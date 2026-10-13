import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { RuleEngine, type EngineDeps } from '../src/automation/engine.ts';
import { normalizeRule, type Rule, type RuleContext } from '../src/automation/rules.ts';
import { RateLimiter } from '../src/automation/runner.ts';
import * as runs from '../src/automation/runs.ts';
import { addScene, getScene, initScenes } from '../src/automation/scenes.ts';
import * as store from '../src/automation/store.ts';
import { openDb, db } from '../src/core/db.ts';
import type { Value } from '../src/core/metrics.ts';
import type { SettingDef } from '../src/devices/types.ts';

const MIN = 60_000;
const DEFS: SettingDef[] = [
  { key: 'output_source_priority', label: 'Output source priority', section: 'IO', type: 'select', options: ['Utility first', 'Solar first', 'Solar/Battery/Utility'] },
  { key: 'max_charge_current', label: 'Max charge current', section: 'Battery', type: 'number', min: 10, max: 120, unit: 'A' },
];
const CTX: RuleContext = {
  connected: true, modelName: 'Test', inverterCount: 1, defs: DEFS,
  sceneExists: (id) => getScene(id) !== null, automationExists: (id) => store.get(id) !== null,
};

interface Timer {
  at: number;
  fn: () => void;
}

function harness(start = '2026-10-12T05:00:00Z') {
  const h = {
    now: Date.parse(start),
    metrics: { 'Battery state of charge': 50 } as Record<string, Value>,
    values: [{ output_source_priority: 'Solar/Battery/Utility', max_charge_current: 80 }] as Record<string, Value>[],
    writes: [] as { key: string; value: Value }[],
    notes: [] as string[],
    alerts: [] as { id: string; level: string }[],
    suspended: false,
    connected: true,
    timers: new Set<Timer>(),
    notifyResult: { ok: true } as { ok: boolean; error?: string },
    engine: null as unknown as RuleEngine,
    deps: null as unknown as EngineDeps,
  };
  h.deps = {
    now: () => h.now,
    tz: () => 'UTC',
    connected: () => h.connected,
    suspended: () => h.suspended,
    metrics: () => h.metrics,
    gridAvailable: () => true,
    price: () => null,
    prices: () => [],
    forecast: () => ({ today_sun: null, tomorrow_sun: null }),
    location: () => null,
    alerts: () => h.alerts,
    inverterCount: () => 1,
    defs: () => DEFS,
    values: (i) => h.values[i] ?? {},
    setSetting: async (i, key, value) => {
      h.writes.push({ key, value });
      h.values[i][key] = value;
      return { ok: true, message: `Set '${key}' to '${value}'` };
    },
    limiter: new RateLimiter(0, 0),
    rules: () => store.rules(),
    automationEnabled: (id) => store.get(id)?.enabled ?? null,
    setAutomationEnabled: (id, on) => void store.update(id, { enabled: on }),
    scene: (id) => getScene(id),
    notify: async (_c, title, message) => {
      h.notes.push(`${title}: ${message}`);
      return h.notifyResult;
    },
    mqttPublish: () => null,
    log: { info: () => {}, warn: () => {} },
    setTimer: (fn, ms) => {
      const t = { at: h.now + ms, fn };
      h.timers.add(t);
      return t;
    },
    clearTimer: (t) => void h.timers.delete(t as Timer),
  };
  h.engine = new RuleEngine(h.deps);
  return {
    ...h,
    h,
    /** Moves the clock, firing due timers in order, then evaluates once. */
    async advance(ms: number) {
      const end = h.now + ms;
      for (;;) {
        const due = [...h.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        h.timers.delete(due);
        h.now = Math.max(h.now, due.at);
        due.fn();
        await h.engine.evaluate('test'); // drains the queue behind the timer's work
      }
      h.now = end;
      await h.engine.evaluate('test');
    },
    eval: () => h.engine.evaluate('test'),
    /** Simulates a process restart: fresh in-memory state, same database. */
    restart() {
      h.engine.stop();
      h.timers.clear();
      h.engine = new RuleEngine(h.deps);
    },
    rule(cfg: unknown, name = '', enabled = true): Rule {
      return store.add('rule', name, normalizeRule(cfg, CTX), enabled, h.now) as unknown as Rule;
    },
  };
}

const setPrio = (value: string) => ({ kind: 'set_setting', setting: 'output_source_priority', value });
const runsOf = (id: number) => runs.listRuns({ automationId: id, limit: 100 });

beforeEach(() => {
  openDb(':memory:');
  store.initStore();
  runs.initRuns();
  initScenes();
});

describe('rule engine: triggers', () => {
  it('fires metric triggers on the edge, after the hold time, and re-arms', async () => {
    const t = harness();
    const r = t.rule({
      triggers: [{ kind: 'metric', metric: 'Battery state of charge', op: 'below', value: 20, forMinutes: 10 }],
      actions: [{ kind: 'notify', message: 'low {soc}' }],
      options: { cooldownMinutes: 0 },
    });
    await t.eval(); // baseline at 50%
    t.h.metrics['Battery state of charge'] = 15;
    await t.eval();
    await t.advance(5 * MIN);
    assert.equal(t.h.notes.length, 0);
    await t.advance(5 * MIN);
    assert.deepEqual(t.h.notes, ['Sunroost: low 15%']);
    await t.advance(20 * MIN);
    assert.equal(t.h.notes.length, 1, 'stays fired while inside');
    t.h.metrics['Battery state of charge'] = 25;
    await t.eval();
    t.h.metrics['Battery state of charge'] = 18;
    await t.eval();
    await t.advance(9 * MIN);
    t.h.metrics['Battery state of charge'] = 21; // leaves before the hold time
    await t.eval();
    t.h.metrics['Battery state of charge'] = 18;
    await t.advance(10 * MIN);
    assert.equal(t.h.notes.length, 1);
    await t.advance(10 * MIN);
    assert.equal(t.h.notes.length, 2);
    assert.equal(runsOf(r.id).length, 2);
  });

  it('does not fire when the value is already inside at start (baseline)', async () => {
    const t = harness();
    t.h.metrics['Battery state of charge'] = 10;
    t.rule({ triggers: [{ kind: 'metric', metric: 'Battery state of charge', op: 'below', value: 20, forMinutes: 0 }], actions: [{ kind: 'notify', message: 'x' }] });
    await t.eval();
    await t.advance(MIN);
    assert.equal(t.h.notes.length, 0);
  });

  it('fires scheduled triggers once, survives a restart and catches up within the grace period', async () => {
    const t = harness('2026-10-12T05:58:00Z');
    t.rule({ triggers: [{ kind: 'time', at: '06:00' }], actions: [{ kind: 'notify', message: 'six' }] });
    await t.eval();
    assert.equal(t.h.notes.length, 0);
    await t.advance(2 * MIN + 1000); // the engine's own wake timer fires at 06:00
    assert.equal(t.h.notes.length, 1);
    await t.eval();
    t.restart();
    t.h.now += 60_000;
    await t.eval();
    assert.equal(t.h.notes.length, 1, 'no double fire after restart');
    // Down over the next fire: back 4 minutes late → still fires once.
    t.restart();
    t.h.now = Date.parse('2026-10-13T06:04:00Z');
    await t.eval();
    assert.equal(t.h.notes.length, 2);
    // Down for longer than the grace period → skipped.
    t.restart();
    t.h.now = Date.parse('2026-10-14T06:30:00Z');
    await t.eval();
    assert.equal(t.h.notes.length, 2);
  });

  it('fires grid and alert triggers on transitions', async () => {
    const t = harness();
    t.rule({ triggers: [{ kind: 'grid', event: 'lost' }], actions: [{ kind: 'notify', message: 'lost' }], options: { cooldownMinutes: 0 } });
    t.rule({ triggers: [{ kind: 'alert', level: 'warn' }], actions: [{ kind: 'notify', message: 'warn' }], options: { cooldownMinutes: 0 } });
    await t.eval();
    t.h.alerts = [{ id: 'grid-outage', level: 'bad' }, { id: 'inverter-hot', level: 'warn' }];
    await t.eval();
    await t.eval();
    assert.deepEqual(t.h.notes.sort(), ['Sunroost: lost', 'Sunroost: warn']);
  });

  it('runs else actions when conditions fail and records skipped runs otherwise', async () => {
    const t = harness();
    const a = t.rule({
      triggers: [{ kind: 'interval', everyMinutes: 5 }],
      conditions: { op: 'and', items: [{ kind: 'metric', metric: 'Battery state of charge', op: 'below', value: 20 }] },
      actions: [{ kind: 'notify', message: 'then' }],
      elseActions: [{ kind: 'notify', message: 'else' }],
      options: { cooldownMinutes: 0 },
    });
    const b = t.rule({
      triggers: [{ kind: 'interval', everyMinutes: 5 }],
      conditions: { op: 'and', items: [{ kind: 'grid', available: false }] },
      actions: [{ kind: 'notify', message: 'b' }],
      options: { cooldownMinutes: 0 },
    });
    await t.advance(5 * MIN);
    assert.deepEqual(t.h.notes, ['Sunroost: else']);
    const [skip] = runsOf(b.id);
    assert.equal(skip.result, 'skipped');
    assert.equal(skip.actions[0].message, 'Grid is available');
    assert.equal(runsOf(a.id)[0].result, 'ok');
  });
});

describe('rule engine: limits and arbitration', () => {
  it('applies cooldown and maxRunsPerDay', async () => {
    const t = harness();
    const a = t.rule({ triggers: [{ kind: 'interval', everyMinutes: 5 }], actions: [{ kind: 'notify', message: 'a' }], options: { cooldownMinutes: 12 } });
    for (let i = 0; i < 4; i++) await t.advance(5 * MIN);
    // Fires at 05:05, skipped 05:10 and 05:15 (cooldown), fires 05:20.
    assert.equal(t.h.notes.length, 2);
    assert.deepEqual(runsOf(a.id).map((r) => r.result), ['ok', 'skipped', 'skipped', 'ok']);
    assert.match(runsOf(a.id)[1].actions[0].message, /^Cooldown/);

    store.update(a.id, { enabled: false });
    t.h.engine.stop();
    const t2 = harness('2026-10-13T05:00:00Z');
    const b = t2.rule({ triggers: [{ kind: 'interval', everyMinutes: 5 }], actions: [{ kind: 'notify', message: 'b' }], options: { cooldownMinutes: 0, maxRunsPerDay: 2 } });
    for (let i = 0; i < 4; i++) await t2.advance(5 * MIN);
    assert.equal(t2.h.notes.length, 2);
    assert.match(runsOf(b.id)[0].actions[0].message, /Daily limit reached/);
  });

  it('lets the higher priority win a setting and records the overridden action', async () => {
    const t = harness('2026-10-12T05:59:00Z');
    const low = t.rule({ priority: 20, triggers: [{ kind: 'time', at: '06:00' }], actions: [setPrio('Solar first'), { kind: 'notify', message: 'low' }] });
    const high = t.rule({ priority: 80, triggers: [{ kind: 'time', at: '06:00' }], actions: [setPrio('Utility first')] });
    await t.eval();
    await t.advance(2 * MIN);
    assert.deepEqual(t.h.writes, [{ key: 'output_source_priority', value: 'Utility first' }]);
    const lost = runsOf(low.id)[0];
    assert.equal(lost.actions[0].message, `skipped (overridden by #${high.id})`);
    assert.equal(lost.actions[1].message, 'Sent', 'other actions of the losing rule still run');
    assert.equal(runsOf(high.id)[0].result, 'ok');
  });

  it('breaks priority ties by the most recent trigger', async () => {
    const t = harness('2026-10-12T05:58:00Z');
    t.rule({ priority: 50, triggers: [{ kind: 'time', at: '06:01' }], actions: [setPrio('Solar first')] });
    const first = t.rule({ priority: 50, triggers: [{ kind: 'time', at: '06:00' }], actions: [setPrio('Utility first')] });
    await t.eval();
    t.h.now = Date.parse('2026-10-12T06:01:30Z'); // both due in one evaluation
    await t.eval();
    assert.deepEqual(t.h.writes.map((w) => w.value), ['Solar first']);
    assert.match(runsOf(first.id)[0].actions[0].message, /overridden/);
  });

  it('writes nothing while suspended or disconnected but still notifies', async () => {
    const t = harness();
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [setPrio('Utility first'), { kind: 'notify', message: 'n' }] });
    t.h.suspended = true;
    const run = await t.h.engine.runNow(r);
    assert.equal(t.h.writes.length, 0);
    assert.equal(run.actions[0].message, 'Skipped: automations are suspended');
    assert.equal(run.result, 'ok');
    t.h.notifyResult = { ok: false, error: 'ntfy.sh answered HTTP 500' };
    t.h.suspended = false;
    t.h.connected = false;
    const run2 = await t.h.engine.runNow(r);
    assert.equal(run2.actions[0].message, 'Skipped: not connected to the inverter');
    assert.equal(run2.actions[1].message, 'ntfy.sh answered HTTP 500');
    assert.equal(run2.result, 'failed');
  });
});

