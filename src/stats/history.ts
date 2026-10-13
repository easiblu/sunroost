/**
 * History store: 10 s samples of the combined system and of each inverter, plus a 5-minute
 * rollup (average) that is kept forever. Raw rows are pruned after 'history.raw_retention_days'.
 *
 * Layout is "wide": one row per (scope, timestamp) with one REAL column per metric, so a
 * sample costs one row instead of one row per metric. Scope `inv` is -1 for the combined
 * system and 0…N-1 for individual inverters (written only when there is more than one).
 * Timestamps are unix seconds; rollup rows carry the bucket start.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { db } from '../core/db.ts';
import { HISTORY_INVERTER_METRICS, HISTORY_TOTAL_METRICS, snake, type Metrics } from '../core/metrics.ts';
import { settings } from '../core/settings.ts';

export const COMBINED = -1;
export const SAMPLE_SECONDS = 10;
export const ROLLUP_SECONDS = 300;
/** The API buckets to at most about this many points. */
export const MAX_POINTS = 1500;

/** Every metric that has a column. Combined rows can hold all of them, inverter rows the inverter list. */
export const HISTORY_METRICS = [...new Set([...HISTORY_TOTAL_METRICS, ...HISTORY_INVERTER_METRICS])];
const COMBINED_METRICS = HISTORY_METRICS;
const column = (metric: string) => `m_${snake(metric)}`;
const COLUMNS = HISTORY_METRICS.map(column);

export interface Sample {
  inv: number;
  ts: number;
  values: (number | null)[];
}

// Prepared statements are cached per database instance (a restore re-opens the db).
let stmtDb: DatabaseSync | null = null;
let stmts: Record<string, StatementSync> = {};
function stmt(key: string, sql: string) {
  if (stmtDb !== db()) {
    stmtDb = db();
    stmts = {};
  }
  return (stmts[key] ??= db().prepare(sql));
}

