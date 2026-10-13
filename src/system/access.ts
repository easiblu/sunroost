/**
 * OS access settings shown on Configuration › System: internet time / manual clock, HDMI kiosk,
 * Bluetooth, SSH, and USB power cycling. State is read from the OS (systemd, timedatectl,
 * bluetoothctl, sshd config) rather than stored, so it stays true to what the device does.
 *
 * Changes need root. They run directly as root, through passwordless sudo, or else fail with the
 * shell command the user can run themselves.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { logger } from '../core/log.ts';
import { exec, execPriv, hasPrivileges, run } from './exec.ts';
import { parseSshMode, parseTimedatectl, sshConfigText, type SshMode } from './info.ts';

const log = logger('system');
const linux = process.platform === 'linux';

export const KIOSK_UNIT = 'sunroost-kiosk.service';
export const SSH_CONF = '/etc/ssh/sshd_config.d/10-sunroost.conf';

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Command for the user to run when we lack privileges. */
  command?: string;
}

const denied = (command: string): ActionResult => ({
  ok: false,
  message: 'This needs root privileges. Run the command below on the device, or allow the app to use sudo.',
  command,
});

async function systemctl(...args: string[]) {
  return (await run('systemctl', args, 4000))?.trim() ?? null;
}

async function unitExists(unit: string): Promise<boolean> {
  if (!linux) return false;
  const out = await run('systemctl', ['list-unit-files', '--no-legend', unit], 4000);
  return Boolean(out && out.includes(unit));
}

// ---------- Time ----------

export interface TimeInfo {
  supported: boolean;
  /** NTP synchronisation enabled. */
  internetTime: boolean | null;
  synchronized: boolean | null;
  timezone: string | null;
}

export async function timeInfo(): Promise<TimeInfo> {
  if (!linux) return { supported: false, internetTime: null, synchronized: null, timezone: null };
  const out = await run('timedatectl', ['show'], 4000);
  if (!out) return { supported: false, internetTime: null, synchronized: null, timezone: null };
  return { supported: true, ...parseTimedatectl(out) };
}

/** Applies internet time on/off, a manual date/time (local, "YYYY-MM-DD HH:MM") and the OS time zone. */
export async function setTime(opts: { internetTime?: boolean; manual?: string; timezone?: string }): Promise<ActionResult> {
  if (!linux || !(await run('timedatectl', ['--version'], 2000))) return { ok: false, message: 'Setting the clock is only supported on Linux (timedatectl).' };
  const cmds: string[][] = [];
  if (opts.timezone) cmds.push(['set-timezone', opts.timezone]);
  if (opts.internetTime !== undefined) cmds.push(['set-ntp', opts.internetTime ? 'true' : 'false']);
  if (opts.internetTime === false && opts.manual) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(opts.manual)) return { ok: false, message: 'Invalid date/time.' };
    cmds.push(['set-time', opts.manual.length === 16 ? `${opts.manual}:00` : opts.manual]);
  }
  for (const args of cmds) {
    const r = await execPriv('timedatectl', args, { tryPlain: true, timeout: 10_000 });
    if (!r.ok) {
      if (r.denied) return denied(cmds.map((a) => `sudo timedatectl ${a.map(shellQuote).join(' ')}`).join(' && '));
      return { ok: false, message: r.message };
    }
  }
  if (opts.internetTime !== undefined) log.info(opts.internetTime ? 'Internet time enabled.' : `Manual time set${opts.manual ? ` to ${opts.manual}` : ''}.`);
  return { ok: true, message: 'Saved' };
}

// ---------- HDMI kiosk ----------

export interface HdmiInfo {
  supported: boolean;
  mode: 'kiosk' | 'console' | null;
  unit: string;
}

export async function hdmiInfo(): Promise<HdmiInfo> {
  if (!(await unitExists(KIOSK_UNIT))) return { supported: false, mode: null, unit: KIOSK_UNIT };
  const enabled = await systemctl('is-enabled', KIOSK_UNIT);
  return { supported: true, mode: enabled === 'enabled' ? 'kiosk' : 'console', unit: KIOSK_UNIT };
}

export async function setHdmi(mode: 'kiosk' | 'console'): Promise<ActionResult> {
  if (!(await unitExists(KIOSK_UNIT))) return { ok: false, message: `Not supported: ${KIOSK_UNIT} is not installed.` };
  const args = mode === 'kiosk' ? ['enable', '--now', KIOSK_UNIT] : ['disable', '--now', KIOSK_UNIT];
  const r = await execPriv('systemctl', args, { timeout: 30_000 });
  if (!r.ok) return r.denied ? denied(`sudo systemctl ${args.join(' ')}`) : { ok: false, message: r.message };
  log.info(mode === 'kiosk' ? 'HDMI kiosk enabled.' : 'HDMI set to text console.');
  return { ok: true, message: 'Saved' };
}

// ---------- Bluetooth ----------

export type BluetoothMode = 'auto-pair' | 'no-pair' | 'disabled';

export interface BluetoothInfo {
  supported: boolean;
  mode: BluetoothMode | null;
  name: string;
  active: boolean;
}

function hasAdapter() {
  try {
    return linux && existsSync('/sys/class/bluetooth') && readdirSync('/sys/class/bluetooth').some((d) => d.startsWith('hci'));
  } catch {
    return false;
  }
}

