import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import * as deviceRules from '../src/automation/devices.ts';
import { RuleEngine, type EngineDeps } from '../src/automation/engine.ts';
import { normalizeRule, setEntityNamer, summarize, type Rule, type RuleContext } from '../src/automation/rules.ts';
import { RateLimiter } from '../src/automation/runner.ts';
import * as runs from '../src/automation/runs.ts';
import { getScene, initScenes } from '../src/automation/scenes.ts';
import * as store from '../src/automation/store.ts';
import * as areas from '../src/home/areas.ts';
import { newContext } from '../src/home/bus.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import type { DeviceEngine, EngineHost, ServiceCall } from '../src/home/types.ts';

/** Instant devices: a water heater, an AC, a fridge and a transfer switch, plus a power reading. */
class House implements DeviceEngine {
  id = 'lite' as const;
  name = 'House';
  host!: EngineHost;
  calls: ServiceCall[] = [];
  async start(host: EngineHost) {
    this.host = host;
    for (const n of ['heater', 'fridge', 'ats', 'pool']) {
      host.registerEntity({ uniqueId: n, domain: 'switch', objectId: n, name: n === 'ats' ? 'Transfer switch' : n.charAt(0).toUpperCase() + n.slice(1) });
      host.setState(`switch.${n}`, 'off');
    }
    host.registerEntity({ uniqueId: 'ac', domain: 'climate', name: 'Bedroom AC' });
    host.setState('climate.bedroom_ac', 'off', { hvac_modes: ['off', 'cool'] });
    host.registerEntity({ uniqueId: 'heater_power', domain: 'sensor', name: 'Heater power', unit: 'W', readOnly: true });
    host.setState('sensor.heater_power', '0');
  }
  async stop() {}
  async callService(call: ServiceCall) {
    this.calls.push(call);
    const next = call.service === 'turn_on' ? 'on' : call.service === 'turn_off' ? 'off' : call.service === 'set_hvac_mode' ? String(call.data.hvac_mode) : null;
    if (next) this.host.setState(call.entityId, next, states.get(call.entityId)!.attributes, newContext('device', call.context));
    return { ok: true };
  }
}

const CTX: RuleContext = {
  connected: true, modelName: 'Test', inverterCount: 1, defs: [],
  sceneExists: () => false, automationExists: (id) => store.get(id) !== null, targetExists: deviceRules.targetExists,
};

function harness() {
  const h = { now: Date.parse('2026-10-12T10:00:00Z'), suspended: false };
  const deps: EngineDeps = {
    now: () => h.now, tz: () => 'UTC', connected: () => true, suspended: () => h.suspended, metrics: () => ({}),
    gridAvailable: () => true, price: () => null, prices: () => [], forecast: () => ({ today_sun: null, tomorrow_sun: null }),
    location: () => null, alerts: () => [], inverterCount: () => 1, defs: () => [], values: () => ({}),
    setSetting: async () => ({ ok: true, message: '' }), limiter: new RateLimiter(0, 0), rules: () => store.rules(),
    automationEnabled: (id) => store.get(id)?.enabled ?? null, setAutomationEnabled: () => {}, scene: (id) => getScene(id),
    notify: async () => ({ ok: true }), mqttPublish: () => null, log: { info: () => {}, warn: () => {} },
    entity: (id) => states.get(id)?.state ?? null,
    deviceAction: (rule, a, overridden) => deviceRules.run(rule, a, h.now, overridden),
    devicePreview: (rule, a) => deviceRules.preview(rule, a, h.now),
    deviceTargets: (a) => deviceRules.targetsOf(a),
    deviceTimers: (now, suspended) => deviceRules.processTimers(now, suspended),
    maxRunsPer10Min: () => Number(settings.get('automation.max_runs_per_10min')) || 0,
  };
  const engine = new RuleEngine(deps);
  return {
    h,
    engine,
    eval: () => engine.evaluate('test'),
    rule: (cfg: unknown, name = '') => store.add('rule', name, normalizeRule(cfg, CTX), true, h.now) as unknown as Rule,
    lastRun: (id: number) => runs.listRuns({ automationId: id, limit: 1 })[0],
  };
}

