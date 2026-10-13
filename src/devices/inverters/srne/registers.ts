/**
 * SRNE Modbus register tables and a small table decoder.
 *
 * Source: SRNE's public "MODBUS communication protocol" documents for its inverters (ASP / HF
 * off-grid and HESP / HYP hybrid series). Every register is a holding register read with
 * function 3; addresses are the hex addresses the documents use (0x0100 = battery/PV block,
 * 0x0200 = inverter block, 0x000A.. = product info, 0xE000.. / 0xE200.. = settings).
 *
 * Confidence notes per row: "confident" means the address and scaling agree across the SRNE
 * documents and open-source register lists; "UNVERIFIED" means best knowledge that still has to be
 * checked against a real unit (see docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'ascii' | 'version' | 'temp8hi' | 'temp8lo';

export interface RegDef {
  addr: number;
  /** u16 (default), s16, ascii (`words` registers), version (hi.lo), or one sign-magnitude byte. */
  type?: RegType;
  words?: number;
  scale?: number;
  metric: string;
  enum?: Record<number, string>;
  note?: string;
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

/** SRNE packs small temperatures as one byte: bit 7 = sign, bits 0–6 = magnitude in °C. */
function signMagnitude(byte: number) {
  return byte & 0x80 ? -(byte & 0x7f) : byte & 0x7f;
}

export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const n = def.type === 'ascii' ? (def.words ?? 1) : 1;
  const words: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  const w = words[0];
  switch (def.type ?? 'u16') {
    case 'ascii':
      return decodeAscii(words);
    case 'version':
      return `${w >> 8}.${String(w & 0xff).padStart(2, '0')}`;
    case 'temp8hi':
      return signMagnitude(w >> 8);
    case 'temp8lo':
      return signMagnitude(w & 0xff);
  }
  const raw = def.type === 's16' && w > 0x7fff ? w - 0x10000 : w;
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
// Product information (P00), read once on connect.

/** Span read for info: 0x000A–0x0016. */
export const INFO_SPAN: [number, number] = [0x000a, 13];
/** Span read for the product serial: 0x0035–0x0048 (40 characters). */
export const SERIAL_SPAN: [number, number] = [0x0035, 20];

export const INFO_MAP: RegDef[] = [
  { addr: 0x000a, metric: 'Rated voltage/current code', note: 'UNVERIFIED: hi = max supported voltage, lo = rated current' },
  { addr: 0x000b, metric: 'Product type code', note: 'UNVERIFIED: product type (controller / inverter / hybrid …)' },
  { addr: 0x000c, type: 'ascii', words: 8, metric: 'Model name', note: 'product model, 16 ASCII chars (confident)' },
  { addr: 0x0014, type: 'version', metric: 'Firmware version', note: 'UNVERIFIED: CPU1 software version, hi.lo' },
  { addr: 0x0015, type: 'version', metric: 'Secondary firmware version', note: 'UNVERIFIED: CPU2 software version, hi.lo' },
  { addr: 0x0035, type: 'ascii', words: 20, metric: 'Serial number', note: 'product SN, ASCII (medium confidence)' },
];

// ---------------------------------------------------------------------------------------------
// Live data.

/** Charge-stage codes at 0x010B. */
export const CHARGE_STATE: Record<number, string> = {
  0: 'Not charging', 1: 'Constant current', 2: 'Constant voltage', 3: 'Float', 4: 'Float',
  5: 'Equalizing', 6: 'Battery activation', 7: 'Current limiting',
};

/**
 * Machine state at 0x0210, mapped to Sunroost's device modes. The SRNE wording is
 * "mains operation" (load fed by grid / bypass) and "inverter operation" (load fed by inverter).
 */
export const MACHINE_STATE: Record<number, string> = {
  0: 'Power on delay', 1: 'Standby', 2: 'Initializing', 3: 'Soft start', 4: 'Grid',
  5: 'Inverter', 6: 'Inverter to grid', 7: 'Grid to inverter', 8: 'Battery activation',
  9: 'Shutdown', 10: 'Fault',
};

/** Battery and PV block, 0x0100–0x0111. */
export const BATTERY_SPAN: [number, number] = [0x0100, 0x12];
export const BATTERY_MAP: RegDef[] = [
  { addr: 0x0100, metric: 'Battery state of charge', note: 'SOC % (confident)' },
  { addr: 0x0101, scale: 0.1, metric: 'Battery voltage', note: '0.1 V (confident)' },
  { addr: 0x0102, type: 's16', scale: 0.1, metric: 'Battery current', note: '0.1 A, + charging / − discharging (confident on hybrid; UNVERIFIED sign on off-grid)' },
  { addr: 0x0103, type: 'temp8lo', metric: 'Battery temperature', note: 'UNVERIFIED: low byte battery temp, sign-magnitude °C (0 without a sensor)' },
  { addr: 0x0107, scale: 0.1, metric: 'PV voltage 1', note: '0.1 V (confident)' },
  { addr: 0x0108, scale: 0.1, metric: 'PV current 1', note: '0.1 A (confident)' },
  { addr: 0x0109, metric: 'PV power 1', note: 'W (confident)' },
  { addr: 0x010b, metric: 'Charger state', enum: CHARGE_STATE, note: 'UNVERIFIED: charge stage' },
  { addr: 0x010e, metric: 'Charge power', note: 'UNVERIFIED: total charge power W' },
];
/** Second MPPT on dual-tracker hybrids (HESP / HYP). */
export const PV2_MAP: RegDef[] = [
  { addr: 0x010f, scale: 0.1, metric: 'PV voltage 2', note: 'UNVERIFIED: PV2 voltage 0.1 V' },
  { addr: 0x0110, scale: 0.1, metric: 'PV current 2', note: 'UNVERIFIED: PV2 current 0.1 A' },
  { addr: 0x0111, metric: 'PV power 2', note: 'UNVERIFIED: PV2 power W' },
];

