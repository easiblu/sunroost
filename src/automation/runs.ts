/**
 * Persistence for rule execution: run history (30 days), the last fire time of every scheduled
 * trigger (so a restart neither misses nor repeats a fire) and pending setting reverts.
 */
import { db } from '../core/db.ts';
import type { Value } from '../core/metrics.ts';

export const RUN_RETENTION_MS = 30 * 86_400_000;

export type RunResult = 'ok' | 'partial' | 'failed' | 'skipped';

export interface RunAction {
  text: string;
  ok: boolean;
  message: string;
  /** Not attempted (suspended, disconnected, overridden, unchanged…); doesn't count as a failure. */
  skipped?: boolean;
}

export interface Run {
  id: number;
  automationId: number | null;
  sceneId: number | null;
  ts: number;
  trigger: string;
  dryRun: boolean;
  result: RunResult;
  actions: RunAction[];
}

export function initRuns() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER, scene_id INTEGER, ts INTEGER NOT NULL, "trigger" TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL, actions TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_runs_auto ON automation_runs (automation_id, ts);
    CREATE INDEX IF NOT EXISTS automation_runs_ts ON automation_runs (ts);
    CREATE TABLE IF NOT EXISTS automation_trigger_state (
      rule_id INTEGER NOT NULL, key TEXT NOT NULL, last_fire INTEGER NOT NULL, PRIMARY KEY (rule_id, key)
    );
    CREATE TABLE IF NOT EXISTS automation_reverts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL, inverter INTEGER NOT NULL, setting TEXT NOT NULL,
      previous TEXT NOT NULL, applied TEXT NOT NULL, due INTEGER NOT NULL, set_at INTEGER NOT NULL
    );
  `);
}

/** Overall result from the action outcomes. */
export function resultOf(actions: RunAction[]): RunResult {
  const tried = actions.filter((a) => !a.skipped);
  if (!tried.length) return 'skipped';
  const ok = tried.filter((a) => a.ok).length;
  return ok === tried.length ? 'ok' : ok === 0 ? 'failed' : 'partial';
}

interface RunRow {
  id: number;
  automation_id: number | null;
  scene_id: number | null;
  ts: number;
  trigger: string;
  dry_run: number;
  result: string;
  actions: string;
}

function fromRow(r: RunRow): Run {
  let actions: RunAction[] = [];
  try {
    actions = JSON.parse(r.actions);
  } catch {}
  return {
    id: r.id, automationId: r.automation_id, sceneId: r.scene_id, ts: r.ts, trigger: r.trigger,
    dryRun: Boolean(r.dry_run), result: r.result as RunResult, actions,
  };
}

export function addRun(run: Omit<Run, 'id'>): Run {
  const res = db()
    .prepare(`INSERT INTO automation_runs (automation_id, scene_id, ts, "trigger", dry_run, result, actions) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(run.automationId, run.sceneId, run.ts, run.trigger, run.dryRun ? 1 : 0, run.result, JSON.stringify(run.actions));
  return { ...run, id: Number(res.lastInsertRowid) };
}

/** Rewrites a run's actions/result (delayed actions append to their run). */
export function updateRun(id: number, actions: RunAction[], result = resultOf(actions)) {
  db().prepare(`UPDATE automation_runs SET actions = ?, result = ? WHERE id = ?`).run(JSON.stringify(actions), result, id);
}

export function getRun(id: number): Run | null {
  const r = db().prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(id) as unknown as RunRow | undefined;
  return r ? fromRow(r) : null;
}

export function listRuns(opts: { automationId?: number; limit?: number } = {}): Run[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
  const rows = (opts.automationId !== undefined
    ? db().prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(opts.automationId, limit)
    : db().prepare(`SELECT * FROM automation_runs ORDER BY ts DESC, id DESC LIMIT ?`).all(limit)) as unknown as RunRow[];
  return rows.map(fromRow);
}