describe('rule engine: reverts and delays', () => {
  it('restores the previous value after the duration, also after a restart', async () => {
    const t = harness('2026-10-12T05:59:00Z');
    const r = t.rule({ triggers: [{ kind: 'time', at: '06:00' }], actions: [setPrio('Utility first')], options: { revertAfterMinutes: 30 } });
    await t.eval();
    await t.advance(2 * MIN);
    assert.equal(t.h.values[0].output_source_priority, 'Utility first');
    assert.equal(runs.reverts().length, 1);
    t.restart();
    await t.advance(20 * MIN);
    assert.equal(t.h.values[0].output_source_priority, 'Utility first');
    await t.advance(10 * MIN);
    assert.equal(t.h.values[0].output_source_priority, 'Solar/Battery/Utility');
    assert.equal(runs.reverts().length, 0);
    assert.equal(runsOf(r.id)[0].trigger, 'Revert after 30 min');
  });

  it('does not revert when another run changed the setting in between', async () => {
    const t = harness();
    const a = t.rule({ triggers: [{ kind: 'manual' }], actions: [setPrio('Utility first')], options: { revertAfterMinutes: 30 } });
    const b = t.rule({ triggers: [{ kind: 'manual' }], actions: [setPrio('Solar first')] });
    await t.h.engine.runNow(a);
    await t.advance(5 * MIN);
    await t.h.engine.runNow(b);
    assert.equal(runs.reverts().length, 0);
    await t.advance(30 * MIN);
    assert.equal(t.h.values[0].output_source_priority, 'Solar first');

    // Changed by hand: the revert is dropped and reported.
    await t.h.engine.runNow(a);
    t.h.values[0].output_source_priority = 'Solar first';
    await t.advance(31 * MIN);
    assert.equal(t.h.values[0].output_source_priority, 'Solar first');
    assert.match(runsOf(a.id)[0].actions[0].message, /Not restored/);
  });

  it('runs actions after a delay and a new run cancels the pending ones', async () => {
    const t = harness();
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'notify', message: 'A' }, { kind: 'delay', minutes: 10 }, { kind: 'notify', message: 'B' }] });
    const first = await t.h.engine.runNow(r);
    assert.deepEqual(t.h.notes, ['Sunroost: A']);
    await t.advance(5 * MIN);
    await t.h.engine.runNow(r);
    assert.match(runs.getRun(first.id)!.actions.at(-1)!.message, /Cancelled: a newer run/);
    await t.advance(10 * MIN);
    assert.deepEqual(t.h.notes, ['Sunroost: A', 'Sunroost: A', 'Sunroost: B']);
    const last = runsOf(r.id)[0];
    assert.deepEqual(last.actions.map((a) => a.text), ['Send an app notification', 'Wait 10 min', 'Send an app notification']);
    assert.equal(last.result, 'ok');
  });
});

