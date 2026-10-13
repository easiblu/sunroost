/**
 * Fire-time computation for the scheduled rule triggers (time, sun, forecast, interval and the
 * cheapest/most-expensive price hours). Pure: everything comes in through `ScheduleEnv`, so the
 * engine can recompute after a restart and tests can use a fixed clock.
 */
import { localTime } from './conditions.ts';
import type { Trigger } from './rules.ts';
import { sunTimes } from './sun.ts';
import { addDays, dowOf, toMinutes, ymdOf, zonedTs } from './time.ts';

export interface PricePoint {
  start: number;
  end: number;
  price: number;
}

export interface ScheduleEnv {
  tz: string;
  /** Site location; null → sunrise 06:00 / sunset 18:00. */
  location: { lat: number; lon: number } | null;
  /** Day-ahead prices (any slot length) from today onwards. */
  prices: PricePoint[];
}

const HOUR = 3_600_000;
export const FALLBACK_SUNRISE = '06:00';
export const FALLBACK_SUNSET = '18:00';

/** Sunrise/sunset of a local date; falls back to 06:00/18:00 without a location (or in polar day/night). */
export function sunEvent(ymd: string, event: 'sunrise' | 'sunset', env: Pick<ScheduleEnv, 'tz' | 'location'>): number {
  if (env.location) {
    const s = sunTimes(ymd, env.location.lat, env.location.lon, env.tz);
    const ts = event === 'sunrise' ? s.sunrise : s.sunset;
    if (ts !== null) return ts;
  }
  return zonedTs(ymd, toMinutes(event === 'sunrise' ? FALLBACK_SUNRISE : FALLBACK_SUNSET), env.tz);
}

/** Averages slots into whole hours (UTC-aligned; all price zones have whole-hour offsets). */
export function hourly(prices: PricePoint[]): PricePoint[] {
  const buckets = new Map<number, { sum: number; w: number }>();
  for (const s of prices) {
    const h = Math.floor(s.start / HOUR) * HOUR;
    const b = buckets.get(h) ?? { sum: 0, w: 0 };
    const w = Math.max(1, s.end - s.start);
    b.sum += s.price * w;
    b.w += w;
    buckets.set(h, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, b]) => ({ start, end: start + HOUR, price: b.sum / b.w }));
}

/**
 * Starts of the N cheapest (or most expensive) hours of each local day in the price list.
 * Ties go to the earlier hour. Sorted by time.
 */
export function priceHours(prices: PricePoint[], mode: 'cheapest' | 'most_expensive', n: number, tz: string): number[] {
  const byDay = new Map<string, PricePoint[]>();
  for (const h of hourly(prices)) {
    const day = ymdOf(h.start, tz);
    const list = byDay.get(day) ?? [];
    list.push(h);
    byDay.set(day, list);
  }
  const out: number[] = [];
  for (const list of byDay.values()) {
    const sorted = [...list].sort((a, b) => (mode === 'cheapest' ? a.price - b.price : b.price - a.price) || a.start - b.start);
    out.push(...sorted.slice(0, n).map((h) => h.start));
  }
  return out.sort((a, b) => a - b);
}

/** Whether `now` falls in one of the N cheapest hours of its local day; null without prices for today. */
export function inPriceHours(prices: PricePoint[], mode: 'cheapest' | 'most_expensive', n: number, now: number, tz: string): boolean | null {
  const today = ymdOf(now, tz);
  const todays = prices.filter((p) => ymdOf(p.start, tz) === today);
  if (!todays.length) return null;
  return priceHours(todays, mode, n, tz).some((s) => now >= s && now < s + HOUR);
}

/** Every fire time of a trigger in (from, to], ascending. Event-driven triggers return []. */
export function occurrences(t: Trigger, from: number, to: number, env: ScheduleEnv): number[] {
  if (to <= from) return [];
  const out: number[] = [];
  const first = addDays(ymdOf(from, env.tz), -1);
  const last = addDays(ymdOf(to, env.tz), 1);
  const eachDay = (fn: (ymd: string) => void) => {
    for (let d = first, guard = 0; d <= last && guard < 400; d = addDays(d, 1), guard++) fn(d);
  };
  switch (t.kind) {
    case 'time':
      eachDay((d) => {
        if (!t.days || t.days.includes(dowOf(d))) out.push(zonedTs(d, toMinutes(t.at), env.tz));
      });
      break;
    case 'forecast':
      eachDay((d) => out.push(zonedTs(d, toMinutes(t.at), env.tz)));
      break;
    case 'sun':
      eachDay((d) => out.push(sunEvent(d, t.event, env) + t.offsetMinutes * 60_000));
      break;
    case 'interval':
      eachDay((d) => {
        for (let m = 0; m < 1440; m += t.everyMinutes) out.push(zonedTs(d, m, env.tz));
      });
      break;
    case 'price':
      if (t.mode) out.push(...priceHours(env.prices, t.mode, t.hours ?? 1, env.tz));
      break;
    default:
      break;
  }
  return [...new Set(out)].filter((ts) => ts > from && ts <= to).sort((a, b) => a - b);
}

/** The most recent fire time in (from, to], or null. */
export function latestDue(t: Trigger, from: number, to: number, env: ScheduleEnv): number | null {
  const list = occurrences(t, from, to, env);
  return list.length ? list[list.length - 1] : null;
}

/** The next fire time after `now` within `horizonMs`, or null. */
export function nextFire(t: Trigger, now: number, env: ScheduleEnv, horizonMs = 48 * HOUR): number | null {
  return occurrences(t, now, now + horizonMs, env)[0] ?? null;
}

/** Local "HH:MM" of today's sunrise and sunset. */
export function sunToday(now: number, env: Pick<ScheduleEnv, 'tz' | 'location'>) {
  const ymd = ymdOf(now, env.tz);
  const hm = (ts: number) => {
    const m = localTime(ts, env.tz).minutes;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  return { sunrise: hm(sunEvent(ymd, 'sunrise', env)), sunset: hm(sunEvent(ymd, 'sunset', env)) };
}
