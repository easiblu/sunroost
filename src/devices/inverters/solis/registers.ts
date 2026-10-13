/**
 * Solis (Ginlong) Modbus register tables and a small table decoder.
 *
 * Source: Ginlong's public "Solis RS485 MODBUS communication protocol" documents — the energy
 * storage ("ESINV-33000ID", hybrid) edition and the string-inverter edition that shares its
 * 33000-range input map — plus general knowledge of the published layout. Live data are INPUT
 * registers (function 4) at 33000–33282; settings are HOLDING registers (function 3) at 43000+.
 * Addresses here are the protocol addresses as sent on the wire (33000 = product model).
 *
 * Confidence per row: "confident" = address and scaling agree across Solis documents and
 * open-source register lists; "medium" = documented but sign/semantics not cross-checked;
 * "UNVERIFIED" = best knowledge that still has to be checked on a real unit (docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'hex';

export interface RegDef {
  addr: number;
  /** u16 (default), s16, u32/s32 (high word first), hex (raw word as upper-case hex text). */
  type?: RegType;
  scale?: number;
  metric: string;
  enum?: Record<number, string>;
  note: string;
}

/** A sparse register image: address → raw 16-bit value. */
export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const t = def.type ?? 'u16';
  const hi = regs.get(def.addr);
  if (hi === undefined) return undefined;
  let raw: number;
  if (t === 'u32' || t === 's32') {
    const lo = regs.get(def.addr + 1);
    if (lo === undefined) return undefined;
    raw = hi * 0x10000 + lo;
    if (t === 's32' && raw >= 0x80000000) raw -= 0x100000000;
  } else if (t === 'hex') {
    return hi.toString(16).toUpperCase().padStart(4, '0');
  } else {
    raw = t === 's16' && hi > 0x7fff ? hi - 0x10000 : hi;
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
// Product information, read once on connect (input 33000–33019).

export const INFO_SPAN: [number, number] = [33000, 20];
export const MODEL_REG = 33000;
export const SERIAL_REG = 33004;
export const SERIAL_WORDS = 16;

export const INFO_MAP: RegDef[] = [
  { addr: 33000, type: 'hex', metric: 'Model code', note: 'product model code; hi byte = protocol/platform, lo byte = type (medium: meaning of codes UNVERIFIED)' },
  { addr: 33001, type: 'hex', metric: 'Firmware version', note: 'DSP software version, shown as hex like the Solis display (medium)' },
  { addr: 33002, type: 'hex', metric: 'Secondary firmware version', note: 'HMI / LCD software version, hex (medium)' },
];

/**
 * Serial number at 33004–33019 (UNVERIFIED encoding). Solis documents describe it as ASCII; units
 * are reported both with one character per register (low byte) and two per register (high byte
 * first), and some older firmware packs the serial as hex digits in the first four registers. We
 * try them in that order and return '' when nothing printable comes out.
 */
export function decodeSerial(words: number[]): string {
  const ws = words.slice(0, SERIAL_WORDS);
  const printable = (c: number) => c >= 0x20 && c <= 0x7e;
  const meaningful = ws.filter((w) => w !== 0 && w !== 0xffff);
  if (!meaningful.length) return '';
  // One character per register: every used register has a zero high byte.
  if (meaningful.every((w) => w >> 8 === 0 && printable(w & 0xff))) {
    return meaningful.map((w) => String.fromCharCode(w & 0xff)).join('').trim();
  }
  // Two characters per register, high byte first.
  const bytes = ws.flatMap((w) => [w >> 8, w & 0xff]).filter((b) => b !== 0 && b !== 0xff);
  if (bytes.length && bytes.every(printable)) return String.fromCharCode(...bytes).trim();
  // Hex digits packed in the first four registers.
  const first = ws.slice(0, 4);
  if (first.length === 4 && first.every((w) => w !== 0xffff)) {
    const hex = first.map((w) => w.toString(16).toUpperCase().padStart(4, '0')).join('');
    if (!/^0+$/.test(hex)) return hex;
  }
  return '';
}

// ---------------------------------------------------------------------------------------------
// Live data.

/**
 * Inverter status at 33095 (medium). 0x0000–0x0003 are the normal start-up states; 0x1xxx and
 * 0x2xxx codes are grid / internal faults, decoded in the driver into "Fault" + the code.
 */
export const STATUS: Record<number, string> = {
  0x0000: 'Waiting',
  0x0001: 'Open loop',
  0x0002: 'Soft run',
  0x0003: 'Generating',
  0x0004: 'Bypass inverter',
  0x0005: 'Bypass grid',
  0x0006: 'Off-grid',
  0x0007: 'Off-grid',
  0x000f: 'Off-grid',
  0x1004: 'Grid off',
};

/** Block A: PV, AC and inverter status, 33022–33095. */
export const SPAN_A: [number, number] = [33022, 74];
export const MAP_A: RegDef[] = [
  { addr: 33029, type: 'u32', metric: 'PV energy total', note: 'total generation kWh (confident)' },
  { addr: 33035, scale: 0.1, metric: 'PV energy today', note: 'today generation 0.1 kWh (confident)' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 33049 + (n - 1) * 2, scale: 0.1, metric: `PV voltage ${n}`, note: n > 2 ? 'medium' : 'DC voltage 0.1 V (confident)' },
    { addr: 33050 + (n - 1) * 2, scale: 0.1, metric: `PV current ${n}`, note: n > 2 ? 'medium' : 'DC current 0.1 A (confident)' },
  ]),
  { addr: 33057, type: 'u32', metric: 'PV power total raw', note: 'total DC input power W (confident)' },
  { addr: 33071, scale: 0.1, metric: 'Bus voltage', note: 'DC bus 0.1 V (medium)' },
  { addr: 33073, scale: 0.1, metric: 'AC voltage 1', note: 'phase A (or single-phase) voltage 0.1 V (confident)' },
  { addr: 33074, scale: 0.1, metric: 'AC voltage 2', note: 'phase B voltage 0.1 V (confident on 3-phase)' },
  { addr: 33075, scale: 0.1, metric: 'AC voltage 3', note: 'phase C voltage 0.1 V (confident on 3-phase)' },
  { addr: 33076, scale: 0.1, metric: 'AC current 1', note: 'phase A current 0.1 A (confident)' },
  { addr: 33077, scale: 0.1, metric: 'AC current 2', note: 'phase B current 0.1 A (confident on 3-phase)' },
  { addr: 33078, scale: 0.1, metric: 'AC current 3', note: 'phase C current 0.1 A (confident on 3-phase)' },
  { addr: 33079, type: 's32', metric: 'Inverter power', note: 'AC active power W, signed (confident)' },
  { addr: 33083, type: 's32', metric: 'Inverter apparent power', note: 'AC apparent power VA (medium)' },
  { addr: 33093, type: 's16', scale: 0.1, metric: 'Temperature', note: 'inverter (heat sink) temperature 0.1 °C (confident)' },
  { addr: 33094, scale: 0.01, metric: 'Grid frequency', note: 'grid frequency 0.01 Hz (confident)' },
  { addr: 33095, metric: 'Status code', note: 'current inverter status (medium)' },
];