/** Inverter block, 0x0200–0x0224 for single-phase units. */
export const INVERTER_SPAN: [number, number] = [0x0200, 0x25];
export const INVERTER_MAP: RegDef[] = [
  { addr: 0x0200, metric: 'Fault word 1', note: 'current fault code 1 (medium)' },
  { addr: 0x0201, metric: 'Fault word 2', note: 'current fault code 2 (medium)' },
  { addr: 0x0202, metric: 'Fault word 3', note: 'current fault code 3 (medium)' },
  { addr: 0x0203, metric: 'Fault word 4', note: 'current fault code 4 (medium)' },
  { addr: 0x0210, metric: 'Device mode', enum: MACHINE_STATE, note: 'machine state (confident)' },
  { addr: 0x0212, scale: 0.1, metric: 'Bus voltage', note: 'DC bus 0.1 V (confident)' },
  { addr: 0x0213, scale: 0.1, metric: 'Grid voltage 1', note: 'grid (mains) voltage L1 0.1 V (confident)' },
  { addr: 0x0214, scale: 0.1, metric: 'Grid current 1', note: 'grid current L1 0.1 A (medium)' },
  { addr: 0x0215, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (confident)' },
  { addr: 0x0216, scale: 0.1, metric: 'AC output voltage 1', note: 'inverter output voltage L1 0.1 V (confident)' },
  { addr: 0x0217, scale: 0.1, metric: 'AC output current 1', note: 'inverter current L1 0.1 A (medium)' },
  { addr: 0x0218, scale: 0.01, metric: 'AC output frequency', note: '0.01 Hz (confident)' },
  { addr: 0x0219, scale: 0.1, metric: 'Load current 1', note: 'load current L1 0.1 A (medium)' },
  { addr: 0x021b, metric: 'Load power 1', note: 'load active power L1 W (confident)' },
  { addr: 0x021c, metric: 'Load apparent power 1', note: 'load apparent power L1 VA (confident)' },
  { addr: 0x021e, scale: 0.1, metric: 'Grid charge current', note: 'mains charging current 0.1 A (medium)' },
  { addr: 0x021f, metric: 'Load percentage 1', note: 'load ratio L1 % (confident)' },
  { addr: 0x0220, type: 's16', scale: 0.1, metric: 'Temperature DC', note: 'heat sink A (DC-DC) 0.1 °C (medium)' },
  { addr: 0x0221, type: 's16', scale: 0.1, metric: 'Temperature AC', note: 'heat sink B (inverter) 0.1 °C (medium)' },
  { addr: 0x0222, type: 's16', scale: 0.1, metric: 'Temperature transformer', note: 'UNVERIFIED: heat sink C 0.1 °C' },
  { addr: 0x0224, scale: 0.1, metric: 'PV charge current', note: 'UNVERIFIED: PV charging current (battery side) 0.1 A' },
];

/**
 * Per-phase blocks for split-phase (L2) and three-phase (L2, L3) units: 8 registers each, phase B at
 * 0x022A and phase C at 0x0232. All UNVERIFIED (from SRNE split-phase register lists; not checked).
 */
export const PHASE_BASE: Record<number, number> = { 2: 0x022a, 3: 0x0232 };
export function phaseMap(p: 2 | 3): RegDef[] {
  const b = PHASE_BASE[p];
  const note = `UNVERIFIED: phase ${p === 2 ? 'B' : 'C'} block at 0x${b.toString(16).toUpperCase()}`;
  return [
    { addr: b, scale: 0.1, metric: `Grid voltage ${p}`, note },
    { addr: b + 1, scale: 0.1, metric: `Grid current ${p}`, note },
    { addr: b + 2, scale: 0.1, metric: `AC output voltage ${p}`, note },
    { addr: b + 3, scale: 0.1, metric: `AC output current ${p}`, note },
    { addr: b + 4, scale: 0.1, metric: `Load current ${p}`, note },
    { addr: b + 5, metric: `Load power ${p}`, note },
    { addr: b + 6, metric: `Load apparent power ${p}`, note },
    { addr: b + 7, metric: `Load percentage ${p}`, note },
  ];
}
