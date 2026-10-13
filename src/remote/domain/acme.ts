/**
 * Let's Encrypt certificates over HTTP-01. Keys and the certificate live in <dataDir>/acme/
 * (mode 0600). Challenge responses are served by the main app at /.well-known/acme-challenge/:token
 * (see src/web/api/acme.ts) from the in-memory `challenges` map.
 */
import * as acme from 'acme-client';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** token → key authorization (also used for our own port-80 self-test). */
const challenges = new Map<string, { value: string; expires: number }>();

export function setChallenge(token: string, value: string, ttlMs = 10 * 60_000) {
  challenges.set(token, { value, expires: Date.now() + ttlMs });
}

export function removeChallenge(token: string) {
  challenges.delete(token);
}

export function getChallenge(token: string): string | null {
  const c = challenges.get(token);
  if (!c) return null;
  if (c.expires < Date.now()) {
    challenges.delete(token);
    return null;
  }
  return c.value;
}

export interface CertInfo {
  key: string;
  cert: string;
  expires: number;
  issuer: string;
  domains: string[];
}

export interface BackoffState {
  failures: number;
  nextAttemptAt: number;
  lastError: string | null;
}

const RENEW_BEFORE_MS = 30 * 864e5;

/** Exponential back-off after failed orders: 1 h, 2 h, 4 h … capped at 24 h (LE limits failed validations). */
export function backoffDelay(failures: number): number {
  return Math.min(24 * 3600_000, 3600_000 * 2 ** Math.max(0, failures - 1));
}

export const needsRenewal = (info: CertInfo | null, domain: string, now = Date.now()) =>
  !info || !info.domains.includes(domain) || info.expires - now < RENEW_BEFORE_MS;

export class CertStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'acme');
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  private write(name: string, data: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(name), data, { mode: 0o600 });
    chmodSync(this.path(name), 0o600);
  }

  private read(name: string): string | null {
    try {
      return readFileSync(this.path(name), 'utf8');
    } catch {
      return null;
    }
  }

  async accountKey(): Promise<string> {
    const existing = this.read('account.key');
    if (existing) return existing;
    const key = (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
    this.write('account.key', key);
    return key;
  }

  /** The stored certificate, or null when missing or unreadable. */
  load(): CertInfo | null {
    const key = this.read('key.pem');
    const cert = this.read('cert.pem');
    if (!key || !cert) return null;
    try {
      const info = acme.crypto.readCertificateInfo(cert);
      const domains = [info.domains.commonName, ...info.domains.altNames].filter(Boolean);
      return { key, cert, expires: info.notAfter.getTime(), issuer: info.issuer.commonName ?? '', domains: [...new Set(domains)] };
    } catch {
      return null;
    }
  }

  save(key: string, cert: string) {
    this.write('key.pem', key);
    this.write('cert.pem', cert);
  }

  loadBackoff(): BackoffState {
    try {
      const s = JSON.parse(this.read('state.json') ?? '');
      return { failures: Number(s.failures) || 0, nextAttemptAt: Number(s.nextAttemptAt) || 0, lastError: s.lastError ?? null };
    } catch {
      return { failures: 0, nextAttemptAt: 0, lastError: null };
    }
  }

  saveBackoff(s: BackoffState) {
    this.write('state.json', JSON.stringify(s));
  }

  exists() {
    return existsSync(this.path('cert.pem'));
  }
}

export interface IssueOptions {
  domain: string;
  email?: string;
  staging?: boolean;
  store: CertStore;
}

/** Orders a certificate for one hostname. Throws with Let's Encrypt's message on failure. */
export async function issueCertificate(o: IssueOptions): Promise<CertInfo> {
  const client = new acme.Client({
    directoryUrl: o.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: await o.store.accountKey(),
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: o.domain, altNames: [o.domain] }, await acme.crypto.createPrivateEcdsaKey('P-256'));
  const cert = await client.auto({
    csr,
    email: o.email || undefined,
    termsOfServiceAgreed: true,
    challengePriority: ['http-01'],
    // We ran our own reachability self-test; acme-client's check would fail on routers without NAT loopback.
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type === 'http-01') setChallenge(challenge.token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      removeChallenge(challenge.token);
    },
  });
  o.store.save(key.toString(), cert);
  const info = o.store.load();
  if (!info) throw new Error('The issued certificate could not be read back.');
  return info;
}
