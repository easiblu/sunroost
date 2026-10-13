/**
 * Calendar helpers in an IANA timezone, built on Intl only.
 * Days are 'YYYY-MM-DD' strings so they sort and compare lexicographically.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The timezone if Intl knows it, otherwise UTC (a typo in settings must not break totals). */
export function safeTz(tz: string | undefined): string {
  if (!tz) return 'UTC';
  if (formatters.has(tz)) return tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a timezone. */
export function localParts(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(safeTz(tz)).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of an instant: 'YYYY-MM-DD'. */
export function dayKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset of local time from UTC at an instant, in ms (e.g. +2 h for Europe/Berlin in summer). */
export function tzOffsetMs(ms: number, tz: string) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant (ms) at which a local day starts. Handles DST by re-checking the offset. */
export function dayStart(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** Calendar arithmetic on day strings (timezone-free). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the ISO week containing the day. */
export const isoWeekStart = (day: string) => addDays(day, -((weekday(day) + 6) % 7));
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
export const yearStart = (day: string) => `${day.slice(0, 4)}-01-01`;

/** First day of the month n months after the given month start. */
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}

/** ISO 8601 week number. */
export function isoWeek(day: string) {
  const thursday = addDays(isoWeekStart(day), 3);
  const jan1 = `${thursday.slice(0, 4)}-01-01`;
  const diff = (Date.parse(thursday) - Date.parse(jan1)) / 86_400_000;
  return Math.floor(diff / 7) + 1;
}
