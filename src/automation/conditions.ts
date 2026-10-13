/**
 * Rule-table conditions: the selectable kinds, their value domain, input normalization
 * (units such as "20%" or "1.5 kW" are accepted) and matching against the live inputs.
 * Everything here is pure so it can be unit-tested without a device.
 */

export type ConditionKind = 'time' | 'day' | 'soc' | 'grid' | 'price' | 'pv' | 'date';

/** Numeric range, inclusive at both ends. A null bound is open. */
export interface RangeCond { from: number | null; to: number | null }
/** Time of day "HH:MM", half-open [from, to). from > to wraps past midnight; from = to is all day. */
export interface TimeCond { from: string; to: string }
/** Days of week, 0 = Sunday … 6 = Saturday. */
export interface DaysCond { days: number[] }
export interface BoolCond { value: boolean }
/** Dates "YYYY-MM-DD" (either bound optional) or yearly "MM-DD" (both bounds, may wrap past new year). */
export interface DateCond { from: string | null; to: string | null }
/** null means "Any". */
export type CondValue = RangeCond | TimeCond | DaysCond | BoolCond | DateCond | null;

export interface ConditionMeta {
  kind: ConditionKind;
  label: string;
  /** Short label used in decision texts. */
  short: string;
  type: 'time' | 'days' | 'range' | 'bool' | 'date';
  unit?: string;
  min?: number;
  max?: number;
}

export const CONDITIONS: Record<ConditionKind, ConditionMeta> = {
  time: { kind: 'time', label: 'Time of day', short: 'Time', type: 'time' },
  day: { kind: 'day', label: 'Day of week', short: 'Day', type: 'days' },
  soc: { kind: 'soc', label: 'Battery state of charge', short: 'Battery SOC', type: 'range', unit: '%', min: 0, max: 100 },
  grid: { kind: 'grid', label: 'Grid available', short: 'Grid', type: 'bool' },
  price: { kind: 'price', label: 'Grid import price', short: 'Price', type: 'range' },
  pv: { kind: 'pv', label: 'PV power', short: 'PV power', type: 'range', unit: 'W', min: 0 },
  date: { kind: 'date', label: 'Date', short: 'Date', type: 'date' },
};

export const isConditionKind = (k: unknown): k is ConditionKind => typeof k === 'string' && k in CONDITIONS;

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Live values the conditions are evaluated against. */
export interface Inputs {
  now: number;
  tz: string;
  soc: number | null;
  gridAvailable: boolean | null;
  price: number | null;
  pv: number | null;
}

export class ValidationError extends Error {}

// ---------- Local time ----------

export interface LocalTime {
  /** Minutes since local midnight. */
  minutes: number;
  /** Fractional hour of day. */
  hour: number;
  dow: number;
  /** YYYY-MM-DD */
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localTime(now: number, tz: string): LocalTime {
  let fmt = formatters.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    }
    formatters.set(tz, fmt);
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(now))) p[part.type] = part.value;
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  const s = Number(p.second);
  return {
    minutes: h * 60 + m,
    hour: h + m / 60 + s / 3600,
    dow: DAY_NAMES.indexOf(p.weekday),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

// ---------- Parsing ----------

/** "20%" → 20, "1.5 kW" → 1500, " 0.30 " → 0.3. Returns null for empty input. */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new ValidationError(`Invalid number '${raw}'`);
    return raw;
  }
  const text = String(raw).trim().replace(',', '.');
  if (!text) return null;
  const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)\s*([^\d\s.,-][^\d]*)?$/.exec(text);
  if (!m) throw new ValidationError(`Invalid number '${text}'`);
  const n = Number(m[1]);
  // Only kW / kWh / kVA scale; any other unit text (%, W, V, €/kWh, kr …) is ignored.
  return /^k(w|wh|va)$/i.test((m[2] ?? '').trim()) ? n * 1000 : n;
}

