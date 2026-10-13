import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { HueDriver, luxFrom, mergeDeep } from '../src/home/lite/hue/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { BRIDGE_ID, HueSim, KEY } from './sims/hue.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const st = (id: string) => states.get(id)?.state;

let sim: HueSim;
let engine: LiteEngine;

before(async () => {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
  sim = new HueSim();
  const port = await sim.start(true);
  engine = new LiteEngine([new HueDriver({ scheme: sim.scheme, port, retryMs: [50, 100] })]);
  await engine.start(hostFor('lite'));
  setEngineLookup((id) => (id === 'lite' ? engine : null));
});

after(async () => {
  await engine.stop();
  await sim.stop();
});

test('helpers: light level to lux, deep merge of partial updates', () => {
  assert.equal(luxFrom(20001), 100);
  assert.deepEqual(mergeDeep({ on: { on: false }, dimming: { brightness: 50, min: 1 } }, { dimming: { brightness: 80 } }),
    { on: { on: false }, dimming: { brightness: 80, min: 1 } });
});

test('a bridge found over mDNS is paired after the link button is pressed', async () => {
  assert.equal(sim.scheme, 'https', 'the simulator runs over HTTPS with a self-signed certificate (openssl available)');
  engine.found({ source: 'mdns', type: '_hue._tcp.local', name: 'Hue Bridge - 123456', host: 'hue.local', ip: '127.0.0.1', port: 443,
    props: { bridgeid: BRIDGE_ID.toUpperCase(), modelid: 'BSB002' } });
  const [found] = (await engine.discovered());
  assert.deepEqual([found.handler, found.title], ['hue', 'Hue bridge at 127.0.0.1']);
  const link = await engine.flowStep(found.flowId, null);
  assert.equal(link.type === 'form' && link.stepId, 'link');
  const notYet = await engine.flowStep(found.flowId, {});
  assert.equal(notYet.type, 'form');
  assert.match(JSON.stringify(notYet), /link button has not been pressed/);
  sim.linkPressed = true;
  const done = await engine.flowStep(found.flowId, {});
  assert.equal(done.type, 'create_entry');
  const [entry] = await engine.entries();
  assert.equal(entry.name, 'Philips Hue');
});

test('lights, plugs and sensors become entities on their Hue devices', async () => {
  await until('lamp', () => st('light.desk_lamp') === 'off');
  assert.equal(st('switch.kettle_plug'), 'off', 'a smart plug is a switch');
  assert.equal(st('binary_sensor.hall_sensor_motion'), 'off');
  assert.equal(st('sensor.hall_sensor_temperature'), '21.5');
  assert.equal(st('sensor.hall_sensor_light_level'), '100');
  const lamp = states.get('light.desk_lamp')!;
  assert.deepEqual([lamp.attributes.brightness, lamp.attributes.supports_brightness, lamp.attributes.color_temp], [128, true, 366]);
  const dev = registry.device(registry.entity('light.desk_lamp')!.deviceId!)!;
  assert.deepEqual([dev.name, dev.manufacturer, dev.model, dev.swVersion], ['Desk lamp', 'Signify Netherlands B.V.', 'Hue color lamp', '1.122.8']);
  assert.ok(registry.allDevices('lite').some((d) => d.name === 'Hue Bridge'), 'the bridge is a device too');
  assert.equal(registry.entity('sensor.hall_sensor_temperature')!.deviceId, registry.entity('binary_sensor.hall_sensor_motion')!.deviceId);
});

test('commands are sent with the application key and confirmed by the event stream', async () => {
  await until('stream', () => sim.streams.size === 1);
  const res = await callService('light', 'turn_on', 'light.desk_lamp', { brightness: 255 }, undefined, { confirmMs: 2000 });
  assert.deepEqual(res.results['light.desk_lamp'], { ok: true, confirmed: true, message: undefined });
  assert.deepEqual(sim.puts.at(-1), { id: 'light-lamp', body: { on: { on: true }, dimming: { brightness: 100 } } });
  await until('brightness', () => states.get('light.desk_lamp')!.attributes.brightness === 255);
  assert.equal(states.get('light.desk_lamp')!.context.parentId, res.context.id);
  const plug = await callService('switch', 'toggle', 'switch.kettle_plug', {}, undefined, { confirmMs: 2000 });
  assert.equal(plug.results['switch.kettle_plug'].confirmed, true);
  assert.deepEqual(sim.puts.at(-1)!.body, { on: { on: true } }, 'no dimming for a plug');
});

test('sensor updates and lost Zigbee connectivity arrive as events', async () => {
  sim.update('motion-1', { motion: { motion: true, motion_valid: true } });
  sim.update('temp-1', { temperature: { temperature: 19.25, temperature_valid: true } });
  await until('motion', () => st('binary_sensor.hall_sensor_motion') === 'on' && st('sensor.hall_sensor_temperature') === '19.25');
  sim.update('zc-lamp', { status: 'connectivity_issue' });
  await until('lamp unavailable', () => st('light.desk_lamp') === 'unavailable');
  assert.equal(st('switch.kettle_plug'), 'on', 'other devices are unaffected');
  const refused = await callService('light', 'turn_off', 'light.desk_lamp');
  assert.match(refused.results['light.desk_lamp'].message!, /unavailable/);
  sim.update('zc-lamp', { status: 'connected' });
  await until('lamp back', () => st('light.desk_lamp') === 'on');
});

test('a dropped event stream reconnects and catches up on missed changes', async () => {
  sim.dropStreams();
  // A change while the stream is down is picked up by the re-sync on reconnect.
  sim.resources.set('light-plug', { ...sim.resources.get('light-plug')!, on: { on: false } });
  await until('reconnected', () => sim.streams.size === 1, 5000);
  await until('caught up', () => st('switch.kettle_plug') === 'off');
});

test('an unreachable bridge marks everything unavailable; removing the entry removes its devices', async () => {
  await sim.stop();
  await until('all unavailable', () => st('light.desk_lamp') === 'unavailable' && st('sensor.hall_sensor_temperature') === 'unavailable', 5000);
  const [entry] = await engine.entries();
  await engine.removeEntry(entry.entryId);
  assert.equal(registry.entity('light.desk_lamp'), null);
  assert.equal(registry.allDevices('lite').length, 0);
  assert.deepEqual(await engine.entries(), []);
  void KEY;
});
