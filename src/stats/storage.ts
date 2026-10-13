/**
 * Database maintenance: usage figures, consistent backups, staged restores.
 * A restore is validated, written next to the database as `<db>.restore`, and swapped in
 * on the next start (before any subsystem uses the database).
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, db, dbPath, openDb } from '../core/db.ts';
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';

const l = logger('db');
/** Tables a file must have to be accepted as a Sunroost backup. */
export const REQUIRED_TABLES = ['settings', 'history_raw', 'history_5m', 'energy_daily'];

const fileSize = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

export async function storageInfo() {
  const path = dbPath();
  const count = (table: string) => (db().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const oldest = (db().prepare(`SELECT min(ts) AS ts FROM (SELECT min(ts) AS ts FROM history_raw UNION ALL SELECT min(ts) FROM history_5m)`).get() as { ts: number | null }).ts;
  const days = db().prepare(`SELECT count(*) AS n, min(day) AS first FROM energy_daily`).get() as { n: number; first: string | null };
  let diskTotal: number | null = null;
  let diskFree: number | null = null;
  if (path && path !== ':memory:') {
    try {
      const s = await statfs(dirname(path));
      diskTotal = s.blocks * s.bsize;
      diskFree = s.bavail * s.bsize;
    } catch {
      // Not every platform/filesystem reports this.
    }
  }
  const memory = !path || path === ':memory:';
  return {
    dbPath: path,
    dbSizeBytes: memory ? 0 : fileSize(path) + fileSize(`${path}-wal`),
    rawRows: count('history_raw'),
    rollupRows: count('history_5m'),
    totalsDays: days.n,
    firstTotalsDay: days.first,
    oldest: oldest === null ? null : oldest * 1000,
    rawRetentionDays: settings.get('history.raw_retention_days'),
    diskTotal,
    diskFree,
    restorePending: !memory && existsSync(`${path}.restore`),
  };
}

/** Writes a consistent copy of the live database to a temp file and returns its path. */
export function createBackup(): string {
  const path = dbPath();
  if (!path || path === ':memory:') throw new Error('The database is in memory; nothing to back up');
  const target = join(dirname(path), `.backup-${process.pid}-${Date.now()}.db`);
  db().prepare('VACUUM INTO ?').run(target);
  return target;
}

/** Checks that a file is a SQLite database with Sunroost's tables. Throws with a readable reason. */
export function validateBackup(file: string) {
  const head = readFileSync(file).subarray(0, 16).toString('latin1');
  if (head !== 'SQLite format 3\0') throw new Error('Not a SQLite database file');
  let d: DatabaseSync | null = null;
  try {
    d = new DatabaseSync(file);
    const check = d.prepare('PRAGMA quick_check').get() as Record<string, string>;
    if (Object.values(check)[0] !== 'ok') throw new Error('The database file is damaged');
    const tables = new Set((d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new Error(`Not a Sunroost backup (missing tables: ${missing.join(', ')})`);
  } finally {
    d?.close();
  }
}

/** Validates an uploaded database and stages it to replace the live one on the next start. */
export function stageRestore(data: Buffer) {
  const path = dbPath();
  if (!path || path === ':memory:') throw new Error('The database is in memory; restore is not possible');
  const tmp = `${path}.restore.tmp`;
  writeFileSync(tmp, data);
  try {
    validateBackup(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    for (const s of ['-wal', '-shm', '-journal']) rmSync(tmp + s, { force: true });
    throw err;
  }
  for (const s of ['-wal', '-shm', '-journal']) rmSync(tmp + s, { force: true });
  renameSync(tmp, `${path}.restore`);
  l.info(`Backup uploaded (${(data.length / 1048576).toFixed(1)} MB) and staged. It replaces the current database when the service restarts.`);
}

/**
 * Swaps in a staged restore. Called at stats start, before other subsystems touch the database.
 * The previous database is kept as `<db>.before-restore`.
 */
export function applyStagedRestore(): boolean {
  const path = dbPath();
  if (!path || path === ':memory:' || !existsSync(`${path}.restore`)) return false;
  try {
    closeDb(); // checkpoints and removes the WAL
    for (const s of ['-wal', '-shm']) rmSync(path + s, { force: true });
    if (existsSync(path)) renameSync(path, `${path}.before-restore`);
    renameSync(`${path}.restore`, path);
    l.info(`Restored the database from the uploaded backup. The previous one is kept as ${path}.before-restore.`);
  } catch (err) {
    l.error(`Restore failed: ${(err as Error).message}`);
  }
  openDb(path);
  settings.init();
  return true;
}
