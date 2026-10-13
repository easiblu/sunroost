/**
 * Dashboard helpers.
 *  GET /api/dashboard/pv-stats → { day, week, dayRating }
 *    day / week: PV kWh since local midnight / the start of the ISO week.
 *    dayRating: 0–5, how today's PV yield so far compares with the previous 7 days up to the
 *    same time of day (3 = typical). Drives the Solar PV "forecast" icon on the dashboard.
 */
import { queryHistory } from '../../stats/history.ts';
import { energyTotals, tz } from '../../stats/totals.ts';
import { addDays, dayKey, dayStart } from '../../stats/tz.ts';
import type { App } from '../server.ts';

const DAY_MS = 86_400_000;
const COMPARE_DAYS = 7;
const CACHE_MS = 5 * 60_000;

let ratingCache: { at: number; value: number } | null = null;

/** PV kWh in [from, to) from the stored PV power history. */
function pvEnergy(xs: number[], values: (number | null)[], resolution: number, from: number, to: number) {
  let wh = 0;
  for (let i = 0; i < xs.length; i++) {
    const t = xs[i] * 1000;
    const v = values[i];
    if (t < from || t >= to || v === null || !(v > 0)) continue;
    wh += (v * resolution) / 3600;
  }
  return wh / 1000;
}

function computeRating(todayKwh: number): number {
  const now = Date.now();
  const zone = tz();
  const today = dayKey(now, zone);
  const sinceMidnight = now - dayStart(today, zone);
  const from = dayStart(addDays(today, -COMPARE_DAYS), zone);
  const h = queryHistory({ from, to: dayStart(today, zone), metrics: ['PV power'] });
  const pv = h.series['PV power'] ?? [];
  const previous: number[] = [];
  for (let d = 1; d <= COMPARE_DAYS; d++) {
    const start = dayStart(addDays(today, -d), zone);
    const kwh = pvEnergy(h.xs, pv, h.resolution, start, start + Math.min(sinceMidnight, DAY_MS));
    if (kwh > 0.05) previous.push(kwh);
  }
  if (!previous.length) return 3;
  const typical = previous.reduce((a, b) => a + b, 0) / previous.length;
  // Before sunrise nothing is produced on any day: call it typical.
  if (typical < 0.05) return 3;
  const ratio = todayKwh / typical;
  return ratio >= 1.15 ? 5 : ratio >= 0.9 ? 4 : ratio >= 0.65 ? 3 : ratio >= 0.4 ? 2 : ratio >= 0.15 ? 1 : 0;
}

export async function register(app: App) {
  app.get('/api/dashboard/pv-stats', async () => {
    const day = energyTotals('d').pv;
    const week = energyTotals('w').pv;
    if (!ratingCache || Date.now() - ratingCache.at > CACHE_MS) {
      let value = 3;
      try {
        value = computeRating(day);
      } catch {
        // History unavailable (e.g. during a restore): keep the neutral rating.
      }
      ratingCache = { at: Date.now(), value };
    }
    return { day, week, dayRating: ratingCache.value };
  });
}
