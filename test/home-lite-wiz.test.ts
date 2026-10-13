import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { WizDriver } from '../src/home/lite/wiz/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { WizSim } from './sims/wiz.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let sim: WizSim;
let engine: LiteEngine;

before(async () => {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
  sim = new WizSim();
  const port = await sim.start();
  engine = new LiteEngine([new WizDriver({ port, broadcast: '127.0.0.1', pollMs: 100 })]);
  await engine.start(hostFor('lite'));
  setEngineLookup((id) => (id === 'lite' ? engine : null));
});

after(async () => {
  await engine.stop();
  sim.stop();
});

test('a WiZ bulb on the network shows up as a new device and is set up in one step', async () => {
  const [found] = (await until('discovered', () => engine.discovered().then((l) => (l.length ? l : null))))!;
  assert.equal(found.handler, 'wiz');
  assert.equal(found.title, 'WiZ device at 127.0.0.1');
  const confirm = await engine.flowStep(found.flowId, null);
  assert.equal(confirm.type, 'form');
  const done = await engine.flowStep(found.flowId, {});
  assert.deepEqual([done.type, done.type === 'create_entry' && done.title], ['create_entry', 'WiZ light 127.0.0.1']);
  assert.deepEqual(await engine.discovered(), [], 'no longer new');
  const e = registry.entity('light.wiz_light_127_0_0_1')!;
  assert.equal(registry.device(e.deviceId!)!.model, 'ESP01_SHDW1C_31');
  await until('state', () => states.get(e.entityId)?.state === 'off');
});

test('commands reach the bulb and are confirmed by the immediate poll', async () => {
  const res = await callService('light', 'turn_on', 'light.wiz_light_127_0_0_1', { brightness: 128 }, undefined, { confirmMs: 2000 });
  assert.deepEqual(res.results['light.wiz_light_127_0_0_1'], { ok: true, confirmed: true, message: undefined });
  assert.deepEqual([sim.state.state, sim.state.dimming], [true, 50]);
  assert.equal(states.get('light.wiz_light_127_0_0_1')!.attributes.brightness, 128);
});

test('manual setup validates the address and refuses duplicates', async () => {
  const f = await engine.startFlow('wiz');
  assert.equal(f.type, 'form');
  const flowId = (f as { flowId: string }).flowId;
  const bad = await engine.flowStep(flowId, { host: 'not an ip' });
  assert.match(JSON.stringify(bad), /Enter an IPv4 address/);
  const dup = await engine.flowStep(flowId, { host: '127.0.0.1' });
  assert.equal(dup.type, 'abort');
  assert.match((dup as { reason: string }).reason, /already set up/);
  const nobody = await engine.startFlow('wiz');
  const r = await engine.flowStep((nobody as { flowId: string }).flowId, { host: '127.0.0.2' });
  assert.match(JSON.stringify(r), /No WiZ device answered at 127.0.0.2/);
});

test('an unanswering bulb becomes unavailable; removing the entry removes the device', async () => {
  sim.silent = true;
  await until('unavailable', () => states.get('light.wiz_light_127_0_0_1')?.state === 'unavailable', 15000);
  sim.silent = false;
  await until('back', () => states.get('light.wiz_light_127_0_0_1')?.state === 'on', 15000);
  const [entry] = await engine.entries();
  assert.equal(entry.name, 'WiZ');
  await engine.removeEntry(entry.entryId);
  assert.equal(registry.entity('light.wiz_light_127_0_0_1'), null);
  assert.deepEqual(await engine.entries(), []);
});
