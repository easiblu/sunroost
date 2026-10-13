/**
 * Encrypted storage for credentials (the Home Assistant token, device keys). Values are sealed with
 * AES-256-GCM using a key kept in <dataDir>/secret.key (mode 0600), so a copy of the database alone
 * reveals nothing. Secrets are never returned by the API.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.ts';
import { logger } from './log.ts';

const log = logger('system');
let key: Buffer | null = null;

/** `dataDir` null keeps the key in memory only (tests). */
export function init(dataDir: string | null) {
  db().exec(`CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  if (!dataDir) {
    key = randomBytes(32);
    return;
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) {
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  } else {
    key = randomBytes(32);
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  }
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key!, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
    const d = createDecipheriv('aes-256-gcm', key!, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function get(name: string): string | null {
  if (!key) throw new Error('Secrets not initialised');
  const row = db().prepare(`SELECT value FROM secrets WHERE key = ?`).get(name) as { value: string } | undefined;
  if (!row) return null;
  const v = open(row.value);
  if (v === null) log.warn(`Secret "${name}" can't be decrypted (was secret.key replaced?).`);
  return v;
}

/** `null` deletes it. */
export function set(name: string, value: string | null) {
  if (!key) throw new Error('Secrets not initialised');
  if (value === null) db().prepare(`DELETE FROM secrets WHERE key = ?`).run(name);
  else db().prepare(`INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)`).run(name, seal(value));
}

export const has = (name: string) => get(name) !== null;
