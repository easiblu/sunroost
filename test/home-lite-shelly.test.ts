import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { ShellyDriver } from '../src/home/lite/shelly/index.ts';
import { digestAuthorization, parseChallenge, sha256 } from '../src/home/lite/shelly/http.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { Gen1Sim, Gen2Sim } from './sims/shelly.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const flowIdOf = (v: unknown) => (v as { flowId: string }).flowId;

let engine: LiteEngine;
let plain: Gen2Sim;
let locked: Gen2Sim;
let gen1: Gen1Sim;

before(async () => {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
  plain = new Gen2Sim();
  locked = new Gen2Sim({ mac: 'C04E30AABB01', name: 'Geyser', password: 'hunter22' });
  gen1 = new Gen1Sim({ password: 'pw1' });
  await Promise.all([plain.start(), locked.start(), gen1.start()]);
  engine = new LiteEngine([new ShellyDriver({ pollMs: 100, wsRetryMs: 100, retryMs: 200, timeoutMs: 300 })]);
  await engine.start(hostFor('lite'));
  setEngineLookup((id) => (id === 'lite' ? engine : null));
});

after(async () => {
  await engine.stop();
  await Promise.all([plain.stop(), locked.stop(), gen1.stop()]);
});

describe('Shelly digest auth', () => {
  it('answers a challenge as RFC 7616 (SHA-256) describes', () => {
    const ch = parseChallenge('Digest qop="auth", realm="shellyplus1-abc", nonce="60dc59c6", algorithm=SHA-256');
    assert.deepEqual(ch, { qop: 'auth', realm: 'shellyplus1-abc', nonce: '60dc59c6', algorithm: 'SHA-256' });
    const h = digestAuthorization('POST', '/rpc/Switch.Set', ch, { kind: 'digest', username: 'admin', password: 'pw' }, 'abcd');
    const ha1 = sha256('admin:shellyplus1-abc:pw');
    const ha2 = sha256('POST:/rpc/Switch.Set');
    assert.match(h, new RegExp(`response="${sha256(`${ha1}:60dc59c6:00000001:abcd:auth:${ha2}`)}"`));
  });
});

