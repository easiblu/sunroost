/**
 * Energy totals. Live power readings are integrated (trapezoid, gaps capped at 60 s) into
 * per-day buckets in the configured timezone and persisted to `energy_daily`. Weeks, months
 * and years are summed from the days. `energyTotals()` is a contract used by MQTT.
 */
import { db } from '../core/db.ts';
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';
import { state, type EnergyToday } from '../core/state.ts';
import { COMBINED, flushPending, oldestTs, ROLLUP_SECONDS } from './history.ts';
import { addDays, addMonths, dayKey, dayStart, isoWeekStart, monthStart, safeTz, yearStart } from './tz.ts';

export const FIELDS = ['pv', 'load', 'gridImport', 'gridExport', 'batteryCharge', 'batteryDischarge'] as const;
export type Field = (typeof FIELDS)[number];
export type Energy = Record<Field, number>;
const COLS: Record<Field, string> = {
  pv: 'pv', load: 'load', gridImport: 'grid_import', gridExport: 'grid_export',
  batteryCharge: 'battery_charge', batteryDischarge: 'battery_discharge',
};

/** Longest interval integrated between two readings; longer gaps count as this long. */
export const MAX_GAP_S = 60;

export interface PowerSample {
  /** Unix ms. */
  t: number;
  pv: number | null;
  load: number | null;
  grid: number | null;
  battery: number | null;
}

const zero = (): Energy => ({ pv: 0, load: 0, gridImport: 0, gridExport: 0, batteryCharge: 0, batteryDischarge: 0 });
export const tz = () => safeTz(settings.get('timezone'));

/** Signed power → per-field instantaneous power (W, ≥ 0); null where the reading is missing. */
function parts(s: PowerSample): Record<Field, number | null> {
  const pos = (v: number | null) => (v === null ? null : Math.max(0, v));
  const neg = (v: number | null) => (v === null ? null : Math.max(0, -v));
  return {
    pv: pos(s.pv), load: pos(s.load), gridImport: pos(s.grid), gridExport: neg(s.grid),
    batteryCharge: pos(s.battery), batteryDischarge: neg(s.battery),
  };
}

/**
 * Integrates the interval between two readings. Calls add(day, field, kWh) once per field
 * and local day; an interval that crosses midnight is split at the day boundary.
 */
export function integrate(prev: PowerSample, cur: PowerSample, zone: string, add: (day: string, f: Field, kwh: number) => void) {
  const dt = (cur.t - prev.t) / 1000;
  if (!(dt > 0)) return;
  const span = Math.min(dt, MAX_GAP_S);
  const start = cur.t - span * 1000;
  const p0 = parts(prev);
  const p1 = parts(cur);
  const d0 = dayKey(start, zone);
  const d1 = dayKey(cur.t, zone);
  const boundary = d0 === d1 ? cur.t : dayStart(d1, zone);
  const f = (boundary - start) / (cur.t - start);
  for (const field of FIELDS) {
    const a = p0[field];
    const b = p1[field];
    if (a === null || b === null) continue;
    const mid = a + (b - a) * f;
    const wh = (x: number, y: number, sec: number) => ((x + y) / 2) * (sec / 3600);
    if (d0 === d1) add(d1, field, wh(a, b, span) / 1000);
    else {
      add(d0, field, wh(a, mid, span * f) / 1000);
      add(d1, field, wh(mid, b, span * (1 - f)) / 1000);
    }
  }
}

// ---------- Persistence ----------

export function ensureTotalsTables() {
  db().exec(`CREATE TABLE IF NOT EXISTS energy_daily (
    day TEXT PRIMARY KEY, pv REAL NOT NULL DEFAULT 0, load REAL NOT NULL DEFAULT 0,
    grid_import REAL NOT NULL DEFAULT 0, grid_export REAL NOT NULL DEFAULT 0,
    battery_charge REAL NOT NULL DEFAULT 0, battery_discharge REAL NOT NULL DEFAULT 0)`);
}