/** "6" → "06:00", "6:30" → "06:30", "24:00" allowed as an end time. */
export function parseTime(raw: unknown, allow24 = false): string {
  const text = String(raw ?? '').trim();
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (!m) throw new ValidationError(`Invalid time '${text}'. Use HH:MM.`);
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59 || h > 24 || (h === 24 && (min > 0 || !allow24))) throw new ValidationError(`Invalid time '${text}'. Use HH:MM.`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function parseDay(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) return raw;
  const text = String(raw).trim().slice(0, 3).toLowerCase();
  const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === text);
  if (i < 0) throw new ValidationError(`Invalid day '${raw}'`);
  return i;
}

function parseBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const t = String(raw ?? '').trim().toLowerCase();
  if (['true', 'yes', '1', 'on', 'available'].includes(t)) return true;
  if (['false', 'no', '0', 'off', 'unavailable', 'outage'].includes(t)) return false;
  throw new ValidationError(`Invalid value '${raw}'. Use yes or no.`);
}

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEARLY_DATE = /^\d{2}-\d{2}$/;

function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim();
  if (FULL_DATE.test(text) && !Number.isNaN(Date.parse(text))) return text;
  if (YEARLY_DATE.test(text)) {
    const [mo, d] = text.split('-').map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return text;
  }
  throw new ValidationError(`Invalid date '${text}'. Use YYYY-MM-DD or MM-DD.`);
}

const isAny = (raw: unknown) =>
  raw === null || raw === undefined || raw === 'any' || raw === 'Any' ||
  (typeof raw === 'object' && raw !== null && (raw as { any?: unknown }).any === true);

/** Validates and normalizes one condition cell for its kind. */
export function normalizeCondition(kind: ConditionKind, raw: unknown): CondValue {
  if (isAny(raw)) return null;
  const meta = CONDITIONS[kind];
  const r = (typeof raw === 'object' ? raw : { value: raw }) as Record<string, unknown>;
  switch (meta.type) {
    case 'time': {
      const from = parseTime(r.from);
      const to = parseTime(r.to, true);
      return { from, to: to === '24:00' ? '00:00' : to };
    }
    case 'days': {
      const list = Array.isArray(r.days) ? r.days : typeof r.value === 'string' ? r.value.split(/[\s,]+/).filter(Boolean) : [];
      const days = [...new Set(list.map(parseDay))].sort();
      if (!days.length) throw new ValidationError('Select at least one day.');
      return { days };
    }
    case 'bool':
      return { value: parseBool(r.value) };
    case 'date': {
      const from = parseDate(r.from);
      const to = parseDate(r.to);
      if (from === null && to === null) throw new ValidationError('Enter a start or end date.');
      const yearly = [from, to].some((d) => d && YEARLY_DATE.test(d));
      if (yearly && !(from && to && YEARLY_DATE.test(from) && YEARLY_DATE.test(to))) {
        throw new ValidationError('Yearly date ranges (MM-DD) need both a start and an end.');
      }
      if (!yearly && from && to && from > to) throw new ValidationError(`Start date ${from} is after end date ${to}.`);
      return { from, to };
    }
    case 'range': {
      const from = parseNumber(r.from);
      const to = parseNumber(r.to);
      if (from === null && to === null) throw new ValidationError(`Enter a range for ${meta.label.toLowerCase()}.`);
      for (const v of [from, to]) {
        if (v === null) continue;
        if (meta.min !== undefined && v < meta.min) throw new ValidationError(`${meta.label} must be at least ${meta.min}${meta.unit ?? ''}.`);
        if (meta.max !== undefined && v > meta.max) throw new ValidationError(`${meta.label} must be at most ${meta.max}${meta.unit ?? ''}.`);
      }
      if (from !== null && to !== null && from > to) throw new ValidationError(`${meta.label}: ${from} is greater than ${to}.`);
      return { from, to };
    }
  }
}

// ---------- Matching ----------

const fmtNum = (n: number, unit = '') => `${Math.round(n * 100) / 100}${unit}`;

