/**
 * Network: WiFi client and hotspot management through NetworkManager (`nmcli`, the default on
 * Raspberry Pi OS Bookworm), the interface status table and an internet check.
 *
 * Hotspot fallback: when neither WiFi nor Ethernet has a LAN connection for 2 minutes, an access
 * point named after the site is started at 10.42.0.1 (NetworkManager "shared" mode runs DHCP/DNS).
 * Every 5 minutes the hotspot is dropped briefly to retry the saved WiFi; it stops as soon as the
 * WiFi or Ethernet is back.
 *
 * Linux only and best effort: on other systems (or without nmcli) every call reports
 * `supported: false` and nothing throws.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { db } from '../core/db.ts';
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';
import { exec, execPriv, isRoot, run } from '../system/exec.ts';
import {
  decideFallback, hotspotSsid, parseDevices, parseIpAddr, parseWifiList, validSsid, validWifiPassword,
  type NetInterface, type WifiNetwork,
} from './parse.ts';

const log = logger('network');

export const WIFI_CON = 'sunroost-wifi';
export const HOTSPOT_CON = 'sunroost-hotspot';
export const HOTSPOT_IP = '10.42.0.1';
const TICK_MS = 15_000;
const CAPTIVE_CONF = '/etc/NetworkManager/dnsmasq-shared.d/sunroost-captive.conf';

// ---------- Small persistent config (own table; kept out of the shared settings keys) ----------

export interface NetworkConfig {
  country: string;
  hotspotAuto: boolean;
  /** Empty = open hotspot. */
  hotspotPassword: string;
}
const CONFIG_DEFAULTS: NetworkConfig = { country: 'US', hotspotAuto: true, hotspotPassword: '' };
let tableReady = false;

function table() {
  if (!tableReady) {
    db().exec(`CREATE TABLE IF NOT EXISTS network_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tableReady = true;
  }
}

export function getConfig(): NetworkConfig {
  try {
    table();
    const out = { ...CONFIG_DEFAULTS };
    for (const row of db().prepare(`SELECT key, value FROM network_config`).all() as { key: string; value: string }[]) {
      if (row.key in out) (out as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
    return out;
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

export function setConfig(patch: Partial<NetworkConfig>) {
  table();
  const stmt = db().prepare(`INSERT OR REPLACE INTO network_config (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(patch)) if (k in CONFIG_DEFAULTS && v !== undefined) stmt.run(k, JSON.stringify(v));
}

// ---------- Capability detection ----------

let nmcli: boolean | null = null;
/** NetworkManager is available (Linux with a running NetworkManager). */
export async function supported(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (nmcli === null) {
    const r = await exec('nmcli', ['-t', '-f', 'RUNNING', 'general'], { timeout: 4000 });
    nmcli = r.ok && r.stdout.trim() === 'running';
  }
  return nmcli;
}

export function unsupportedReason(): string {
  if (process.platform !== 'linux') return `WiFi management is not supported on this OS (${process.platform === 'darwin' ? 'macOS' : process.platform}).`;
  return 'WiFi management needs NetworkManager (nmcli), the default on Raspberry Pi OS Bookworm.';
}

const nm = (args: string[], timeout = 10_000) => exec('nmcli', args, { timeout });
const nmPriv = (args: string[], timeout = 30_000) => execPriv('nmcli', args, { timeout, tryPlain: true });

async function wifiDevice(): Promise<string | null> {
  const r = await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev']);
  if (!r.ok) return null;
  return parseDevices(r.stdout).find((d) => d.type === 'wifi')?.device ?? null;
}

// ---------- Status ----------

export interface NetworkStatus {
  supported: boolean;
  reason: string | null;
  /** 'connected' | 'disconnected' | 'hotspot' | 'disconnected-hotspot' | 'unsupported' */
  status: string;
  ssid: string | null;
  signal: number | null;
  wifiDevice: string | null;
  hotspot: { active: boolean; ssid: string; ip: string; manual: boolean; auto: boolean; open: boolean };
  interfaces: NetInterface[];
  internet: boolean | null;
  country: string;
  /** Last WiFi connect attempt result, for the UI. */
  lastConnect: { ssid: string; ok: boolean | null; message: string; at: number } | null;
}

let internetCache: { at: number; up: boolean } | null = null;

/** Internet reachability: a TCP connect to well-known anycast DNS servers (port 53), cached 30 s. */
export async function internetUp(): Promise<boolean> {
  if (internetCache && Date.now() - internetCache.at < 30_000) return internetCache.up;
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port: 53, timeout: 2500 });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('timeout', () => (s.destroy(), resolve(false)));
      s.once('error', () => resolve(false));
    });
  const up = (await probe('1.1.1.1')) || (await probe('9.9.9.9'));
  internetCache = { at: Date.now(), up };
  return up;
}

