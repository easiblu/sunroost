/**
 * System subsystem: device information (board, CPU temperature, memory, disk, USB, under-voltage),
 * the kernel log, and reboot / shutdown / restart-app actions. Every external command runs through
 * execFile with a timeout and failures degrade to null, so this works (with less detail) off a Pi.
 */
import { readFile, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { dbPath } from '../core/db.ts';
import { logger } from '../core/log.ts';
import { boardProfile, type BoardProfile } from './board.ts';
import { execPriv, run } from './exec.ts';
import {
  countUnderVoltage, lsusbLines, isRootHub, parseBoardModel, parseCpuTemp, parseLsusb, parseOsRelease, parseThrottled,
  tailLines, type Throttled, type UsbDevice,
} from './info.ts';

const log = logger('system');
const root = join(import.meta.dirname, '..', '..');
const CHECK_MS = 60_000;
const CACHE_MS = 5_000;
const HOT_C = 80;

let version = '0.0.0';
let canPower = false;
let timer: NodeJS.Timeout | null = null;
let lastUnderVoltage = 0;
let wasHot = false;
let cache: { at: number; info: Promise<SystemInfo> } | null = null;

export interface SystemInfo {
  version: string;
  hostname: string;
  board: string;
  os: string;
  arch: string;
  isPi: boolean;
  /** Supported-board check and which smart-device engine fits this hardware. */
  profile: BoardProfile;
  canPower: boolean;
  uptime: number;
  appUptime: number;
  node: string;
  cpuTemp: number | null;
  loadavg: number[];
  cpus: number;
  memory: { total: number; free: number; used: number };
  disk: { path: string; total: number; free: number; used: number; type: string | null } | null;
  underVoltage: { count: number | null; throttled: Throttled | null } | null;
  usbDevices: UsbDevice[];
  serialPorts: { path: string; label: string }[];
  ip: { iface: string; address: string; family: string }[];
  time: number;
  timezone: string;
}

export { run } from './exec.ts';

/** Like run() but keeps the error message, for user-facing actions. */
async function runChecked(cmd: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; message: string }> {
  const r = await execPriv(cmd, args, { timeout, tryPlain: true });
  return { ok: r.ok, message: r.ok ? 'ok' : r.message };
}

const readText = (path: string) => readFile(path, 'utf8').catch(() => null);

export async function start() {
  try {
    version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? version;
  } catch {
    // Keep the placeholder.
  }
  canPower = process.platform === 'linux' && (await run('systemctl', ['--version'], 2000)) !== null;
  const info = await systemInfo();
  log.info(`Sunroost ${version} on ${info.board} (${info.os}), Node ${process.versions.node}.`);
  lastUnderVoltage = info.underVoltage?.count ?? 0;
  if (lastUnderVoltage > 0) log.warn(underVoltageMessage(lastUnderVoltage));
  timer = setInterval(() => void check(), CHECK_MS);
}

export async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function underVoltageMessage(count: number) {
  return `Device experienced ${count} voltage dip${count === 1 ? '' : 's'} since boot. Confirm the USB power supply is 5V and 3A; voltage dips cause USB communication errors.`;
}

/** Periodic health check: logs new voltage dips and CPU over-temperature. */
async function check() {
  const [count, temp] = await Promise.all([underVoltageCount(), cpuTemp()]);
  if (count !== null && count > lastUnderVoltage) log.warn(underVoltageMessage(count));
  if (count !== null) lastUnderVoltage = count;
  if (temp === null) return;
  if (temp >= HOT_C && !wasHot) {
    wasHot = true;
    log.warn(`CPU temperature is high: ${temp} °C.`);
  } else if (temp < HOT_C - 5) {
    wasHot = false; // hysteresis so a hovering temperature doesn't spam the log
  }
}

async function cpuTemp() {
  const text = await readText('/sys/class/thermal/thermal_zone0/temp');
  return text === null ? null : parseCpuTemp(text);
}

async function underVoltageCount(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  const dmesg = await run('dmesg', [], 4000);
  return dmesg === null ? null : countUnderVoltage(dmesg);
}

async function board(): Promise<{ board: string; isPi: boolean }> {
  const model = parseBoardModel((await readText('/proc/device-tree/model')) ?? '');
  if (model) return { board: model, isPi: /raspberry pi/i.test(model) };
  const cpu = os.cpus()[0]?.model?.trim();
  const kind = process.platform === 'darwin' ? 'Mac' : process.platform === 'linux' ? 'Linux computer' : process.platform;
  return { board: cpu ? `${kind} (${cpu})` : kind, isPi: false };
}

async function osName() {
  const pretty = parseOsRelease((await readText('/etc/os-release')) ?? '');
  if (pretty) return pretty;
  if (process.platform === 'darwin') {
    const v = await run('sw_vers', ['-productVersion'], 2000);
    if (v) return `macOS ${v.trim()}`;
  }
  return `${os.type()} ${os.release()}`;
}

async function usbDevices(): Promise<UsbDevice[]> {
  const lsusb = await run('lsusb', [], 3000);
  if (lsusb !== null) return parseLsusb(lsusb).filter((d) => !isRootHub(d));
  // Fallback: sysfs, one directory per device with idVendor/idProduct/product.
  const base = '/sys/bus/usb/devices';
  const entries = await readdir(base).catch(() => [] as string[]);
  const out: UsbDevice[] = [];
  for (const e of entries) {
    if (e.includes(':')) continue; // interfaces, not devices
    const [vendor, product, name, maker] = await Promise.all(
      ['idVendor', 'idProduct', 'product', 'manufacturer'].map((f) => readText(join(base, e, f))),
    );
    if (!vendor || !product) continue;
    const d = { id: `${vendor.trim()}:${product.trim()}`, name: [maker?.trim(), name?.trim()].filter(Boolean).join(' ') || 'Unknown device' };
    if (!isRootHub(d)) out.push(d);
  }
  return out;
}

async function serialPorts(): Promise<{ path: string; label: string }[]> {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path, label: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(' · ') }));
  } catch {
    return [];
  }
}

