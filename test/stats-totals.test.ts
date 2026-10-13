import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import { state } from '../src/core/state.ts';
import { ensureHistoryTables } from '../src/stats/history.ts';
import {
  energyTotals, ensureTotalsTables, integrate, readDay, totalsCsv, totalsReport, tracker, writeDay,
  type Field, type PowerSample,
} from '../src/stats/totals.ts';
import { addDays, dayKey, dayStart, isoWeek, isoWeekStart, monthStart } from '../src/stats/tz.ts';

before(() => {
  openDb(':memory:');
  settings.init();
  ensureHistoryTables();
  ensureTotalsTables();
});

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const sample = (t: number, p: Partial<PowerSample> = {}): PowerSample => ({ t, pv: null, load: null, grid: null, battery: null, ...p });

function collect(samples: PowerSample[], zone = 'UTC') {
  const out: Record<string, Partial<Record<Field, number>>> = {};
  for (let i = 1; i < samples.length; i++) {
    integrate(samples[i - 1], samples[i], zone, (day, f, kwh) => {
      out[day] ??= {};
      out[day][f] = (out[day][f] ?? 0) + kwh;
    });
  }
  return out;
}

test('trapezoid integration of constant and ramping power', () => {
  const t0 = Date.UTC(2026, 5, 1, 10);
  const flat = Array.from({ length: 361 }, (_, i) => sample(t0 + i * 10_000, { pv: 1000, load: 500 }));
  const r = collect(flat)['2026-06-01'];
  near(r.pv!, 1); // 1 kW for an hour
  near(r.load!, 0.5);
  // Ramp 0 → 2000 W over an hour (in 60 s steps) = 1 kWh.
  const ramp = Array.from({ length: 61 }, (_, i) => sample(t0 + i * 60_000, { pv: (2000 * i) / 60 }));
  near(collect(ramp)['2026-06-01'].pv!, 1);
});

test('signed grid and battery split into import/export and charge/discharge', () => {
  const t0 = Date.UTC(2026, 5, 1, 10);
  const r = collect([
    sample(t0, { grid: 3600, battery: -3600 }),
    sample(t0 + 10_000, { grid: 3600, battery: -3600 }),
    sample(t0 + 20_000, { grid: -3600, battery: 3600 }),
    sample(t0 + 30_000, { grid: -3600, battery: 3600 }),
  ])['2026-06-01'];
  // 10 s at 3.6 kW = 0.01 kWh; the crossing interval contributes 0.005 to each side.
  near(r.gridImport!, 0.015);
  near(r.gridExport!, 0.015);
  near(r.batteryDischarge!, 0.015);
  near(r.batteryCharge!, 0.015);
});

test('gaps longer than 60 s are capped', () => {
  const t0 = Date.UTC(2026, 5, 1, 10);
  const r = collect([sample(t0, { pv: 3600 }), sample(t0 + 600_000, { pv: 3600 })])['2026-06-01'];
  near(r.pv!, 0.06); // 60 s at 3.6 kW, not 10 minutes
});

test('day boundaries follow the configured timezone and split at midnight', () => {
  const zone = 'America/New_York';
  const midnight = dayStart('2026-07-04', zone);
  assert.equal(new Date(midnight).toISOString(), '2026-07-04T04:00:00.000Z');
  assert.equal(dayKey(midnight - 1, zone), '2026-07-03');
  // DST end: the day is 25 h long.
  assert.equal(dayStart('2026-11-02', zone) - dayStart('2026-11-01', zone), 25 * 3_600_000);
  const r = collect([sample(midnight - 20_000, { pv: 3600 }), sample(midnight + 10_000, { pv: 3600 })], zone);
  near(r['2026-07-03'].pv!, 0.02);
  near(r['2026-07-04'].pv!, 0.01);
});

test('tracker rolls over at local midnight in a non-UTC timezone and restores today', () => {
  settings.set('timezone', 'Pacific/Auckland');
  const zone = 'Pacific/Auckland';
  const midnight = dayStart('2026-03-10', zone);
  tracker.start(midnight - 60_000);
  assert.equal(tracker.day, '2026-03-09');
  for (let t = midnight - 60_000; t <= midnight + 60_000; t += 10_000) tracker.sample(sample(t, { pv: 3600, load: 1800 }));
  assert.equal(tracker.day, '2026-03-10');
  near(readDay('2026-03-09').pv, 0.06); // saved on rollover
  near(tracker.today.pv, 0.06);
  near(state.energy!.load, 0.03);
  assert.equal(state.energy!.day, '2026-03-10');
  // A restart restores today's values from the table.
  tracker.stop();
  tracker.start(midnight + 120_000);
  near(tracker.today.pv, 0.06);
  tracker.stop();
  settings.set('timezone', 'UTC');
});

test('energyTotals sums day, ISO week and month', () => {
  settings.set('timezone', 'UTC');
  const today = dayKey(Date.now(), 'UTC');
  for (let i = 1; i <= 45; i++) writeDay(addDays(today, -i), { pv: 1, load: 2, gridImport: 0.5, gridExport: 0, batteryCharge: 0, batteryDischarge: 0 });
  tracker.start();
  tracker.today.pv = 0.25;
  const d = energyTotals('d');
  assert.equal(d.day, today);
  near(d.pv, 0.25);
  const w = energyTotals('w');
  const weekDays = (Date.parse(today) - Date.parse(isoWeekStart(today))) / 86_400_000;
  assert.equal(w.day, isoWeekStart(today));
  near(w.pv, weekDays + 0.25);
  const m = energyTotals('m');
  assert.equal(m.day, monthStart(today));
  near(m.load, ((Date.parse(today) - Date.parse(monthStart(today))) / 86_400_000) * 2);
  tracker.stop();
});

test('totals report: periods, self-sufficiency, cost and CSV', () => {
  settings.set('timezone', 'UTC');
  tracker.start();
  const today = tracker.day;
  const rep = totalsReport('day', 30);
  assert.equal(rep.rows.length, 30);
  assert.equal(rep.rows.at(-1)!.start, today);
  assert.equal(rep.rows[0].start, addDays(today, -29));
  const y = rep.rows.at(-2)!;
  near(y.pv, 1);
  assert.equal(y.selfSufficiency, 75); // 0.5 of 2 kWh from grid
  assert.equal(y.cost, undefined);

  settings.set('tariff.import_price', 0.3);
  settings.set('tariff.export_price', 0.1);
  const withCost = totalsReport('week', 8);
  assert.equal(withCost.rows.length, 8);
  assert.equal(withCost.rows.at(-1)!.start, isoWeekStart(today));
  assert.ok(typeof withCost.summary.cost === 'number');
  const months = totalsReport('month', 12);
  assert.equal(months.rows.length, 12);
  assert.ok(months.rows.every((r) => r.start.endsWith('-01')));
  const csv = totalsCsv('day', 3).trim().split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[0], /^period,start,load_kwh,pv_kwh/);
  assert.match(csv[0], /cost_/);
  assert.equal(totalsReport('year', 5).rows.length, 5);
  tracker.stop();
});

test('ISO week numbers', () => {
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(isoWeekStart('2026-10-12'), '2026-10-12');
  assert.equal(isoWeekStart('2026-10-18'), '2026-10-12');
});