describe('Shelly Gen2', () => {
  it('is discovered over mDNS and set up in one step, with switch, power and energy entities', async () => {
    engine.found({
      source: 'mdns', type: '_shelly._tcp.local', name: plain.id, host: `${plain.id}.local`, ip: '127.0.0.1', port: plain.port,
      props: { gen: '2', app: 'Plus1PM', id: plain.id },
    });
    const [found] = await engine.discovered();
    assert.deepEqual([found.handler, found.title], ['shelly', 'Shelly Plus1PM at 127.0.0.1']);
    const confirm = await engine.flowStep(found.flowId, null);
    assert.equal(confirm.type, 'form');
    assert.equal((confirm as { fields: unknown[] }).fields.length, 0, 'no password on this one');
    const done = await engine.flowStep(found.flowId, {});
    assert.deepEqual([done.type, (done as { title: string }).title], ['create_entry', 'Pool pump']);
    await until('switch', () => states.get('switch.pool_pump')?.state === 'off');
    assert.equal(states.get('sensor.pool_pump_power')!.state, '0');
    assert.equal(states.get('sensor.pool_pump_energy')!.state, '1.235');
    assert.equal(states.get('sensor.pool_pump_temperature'), null, 'only components with their own status key');
    const dev = registry.device(registry.entity('switch.pool_pump')!.deviceId!)!;
    assert.deepEqual([dev.manufacturer, dev.model, dev.swVersion], ['Shelly', 'SNSW-001P16EU', '1.4.2']);
    assert.equal(states.get('switch.pool_pump')!.attributes.supports_auto_off, true);
  });

  it('switches with a device-side off-timer and is confirmed by the WebSocket push', async () => {
    await until('ws', () => plain.calls.includes('Shelly.GetStatus'));
    const res = await callService('switch', 'turn_on', 'switch.pool_pump', { auto_off_s: 600 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(res.results['switch.pool_pump'], { ok: true, confirmed: true, message: undefined });
    assert.equal(plain.lastToggleAfter, 600);
    await until('power', () => states.get('sensor.pool_pump_power')?.state === '1480.5');
    assert.equal(states.get('switch.pool_pump')!.context.parentId, res.context.id, 'traced to the command');
    const off = await callService('switch', 'toggle', 'switch.pool_pump', {}, undefined, { confirmMs: 2000 });
    assert.equal(off.results['switch.pool_pump'].confirmed, true);
    assert.equal(plain.sw.output, false);
  });

  it('reconnects after the WebSocket drops and still sees changes', async () => {
    plain.dropClients();
    await new Promise((r) => setTimeout(r, 300));
    plain.setOutput(true);
    await until('change seen', () => states.get('switch.pool_pump')?.state === 'on');
  });

  it('asks for the password, refuses a wrong one, and works with the right one (HTTP and WebSocket auth)', async () => {
    const flowId = flowIdOf(await engine.startFlow('shelly'));
    const host = `127.0.0.1:${locked.port}`;
    const missing = await engine.flowStep(flowId, { host });
    assert.match(JSON.stringify(missing), /This device has a password/);
    const wrong = await engine.flowStep(flowId, { password: 'nope' });
    assert.match(JSON.stringify(wrong), /Wrong password/);
    const ok = await engine.flowStep(flowId, { password: 'hunter22' });
    assert.equal(ok.type, 'create_entry');
    await until('geyser', () => states.get('switch.geyser')?.state === 'off');
    await until('ws auth', () => locked.wsAuthed);
    const res = await callService('switch', 'turn_on', 'switch.geyser', {}, undefined, { confirmMs: 2000 });
    assert.equal(res.results['switch.geyser'].confirmed, true);
  });

  it('a manual address that is not a Shelly is reported', async () => {
    const flowId = flowIdOf(await engine.startFlow('shelly'));
    const r = await engine.flowStep(flowId, { host: '127.0.0.1:9' });
    assert.match(JSON.stringify(r), /No Shelly device answered at 127.0.0.1:9/);
  });
});

describe('Shelly Gen1', () => {
  it('sets up with basic auth, polls, and uses the relay timer as off-timer', async () => {
    const flowId = flowIdOf(await engine.startFlow('shelly'));
    const step = await engine.flowStep(flowId, { host: `127.0.0.1:${gen1.port}`, password: 'pw1' });
    assert.equal(step.type, 'create_entry');
    await until('garage', () => states.get('switch.garage')?.state === 'off');
    assert.equal(states.get('sensor.garage_energy')!.state, '1.021', 'watt-minutes to kWh');
    const res = await callService('switch', 'turn_on', 'switch.garage', { auto_off_s: 30 }, undefined, { confirmMs: 2000 });
    assert.equal(res.results['switch.garage'].confirmed, true);
    assert.equal(gen1.lastTimer, 30);
    assert.equal(states.get('sensor.garage_power')!.state, '2003.4');
  });

  it('turns unavailable when the device stops answering, and comes back', async () => {
    gen1.silent = true;
    await until('unavailable', () => states.get('switch.garage')?.state === 'unavailable', 8000);
    gen1.silent = false;
    await until('back', () => states.get('switch.garage')?.state === 'on', 8000);
  });

  it('Gen1 discovery skips devices already set up', () => {
    const before = engine.discovered();
    engine.found({ source: 'mdns', type: '_http._tcp.local', name: 'shelly1pm-F45678', host: null, ip: '127.0.0.1', port: gen1.port, props: {} });
    engine.found({ source: 'mdns', type: '_http._tcp.local', name: 'printer-1', host: null, ip: '127.0.0.9', port: 80, props: {} });
    return before.then(async (b) => assert.deepEqual(await engine.discovered(), b));
  });
});

describe('removing a Shelly', () => {
  it('removes its devices and stops talking to it', async () => {
    const entry = (await engine.entries()).find((e) => e.title === 'Pool pump')!;
    await engine.removeEntry(entry.entryId);
    assert.equal(registry.entity('switch.pool_pump'), null);
    assert.equal(registry.entity('sensor.pool_pump_power'), null);
    const calls = plain.calls.length;
    await new Promise((r) => setTimeout(r, 400));
    plain.setOutput(false);
    assert.ok(plain.calls.length - calls <= 1, 'no more polling');
  });
});
