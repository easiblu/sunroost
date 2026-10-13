/**
 * HTTP for Shelly devices: JSON requests with Gen1 basic auth or Gen2+ digest auth (RFC 7616,
 * SHA-256, user "admin", realm = device id), plus the in-band digest Gen2+ expects on its WebSocket.
 */
import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Credentials {
  kind: 'basic' | 'digest';
  username: string;
  password: string;
}

export class ShellyHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** `Digest qop="auth", realm="shellyplus1-…", nonce="…", algorithm=SHA-256` → its parameters. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, '');
  for (const m of body.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** Authorization header answering a digest challenge. */
export function digestAuthorization(method: string, uri: string, ch: Record<string, string>, c: Credentials, cnonce = randomBytes(8).toString('hex')) {
  const nc = '00000001';
  const ha1 = sha256(`${c.username}:${ch.realm}:${c.password}`);
  const ha2 = sha256(`${method}:${uri}`);
  const response = sha256(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${c.username}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}", algorithm=SHA-256, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
}

/**
 * The `auth` object of a Gen2+ WebSocket request, answering the 401 error's
 * `{ auth_type, nonce, nc, realm, algorithm }`. Shelly hashes a fixed "dummy_method:dummy_uri" as HA2.
 */
export function wsAuth(ch: { realm: string; nonce: number | string }, password: string, cnonce = Math.floor(Math.random() * 1e9)) {
  const ha1 = sha256(`admin:${ch.realm}:${password}`);
  const ha2 = sha256('dummy_method:dummy_uri');
  return {
    realm: ch.realm, username: 'admin', nonce: ch.nonce, cnonce, algorithm: 'SHA-256',
    response: sha256(`${ha1}:${ch.nonce}:1:${cnonce}:auth:${ha2}`),
  };
}

/**
 * One JSON request to `http://<host><path>`. Basic credentials are sent up front; digest ones
 * answer the 401 challenge. Throws ShellyHttpError (401 = wrong or missing password) or a network error.
 */
export async function request(
  host: string, path: string, opts: { method?: string; body?: unknown; auth?: Credentials | null; timeoutMs?: number } = {},
): Promise<any> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth?.kind === 'basic') headers.authorization = `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}`;
  const send = () =>
    fetch(url, {
      method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  let res = await send();
  if (res.status === 401 && opts.auth?.kind === 'digest') {
    const ch = parseChallenge(res.headers.get('www-authenticate') ?? '');
    await res.arrayBuffer().catch(() => {});
    if (ch.nonce) {
      headers.authorization = digestAuthorization(method, path, ch, opts.auth);
      res = await send();
    }
  }
  const text = await res.text();
  if (res.status === 401) throw new ShellyHttpError(401, opts.auth ? 'Wrong password' : 'The device needs a password');
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ShellyHttpError(res.status, typeof data === 'object' && data?.message ? data.message : `HTTP ${res.status}`);
  return data;
}

/** What `GET /shelly` says about a device (no auth needed on either generation). */
export interface Probe {
  gen: number;
  mac: string;
  model: string;
  name: string | null;
  id: string | null;
  fw: string | null;
  auth: boolean;
}

export const normMac = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

export async function probe(host: string, timeoutMs = 5000): Promise<Probe | null> {
  try {
    const j = await request(host, '/shelly', { timeoutMs });
    if (!j || typeof j !== 'object') return null;
    if (Number(j.gen) >= 2) {
      return { gen: Number(j.gen), mac: normMac(j.mac), model: String(j.model ?? j.app ?? 'Shelly'), name: j.name ?? null, id: j.id ?? null, fw: j.ver ?? j.fw_id ?? null, auth: !!j.auth_en };
    }
    if (j.type) return { gen: 1, mac: normMac(j.mac), model: String(j.type), name: null, id: null, fw: j.fw ?? null, auth: !!j.auth };
    return null;
  } catch {
    return null;
  }
}
