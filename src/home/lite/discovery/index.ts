/**
 * Network discovery for the lite engine: an mDNS browser and an SSDP searcher, both plain UDP with
 * no dependencies. Drivers say which mDNS service types / SSDP targets they want; results arrive as
 * `Found` objects. Queries go out at start and every 5 minutes; mDNS announcements are heard any time.
 *
 * Multicast only works on the board's own network segment (not across VLANs or a guest network).
 */
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { logger } from '../../../core/log.ts';
import type { Found } from '../types.ts';
import { buildQuery, parse, type Record_ } from './dns.ts';

const log = logger('home');
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const REQUERY_MS = 5 * 60_000;

/** Turns one mDNS response into Found records for the wanted service types. Exported for tests. */
export function foundFromMdns(records: Record_[], wanted: Set<string>, fromIp: string): Found[] {
  const out: Found[] = [];
  const norm = (n: string) => n.toLowerCase().replace(/\.$/, '');
  for (const ptr of records) {
    if (ptr.type !== 'PTR' || !wanted.has(norm(ptr.name))) continue;
    const instance = ptr.target;
    const srv = records.find((r): r is Extract<Record_, { type: 'SRV' }> => r.type === 'SRV' && norm(r.name) === norm(instance));
    const txt = records.find((r): r is Extract<Record_, { type: 'TXT' }> => r.type === 'TXT' && norm(r.name) === norm(instance));
    const a = srv && records.find((r): r is Extract<Record_, { type: 'A' }> => r.type === 'A' && norm(r.name) === norm(srv.target));
    out.push({
      source: 'mdns',
      type: norm(ptr.name),
      name: instance.slice(0, instance.length - ptr.name.length).replace(/\.$/, ''),
      host: srv ? norm(srv.target) : null,
      ip: a?.ip ?? fromIp,
      port: srv?.port ?? null,
      props: txt?.txt ?? {},
    });
  }
  return out;
}

/** Parses an SSDP response or NOTIFY into headers (lower-case keys). Exported for tests. */
export function ssdpHeaders(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (!/^(HTTP\/1\.[01] 200|NOTIFY \* HTTP)/i.test(lines[0] ?? '')) return null;
  const h: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return h;
}

export class Discovery {
  private mdns: Socket | null = null;
  private ssdp: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private mdnsTypes = new Set<string>();
  private ssdpTargets = new Set<string>();
  private onFound: (f: Found) => void;

  constructor(onFound: (f: Found) => void) {
    this.onFound = onFound;
  }

  want(mdnsTypes: string[] = [], ssdpTargets: string[] = []) {
    for (const t of mdnsTypes) this.mdnsTypes.add(t.toLowerCase().replace(/\.$/, ''));
    for (const t of ssdpTargets) this.ssdpTargets.add(t);
  }

  start() {
    if (this.mdnsTypes.size) this.startMdns();
    if (this.ssdpTargets.size) this.startSsdp();
    this.timer = setInterval(() => this.query(), REQUERY_MS);
    // Let sockets bind before the first query.
    setTimeout(() => this.query(), 500).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.mdns?.close();
    this.ssdp?.close();
    this.mdns = this.ssdp = null;
  }

  /** Sends the queries now (also on the Devices page's "Scan" button). */
  query() {
    if (this.mdns && this.mdnsTypes.size) {
      const q = buildQuery([...this.mdnsTypes]);
      this.mdns.send(q, MDNS_PORT, MDNS_ADDR, () => {});
    }
    if (this.ssdp) {
      for (const st of this.ssdpTargets) {
        const msg = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        this.ssdp.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      }
    }
  }

  private startMdns() {
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    this.mdns = s;
    s.on('error', (err) => log.warn(`mDNS discovery: ${err.message}`));
    s.on('message', (msg, rinfo) => {
      try {
        const m = parse(msg);
        if (!m.response) return;
        for (const f of foundFromMdns(m.records, this.mdnsTypes, rinfo.address)) this.onFound(f);
      } catch {
        // Malformed packets are common on busy networks; ignore them.
      }
    });
    s.bind(MDNS_PORT, () => {
      try {
        for (const addr of localIPv4()) s.addMembership(MDNS_ADDR, addr);
        s.setMulticastTTL(255);
      } catch (err) {
        log.warn(`mDNS discovery: ${(err as Error).message}`);
      }
    });
  }

  private startSsdp() {
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    this.ssdp = s;
    s.on('error', (err) => log.warn(`SSDP discovery: ${err.message}`));
    s.on('message', (msg, rinfo) => {
      const h = ssdpHeaders(msg.toString());
      if (!h) return;
      this.onFound({
        source: 'ssdp', type: h.st ?? h.nt ?? '', name: h.usn ?? '', host: null, ip: rinfo.address,
        port: null, props: h,
      });
    });
    // An ephemeral port for M-SEARCH answers (port 1900 is often taken by the OS).
    s.bind(0);
  }
}

function localIPv4(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}
