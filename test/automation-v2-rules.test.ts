import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../src/automation/conditions.ts';
import { evalGroup, normalizeRule, summarize, type RuleContext, type RuleEnv } from '../src/automation/rules.ts';
import type { SettingDef } from '../src/devices/types.ts';

const DEFS: SettingDef[] = [
  { key: 'output_source_priority', label: 'Output source priority', section: 'IO', type: 'select', options: ['Utility first', 'Solar first', 'Solar/Battery/Utility'] },
  { key: 'max_charge_current', label: 'Max charge current', section: 'Battery', type: 'number', min: 10, max: 120, unit: 'A' },
];

const CTX: RuleContext = {
  connected: true, modelName: 'Test', inverterCount: 1, defs: DEFS,
  sceneExists: (id) => id === 1, automationExists: (id) => id === 7,
};

function env(extra: Partial<RuleEnv> & { metrics?: Record<string, number> } = {}): RuleEnv {
  const m = extra.metrics ?? { 'Battery state of charge': 40, 'PV power': 1200 };
  return {
    now: Date.parse('2026-10-12T23:00:00Z'), // Monday 23:00 UTC
    tz: 'UTC',
    metric: (n) => m[n] ?? null,
    gridAvailable: true,
    price: 0.2,
    inCheapestHours: () => null,
    sunUp: false,
    forecast: { today_sun: 12, tomorrow_sun: 4 },
    inverterCount: 1,
    values: () => ({ output_source_priority: 'Solar first' }),
    automationEnabled: (id) => (id === 7 ? true : null),
    defs: DEFS,
    ...extra,
  };
}

