/**
 * "Own domain" remote access: the user adds one A record; this module does the rest.
 *
 *   public IP (5 min) ──▶ dynamic DNS update ──▶ DNS check (public resolvers)
 *   UPnP: router 80 → <LAN IP>:<http port>, 443 → <LAN IP>:<https port> (lease 1 h, renewed 30 min)
 *   DNS ok + port 80 self-test ──▶ Let's Encrypt (HTTP-01 on the main app) ──▶ HTTPS proxy ──▶ reachability (30 min)
 *
 * Everything is best effort and reported in status(); nothing here throws into the app.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:https';
import { logger } from '../../core/log.ts';
import { testReachability } from '../reach.ts';
import { backoffDelay, CertStore, getChallenge, issueCertificate, needsRenewal, removeChallenge, setChallenge, type CertInfo } from './acme.ts';
import { updateDdns, type DdnsProvider } from './ddns.ts';
import { checkDns, type DnsResult } from './dns.ts';
import { detectCgnat, splitDomain } from './net.ts';
import { createHttpsProxy, listen } from './proxy.ts';
import { detectPublicIp } from './publicip.ts';
import {
  addPortMapping, deletePortMapping, discoverGateway, getExternalIp, lanIpByRoute, lanIpFor, onlyPermanentLeases, type Gateway,
} from './upnp.ts';

export { getChallenge };

const log = logger('remote');
const MIN = 60_000;
const IP_EVERY = 5 * MIN;
const UPNP_RENEW = 30 * MIN;
const UPNP_RETRY = 5 * MIN;
const LEASE_S = 3600;
const REACH_EVERY = 30 * MIN;
const RENEW_CHECK = 24 * 60 * MIN;

export interface DomainOptions {
  domain: string;
  httpPort: number;
  httpsPort: number;
  upnp: boolean;
  email: string;
  dataDir: string;
  ddnsProvider: DdnsProvider;
  ddnsToken: string;
}

interface Rule {
  external: number;
  internal: number;
  lanIp: string | null;
  ok: boolean;
  error: string | null;
}

type UpnpState = 'off' | 'searching' | 'not_found' | 'found' | 'mapped' | 'failed';
type CertState = 'none' | 'waiting' | 'ordering' | 'ok' | 'error';

const fresh = () => ({
  publicIp: { ip: null as string | null, source: null as string | null, checkedAt: null as number | null, changedAt: null as number | null, error: null as string | null },
  dns: { state: 'unknown', seen: [], note: null, error: null, checkedAt: null } as DnsResult & { checkedAt: number | null },
  upnp: { state: 'off' as UpnpState, router: null as string | null, error: null as string | null, lanIp: null as string | null, externalIp: null as string | null, lease: LEASE_S, rules: [] as Rule[] },
  cert: { state: 'none' as CertState, expires: null as number | null, issuer: null as string | null, error: null as string | null, nextAttemptAt: null as number | null, staging: false },
  portCheck: { state: 'unknown' as 'unknown' | 'ok' | 'failed', error: null as string | null },
  https: { listening: false, port: 0, error: null as string | null },
  reachable: { state: 'unknown' as 'unknown' | 'checking' | 'ok' | 'failed', checkedAt: null as number | null, ms: null as number | null, error: null as string | null },
  ddns: { provider: 'none' as DdnsProvider, state: 'off' as 'off' | 'pending' | 'ok' | 'error', lastUpdate: null as number | null, ip: null as string | null, error: null as string | null },
});

let opts: DomainOptions | null = null;
let s = fresh();
/** Bumped on every stop; async work started under an older generation drops its results. */
let gen = 0;
const timers = new Map<string, NodeJS.Timeout>();
let gateway: Gateway | null = null;
let server: Server | null = null;
let store: CertStore | null = null;
let current: CertInfo | null = null;
let ordering = false;

function schedule(name: string, ms: number, fn: () => unknown) {
  clearTimeout(timers.get(name));
  const g = gen;
  timers.set(name, setTimeout(() => g === gen && void fn(), ms).unref());
}

const alive = (g: number) => g === gen && opts !== null;

// ---------- Public IP + dynamic DNS ----------

async function refreshIp() {
  const g = gen;
  try {
    const { ip, source } = await detectPublicIp();
    if (!alive(g)) return;
    const prev = s.publicIp.ip;
    s.publicIp = { ...s.publicIp, ip, source, checkedAt: Date.now(), error: null };
    if (prev !== ip) {
      if (prev) {
        s.publicIp.changedAt = Date.now();
        log.info(`Public IP changed from ${prev} to ${ip}.`);
      } else log.info(`Public IP is ${ip}.`);
      await ddnsUpdate();
      void dnsCheck();
    }
  } catch (err) {
    if (!alive(g)) return;
    s.publicIp = { ...s.publicIp, checkedAt: Date.now(), error: (err as Error).message };
  }
  schedule('ip', IP_EVERY, refreshIp);
}

