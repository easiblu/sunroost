/**
 * Pure parsers and decision logic for the network module (nmcli / ip output, hotspot fallback).
 * Kept free of I/O so they can be unit tested on any OS.
 */

export interface WifiNetwork {
  ssid: string;
  /** 0–100 as reported by NetworkManager. */
  signal: number;
  security: string;
  active?: boolean;
}

export interface NetInterface {
  name: string;
  /** IPv4 addresses (without prefix length). */
  addresses: string[];
  up: boolean;
}

/**
 * Splits one line of `nmcli -t` output. Fields are separated by ':'; literal ':' and '\' inside a
 * value are escaped as '\:' and '\\'.
 */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * `nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list` (optionally prefixed with ACTIVE when `withActive`).
 * Hidden networks (empty SSID) are dropped, duplicates (several access points) keep the strongest,
 * and the result is sorted by signal, strongest first.
 */
export function parseWifiList(text: string, withActive = false): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = splitTerse(line);
    const [active, ssid, signal, security] = withActive ? f : ['', ...f];
    if (!ssid) continue;
    const n: WifiNetwork = { ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)), security: (security ?? '').trim() };
    if (withActive) n.active = active === 'yes' || active === '*';
    const prev = best.get(ssid);
    if (!prev || n.signal > prev.signal || (n.active && !prev.active)) best.set(ssid, { ...n, active: n.active || prev?.active });
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev`. */
export function parseDevices(text: string): { device: string; type: string; state: string; connection: string }[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [device = '', type = '', state = '', connection = ''] = splitTerse(l);
      return { device, type, state, connection };
    });
}

/** Interfaces that are never interesting in the status table (loopback, Bluetooth PAN). */
const HIDDEN = /^(lo|bnep\d*|pan\d*)$/;

/** `ip -j addr` JSON → interfaces with IPv4 addresses, sorted by name. */
export function parseIpAddr(json: string): NetInterface[] {
  let list: { ifname?: string; operstate?: string; flags?: string[]; addr_info?: { family?: string; local?: string }[] }[];
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i.ifname && !HIDDEN.test(i.ifname))
    .map((i) => {
      const addresses = (i.addr_info ?? []).filter((a) => a.family === 'inet' && a.local).map((a) => a.local as string);
      // "UNKNOWN" operstate is common for links without carrier detection; treat as up when addressed.
      const up = i.operstate === 'UP' || (i.operstate === 'UNKNOWN' && addresses.length > 0) || (Boolean(i.flags?.includes('LOWER_UP')) && addresses.length > 0);
      return { name: i.ifname as string, addresses, up };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** NetworkManager signal (0–100) → 1–6 bars, as shown next to the SSID. */
export function signalBars(signal: number): number {
  if (!Number.isFinite(signal) || signal <= 0) return 0;
  return Math.max(1, Math.min(6, Math.ceil(signal / (100 / 6))));
}

/** WiFi passwords: WPA-PSK needs 8–63 printable characters or 64 hex digits; empty = open network. */
export function validWifiPassword(pw: string): boolean {
  if (pw === '') return true;
  if (pw.length === 64) return /^[0-9a-f]{64}$/i.test(pw);
  return pw.length >= 8 && pw.length <= 63;
}

/** SSIDs are 1–32 bytes. */
export function validSsid(ssid: string): boolean {
  const n = Buffer.byteLength(ssid, 'utf8');
  return n >= 1 && n <= 32;
}

/** Hotspot SSID from the site name: trimmed and cut to 32 bytes. */
export function hotspotSsid(siteName: string): string {
  let s = (siteName || 'Sunroost').trim() || 'Sunroost';
  while (Buffer.byteLength(s, 'utf8') > 32) s = s.slice(0, -1);
  return s;
}

// ---------- Hotspot fallback ----------

export interface FallbackInput {
  now: number;
  /** Some interface (WiFi client or Ethernet) has a LAN address. */
  connected: boolean;
  /** Ethernet specifically is connected (then WiFi retries are pointless for reachability). */
  ethernet: boolean;
  hotspotActive: boolean;
  /** Hotspot was started manually from the UI; never stop it automatically. */
  manual: boolean;
  autoEnabled: boolean;
  /** A WiFi client connection is configured (something to retry). */
  hasSavedWifi: boolean;
  /** When the device was first seen without connectivity (null while connected). */
  offlineSince: number | null;
  /** When the hotspot was last (re)started automatically. */
  hotspotSince: number | null;
}

export type FallbackAction = 'start-hotspot' | 'stop-hotspot' | 'retry-wifi' | 'none';

export const OFFLINE_GRACE_MS = 2 * 60_000;
/** While the hotspot runs, drop it this often to see whether the saved WiFi is back. */
export const RETRY_WIFI_MS = 5 * 60_000;

/**
 * Decides what the fallback loop should do next:
 * - offline for 2 minutes → start the hotspot
 * - hotspot running and Ethernet came up → stop it
 * - hotspot running for 5 minutes and a WiFi network is saved → retry WiFi (the caller restarts the
 *   hotspot if the retry fails, which the next ticks handle through the offline grace period)
 */
export function decideFallback(i: FallbackInput): FallbackAction {
  if (i.hotspotActive) {
    if (i.manual) return 'none';
    if (!i.autoEnabled) return 'stop-hotspot';
    if (i.ethernet) return 'stop-hotspot';
    if (i.hasSavedWifi && i.hotspotSince !== null && i.now - i.hotspotSince >= RETRY_WIFI_MS) return 'retry-wifi';
    return 'none';
  }
  if (!i.autoEnabled || i.connected) return 'none';
  if (i.offlineSince !== null && i.now - i.offlineSince >= OFFLINE_GRACE_MS) return 'start-hotspot';
  return 'none';
}
