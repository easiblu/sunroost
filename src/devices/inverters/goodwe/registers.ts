/**
 * GoodWe register maps.
 *
 * ET family (ET / EH / BT / BH, ET G2, ES G2 / ES Uniq, EHB …): Modbus, unit 0xF7 (247).
 * Holding registers (function 3) only:
 *   35000+  device info (model name, serial, firmware)
 *   35100+  live data
 *   36000+  smart meter
 *   37000+  BMS (battery SOC / SOH / temperature)
 *   45000+, 47000+  settings
 * Values are big-endian; 32-bit values are HIGH word first. Sources: GoodWe's public "ET/EH
 * Modbus protocol" register list, as also documented by open-source GoodWe tools. Nothing here is
 * checked on hardware yet. Each row's note says "confident" (consistent across every source seen)
 * or "UNVERIFIED" (one source / recalled / sign or scale uncertain).
 *
 * GoodWe sign conventions (converted to Sunroost's in deriveEt):
 *   - battery current / power: + = discharging   → we report + = charging
 *   - meter / active power:    + = exporting     → we report + = importing
 *
 * ES family (older ES / EM / BP): proprietary AA55 protocol; the running-info reply is a byte
 * payload decoded by offset (ES_RUNNING below, all UNVERIFIED).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** Registers for 'ascii'. */
  words?: number;
  scale?: number;
  metric: string;
  enum?: Record<number, string>;
  note: string;
}

export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

