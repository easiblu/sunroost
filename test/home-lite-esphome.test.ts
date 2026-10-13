import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { EspConnection } from '../src/home/lite/esphome/connection.ts';
import { EsphomeDriver } from '../src/home/lite/esphome/index.ts';
import { CipherState, NoiseHandshake } from '../src/home/lite/esphome/noise.ts';
import { encodeVarint, Fields, readVarint, Writer } from '../src/home/lite/esphome/proto.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { EsphomeSim } from './sims/esphome.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('protobuf and Noise', () => {
  test('varints, negatives, floats, strings and repeated fields round-trip', () => {
    for (const n of [0, 1, 127, 128, 300, 2 ** 32 - 1]) assert.equal(Number(readVarint(encodeVarint(n), 0).value), n);
    const f = Fields.decode(new Writer().varint(1, -5).float(2, 1.5).str(3, 'héllo').fixed32(4, 0xdeadbeef).varint(5, 2).varint(5, 3).bool(6, true).bytes());
    assert.deepEqual([f.int(1), f.float(2), f.str(3), f.fixed32(4), f.ints(5), f.bool(6), f.bool(7)], [-5, 1.5, 'héllo', 0xdeadbeef, [2, 3], true, false]);
    // Packed repeated enum (proto3 default) decodes too.
    const packed = Buffer.concat([Buffer.from([(7 << 3) | 2, 3]), Buffer.from([0, 2, 3])]);
    assert.deepEqual(Fields.decode(packed).ints(7), [0, 2, 3]);
  });

  test('NNpsk0 handshake gives matching transport keys; a wrong PSK fails', () => {
    const psk = randomBytes(32);
    const i = new NoiseHandshake(psk, true);
    const r = new NoiseHandshake(psk, false);
    r.readMessage1(i.writeMessage1());
    i.readMessage2(r.writeMessage2());
    const [iSend, iRecv] = i.split();
    const [rSend, rRecv] = r.split();
    assert.equal(rRecv.decrypt(iSend.encrypt(Buffer.from('ping'))).toString(), 'ping');
    assert.equal(iRecv.decrypt(rSend.encrypt(Buffer.from('pong'))).toString(), 'pong');
    const bad = new NoiseHandshake(randomBytes(32), false);
    assert.throws(() => bad.readMessage1(new NoiseHandshake(psk, true).writeMessage1()), /Decryption failed/);
    assert.ok(CipherState);
  });
});

