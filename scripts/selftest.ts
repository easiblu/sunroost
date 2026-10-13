/**
 * Hardware self-test: run on a board after installing (`npm run selftest`, or
 * `sudo -u sunroost node scripts/selftest.ts` in /opt/sunroost). Checks what can only be checked on the
 * real thing and prints one line per check; the exit code is non-zero when something failed.
 * See docs/HARDWARE_TEST.md for the full checklist.
 */
import { createSocket } from 'node:dgram';
import { statfs } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadBootConfig } from '../src/config.ts';
import { boardProfile } from '../src/system/board.ts';
import { parseBoardModel } from '../src/system/info.ts';
import { exec } from '../src/system/exec.ts';

type Level = 'ok' | 'warn' | 'fail';
const results: { level: Level; name: string; detail: string }[] = [];
const mark = { ok: '✓', warn: '!', fail: '✗' };
function report(level: Level, name: string, detail: string) {
  results.push({ level, name, detail });
  console.log(`${mark[level]} ${name.padEnd(26)} ${detail}`);
}

const config = loadBootConfig();
const base = `http://127.0.0.1:${config.http.port}`;
const get = async (path: string) => {
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

// Board and runtime
let model = '';
try {
  model = parseBoardModel(readFileSync('/proc/device-tree/model', 'utf8')) ?? '';
} catch {}
const profile = boardProfile(model || `${os.type()} computer`, process.arch, os.totalmem());
report(profile.supported ? 'ok' : 'warn', 'Board', `${profile.name} (${profile.arch}, ${profile.ramMb} MB)${profile.supported ? '' : ': not a supported board'}`);
report('ok', 'Device engine', `${profile.engine.recommended}${profile.engine.reason ? `: ${profile.engine.reason}` : ''}`);
const [maj, min] = process.versions.node.split('.').map(Number);
report(maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'fail', 'Node.js', `${process.version}${maj === 22 ? ' (security support ends April 2027)' : ''}`);

// Storage
try {
  const s = await statfs(config.dataDir);
  const freeGb = (s.bavail * s.bsize) / 1e9;
  report(freeGb > 2 ? 'ok' : freeGb > 0.5 ? 'warn' : 'fail', 'Free disk', `${freeGb.toFixed(1)} GB in ${config.dataDir}`);
} catch (err) {
  report('fail', 'Free disk', (err as Error).message);
}
try {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)');
  db.close();
  const file = new DatabaseSync(join(config.dataDir, 'solar.db'), { readOnly: true });
  const n = (file.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n;
  file.close();
  report('ok', 'Database', `node:sqlite works; ${n} settings in solar.db`);
} catch (err) {
  report('warn', 'Database', `${(err as Error).message} (normal before Sunroost's first start)`);
}

// Native serial binding (inverter and BMS links)
try {
  const { SerialPort } = createRequire(import.meta.url)('serialport') as typeof import('serialport');
  const ports = await SerialPort.list();
  report('ok', 'Serial ports', ports.length ? ports.map((p) => p.path).join(', ') : 'library loads; no adapters plugged in');
} catch (err) {
  report('fail', 'Serial ports', `serialport binding failed: ${(err as Error).message}`);
}

// Multicast (smart-device discovery)
await new Promise<void>((resolve) => {
  const s = createSocket({ type: 'udp4', reuseAddr: true });
  const done = (level: Level, detail: string) => {
    report(level, 'Multicast discovery', detail);
    try {
      s.close();
    } catch {}
    resolve();
  };
  s.on('error', (err) => done('warn', `${err.message}: devices must then be added by address`));
  s.bind(5353, () => {
    try {
      s.addMembership('224.0.0.251');
      done('ok', 'mDNS socket can join 224.0.0.251:5353');
    } catch (err) {
      done('warn', `${(err as Error).message}: devices must then be added by address`);
    }
  });
});

// The running app
const sys = await get('/api/system');
if (!sys) report('fail', 'Sunroost', `not answering on ${base} (systemctl status sunroost; journalctl -u sunroost)`);
else {
  report('ok', 'Sunroost', `running ${sys.version}, Node ${sys.node}, up ${Math.round(sys.appUptime / 60)} min`);
  if (sys.cpuTemp !== null) report(sys.cpuTemp < 75 ? 'ok' : 'warn', 'CPU temperature', `${sys.cpuTemp} °C`);
  if (sys.underVoltage?.count) report('warn', 'Power supply', `${sys.underVoltage.count} under-voltage events: use a better power supply`);
  const mem = sys.memory;
  report(mem.free / mem.total > 0.1 ? 'ok' : 'warn', 'Memory', `${Math.round(mem.used / 1048576)} of ${Math.round(mem.total / 1048576)} MB used`);
}
const home = await get('/api/home/status');
if (home) {
  report(home.active ? 'ok' : 'fail', 'Smart devices', `${home.active ?? 'no'} engine active (setting ${home.setting})`);
  for (const e of home.engines.filter((x: { running: boolean; id: string }) => x.running && (x.id === 'lite' || x.id === 'full'))) {
    if (e.id === 'full') report(e.info?.state === 'connected' ? 'ok' : 'fail', 'Home Assistant', e.info?.state === 'connected' ? `${e.info.version}, ${e.info.entities} entities` : e.info?.message ?? 'not connected');
    else for (const d of e.info?.drivers ?? []) if (d.state === 'error') report('warn', `Driver ${d.name}`, d.message ?? 'error');
  }
}
const mqtt = await get('/api/mqtt/status');
if (mqtt?.enabled) report(mqtt.running ? 'ok' : 'fail', 'MQTT broker', mqtt.running ? `${mqtt.broker} on port ${mqtt.port}, ${mqtt.clients} clients` : mqtt.lastError ?? 'not running');

// Home Assistant service (full engine boards)
if (process.platform === 'linux') {
  const unit = await exec('systemctl', ['is-active', 'sunroost-homeassistant'], { timeout: 3000 });
  const state = unit.stdout.trim() || unit.message;
  if (state !== 'inactive' && !/could not be found|not-found/i.test(state)) {
    report(state === 'active' ? 'ok' : 'fail', 'HA service', `sunroost-homeassistant: ${state}`);
  }
  const ntp = await exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 3000 });
  if (ntp.ok) report(ntp.stdout.trim() === 'yes' ? 'ok' : 'warn', 'Clock', ntp.stdout.trim() === 'yes' ? 'synchronised' : 'not synchronised (schedules may run at the wrong time)');
}

const failed = results.filter((r) => r.level === 'fail').length;
const warned = results.filter((r) => r.level === 'warn').length;
console.log(`\n${failed ? `${failed} failed` : 'No failures'}${warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : ''}.`);
process.exit(failed ? 1 : 0);
