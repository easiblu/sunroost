import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { connectAsync, type MqttClient } from 'mqtt';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import { devices } from '../src/devices/manager.ts';
import * as home from '../src/home/index.ts';
import * as mqtt from '../src/mqtt/index.ts';

const { registry, states } = home;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Polls until `fn` returns a truthy value. */
async function until<T>(what: string, fn: () => T, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const stateOf = (id: string) => states.get(id)?.state;
const DEMO = [
  'switch.demo_plug', 'sensor.demo_plug_power', 'light.demo_bulb', 'climate.demo_air_conditioner', 'sensor.demo_air_conditioner_power',
  'switch.demo_ev_charger_charging', 'number.demo_ev_charger_charging_current', 'sensor.demo_ev_charger_power',
];

let port = 0;
let client: MqttClient;

before(async () => {
  openDb(':memory:');
  settings.init();
  port = await freePort();
  // Sunroost's own inverter data is announced with discovery too; the driver must leave it alone.
  settings.setMany({ 'mqtt.port': port, mqtt_discovery: true, 'inverter.driver_id': 'simulator', 'home.demo_devices': true, 'home.engine': 'lite' });
  await mqtt.start({ host: '127.0.0.1' });
  await devices.start();
  await home.start();
  client = await connectAsync(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 });
});

after(async () => {
  await client?.endAsync();
  await home.stop();
  await devices.stop();
  await mqtt.stop();
});

test('simulated devices are discovered as entities, and Sunroost\'s own discovery is not', async () => {
  await until('demo entities', () => DEMO.every((id) => stateOf(id) && stateOf(id) !== 'unavailable'));
  assert.equal(stateOf('switch.demo_plug'), 'off');
  assert.equal(stateOf('climate.demo_air_conditioner'), 'off');
  assert.equal(stateOf('number.demo_ev_charger_charging_current'), '16');

  const plug = registry.entity('switch.demo_plug')!;
  const dev = registry.device(plug.deviceId!)!;
  assert.deepEqual([dev.name, dev.manufacturer, dev.model], ['Demo plug', 'Tasmota', 'Sonoff S31']);
  assert.equal(registry.entity('sensor.demo_plug_power')!.deviceId, dev.id, 'both entities on one device');
  assert.equal(registry.entity('sensor.demo_plug_power')!.unit, 'W');

  // Give Sunroost's publisher time to announce the simulated inverter, then check none of it became a device entity.
  await new Promise((r) => setTimeout(r, 300));
  const lite = registry.allEntities('lite').map((e) => e.entityId).sort();
  assert.deepEqual(lite, [...DEMO].sort());

  const status = await home.engineStatus();
  assert.equal(status.active, 'lite');
  const driver = (status.engines.find((e) => e.id === 'lite')!.info as { drivers: { id: string; state: string; entities: number }[] }).drivers[0];
  assert.deepEqual([driver.id, driver.state, driver.entities], ['mqtt', 'connected', 8]);
});

test('commands round-trip through the devices and are confirmed', async () => {
  const on = await home.callService('switch', 'turn_on', 'switch.demo_plug');
  assert.deepEqual(on.results['switch.demo_plug'], { ok: true, confirmed: true, message: undefined });
  assert.equal(states.get('switch.demo_plug')!.context.parentId, on.context.id, 'state change traced to the command');
  await until('plug power', () => Number(stateOf('sensor.demo_plug_power')) > 1900);

  const bulb = await home.callService('light', 'turn_on', 'light.demo_bulb', { brightness: 128 });
  assert.equal(bulb.results['light.demo_bulb'].confirmed, true);
  await until('bulb brightness', () => states.get('light.demo_bulb')!.attributes.brightness === 128);

  const cool = await home.callService('climate', 'set_hvac_mode', 'climate.demo_air_conditioner', { hvac_mode: 'cool' });
  assert.equal(cool.results['climate.demo_air_conditioner'].confirmed, true);
  await home.callService('climate', 'set_temperature', 'climate.demo_air_conditioner', { temperature: 22 });
  await until('target temperature', () => states.get('climate.demo_air_conditioner')!.attributes.temperature === 22);
  await until('AC power', () => Number(stateOf('sensor.demo_air_conditioner_power')) > 1000);

  await home.callService('number', 'set_value', 'number.demo_ev_charger_charging_current', { value: 32 });
  await until('charging current', () => stateOf('number.demo_ev_charger_charging_current') === '32');

  const off = await home.callService('homeassistant', 'turn_off', ['switch.demo_plug', 'light.demo_bulb', 'climate.demo_air_conditioner']);
  assert.equal(off.ok, true);
  assert.ok(Object.values(off.results).every((r) => r.confirmed === true));

  const bad = await home.callService('number', 'set_value', 'number.demo_ev_charger_charging_current', { value: 99 });
  assert.match(bad.results['number.demo_ev_charger_charging_current'].message!, /between 6 and 32/);
});

test('availability: a device that goes offline becomes unavailable and refuses commands', async () => {
  await client.publishAsync('demo-charger/status', 'offline', { retain: true });
  await until('charger unavailable', () => stateOf('switch.demo_ev_charger_charging') === 'unavailable');
  const res = await home.callService('switch', 'turn_on', 'switch.demo_ev_charger_charging');
  assert.match(res.results['switch.demo_ev_charger_charging'].message!, /unavailable/);
  await client.publishAsync('demo-charger/status', 'online', { retain: true });
  await until('charger back', () => stateOf('switch.demo_ev_charger_charging') === 'off');
});

test('third-party devices: added, updated in place, and removed with an empty config', async () => {
  const topic = 'homeassistant/switch/pump/config';
  await client.publishAsync(topic, JSON.stringify({ name: 'Pool pump', uniq_id: 'pump1', cmd_t: 'pump/set', stat_t: 'pump/state' }), { retain: true });
  await until('pump', () => registry.entity('switch.pool_pump'));
  await client.publishAsync('pump/state', 'ON');
  await until('pump on', () => stateOf('switch.pool_pump') === 'on');

  registry.updateEntity('switch.pool_pump', { role: 'deferrable' });
  await client.publishAsync(topic, JSON.stringify({ name: 'Pool pump', uniq_id: 'pump1', cmd_t: 'pump/cmd', stat_t: 'pump/state', ic: 'mdi:pump' }), { retain: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(registry.entity('switch.pool_pump')!.role, 'deferrable', 'user role survives a config update');

  // An unsupported template is reported, not run.
  await client.publishAsync('homeassistant/sensor/weird/config', JSON.stringify({ name: 'Weird', uniq_id: 'w', stat_t: 'w', val_tpl: '{% for x in y %}{% endfor %}' }));
  type LiteInfo = { drivers: { details: { ignored: { topic: string; reason: string }[] } }[] };
  let ignored: { topic: string; reason: string }[] = [];
  const end = Date.now() + 5000;
  while (!ignored.some((i) => i.topic === 'homeassistant/sensor/weird/config') && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    const status = await home.engineStatus();
    ignored = (status.engines.find((e) => e.id === 'lite')!.info as LiteInfo).drivers[0].details.ignored;
  }
  assert.match(ignored.find((i) => i.topic === 'homeassistant/sensor/weird/config')!.reason, /template/);
  assert.equal(registry.entity('sensor.weird'), null);

  await client.publishAsync(topic, '', { retain: true });
  await until('pump removed', () => !registry.entity('switch.pool_pump'));
});

test('switching the demo off removes its devices', async () => {
  settings.set('home.demo_devices', false);
  await until('demo removed', () => DEMO.every((id) => !registry.entity(id)));
});
