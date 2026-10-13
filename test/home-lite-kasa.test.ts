import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { emeterReading, KasaDriver, legacyLayout } from '../src/home/lite/kasa/index.ts';
import { klapAuthHash, klapDecrypt, klapEncrypt, klapKeys, xorDecrypt, xorEncrypt } from '../src/home/lite/kasa/protocol.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { KasaLegacySim, KlapSim } from './sims/kasa.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function fresh() {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
}

const state = (id: string) => states.get(id)?.state;
const flowId = (v: unknown) => (v as { flowId: string }).flowId;

describe('protocol', () => {
  it('XOR autokey round-trips and matches the known first byte', () => {
    const enc = xorEncrypt('{"system":{"get_sysinfo":{}}}');
    // '{' (0x7b) ^ 171 (0xab) = 0xd0: the well-known first byte of every Kasa request.
    assert.equal(enc[0], 0xd0);
    assert.equal(xorDecrypt(enc), '{"system":{"get_sysinfo":{}}}');
  });

  it('KLAP v2 hashes and AES framing round-trip', () => {
    const auth = klapAuthHash('a@b.c', 'pw');
    assert.equal(auth.length, 32);
    const k = klapKeys(Buffer.alloc(16, 1), Buffer.alloc(16, 2), auth);
    assert.deepEqual([k.key.length, k.iv.length, k.sig.length], [16, 12, 28]);
    const body = klapEncrypt(k, k.seq + 1, '{"method":"x"}');
    assert.equal(klapDecrypt(k, k.seq + 1, body), '{"method":"x"}');
  });

  it('reads both emeter formats and decides the layout from sysinfo', () => {
    assert.deepEqual(emeterReading({ power_mw: 1234567, total_wh: 5432 }), { w: 1234.6, kwh: 5.432 });
    assert.deepEqual(emeterReading({ power: 12.34, total: 1.5 }), { w: 12.3, kwh: 1.5 });
    assert.equal(legacyLayout('h', { model: 'HS220', brightness: 50, mac: 'AA:BB:CC:DD:EE:FF' }).kind, 'dimmer');
    assert.equal(legacyLayout('h', { model: 'KL110', mic_type: 'IOT.SMARTBULB', mic_mac: 'AABBCCDDEEFF', light_state: {} }).kind, 'bulb');
    const strip = legacyLayout('h', { model: 'KP303', deviceId: 'DEV', children: [{ id: '00', alias: 'A' }] });
    assert.deepEqual([strip.kind, strip.children[0].id], ['strip', 'DEV00']);
  });
});

