import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { db, openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import {
  clearHistory, COMBINED, ensureHistoryTables, makeSamples, prune, queryHistory, resolutionFor, rollup, rollupUntil,
  writeSamples, type Sample,
} from '../src/stats/history.ts';
import { ensureTotalsTables, readDay, resampleTotals } from '../src/stats/totals.ts';

before(() => {
  openDb(':memory:');
  settings.init();
  settings.set('timezone', 'UTC');
  ensureHistoryTables();
  ensureTotalsTables();
});
beforeEach(() => clearHistory());

const T0 = Math.floor(Date.UTC(2026, 5, 1, 0) / 1000);

function fill(fromSec: number, toSec: number, values: (ts: number) => Record<string, number>, inverters = 1) {
  const batch: Sample[] = [];
  for (let ts = fromSec; ts < toSec; ts += 10) {
    const v = values(ts);
    batch.push(...makeSamples(ts, v, Array.from({ length: inverters }, () => v)));
  }
  writeSamples(batch);
}

test('resolution keeps responses under ~1500 points', () => {
  assert.equal(resolutionFor(6 * 3600), 20);
  assert.equal(resolutionFor(24 * 3600), 60);
  assert.equal(resolutionFor(7 * 86400), 600);
  assert.ok((30 * 86400) / resolutionFor(30 * 86400) <= 1500);
});

test('buckets average raw rows and break lines at gaps', () => {
  fill(T0, T0 + 3600, () => ({ 'PV power': 100, 'Load power': 50 }));
  fill(T0 + 5400, T0 + 9000, () => ({ 'PV power': 300, 'Load power': 50 }));
  const r = queryHistory({ from: T0 * 1000, to: (T0 + 9000) * 1000, metrics: ['PV power', 'Load power', 'Battery power', 'Nope'] });
  assert.equal(r.resolution, 10);
  const gapAt = r.xs.indexOf(T0 + 3600);
  assert.ok(gapAt > 0, 'a null point follows the last bucket before the gap');
  assert.equal(r.series['PV power'][gapAt], null);
  assert.equal(r.series['PV power'][gapAt - 1], 100);
  assert.equal(r.series['PV power'].at(-1), 300);
  assert.equal(r.xs.length, 360 + 1 + 360);
  assert.ok(r.series['Battery power'].every((v) => v === null));
  assert.equal(r.series['Nope'].length, r.xs.length);

  // A coarser bucket averages; 6 h → 20 s buckets.
  const coarse = queryHistory({ from: T0 * 1000, to: (T0 + 6 * 3600) * 1000, metrics: ['PV power'] });
  assert.equal(coarse.resolution, 20);
  assert.equal(coarse.xs[1] - coarse.xs[0], 20);
  assert.ok(coarse.xs.length <= 1500);
});

test('per-inverter rows are kept for parallel systems; single inverter falls back to combined', () => {
  fill(T0, T0 + 600, () => ({ 'PV power': 100, 'Grid voltage': 230 }), 2);
  const inv1 = queryHistory({ from: T0 * 1000, to: (T0 + 600) * 1000, metrics: ['Grid voltage'], inverter: 1 });
  assert.equal(inv1.series['Grid voltage'][0], 230);
  clearHistory();
  fill(T0, T0 + 600, () => ({ 'PV power': 100 }), 1);
  const rows = db().prepare('SELECT DISTINCT inv FROM history_raw').all() as { inv: number }[];
  assert.deepEqual(rows.map((r) => r.inv), [COMBINED]);
  const inv0 = queryHistory({ from: T0 * 1000, to: (T0 + 600) * 1000, metrics: ['PV power'], inverter: 0 });
  assert.equal(inv0.series['PV power'][0], 100);
});

test('rollup, pruning and long ranges use the 5-minute table', () => {
  const now = T0 + 20 * 86400;
  fill(T0, T0 + 2 * 86400, (ts) => ({ 'PV power': ts % 600 < 300 ? 0 : 1000 }));
  rollup(now);
  assert.equal(rollupUntil(), Math.floor(now / 300) * 300);
  const n = (db().prepare('SELECT count(*) AS n FROM history_5m').get() as { n: number }).n;
  assert.equal(n, (2 * 86400) / 300);
  settings.set('history.raw_retention_days', 14);
  assert.ok(prune(now) > 0);
  assert.equal((db().prepare('SELECT count(*) AS n FROM history_raw').get() as { n: number }).n, 0);
  const r = queryHistory({ from: T0 * 1000, to: (T0 + 86400) * 1000, metrics: ['PV power'] });
  assert.equal(r.resolution, 300);
  assert.deepEqual(r.series['PV power'].slice(0, 2), [0, 1000]);
});

test('resample recomputes daily totals from rollup and raw history', async () => {
  // Day 1 only in the rollup, day 2 in raw rows: 1 kW all day = 24 kWh each.
  fill(T0, T0 + 86400, () => ({ 'PV power': 1000, 'Grid power': -500 }));
  rollup(T0 + 86400);
  prune(T0 + 86400 + 14 * 86400 + 1);
  fill(T0 + 86400, T0 + 2 * 86400, () => ({ 'PV power': 1000, 'Grid power': -500 }));
  await resampleTotals();
  const d1 = readDay('2026-06-01');
  const d2 = readDay('2026-06-02');
  assert.ok(Math.abs(d1.pv - 24) < 0.01, `day 1 pv ${d1.pv}`);
  assert.ok(Math.abs(d1.gridExport - 12) < 0.01);
  // Raw: trapezoid between 10 s samples; the first interval of the day is split at midnight.
  assert.ok(Math.abs(d2.pv - 24) < 0.01, `day 2 pv ${d2.pv}`);
});