let house: House;
beforeEach(async () => {
  openDb(':memory:');
  settings.init();
  store.initStore();
  runs.initRuns();
  initScenes();
  deviceRules.initTimers();
  registry.init();
  areas.init();
  states.reset();
  deviceRules.resetGuards();
  setEntityNamer(deviceRules.targetName);
  house = new House();
  await house.start(hostFor('lite'));
  setEngineLookup((id) => (id === 'lite' ? house : null));
});

const notify = { kind: 'notify', message: 'x' };

describe('device triggers', () => {
  it('fires when a device enters a state and stayed there, not on the baseline, and re-arms', async () => {
    const t = harness();
    states.set('switch.heater', 'on');
    const r = t.rule({ triggers: [{ kind: 'device', entity: 'switch.heater', to: 'on', forMinutes: 5 }], actions: [notify], options: { cooldownMinutes: 0 } });
    await t.eval();
    assert.equal(t.lastRun(r.id), undefined, 'already on when the rule was made: baseline');
    states.set('switch.heater', 'off');
    await t.eval();
    states.set('switch.heater', 'on');
    await t.eval();
    t.h.now += 4 * 60_000;
    await t.eval();
    assert.equal(t.lastRun(r.id), undefined, 'not yet on for 5 minutes');
    t.h.now += 60_000;
    await t.eval();
    assert.match(t.lastRun(r.id).trigger, /When Heater turns on for 5 min/);
    t.h.now += 60_000;
    await t.eval();
    assert.equal(runs.listRuns({ automationId: r.id, limit: 10 }).length, 1, 'fires once per entry');
  });

  it('"changes from" and any-change triggers', async () => {
    const t = harness();
    const fromCool = t.rule({ triggers: [{ kind: 'device', entity: 'climate.bedroom_ac', from: 'cool', to: 'off' }], actions: [notify], options: { cooldownMinutes: 0 } });
    const any = t.rule({ triggers: [{ kind: 'device', entity: 'switch.pool' }], actions: [notify], options: { cooldownMinutes: 0 } });
    await t.eval();
    states.set('climate.bedroom_ac', 'cool');
    states.set('switch.pool', 'on');
    await t.eval();
    assert.equal(t.lastRun(fromCool.id), undefined);
    assert.ok(t.lastRun(any.id), 'any change fires');
    states.set('climate.bedroom_ac', 'off');
    await t.eval();
    assert.ok(t.lastRun(fromCool.id), 'cool → off fires');
  });

  it('device readings work as values in triggers and conditions', async () => {
    const t = harness();
    const r = t.rule({
      triggers: [{ kind: 'metric', metric: 'sensor.heater_power', op: 'above', value: 1500, forMinutes: 0 }],
      conditions: { op: 'and', items: [{ kind: 'device', entity: 'switch.heater', is: 'on' }] },
      actions: [notify], elseActions: [{ kind: 'notify', message: 'else' }], options: { cooldownMinutes: 0 },
    });
    await t.eval();
    states.set('sensor.heater_power', '2000');
    await t.eval();
    const run = t.lastRun(r.id);
    assert.ok(run, 'reading crossed 1500 W');
    assert.equal(run.actions[0].text, 'Send an app notification', 'heater is off, so the else branch ran');
    assert.match(summarize(r.config), /When Heater power rises above 1500 W, if Heater is on/);
  });
});

