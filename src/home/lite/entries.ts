/**
 * Lite engine entries: one row per configured device/hub/account. Metadata in `home_lite_entries`;
 * the entry's data (addresses, passwords, device keys) sealed in the secrets store.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../core/db.ts';
import * as secrets from '../../core/secrets.ts';
import type { LiteEntry } from './types.ts';

const secretKey = (id: string) => `lite.entry.${id}`;

export function init() {
  db().exec(`CREATE TABLE IF NOT EXISTS home_lite_entries (
    id TEXT PRIMARY KEY, driver TEXT NOT NULL, title TEXT NOT NULL, unique_id TEXT, created INTEGER NOT NULL
  )`);
  db().exec(`CREATE TABLE IF NOT EXISTS home_lite_ignored (driver TEXT NOT NULL, unique_id TEXT NOT NULL, PRIMARY KEY (driver, unique_id))`);
}

export function list(driver?: string): LiteEntry[] {
  const rows = db().prepare(`SELECT id, driver, title, unique_id, created FROM home_lite_entries ORDER BY created`).all() as {
    id: string; driver: string; title: string; unique_id: string | null; created: number;
  }[];
  return rows
    .filter((r) => !driver || r.driver === driver)
    .map((r) => ({
      id: r.id, driver: r.driver, title: r.title, uniqueId: r.unique_id, createdAt: r.created,
      data: JSON.parse(secrets.get(secretKey(r.id)) ?? '{}') as Record<string, unknown>,
    }));
}

export const get = (id: string) => list().find((e) => e.id === id) ?? null;

export function findUnique(driver: string, uniqueId: string) {
  return list(driver).find((e) => e.uniqueId === uniqueId) ?? null;
}

export function add(driver: string, title: string, uniqueId: string | null, data: Record<string, unknown>, now = Date.now()): LiteEntry {
  const id = randomBytes(8).toString('hex');
  db().prepare(`INSERT INTO home_lite_entries (id, driver, title, unique_id, created) VALUES (?, ?, ?, ?, ?)`).run(id, driver, title, uniqueId, now);
  secrets.set(secretKey(id), JSON.stringify(data));
  if (uniqueId) unignore(driver, uniqueId);
  return { id, driver, title, uniqueId, data, createdAt: now };
}

export function update(id: string, data: Record<string, unknown>, title?: string) {
  secrets.set(secretKey(id), JSON.stringify(data));
  if (title) db().prepare(`UPDATE home_lite_entries SET title = ? WHERE id = ?`).run(title, id);
}

export function remove(id: string) {
  db().prepare(`DELETE FROM home_lite_entries WHERE id = ?`).run(id);
  secrets.set(secretKey(id), null);
}

/** Dismissed discoveries stay dismissed. */
export function ignore(driver: string, uniqueId: string) {
  db().prepare(`INSERT OR IGNORE INTO home_lite_ignored (driver, unique_id) VALUES (?, ?)`).run(driver, uniqueId);
}

export function unignore(driver: string, uniqueId: string) {
  db().prepare(`DELETE FROM home_lite_ignored WHERE driver = ? AND unique_id = ?`).run(driver, uniqueId);
}

export function isIgnored(driver: string, uniqueId: string) {
  return !!db().prepare(`SELECT 1 FROM home_lite_ignored WHERE driver = ? AND unique_id = ?`).get(driver, uniqueId);
}