async function disk(path: string) {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path, total, free, used: total - free, type: await storageType(path) };
  } catch {
    return null;
  }
}

/** Kind of storage holding a path (Linux): SD card, eMMC, NVMe SSD or USB drive. */
async function storageType(path: string): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const source = (await run('findmnt', ['-n', '-o', 'SOURCE', '--target', path], 3000))?.trim();
  if (!source) return null;
  const dev = source.replace(/^\/dev\//, '');
  if (dev.startsWith('mmcblk')) {
    const base = dev.replace(/p\d+$/, '');
    const kind = (await readText(`/sys/block/${base}/device/type`))?.trim();
    return kind === 'MMC' ? 'eMMC' : 'SD card';
  }
  if (dev.startsWith('nvme')) return 'NVMe SSD';
  if (dev.startsWith('sd')) return 'USB drive';
  return source;
}

function addresses() {
  const out: { iface: string; address: string; family: string }[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || (a.family === 'IPv6' && a.address.startsWith('fe80'))) continue;
      out.push({ iface, address: a.address, family: a.family });
    }
  }
  return out;
}

async function gather(): Promise<SystemInfo> {
  const dataDir = dbPath() && dbPath() !== ':memory:' ? dirname(dbPath()) : process.cwd();
  const [b, osText, temp, uvCount, throttledText, usb, ports, d] = await Promise.all([
    board(),
    osName(),
    cpuTemp(),
    underVoltageCount(),
    run('vcgencmd', ['get_throttled'], 2000),
    usbDevices(),
    serialPorts(),
    disk(dataDir),
  ]);
  const throttled = throttledText ? parseThrottled(throttledText) : null;
  const total = os.totalmem();
  const free = os.freemem();
  return {
    version,
    hostname: os.hostname(),
    board: b.board,
    os: osText,
    arch: process.arch,
    isPi: b.isPi,
    profile: boardProfile(b.board, process.arch, total),
    canPower,
    uptime: Math.round(os.uptime()),
    appUptime: Math.round(process.uptime()),
    node: process.versions.node,
    cpuTemp: temp,
    loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
    cpus: os.cpus().length,
    memory: { total, free, used: total - free },
    disk: d,
    underVoltage: uvCount === null && !throttled ? null : { count: uvCount, throttled },
    usbDevices: usb,
    serialPorts: ports,
    ip: addresses(),
    time: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** System information, cached for a few seconds so polling pages don't spawn many processes. */
let profileCache: BoardProfile | null = null;

/** Board profile for this machine (cached: the hardware doesn't change while running). */
export async function hardwareProfile(): Promise<BoardProfile> {
  profileCache ??= boardProfile((await board()).board, process.arch, os.totalmem());
  return profileCache;
}

export function systemInfo(): Promise<SystemInfo> {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), info: gather() };
  return cache.info;
}

/** Tail of the kernel log (UTC timestamps), newest first, plus the raw USB device list. */
export async function kernelLog(limit = 500): Promise<{ available: boolean; lines: string[]; error: string | null; usb: string[] }> {
  const lsusb = process.platform === 'linux' ? await run('lsusb', [], 3000) : null;
  const usb = lsusb ? lsusbLines(lsusb) : (await usbDevices()).map((d) => `${d.bus ? `Bus ${d.bus} Device ${d.device}: ` : ''}ID ${d.id} ${d.name}`);
  if (process.platform !== 'linux') return { available: false, lines: [], error: 'The kernel log is only available on Linux.', usb };
  const env = { ...process.env, TZ: 'UTC' };
  const text = (await run('dmesg', ['--time-format', 'iso'], 5000, env)) ?? (await run('dmesg', ['-T'], 5000, env)) ?? (await run('dmesg', [], 5000, env));
  if (text === null) return { available: false, lines: [], error: 'Unable to read the kernel log (dmesg needs permission).', usb };
  return { available: true, lines: tailLines(text, limit), error: null, usb };
}

export type PowerAction = 'reboot' | 'shutdown' | 'restart-app';

/**
 * Reboot/shutdown via systemctl (Linux only). Restart-app exits gracefully (SIGTERM → the normal
 * shutdown path, exit code 0) shortly after the HTTP response is sent; systemd starts it again.
 */
export async function perform(action: PowerAction): Promise<{ ok: boolean; status: number; message: string }> {
  if (action === 'restart-app') {
    log.info('Restarting application (requested from the web UI).');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    return { ok: true, status: 200, message: 'Restarting application' };
  }
  if (!canPower) return { ok: false, status: 501, message: `${action === 'reboot' ? 'Reboot' : 'Shutdown'} is only supported on Linux with systemd.` };
  log.info(action === 'reboot' ? 'Rebooting device (requested from the web UI).' : 'Shutting down device (requested from the web UI).');
  const res = await runChecked('systemctl', [action === 'reboot' ? 'reboot' : 'poweroff']);
  if (!res.ok) {
    log.error(`${action} failed: ${res.message}`);
    return { ok: false, status: 500, message: res.message };
  }
  return { ok: true, status: 200, message: action === 'reboot' ? 'Rebooting' : 'Shutting down' };
}

/** Seconds the UI should wait before trying to reconnect (reboot/restart) or before power can be cut. */
export const ACTION_SECONDS: Record<PowerAction, number> = { reboot: 60, shutdown: 20, 'restart-app': 10 };
