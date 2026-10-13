/**
 * Smart-device history: state changes of device entities (Sunroost's own energy readings already have
 * their own history in stats/). Kept light for SD cards:
 *
 * - every state change of switches, modes, binary sensors …;
 * - numeric readings only when they move more than 2% (or 1 unit), or after 60 s, whichever is first;
 * - written in one transaction every 10 s; kept 14 days.
 *
 * Also gives the energy each device with a power reading used today (for the dashboard).
 */
import { db } from '../core/db.ts';
import { bus, type StateChangedEvent } from './bus.ts';
import * as registry from './registry.ts';
import { UNAVAILABLE, UNKNOWN } from './types.ts';

const FLUSH_MS = 10_000;
const KEEP_DAYS = 14;
const MIN_GAP_MS = 60_000;
const PRUNE_MS = 3_600_000;
const MAX_POINTS = 600;

type Row = [entityId: string, ts: number, state: string, num: number | null];

let queue: Row[] = [];
const last = new Map<string, { ts: number; state: string; num: number | null }>();
let flushTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

export function init() {
  db().exec(`CREATE TABLE IF NOT EXISTS home_state_log (entity_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, num REAL);
    CREATE INDEX IF NOT EXISTS home_state_log_entity_ts ON home_state_log (entity_id, ts)`);
}

const toNum = (s: string) => (s === '' || s === UNAVAILABLE || s === UNKNOWN ? null : Number.isFinite(Number(s)) ? Number(s) : null);

/** Whether a change is worth a row (exported for tests). */
export function worthRecording(prev: { ts: number; state: string; num: number | null } | undefined, state: string, num: number | null, now: number): boolean {
  if (!prev) return true;
  if (num === null || prev.num === null) return state !== prev.state;
  const delta = Math.abs(num - prev.num);
  if (delta >= Math.max(1, Math.abs(prev.num) * 0.02)) return true;
  return delta > 0 && now - prev.ts >= MIN_GAP_MS;
}

function onState(ev: StateChangedEvent) {
  const e = registry.entity(ev.entityId);
  if (!e || e.engine === 'energy' || !ev.newState) return;
  const now = ev.newState.lastUpdated;
  const num = toNum(ev.newState.state);
  if (!worthRecording(last.get(ev.entityId), ev.newState.state, num, now)) return;
  last.set(ev.entityId, { ts: now, state: ev.newState.state, num });
  queue.push([ev.entityId, now, ev.newState.state, num]);
}

/** Writes queued rows now (exported for tests). */
export function flush() {
  if (!queue.length) return;
  const rows = queue;
  queue = [];
  const stmt = db().prepare(`INSERT INTO home_state_log (entity_id, ts, state, num) VALUES (?, ?, ?, ?)`);
  db().exec('BEGIN');
  try {
    for (const r of rows) stmt.run(...r);
    db().exec('COMMIT');
  } catch (err) {
    db().exec('ROLLBACK');
    throw err;
  }
}

export function prune(now = Date.now()) {
  db().prepare(`DELETE FROM home_state_log WHERE ts < ?`).run(now - KEEP_DAYS * 86_400_000);
}

export function start() {
  init();
  bus.on('state_changed', onState);
  flushTimer = setInterval(flush, FLUSH_MS);
  pruneTimer = setInterval(() => prune(), PRUNE_MS);
  prune();
}

export function stop() {
  bus.off('state_changed', onState);
  if (flushTimer) clearInterval(flushTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  flush();
  last.clear();
}

export interface HistoryPoint {
  ts: number;
  state: string;
  num: number | null;
}

/**
 * An entity's history in [from, to]: the state just before `from` (so the chart starts with it),
 * then every row. Numeric series longer than MAX_POINTS are averaged into buckets.
 */
export function history(entityId: string, from: number, to = Date.now()): HistoryPoint[] {
  flush();
  const before = db().prepare(`SELECT ts, state, num FROM home_state_log WHERE entity_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(entityId, from) as HistoryPoint | undefined;
  const rows = db().prepare(`SELECT ts, state, num FROM home_state_log WHERE entity_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`).all(entityId, from, to) as unknown as HistoryPoint[];
  const all = before ? [{ ...before, ts: from }, ...rows] : rows;
  const numeric = all.some((p) => p.num !== null);
  if (!numeric || all.length <= MAX_POINTS) return all;
  const width = (to - from) / MAX_POINTS;
  const out: HistoryPoint[] = [];
  for (let i = 0; i < MAX_POINTS; i++) {
    const a = from + i * width;
    const pts = all.filter((p) => p.ts >= a && p.ts < a + width && p.num !== null);
    if (!pts.length) continue;
    const avg = pts.reduce((s, p) => s + p.num!, 0) / pts.length;
    out.push({ ts: Math.round(a + width / 2), state: String(Math.round(avg * 100) / 100), num: Math.round(avg * 100) / 100 });
  }
  return out;
}

/** Energy (kWh) a power sensor (W) recorded between `from` and now: each value held until the next. */
export function energyKwh(entityId: string, from: number, now = Date.now()): number {
  const pts = history(entityId, from, now).filter((p) => p.num !== null || p.state === UNAVAILABLE);
  let wh = 0;
  for (let i = 0; i < pts.length; i++) {
    const w = pts[i].num ?? 0;
    const until = i + 1 < pts.length ? pts[i + 1].ts : now;
    wh += (Math.max(0, w) * (until - pts[i].ts)) / 3_600_000;
  }
  return Math.round(wh) / 1000;
}

/** For tests. */
export function reset() {
  queue = [];
  last.clear();
}
