/**
 * Parsers for system information sources (sysfs, vcgencmd, lsusb, dmesg, os-release).
 * Pure functions so they can be unit tested on any OS.
 */

/** /sys/class/thermal/thermal_zone0/temp holds millidegrees: "48312\n" → 48.3. */
export function parseCpuTemp(text: string): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return null;
  // Some kernels report whole degrees.
  const c = Math.abs(n) > 1000 ? n / 1000 : n;
  return Math.round(c * 10) / 10;
}

/** /proc/device-tree/model ends with a NUL: "Raspberry Pi 4 Model B Rev 1.4\0" → trimmed. */
export function parseBoardModel(text: string): string | null {
  const s = text.replace(/\0/g, '').trim();
  return s || null;
}

/** PRETTY_NAME from /etc/os-release, e.g. "Debian GNU/Linux 12 (bookworm)". */
export function parseOsRelease(text: string): string | null {
  const m = text.match(/^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m);
  return (m?.[1] ?? m?.[2])?.trim() || null;
}

export interface Throttled {
  raw: string;
  underVoltageNow: boolean;
  frequencyCappedNow: boolean;
  throttledNow: boolean;
  softTempLimitNow: boolean;
  underVoltageOccurred: boolean;
  frequencyCappedOccurred: boolean;
  throttledOccurred: boolean;
  softTempLimitOccurred: boolean;
}

/** `vcgencmd get_throttled` → "throttled=0x50005". Bits: 0–3 now, 16–19 since boot. */
export function parseThrottled(text: string): Throttled | null {
  const m = text.match(/throttled=(0x[0-9a-f]+|\d+)/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const bit = (n: number) => (v & (1 << n)) !== 0;
  return {
    raw: m[1],
    underVoltageNow: bit(0),
    frequencyCappedNow: bit(1),
    throttledNow: bit(2),
    softTempLimitNow: bit(3),
    underVoltageOccurred: bit(16),
    frequencyCappedOccurred: bit(17),
    throttledOccurred: bit(18),
    softTempLimitOccurred: bit(19),
  };
}

/** Number of under-voltage events in a kernel log ("Undervoltage detected!" / "Under-voltage detected!"). */
export function countUnderVoltage(dmesg: string): number {
  return (dmesg.match(/under-?voltage detected/gi) ?? []).length;
}

export interface UsbDevice {
  id: string;
  name: string;
  bus?: string;
  device?: string;
}

/** `lsusb` lines: "Bus 001 Device 003: ID 1a86:7523 QinHeng Electronics CH340 serial converter". */
export function parseLsusb(text: string): UsbDevice[] {
  const out: UsbDevice[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}:[0-9a-f]{4})\s*(.*)$/i);
    if (m) out.push({ bus: m[1], device: m[2], id: m[3].toLowerCase(), name: m[4].trim() || 'Unknown device' });
  }
  return out;
}

/** True for USB root hubs, which every board has and are noise in a device list. */
export function isRootHub(d: UsbDevice) {
  return d.id.startsWith('1d6b:') || /root hub/i.test(d.name);
}

/** Last `limit` lines of a kernel log, newest first, blank lines dropped. */
export function tailLines(text: string, limit: number): string[] {
  return text.split('\n').filter((l) => l.trim()).slice(-limit).reverse();
}

/** `timedatectl show` key=value output → NTP state and time zone. */
export function parseTimedatectl(text: string): { internetTime: boolean | null; synchronized: boolean | null; timezone: string | null } {
  const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  const bool = (v: string | undefined) => (v === 'yes' ? true : v === 'no' ? false : null);
  return { internetTime: bool(get('NTP')), synchronized: bool(get('NTPSynchronized')), timezone: get('Timezone') || null };
}

export type SshMode = 'key,password' | 'key' | 'disabled';

/** SSH mode from our sshd drop-in: PasswordAuthentication no → key only; otherwise key and password. */
export function parseSshMode(conf: string): SshMode {
  const m = conf.match(/^\s*PasswordAuthentication\s+(\S+)/im);
  return m && m[1].toLowerCase() === 'no' ? 'key' : 'key,password';
}

/** Contents of the sshd drop-in for a mode (disabled stops the service instead). */
export function sshConfigText(mode: SshMode): string {
  const pw = mode === 'key' ? 'no' : 'yes';
  return `# Managed by Sunroost (Configuration › System › SSH access)\nPubkeyAuthentication yes\nPasswordAuthentication ${pw}\nKbdInteractiveAuthentication ${pw}\n`;
}

/** Raw `lsusb` lines (including root hubs), for the System USB devices page. */
export function lsusbLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^Bus \d+ Device \d+:/.test(l));
}

/** Disk size like `df -h`: 486G, 29G, 512M. */
export function fmtDiskSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}
