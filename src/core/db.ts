/**
 * The single SQLite database. Each subsystem creates its own tables with
 * `CREATE TABLE IF NOT EXISTS` when it starts, so there is no central migration list.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let instance: DatabaseSync | null = null;
let instancePath = '';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  instance = new DatabaseSync(path);
  instancePath = path;
  instance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  return instance;
}

export function db(): DatabaseSync {
  if (!instance) throw new Error('Database not opened');
  return instance;
}

export function dbPath() {
  return instancePath;
}

export function closeDb() {
  instance?.close();
  instance = null;
}