describe('ESPHome driver', () => {
  const key = randomBytes(32).toString('base64');
  let sim: EsphomeSim;
  let engine: LiteEngine;

  before(async () => {
    openDb(':memory:');
    settings.init();
    secrets.init(null);
    registry.init();
    areas.init();
    states.reset();
    sim = new EsphomeSim({ key });
    await sim.start();
    engine = new LiteEngine([new EsphomeDriver({ timeoutMs: 2000, backoffMs: [50, 100], pingMs: 200 })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });

  after(async () => {
    await engine.stop();
    await sim.stop();
  });

  const found = () => ({
    source: 'mdns' as const, type: '_esphomelib._tcp.local', name: 'heat-pump', host: 'heat-pump.local', ip: '127.0.0.1', port: sim.port,
    props: { mac: 'aabbcc112233', friendly_name: 'Heat pump', version: '2024.6.0', api_encryption: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256' },
  });

  test('connection errors are told apart: no key, wrong key, unreachable', async () => {
    const plain = new EspConnection({ host: '127.0.0.1', port: sim.port, timeoutMs: 2000 });
    await assert.rejects(plain.open(), (e: { code: string }) => e.code === 'requires_encryption');
    const wrong = new EspConnection({ host: '127.0.0.1', port: sim.port, key: randomBytes(32).toString('base64'), timeoutMs: 2000 });
    await assert.rejects(wrong.open(), (e: { code: string }) => e.code === 'invalid_key');
    const nobody = new EspConnection({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await assert.rejects(nobody.open(), (e: { code: string }) => e.code === 'cannot_connect');
  });

  test('an encrypted device found by mDNS asks for its key, then sets up with every entity', async () => {
    engine.found(found());
    const [d] = (await until('discovered', () => engine.discovered().then((l) => (l.length ? l : null))))!;
    assert.deepEqual([d.handler, d.title], ['esphome', 'Heat pump (ESPHome)']);
    const form = await engine.flowStep(d.flowId, null);
    assert.equal(form.type === 'form' && form.fields[0].name, 'key');
    const bad = await engine.flowStep(d.flowId, { key: randomBytes(32).toString('base64') });
    assert.equal(bad.type === 'form' && bad.errors.key, 'Wrong encryption key.');
    const done = await engine.flowStep(d.flowId, { key });
    assert.deepEqual([done.type, done.type === 'create_entry' && done.title], ['create_entry', 'Heat pump']);

    // States arrive one message at a time after setup; wait for all the ones checked below (slow CI runners lag).
    await until('initial states', () =>
      states.get('switch.heat_pump_relay')?.state === 'off' &&
      states.get('sensor.heat_pump_power')?.state === '0' &&
      states.get('climate.heat_pump')?.state === 'off');
    const dev = registry.device(registry.entity('switch.heat_pump_relay')!.deviceId!)!;
    assert.deepEqual([dev.manufacturer, dev.model, dev.swVersion], ['Espressif', 'esp32dev', 'ESPHome 2024.6.0']);
    assert.equal(registry.entity('sensor.heat_pump_power')!.unit, 'W');
    assert.equal(states.get('sensor.heat_pump_power')!.state, '0');
    assert.equal(registry.entity('sensor.heat_pump_wifi_signal')!.hidden, true, 'diagnostic entity starts hidden');
    assert.equal(states.get('climate.heat_pump')!.state, 'off', 'unnamed entity takes the device name');
    assert.deepEqual(states.get('climate.heat_pump')!.attributes.hvac_modes, ['off', 'cool', 'heat']);
    assert.equal(states.get('climate.heat_pump')!.attributes.current_temperature, 27.5);
    assert.deepEqual(states.get('select.heat_pump_mode')!.attributes.options, ['eco', 'boost']);
    assert.equal(states.get('light.heat_pump_lamp')!.attributes.supports_brightness, true);
  });

  test('commands go out encrypted and are confirmed by the state push', async () => {
    const r = await callService('switch', 'turn_on', 'switch.heat_pump_relay', { auto_off_s: 60 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(r.results['switch.heat_pump_relay'], { ok: true, confirmed: true, message: undefined });
    assert.equal(sim.state.relay, true);
    await until('power', () => states.get('sensor.heat_pump_power')?.state === '1234.6');

    await callService('light', 'turn_on', 'light.heat_pump_lamp', { brightness: 128 }, undefined, { confirmMs: 2000 });
    assert.ok(Math.abs(sim.state.brightness - 128 / 255) < 0.001);
    await until('lamp', () => states.get('light.heat_pump_lamp')?.attributes.brightness === 128);

    const cool = await callService('climate', 'set_hvac_mode', 'climate.heat_pump', { hvac_mode: 'cool' }, undefined, { confirmMs: 2000 });
    assert.equal(cool.results['climate.heat_pump'].confirmed, true);
    await callService('climate', 'set_temperature', 'climate.heat_pump', { temperature: 21.5 }, undefined, { confirmMs: 500 });
    await until('target', () => sim.state.acTarget === 21.5);
    const off = await callService('climate', 'turn_off', 'climate.heat_pump', {}, undefined, { confirmMs: 2000 });
    assert.equal(off.results['climate.heat_pump'].confirmed, true);
    await callService('climate', 'turn_on', 'climate.heat_pump', {}, undefined, { confirmMs: 500 });
    await until('turn_on restores the last mode (cool)', () => sim.state.acMode === 2);

    await callService('number', 'set_value', 'number.heat_pump_current', { value: 25 }, undefined, { confirmMs: 500 });
    await callService('select', 'select_option', 'select.heat_pump_mode', { option: 'boost' }, undefined, { confirmMs: 2000 });
    await callService('button', 'press', 'button.heat_pump_reboot', {}, undefined, { confirmMs: 100 });
    await until('number, select, button', () => sim.state.current === 25 && sim.state.mode === 'boost' && sim.state.presses === 1);

    const tooHigh = await callService('number', 'set_value', 'number.heat_pump_current', { value: 99 });
    assert.match(tooHigh.results['number.heat_pump_current'].message!, /between 6 and 32/);
  });

  test('a dropped connection makes everything unavailable, then it reconnects by itself', async () => {
    sim.dropAll();
    await until('unavailable', () => states.get('switch.heat_pump_relay')?.state === 'unavailable');
    await until('back', () => states.get('switch.heat_pump_relay')?.state === 'on');
  });

  test('removing the entry closes the connection and removes the device', async () => {
    const [entry] = await engine.entries();
    await engine.removeEntry(entry.entryId);
    assert.equal(registry.entity('switch.heat_pump_relay'), null);
    await until('closed', () => sim.sockets.size === 0);
  });
});

describe('older firmware without encryption, with an API password', () => {
  test('manual setup logs in with the password; a wrong one is refused', async () => {
    openDb(':memory:');
    settings.init();
    secrets.init(null);
    registry.init();
    states.reset();
    const sim = new EsphomeSim({ password: 'secret', apiMinor: 9, name: 'old-plug', mac: '11:22:33:44:55:66' });
    await sim.start();
    const engine = new LiteEngine([new EsphomeDriver({ timeoutMs: 2000, backoffMs: [50], pingMs: 1000 })]);
    await engine.start(hostFor('lite'));
    try {
      const f = await engine.startFlow('esphome');
      const id = (f as { flowId: string }).flowId;
      const wrong = await engine.flowStep(id, { host: '127.0.0.1', port: sim.port, password: 'nope' });
      assert.equal(wrong.type === 'form' && wrong.errors.password, 'Wrong API password.');
      const withKey = await engine.flowStep(id, { host: '127.0.0.1', port: sim.port, key: randomBytes(32).toString('base64') });
      assert.match(JSON.stringify(withKey), /doesn't use encryption/);
      const ok = await engine.flowStep(id, { host: '127.0.0.1', port: sim.port, password: 'secret' });
      assert.equal(ok.type, 'create_entry');
      // States arrive one message at a time after setup; wait for all the ones checked below (slow CI runners lag).
    await until('initial states', () =>
      states.get('switch.heat_pump_relay')?.state === 'off' &&
      states.get('sensor.heat_pump_power')?.state === '0' &&
      states.get('climate.heat_pump')?.state === 'off');
    } finally {
      await engine.stop();
      await sim.stop();
    }
  });
});