describe('rule validation', () => {
  it('normalizes a full rule', () => {
    const cfg = normalizeRule({
      priority: '70',
      triggers: [{ kind: 'time', at: '6', days: ['Mon', 'Tue'] }, { kind: 'metric', metric: 'Battery state of charge', op: 'below', value: '20%', forMinutes: 5 }],
      conditions: { op: 'or', items: [{ kind: 'grid', available: true }, { op: 'and', items: [{ kind: 'sun', is: 'down' }] }] },
      actions: [{ kind: 'set_setting', setting: 'Output source priority', value: 'utility first' }, { kind: 'delay', minutes: 10 }, { kind: 'scene', scene: 1 }],
      options: { cooldownMinutes: 0, activeFrom: '11-01', activeTo: '02-28' },
    }, CTX);
    assert.equal(cfg.priority, 70);
    assert.deepEqual(cfg.triggers[0], { kind: 'time', at: '06:00', days: [1, 2] });
    assert.equal((cfg.triggers[1] as { value: number }).value, 20);
    assert.deepEqual(cfg.actions[0], { kind: 'set_setting', inverter: 'all', setting: 'output_source_priority', value: 'Utility first' });
    assert.equal(cfg.options.revertAfterMinutes, 0);
    assert.equal(cfg.options.activeTo, '02-28');
  });

  it('rejects invalid rules with clear messages', () => {
    const ok = { triggers: [{ kind: 'manual' }], actions: [{ kind: 'notify', message: 'x' }] };
    assert.throws(() => normalizeRule({ ...ok, triggers: [] }, CTX), /at least one trigger/);
    assert.throws(() => normalizeRule({ ...ok, actions: [{ kind: 'set_setting', setting: 'nope', value: 1 }] }, CTX), /"nope" is not a setting of Test/);
    assert.throws(() => normalizeRule({ ...ok, actions: [{ kind: 'set_setting', setting: 'max_charge_current', value: 500 }] }, CTX), /at most 120/);
    assert.throws(() => normalizeRule({ ...ok, triggers: [{ kind: 'interval', everyMinutes: 2 }] }, CTX), ValidationError);
    assert.throws(() => normalizeRule({ ...ok, actions: [{ kind: 'delay', minutes: 500 }] }, CTX), /between 1 and 240/);
    assert.throws(() => normalizeRule({ ...ok, actions: [{ kind: 'scene', scene: 9 }] }, CTX), /scene #9 does not exist/);
    const deep = { op: 'and', items: [{ op: 'or', items: [{ op: 'and', items: [{ op: 'or', items: [] }] }] }] };
    assert.throws(() => normalizeRule({ ...ok, conditions: deep }, CTX), /nested at most 2 levels/);
    assert.throws(() => normalizeRule({ ...ok, options: { activeFrom: '01-01' } }, CTX), /both a start and an end/);
  });

  it('writes a human summary', () => {
    const cfg = normalizeRule({
      triggers: [{ kind: 'time', at: '22:00', days: [1, 2, 3, 4, 5] }],
      conditions: { op: 'and', items: [{ kind: 'metric', metric: 'Battery state of charge', op: 'below', value: 50 }] },
      actions: [{ kind: 'set_setting', setting: 'output_source_priority', value: 'Utility first' }, { kind: 'notify', channel: 'app', message: 'hi' }],
      options: { revertAfterMinutes: 60 },
    }, CTX);
    assert.equal(
      summarize(cfg, DEFS),
      'At 22:00 on weekdays, if battery state of charge is below 50%, set Output source priority to Utility first and send an app notification, reverting after 60 min.',
    );
  });
});

describe('condition groups', () => {
  const group = (raw: unknown) => normalizeRule({ triggers: [{ kind: 'manual' }], actions: [{ kind: 'notify', message: 'x' }], conditions: raw }, CTX).conditions;

  it('evaluates and/or with nesting and reports per-condition detail', () => {
    const g = group({
      op: 'and',
      items: [
        { kind: 'time_between', from: '22:00', to: '06:00' },
        { op: 'or', items: [{ kind: 'metric', metric: 'Battery state of charge', op: 'below', value: 30 }, { kind: 'forecast', metric: 'tomorrow_sun', op: 'below', value: 5 }] },
      ],
    });
    const d = evalGroup(g, env());
    assert.equal(d.match, true);
    assert.equal(d.items![0].text, 'Time 23:00 is between 22:00 and 06:00');
    assert.equal(d.items![1].items![0].match, false);
    assert.equal(d.items![1].items![1].match, true);
    assert.equal(evalGroup(g, env({ now: Date.parse('2026-10-12T12:00:00Z') })).match, false);
    // Without a forecast the OR falls to the SOC branch.
    assert.equal(evalGroup(g, env({ forecast: { today_sun: null, tomorrow_sun: null } })).match, false);
    assert.equal(evalGroup(g, env({ forecast: { today_sun: null, tomorrow_sun: null }, metrics: { 'Battery state of charge': 25 } })).match, true);
  });

  it('evaluates every condition kind', () => {
    const e = env();
    const m = (c: unknown) => evalGroup(group({ op: 'and', items: [c] }), e).match;
    assert.equal(m({ kind: 'days', days: [1] }), true);
    assert.equal(m({ kind: 'metric', metric: 'PV power', op: 'between', value: 1000, value2: '1.5kW' }), true);
    assert.equal(m({ kind: 'grid', available: false }), false);
    assert.equal(m({ kind: 'price', op: 'below', value: 0.25 }), true);
    assert.equal(m({ kind: 'price', cheapest_hours: 3 }), false); // no price data
    assert.equal(m({ kind: 'sun', is: 'down' }), true);
    assert.equal(m({ kind: 'setting', setting: 'output_source_priority', equals: 'solar first' }), true);
    assert.equal(m({ kind: 'automation', id: 7, enabled: true }), true);
    assert.equal(m({ kind: 'date_between', from: '10-01', to: '10-31' }), true);
    assert.equal(m({ kind: 'date_between', from: '11-01', to: '02-28' }), false);
    assert.equal(evalGroup(group({ op: 'or', items: [] }), e).match, true);
  });
});
