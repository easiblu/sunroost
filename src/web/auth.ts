/**
 * Optional local password. With no password set the UI is open on the LAN;
 * once set, every API call and the WebSocket need a session cookie. A password is mandatory
 * before remote access can be turned on.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';
import { isLanAddress } from '../remote/domain/net.ts';

const COOKIE = 'solar_session';
const SESSION_DAYS = 30;
const log = logger('system');

function secret() {
  let s = settings.get('auth.secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    settings.set('auth.secret', s);
  }
  return s;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function checkPassword(password: string) {
  const stored = settings.get('auth.password_hash');
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function passwordRequired() {
  return Boolean(settings.get('auth.password_hash'));
}

function sign(payload: string) {
  // Includes the password hash, so changing the password signs everyone out.
  return createHmac('sha256', secret() + settings.get('auth.password_hash')).update(payload).digest('base64url');
}

/** Secure is added when the request arrived over HTTPS (directly or via a trusted local proxy/tunnel). */
export function sessionCookie(req: FastifyRequest) {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const value = `${expires}.${sign(String(expires))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.protocol === 'https' ? '; Secure' : ''}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function isAuthenticated(req: FastifyRequest) {
  if (!passwordRequired()) return true;
  const cookie = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!cookie) return false;
  const [expires, sig] = cookie.slice(COOKIE.length + 1).split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = sign(expires);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Fastify preHandler for protected routes. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!isAuthenticated(req)) return reply.code(401).send({ error: 'Sign in required' });
}

// ---------- Brute-force protection ----------

const FREE_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

/** Milliseconds this client must wait before trying again (0 = allowed). */
export function loginLockout(ip: string): number {
  const a = attempts.get(ip);
  if (!a) return 0;
  if (Date.now() - a.first > WINDOW_MS && a.lockedUntil < Date.now()) {
    attempts.delete(ip);
    return 0;
  }
  return Math.max(0, a.lockedUntil - Date.now());
}

export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip) ?? { count: 0, first: now, lockedUntil: 0 };
  a.count++;
  if (a.count > FREE_ATTEMPTS) {
    // 30 s, 1 min, 2 min … capped at an hour.
    a.lockedUntil = now + Math.min(MAX_LOCK_MS, 30_000 * 2 ** (a.count - FREE_ATTEMPTS - 1));
    if (a.count === FREE_ATTEMPTS + 1) log.warn(`Repeated failed sign-ins from ${ip}; slowing down further attempts.`);
  }
  attempts.set(ip, a);
  // Bound memory if someone sprays from many addresses.
  if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!);
  trackForBan(ip, now);
}

export function recordLoginSuccess(ip: string) {
  attempts.delete(ip);
  hourly.delete(ip);
}

// ---------- 24 h ban after sustained guessing ----------

const BAN_AFTER = 20;
const BAN_WINDOW_MS = 60 * 60_000;
const BAN_MS = 24 * 60 * 60_000;
/** Failure timestamps in the last hour, per address. */
const hourly = new Map<string, number[]>();
const bans = new Map<string, number>();

function trackForBan(ip: string, now: number) {
  const recent = (hourly.get(ip) ?? []).filter((t) => now - t < BAN_WINDOW_MS);
  recent.push(now);
  hourly.set(ip, recent);
  if (hourly.size > 10_000) hourly.delete(hourly.keys().next().value!);
  if (recent.length >= BAN_AFTER && !isBanned(ip, now)) {
    bans.set(ip, now + BAN_MS);
    hourly.delete(ip);
    if (bans.size > 100_000) bans.delete(bans.keys().next().value!);
    log.warn(`Blocked ${ip} for 24 hours after ${BAN_AFTER} failed sign-ins within an hour${isLanAddress(ip) ? ' (local network addresses stay allowed)' : ''}.`);
  }
}

/** A sign-in attempt refused by the rate limit still counts towards the ban. */
export function recordLockedAttempt(ip: string) {
  trackForBan(ip, Date.now());
}

export function isBanned(ip: string, now = Date.now()): boolean {
  const until = bans.get(ip);
  if (until === undefined) return false;
  if (until <= now) {
    bans.delete(ip);
    return false;
  }
  return true;
}

/**
 * Whether to refuse every request from this address. Local-network addresses are never blocked,
 * so the owner can't lock themselves out at home.
 */
export function isBlocked(ip: string, now = Date.now()): boolean {
  return isBanned(ip, now) && !isLanAddress(ip);
}

/** For tests. */
export function resetBans() {
  bans.clear();
  hourly.clear();
  attempts.clear();
}