export async function bluetoothInfo(): Promise<BluetoothInfo> {
  const name = os.hostname();
  if (!hasAdapter() || !(await unitExists('bluetooth.service'))) return { supported: false, mode: null, name, active: false };
  const active = (await systemctl('is-active', 'bluetooth')) === 'active';
  if (!active) return { supported: true, mode: 'disabled', name, active };
  const show = (await run('bluetoothctl', ['show'], 4000)) ?? '';
  const alias = show.match(/^\s*Alias:\s*(.+)$/m)?.[1]?.trim();
  const discoverable = /^\s*Discoverable:\s*yes/m.test(show);
  return { supported: true, mode: discoverable ? 'auto-pair' : 'no-pair', name: alias || name, active };
}

export async function setBluetooth(mode: BluetoothMode): Promise<ActionResult> {
  if (!hasAdapter()) return { ok: false, message: 'Not supported: no Bluetooth adapter found.' };
  if (mode === 'disabled') {
    const r = await execPriv('systemctl', ['disable', '--now', 'bluetooth'], { timeout: 20_000 });
    if (!r.ok) return r.denied ? denied('sudo systemctl disable --now bluetooth') : { ok: false, message: r.message };
  } else {
    const r = await execPriv('systemctl', ['enable', '--now', 'bluetooth'], { timeout: 20_000 });
    if (!r.ok) return r.denied ? denied('sudo systemctl enable --now bluetooth') : { ok: false, message: r.message };
    const on = mode === 'auto-pair' ? 'on' : 'off';
    // Pairing/discoverability are best effort; bluetoothctl talks to bluetoothd over D-Bus.
    await exec('bluetoothctl', ['discoverable', on], { timeout: 5000 });
    await exec('bluetoothctl', ['pairable', on], { timeout: 5000 });
  }
  log.info(`Bluetooth set to ${mode}.`);
  return { ok: true, message: 'Saved' };
}

// ---------- SSH ----------

export interface SshInfo {
  supported: boolean;
  mode: SshMode | null;
  file: string;
  user: string;
}

const sshUnit = async () => ((await unitExists('ssh.service')) ? 'ssh' : (await unitExists('sshd.service')) ? 'sshd' : null);

export async function sshInfo(): Promise<SshInfo> {
  const user = os.userInfo().username;
  const unit = await sshUnit();
  if (!unit) return { supported: false, mode: null, file: SSH_CONF, user };
  const enabled = (await systemctl('is-enabled', unit)) === 'enabled' || (await systemctl('is-active', unit)) === 'active';
  const conf = await readFile(SSH_CONF, 'utf8').catch(() => '');
  return { supported: true, mode: enabled ? parseSshMode(conf) : 'disabled', file: SSH_CONF, user };
}

export async function setSsh(mode: SshMode): Promise<ActionResult> {
  const unit = await sshUnit();
  if (!unit) return { ok: false, message: 'Not supported: OpenSSH server is not installed.' };
  const text = sshConfigText(mode);
  const command =
    mode === 'disabled'
      ? `sudo systemctl disable --now ${unit}`
      : `printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${SSH_CONF} >/dev/null && sudo systemctl enable --now ${unit} && sudo systemctl reload ${unit}`;
  if (!(await hasPrivileges())) return denied(command);
  if (mode === 'disabled') {
    const r = await execPriv('systemctl', ['disable', '--now', unit], { timeout: 20_000 });
    if (!r.ok) return { ok: false, message: r.message };
  } else {
    const w = await execPriv('tee', [SSH_CONF], { input: text, timeout: 5000 });
    if (!w.ok) return w.denied ? denied(command) : { ok: false, message: w.message };
    const t = await execPriv('sshd', ['-t'], { timeout: 5000 });
    if (!t.ok && !/not found|ENOENT/.test(t.message)) return { ok: false, message: `sshd rejected the configuration: ${t.message}` };
    for (const args of [['enable', '--now', unit], ['reload', unit]]) {
      const r = await execPriv('systemctl', args, { timeout: 20_000 });
      if (!r.ok) return { ok: false, message: r.message };
    }
  }
  log.info(`SSH access set to ${mode === 'disabled' ? 'disabled' : mode === 'key' ? 'key authentication only' : 'key and password authentication'}.`);
  return { ok: true, message: 'Saved' };
}

// ---------- USB power ----------

export async function cycleUsbPower(): Promise<ActionResult> {
  if (!linux) return { ok: false, message: 'Cycling USB power is only supported on Linux.' };
  if (!(await run('uhubctl', ['-v'], 3000)) && !existsSync('/usr/sbin/uhubctl') && !existsSync('/usr/bin/uhubctl')) {
    return { ok: false, message: 'uhubctl is not installed (sudo apt install uhubctl).' };
  }
  log.warn('Cycling USB power (requested from the web UI).');
  const r = await execPriv('uhubctl', ['-a', 'cycle', '-d', '3'], { timeout: 30_000 });
  if (!r.ok) {
    if (r.denied) return denied('sudo uhubctl -a cycle -d 3');
    log.error(`USB power cycle failed: ${r.message}`);
    return { ok: false, message: r.message || 'uhubctl failed' };
  }
  return { ok: true, message: 'USB power cycled.' };
}

/** Everything the System page shows, in one call. */
export async function accessInfo() {
  const [time, hdmi, bluetooth, ssh, privileged] = await Promise.all([timeInfo(), hdmiInfo(), bluetoothInfo(), sshInfo(), hasPrivileges()]);
  return { time, hdmi, bluetooth, ssh, privileged };
}

function shellQuote(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
