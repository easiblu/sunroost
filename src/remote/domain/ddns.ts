/**
 * Dynamic DNS: points the domain's A record at a new public IP. The token is a secret; it is never
 * logged and is scrubbed from every error message.
 */
import { splitDomain } from './net.ts';

export type DdnsProvider = 'none' | 'duckdns' | 'cloudflare' | 'namecheap' | 'url';
export const DDNS_PROVIDERS: DdnsProvider[] = ['none', 'duckdns', 'cloudflare', 'namecheap', 'url'];

type Fetch = typeof fetch;

/** "solar.duckdns.org" → "solar"; null when the domain isn't a DuckDNS name. */
export function duckSubdomain(domain: string): string | null {
  const m = /(?:^|\.)([a-z0-9-]+)\.duckdns\.org$/.exec(domain);
  return m ? m[1] : null;
}

/** The update URL for the GET-style providers (DuckDNS, Namecheap, custom URL). */
export function ddnsUrl(provider: DdnsProvider, token: string, domain: string, ip: string): string {
  const enc = encodeURIComponent;
  switch (provider) {
    case 'duckdns': {
      const sub = duckSubdomain(domain);
      if (!sub) throw new Error('DuckDNS only updates <name>.duckdns.org domains.');
      return `https://www.duckdns.org/update?domains=${enc(sub)}&token=${enc(token)}&ip=${enc(ip)}`;
    }
    case 'namecheap': {
      const { root, name } = splitDomain(domain);
      return `https://dynamicdns.park-your-domain.com/update?host=${enc(name)}&domain=${enc(root)}&password=${enc(token)}&ip=${enc(ip)}`;
    }
    case 'url': {
      if (!/^https?:\/\//i.test(token)) throw new Error('The update URL must start with https://');
      return token.replace(/\{ip\}/g, enc(ip)).replace(/\{domain\}/g, enc(domain));
    }
    default:
      throw new Error(`No update URL for ${provider}`);
  }
}

const CF = 'https://api.cloudflare.com/client/v4';

async function cf(fetchFn: Fetch, token: string, path: string, init: RequestInit = {}) {
  const res = await fetchFn(CF + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: any; errors?: { message: string }[] } | null;
  if (!res.ok || !body?.success) {
    const msg = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${msg}`);
  }
  return body.result;
}

/** Finds the zone by trying the domain's suffixes, then creates or updates the A record. */
async function updateCloudflare(fetchFn: Fetch, token: string, domain: string, ip: string): Promise<string> {
  const labels = domain.split('.');
  let zone: { id: string; name: string } | null = null;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const zones = (await cf(fetchFn, token, `/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`)) as { id: string; name: string }[];
    zone = zones[0] ?? null;
  }
  if (!zone) throw new Error(`Cloudflare: no zone for ${domain} is visible to this API token.`);
  const records = (await cf(fetchFn, token, `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(domain)}`)) as { id: string; content: string }[];
  if (!records.length) {
    await cf(fetchFn, token, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'A', name: domain, content: ip, ttl: 1, proxied: false, comment: 'Sunroost dynamic DNS' }),
    });
    return 'created';
  }
  if (records[0].content === ip) return 'unchanged';
  await cf(fetchFn, token, `/zones/${zone.id}/dns_records/${records[0].id}`, { method: 'PATCH', body: JSON.stringify({ content: ip }) });
  return 'updated';
}

/** Checks the provider's answer; each one signals failure differently. */
export function checkDdnsAnswer(provider: DdnsProvider, status: number, body: string) {
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  if (provider === 'duckdns' && !/^OK/.test(body.trim())) throw new Error('DuckDNS rejected the update (check the token and domain).');
  if (provider === 'namecheap') {
    const errs = Number(/<ErrCount>(\d+)<\/ErrCount>/i.exec(body)?.[1] ?? '1');
    if (errs > 0) throw new Error(`Namecheap: ${/<Err1>([^<]*)<\/Err1>/i.exec(body)?.[1] ?? 'update failed'}`);
  }
}

export async function updateDdns(provider: DdnsProvider, token: string, domain: string, ip: string, fetchFn: Fetch = fetch): Promise<string> {
  const scrub = (msg: string) => (token ? msg.split(token).join('…').split(encodeURIComponent(token)).join('…') : msg);
  try {
    if (provider === 'none') return 'off';
    if (!token) throw new Error('No token saved.');
    if (provider === 'cloudflare') return await updateCloudflare(fetchFn, token, domain, ip);
    const res = await fetchFn(ddnsUrl(provider, token, domain, ip), { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'sunroost' } });
    checkDdnsAnswer(provider, res.status, await res.text());
    return 'updated';
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const detail = e.name === 'TimeoutError' ? 'Timed out' : e.cause ? `${e.message} (${e.cause.code ?? e.cause.message})` : e.message;
    throw new Error(scrub(detail));
  }
}
