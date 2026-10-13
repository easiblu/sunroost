/**
 * Checks the domain's A/AAAA records against public resolvers (not the OS cache) and compares
 * them with our public IP.
 */
import { Resolver } from 'node:dns/promises';

export type DnsState = 'unknown' | 'pending' | 'mismatch' | 'ok';

export interface DnsResult {
  state: DnsState;
  /** Addresses the domain currently resolves to (A then AAAA). */
  seen: string[];
  /** Extra advice, e.g. about an AAAA record. */
  note: string | null;
  error: string | null;
}

/** Pure comparison, so it can be tested without the network. */
export function compareDns(a: string[], aaaa: string[], publicIp: string | null): DnsResult {
  const seen = [...a, ...aaaa];
  if (!a.length) {
    return {
      state: 'pending',
      seen,
      note: aaaa.length ? 'The domain has only an IPv6 (AAAA) record. Add an A record with your IPv4 address.' : null,
      error: null,
    };
  }
  if (!publicIp) return { state: 'unknown', seen, note: null, error: null };
  const ours = a.includes(publicIp);
  const others = a.filter((ip) => ip !== publicIp);
  let note: string | null = null;
  if (ours && others.length) note = `Also points at ${others.join(', ')}. Remove the other A records so every visitor reaches this device.`;
  if (ours && aaaa.length) note = `${note ? note + ' ' : ''}It also has an IPv6 (AAAA) record. Let's Encrypt prefers IPv6, so remove it unless it points at this device.`;
  // Extra A records pointing elsewhere would send some visitors (and Let's Encrypt) to the wrong place.
  return { state: ours && !others.length ? 'ok' : 'mismatch', seen, note, error: null };
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

async function query(resolver: Resolver, domain: string, type: 'A' | 'AAAA'): Promise<string[]> {
  try {
    return type === 'A' ? await resolver.resolve4(domain) : await resolver.resolve6(domain);
  } catch (err) {
    if (NOT_FOUND.has((err as NodeJS.ErrnoException).code ?? '')) return [];
    throw err;
  }
}

export async function checkDns(domain: string, publicIp: string | null, servers = ['1.1.1.1', '8.8.8.8']): Promise<DnsResult> {
  let lastErr: Error | null = null;
  // Try each resolver on its own: one blocked resolver shouldn't fail the check.
  for (const server of servers) {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([server]);
    try {
      const [a, aaaa] = await Promise.all([query(resolver, domain, 'A'), query(resolver, domain, 'AAAA')]);
      return compareDns(a, aaaa, publicIp);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  return { state: 'unknown', seen: [], note: null, error: `DNS lookup failed: ${(lastErr as NodeJS.ErrnoException)?.code ?? lastErr?.message}` };
}
