/**
 * Public IPv4 address of this connection, from a fallback chain of plain-text "what is my IP"
 * services. Only IPv4 is used: the user adds an A record.
 */
import { isIPv4 } from 'node:net';

type Fetch = typeof fetch;

export const IP_SOURCES: { url: string; parse: (body: string) => string }[] = [
  { url: 'https://api.ipify.org', parse: (b) => b.trim() },
  { url: 'https://ipv4.icanhazip.com', parse: (b) => b.trim() },
  { url: 'https://ifconfig.me/ip', parse: (b) => b.trim() },
  // Connecting to 1.1.1.1 directly forces IPv4.
  { url: 'https://1.1.1.1/cdn-cgi/trace', parse: (b) => /^ip=(.+)$/m.exec(b)?.[1]?.trim() ?? '' },
];

/** Tries each source in turn; resolves the first valid IPv4 address or throws with every failure. */
export async function detectPublicIp(fetchFn: Fetch = fetch, timeoutMs = 5000): Promise<{ ip: string; source: string }> {
  const errors: string[] = [];
  for (const src of IP_SOURCES) {
    try {
      const res = await fetchFn(src.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'sunroost' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = src.parse(await res.text());
      if (!isIPv4(ip)) throw new Error('no IPv4 address in the answer');
      return { ip, source: new URL(src.url).host };
    } catch (err) {
      errors.push(`${new URL(src.url).host}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Couldn't detect the public IP (${errors.join('; ')})`);
}
