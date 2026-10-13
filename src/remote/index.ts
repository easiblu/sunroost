/**
 * Remote access on the user's own domain.
 *
 * - `domain`: the user adds a DNS A record; we open router ports via UPnP, get a Let's Encrypt
 *   certificate and terminate HTTPS ourselves (see ./domain/).
 * - `cloudflare`: runs `cloudflared tunnel run` as a supervised child process. The user creates a
 *   tunnel in the Cloudflare dashboard, routes their hostname to http://localhost:<port>, and pastes
 *   the tunnel token here. No router ports are opened and Cloudflare terminates HTTPS.
 * - `proxy`: the user runs their own reverse proxy (Caddy, nginx) for the domain; we only record the
 *   domain and trust forwarded headers from localhost.
 *
 * Going public requires a local password (enforced in the API and here at start-up).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { logger } from '../core/log.ts';
import { settings, type SettingKey } from '../core/settings.ts';
import * as own from './domain/index.ts';

const log = logger('remote');
const MAX_BACKOFF_MS = 5 * 60_000;
const KEYS: SettingKey[] = [
  'remote.mode', 'remote.cloudflare_token', 'remote.cloudflared_path', 'auth.password_hash',
  'remote.domain', 'remote.https_port', 'remote.upnp', 'remote.acme_email', 'remote.ddns_provider', 'remote.ddns_token',
];

let httpPort = 8080;
let dataDir = 'data';
let child: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let failures = 0;
let stopping = false;
const connections = new Map<string, string>();
let lastError: string | null = null;
let startedAt = 0;

export interface RemoteStatus {
  mode: 'off' | 'domain' | 'cloudflare' | 'proxy';
  domain: string;
  publicUrl: string | null;
  tokenSet: boolean;
  passwordSet: boolean;
  binary: string | null;
  running: boolean;
  /** Edge locations the tunnel is connected to, e.g. ["fra08", "ams01"]. */
  connections: string[];
  lastError: string | null;
  since: number | null;
  /** Own-domain mode checks (all null/idle in the other modes). */
  domainMode: own.DomainStatus;
}

/** Validates a Cloudflare Tunnel token: base64 JSON with account (a), tunnel id (t) and secret (s). */
export function isTunnelToken(token: string): boolean {
  try {
    const json = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8'));
    return typeof json.a === 'string' && typeof json.t === 'string' && typeof json.s === 'string';
  } catch {
    return false;
  }
}

/** "https://Solar.Example.com/x" → "solar.example.com"; returns '' when it isn't a hostname. */
export function normalizeDomain(input: string): string {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : '';
}

export function findCloudflared(): string | null {
  const configured = settings.get('remote.cloudflared_path');
  if (configured) return existsSync(configured) ? configured : null;
  const dirs = (process.env.PATH ?? '').split(delimiter).concat(['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']);
  for (const dir of dirs) {
    const p = join(dir, 'cloudflared');
    if (existsSync(p)) return p;
  }
  return null;
}

export function status(): RemoteStatus {
  const mode = settings.get('remote.mode');
  const domain = settings.get('remote.domain');
  return {
    mode,
    domain,
    publicUrl: mode !== 'off' && domain ? `https://${domain}` : null,
    tokenSet: Boolean(settings.get('remote.cloudflare_token')),
    passwordSet: Boolean(settings.get('auth.password_hash')),
    binary: findCloudflared(),
    running: Boolean(child),
    connections: [...connections.values()],
    lastError,
    since: child ? startedAt : null,
    domainMode: own.status(),
  };
}

function launch() {
  restartTimer = null;
  if (stopping || child) return;
  if (settings.get('remote.mode') !== 'cloudflare') return;
  if (!settings.get('auth.password_hash')) {
    lastError = 'Set a local password before enabling remote access.';
    log.warn(`Tunnel not started: ${lastError}`);
    return;
  }
  const token = settings.get('remote.cloudflare_token');
  if (!token) {
    lastError = 'No tunnel token configured.';
    return;
  }
  const bin = findCloudflared();
  if (!bin) {
    lastError = 'cloudflared is not installed. Run deploy/install.sh again or install it from Cloudflare.';
    log.warn(lastError);
    return;
  }

  lastError = null;
  connections.clear();
  startedAt = Date.now();
  // Token via environment, not argv, so it doesn't show up in `ps`.
  // The hostname → http://localhost:<port> route lives in the tunnel's dashboard config (token tunnels).
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], {
    env: { ...process.env, TUNNEL_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  log.info('Starting Cloudflare Tunnel.');

  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', (err) => {
    lastError = err.message;
    log.error(`cloudflared: ${err.message}`);
  });
  proc.on('exit', (code, signal) => {
    child = null;
    connections.clear();
    if (stopping) return;
    failures++;
    lastError ??= `cloudflared exited (${signal ?? `code ${code}`})`;
    const delay = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(failures - 1, 6));
    log.warn(`Tunnel stopped: ${lastError}. Retrying in ${Math.round(delay / 1000)} s.`);
    restartTimer = setTimeout(launch, delay);
  });
}