async function ddnsUpdate() {
  if (!opts) return;
  const { ddnsProvider: provider, ddnsToken: token, domain } = opts;
  s.ddns.provider = provider;
  if (provider === 'none') {
    s.ddns = { ...s.ddns, state: 'off', error: null };
    return;
  }
  const ip = s.publicIp.ip;
  if (!ip) return;
  const g = gen;
  s.ddns.state = 'pending';
  try {
    const result = await updateDdns(provider, token, domain, ip);
    if (!alive(g)) return;
    s.ddns = { ...s.ddns, state: 'ok', lastUpdate: Date.now(), ip, error: null };
    log.info(`Dynamic DNS (${provider}): ${domain} → ${ip} (${result}).`);
  } catch (err) {
    if (!alive(g)) return;
    s.ddns = { ...s.ddns, state: 'error', error: (err as Error).message };
    log.warn(`Dynamic DNS (${provider}) failed: ${(err as Error).message}`);
    schedule('ddns', 10 * MIN, ddnsUpdate);
  }
}

// ---------- DNS ----------

let dnsBusy = false;
async function dnsCheck() {
  if (!opts || dnsBusy) return;
  const g = gen;
  dnsBusy = true;
  const result = await checkDns(opts.domain, s.publicIp.ip).finally(() => (dnsBusy = false));
  if (!alive(g)) return;
  const was = s.dns.state;
  s.dns = { ...result, checkedAt: Date.now() };
  if (result.state === 'ok' && was !== 'ok') {
    log.info(`DNS: ${opts.domain} points at this connection (${s.publicIp.ip}).`);
    void maybeOrder();
  }
  // Poll quickly while the user is adding the record, slowly once it's right.
  schedule('dns', result.state === 'ok' ? 10 * MIN : 20_000, dnsCheck);
}

// ---------- UPnP ----------

async function upnpMap() {
  if (!opts) return;
  const g = gen;
  if (!opts.upnp) {
    const lanIp = s.upnp.lanIp ?? (await lanIpByRoute('1.1.1.1'));
    if (alive(g)) s.upnp = { ...s.upnp, state: 'off', error: null, lanIp, rules: rulesFor(lanIp) };
    return;
  }
  s.upnp.state = 'searching';
  const gw = await discoverGateway().catch(() => null);
  if (!alive(g)) return;
  if (!gw) {
    const lanIp = s.upnp.lanIp ?? (await lanIpByRoute('1.1.1.1'));
    if (!alive(g)) return;
    s.upnp = { ...s.upnp, state: 'not_found', router: null, lanIp, rules: rulesFor(lanIp), error: 'No UPnP router answered. Forward the ports by hand, or turn on UPnP in the router.' };
    schedule('upnp', UPNP_RETRY, upnpMap);
    return;
  }
  gateway = gw;
  const routerIp = new URL(gw.location).hostname;
  const lanIp = lanIpFor(routerIp) ?? (await lanIpByRoute(routerIp));
  const externalIp = await getExternalIp(gw).catch(() => null);
  if (!alive(g)) return;
  s.upnp = { ...s.upnp, router: gw.name, lanIp, externalIp, error: null };
  const rules = rulesFor(lanIp);

  // Read-only mode for development machines: discover, but never touch the router's mappings.
  if (process.env.SOLAR_UPNP_DRYRUN === '1' || !lanIp) {
    s.upnp = { ...s.upnp, state: 'found', rules, error: lanIp ? null : "Couldn't tell this device's address on the router's network." };
    return;
  }

  for (const rule of rules) {
    try {
      try {
        await addPortMapping(gw, { external: rule.external, internal: rule.internal, lanIp }, s.upnp.lease);
      } catch (err) {
        if (!onlyPermanentLeases(err) || s.upnp.lease === 0) throw err;
        s.upnp.lease = 0;
        log.info('Router only accepts permanent port mappings; using lease 0.');
        await addPortMapping(gw, { external: rule.external, internal: rule.internal, lanIp }, 0);
      }
      rule.ok = true;
    } catch (err) {
      rule.error = (err as Error).message;
    }
  }
  if (!alive(g)) return;
  const failed = rules.filter((r) => !r.ok);
  const wasMapped = s.upnp.state === 'mapped';
  s.upnp = {
    ...s.upnp,
    rules,
    state: failed.length ? 'failed' : 'mapped',
    error: failed.length ? `The router refused port ${failed.map((r) => r.external).join(' and ')}: ${failed[0].error}` : null,
  };
  if (failed.length) log.warn(`UPnP on ${gw.name}: ${s.upnp.error}`);
  else if (!wasMapped) log.info(`UPnP: ${gw.name} forwards ports 80 and 443 to ${lanIp}.`);
  schedule('upnp', failed.length ? UPNP_RETRY : UPNP_RENEW, upnpMap);
}

