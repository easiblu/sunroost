/**
 * Small address helpers shared by the own-domain mode and the sign-in ban (LAN exemption).
 */
import { isIPv4, isIPv6 } from 'node:net';

const v4 = (ip: string) => ip.replace(/^::ffff:/i, '');

function toInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, base: string, bits: number) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/** RFC 1918, loopback and link-local IPv4. */
export function isPrivateV4(ip: string): boolean {
  ip = v4(ip);
  if (!isIPv4(ip)) return false;
  return inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16)
    || inRange(ip, '127.0.0.0', 8) || inRange(ip, '169.254.0.0', 16);
}

/** Carrier-grade NAT shared address space (RFC 6598). */
export function isCgnatV4(ip: string): boolean {
  ip = v4(ip);
  return isIPv4(ip) && inRange(ip, '100.64.0.0', 10);
}

/** True for addresses on the local network (private IPv4, loopback, IPv6 ULA / link-local). */
export function isLanAddress(ip: string): boolean {
  if (!ip) return false;
  const a = v4(ip);
  if (isIPv4(a)) return isPrivateV4(a);
  if (!isIPv6(a)) return false;
  const lower = a.toLowerCase();
  return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}

/** True when both addresses share the subnet given by `netmask`. */
export function sameSubnet(a: string, b: string, netmask: string): boolean {
  if (!isIPv4(a) || !isIPv4(b) || !isIPv4(netmask)) return false;
  const m = toInt(netmask);
  return (toInt(a) & m) === (toInt(b) & m);
}

/** Second-level public suffixes common enough to matter for "which part is the record name". */
const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'co.za', 'org.za', 'net.za', 'web.za', 'gov.za',
  'com.au', 'net.au', 'org.au', 'id.au', 'co.nz', 'net.nz', 'org.nz', 'geek.nz',
  'com.br', 'net.br', 'com.mx', 'com.ar', 'co.in', 'net.in', 'org.in', 'firm.in',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.cn', 'com.tw', 'com.hk', 'com.sg', 'com.my',
  'co.id', 'co.il', 'co.ke', 'co.ug', 'co.tz', 'com.ng', 'com.gh', 'com.eg', 'com.tr', 'com.pl', 'com.ua',
]);

/**
 * Splits a hostname into the registered domain and the record name the user enters at their
 * DNS provider: "solar.example.com" → { root: "example.com", name: "solar" }; apex → name "@".
 */
export function splitDomain(host: string): { root: string; name: string } {
  const labels = host.split('.');
  const suffix2 = labels.slice(-2).join('.');
  const rootLen = TWO_LEVEL.has(suffix2) ? 3 : 2;
  if (labels.length <= rootLen) return { root: host, name: '@' };
  return { root: labels.slice(-rootLen).join('.'), name: labels.slice(0, -rootLen).join('.') };
}

export interface CgnatResult {
  /** null = can't tell (no UPnP answer). */
  cgnat: boolean | null;
  reason: string | null;
}

/**
 * The router's WAN address (from UPnP) vs. the address the internet sees. A private / shared
 * (100.64/10) WAN address, or one that differs from the public IP, means another NAT sits between
 * the router and the internet, so inbound connections can't reach us.
 */
export function detectCgnat(routerWanIp: string | null, publicIp: string | null): CgnatResult {
  if (!routerWanIp || routerWanIp === '0.0.0.0') return { cgnat: null, reason: null };
  if (isCgnatV4(routerWanIp)) {
    return { cgnat: true, reason: `Your router's internet address (${routerWanIp}) is in the carrier-grade NAT range: your provider shares one public IP between many customers.` };
  }
  if (isPrivateV4(routerWanIp)) {
    return { cgnat: true, reason: `Your router's internet address (${routerWanIp}) is a private address: there is another router or your provider's NAT in front of it.` };
  }
  if (publicIp && routerWanIp !== publicIp) {
    return { cgnat: true, reason: `Your router reports ${routerWanIp} but the internet sees ${publicIp}: traffic goes through another NAT.` };
  }
  return { cgnat: false, reason: null };
}
