/**
 * Fills the database with simulated history so charts and totals look full in demos.
 *   npm run seed            14 days
 *   npm run seed -- 30      30 days
 * Writes into the configured data dir (SOLAR_DATA, config.json dataDir, or ./data).
 * Stop the server first, or restart it afterwards so it picks up the new totals.
 */
import { join } from 'node:path';
import { loadBootConfig } from '../src/config.ts';
import { closeDb, openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import {
  COMBINED, ensureHistoryTables, HISTORY_METRICS, makeSamples, prune, rollup, SAMPLE_SECONDS, setMeta, writeSamples, type Sample,
} from '../src/stats/history.ts';
import { ensureTotalsTables, resampleTotals } from '../src/stats/totals.ts';
import { localParts, safeTz } from '../src/stats/tz.ts';

const days = Math.max(1, Math.min(400, Number(process.argv[2]) || 14));
const config = loadBootConfig();
const file = join(config.dataDir, 'solar.db');
openDb(file);
settings.init();
ensureHistoryTables();
ensureTotalsTables();
const zone = safeTz(settings.get('timezone'));
const capacityWh = (Number(settings.get('bms.capacity')) || 10) * 1000;

console.log(`Seeding ${days} days of history into ${file} (timezone ${zone})…`);

// Deterministic pseudo-random numbers so repeated runs look alike.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const now = Math.floor(Date.now() / 1000 / SAMPLE_SECONDS) * SAMPLE_SECONDS;
const start = now - days * 86_400;
const PEAK_PV = 5200;
let soc = 55;
let cloud = 1;
let dayClear = 0.8;
let lastDay = -1;
let kettle = 0;
let batch: Sample[] = [];
const r1 = (v: number) => Math.round(v * 10) / 10;

for (let ts = start; ts <= now; ts += SAMPLE_SECONDS) {
  const p = localParts(ts * 1000, zone);
  const hour = p.hour + p.minute / 60 + p.second / 3600;
  if (p.day !== lastDay) {
    lastDay = p.day;
    dayClear = 0.35 + rand() * 0.65; // overcast … clear
  }
  // Solar: a bell between sunrise and sunset, with drifting cloud cover.
  cloud = Math.max(0.15, Math.min(1, cloud + (rand() - 0.5) * 0.08 * (1.2 - dayClear)));
  const sun = hour > 6.5 && hour < 19 ? Math.sin((Math.PI * (hour - 6.5)) / 12.5) ** 1.5 : 0;
  const pv = Math.max(0, PEAK_PV * sun * (dayClear * 0.7 + cloud * 0.3) * (0.95 + rand() * 0.1));
  // Load: base + morning/evening peaks + occasional kettle/oven.
  if (kettle <= 0 && rand() < 0.002) kettle = 30 + Math.floor(rand() * 60);
  const peaks = 900 * Math.exp(-((hour - 7.5) ** 2) / 0.8) + 1400 * Math.exp(-((hour - 19) ** 2) / 2);
  const load = 280 + rand() * 120 + peaks + (kettle-- > 0 ? 2200 : 0);
  // Battery covers the difference within its limits; the grid covers the rest.
  const surplus = pv - load;
  let battery = surplus > 0 ? Math.min(surplus, 3000) : Math.max(surplus, -3500);
  if ((battery > 0 && soc >= 100) || (battery < 0 && soc <= 20)) battery = 0;
  soc = Math.max(0, Math.min(100, soc + (battery * SAMPLE_SECONDS) / 3600 / capacityWh * 100));
  const grid = load - pv + battery;
  const battV = 48 + soc * 0.06 + battery / 2500;
  const pv1 = pv * 0.55;
  const pv2 = pv - pv1;
  const totals = {
    'PV power': Math.round(pv), 'PV power 1': Math.round(pv1), 'PV power 2': Math.round(pv2),
    'PV voltage 1': pv > 0 ? r1(330 + rand() * 25) : 0, 'PV voltage 2': pv > 0 ? r1(310 + rand() * 25) : 0,
    'PV current 1': pv > 0 ? r1(pv1 / 335) : 0, 'PV current 2': pv > 0 ? r1(pv2 / 315) : 0,
    'Load power': Math.round(load), 'Grid power': Math.round(grid), 'Battery power': Math.round(battery),
    'Battery state of charge': Math.round(soc), 'Battery voltage': Math.round(battV * 100) / 100,
    'Battery current': r1(battery / battV), 'Battery temperature': r1(22 + Math.abs(battery) / 900 + Math.sin((hour / 24) * Math.PI) * 3),
    'Temperature': r1(30 + (pv + load) / 400), 'Bus voltage': r1(380 + rand() * 8),
    'Grid voltage': r1(229 + rand() * 4), 'Grid frequency': Math.round((49.95 + rand() * 0.1) * 100) / 100,
    'AC output voltage': r1(229.5 + rand()),
  };
  batch.push(...makeSamples(ts, totals, [totals]));
  if (batch.length >= 20_000) {
    writeSamples(batch);
    batch = [];
  }
}
writeSamples(batch);
console.log(`History: ${Math.round((now - start) / SAMPLE_SECONDS)} samples per scope (${HISTORY_METRICS.length} metrics, scope ${COMBINED}).`);

// Re-roll everything: the seeded range may predate an earlier rollup watermark.
setMeta('rollup_until', 0);
rollup(now);
const pruned = prune(now);
console.log(`Rolled up to 5-minute buckets; pruned ${pruned} raw rows past the ${settings.get('history.raw_retention_days')}-day retention.`);
const { days: totalDays } = await resampleTotals();
console.log(`Daily totals computed for ${totalDays} days.`);
closeDb();