function rulesFor(lanIp: string | null): Rule[] {
  if (!opts) return [];
  return [
    { external: 80, internal: opts.httpPort, lanIp, ok: false, error: null },
    { external: 443, internal: opts.httpsPort, lanIp, ok: false, error: null },
  ];
}

async function upnpRelease() {
  const gw = gateway;
  const mapped = s.upnp.rules.filter((r) => r.ok);
  gateway = null;
  if (!gw || !mapped.length || process.env.SOLAR_UPNP_DRYRUN === '1') return;
  await Promise.all(mapped.map((r) => deletePortMapping(gw, r.external).catch(() => {})));
  log.info(`UPnP: removed the port mappings on ${gw.name}.`);
}

// ---------- Certificate + HTTPS ----------

/** Fetches http://<domain>/.well-known/acme-challenge/selftest-… and checks this device answered. */
async function portSelfTest(domain: string): Promise<string | null> {
  const token = `selftest-${randomBytes(12).toString('hex')}`;
  const value = randomBytes(16).toString('hex');
  setChallenge(token, value, 60_000);
  try {
    const res = await fetch(`http://${domain}/.well-known/acme-challenge/${token}`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const body = await res.text();
    return res.ok && body.trim() === value ? null : `http://${domain} answered HTTP ${res.status}, but not from this device.`;
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return `Port 80 on ${domain} isn't reachable from here (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ?? e.message}).`;
  } finally {
    removeChallenge(token);
  }
}

function showCert(info: CertInfo) {
  s.cert = { ...s.cert, state: 'ok', expires: info.expires, issuer: info.issuer, error: null, nextAttemptAt: null };
}

async function maybeOrder(force = false) {
  if (!opts || !store || ordering) return;
  const g = gen;
  const { domain } = opts;
  if (!needsRenewal(current, domain)) {
    showCert(current!);
    return;
  }
  if (s.dns.state !== 'ok') {
    if (!current) s.cert = { ...s.cert, state: 'waiting', error: null };
    return;
  }
  const backoff = store.loadBackoff();
  if (!force && backoff.nextAttemptAt > Date.now()) {
    s.cert = { ...s.cert, state: current ? 'ok' : 'error', error: backoff.lastError, nextAttemptAt: backoff.nextAttemptAt };
    schedule('cert', backoff.nextAttemptAt - Date.now() + 1000, maybeOrder);
    return;
  }

  ordering = true;
  try {
    const portError = await portSelfTest(domain);
    if (!alive(g)) return;
    s.portCheck = { state: portError ? 'failed' : 'ok', error: portError };
    // Many routers can't reach their own public address from inside (no NAT loopback), so a failed
    // self-test only blocks the order when nothing else says the port is open.
    if (portError && !force && s.upnp.state !== 'mapped') {
      if (!current) s.cert = { ...s.cert, state: 'waiting', error: portError };
      schedule('cert', 2 * MIN, maybeOrder);
      return;
    }
    s.cert = { ...s.cert, state: 'ordering', error: null };
    const staging = process.env.SOLAR_ACME_STAGING === '1';
    log.info(`Requesting a certificate for ${domain} from Let's Encrypt${staging ? ' (staging)' : ''}.`);
    const info = await issueCertificate({ domain, email: opts.email, staging, store });
    if (!alive(g)) return;
    store.saveBackoff({ failures: 0, nextAttemptAt: 0, lastError: null });
    current = info;
    s.cert.staging = staging;
    showCert(info);
    log.info(`Certificate issued for ${domain}, valid until ${new Date(info.expires).toISOString().slice(0, 10)}.`);
    await startHttps(info);
    void reachCheck();
  } catch (err) {
    if (!alive(g)) return;
    const msg = acmeMessage(err);
    const failures = backoff.failures + 1;
    const next = Date.now() + backoffDelay(failures);
    store.saveBackoff({ failures, nextAttemptAt: next, lastError: msg });
    s.cert = { ...s.cert, state: current ? 'ok' : 'error', error: msg, nextAttemptAt: next };
    log.error(`Certificate request failed (${failures}× in a row): ${msg} Next try ${new Date(next).toLocaleString()}.`);
    schedule('cert', next - Date.now() + 1000, maybeOrder);
  } finally {
    ordering = false;
  }
}

function acmeMessage(err: unknown): string {
  const e = err as Error & { response?: { data?: { detail?: string } } };
  const detail = e.response?.data?.detail ?? e.message ?? String(err);
  if (/rateLimited|too many/i.test(detail)) return `Let's Encrypt rate limit reached: ${detail}`;
  return detail.slice(0, 400);
}

async function startHttps(info: CertInfo) {
  if (!opts) return;
  const port = opts.httpsPort;
  if (server) {
    server.setSecureContext({ key: info.key, cert: info.cert });
    return;
  }
  const srv = createHttpsProxy({ key: info.key, cert: info.cert }, opts.httpPort);
  try {
    await listen(srv, port);
    server = srv;
    s.https = { listening: true, port, error: null };
    log.info(`HTTPS listening on port ${port}.`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    s.https = {
      listening: false,
      port,
      error: code === 'EACCES' ? `No permission to listen on port ${port}. Allow it (setcap cap_net_bind_service) or use a port above 1024.`
        : code === 'EADDRINUSE' ? `Port ${port} is already in use by another program.`
        : (err as Error).message,
    };
    log.error(`HTTPS server: ${s.https.error}`);
  }
}

async function reachCheck() {
  if (!opts) return;
  const g = gen;
  s.reachable.state = 'checking';
  const r = await testReachability(opts.domain, 'check the router forwards port 443 to this device');
  if (!alive(g)) return;
  s.reachable = { state: r.ok ? 'ok' : 'failed', checkedAt: Date.now(), ms: r.ms ?? null, error: r.error ?? null };
  schedule('reach', REACH_EVERY, reachCheck);
}

async function renewCheck() {
  await maybeOrder();
  schedule('renew', RENEW_CHECK, renewCheck);
}

// ---------- Lifecycle ----------

const signature = (o: DomainOptions) => JSON.stringify([o.domain, o.httpPort, o.httpsPort, o.upnp, o.dataDir]);

export async function start(o: DomainOptions) {
  if (opts) await stop();
  opts = o;
  s = fresh();
  s.https.port = o.httpsPort;
  s.ddns.provider = o.ddnsProvider;
  store = new CertStore(o.dataDir);
  current = store.load();
  if (current && current.domains.includes(o.domain) && current.expires > Date.now()) {
    showCert(current);
    await startHttps(current);
  } else {
    current = null;
    s.cert.state = 'waiting';
  }
  log.info(`Own domain mode for ${o.domain}.`);
  // DNS is checked when the IP first arrives; this covers a failed IP lookup too.
  void refreshIp().then(() => dnsCheck());
  void upnpMap();
  schedule('renew', RENEW_CHECK, renewCheck);
  if (current) schedule('reach', 5000, reachCheck);
}

/** Applies new options: a full restart only when the domain, ports or UPnP choice changed. */
export async function sync(o: DomainOptions | null) {
  if (!o) return stop();
  if (!opts || signature(opts) !== signature(o)) return start(o);
  const ddnsChanged = opts.ddnsProvider !== o.ddnsProvider || opts.ddnsToken !== o.ddnsToken;
  opts = o;
  if (ddnsChanged) await ddnsUpdate();
}

export async function stop() {
  if (!opts) return;
  gen++;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  opts = null;
  await upnpRelease();
  if (server) {
    const srv = server;
    server = null;
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  }
  s = fresh();
  current = null;
  store = null;
  ordering = false;
}

/** Re-runs every check now; also lets a certificate order bypass the back-off and port self-test. */
export async function retry() {
  if (!opts) return;
  await Promise.all([refreshIp().then(() => dnsCheck()), upnpMap()]);
  // Ordering can take a minute; the UI polls for the result.
  void maybeOrder(true).then(() => (current ? reachCheck() : undefined));
}

/** Domain served over HTTPS right now (for the http → https redirect), or null. */
export function httpsDomain(): string | null {
  return opts && server && current ? opts.domain : null;
}

export function status() {
  const record = opts ? splitDomain(opts.domain) : null;
  const cg = detectCgnat(s.upnp.externalIp, s.publicIp.ip);
  return {
    active: Boolean(opts),
    publicIp: s.publicIp.ip,
    publicIpError: s.publicIp.error,
    publicIpChangedAt: s.publicIp.changedAt,
    record: record && { type: 'A', name: record.name, root: record.root, value: s.publicIp.ip },
    dns: { state: s.dns.state, seen: s.dns.seen, note: s.dns.note, error: s.dns.error, checkedAt: s.dns.checkedAt },
    upnp: { ...s.upnp },
    cgnat: cg.cgnat,
    cgnatReason: cg.reason,
    portCheck: { ...s.portCheck },
    cert: { ...s.cert },
    https: { ...s.https },
    reachable: { ...s.reachable },
    ddns: { ...s.ddns },
  };
}

export type DomainStatus = ReturnType<typeof status>;