describe('scenes and dry run', () => {
  it('applies a scene and records a run', async () => {
    const t = harness();
    const s = addScene({ name: 'Night', icon: 'moon', color: 'battery', settings: [{ inverter: 'all', setting: 'output_source_priority', value: 'Utility first' }, { inverter: 0, setting: 'max_charge_current', value: 40 }] });
    t.h.suspended = true; // applying by hand works while automations are suspended
    const run = await t.h.engine.applyScene(s);
    assert.equal(run.sceneId, s.id);
    assert.equal(run.result, 'ok');
    assert.equal(run.actions.length, 2);
    assert.deepEqual(t.h.values[0], { output_source_priority: 'Utility first', max_charge_current: 40 });
    // As a rule action, scene writes are expanded and take part in arbitration.
    t.h.suspended = false;
    const r = t.rule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'scene', scene: s.id }] });
    t.h.values[0].max_charge_current = 80;
    const run2 = await t.h.engine.runNow(r);
    assert.deepEqual(run2.actions.map((a) => a.message), ['Already set', "Set 'max_charge_current' to '40'"]);
  });

  it('dry run reports conditions, actions and arbitration without side effects', async () => {
    const t = harness();
    t.rule({ priority: 90, triggers: [{ kind: 'manual' }], actions: [setPrio('Solar first')] }, 'other');
    const r = t.rule({
      priority: 40,
      triggers: [{ kind: 'interval', everyMinutes: 5 }],
      conditions: { op: 'and', items: [{ kind: 'metric', metric: 'Battery state of charge', op: 'above', value: 40 }] },
      actions: [setPrio('Utility first'), { kind: 'delay', minutes: 5 }, { kind: 'notify', message: 'SOC {soc}' }],
      options: { revertAfterMinutes: 10 },
    });
    const count = () => ['automation_runs', 'automation_reverts', 'automation_trigger_state'].map((tb) => (db().prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get() as { n: number }).n);
    const before = count();
    const d = t.h.engine.dryRun(r);
    assert.deepEqual(count(), before);
    assert.equal(t.h.writes.length + t.h.notes.length + t.h.timers.size, 0);
    assert.equal(d.dryRun, true);
    assert.equal(d.conditions.match, true);
    assert.equal(d.conditions.items![0].text, 'Battery state of charge 50% is above 40%');
    assert.equal(d.branch, 'actions');
    assert.deepEqual(d.wouldRun[0], {
      kind: 'set_setting', text: 'Set Output source priority to Utility first', inverter: 0, setting: 'output_source_priority',
      value: 'Utility first', current: 'Solar/Battery/Utility', outcome: 'Would write',
    });
    assert.equal(d.wouldRun[2].outcome, 'Would send "Sunroost: SOC 50%"');
    assert.equal(d.arbitration[0].wins, false);
    assert.equal(d.arbitration[0].competitors[0].priority, 90);
  });
});
