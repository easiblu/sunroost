/**
 * Minimal UPnP Internet Gateway Device client (no dependencies): SSDP discovery, device
 * description parsing, and the three SOAP actions we need on WANIPConnection / WANPPPConnection.
 */
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { sameSubnet } from './net.ts';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
export const IGD_TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];

export interface Gateway {
  /** Device description URL from the SSDP LOCATION header. */
  location: string;
  /** Friendly name for the UI, e.g. "FRITZ!Box 7590". */
  name: string;
  serviceType: string;
  controlUrl: string;
}

export class UpnpError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

// ---------- SSDP ----------

export function buildMSearch(st: string, mx = 2): string {
  return `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`;
}

/** Parses an SSDP response into lower-cased headers; null unless it's a 200 with a LOCATION. */
export function parseSsdpResponse(text: string): { location: string; st: string; server: string } | null {
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? '')) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!headers.location || !/^https?:\/\//i.test(headers.location)) return null;
  return { location: headers.location, st: headers.st ?? '', server: headers.server ?? '' };
}

/** Sends M-SEARCH for IGD v1 and v2 and collects distinct LOCATIONs for `timeoutMs`. */
export function ssdpSearch(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      resolve([...found]);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      const r = parseSsdpResponse(msg.toString());
      if (r && /InternetGatewayDevice|WANIPConnection|WANPPPConnection/i.test(r.st || 'InternetGatewayDevice')) found.add(r.location);
    });
    sock.bind(0, () => {
      for (const st of IGD_TARGETS) {
        const buf = Buffer.from(buildMSearch(st));
        // Twice, UDP may drop one.
        for (let i = 0; i < 2; i++) sock.send(buf, SSDP_PORT, SSDP_ADDR, () => {});
      }
    });
  });
}

// ---------- Device description ----------

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1] ?? '';

/** Finds the WAN connection service (WANIPConnection preferred over WANPPPConnection, v2 over v1). */
export function parseDeviceDescription(xml: string, location: string): Gateway | null {
  const base = tag(xml, 'URLBase') || location;
  const services = [...xml.matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/gi)].map((m) => ({
    serviceType: tag(m[1], 'serviceType'),
    controlUrl: tag(m[1], 'controlURL'),
  }));
  const rank = (t: string) =>
    /WANIPConnection:2/.test(t) ? 0 : /WANIPConnection:1/.test(t) ? 1 : /WANPPPConnection/.test(t) ? 2 : 9;
  const svc = services.filter((s) => rank(s.serviceType) < 9 && s.controlUrl).sort((a, b) => rank(a.serviceType) - rank(b.serviceType))[0];
  if (!svc) return null;
  let controlUrl: string;
  try {
    controlUrl = new URL(svc.controlUrl, base).toString();
  } catch {
    return null;
  }
  const name = decodeXml(tag(xml, 'friendlyName') || tag(xml, 'modelName') || new URL(location).hostname);
  return { location, name, serviceType: svc.serviceType, controlUrl };
}

// ---------- SOAP ----------

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|apos|quot);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' })[e as 'lt']!);

export function buildSoapEnvelope(serviceType: string, action: string, args: [string, string | number][] = []): string {
  const body = args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
  return (
    '<?xml version="1.0"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">${body}</u:${action}></s:Body></s:Envelope>`
  );
}

/** Returns the response's output arguments, or throws UpnpError with the UPnP error code/description. */
export function parseSoapResponse(xml: string, action: string): Record<string, string> {
  if (/<(?:\w+:)?Fault>/i.test(xml)) {
    const code = Number(tag(xml, 'errorCode')) || null;
    const desc = tag(xml, 'errorDescription') || tag(xml, 'faultstring') || 'SOAP fault';
    throw new UpnpError(`${decodeXml(desc)}${code ? ` (UPnP error ${code})` : ''}`, code);
  }
  const m = new RegExp(`<(?:\\w+:)?${action}Response[^>]*>([\\s\\S]*?)</(?:\\w+:)?${action}Response>`, 'i').exec(xml);
  if (!m) throw new UpnpError(`Unexpected answer to ${action}`);
  const out: Record<string, string> = {};
  for (const a of m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[a[1]] = decodeXml(a[2]);
  return out;
}

export async function soapCall(gw: Gateway, action: string, args: [string, string | number][] = [], fetchFn: typeof fetch = fetch) {
  let res: Response;
  try {
    res = await fetchFn(gw.controlUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${gw.serviceType}#${action}"` },
      body: buildSoapEnvelope(gw.serviceType, action, args),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new UpnpError(`Router didn't answer ${action}: ${(err as Error).message}`);
  }
  const text = await res.text();
  // Faults come back as HTTP 500 with a SOAP body.
  if (!res.ok && !/Fault/i.test(text)) throw new UpnpError(`Router answered HTTP ${res.status} to ${action}`);
  return parseSoapResponse(text, action);
}

// ---------- High level ----------

/** Discovers the first gateway that has a WAN connection service. */
export async function discoverGateway(timeoutMs = 3000, fetchFn: typeof fetch = fetch): Promise<Gateway | null> {
  for (const location of await ssdpSearch(timeoutMs)) {
    try {
      const res = await fetchFn(location, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const gw = parseDeviceDescription(await res.text(), location);
      if (gw) return gw;
    } catch {
      // Try the next responder.
    }
  }
  return null;
}

export async function getExternalIp(gw: Gateway, fetchFn?: typeof fetch): Promise<string> {
  return (await soapCall(gw, 'GetExternalIPAddress', [], fetchFn)).NewExternalIPAddress ?? '';
}

export interface Mapping {
  external: number;
  internal: number;
  lanIp: string;
}

export async function addPortMapping(gw: Gateway, m: Mapping, lease: number, fetchFn?: typeof fetch) {
  await soapCall(gw, 'AddPortMapping', [
    ['NewRemoteHost', ''],
    ['NewExternalPort', m.external],
    ['NewProtocol', 'TCP'],
    ['NewInternalPort', m.internal],
    ['NewInternalClient', m.lanIp],
    ['NewEnabled', 1],
    ['NewPortMappingDescription', 'Sunroost'],
    ['NewLeaseDuration', lease],
  ], fetchFn);
}

export async function deletePortMapping(gw: Gateway, external: number, fetchFn?: typeof fetch) {
  await soapCall(gw, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', external], ['NewProtocol', 'TCP']], fetchFn);
}

/** UPnP error 725: the router only supports permanent (lease 0) mappings. */
export const onlyPermanentLeases = (err: unknown) => err instanceof UpnpError && (err.code === 725 || /OnlyPermanentLease/i.test(err.message));

/** This host's IPv4 address on the router's subnet. */
export function lanIpFor(routerIp: string, ifaces = networkInterfaces()): string | null {
  if (!isIPv4(routerIp)) return null;
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && sameSubnet(a.address, routerIp, a.netmask)) return a.address;
    }
  }
  return null;
}

/** Fallback: ask the OS which local address it would use to reach the router. */
export function lanIpByRoute(routerIp: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    sock.on('error', () => {
      sock.close();
      resolve(null);
    });
    sock.connect(SSDP_PORT, routerIp, () => {
      const addr = sock.address().address;
      sock.close();
      resolve(addr);
    });
  });
}