describe('device actions and guard rails', () => {
  it('controls a device, traced to the rule', async () => {
    const t = harness();
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_on', data: {} }] });
    const run = await t.engine.runNow(r);
    assert.deepEqual(run.actions, [{ text: 'Turn on Heater', ok: true, message: 'Done' }]);
    assert.equal(states.get('switch.heater')!.state, 'on');
    const ctx = house.calls[0].context;
    assert.deepEqual([ctx.origin, ctx.ruleId], ['rule', r.id]);
  });

  it('role and room targets, with protected and critical devices respected', async () => {
    const t = harness();
    for (const [id, role] of [['switch.heater', 'sheddable'], ['switch.pool', 'sheddable'], ['switch.fridge', 'critical'], ['switch.ats', 'protected']] as const) {
      registry.updateEntity(id, { role });
      states.set(id, 'on');
    }
    const shed = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'role:sheddable', service: 'turn_off', data: {} }] });
    const run = await t.engine.runNow(shed);
    assert.deepEqual(run.actions.map((a) => a.text).sort(), ['Turn off Heater', 'Turn off Pool']);
    assert.equal(states.get('switch.heater')!.state, 'off');

    const critical = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.fridge', service: 'turn_off', data: {} }] });
    assert.match((await t.engine.runNow(critical)).actions[0].message!, /Critical device/);
    assert.equal(states.get('switch.fridge')!.state, 'on');

    const ats = { kind: 'device', target: 'switch.ats', service: 'turn_off', data: {} };
    assert.match((await t.engine.runNow(t.rule({ triggers: [{ kind: 'manual' }], actions: [ats] }))).actions[0].message!, /Protected device/);
    assert.equal(states.get('switch.ats')!.state, 'on');
    const allowed = await t.engine.runNow(t.rule({ triggers: [{ kind: 'manual' }], actions: [{ ...ats, allowProtected: true }] }));
    assert.equal(allowed.actions[0].message, 'Done');

    areas.create('Garden');
    registry.updateEntity('switch.pool', { areaId: 'garden' });
    states.set('switch.pool', 'off');
    t.h.now += 3 * 60_000;
    const room = await t.engine.runNow(t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'area:garden', service: 'turn_on', data: {} }] }));
    assert.deepEqual(room.actions.map((a) => [a.text, a.message]), [['Turn on Pool', 'Done']]);
  });

  it('holds a device an automation switched less than 2 minutes ago, and skips no-op commands', async () => {
    const t = harness();
    const on = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_on', data: {} }] });
    const off = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_off', data: {} }] });
    await t.engine.runNow(on);
    assert.equal((await t.engine.runNow(on)).actions[0].message, 'Already on');
    t.h.now += 60_000;
    const held = await t.engine.runNow(off);
    assert.match(held.actions[0].message!, /Held: an automation switched it 60 s ago/);
    assert.equal(states.get('switch.heater')!.state, 'on');
    t.h.now += 61_000;
    assert.equal((await t.engine.runNow(off)).actions[0].message, 'Done');
  });

  it('suspension stops device actions; the dry run says what would happen', async () => {
    const t = harness();
    registry.updateEntity('switch.ats', { role: 'protected' });
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [
      { kind: 'device', target: 'climate.bedroom_ac', service: 'set_hvac_mode', data: { hvac_mode: 'cool' } },
      { kind: 'device', target: 'switch.ats', service: 'turn_on', data: {} },
    ] });
    const dry = t.engine.dryRun(r);
    assert.deepEqual(dry.wouldRun.map((w) => [w.text, w.outcome]), [
      ['Set Bedroom AC to cool', 'Would send'],
      ['Turn on Transfer switch', 'Protected device: this action is not allowed to switch it'],
    ]);
    assert.equal(house.calls.length, 0, 'a dry run sends nothing');
    t.h.suspended = true;
    const run = await t.engine.runNow(r);
    assert.ok(run.actions.every((a) => a.skipped && /suspended/.test(a.message!)));
    assert.equal(states.get('climate.bedroom_ac')!.state, 'off');
  });
});

