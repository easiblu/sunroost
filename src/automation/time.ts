/**
 * Time-zone helpers for the rule scheduler: local calendar dates ("YYYY-MM-DD") and converting a
 * local wall-clock time on a date to a UTC timestamp, without any dependency.
 */
import { localTime } from './conditions.ts';

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(tz);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = {
      hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
    }
    offsetFormatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at `ts`, in ms (positive east of Greenwich). */
export function tzOffset(ts: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ts))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC timestamp of local `minutes` after midnight on local date `ymd` in `tz`. */
export function zonedTs(ymd: string, minutes: number, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * 60_000;
  let ts = guess - tzOffset(guess, tz);
  // Second pass corrects for a DST change between the guess and the result.
  const again = guess - tzOffset(ts, tz);
  if (again !== ts) ts = again;
  return ts;
}

/** Local calendar date of a timestamp. */
export const ymdOf = (ts: number, tz: string) => localTime(ts, tz).date;

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Day of week (0 = Sunday) of a calendar date. */
export function dowOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const fmtMinutes = (m: number) => {
  const v = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** "HH:MM" of a timestamp in `tz`. */
export function hhmmOf(ts: number, tz: string): string {
  return fmtMinutes(localTime(ts, tz).minutes);
}