/** Human text for a condition cell, e.g. "22:00–06:00", "≤ 20%", "Mon, Tue". */
export function describeCondition(kind: ConditionKind, c: CondValue, unit?: string): string {
  if (c === null) return 'Any';
  const u = unit ?? CONDITIONS[kind].unit ?? '';
  switch (CONDITIONS[kind].type) {
    case 'time': {
      const t = c as TimeCond;
      return t.from === t.to ? 'All day' : `${t.from}–${t.to}`;
    }
    case 'days':
      return (c as DaysCond).days.map((d) => DAY_NAMES[d]).join(', ');
    case 'bool':
      return (c as BoolCond).value ? 'Yes' : 'No';
    case 'date': {
      const d = c as DateCond;
      return d.from && d.to ? `${d.from} – ${d.to}` : d.from ? `from ${d.from}` : `until ${d.to}`;
    }
    case 'range': {
      const r = c as RangeCond;
      if (r.from !== null && r.to !== null) return `${fmtNum(r.from)}–${fmtNum(r.to, u)}`;
      return r.from !== null ? `≥ ${fmtNum(r.from, u)}` : `≤ ${fmtNum(r.to as number, u)}`;
    }
  }
}

export interface MatchResult {
  match: boolean;
  /** e.g. "Battery SOC 18% ≤ 20%". */
  text: string;
}

export function matchCondition(kind: ConditionKind, c: CondValue, inputs: Inputs, lt = localTime(inputs.now, inputs.tz)): MatchResult {
  const meta = CONDITIONS[kind];
  if (c === null) return { match: true, text: '' };
  switch (kind) {
    case 'time': {
      const t = c as TimeCond;
      const from = toMinutes(t.from);
      const to = toMinutes(t.to);
      const m = lt.minutes;
      const match = from === to ? true : from < to ? m >= from && m < to : m >= from || m < to;
      const now = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return { match, text: `Time ${now} ${match ? 'in' : 'outside'} ${describeCondition(kind, c)}` };
    }
    case 'day': {
      const match = (c as DaysCond).days.includes(lt.dow);
      return { match, text: `Day ${DAY_NAMES[lt.dow]}` };
    }
    case 'date': {
      const d = c as DateCond;
      let match: boolean;
      if (d.from && YEARLY_DATE.test(d.from)) {
        const md = lt.date.slice(5);
        const from = d.from;
        const to = d.to as string;
        match = from <= to ? md >= from && md <= to : md >= from || md <= to;
      } else {
        match = (!d.from || lt.date >= d.from) && (!d.to || lt.date <= d.to);
      }
      return { match, text: `Date ${lt.date} ${match ? 'in' : 'outside'} ${describeCondition(kind, c)}` };
    }
    case 'grid': {
      const want = (c as BoolCond).value;
      if (inputs.gridAvailable === null) return { match: false, text: 'Grid availability unknown' };
      return { match: inputs.gridAvailable === want, text: inputs.gridAvailable ? 'Grid available' : 'Grid unavailable' };
    }
    case 'soc':
    case 'price':
    case 'pv': {
      const value = kind === 'soc' ? inputs.soc : kind === 'price' ? inputs.price : inputs.pv;
      const unit = meta.unit ?? '';
      if (value === null) return { match: false, text: `${meta.short} unknown` };
      const r = c as RangeCond;
      const match = (r.from === null || value >= r.from) && (r.to === null || value <= r.to);
      const v = fmtNum(value, unit);
      let text: string;
      if (r.from !== null && r.to !== null) text = `${meta.short} ${v} ${match ? 'in' : 'outside'} ${describeCondition(kind, c)}`;
      else if (r.to !== null) text = `${meta.short} ${v} ${match ? '≤' : '>'} ${fmtNum(r.to, unit)}`;
      else text = `${meta.short} ${v} ${match ? '≥' : '<'} ${fmtNum(r.from as number, unit)}`;
      return { match, text };
    }
  }
}
