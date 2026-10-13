/**
 * Luxpower / EG4 hybrid register tables (Modbus RTU, 19200 8N1, unit 1).
 *
 * Source: the public "LuxPower Modbus RTU protocol" document (input registers = live data in blocks
 * of 40: 0–39, 40–79, 80–119, 120–159; holding registers = settings) plus facts cross-checked
 * against the documentation of open-source Luxpower/EG4 tools. Nothing here has been checked on a
 * real unit yet. Every row's note says "confident" (consistent across all sources seen) or
 * "UNVERIFIED" (one source, or recalled from memory, or the scale is uncertain).
 *
 * Luxpower specifics:
 *  - 32-bit values (energy totals, fault/warning codes) are LOW word first.
 *  - Register 5 packs SOC (low byte) and SOH (high byte).
 *  - Battery and grid power come as pairs of unsigned registers (charge/discharge, import/export).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32le' | 'ascii' | 'lo8' | 'hi8';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** Registers for 'ascii'. */
  words?: number;
  scale?: number;
  /** Raw name (decoded into this key). */
  metric: string;
  enum?: Record<number, string>;
  note: string;
}

export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

export function decodeAscii(words: number[]): string {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

function words(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32le' ? 2 : 1;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const w: number[] = [];
  for (let i = 0; i < words(def); i++) {
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
    case 'u32le':
      raw = (w[1] * 0x10000 + w[0]) >>> 0;
      break;
    case 'lo8':
      raw = w[0] & 0xff;
      break;
    case 'hi8':
      raw = (w[0] >> 8) & 0xff;
      break;
    default:
      raw = w[0];
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (0x${raw.toString(16).padStart(2, '0')})`;
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

/** Input register 0, inverter state (hex codes from the protocol document; medium confidence). */
export const STATUS: Record<number, string> = {
  0x00: 'Standby',
  0x01: 'Fault',
  0x02: 'Programming',
  0x04: 'PV on-grid',
  0x08: 'PV charge',
  0x0c: 'PV charge on-grid',
  0x10: 'Battery on-grid',
  0x11: 'Bypass',
  0x14: 'PV and battery on-grid',
  0x19: 'PV charge and bypass',
  0x20: 'AC charge',
  0x28: 'PV and AC charge',
  0x40: 'Battery off-grid',
  0x80: 'PV off-grid',
  0x88: 'PV charge off-grid',
  0xc0: 'PV and battery off-grid',
};

const pv = (n: number): RegDef[] => [
  { addr: n, scale: 0.1, metric: `PV voltage ${n}`, note: `Vpv${n} 0.1 V (confident)` },
  { addr: 6 + n, metric: `PV power ${n}`, note: `Ppv${n} W (confident)` },
];

/** Input registers (fn 4), polled in blocks of 40. */
export const INPUT: RegDef[] = [
  // Block 0–39: status, PV, battery, grid, EPS.
  { addr: 0, metric: 'Status', enum: STATUS, note: 'State (codes medium confidence)' },
  ...pv(1),
  ...pv(2),
  ...pv(3),
  { addr: 4, scale: 0.1, metric: 'Battery voltage', note: 'Vbat 0.1 V (confident)' },
  { addr: 5, type: 'lo8', metric: 'SOC', note: 'SOC % low byte (confident)' },
  { addr: 5, type: 'hi8', metric: 'SOH', note: 'SOH % high byte (confident)' },
  { addr: 6, metric: 'Internal fault', note: 'UNVERIFIED: internal fault word' },
  { addr: 10, metric: 'Charge power', note: 'Pcharge W, battery charging (confident)' },
  { addr: 11, metric: 'Discharge power', note: 'Pdischarge W, battery discharging (confident)' },
  { addr: 12, scale: 0.1, metric: 'Grid voltage R', note: 'VacR 0.1 V (confident)' },
  { addr: 13, scale: 0.1, metric: 'Grid voltage S', note: 'VacS 0.1 V (UNVERIFIED: 0 on single-phase)' },
  { addr: 14, scale: 0.1, metric: 'Grid voltage T', note: 'VacT 0.1 V (UNVERIFIED: 0 on single-phase)' },
  { addr: 15, scale: 0.01, metric: 'Grid frequency', note: 'Fac 0.01 Hz (confident)' },
  { addr: 16, metric: 'Inverter power', note: 'Pinv W, inverter output to AC (confident)' },
  { addr: 17, metric: 'Rectifier power', note: 'Prec W, AC into the inverter (confident)' },
  { addr: 18, scale: 0.01, metric: 'Inverter current', note: 'IinvRMS 0.01 A (UNVERIFIED)' },
  { addr: 19, scale: 0.001, metric: 'Power factor', note: 'PF 0.001 (UNVERIFIED)' },
  { addr: 20, scale: 0.1, metric: 'EPS voltage R', note: 'VepsR 0.1 V (confident)' },
  { addr: 21, scale: 0.1, metric: 'EPS voltage S', note: 'VepsS 0.1 V (UNVERIFIED)' },
  { addr: 22, scale: 0.1, metric: 'EPS voltage T', note: 'VepsT 0.1 V (UNVERIFIED)' },
  { addr: 23, scale: 0.01, metric: 'EPS frequency', note: 'Feps 0.01 Hz (confident)' },
  { addr: 24, metric: 'EPS power', note: 'Peps W, backup output (confident)' },
  { addr: 25, metric: 'EPS apparent power', note: 'Seps VA (UNVERIFIED)' },
  { addr: 26, metric: 'Power to grid', note: 'Ptogrid W, export (confident)' },
  { addr: 27, metric: 'Power to user', note: 'Ptouser W, import (confident)' },
  { addr: 28, scale: 0.1, metric: 'PV1 energy today', note: 'Epv1_day 0.1 kWh (UNVERIFIED)' },
  { addr: 29, scale: 0.1, metric: 'PV2 energy today', note: 'Epv2_day 0.1 kWh (UNVERIFIED)' },
  { addr: 30, scale: 0.1, metric: 'PV3 energy today', note: 'Epv3_day 0.1 kWh (UNVERIFIED)' },
  { addr: 31, scale: 0.1, metric: 'Inverter energy today', note: 'Einv_day 0.1 kWh (UNVERIFIED)' },
  { addr: 32, scale: 0.1, metric: 'Rectifier energy today', note: 'Erec_day 0.1 kWh (UNVERIFIED)' },
  { addr: 33, scale: 0.1, metric: 'Charge energy today', note: 'Echg_day 0.1 kWh (UNVERIFIED)' },
  { addr: 34, scale: 0.1, metric: 'Discharge energy today', note: 'Edischg_day 0.1 kWh (UNVERIFIED)' },
  { addr: 35, scale: 0.1, metric: 'EPS energy today', note: 'Eeps_day 0.1 kWh (UNVERIFIED)' },
  { addr: 36, scale: 0.1, metric: 'Export energy today', note: 'Etogrid_day 0.1 kWh (UNVERIFIED)' },
  { addr: 37, scale: 0.1, metric: 'Import energy today', note: 'Etouser_day 0.1 kWh (UNVERIFIED)' },
  { addr: 38, scale: 0.1, metric: 'Bus voltage 1', note: 'Vbus1 0.1 V (UNVERIFIED)' },
  { addr: 39, scale: 0.1, metric: 'Bus voltage 2', note: 'Vbus2 0.1 V (UNVERIFIED)' },
  // Block 40–79: lifetime energy (u32, low word first), fault/warning, temperatures.
  { addr: 40, type: 'u32le', scale: 0.1, metric: 'PV1 energy total', note: 'UNVERIFIED' },
  { addr: 42, type: 'u32le', scale: 0.1, metric: 'PV2 energy total', note: 'UNVERIFIED' },
  { addr: 44, type: 'u32le', scale: 0.1, metric: 'PV3 energy total', note: 'UNVERIFIED' },
  { addr: 46, type: 'u32le', scale: 0.1, metric: 'Inverter energy total', note: 'UNVERIFIED' },
  { addr: 48, type: 'u32le', scale: 0.1, metric: 'Rectifier energy total', note: 'UNVERIFIED' },
  { addr: 50, type: 'u32le', scale: 0.1, metric: 'Charge energy total', note: 'UNVERIFIED' },
  { addr: 52, type: 'u32le', scale: 0.1, metric: 'Discharge energy total', note: 'UNVERIFIED' },
  { addr: 54, type: 'u32le', scale: 0.1, metric: 'EPS energy total', note: 'UNVERIFIED' },
  { addr: 56, type: 'u32le', scale: 0.1, metric: 'Export energy total', note: 'UNVERIFIED' },
  { addr: 58, type: 'u32le', scale: 0.1, metric: 'Import energy total', note: 'UNVERIFIED' },
  { addr: 60, type: 'u32le', metric: 'Fault code', note: 'fault bitmap, low word first (medium)' },
  { addr: 62, type: 'u32le', metric: 'Warning code', note: 'warning bitmap, low word first (medium)' },
  { addr: 64, type: 's16', metric: 'Internal temperature', note: 'Tinner °C (medium)' },
  { addr: 65, type: 's16', metric: 'Radiator temperature 1', note: 'Tradiator1 °C (medium)' },
  { addr: 66, type: 's16', metric: 'Radiator temperature 2', note: 'Tradiator2 °C (UNVERIFIED)' },
  { addr: 67, type: 's16', metric: 'Battery temperature', note: 'Tbat °C (medium)' },
  { addr: 69, type: 'u32le', metric: 'Runtime', note: 'seconds, low word first (UNVERIFIED)' },
  // Block 80–119: BMS data (only with a communicating lithium battery).
  { addr: 81, scale: 0.1, metric: 'BMS max charge current', note: 'UNVERIFIED: scale may be 0.01 A' },
  { addr: 82, scale: 0.1, metric: 'BMS max discharge current', note: 'UNVERIFIED: scale may be 0.01 A' },
  { addr: 83, scale: 0.1, metric: 'BMS charge voltage', note: 'UNVERIFIED' },
  { addr: 84, scale: 0.1, metric: 'BMS discharge cut-off voltage', note: 'UNVERIFIED' },
  { addr: 96, metric: 'Battery pack count', note: 'UNVERIFIED' },
  { addr: 97, metric: 'Battery capacity Ah', note: 'UNVERIFIED' },
  { addr: 98, type: 's16', scale: 0.1, metric: 'BMS battery current', note: 'UNVERIFIED: sign and scale' },
  { addr: 101, scale: 0.001, metric: 'Max cell voltage', note: 'UNVERIFIED: 1 mV' },
  { addr: 102, scale: 0.001, metric: 'Min cell voltage', note: 'UNVERIFIED: 1 mV' },
  { addr: 103, type: 's16', scale: 0.1, metric: 'Max cell temperature', note: 'UNVERIFIED' },
  { addr: 104, type: 's16', scale: 0.1, metric: 'Min cell temperature', note: 'UNVERIFIED' },
  { addr: 106, metric: 'Cycles', note: 'UNVERIFIED: BMS cycle count' },
  { addr: 115, type: 'ascii', words: 5, metric: 'Serial (input)', note: 'UNVERIFIED: 10-char serial on newer firmware' },
  // Block 120–159: generator and split-phase EPS (EG4 / SNA-US; older firmware may reject it).
  { addr: 121, scale: 0.1, metric: 'Generator voltage', note: 'UNVERIFIED' },
  { addr: 122, scale: 0.01, metric: 'Generator frequency', note: 'UNVERIFIED' },
  { addr: 123, metric: 'Generator power', note: 'UNVERIFIED' },
  { addr: 127, scale: 0.1, metric: 'EPS voltage L1', note: 'UNVERIFIED: split-phase L1-N' },
  { addr: 128, scale: 0.1, metric: 'EPS voltage L2', note: 'UNVERIFIED: split-phase L2-N' },
  { addr: 129, metric: 'EPS power L1', note: 'UNVERIFIED: split-phase' },
  { addr: 130, metric: 'EPS power L2', note: 'UNVERIFIED: split-phase' },
];

/** Input spans read every poll. The first block is required; the others are best effort. */
export const INPUT_BLOCKS: [number, number][] = [[0, 40], [40, 40], [80, 40], [120, 40]];

/** Holding registers (fn 3) for info and the console (settings are in settings.ts). */
export const HOLDING_INFO: RegDef[] = [
  { addr: 0, metric: 'Model code 1', note: 'UNVERIFIED: model/feature bit field' },
  { addr: 1, metric: 'Model code 2', note: 'UNVERIFIED: model/feature bit field' },
  { addr: 2, type: 'ascii', words: 5, metric: 'Serial (holding 2)', note: 'UNVERIFIED: 10-char serial, older layout' },
  { addr: 7, type: 'ascii', words: 2, metric: 'Firmware code', note: 'UNVERIFIED: 4-char code, e.g. "FAAB"' },
  { addr: 9, metric: 'Firmware version word 1', note: 'UNVERIFIED' },
  { addr: 10, metric: 'Firmware version word 2', note: 'UNVERIFIED' },
  { addr: 15, metric: 'Modbus address', note: 'com address (medium)' },
  { addr: 115, type: 'ascii', words: 5, metric: 'Serial (holding 115)', note: 'UNVERIFIED: 10-char serial per the protocol brief' },
];

/** A 10-character inverter/dongle serial: letters and digits only. */
export function isSerial(text: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(text);
}

/** Picks the info metrics out of holding and input images. */
export function decodeInfo(holding: RegisterImage, input: RegisterImage): Metrics {
  const out: Metrics = {};
  const h = decodeTable(HOLDING_INFO, holding);
  const i = decodeTable(INPUT.filter((d) => d.type === 'ascii'), input);
  const serial = [i['Serial (input)'], h['Serial (holding 115)'], h['Serial (holding 2)']].find(
    (s) => typeof s === 'string' && isSerial(s),
  );
  if (serial) out['Serial number'] = serial;
  const code = h['Firmware code'];
  if (typeof code === 'string' && /^[A-Za-z0-9]{4}$/.test(code)) {
    const hex = (n: unknown) => (typeof n === 'number' ? n.toString(16).toUpperCase().padStart(4, '0') : '');
    const parts = [hex(h['Firmware version word 1']), hex(h['Firmware version word 2'])].filter(Boolean);
    out['Firmware version'] = [code, ...parts].join('-');
  }
  return out;
}

const num = (m: Metrics, k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0);
const has = (m: Metrics, k: string) => typeof m[k] === 'number';

/**
 * Raw table values → Sunroost metrics. `pv` is false for AC-coupled units (no PV inputs).
 *
 * Load power (UNVERIFIED): consumption on the grid side = Pinv − Prec + import − export, plus the
 * EPS (backup) output. Reported separately as essential (EPS) and non-essential (grid side).
 */
export function deriveLive(raw: Metrics, opts: { pv: boolean }): Metrics {
  const out: Metrics = {};
  if (typeof raw.Status === 'string') out['Device mode'] = raw.Status;

  if (opts.pv) {
    let total = 0;
    for (const n of [1, 2, 3]) {
      if (!has(raw, `PV power ${n}`)) continue;
      const p = num(raw, `PV power ${n}`);
      const v = num(raw, `PV voltage ${n}`);
      total += p;
      // String 3 only exists on some models; skip it when idle so it doesn't clutter the UI.
      if (n === 3 && p === 0 && v === 0) continue;
      out[`PV power ${n}`] = p;
      out[`PV voltage ${n}`] = v;
      out[`PV current ${n}`] = v > 0 ? round(p / v, 1) : 0;
    }
    out['PV power'] = total;
  }

  if (has(raw, 'Battery voltage')) {
    const bv = num(raw, 'Battery voltage');
    const bp = num(raw, 'Charge power') - num(raw, 'Discharge power');
    out['Battery voltage'] = bv;
    out['Battery power'] = bp;
    out['Battery current'] = bv > 0 ? round(bp / bv, 1) : 0;
  }
  if (has(raw, 'SOC')) out['Battery state of charge'] = raw.SOC;
  if (has(raw, 'SOH') && num(raw, 'SOH') > 0) out['Battery state of health'] = raw.SOH;
  if (has(raw, 'Battery temperature')) out['Battery temperature'] = raw['Battery temperature'];

  if (has(raw, 'Grid voltage R')) out['Grid voltage'] = raw['Grid voltage R'];
  if (has(raw, 'Grid frequency')) out['Grid frequency'] = raw['Grid frequency'];
  const imp = num(raw, 'Power to user');
  const exp = num(raw, 'Power to grid');
  if (has(raw, 'Power to user') || has(raw, 'Power to grid')) out['Grid power'] = imp - exp;

  if (has(raw, 'Inverter power')) {
    const gridSide = Math.max(0, num(raw, 'Inverter power') - num(raw, 'Rectifier power') + imp - exp);
    const eps = num(raw, 'EPS power');
    out['Load power'] = gridSide + eps;
    out['Load power essential'] = eps;
    out['Load power non-essential'] = gridSide;
  }
  if (has(raw, 'EPS apparent power')) out['Load apparent power'] = raw['EPS apparent power'];
  if (has(raw, 'EPS voltage R')) out['AC output voltage'] = raw['EPS voltage R'];
  if (has(raw, 'EPS frequency')) out['AC output frequency'] = raw['EPS frequency'];
  // Split-phase (SNA-US, EG4 18kPV/FlexBOSS): per-leg EPS values, named like the Deye per-phase ones.
  if (num(raw, 'EPS voltage L1') > 0 || num(raw, 'EPS voltage L2') > 0) {
    out['AC output voltage 1'] = num(raw, 'EPS voltage L1');
    out['AC output voltage 2'] = num(raw, 'EPS voltage L2');
    out['Load power 1'] = num(raw, 'EPS power L1');
    out['Load power 2'] = num(raw, 'EPS power L2');
  }
  if (num(raw, 'Generator voltage') > 0) {
    out['Generator voltage'] = num(raw, 'Generator voltage');
    out['Generator power'] = num(raw, 'Generator power');
  }

  if (has(raw, 'Fault code')) out['Fault code'] = raw['Fault code'];
  if (has(raw, 'Internal temperature')) out.Temperature = raw['Internal temperature'];
  if (has(raw, 'Bus voltage 1')) out['Bus voltage'] = raw['Bus voltage 1'];
  return out;
}