function handleLine(line: string) {
  const index = /connIndex=(\d+)/.exec(line)?.[1];
  if (/Registered tunnel connection/i.test(line) && index !== undefined) {
    const location = /location=(\S+)/.exec(line)?.[1] ?? 'edge';
    connections.set(index, location);
    failures = 0;
    lastError = null;
    log.info(`Tunnel connected (${location}).`);
  } else if (/Unregistered tunnel connection|Connection terminated|Lost connection/i.test(line) && index !== undefined) {
    connections.delete(index);
  } else if (/\bERR\b/.test(line)) {
    // Keep the human part of cloudflared's error, without timestamps or the token.
    lastError = line.replace(/^\S+\s+ERR\s+/, '').replace(/[A-Za-z0-9+/=]{60,}/g, '…').slice(0, 300);
    if (/Unauthorized|invalid token|tunnel credentials/i.test(line)) log.error(`Tunnel rejected the token: ${lastError}`);
  }
}

async function halt() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  if (!proc) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill('SIGTERM');
  });
  child = null;
  connections.clear();
  log.info('Tunnel stopped.');
}

/** Own-domain options from settings, or null when that mode shouldn't run. */
function domainOptions(): own.DomainOptions | null {
  const domain = settings.get('remote.domain');
  if (settings.get('remote.mode') !== 'domain' || !domain) return null;
  if (!settings.get('auth.password_hash')) {
    log.warn('Own domain mode not started: set a local password first.');
    return null;
  }
  return {
    domain,
    httpPort,
    httpsPort: Number(settings.get('remote.https_port')) || 443,
    upnp: settings.get('remote.upnp') !== false,
    email: settings.get('remote.acme_email'),
    dataDir,
    ddnsProvider: settings.get('remote.ddns_provider'),
    ddnsToken: settings.get('remote.ddns_token'),
  };
}

/** Re-applies the current settings: start, restart or stop the tunnel and the own-domain mode. */
export async function apply() {
  // The tunnel only restarts when its own settings change (or it should stop).
  if (settings.get('remote.mode') !== 'cloudflare' || tunnelDirty) {
    tunnelDirty = false;
    stopping = true;
    await halt();
    stopping = false;
    failures = 0;
    lastError = null;
    launch();
  }
  await own.sync(domainOptions()).catch((err) => log.error(`Own domain mode: ${(err as Error).message}`));
}

/** Re-runs the own-domain checks now (DNS, UPnP, certificate). */
export const retryDomain = () => own.retry();

let applyTimer: NodeJS.Timeout | null = null;
let tunnelDirty = false;
const TUNNEL_KEYS = new Set(['remote.mode', 'remote.cloudflare_token', 'remote.cloudflared_path', 'auth.password_hash']);
function onSettingChange(key: string) {
  if (!KEYS.includes(key as SettingKey)) return;
  if (TUNNEL_KEYS.has(key)) tunnelDirty = true;
  // One save can touch several keys; restart once.
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => void apply(), 300);
}

export async function start(port = 8080, dir = 'data') {
  httpPort = port;
  dataDir = dir;
  stopping = false;
  settings.on('change', onSettingChange);
  launch();
  await own.sync(domainOptions()).catch((err) => log.error(`Own domain mode: ${(err as Error).message}`));
}

/** Port the tunnel should route to (shown in setup instructions). */
export const localPort = () => httpPort;

export async function stop() {
  if (applyTimer) clearTimeout(applyTimer);
  settings.off('change', onSettingChange);
  stopping = true;
  await halt();
  await own.stop();
}