export function ensureHistoryTables() {
  const d = db();
  for (const table of ['history_raw', 'history_5m']) {
    d.exec(`CREATE TABLE IF NOT EXISTS ${table} (inv INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (inv, ts)) WITHOUT ROWID`);
    const have = new Set((d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
    // New metrics simply become new columns; old rows read as NULL.
    for (const c of COLUMNS) if (!have.has(c)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${c} REAL`);
  }
  d.exec(`CREATE TABLE IF NOT EXISTS stats_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

export function getMeta(key: string): string | null {
  const row = stmt('getMeta', `SELECT value FROM stats_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setMeta(key: string, value: string | number) {
  stmt('setMeta', `INSERT OR REPLACE INTO stats_meta (key, value) VALUES (?, ?)`).run(key, String(value));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Builds the samples for one instant from combined totals and per-inverter metrics. */
export function makeSamples(ts: number, totals: Metrics, inverters: Metrics[]): Sample[] {
  const out: Sample[] = [];
  const combined = HISTORY_METRICS.map((m) => (COMBINED_METRICS.includes(m) ? num(totals[m]) : null));
  if (combined.some((v) => v !== null)) out.push({ inv: COMBINED, ts, values: combined });
  const present = inverters.filter(Boolean);
  if (present.length > 1) {
    inverters.forEach((inv, i) => {
      if (!inv) return;
      const values = HISTORY_METRICS.map((m) => (HISTORY_INVERTER_METRICS.includes(m) ? num(inv[m]) : null));
      if (values.some((v) => v !== null)) out.push({ inv: i, ts, values });
    });
  }
  return out;
}

/** Writes samples in one transaction. */
export function writeSamples(samples: Sample[], table: 'history_raw' | 'history_5m' = 'history_raw') {
  if (!samples.length) return;
  const insert = stmt(
    `insert:${table}`,
    `INSERT OR REPLACE INTO ${table} (inv, ts, ${COLUMNS.join(', ')}) VALUES (?, ?, ${COLUMNS.map(() => '?').join(', ')})`,
  );
  const d = db();
  d.exec('BEGIN');
  try {
    for (const s of samples) insert.run(s.inv, s.ts, ...s.values);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// Samples wait here and are written in one transaction every FLUSH interval.
let pending: Sample[] = [];
export function queueSamples(samples: Sample[]) {
  pending.push(...samples);
}
export function flushPending() {
  if (!pending.length) return 0;
  const batch = pending;
  pending = [];
  writeSamples(batch);
  return batch.length;
}

/** Scopes (combined + inverters) that have rows in a table. */
export function scopes(table: 'history_raw' | 'history_5m' = 'history_raw'): number[] {
  return (db().prepare(`SELECT DISTINCT inv FROM ${table}`).all() as { inv: number }[]).map((r) => r.inv);
}

export function oldestTs(table: 'history_raw' | 'history_5m', inv: number): number | null {
  const row = stmt(`oldest:${table}`, `SELECT min(ts) AS ts FROM ${table} WHERE inv = ?`).get(inv) as { ts: number | null };
  return row?.ts ?? null;
}

/** Rollup covers every bucket that starts before this (unix seconds). */
export function rollupUntil(): number {
  return Number(getMeta('rollup_until') ?? 0);
}

/**
 * Averages raw rows into 5-minute buckets up to `untilSec` (rounded down to a bucket).
 * Idempotent: re-running a range replaces its buckets.
 */
export function rollup(untilSec: number) {
  const until = Math.floor(untilSec / ROLLUP_SECONDS) * ROLLUP_SECONDS;
  let from = rollupUntil();
  const d = db();
  const invs = scopes('history_raw');
  if (!from) {
    const oldest = Math.min(...invs.map((i) => oldestTs('history_raw', i) ?? Infinity));
    if (!Number.isFinite(oldest)) return setMeta('rollup_until', until);
    from = Math.floor(oldest / ROLLUP_SECONDS) * ROLLUP_SECONDS;
  }
  if (from >= until) return;
  d.exec('BEGIN');
  try {
    for (const inv of invs) {
      d.prepare(
        `INSERT OR REPLACE INTO history_5m (inv, ts, ${COLUMNS.join(', ')})
         SELECT inv, (ts / ${ROLLUP_SECONDS}) * ${ROLLUP_SECONDS} AS b, ${COLUMNS.map((c) => `avg(${c})`).join(', ')}
         FROM history_raw WHERE inv = ? AND ts >= ? AND ts < ? GROUP BY b`,
      ).run(inv, from, until);
    }
    setMeta('rollup_until', until);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Deletes raw rows older than the retention period (never rows not yet rolled up). */
export function prune(nowSec = Math.floor(Date.now() / 1000)) {
  const days = Math.max(1, Number(settings.get('history.raw_retention_days')) || 14);
  const cutoff = Math.min(nowSec - days * 86_400, rollupUntil());
  let deleted = 0;
  for (const inv of scopes('history_raw')) {
    deleted += Number(stmt('prune', `DELETE FROM history_raw WHERE inv = ? AND ts < ?`).run(inv, cutoff).changes);
  }
  return deleted;
}

export function clearHistory() {
  pending = [];
  db().exec(`DELETE FROM history_raw; DELETE FROM history_5m; DELETE FROM stats_meta WHERE key = 'rollup_until';`);
}

const STEPS = [10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** Smallest "nice" bucket size that keeps a span under MAX_POINTS. */
export function resolutionFor(spanSec: number, min = SAMPLE_SECONDS) {
  const want = Math.max(min, spanSec / MAX_POINTS);
  return STEPS.find((s) => s >= want) ?? Math.ceil(want / 86400) * 86400;
}

export interface HistoryResult {
  xs: number[];
  series: Record<string, (number | null)[]>;
  resolution: number;
}

/**
 * Bucketed history for [fromMs, toMs). Uses the raw table when the range is short and still
 * covered by raw rows, otherwise the 5-minute rollup (plus raw rows not yet rolled up).
 * A null point is inserted wherever consecutive buckets are more than 3 buckets apart, so
 * lines break during outages.
 */
export function queryHistory(opts: { from: number; to: number; metrics: string[]; inverter?: number }): HistoryResult {
  const fromSec = Math.floor(opts.from / 1000);
  const toSec = Math.ceil(opts.to / 1000);
  const metrics = opts.metrics;
  const known = metrics.filter((m) => HISTORY_METRICS.includes(m));
  let inv = opts.inverter ?? COMBINED;
  // Single-inverter installs only store the combined scope; it is the same data.
  if (inv !== COMBINED && oldestTs('history_raw', inv) === null && oldestTs('history_5m', inv) === null) inv = COMBINED;

  let res = resolutionFor(toSec - fromSec);
  const rawOldest = oldestTs('history_raw', inv);
  const rollOldest = oldestTs('history_5m', inv);
  // Raw rows were pruned for part of the range, and the rollup has that part.
  const rawPruned =
    rollOldest !== null && (rawOldest === null || (fromSec < rawOldest && rollOldest < rawOldest - ROLLUP_SECONDS));
  const useRollup = res >= ROLLUP_SECONDS || rawPruned;
  if (useRollup) res = Math.max(res, ROLLUP_SECONDS);

  const empty = (): HistoryResult => ({ xs: [], series: Object.fromEntries(metrics.map((m) => [m, []])), resolution: res });
  if (!known.length || toSec <= fromSec) return empty();

  const cols = known.map(column);
  const select = (table: string) =>
    `SELECT (ts / ${res}) * ${res} AS b, ${cols.map((c) => `avg(${c})`).join(', ')}, count(*) AS n
     FROM ${table} WHERE inv = ? AND ts >= ? AND ts < ? GROUP BY b ORDER BY b`;

  type Row = Record<string, number | null>;
  let rows: Row[];
  if (useRollup) {
    const split = Math.max(fromSec, Math.min(toSec, rollupUntil()));
    const rolled = db().prepare(select('history_5m')).all(inv, fromSec, split) as Row[];
    const recent = db().prepare(select('history_raw')).all(inv, split, toSec) as Row[];
    // The bucket at the seam can come from both tables; keep the rollup's value.
    const last = rolled.at(-1)?.b;
    rows = [...rolled, ...recent.filter((r) => r.b !== last)];
  } else {
    rows = db().prepare(select('history_raw')).all(inv, fromSec, toSec) as Row[];
  }

  const xs: number[] = [];
  const series: Record<string, (number | null)[]> = Object.fromEntries(metrics.map((m) => [m, []]));
  const keys = cols.map((c) => `avg(${c})`);
  let prev: number | null = null;
  for (const row of rows) {
    const b = row.b as number;
    if (prev !== null && b - prev > 3 * res) {
      xs.push(prev + res);
      for (const m of metrics) series[m].push(null);
    }
    xs.push(b);
    metrics.forEach((m) => {
      const i = known.indexOf(m);
      const v = i < 0 ? null : (row[keys[i]] as number | null);
      series[m].push(v === null ? null : Math.round(v * 100) / 100);
    });
    prev = b;
  }
  return { xs, series, resolution: res };
}