/** Last run of an automation (any result). */
export function lastRun(automationId: number): Run | null {
  return listRuns({ automationId, limit: 1 })[0] ?? null;
}

/** Runs that executed actions (not skipped) since `since`. */
export function countRuns(automationId: number, since: number): number {
  const r = db()
    .prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND ts >= ? AND result != 'skipped' AND dry_run = 0`)
    .get(automationId, since) as { n: number };
  return Number(r.n);
}

/** Time of the last executed (not skipped) run, for the cooldown. */
export function lastExecuted(automationId: number): number | null {
  const r = db()
    .prepare(`SELECT MAX(ts) AS ts FROM automation_runs WHERE automation_id = ? AND result != 'skipped' AND dry_run = 0`)
    .get(automationId) as { ts: number | null };
  return r.ts ?? null;
}

export function pruneRuns(now = Date.now()) {
  db().prepare(`DELETE FROM automation_runs WHERE ts < ?`).run(now - RUN_RETENTION_MS);
}

/** Drops the trigger state of a deleted rule. Its pending reverts stay, so changed settings are still restored. */
export function forgetTriggers(automationId: number) {
  db().prepare(`DELETE FROM automation_trigger_state WHERE rule_id = ?`).run(automationId);
}

// ---------- Trigger state ----------

export function lastFire(ruleId: number, key: string): number | null {
  const r = db().prepare(`SELECT last_fire FROM automation_trigger_state WHERE rule_id = ? AND key = ?`).get(ruleId, key) as
    | { last_fire: number }
    | undefined;
  return r?.last_fire ?? null;
}

export function setLastFire(ruleId: number, key: string, ts: number) {
  db().prepare(`INSERT OR REPLACE INTO automation_trigger_state (rule_id, key, last_fire) VALUES (?, ?, ?)`).run(ruleId, key, ts);
}

// ---------- Reverts ----------

export interface Revert {
  id: number;
  ruleId: number;
  inverter: number;
  setting: string;
  /** Value before the rule changed it. */
  previous: Value;
  /** Value the rule wrote. */
  applied: Value;
  due: number;
  setAt: number;
}

interface RevertRow {
  id: number;
  rule_id: number;
  inverter: number;
  setting: string;
  previous: string;
  applied: string;
  due: number;
  set_at: number;
}

const revertFrom = (r: RevertRow): Revert => ({
  id: r.id, ruleId: r.rule_id, inverter: r.inverter, setting: r.setting,
  previous: JSON.parse(r.previous), applied: JSON.parse(r.applied), due: r.due, setAt: r.set_at,
});

export function reverts(): Revert[] {
  return (db().prepare(`SELECT * FROM automation_reverts ORDER BY due`).all() as unknown as RevertRow[]).map(revertFrom);
}

export function findRevert(inverter: number, setting: string): Revert | null {
  const r = db().prepare(`SELECT * FROM automation_reverts WHERE inverter = ? AND setting = ?`).get(inverter, setting) as unknown as RevertRow | undefined;
  return r ? revertFrom(r) : null;
}

export function addRevert(r: Omit<Revert, 'id'>) {
  db()
    .prepare(`INSERT INTO automation_reverts (rule_id, inverter, setting, previous, applied, due, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(r.ruleId, r.inverter, r.setting, JSON.stringify(r.previous), JSON.stringify(r.applied), r.due, r.setAt);
}

export function updateRevert(id: number, changes: { ruleId: number; applied: Value; due: number; setAt: number }) {
  db()
    .prepare(`UPDATE automation_reverts SET rule_id = ?, applied = ?, due = ?, set_at = ? WHERE id = ?`)
    .run(changes.ruleId, JSON.stringify(changes.applied), changes.due, changes.setAt, id);
}

export function removeRevert(id: number) {
  db().prepare(`DELETE FROM automation_reverts WHERE id = ?`).run(id);
}