const colList = FIELDS.map((f) => COLS[f]).join(', ');
const selectCols = FIELDS.map((f) => `${COLS[f]} AS ${f}`).join(', ');

export function readDay(day: string): Energy {
  const row = db().prepare(`SELECT ${selectCols} FROM energy_daily WHERE day = ?`).get(day) as Energy | undefined;
  return row ? { ...zero(), ...row } : zero();
}

/** Daily rows in [fromDay, toDay] (inclusive), oldest first. */
export function readDays(fromDay: string, toDay: string): (Energy & { day: string })[] {
  return db().prepare(`SELECT day, ${selectCols} FROM energy_daily WHERE day >= ? AND day <= ? ORDER BY day`).all(fromDay, toDay) as never;
}

/** Replaces (mode 'set') or adds to (mode 'add') a day's row. */
export function writeDay(day: string, e: Energy, mode: 'set' | 'add' = 'set') {
  const update = FIELDS.map((f) => `${COLS[f]} = ${mode === 'add' ? `${COLS[f]} + ` : ''}excluded.${COLS[f]}`).join(', ');
  db()
    .prepare(`INSERT INTO energy_daily (day, ${colList}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})
      ON CONFLICT(day) DO UPDATE SET ${update}`)
    .run(day, ...FIELDS.map((f) => e[f]));
}

// ---------- Live tracker ----------

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const rounded = (e: Energy): Energy => Object.fromEntries(FIELDS.map((f) => [f, r3(e[f])])) as Energy;

class Tracker {
  active = false;
  day = '';
  today: Energy = zero();
  private prev: PowerSample | null = null;
  private dirty = false;

  start(now = Date.now()) {
    this.active = true;
    this.prev = null;
    this.day = dayKey(now, tz());
    this.today = readDay(this.day);
    this.publish();
  }

  stop() {
    this.save();
    this.active = false;
    this.prev = null;
  }

  /** Feeds one live reading. */
  sample(s: PowerSample) {
    if (!this.active) return;
    if (this.prev) {
      integrate(this.prev, s, tz(), (day, f, kwh) => {
        if (day !== this.day) {
          if (day < this.day) return writeDay(day, { ...zero(), [f]: kwh }, 'add'); // tail of a finished day
          this.rollTo(day);
        }
        this.today[f] += kwh;
        this.dirty = true;
      });
    }
    this.prev = s;
    this.publish();
  }

  /** Starts a new day when the clock passes midnight even without readings. */
  checkRollover(now = Date.now()) {
    const day = dayKey(now, tz());
    if (this.active && day !== this.day) {
      this.rollTo(day);
      this.publish();
    }
  }

  private rollTo(day: string) {
    this.save();
    this.day = day;
    this.today = readDay(day);
  }

  save() {
    if (!this.active || !this.dirty || !this.day) return;
    writeDay(this.day, this.today, 'set');
    this.dirty = false;
  }

  /** Re-reads today after the table was rewritten (resample, clear). */
  reload() {
    if (!this.active) return;
    this.dirty = false;
    this.today = readDay(this.day);
    this.publish();
  }

  current(): EnergyToday {
    return { day: this.day, ...rounded(this.today) };
  }

  private publish() {
    state.setEnergy(this.current());
  }
}

export const tracker = new Tracker();

// ---------- Queries ----------

function sum(rows: Energy[]): Energy {
  const out = zero();
  for (const r of rows) for (const f of FIELDS) out[f] += r[f] ?? 0;
  return out;
}

/** Daily rows with today's row taken from the live tracker (fresher than the table). */
function daysWithLive(fromDay: string, toDay: string) {
  const rows = readDays(fromDay, toDay);
  if (tracker.active && tracker.day >= fromDay && tracker.day <= toDay) {
    const i = rows.findIndex((r) => r.day === tracker.day);
    const live = { day: tracker.day, ...tracker.today };
    if (i >= 0) rows[i] = live;
    else rows.push(live);
  }
  return rows;
}

/**
 * Energy (kWh) accumulated since the start of the current day ('d'), ISO week ('w') or month ('m'),
 * in the configured timezone. `day` holds the period start date (YYYY-MM-DD).
 */
