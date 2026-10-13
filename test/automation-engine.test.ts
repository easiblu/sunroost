import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ValidationError, localTime, matchCondition, normalizeCondition, parseNumber, type Inputs } from '../src/automation/conditions.ts';
import { openDb } from '../src/core/db.ts';
import { RateLimiter, Runner, type RunnerDeps } from '../src/automation/runner.ts';
import * as store from '../src/automation/store.ts';
import {
  evaluateProtection, evaluateSoc, evaluateTable, normalizeConfig, normalizeTable, socDiagram, socThresholds,
  type Automation, type EngineContext, type ProtectionConfig, type SocConfig, type TableConfig,
} from '../src/automation/types.ts';
import type { SettingDef } from '../src/devices/types.ts';
import type { Value } from '../src/core/metrics.ts';

const DEFS: SettingDef[] = [
  { key: 'output_source_priority', label: 'Output source priority', section: 'IO', type: 'select', options: ['Utility first', 'Solar first', 'Solar/Battery/Utility'] },
  { key: 'max_charge_current', label: 'Max charge current', section: 'Battery', type: 'number', min: 10, max: 120, unit: 'A' },
  { key: 'grid_first_slot_1', label: 'Grid first slot 1', section: 'Schedule', type: 'slot' },
];

const CTX: EngineContext = {
  connected: true,
  modelName: 'Test',
  inverterCount: 1,
  defs: DEFS,
  socControl: { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' },
  protection: { setting: 'output_source_priority', shutdownValue: 'Utility first' },
};

/** 2026-10-12 is a Monday. */
const at = (hhmm: string, extra: Partial<Inputs> = {}): Inputs => ({
  now: Date.parse(`2026-10-12T${hhmm}:00Z`),
  tz: 'UTC',
  soc: 50,
  gridAvailable: true,
  price: null,
  pv: 0,
  ...extra,
});

describe('conditions', () => {
  it('parses numbers with units', () => {
    assert.equal(parseNumber('20%'), 20);
    assert.equal(parseNumber(' 1.5 kW'), 1500);
    assert.equal(parseNumber('0,25 €/kWh'), 0.25);
    assert.equal(parseNumber(''), null);
    assert.throws(() => parseNumber('abc'), ValidationError);
  });

  it('matches time ranges including midnight wrap', () => {
    const night = normalizeCondition('time', { from: '22:00', to: '6' });
    assert.deepEqual(night, { from: '22:00', to: '06:00' });
    assert.equal(matchCondition('time', night, at('23:30')).match, true);
    assert.equal(matchCondition('time', night, at('02:00')).match, true);
    assert.equal(matchCondition('time', night, at('06:00')).match, false);
    assert.equal(matchCondition('time', night, at('12:00')).match, false);
    const day = normalizeCondition('time', { from: '06:00', to: '24:00' });
    assert.equal(matchCondition('time', day, at('23:59')).match, true);
    assert.equal(matchCondition('time', day, at('05:59')).match, false);
    assert.throws(() => normalizeCondition('time', { from: '25:00', to: '01:00' }), ValidationError);
  });

  it('respects the configured timezone', () => {
    const lt = localTime(Date.parse('2026-10-12T23:30:00Z'), 'Europe/Berlin');
    assert.equal(lt.minutes, 1 * 60 + 30);
    assert.equal(lt.dow, 2); // Tuesday in Berlin
  });

  it('matches day of week, SOC, grid, PV and date', () => {
    const weekdays = normalizeCondition('day', { days: ['Mon', 'Tue', 3] });
    assert.equal(matchCondition('day', weekdays, at('10:00')).match, true);
    const soc = normalizeCondition('soc', { from: '', to: '20%' });
    const r = matchCondition('soc', soc, at('10:00', { soc: 18 }));
    assert.equal(r.match, true);
    assert.equal(r.text, 'Battery SOC 18% ≤ 20%');
    assert.equal(matchCondition('soc', soc, at('10:00', { soc: 21 })).match, false);
    assert.equal(matchCondition('soc', soc, at('10:00', { soc: null })).match, false);
    assert.equal(matchCondition('grid', normalizeCondition('grid', { value: 'no' }), at('10:00', { gridAvailable: false })).match, true);
    assert.equal(matchCondition('pv', normalizeCondition('pv', { from: '1kW' }), at('10:00', { pv: 1200 })).match, true);
    const winter = normalizeCondition('date', { from: '11-01', to: '02-28' });
    assert.equal(matchCondition('date', winter, at('10:00')).match, false);
    assert.equal(matchCondition('date', winter, { ...at('10:00'), now: Date.parse('2027-01-15T10:00:00Z') }).match, true);
    assert.throws(() => normalizeCondition('soc', { from: 50, to: 20 }), ValidationError);
    assert.throws(() => normalizeCondition('soc', { to: 120 }), ValidationError);
  });
});

describe('rule table', () => {
  const cfg = normalizeTable(
    {
      setting: 'Output source priority',
      conditions: ['time', 'soc'],
      rows: [
        { when: [{ from: '22:00', to: '06:00' }, { to: '30%' }], value: 'utility first' },
        { when: [null, { to: '20' }], value: 'Utility first' },
        { when: [null, { from: '50%' }], value: 'Solar/Battery/Utility' },
        { when: [null, null], value: 'None' },
      ],
    },
    CTX,
  );

  it('normalizes values and settings', () => {
    assert.equal(cfg.setting, 'output_source_priority');
    assert.equal(cfg.rows[0].value, 'Utility first');
    assert.equal(cfg.rows[3].value, null);
    assert.throws(() => normalizeTable({ setting: 'Output source priority', conditions: ['soc'], rows: [{ when: [{ to: 20 }], value: 'Bogus' }] }, CTX), /Row 1/);
    assert.throws(() => normalizeTable({ setting: 'Nope', conditions: ['soc'], rows: [] }, CTX), ValidationError);
    assert.throws(() => normalizeTable({ setting: 'Output source priority', conditions: ['soc', 'soc'], rows: [] }, CTX), ValidationError);
    const slot = normalizeTable({ setting: 'grid_first_slot_1', conditions: ['day'], rows: [{ when: [{ days: [1] }], value: '17:00,19:00,TRUE' }] }, CTX);
    assert.equal(slot.rows[0].value, '17:00,19:00,true');
  });

  it('first matching row wins', () => {
    assert.equal(evaluateTable(cfg, at('23:00', { soc: 25 })).activeRow, 0);
    const d = evaluateTable(cfg, at('12:00', { soc: 18 }));
    assert.equal(d.activeRow, 1);
    assert.equal(d.value, 'Utility first');
    assert.match(d.reason, /Battery SOC 18% ≤ 20/);
    assert.equal(evaluateTable(cfg, at('12:00', { soc: 60 })).value, 'Solar/Battery/Utility');
    const none = evaluateTable(cfg, at('12:00', { soc: 40 }));
    assert.equal(none.activeRow, 3);
    assert.equal(none.value, null);
  });
});

describe('battery SOC control', () => {
  const cfg = normalizeConfig('battery-soc', { hourA: 6, lowA: 20, highA: 40, hourB: 18, lowB: 50, highB: 90 }, CTX) as SocConfig;

  it('interpolates thresholds both ways round the clock', () => {
    assert.deepEqual(socThresholds(cfg, 6), { low: 20, high: 40 });
    assert.deepEqual(socThresholds(cfg, 12), { low: 35, high: 65 });
    assert.deepEqual(socThresholds(cfg, 18), { low: 50, high: 90 });
    assert.deepEqual(socThresholds(cfg, 0), { low: 35, high: 65 });
    const d = socDiagram(cfg);
    assert.equal(d.low.length, 24);
    assert.equal(d.high[18], 90);
    assert.throws(() => normalizeConfig('battery-soc', { lowA: 50, highA: 40 }, CTX), ValidationError);
  });

  it('applies hysteresis', () => {
    assert.equal(evaluateSoc(cfg, at('06:00', { soc: 20 })).value, 'Utility first');
    assert.equal(evaluateSoc(cfg, at('06:00', { soc: 40 })).value, 'Solar/Battery/Utility');
    const keep = evaluateSoc(cfg, at('06:00', { soc: 30 }));
    assert.equal(keep.value, null);
    assert.match(keep.reason, /keeping/);
    assert.equal(evaluateSoc(cfg, at('06:00', { soc: null })).value, null);
  });
});

describe('battery protection', () => {
  const cfg = normalizeConfig('battery-protection', { soc: '10%', restoreValue: 'Solar first' }, CTX) as ProtectionConfig;

  it('shuts down and restores after recovery with hysteresis', () => {
    assert.equal(cfg.shutdownValue, 'Utility first');
    assert.equal(cfg.hysteresis, 5);
    let d = evaluateProtection(cfg, at('12:00', { soc: 30 }), false);
    assert.equal(d.value, null);
    d = evaluateProtection(cfg, at('12:00', { soc: 10 }), false);
    assert.equal(d.value, 'Utility first');
    assert.equal(d.tripped, true);
    d = evaluateProtection(cfg, at('12:00', { soc: 13 }), true);
    assert.equal(d.value, 'Utility first');
    assert.equal(d.tripped, true);
    d = evaluateProtection(cfg, at('12:00', { soc: 15 }), true);
    assert.equal(d.value, 'Solar first');
    assert.equal(d.tripped, false);
    assert.throws(() => normalizeConfig('battery-protection', { soc: 10, restoreValue: 'Utility first' }, CTX), ValidationError);
  });
});

describe('store and conflicts', () => {
  beforeEach(() => {
    openDb(':memory:');
    store.initStore();
  });

  const table = (setting: string, inverter: number | null = null): TableConfig => ({ setting, inverter, conditions: ['soc'], rows: [] });

  it('persists automations', () => {
    const a = store.add('table', 'Night', table('output_source_priority'), true);
    assert.equal(store.get(a.id)?.name, 'Night');
    assert.deepEqual(store.affectedSettings(), ['output_source_priority']);
    store.update(a.id, { name: 'Night 2' });
    assert.equal(store.all()[0].name, 'Night 2');
    assert.equal(store.remove(a.id), true);
    assert.equal(store.all().length, 0);
  });

  it('allows one enabled automation per setting', () => {
    const a = store.add('table', '', table('output_source_priority'), true);
    const b = store.add('battery-soc', '', { ...table('output_source_priority') } as never, false);
    assert.throws(() => store.enable(b.id, DEFS), /Unable to enable automation\. Output source priority is already controlled by a different automation\./);
    store.disable(a.id);
    assert.equal(store.enable(b.id).enabled, true);
    // Different inverters don't conflict; "all inverters" overlaps everything.
    const c = store.add('table', '', table('max_charge_current', 0), true);
    const d = store.add('table', '', table('max_charge_current', 1), false);
    assert.equal(store.enable(d.id).enabled, true);
    store.disable(c.id);
    store.disable(d.id);
    const e = store.add('table', '', table('max_charge_current', null), true);
    assert.ok(store.findConflict({ id: -1, type: 'table', config: table('max_charge_current', 1) }));
    assert.equal(store.findConflict({ id: e.id, type: 'table', config: e.config }), null);
  });
});

describe('runner', () => {
  it('rate limits writes', () => {
    const rl = new RateLimiter(300_000, 60_000);
    assert.equal(rl.wait('0:x', 'A', 0), 0);
    rl.record('0:x', 'A', 0);
    assert.equal(rl.wait('0:x', 'A', 100_000), 200_000);
    assert.equal(rl.wait('0:x', 'a', 300_000), 0);
    assert.equal(rl.wait('0:x', 'B', 30_000), 30_000);
    assert.equal(rl.wait('0:x', 'B', 60_000), 0);
  });

  function harness(automations: Automation[], soc: number) {
    let now = Date.parse('2026-10-12T12:00:00Z');
    let currentSoc = soc;
    const values: Record<string, Value> = { output_source_priority: 'Solar/Battery/Utility' };
    const writes: { key: string; value: Value }[] = [];
    const logs: string[] = [];
    let override = 0;
    const deps: RunnerDeps = {
      now: () => now,
      tz: () => 'UTC',
      connected: () => true,
      overrideUntil: () => override,
      context: () => CTX,
      inputs: () => ({ soc: currentSoc, gridAvailable: true, price: null, pv: 0 }),
      values: () => values,
      setSetting: async (_i, key, value) => {
        writes.push({ key, value });
        return { ok: true, message: 'ok' };
      },
      automations: () => automations,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
    };
    return {
      runner: new Runner(deps),
      values,
      writes,
      logs,
      advance: (ms: number) => (now += ms),
      setSoc: (s: number) => (currentSoc = s),
      suspend: (until: number) => (override = until),
      now: () => now,
    };
  }

  const tableAutomation: Automation = {
    id: 2, type: 'table', enabled: true, name: '', created: 0, updated: 0,
    config: normalizeTable({ setting: 'output_source_priority', conditions: ['soc'], rows: [{ when: [{ to: 20 }], value: 'Utility first' }] }, CTX),
  };

  it('writes only on change, logs decisions, and limits retries', async () => {
    const h = harness([tableAutomation], 18);
    await h.runner.tick();
    assert.deepEqual(h.writes, [{ key: 'output_source_priority', value: 'Utility first' }]);
    assert.equal(h.logs[0], 'Rule table #2: Battery SOC 18% ≤ 20% → Output source priority = Utility first');
    // The inverter didn't take it (value unchanged): no retry within 5 minutes.
    h.advance(60_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 1);
    h.advance(240_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 2);
    // Once the value matches, nothing is written.
    h.values.output_source_priority = 'Utility first';
    h.advance(600_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 2);
  });

  it('does nothing while suspended', async () => {
    const h = harness([tableAutomation], 18);
    h.suspend(h.now() + 60_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 0);
    h.advance(61_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 1);
  });

  it('battery protection restores after recovery', async () => {
    const prot: Automation = {
      id: 3, type: 'battery-protection', enabled: true, name: '', created: 0, updated: 0,
      config: normalizeConfig('battery-protection', { soc: 10, restoreValue: 'Solar/Battery/Utility' }, CTX),
    };
    const h = harness([prot], 9);
    await h.runner.tick();
    assert.equal(h.writes.at(-1)?.value, 'Utility first');
    h.values.output_source_priority = 'Utility first';
    h.setSoc(12);
    h.advance(120_000);
    await h.runner.tick();
    assert.equal(h.writes.length, 1);
    h.setSoc(16);
    await h.runner.tick();
    assert.equal(h.writes.at(-1)?.value, 'Solar/Battery/Utility');
    assert.match(h.logs.at(-1)!, /recovered/);
  });
});