describe('safety: interlocks, timers, priority, limits', () => {
  it('an interlock refuses every command, manual or automatic, while it fails', async () => {
    const t = harness();
    registry.updateEntity('switch.ats', { role: 'protected', interlock: { maxLoadW: 3000, gridAvailable: true } });
    const manual = async () => (await callService('switch', 'turn_on', 'switch.ats')).results['switch.ats'].message;
    assert.match((await manual())!, /Interlock: the house load is unknown/);
    // The energy engine's entities are what interlocks read.
    registry.registerEntity('energy', { uniqueId: 'total:Load power', domain: 'sensor', name: 'Load power', objectId: 'load_power', readOnly: true });
    registry.registerEntity('energy', { uniqueId: 'grid:available', domain: 'binary_sensor', name: 'Grid available', objectId: 'grid_available', readOnly: true });
    states.set('sensor.load_power', '4200');
    states.set('binary_sensor.grid_available', 'on');
    assert.match((await manual())!, /load is 4200 W \(limit 3000 W\)/);
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.ats', service: 'turn_on', data: {}, allowProtected: true }] });
    assert.match((await t.engine.runNow(r)).actions[0].message!, /Interlock: the house load is 4200 W/);
    states.set('sensor.load_power', '1200');
    states.set('binary_sensor.grid_available', 'off');
    assert.match((await manual())!, /Interlock: the grid is down/);
    states.set('binary_sensor.grid_available', 'on');
    assert.equal((await t.engine.runNow(r)).actions[0].message, 'Done');
  });

  it('off-timer: device-timed when supported, and Sunroost switches it off when due', async () => {
    const t = harness();
    states.set('switch.heater', 'off', { supports_auto_off: true });
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_on', data: {}, autoOffMinutes: 30 }] });
    const run = await t.engine.runNow(r);
    assert.match(run.actions[0].message!, /off again after 30 min \(timed by the device too\)/);
    assert.equal(house.calls.at(-1)!.data.auto_off_s, 1800, 'the device gets the timer');
    const pool = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.pool', service: 'turn_on', data: {}, autoOffMinutes: 10 }] });
    await t.engine.runNow(pool);
    assert.equal(house.calls.at(-1)!.data.auto_off_s, undefined, 'devices without timers never see the key');
    t.h.now += 11 * 60_000;
    await t.eval();
    assert.equal(states.get('switch.pool')!.state, 'off', 'Sunroost switched it off');
    assert.equal(states.get('switch.heater')!.state, 'on', 'not due yet');
    assert.match(runs.listRuns({ limit: 1 })[0].trigger, /Auto-off after 10 min/);
    assert.throws(() => normalizeRule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.pool', service: 'turn_off', autoOffMinutes: 5 }] }, CTX), /only applies to "turn on"/);
  });

  it('revert after N minutes restores the previous state, unless someone changed it since', async () => {
    const t = harness();
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'climate.bedroom_ac', service: 'set_hvac_mode', data: { hvac_mode: 'cool' } }], options: { revertAfterMinutes: 20 } });
    assert.match((await t.engine.runNow(r)).actions[0].message!, /restored after 20 min/);
    assert.equal(states.get('climate.bedroom_ac')!.state, 'cool');
    t.h.now += 21 * 60_000;
    await t.eval();
    assert.equal(states.get('climate.bedroom_ac')!.state, 'off', 'restored');

    t.h.now += 3 * 60_000;
    await t.engine.runNow(r);
    states.set('climate.bedroom_ac', 'heat'); // someone changed it by hand
    t.h.now += 21 * 60_000;
    await t.eval();
    assert.equal(states.get('climate.bedroom_ac')!.state, 'heat');
    assert.match(runs.listRuns({ limit: 1 })[0].actions[0].message!, /Not restored: it was changed since/);
  });

  it('two rules commanding the same device at once: the higher priority wins', async () => {
    const t = harness();
    const low = t.rule({ priority: 10, triggers: [{ kind: 'device', entity: 'switch.pool', to: 'on' }], actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_on', data: {} }], options: { cooldownMinutes: 0 } });
    const high = t.rule({ priority: 90, triggers: [{ kind: 'device', entity: 'switch.pool', to: 'on' }], actions: [{ kind: 'device', target: 'role:sheddable', service: 'turn_off', data: {} }], options: { cooldownMinutes: 0 } });
    registry.updateEntity('switch.heater', { role: 'sheddable' });
    states.set('switch.heater', 'on');
    await t.eval();
    states.set('switch.pool', 'on');
    await t.eval();
    assert.equal(states.get('switch.heater')!.state, 'off', 'the priority-90 rule won');
    const lost = t.lastRun(low.id);
    assert.match(lost.actions[0].message!, new RegExp(`Overridden by rule #${high.id}`));
  });

  it('limits switches per hour, and pauses a rule that runs in a loop', async () => {
    const t = harness();
    settings.set('automation.device_max_switches_per_hour', 3);
    const on = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'device', target: 'switch.pool', service: 'toggle', data: {} }] });
    for (let i = 0; i < 3; i++) {
      await t.engine.runNow(on);
      t.h.now += 3 * 60_000;
    }
    assert.match((await t.engine.runNow(on)).actions[0].message!, /switched 3 times in the last hour \(limit 3\)/);

    settings.set('automation.max_runs_per_10min', 2);
    const loop = t.rule({ triggers: [{ kind: 'device', entity: 'switch.fridge' }], actions: [notify], options: { cooldownMinutes: 0 } });
    await t.eval();
    for (const st of ['on', 'off', 'on']) {
      states.set('switch.fridge', st);
      await t.eval();
    }
    const last = t.lastRun(loop.id);
    assert.match(last.actions[0].message!, /Paused by loop protection: ran 2 times in 10 minutes/);
  });
});