/** Block B: faults, meter, battery and energy counters, 33116–33180. */
export const SPAN_B: [number, number] = [33116, 65];
export const MAP_B: RegDef[] = [
  ...[1, 2, 3, 4, 5].map((n): RegDef => ({ addr: 33115 + n, metric: `Fault word ${n}`, note: `fault code 0${n} bitfield (medium)` })),
  { addr: 33130, type: 's32', metric: 'Meter power raw', note: 'meter total active power W; + = export (UNVERIFIED sign) — negated to + import' },
  { addr: 33133, scale: 0.1, metric: 'Battery voltage', note: 'battery voltage 0.1 V (confident)' },
  { addr: 33134, scale: 0.1, metric: 'Battery current raw', note: 'battery current magnitude 0.1 A (confident)' },
  { addr: 33135, metric: 'Battery direction', note: '0 = charging, 1 = discharging (confident)' },
  { addr: 33137, scale: 0.1, metric: 'Backup voltage', note: 'bypass / backup AC voltage 0.1 V (medium)' },
  { addr: 33139, metric: 'Battery state of charge', note: 'SOC % (confident)' },
  { addr: 33140, metric: 'Battery state of health', note: 'SOH % (confident)' },
  { addr: 33141, scale: 0.01, metric: 'BMS voltage', note: 'battery voltage from BMS 0.01 V (medium)' },
  { addr: 33142, type: 's16', scale: 0.1, metric: 'BMS current', note: 'battery current from BMS 0.1 A (UNVERIFIED sign)' },
  { addr: 33143, scale: 0.1, metric: 'Battery charge current limit', note: 'BMS charge limit 0.1 A (medium)' },
  { addr: 33144, scale: 0.1, metric: 'Battery discharge current limit', note: 'BMS discharge limit 0.1 A (medium)' },
  { addr: 33147, metric: 'House load power', note: 'house (grid-side) load W (confident)' },
  { addr: 33148, metric: 'Backup load power', note: 'bypass / backup load W (medium)' },
  { addr: 33149, type: 's32', metric: 'Battery power raw', note: 'battery power W magnitude; sign from 33135 (UNVERIFIED whether signed)' },
  { addr: 33161, type: 'u32', metric: 'Charge energy total', note: 'kWh (confident)' },
  { addr: 33163, scale: 0.1, metric: 'Charge energy today', note: '0.1 kWh (confident)' },
  { addr: 33165, type: 'u32', metric: 'Discharge energy total', note: 'kWh (confident)' },
  { addr: 33167, scale: 0.1, metric: 'Discharge energy today', note: '0.1 kWh (confident)' },
  { addr: 33169, type: 'u32', metric: 'Import energy total', note: 'kWh (confident)' },
  { addr: 33171, scale: 0.1, metric: 'Import energy today', note: '0.1 kWh (confident)' },
  { addr: 33173, type: 'u32', metric: 'Export energy total', note: 'kWh (confident)' },
  { addr: 33175, scale: 0.1, metric: 'Export energy today', note: '0.1 kWh (confident)' },
  { addr: 33177, type: 'u32', metric: 'Load energy total', note: 'kWh (medium)' },
  { addr: 33179, scale: 0.1, metric: 'Load energy today', note: '0.1 kWh (medium)' },
];

/** Block C: external meter per phase, 33250–33282 (absent without a meter; read is optional). */
export const SPAN_C: [number, number] = [33250, 33];
export const MAP_C: RegDef[] = [
  ...[1, 2, 3].flatMap((p): RegDef[] => [
    { addr: 33249 + p * 2, scale: 0.1, metric: `Meter voltage ${p}`, note: 'UNVERIFIED: meter phase voltage 0.1 V' },
    { addr: 33250 + p * 2, scale: 0.01, metric: `Meter current ${p}`, note: 'UNVERIFIED: meter phase current 0.01 A' },
    { addr: 33255 + p * 2, type: 's32', metric: `Meter power raw ${p}`, note: 'UNVERIFIED: meter phase active power W, + = export' },
  ]),
  { addr: 33263, type: 's32', metric: 'Meter total power raw', note: 'UNVERIFIED: meter total active power W, + = export' },
  { addr: 33282, scale: 0.01, metric: 'Meter frequency', note: 'UNVERIFIED: meter grid frequency 0.01 Hz' },
];
