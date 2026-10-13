import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { parseConfig, pulseTime, topicFor } from '../src/home/lite/tasmota/model.ts';
import { TasmotaDriver } from '../src/home/lite/tasmota/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { startBroker, TasmotaSim } from './sims/tasmota.ts';

async function until<T>(what: string, fn: () => T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const st = (id: string) => states.get(id)?.state;

let broker: Awaited<ReturnType<typeof startBroker>>;
let engine: LiteEngine;
const plug = new TasmotaSim({ mac: 'AABBCC112233', topic: 'tasmota_112233', name: 'Kitchen plug', relays: [1], energy: true });
const duo = new TasmotaSim({
  mac: 'AABBCC445566', topic: 'tasmota_445566', name: 'Hall', relays: [1, 2], lightType: 1, friendly: ['Hall fan', 'Hall lamp', null, null, null, null, null, null],
});

before(async () => {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
  broker = await startBroker();
  await plug.start(broker.url);
  engine = new LiteEngine([new TasmotaDriver({ url: broker.url })]);
  await engine.start(hostFor('lite'));
  setEngineLookup((id) => (id === 'lite' ? engine : null));
  await duo.start(broker.url);
});

after(async () => {
  await engine.stop();
  await plug.stop().catch(() => {});
  await duo.stop().catch(() => {});
  await broker.close();
});

test('model: topics, PulseTime encoding, config parsing', () => {
  const c = parseConfig(plug.config())!;
  assert.equal(c.mac, 'aabbcc112233');
  assert.equal(topicFor(c, 0, 'POWER1'), 'cmnd/tasmota_112233/POWER1');
  assert.equal(topicFor({ ...c, fullTopic: 'home/%topic%/%prefix%/' }, 2, 'LWT'), 'home/tasmota_112233/tele/LWT');
  assert.deepEqual([pulseTime(5), pulseTime(11), pulseTime(12), pulseTime(3600), pulseTime(0), pulseTime(70000)], [50, 110, 112, 3700, null, null]);
  assert.equal(parseConfig({ dn: 'x' }), null);
});

test('native discovery becomes a device with a switch and energy sensors', async () => {
  await until('plug', () => st('switch.kitchen_plug') === 'off');
  const e = registry.entity('switch.kitchen_plug')!;
  const dev = registry.device(e.deviceId!)!;
  assert.deepEqual([dev.name, dev.manufacturer, dev.model, dev.swVersion], ['Kitchen plug', 'Tasmota', 'Sonoff Pow R2', '14.3.0']);
  assert.equal(states.get('switch.kitchen_plug')!.attributes.supports_auto_off, true);
  await until('energy', () => st('sensor.kitchen_plug_power') === '0');
  assert.equal(registry.entity('sensor.kitchen_plug_power')!.unit, 'W');
  assert.equal(st('sensor.kitchen_plug_energy_total'), '12.345');
  assert.equal(registry.entity('sensor.kitchen_plug_energy_total')!.deviceClass, 'energy');
  assert.equal(st('sensor.kitchen_plug_voltage'), '231');
});

test('POWER commands are confirmed by the device; energy follows', async () => {
  const on = await callService('switch', 'turn_on', 'switch.kitchen_plug', {}, undefined, { confirmMs: 2000 });
  assert.deepEqual(on.results['switch.kitchen_plug'], { ok: true, confirmed: true, message: undefined });
  assert.equal(plug.power[0], true);
  await until('power reading', () => st('sensor.kitchen_plug_power') === '1500');
  const t = await callService('switch', 'toggle', 'switch.kitchen_plug', {}, undefined, { confirmMs: 2000 });
  assert.equal(t.results['switch.kitchen_plug'].confirmed, true);
  assert.equal(st('switch.kitchen_plug'), 'off');
});

test('auto_off_s sets PulseTime before ON, and a plain ON clears it again', async () => {
  await callService('switch', 'turn_on', 'switch.kitchen_plug', { auto_off_s: 1800 }, undefined, { confirmMs: 2000 });
  await until('pulse', () => plug.pulse[0] === 1900);
  await callService('switch', 'turn_off', 'switch.kitchen_plug', {}, undefined, { confirmMs: 2000 });
  await callService('switch', 'turn_on', 'switch.kitchen_plug', {}, undefined, { confirmMs: 2000 });
  await until('pulse cleared', () => plug.pulse[0] === 0);
  await callService('switch', 'turn_off', 'switch.kitchen_plug', {}, undefined, { confirmMs: 2000 });
});

test('two channels: POWER1/POWER2 keys, a dimmable light, friendly names', async () => {
  await until('duo', () => st('switch.hall_fan') === 'off' && st('light.hall_lamp') === 'off');
  assert.equal(states.get('light.hall_lamp')!.attributes.supports_brightness, true);
  const r = await callService('light', 'turn_on', 'light.hall_lamp', { brightness: 128 }, undefined, { confirmMs: 2000 });
  assert.equal(r.results['light.hall_lamp'].confirmed, true);
  assert.equal(duo.dimmer, 50);
  await until('brightness', () => states.get('light.hall_lamp')!.attributes.brightness === 128);
  const f = await callService('switch', 'turn_on', 'switch.hall_fan', {}, undefined, { confirmMs: 2000 });
  assert.equal(f.results['switch.hall_fan'].confirmed, true);
  assert.deepEqual(duo.power, [true, true]);
});

test('LWT Offline makes the device unavailable; Online brings it back', async () => {
  await plug.stop(true); // dropped connection: the broker publishes the will (Offline)
  await until('offline', () => st('switch.kitchen_plug') === 'unavailable' && st('sensor.kitchen_plug_power') === 'unavailable');
  const res = await callService('switch', 'turn_on', 'switch.kitchen_plug');
  assert.match(res.results['switch.kitchen_plug'].message!, /unavailable/);
  await plug.start(broker.url);
  await until('online', () => st('switch.kitchen_plug') === 'off');
});

test('an empty discovery config removes the device', async () => {
  await duo.removeDiscovery();
  await until('removed', () => registry.entity('switch.hall_fan') === null && registry.entity('light.hall_lamp') === null);
  assert.ok(registry.entity('switch.kitchen_plug'), 'other devices stay');
});