describe('validation and wording', () => {
  it('rejects unknown devices, rooms, roles and bad options', () => {
    const base = { triggers: [{ kind: 'manual' }] };
    assert.throws(() => normalizeRule({ ...base, actions: [{ kind: 'device', target: 'switch.nope', service: 'turn_on' }] }, CTX), /not found/);
    assert.throws(() => normalizeRule({ ...base, actions: [{ kind: 'device', target: 'area:attic', service: 'turn_on' }] }, CTX), /not found/);
    assert.throws(() => normalizeRule({ ...base, actions: [{ kind: 'device', target: 'role:vip', service: 'turn_on' }] }, CTX), /not found/);
    assert.throws(() => normalizeRule({ ...base, actions: [{ kind: 'device', target: 'switch.heater', service: 'Turn On!' }] }, CTX), /choose what to do/);
    assert.throws(() => normalizeRule({ ...base, actions: [{ kind: 'device', target: 'switch.heater', service: 'turn_on', data: { x: { y: 1 } } }] }, CTX), /invalid value/);
    assert.throws(() => normalizeRule({ triggers: [{ kind: 'device', entity: 'switch.ghost', to: 'on' }], actions: [notify] }, CTX), /not found/);
    assert.throws(() => normalizeRule({ ...base, conditions: { op: 'and', items: [{ kind: 'device', entity: 'switch.heater' }] }, actions: [notify] }, CTX), /state/);
  });

  it('summarises device rules in plain words', () => {
    const cfg = normalizeRule({
      triggers: [{ kind: 'device', entity: 'switch.heater', to: 'on', forMinutes: 30 }],
      conditions: { op: 'and', items: [{ kind: 'device', entity: 'climate.bedroom_ac', is: 'cool', not: true }] },
      actions: [
        { kind: 'device', target: 'role:sheddable', service: 'turn_off', data: {} },
        { kind: 'device', target: 'climate.bedroom_ac', service: 'set_temperature', data: { temperature: 22 } },
      ],
    }, CTX);
    assert.equal(summarize(cfg), 'When Heater turns on for 30 min, if Bedroom AC is not cool, turn off every sheddable device and set Bedroom AC to 22°.');
  });
});