/** Registers → printable ASCII, NULs / 0xFF / non-printables dropped. */
export function decodeAscii(words: number[]): string {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

function wordCount(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const w: number[] = [];
  for (let i = 0; i < wordCount(def); i++) {
    const v = regs.get(def.addr + i);
    if (v === undefined) return undefined;
    w.push(v);
  }
  if (def.type === 'ascii') return decodeAscii(w);
  let raw: number;
  switch (def.type ?? 'u16') {
    case 's16':
      raw = w[0] > 0x7fff ? w[0] - 0x10000 : w[0];
      break;
    case 'u32':
      raw = (w[0] * 0x10000 + w[1]) >>> 0;
      break;
    case 's32':
      raw = (w[0] << 16) | w[1];
      break;
    default:
      raw = w[0];
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (${raw})`;
  const scale = def.scale ?? 1;
  return scale === 1 ? raw : round(raw * scale, digitsFor(scale));
}

export function decodeTable(defs: RegDef[], regs: RegisterImage): Metrics {
  const out: Metrics = {};
  for (const def of defs) {
    const v = decodeOne(def, regs);
    if (v !== undefined) out[def.metric] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ET family: device info 35000+

/** Read span for device info: 35000–35032. */
export const INFO_SPAN: [number, number] = [35000, 33];

export const ET_INFO: RegDef[] = [
  { addr: 35000, metric: 'Protocol version', note: '35000 Modbus protocol version (confident)' },
  { addr: 35001, metric: 'Rated power', note: '35001 rated power W (confident)' },
  { addr: 35003, type: 'ascii', words: 8, metric: 'Serial number', note: '35003–35010 serial, 16 ASCII (confident)' },
  { addr: 35011, type: 'ascii', words: 5, metric: 'Model name', note: '35011–35015 model name, 10 ASCII (confident)' },
  { addr: 35016, metric: 'DSP1 version', note: '35016 DSP1 version (confident)' },
  { addr: 35017, metric: 'DSP2 version', note: '35017 DSP2 version (UNVERIFIED)' },
  { addr: 35019, metric: 'ARM version', note: '35019 ARM version (confident)' },
  { addr: 35021, type: 'ascii', words: 6, metric: 'Firmware version', note: '35021–35026 DSP firmware, 12 ASCII (UNVERIFIED)' },
  { addr: 35027, type: 'ascii', words: 6, metric: 'Secondary firmware version', note: '35027–35032 ARM firmware, 12 ASCII (UNVERIFIED)' },
];

// ---------------------------------------------------------------------------------------------
// ET family: live data 35100+

/** Live block 35100–35224 (125 registers). */
export const LIVE_SPAN: [number, number] = [35100, 125];
/** Meter 36000–36014 (optional). */
export const METER_SPAN: [number, number] = [36000, 15];
/** BMS 37000–37011 (optional). */
export const BMS_SPAN: [number, number] = [37000, 12];

/** 35187 work mode (confident for 0–5). */
export const WORK_MODES: Record<number, string> = {
  0: 'Wait',
  1: 'On-grid',
  2: 'Off-grid',
  3: 'Fault',
  4: 'Flash',
  5: 'Check',
};

/** 35184 battery mode (confident). */
export const BATTERY_MODES: Record<number, string> = {
  0: 'No battery',
  1: 'Standby',
  2: 'Discharging',
  3: 'Charging',
  4: 'Waiting to charge',
  5: 'Waiting to discharge',
};

const pvString = (n: number): RegDef[] => {
  const base = 35103 + (n - 1) * 4;
  const c = n <= 2 ? 'confident' : 'UNVERIFIED';
  return [
    { addr: base, scale: 0.1, metric: `PV voltage ${n}`, note: `${base} PV${n} voltage 0.1 V (${c})` },
    { addr: base + 1, scale: 0.1, metric: `PV current ${n}`, note: `${base + 1} PV${n} current 0.1 A (${c})` },
    { addr: base + 2, type: 'u32', metric: `PV power ${n}`, note: `${base + 2}–${base + 3} PV${n} power W, u32 (${c})` },
  ];
};

const gridPhase = (n: number): RegDef[] => {
  const base = 35121 + (n - 1) * 5;
  const c = n === 1 ? 'confident' : 'UNVERIFIED';
  return [
    { addr: base, scale: 0.1, metric: `Grid voltage ${n}`, note: `${base} on-grid L${n} voltage 0.1 V (${c})` },
    { addr: base + 1, scale: 0.1, metric: `Grid current ${n}`, note: `${base + 1} on-grid L${n} current 0.1 A (${c})` },
    { addr: base + 2, scale: 0.01, metric: `Grid frequency ${n}`, note: `${base + 2} on-grid L${n} frequency 0.01 Hz (${c})` },
    { addr: base + 3, type: 's32', metric: `Inverter power ${n}`, note: `${base + 3}–${base + 4} on-grid L${n} power W, s32 (UNVERIFIED: older docs say s16 at ${base + 4})` },
  ];
};

const backupPhase = (n: number): RegDef[] => {
  const base = 35145 + (n - 1) * 6;
  return [
    { addr: base, scale: 0.1, metric: `AC output voltage ${n}`, note: `${base} back-up L${n} voltage 0.1 V (${n === 1 ? 'confident' : 'UNVERIFIED'})` },
    { addr: base + 1, scale: 0.1, metric: `AC output current ${n}`, note: `${base + 1} back-up L${n} current 0.1 A (UNVERIFIED)` },
    { addr: base + 2, scale: 0.01, metric: `AC output frequency ${n}`, note: `${base + 2} back-up L${n} frequency 0.01 Hz (UNVERIFIED)` },
    { addr: base + 4, type: 's32', metric: `Backup power ${n}`, note: `${base + 4}–${base + 5} back-up L${n} power W, s32 (UNVERIFIED)` },
  ];
};

export const ET_LIVE: RegDef[] = [
  ...pvString(1), ...pvString(2), ...pvString(3), ...pvString(4),
  ...gridPhase(1), ...gridPhase(2), ...gridPhase(3),
  { addr: 35136, metric: 'Grid mode', note: '35136 grid mode (UNVERIFIED: 0 off, 1 on-grid, 2 fault)' },
  { addr: 35137, type: 's32', metric: 'Inverter power', note: '35137–35138 total inverter power W, s32 (confident)' },
  { addr: 35139, type: 's32', metric: 'Active power', note: '35139–35140 grid active power W, s32, + = export (sign medium confidence)' },
  { addr: 35143, type: 's32', metric: 'Apparent power raw', note: '35143–35144 apparent power VA, s32 (UNVERIFIED)' },
  ...backupPhase(1), ...backupPhase(2), ...backupPhase(3),
  { addr: 35163, type: 's32', metric: 'Load power 1', note: '35163–35164 load L1 W, s32 (UNVERIFIED)' },
  { addr: 35165, type: 's32', metric: 'Load power 2', note: '35165–35166 load L2 W, s32 (UNVERIFIED)' },
  { addr: 35167, type: 's32', metric: 'Load power 3', note: '35167–35168 load L3 W, s32 (UNVERIFIED)' },
  { addr: 35169, type: 's32', metric: 'Backup power', note: '35169–35170 total back-up power W, s32 (UNVERIFIED)' },
  { addr: 35171, type: 's32', metric: 'Load power raw', note: '35171–35172 total load power W, s32 (UNVERIFIED)' },
  { addr: 35173, metric: 'Load percentage', note: '35173 back-up (UPS) load % (confident)' },
  { addr: 35174, type: 's16', scale: 0.1, metric: 'Temperature air', note: '35174 air temperature 0.1 °C (confident)' },
  { addr: 35175, type: 's16', scale: 0.1, metric: 'Temperature module', note: '35175 module temperature 0.1 °C (confident)' },
  { addr: 35176, type: 's16', scale: 0.1, metric: 'Temperature radiator', note: '35176 radiator temperature 0.1 °C (confident)' },
  { addr: 35178, scale: 0.1, metric: 'Bus voltage', note: '35178 bus voltage 0.1 V (confident)' },
  { addr: 35180, scale: 0.1, metric: 'Battery voltage', note: '35180 battery voltage 0.1 V (confident)' },
  { addr: 35181, type: 's16', scale: 0.1, metric: 'Battery current raw', note: '35181 battery current 0.1 A, s16, + = discharge (confident)' },
  { addr: 35182, type: 's32', metric: 'Battery power raw', note: '35182–35183 battery power W, s32, + = discharge (medium)' },
  { addr: 35184, metric: 'Battery mode', enum: BATTERY_MODES, note: '35184 battery mode (confident)' },
  { addr: 35185, metric: 'Warning code', note: '35185 warning bits (confident)' },
  { addr: 35186, metric: 'Safety country', note: '35186 safety country code (confident)' },
  { addr: 35187, metric: 'Device mode', enum: WORK_MODES, note: '35187 work mode (confident)' },
  { addr: 35189, type: 'u32', metric: 'Error code raw', note: '35189–35190 error bits, u32 (confident)' },
  { addr: 35191, type: 'u32', scale: 0.1, metric: 'PV energy total', note: '35191–35192 total PV generation 0.1 kWh (confident)' },
  { addr: 35193, type: 'u32', scale: 0.1, metric: 'PV energy today', note: '35193–35194 today PV generation 0.1 kWh (confident)' },
  { addr: 35195, type: 'u32', scale: 0.1, metric: 'Export energy total', note: '35195–35196 total export 0.1 kWh (medium)' },
  { addr: 35199, scale: 0.1, metric: 'Export energy today', note: '35199 today export 0.1 kWh (medium)' },
  { addr: 35200, type: 'u32', scale: 0.1, metric: 'Import energy total', note: '35200–35201 total import 0.1 kWh (medium)' },
  { addr: 35202, scale: 0.1, metric: 'Import energy today', note: '35202 today import 0.1 kWh (medium)' },
  { addr: 35203, type: 'u32', scale: 0.1, metric: 'Load energy total', note: '35203–35204 total load 0.1 kWh (medium)' },
  { addr: 35205, scale: 0.1, metric: 'Load energy today', note: '35205 today load 0.1 kWh (medium)' },
  { addr: 35206, type: 'u32', scale: 0.1, metric: 'Charge energy total', note: '35206–35207 total battery charge 0.1 kWh (medium)' },
  { addr: 35208, scale: 0.1, metric: 'Charge energy today', note: '35208 today battery charge 0.1 kWh (medium)' },
  { addr: 35209, type: 'u32', scale: 0.1, metric: 'Discharge energy total', note: '35209–35210 total battery discharge 0.1 kWh (medium)' },
  { addr: 35211, scale: 0.1, metric: 'Discharge energy today', note: '35211 today battery discharge 0.1 kWh (medium)' },
];

export const ET_METER: RegDef[] = [
  { addr: 36004, metric: 'Meter status', note: '36004 meter comm status, 1 = OK (UNVERIFIED)' },
  { addr: 36005, type: 's16', metric: 'Meter power 1', note: '36005 meter L1 active power W, + = export (UNVERIFIED)' },
  { addr: 36006, type: 's16', metric: 'Meter power 2', note: '36006 meter L2 active power W, + = export (UNVERIFIED)' },
  { addr: 36007, type: 's16', metric: 'Meter power 3', note: '36007 meter L3 active power W, + = export (UNVERIFIED)' },
  { addr: 36008, type: 's16', metric: 'Meter power', note: '36008 meter total active power W, + = export (UNVERIFIED)' },
];

export const ET_BMS: RegDef[] = [
  { addr: 37003, type: 's16', scale: 0.1, metric: 'Battery temperature', note: '37003 BMS battery temperature 0.1 °C (confident)' },
  { addr: 37004, metric: 'BMS charge limit', note: '37004 BMS charge current limit A (confident)' },
  { addr: 37005, metric: 'BMS discharge limit', note: '37005 BMS discharge current limit A (confident)' },
  { addr: 37007, metric: 'Battery state of charge', note: '37007 BMS SOC % (confident)' },
  { addr: 37008, metric: 'Battery state of health', note: '37008 BMS SOH % (confident)' },
];

function num(m: Metrics, k: string): number {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw ET table values (live + meter + BMS) → Sunroost metrics. */
export function deriveEt(raw: Metrics, opts: { phases: 1 | 2 | 3; pvStrings?: number }): Metrics {
  const out: Metrics = {};
  const strings = opts.pvStrings ?? 4;
  let pv = 0;
  for (let n = 1; n <= strings; n++) {
    if (!has(raw, `PV voltage ${n}`)) continue;
    // Unused strings 3–4 are hidden when they read nothing.
    if (n > 2 && !num(raw, `PV voltage ${n}`) && !num(raw, `PV power ${n}`)) continue;
    for (const k of ['PV voltage', 'PV current', 'PV power']) out[`${k} ${n}`] = raw[`${k} ${n}`];
    pv += num(raw, `PV power ${n}`);
  }
  out['PV power'] = pv;

  for (const k of ['Battery voltage', 'Battery state of charge', 'Battery state of health', 'Battery temperature', 'Bus voltage', 'Load percentage', 'Device mode', 'Battery mode']) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  // GoodWe: + = discharge; Sunroost: + = charging.
  if (has(raw, 'Battery current raw')) out['Battery current'] = round(-num(raw, 'Battery current raw'), 1);
  const battery = -num(raw, 'Battery power raw');
  out['Battery power'] = battery;

  // Grid: active power is + = export; prefer the meter total when the meter is online.
  const meterOk = has(raw, 'Meter power') && (!has(raw, 'Meter status') || num(raw, 'Meter status') === 1);
  const grid = meterOk ? -num(raw, 'Meter power') : -num(raw, 'Active power');
  out['Grid power'] = grid;
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'Grid frequency 1')) out['Grid frequency'] = raw['Grid frequency 1'];
  if (has(raw, 'AC output voltage 1')) out['AC output voltage'] = raw['AC output voltage 1'];
  if (has(raw, 'AC output frequency 1')) out['AC output frequency'] = raw['AC output frequency 1'];
  if (has(raw, 'Backup power')) out['Backup power'] = raw['Backup power'];
  if (has(raw, 'Inverter power')) out['Inverter power'] = raw['Inverter power'];
  if (opts.phases > 1) {
    for (let p = 1; p <= opts.phases; p++) {
      for (const k of ['Grid voltage', 'Grid current', 'AC output voltage', 'Load power']) {
        if (raw[`${k} ${p}`] !== undefined) out[`${k} ${p}`] = raw[`${k} ${p}`];
      }
      if (meterOk && has(raw, `Meter power ${p}`)) out[`Grid power ${p}`] = -num(raw, `Meter power ${p}`);
    }
  } else if (has(raw, 'Grid current 1')) {
    out['Grid current'] = raw['Grid current 1'];
  }

  // House load by energy balance (PV + discharge + import), as GoodWe's own apps show it.
  out['Load power'] = Math.max(0, Math.round(pv - battery + grid));

  const temps = ['Temperature radiator', 'Temperature module', 'Temperature air'].filter((k) => has(raw, k)).map((k) => num(raw, k));
  if (temps.length) out.Temperature = Math.max(...temps);
  if (has(raw, 'Error code raw')) {
    const e = num(raw, 'Error code raw');
    out['Fault code'] = e ? `0x${e.toString(16).toUpperCase().padStart(8, '0')}` : 'None';
  }
  for (const k of [
    'PV energy total', 'PV energy today', 'Export energy total', 'Export energy today', 'Import energy total', 'Import energy today',
    'Load energy total', 'Load energy today', 'Charge energy total', 'Charge energy today', 'Discharge energy total', 'Discharge energy today',
  ]) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

/** ET device-info registers → info metrics (blank strings dropped). */
export function decodeEtInfo(regs: RegisterImage): Metrics {
  const t = decodeTable(ET_INFO, regs);
  const out: Metrics = {};
  for (const k of ['Serial number', 'Model name', 'Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  if (!out['Firmware version'] && has(t, 'DSP1 version') && has(t, 'ARM version')) {
    out['Firmware version'] = `${t['DSP1 version']}.${t['ARM version']}`;
  }
  if (has(t, 'Rated power') && num(t, 'Rated power') > 0) out['Max AC output power'] = t['Rated power'];
  return out;
}

// ---------------------------------------------------------------------------------------------
// ES family (AA55 protocol). Byte offsets into the reply payload (after the 7-byte header).

/** Running-info (0x01/0x06) payload field. */
export interface ByteDef {
  off: number;
  type: 'u8' | 'u16' | 's16' | 'u32';
  scale?: number;
  metric: string;
  enum?: Record<number, string>;
  note: string;
}

/** ES work mode (byte 52), UNVERIFIED. */
export const ES_WORK_MODES: Record<number, string> = { 0: 'Wait', 1: 'On-grid', 2: 'Off-grid', 3: 'Fault', 4: 'Flash', 5: 'Check' };

/** ES grid flow (byte 80), UNVERIFIED: 0 idle, 1 exporting, 2 importing. */
export const ES_RUNNING: ByteDef[] = [
  { off: 0, type: 'u16', scale: 0.1, metric: 'PV voltage 1', note: 'payload 0 PV1 voltage 0.1 V (UNVERIFIED)' },
  { off: 2, type: 'u16', scale: 0.1, metric: 'PV current 1', note: 'payload 2 PV1 current 0.1 A (UNVERIFIED)' },
  { off: 5, type: 'u16', scale: 0.1, metric: 'PV voltage 2', note: 'payload 5 PV2 voltage 0.1 V (UNVERIFIED)' },
  { off: 7, type: 'u16', scale: 0.1, metric: 'PV current 2', note: 'payload 7 PV2 current 0.1 A (UNVERIFIED)' },
  { off: 10, type: 'u16', scale: 0.1, metric: 'Battery voltage', note: 'payload 10 battery voltage 0.1 V (UNVERIFIED)' },
  { off: 16, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'payload 16 battery temperature 0.1 °C (UNVERIFIED)' },
  { off: 18, type: 'u16', scale: 0.1, metric: 'Battery current abs', note: 'payload 18 battery current 0.1 A, unsigned (UNVERIFIED)' },
  { off: 26, type: 'u8', metric: 'Battery state of charge', note: 'payload 26 SOC % (UNVERIFIED)' },
  { off: 29, type: 'u8', metric: 'Battery state of health', note: 'payload 29 SOH % (UNVERIFIED)' },
  { off: 30, type: 'u8', metric: 'Battery mode', enum: BATTERY_MODES, note: 'payload 30 battery mode (UNVERIFIED)' },
  { off: 34, type: 'u16', scale: 0.1, metric: 'Grid voltage', note: 'payload 34 grid voltage 0.1 V (UNVERIFIED)' },
  { off: 36, type: 'u16', scale: 0.1, metric: 'Grid current', note: 'payload 36 grid current 0.1 A (UNVERIFIED)' },
  { off: 38, type: 's16', metric: 'Grid power abs', note: 'payload 38 grid power W, magnitude (UNVERIFIED)' },
  { off: 40, type: 'u16', scale: 0.01, metric: 'Grid frequency', note: 'payload 40 grid frequency 0.01 Hz (UNVERIFIED)' },
  { off: 43, type: 'u16', scale: 0.1, metric: 'AC output voltage', note: 'payload 43 back-up voltage 0.1 V (UNVERIFIED)' },
  { off: 45, type: 'u16', scale: 0.1, metric: 'AC output current', note: 'payload 45 back-up current 0.1 A (UNVERIFIED)' },
  { off: 47, type: 'u16', metric: 'On-grid load power', note: 'payload 47 on-grid load power W (UNVERIFIED)' },
  { off: 49, type: 'u16', scale: 0.01, metric: 'AC output frequency', note: 'payload 49 back-up frequency 0.01 Hz (UNVERIFIED)' },
  { off: 52, type: 'u8', metric: 'Device mode', enum: ES_WORK_MODES, note: 'payload 52 work mode (UNVERIFIED)' },
  { off: 53, type: 's16', scale: 0.1, metric: 'Temperature', note: 'payload 53 inverter temperature 0.1 °C (UNVERIFIED)' },
  { off: 55, type: 'u32', metric: 'Error code raw', note: 'payload 55–58 error bits (UNVERIFIED)' },
  { off: 59, type: 'u32', scale: 0.1, metric: 'PV energy total', note: 'payload 59–62 total PV 0.1 kWh (UNVERIFIED)' },
  { off: 67, type: 'u16', scale: 0.1, metric: 'PV energy today', note: 'payload 67 today PV 0.1 kWh (UNVERIFIED)' },
  { off: 80, type: 'u8', metric: 'Grid flow', note: 'payload 80 grid in/out: 0 idle, 1 export, 2 import (UNVERIFIED)' },
  { off: 81, type: 's16', metric: 'Backup load power', note: 'payload 81 back-up power W (UNVERIFIED)' },
];

export function decodeBytes(defs: ByteDef[], data: Uint8Array): Metrics {
  const b = Buffer.from(data);
  const out: Metrics = {};
  for (const d of defs) {
    const size = d.type === 'u8' ? 1 : d.type === 'u32' ? 4 : 2;
    if (d.off + size > b.length) continue;
    const raw = d.type === 'u8' ? b[d.off] : d.type === 'u16' ? b.readUInt16BE(d.off) : d.type === 's16' ? b.readInt16BE(d.off) : b.readUInt32BE(d.off);
    if (d.enum) out[d.metric] = d.enum[raw] ?? `Unknown (${raw})`;
    else out[d.metric] = d.scale ? round(raw * d.scale, digitsFor(d.scale)) : raw;
  }
  return out;
}

/** Raw ES running-info values → Sunroost metrics. */
export function deriveEs(raw: Metrics): Metrics {
  const out: Metrics = {};
  let pv = 0;
  for (const n of [1, 2]) {
    if (!has(raw, `PV voltage ${n}`)) continue;
    const p = Math.round(num(raw, `PV voltage ${n}`) * num(raw, `PV current ${n}`));
    out[`PV voltage ${n}`] = raw[`PV voltage ${n}`];
    out[`PV current ${n}`] = raw[`PV current ${n}`];
    out[`PV power ${n}`] = p;
    pv += p;
  }
  out['PV power'] = pv;
  for (const k of [
    'Battery voltage', 'Battery temperature', 'Battery state of charge', 'Battery state of health', 'Battery mode', 'Grid voltage',
    'Grid current', 'Grid frequency', 'AC output voltage', 'AC output frequency', 'Device mode', 'Temperature', 'PV energy total', 'PV energy today',
  ]) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  // Battery sign from the mode: charging +, discharging −.
  const charging = raw['Battery mode'] === BATTERY_MODES[3];
  const sign = charging ? 1 : raw['Battery mode'] === BATTERY_MODES[2] ? -1 : 0;
  const amps = num(raw, 'Battery current abs');
  out['Battery current'] = round(sign * amps, 1);
  out['Battery power'] = Math.round(sign * amps * num(raw, 'Battery voltage'));
  // Grid: magnitude + direction byte (2 = importing → +, 1 = exporting → −).
  const flow = num(raw, 'Grid flow');
  const gridAbs = Math.abs(num(raw, 'Grid power abs'));
  out['Grid power'] = flow === 2 ? gridAbs : flow === 1 ? -gridAbs : 0;
  out['Load power'] = Math.max(0, num(raw, 'On-grid load power') + num(raw, 'Backup load power'));
  if (has(raw, 'Backup load power')) out['Backup power'] = raw['Backup load power'];
  if (has(raw, 'Error code raw')) {
    const e = num(raw, 'Error code raw');
    out['Fault code'] = e ? `0x${e.toString(16).toUpperCase().padStart(8, '0')}` : 'None';
  }
  return out;
}

/**
 * ES device-info (0x01/0x02) payload, UNVERIFIED layout:
 *   0–4 firmware (5 ASCII), 5–14 model name (10 ASCII), 31–46 serial (16 ASCII), 51–62 internal
 *   software version (12 ASCII).
 */
export function decodeEsInfo(data: Uint8Array): Metrics {
  const b = Buffer.from(data);
  const text = (from: number, to: number) => (b.length >= to ? b.subarray(from, to).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() : '');
  const out: Metrics = {};
  const fw = text(0, 5);
  const model = text(5, 15);
  const serial = text(31, 47);
  const sw = text(51, 63);
  if (model) out['Model name'] = model;
  if (serial) out['Serial number'] = serial;
  if (fw) out['Firmware version'] = fw;
  if (sw) out['Secondary firmware version'] = sw;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Model identification from the serial number. GoodWe serials carry a family tag at [5:8]
// (e.g. "9010KETU…" → "ETU"). Tag lists as documented by open-source GoodWe tools (UNVERIFIED for
// the newest series).

export const TAGS_ET_THREE = ['ETU', 'ETL', 'ETR', 'ETC', 'ETT', 'ETF', 'BTU', 'BTN', 'BTC', 'HHI', 'HUA', 'CUA'];
export const TAGS_ET_SINGLE = ['EHU', 'EHR', 'EHB', 'BHU', 'HSB', 'ESN', 'EMN', 'ERN', 'EBN', 'HLB', 'HMB', 'HBB', 'ESA', 'EMJ'];
export const TAGS_ET_SPLIT = ['AES'];
export const TAGS_ES = ['ESU', 'EMU', 'BPU', 'BPS'];

/** Serial / model name → driver model id, when it tells. */
export function modelFromIdentity(serial: string, modelName = ''): string | undefined {
  const tag = serial.slice(5, 8).toUpperCase();
  if (TAGS_ET_THREE.includes(tag)) return 'et';
  if (TAGS_ET_SPLIT.includes(tag)) return 'et-split';
  if (TAGS_ET_SINGLE.includes(tag)) return 'eh';
  if (TAGS_ES.includes(tag)) return 'es';
  const m = modelName.toUpperCase();
  if (/-(ET|BT)\b|ET-?G2|\bET\d/.test(m)) return 'et';
  if (/-(EH|BH|EHB)\b|ES-?C10|UNIQ|D-ES|ES-?G2/.test(m)) return 'eh';
  if (/-(ES|EM|BP)\b/.test(m)) return 'es';
  return undefined;
}