/** Interfaces from `ip -j addr` on Linux; os.networkInterfaces() elsewhere. */
export async function interfaces(): Promise<NetInterface[]> {
  if (process.platform === 'linux') {
    const json = await run('ip', ['-j', 'addr'], 3000);
    if (json) return parseIpAddr(json);
  }
  const out: NetInterface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const v4 = (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
    if (!v4.length) continue; // macOS lists many idle virtual interfaces; only show addressed ones
    out.push({ name, addresses: v4.map((a) => a.address), up: true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let manualHotspot = false;
let lastConnect: NetworkStatus['lastConnect'] = null;

async function activeConnections(): Promise<{ name: string; type: string; device: string }[]> {
  const r = await nm(['-t', '-f', 'NAME,TYPE,DEVICE', 'con', 'show', '--active']);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [name = '', type = '', device = ''] = l.split(':');
      return { name, type, device };
    });
}

export async function status(): Promise<NetworkStatus> {
  const cfg = getConfig();
  const [ifaces, internet] = await Promise.all([interfaces(), internetUp()]);
  const hotspotSsidName = hotspotSsid(String(settings.get('site.name')));
  const base: NetworkStatus = {
    supported: false,
    reason: null,
    status: 'unsupported',
    ssid: null,
    signal: null,
    wifiDevice: null,
    hotspot: { active: false, ssid: hotspotSsidName, ip: HOTSPOT_IP, manual: manualHotspot, auto: cfg.hotspotAuto, open: !cfg.hotspotPassword },
    interfaces: ifaces,
    internet,
    country: cfg.country,
    lastConnect,
  };
  if (!(await supported())) return { ...base, reason: unsupportedReason() };
  const [dev, active] = await Promise.all([wifiDevice(), activeConnections()]);
  const hotspotActive = active.some((c) => c.name === HOTSPOT_CON);
  let ssid: string | null = null;
  let signal: number | null = null;
  if (dev && !hotspotActive) {
    const r = await nm(['-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'no']);
    const cur = r.ok ? parseWifiList(r.stdout, true).find((n) => n.active) : undefined;
    if (cur) {
      ssid = cur.ssid;
      signal = cur.signal;
    }
  }
  if (!ssid && !hotspotActive) ssid = await savedSsid();
  const wifiConnected = active.some((c) => c.type.includes('wireless') && c.name !== HOTSPOT_CON);
  return {
    ...base,
    supported: true,
    wifiDevice: dev,
    ssid: hotspotActive ? hotspotSsidName : ssid,
    signal: wifiConnected ? signal : null,
    status: hotspotActive ? (wifiConnected ? 'connected' : 'disconnected-hotspot') : wifiConnected ? 'connected' : 'disconnected',
    hotspot: { ...base.hotspot, active: hotspotActive },
  };
}

/** SSID of our saved client connection, if any. */
async function savedSsid(): Promise<string | null> {
  const r = await nm(['-t', '-g', '802-11-wireless.ssid', 'con', 'show', WIFI_CON]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Any saved WiFi client connection (ours or one made by the OS imager). */
async function hasSavedWifi(): Promise<boolean> {
  const r = await nm(['-t', '-f', 'NAME,TYPE', 'con', 'show']);
  if (!r.ok) return false;
  return r.stdout.split('\n').some((l) => l.includes('wireless') && !l.startsWith(`${HOTSPOT_CON}:`));
}

// ---------- WiFi ----------

export async function scan(): Promise<{ supported: boolean; reason: string | null; networks: WifiNetwork[]; error?: string }> {
  if (!(await supported())) return { supported: false, reason: unsupportedReason(), networks: [] };
  const r = await nm(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'yes'], 20_000);
  if (!r.ok) return { supported: true, reason: null, networks: [], error: r.message || 'Scan failed' };
  return { supported: true, reason: null, networks: parseWifiList(r.stdout) };
}

/** Sets the regulatory domain: persistent via raspi-config when present, else `iw reg set`. */
async function setCountry(country: string) {
  if (existsSync('/usr/bin/raspi-config')) {
    const r = await execPriv('raspi-config', ['nonint', 'do_wifi_country', country], { timeout: 20_000 });
    if (r.ok) return;
  }
  const r = await execPriv('iw', ['reg', 'set', country], { timeout: 5000 });
  if (!r.ok) log.warn(`Unable to set WiFi country ${country}: ${r.message}`);
}

export async function validateWifi(ssid: string, password: string, country: string): Promise<string | null> {
  if (!validSsid(ssid)) return 'SSID must be 1 to 32 characters.';
  if (!validWifiPassword(password)) return 'Password must be 8 to 64 characters.';
  if (!/^[A-Z]{2}[0-9]?$/.test(country)) return 'Invalid country code.';
  return null;
}

/**
 * Saves the WiFi network as our NetworkManager connection and connects in the background
 * (the caller may be connected through the hotspot that is about to go away).
 */
export async function connectWifi(ssid: string, password: string, country: string): Promise<{ ok: boolean; message: string }> {
  if (!(await supported())) return { ok: false, message: unsupportedReason() };
  const invalid = await validateWifi(ssid, password, country);
  if (invalid) return { ok: false, message: invalid };
  setConfig({ country });
  lastConnect = { ssid, ok: null, message: 'Connecting…', at: Date.now() };
  void (async () => {
    await setCountry(country);
    const dev = (await wifiDevice()) ?? 'wlan0';
    await nmPriv(['con', 'delete', WIFI_CON], 15_000); // fine if it doesn't exist
    const sec = password ? ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password] : [];
    const add = await nmPriv([
      'con', 'add', 'type', 'wifi', 'ifname', dev, 'con-name', WIFI_CON, 'ssid', ssid,
      'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '10', ...sec,
    ]);
    if (!add.ok) return finishConnect(ssid, false, add.message);
    manualHotspot = false;
    await nmPriv(['con', 'down', HOTSPOT_CON], 15_000);
    const up = await nmPriv(['con', 'up', WIFI_CON], 60_000);
    finishConnect(ssid, up.ok, up.ok ? `Connected to ${ssid}.` : up.message);
  })();
  log.info(`Connecting to WiFi network ${ssid} (country ${country}).`);
  return { ok: true, message: `Connecting to ${ssid}…` };
}

function finishConnect(ssid: string, ok: boolean, message: string) {
  lastConnect = { ssid, ok, message, at: Date.now() };
  if (ok) log.info(message);
  else log.error(`Unable to connect to WiFi network ${ssid}: ${message}`);
}

// ---------- Hotspot ----------

/** Makes every DNS name resolve to the hotspot while it runs, so phones open the captive portal. */
async function ensureCaptiveDns() {
  if (!isRoot() || existsSync(CAPTIVE_CONF)) return;
  try {
    await writeFile(CAPTIVE_CONF, `# Written by Sunroost: captive portal while the hotspot is active.\naddress=/#/${HOTSPOT_IP}\n`);
  } catch {
    // Directory missing or read-only; captive detection then relies on the probe URLs only.
  }
}

export async function startHotspot(manual: boolean): Promise<{ ok: boolean; message: string }> {
  if (!(await supported())) return { ok: false, message: unsupportedReason() };
  const dev = await wifiDevice();
  if (!dev) return { ok: false, message: 'No WiFi device found.' };
  const cfg = getConfig();
  const ssid = hotspotSsid(String(settings.get('site.name')));
  await ensureCaptiveDns();
  await nmPriv(['con', 'delete', HOTSPOT_CON], 15_000);
  const sec = cfg.hotspotPassword ? ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', cfg.hotspotPassword] : [];
  const add = await nmPriv([
    'con', 'add', 'type', 'wifi', 'ifname', dev, 'con-name', HOTSPOT_CON, 'ssid', ssid, 'connection.autoconnect', 'no',
    '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg', 'ipv4.method', 'shared', 'ipv4.addresses', `${HOTSPOT_IP}/24`,
    'ipv6.method', 'disabled', ...sec,
  ]);
  if (!add.ok) {
    log.error(`Unable to create hotspot: ${add.message}`);
    return { ok: false, message: add.message };
  }
  const up = await nmPriv(['con', 'up', HOTSPOT_CON], 30_000);
  if (!up.ok) {
    log.error(`Unable to start hotspot: ${up.message}`);
    return { ok: false, message: up.message };
  }
  manualHotspot = manual;
  hotspotSince = Date.now();
  log.info(`Hotspot "${ssid}" started at http://${HOTSPOT_IP}${manual ? '' : ' (no network connection)'}.`);
  return { ok: true, message: `Hotspot "${ssid}" started.` };
}

export async function stopHotspot(reason = ''): Promise<{ ok: boolean; message: string }> {
  if (!(await supported())) return { ok: false, message: unsupportedReason() };
  manualHotspot = false;
  hotspotSince = null;
  const r = await nmPriv(['con', 'down', HOTSPOT_CON], 15_000);
  if (r.ok) log.info(`Hotspot stopped${reason ? ` (${reason})` : ''}.`);
  // Let NetworkManager bring the saved WiFi back up.
  if (await hasSavedWifi()) await nmPriv(['con', 'up', WIFI_CON], 60_000);
  return { ok: true, message: 'Hotspot stopped.' };
}

// ---------- Fallback loop ----------

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let offlineSince: number | null = null;
let hotspotSince: number | null = null;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const r = await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev']);
    if (!r.ok) return;
    const devs = parseDevices(r.stdout);
    const hotspotActive = devs.some((d) => d.connection === HOTSPOT_CON);
    const ethernet = devs.some((d) => d.type === 'ethernet' && d.state === 'connected');
    const wifi = devs.some((d) => d.type === 'wifi' && d.state === 'connected' && d.connection !== HOTSPOT_CON);
    const connected = ethernet || wifi;
    const now = Date.now();
    offlineSince = connected ? null : (offlineSince ?? now);
    if (hotspotActive && hotspotSince === null) hotspotSince = now; // e.g. after an app restart
    const cfg = getConfig();
    const action = decideFallback({
      now, connected, ethernet, hotspotActive, manual: manualHotspot, autoEnabled: cfg.hotspotAuto,
      hasSavedWifi: await hasSavedWifi(), offlineSince, hotspotSince,
    });
    if (action === 'start-hotspot') {
      log.warn('No network connection for 2 minutes. Starting hotspot.');
      await startHotspot(false);
    } else if (action === 'stop-hotspot') {
      await stopHotspot(ethernet ? 'Ethernet connected' : 'automatic hotspot disabled');
    } else if (action === 'retry-wifi') {
      log.info('Retrying saved WiFi network.');
      await stopHotspot('retrying WiFi');
      // If WiFi doesn't come up, offlineSince restarts the grace period and the hotspot returns.
      offlineSince = Date.now();
    }
  } finally {
    ticking = false;
  }
}

export async function start() {
  if (!(await supported())) return;
  timer = setInterval(() => void tick().catch(() => {}), TICK_MS);
  void tick().catch(() => {});
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