export function energyTotals(period: 'd' | 'w' | 'm'): EnergyToday {
  try {
    if (tracker.active) tracker.checkRollover();
    const today = tracker.active ? tracker.day : dayKey(Date.now(), tz());
    const start = period === 'w' ? isoWeekStart(today) : period === 'm' ? monthStart(today) : today;
    return { day: start, ...rounded(sum(daysWithLive(start, today))) };
  } catch {
    return { day: '', ...zero() };
  }
}

export type Period = 'day' | 'week' | 'month' | 'year';
export const PERIOD_DEFAULT_COUNT: Record<Period, number> = { day: 30, week: 52, month: 12, year: 5 };

export interface TotalsRow extends Energy {
  label: string;
  start: string;
  /** % of load not supplied by the grid; null without load. */
  selfSufficiency: number | null;
  cost?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function label(period: Period, start: string) {
  const [y, m, d] = start.split('-').map(Number);
  if (period === 'year') return String(y);
  if (period === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${d}`;
}

function periodStart(period: Period, day: string) {
  return period === 'day' ? day : period === 'week' ? isoWeekStart(day) : period === 'month' ? monthStart(day) : yearStart(day);
}

function stepBack(period: Period, start: string, n: number) {
  if (period === 'day') return addDays(start, -n);
  if (period === 'week') return addDays(start, -7 * n);
  if (period === 'month') return addMonths(start, -n);
  return `${Number(start.slice(0, 4)) - n}-01-01`;
}

function finish(e: Energy, prices: { import: number; export: number }) {
  const load = e.load;
  const selfSufficiency = load > 0 ? Math.round(Math.max(0, Math.min(100, (1 - e.gridImport / load) * 100)) * 10) / 10 : null;
  const out: Omit<TotalsRow, 'label' | 'start'> = { ...rounded(e), selfSufficiency };
  if (prices.import > 0 || prices.export > 0) {
    out.cost = Math.round((e.gridImport * prices.import - e.gridExport * prices.export) * 100) / 100;
  }
  return out;
}

/** Totals per period, oldest first, plus a summary over all rows. */
export function totalsReport(period: Period, count = PERIOD_DEFAULT_COUNT[period]) {
  count = Math.max(1, Math.min(count, period === 'day' ? 3660 : 520));
  const today = tracker.active ? tracker.day : dayKey(Date.now(), tz());
  const last = periodStart(period, today);
  const first = stepBack(period, last, count - 1);
  const prices = { import: Number(settings.get('tariff.import_price')) || 0, export: Number(settings.get('tariff.export_price')) || 0 };

  const buckets = new Map<string, Energy>();
  for (let i = 0, s = first; i < count; i++, s = stepBack(period, s, -1)) buckets.set(s, zero());
  for (const row of daysWithLive(first, today)) {
    const b = buckets.get(periodStart(period, row.day));
    if (b) for (const f of FIELDS) b[f] += row[f];
  }
  const rows: TotalsRow[] = [...buckets].map(([start, e]) => ({ label: label(period, start), start, ...finish(e, prices) }));
  return {
    period,
    rows,
    summary: finish(sum([...buckets.values()]), prices),
    tariff: { importPrice: prices.import, exportPrice: prices.export, currency: settings.get('grid.currency') },
  };
}

const CSV_HEAD = ['period', 'start', 'load_kwh', 'pv_kwh', 'battery_charged_kwh', 'battery_discharged_kwh', 'grid_used_kwh', 'grid_exported_kwh', 'self_sufficiency_pct'];
export function totalsCsv(period: Period, count?: number) {
  const report = totalsReport(period, count);
  const withCost = report.rows.some((r) => r.cost !== undefined);
  const lines = [[...CSV_HEAD, ...(withCost ? [`cost_${report.tariff.currency}`] : [])].join(',')];
  for (const r of report.rows) {
    lines.push([
      `"${r.label}"`, r.start, r.load, r.pv, r.batteryCharge, r.batteryDischarge, r.gridImport, r.gridExport,
      r.selfSufficiency ?? '', ...(withCost ? [r.cost ?? ''] : []),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- Resample ----------

let resampling = false;
export const isResampling = () => resampling;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Recomputes every daily total from stored history: the 5-minute rollup where raw rows have
 * been pruned (each bucket counts as its average for 5 minutes) and the 10 s raw rows after that.
 * Runs in chunks so the event loop stays responsive. Progress is logged under 'db'.
 */
export async function resampleTotals(): Promise<{ days: number }> {
  if (resampling) throw new Error('Resampling is already running');
  resampling = true;
  const l = logger('db');
  try {
    flushPending();
    tracker.save();
    const zone = tz();
    const rawOldest = oldestTs('history_raw', COMBINED);
    const rollOldest = oldestTs('history_5m', COMBINED);
    if (rawOldest === null && rollOldest === null) {
      l.info('Resample totals: no history stored, nothing to do.');
      return { days: 0 };
    }
    l.info('Resampling totals from history…');
    const days = new Map<string, Energy>();
    const add = (day: string, f: Field, kwh: number) => {
      let e = days.get(day);
      if (!e) days.set(day, (e = zero()));
      e[f] += kwh;
    };
    const cols = 'ts, m_pv_power AS pv, m_load_power AS load, m_grid_power AS grid, m_battery_power AS battery';
    const seam = rawOldest === null ? Infinity : Math.floor(rawOldest / ROLLUP_SECONDS) * ROLLUP_SECONDS;
    const end = Math.ceil(Date.now() / 1000) + 1;
    const begin = Math.min(rawOldest ?? Infinity, rollOldest ?? Infinity);
    const CHUNK = 86_400;
    const total = end - begin;
    let lastPct = -1;
    let prev: PowerSample | null = null;
    const rollStmt = db().prepare(`SELECT ${cols} FROM history_5m WHERE inv = ? AND ts >= ? AND ts < ? ORDER BY ts`);
    const rawStmt = db().prepare(`SELECT ${cols} FROM history_raw WHERE inv = ? AND ts >= ? AND ts < ? ORDER BY ts`);
    type Row = { ts: number; pv: number | null; load: number | null; grid: number | null; battery: number | null };

    for (let t = begin; t < end; t += CHUNK) {
      const chunkEnd = Math.min(end, t + CHUNK);
      if (t < seam) {
        for (const r of rollStmt.all(COMBINED, t, Math.min(chunkEnd, seam)) as Row[]) {
          const p = parts({ t: 0, ...r });
          const day = dayKey(r.ts * 1000, zone);
          for (const f of FIELDS) if (p[f] !== null) add(day, f, ((p[f] as number) * ROLLUP_SECONDS) / 3600 / 1000);
        }
      }
      if (chunkEnd > seam) {
        for (const r of rawStmt.all(COMBINED, Math.max(t, seam), chunkEnd) as Row[]) {
          const s: PowerSample = { t: r.ts * 1000, pv: r.pv, load: r.load, grid: r.grid, battery: r.battery };
          if (prev) integrate(prev, s, zone, add);
          prev = s;
        }
      }
      const pct = Math.floor(((chunkEnd - begin) / total) * 10) * 10;
      if (pct !== lastPct && pct < 100) {
        l.info(`Resampling totals: ${pct}% (${dayKey(chunkEnd * 1000, zone)})`);
        lastPct = pct;
      }
      await tick();
    }

    const d = db();
    d.exec('BEGIN');
    try {
      d.exec('DELETE FROM energy_daily');
      for (const [day, e] of days) writeDay(day, e, 'set');
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
    tracker.reload();
    l.info(`Resampled totals for ${days.size} day${days.size === 1 ? '' : 's'}.`);
    return { days: days.size };
  } catch (err) {
    l.error(`Resample failed: ${(err as Error).message}`);
    throw err;
  } finally {
    resampling = false;
  }
}

export function clearTotals() {
  db().exec('DELETE FROM energy_daily');
  tracker.reload();
}
