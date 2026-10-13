/**
 * Energy outlook for automations and the UI: expected solar (forecast.ts) and the solar surplus
 * (surplus.ts), from the live state, the weather service and Sunroost's own daily history.
 */
import { settings } from '../core/settings.ts';
import { state } from '../core/state.ts';
import { readDays } from '../stats/totals.ts';
import { ymdOf } from '../automation/time.ts';
import * as weather from '../weather/index.ts';
import { factorFrom, forecastFrom, type Factor, type SolarForecast } from './forecast.ts';
import { surplusW } from './surplus.ts';

export { MIN_LEARNED_DAYS } from './forecast.ts';

/** The learned factor changes slowly; recompute it at most this often. */
const FACTOR_TTL_MS = 30 * 60_000;
let factorCache: { at: number; key: string; factor: Factor } | null = null;

function factor(): Factor {
  const w = weather.current().weather;
  const kwp = Number(settings.get('site.pv_kwp')) || 0;
  const rough = (Number(settings.get('max_pv_power')) || 0) / 1000;
  const key = `${kwp}|${rough}|${w?.updatedAt ?? 0}`;
  if (factorCache && factorCache.key === key && Date.now() - factorCache.at < FACTOR_TTL_MS) return factorCache.factor;
  const past = w?.past ?? [];
  let history: { date: string; pvKwh: number; radiationMj: number }[] = [];
  if (past.length) {
    const rows = readDays(past[0].date, past.at(-1)!.date);
    const pv = new Map(rows.map((r) => [r.day, r.pv]));
    history = past.filter((p) => pv.has(p.date)).map((p) => ({ date: p.date, pvKwh: pv.get(p.date)!, radiationMj: p.radiationMj }));
  }
  const f = factorFrom(history, kwp, rough);
  factorCache = { at: Date.now(), key, factor: f };
  return f;
}

/** Expected solar, or null without a forecast (no site location yet). */
export function solarForecast(): SolarForecast | null {
  const w = weather.current().weather;
  if (!w) return null;
  return forecastFrom(factor(), w.daily, w.hourly, ymdOf(Date.now(), settings.get('timezone')));
}

/** Current solar surplus in W, or null without readings. */
export function currentSurplus(totals = state.totals): number | null {
  const n = (k: string) => (typeof totals[k] === 'number' ? (totals[k] as number) : null);
  return surplusW(
    { pvW: n('PV power'), loadW: n('Load power'), gridW: n('Grid power'), batteryW: n('Battery power'), soc: n('Battery state of charge') },
    Number(settings.get('surplus.battery_soc')) || 90,
  );
}

/** Metrics for rules and the energy entities. */
export const SURPLUS_METRIC = 'Solar surplus';
export const FORECAST_METRICS = { today: 'PV forecast today', tomorrow: 'PV forecast tomorrow', rest: 'PV forecast rest of today' } as const;

export function outlookMetrics(totals = state.totals): Record<string, number | null> {
  const f = solarForecast();
  return {
    [SURPLUS_METRIC]: currentSurplus(totals),
    [FORECAST_METRICS.today]: f?.todayKwh ?? null,
    [FORECAST_METRICS.tomorrow]: f?.tomorrowKwh ?? null,
    [FORECAST_METRICS.rest]: f?.restOfTodayKwh ?? null,
  };
}