describe('legacy plug (HS110, new emeter format)', () => {
  let sim: KasaLegacySim;
  let engine: LiteEngine;
  before(async () => {
    fresh();
    sim = new KasaLegacySim({ kind: 'plug', emeter: 'new' });
    const port = await sim.start();
    engine = new LiteEngine([new KasaDriver({ port, broadcast: '127.0.0.1', pollMs: 150, timeoutMs: 500 })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });
  after(async () => {
    await engine.stop();
    sim.stop();
  });

  it('is discovered by broadcast and set up in one step', async () => {
    const [found] = (await until('discovered', () => engine.discovered().then((l) => (l.length ? l : null))))!;
    assert.deepEqual([found.handler, found.title], ['kasa', 'Kettle plug (HS110(EU))']);
    assert.equal((await engine.flowStep(found.flowId, null)).type, 'form');
    const done = await engine.flowStep(found.flowId, {});
    assert.equal(done.type, 'create_entry');
    const e = registry.entity('switch.kettle_plug')!;
    assert.deepEqual([registry.device(e.deviceId!)!.manufacturer, registry.device(e.deviceId!)!.model], ['TP-Link', 'HS110(EU)']);
    assert.ok(registry.entity('sensor.kettle_plug_power') && registry.entity('sensor.kettle_plug_energy'));
    await until('off', () => state('switch.kettle_plug') === 'off');
    assert.equal(states.get('switch.kettle_plug')!.attributes.supports_auto_off, true);
  });

  it('switches on, confirmed by the re-poll, with metering in W and kWh', async () => {
    const r = await callService('switch', 'turn_on', 'switch.kettle_plug', {}, undefined, { confirmMs: 2000 });
    assert.deepEqual(r.results['switch.kettle_plug'], { ok: true, confirmed: true, message: undefined });
    assert.equal(sim.relay, 1);
    await until('power', () => state('sensor.kettle_plug_power') === '1234.5');
    assert.equal(state('sensor.kettle_plug_energy'), '5.432');
  });

  it('auto_off_s sets the plug\'s own countdown rule', async () => {
    await callService('switch', 'turn_off', 'switch.kettle_plug', {}, undefined, { confirmMs: 2000 });
    await callService('switch', 'turn_on', 'switch.kettle_plug', { auto_off_s: 1800 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(sim.rules, [{ child: null, delay: 1800, act: 0 }]);
    const sent = sim.requests.find((q) => (q as { system?: { set_relay_state?: unknown } }).system?.set_relay_state && JSON.stringify(q).includes('auto_off'));
    assert.equal(sent, undefined, 'auto_off_s is not sent to the device as is');
  });

  it('manual setup refuses the same plug twice and reports nobody home', async () => {
    const f = await engine.startFlow('kasa');
    const dup = await engine.flowStep(flowId(f), { host: '127.0.0.1' });
    assert.match((dup as { reason: string }).reason, /already set up/);
    const g = await engine.startFlow('kasa');
    assert.match(JSON.stringify(await engine.flowStep(flowId(g), { host: 'bad host!' })), /Enter an IP address/);
  });

  it('goes unavailable when silent, comes back, and removing the entry removes the device', async () => {
    sim.silent = true;
    await until('unavailable', () => state('switch.kettle_plug') === 'unavailable');
    assert.equal(state('sensor.kettle_plug_power'), 'unavailable');
    sim.silent = false;
    await until('back', () => state('switch.kettle_plug') === 'on');
    const [entry] = await engine.entries();
    await engine.removeEntry(entry.entryId);
    assert.equal(registry.entity('switch.kettle_plug'), null);
  });
});

describe('legacy power strip (HS300, old emeter format)', () => {
  let sim: KasaLegacySim;
  let engine: LiteEngine;
  before(async () => {
    fresh();
    sim = new KasaLegacySim({ kind: 'strip', emeter: 'old' });
    const port = await sim.start();
    engine = new LiteEngine([new KasaDriver({ port, broadcast: '127.0.0.1', pollMs: 150, timeoutMs: 500 })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });
  after(async () => {
    await engine.stop();
    sim.stop();
  });

  it('gives each outlet its own switch and power reading, and commands only that outlet', async () => {
    const f = await engine.startFlow('kasa');
    assert.equal((await engine.flowStep(flowId(f), { host: '127.0.0.1' })).type, 'create_entry');
    await until('outlets', () => state('switch.pool_pump') === 'off' && state('switch.geyser') === 'off');
    await callService('switch', 'turn_on', 'switch.geyser', { auto_off_s: 600 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(sim.children.map((c) => c.state), [0, 1]);
    assert.deepEqual(sim.rules, [{ child: `${sim.deviceId}01`, delay: 600, act: 0 }]);
    await until('geyser power', () => state('sensor.geyser_power') === '2000');
    assert.equal(state('sensor.pool_pump_power'), '0');
    const t = await callService('switch', 'toggle', 'switch.pool_pump', {}, undefined, { confirmMs: 2000 });
    assert.equal(t.results['switch.pool_pump'].confirmed, true);
    assert.deepEqual(sim.children.map((c) => c.state), [1, 1]);
  });
});

describe('KLAP device (Tapo P110)', () => {
  let sim: KlapSim;
  let engine: LiteEngine;
  before(async () => {
    fresh();
    sim = new KlapSim();
    sim.powerMw = 412_000;
    const klapPort = await sim.start();
    engine = new LiteEngine([new KasaDriver({ port: await freePort(), klapPort, broadcast: '127.0.0.1', pollMs: 150, timeoutMs: 500 })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });
  after(async () => {
    await engine.stop();
    sim.stop();
  });

  it('asks for the TP-Link account, rejects wrong credentials, then sets up', async () => {
    const f = await engine.startFlow('kasa');
    const creds = await engine.flowStep(flowId(f), { host: '127.0.0.1' });
    assert.deepEqual([creds.type, (creds as { stepId: string }).stepId], ['form', 'credentials']);
    const wrong = await engine.flowStep(flowId(f), { username: 'owner@example.com', password: 'nope' });
    assert.match(JSON.stringify(wrong), /Wrong TP-Link email or password/);
    const done = await engine.flowStep(flowId(f), { username: 'owner@example.com', password: 'correct horse' });
    assert.deepEqual([done.type, (done as { title: string }).title], ['create_entry', 'Washing machine']);
    await until('state', () => state('switch.washing_machine') === 'off');
    assert.ok(registry.entity('sensor.washing_machine_power') && registry.entity('sensor.washing_machine_energy_today'));
  });

  it('switches through the encrypted session, with power and an auto-off countdown', async () => {
    const r = await callService('switch', 'turn_on', 'switch.washing_machine', { auto_off_s: 900 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(r.results['switch.washing_machine'], { ok: true, confirmed: true, message: undefined });
    assert.equal(sim.on, true);
    assert.deepEqual(sim.countdowns, [{ delay: 900, desired_states: { on: false }, enable: true, remain: 900 }]);
    await until('power', () => state('sensor.washing_machine_power') === '412');
    assert.equal(state('sensor.washing_machine_energy_today'), '1.53');
  });
});
