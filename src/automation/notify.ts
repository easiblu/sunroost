/**
 * Notification channels for rule actions: the in-app feed (SQLite, newest 200 kept), ntfy
 * (POST the message to the topic URL with a Title header) and a generic webhook (POST JSON
 * `{title, message, ts}`). Remote sends time out after 10 s. URLs may carry tokens, so logs and
 * errors only ever show the URL's origin.
 */
import { EventEmitter } from 'node:events';
import { db } from '../core/db.ts';
import type { NotifyChannel } from './rules.ts';

export const FEED_MAX = 200;
export const SEND_TIMEOUT_MS = 10_000;

export interface FeedItem {
  id: number;
  ts: number;
  title: string;
  message: string;
  read: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** 'notification'(FeedItem) whenever the app feed gets an entry. */
export const events = new EventEmitter();

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** For tests: replace the HTTP client. */
export function setFetch(f: Fetch | null) {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

export function initNotifications() {
  db().exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
  )`);
}

interface Row {
  id: number;
  ts: number;
  title: string;
  message: string;
  read: number;
}

export function addToFeed(title: string, message: string, now = Date.now()): FeedItem {
  const res = db().prepare(`INSERT INTO notifications (ts, title, message, read) VALUES (?, ?, ?, 0)`).run(now, title, message);
  db().prepare(`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)`).run(FEED_MAX);
  const item = { id: Number(res.lastInsertRowid), ts: now, title, message, read: false };
  events.emit('notification', item);
  return item;
}

export function feed(limit = 50): { items: FeedItem[]; unread: number } {
  const n = Math.min(Math.max(1, Math.floor(limit) || 50), FEED_MAX);
  const rows = db().prepare(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`).all(n) as unknown as Row[];
  return { items: rows.map((r) => ({ ...r, read: Boolean(r.read) })), unread: unreadCount() };
}

export function unreadCount(): number {
  return Number((db().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE read = 0`).get() as { n: number }).n);
}

export function markAllRead() {
  db().prepare(`UPDATE notifications SET read = 1 WHERE read = 0`).run();
}

/** "https://ntfy.sh/secret-topic?auth=x" → "https://ntfy.sh". */
export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an invalid URL';
  }
}

function validUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** HTTP headers are Latin-1; non-ASCII titles use RFC 2047 encoding, which ntfy understands. */
function headerText(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

async function post(url: string, init: RequestInit): Promise<SendResult> {
  try {
    const res = await fetchImpl(url, { ...init, method: 'POST', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `${safeOrigin(url)} answered HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out after 10 s' : e.message;
    return { ok: false, error: `Sending to ${safeOrigin(url)} failed: ${why}` };
  }
}

export interface ChannelUrls {
  ntfy: string;
  webhook: string;
}

export async function send(channel: NotifyChannel, title: string, message: string, urls: ChannelUrls, now = Date.now()): Promise<SendResult> {
  if (channel === 'app') {
    addToFeed(title, message, now);
    return { ok: true };
  }
  const url = (channel === 'ntfy' ? urls.ntfy : urls.webhook).trim();
  if (!url) return { ok: false, error: `No ${channel} URL configured (Configuration › Notifications).` };
  if (!validUrl(url)) return { ok: false, error: `The ${channel} URL is not a valid http(s) URL.` };
  if (channel === 'ntfy') {
    return post(url, { headers: { Title: headerText(title), 'Content-Type': 'text/plain; charset=utf-8' }, body: message });
  }
  return post(url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message, ts: now }) });
}
