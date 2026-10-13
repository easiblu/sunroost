/**
 * Solax Modbus register tables and a small table decoder.
 *
 * Source: SolaX's public "Hybrid X1/X3-G4 Modbus RTU/TCP communication protocol" (the G3 document
 * shares the live-data block), cross-checked against the facts in open-source Solax register lists.
 * Live data is in input registers (function 4) from 0x0000; info and settings are holding registers
 * (function 3) from 0x0000. 32-bit values are sent LOW word first (Solax convention).
 *
 * Confidence notes per row: "confident" = address and scaling agree across the Solax documents and
 * open-source lists; "medium" = documented but not seen on every firmware; "UNVERIFIED" = best
 * knowledge, to be checked on a real unit (docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  addr: number;
  /** u16 (default), s16, u32/s32 (two registers, low word first) or ascii (`words` registers). */
  type?: RegType;
  words?: number;
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

export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

function width(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < width(def); i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  if (def.type === 'ascii') return decodeAscii(words);
  let raw: number;
  switch (def.type ?? 'u16') {
    case 's16':
      raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
      break;
    case 'u32':
      raw = words[1] * 0x10000 + words[0];
      break;
    case 's32': {
      const u = words[1] * 0x10000 + words[0];
      raw = u >= 0x80000000 ? u - 0x100000000 : u;
      break;
    }
    default:
      raw = words[0];
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
// Info (holding registers), read once on connect.

/** Serial (0x0000, 7 regs), factory name (0x0007, 7 regs), module name (0x000E, 7 regs). */
export const IDENT_SPAN: [number, number] = [0x0000, 21];
/** Firmware versions 0x007D–0x0084. */
export const FIRMWARE_SPAN: [number, number] = [0x007d, 8];

export const INFO_MAP: RegDef[] = [
  { addr: 0x0000, type: 'ascii', words: 7, metric: 'Serial number', note: 'inverter serial, 14 ASCII chars (confident)' },
  { addr: 0x0007, type: 'ascii', words: 7, metric: 'Factory name', note: 'factory name, 14 ASCII chars, "SolaX" (medium)' },
  { addr: 0x000e, type: 'ascii', words: 7, metric: 'Module name', note: 'module / model name, 14 ASCII chars (medium)' },
  { addr: 0x007d, scale: 0.01, metric: 'Firmware version', note: 'UNVERIFIED: DSP (master) firmware version, x.yy' },
  { addr: 0x0083, scale: 0.01, metric: 'Secondary firmware version', note: 'UNVERIFIED: ARM (manager) firmware version, x.yy' },
];

// ---------------------------------------------------------------------------------------------
// Live data (input registers).

/** Run mode at input 0x0009 → device mode. */
export const RUN_MODE: Record<number, string> = {
  0: 'Waiting', 1: 'Checking', 2: 'Normal', 3: 'Fault', 4: 'Permanent fault', 5: 'Updating',
  6: 'EPS check', 7: 'EPS', 8: 'Self test', 9: 'Idle', 10: 'Standby',
};

/** Main live block, input 0x0000–0x0053. */
export const LIVE_SPAN: [number, number] = [0x0000, 0x54];
export const LIVE_MAP: RegDef[] = [
  { addr: 0x0000, scale: 0.1, metric: 'Grid voltage', note: 'inverter AC (grid) voltage 0.1 V, X1 (confident)' },
  { addr: 0x0001, type: 's16', scale: 0.1, metric: 'Grid current', note: 'inverter AC current 0.1 A, X1 (confident)' },
  { addr: 0x0002, type: 's16', metric: 'Inverter power', note: 'inverter AC output power W, X1 (confident)' },
  { addr: 0x0003, scale: 0.1, metric: 'PV voltage 1', note: '0.1 V (confident)' },
  { addr: 0x0004, scale: 0.1, metric: 'PV voltage 2', note: '0.1 V (confident)' },
  { addr: 0x0005, scale: 0.1, metric: 'PV current 1', note: '0.1 A (confident)' },
  { addr: 0x0006, scale: 0.1, metric: 'PV current 2', note: '0.1 A (confident)' },
  { addr: 0x0007, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz, X1 (confident)' },
  { addr: 0x0008, type: 's16', metric: 'Temperature', note: 'radiator (heat sink) °C (confident)' },
  { addr: 0x0009, metric: 'Device mode', enum: RUN_MODE, note: 'run mode (confident; 9/10 G4 only)' },
  { addr: 0x000a, metric: 'PV power 1', note: 'W (confident)' },
  { addr: 0x000b, metric: 'PV power 2', note: 'W (confident)' },
  { addr: 0x0014, type: 's16', scale: 0.1, metric: 'Battery voltage', note: '0.1 V (confident)' },
  { addr: 0x0015, type: 's16', scale: 0.1, metric: 'Battery current', note: '0.1 A, + charging (confident)' },
  { addr: 0x0016, type: 's16', metric: 'Battery power', note: 'W, + charging (confident)' },
  { addr: 0x0017, metric: 'BMS connected', enum: { 0: 'Disconnected', 1: 'Connected' }, note: 'medium: BMS link state' },
  { addr: 0x0018, type: 's16', metric: 'Battery temperature', note: '°C (confident)' },
  { addr: 0x001c, metric: 'Battery state of charge', note: '% (confident)' },
  { addr: 0x0040, type: 'u32', metric: 'Inverter fault bits', note: 'UNVERIFIED: inverter fault message bitfield (u32)' },
  { addr: 0x0043, metric: 'Manager fault bits', note: 'UNVERIFIED: manager (ARM) fault bitfield' },
  { addr: 0x0046, type: 's32', metric: 'Feed-in power', note: 'meter power W, + export / − import (confident)' },
  { addr: 0x004c, scale: 0.1, metric: 'EPS voltage', note: 'EPS (backup) output voltage 0.1 V, X1 (medium)' },
  { addr: 0x004d, scale: 0.1, metric: 'EPS current', note: 'EPS output current 0.1 A, X1 (medium)' },
  { addr: 0x004e, metric: 'EPS power', note: 'EPS output apparent power VA, X1 (medium)' },
  { addr: 0x004f, scale: 0.01, metric: 'EPS frequency', note: 'EPS output frequency 0.01 Hz (medium)' },
];

/** Three-phase (X3) per-phase block, input 0x006A–0x0087. */
export const PHASE_SPAN: [number, number] = [0x006a, 0x1e];
export function phaseMap(): RegDef[] {
  const out: RegDef[] = [];
  for (const p of [1, 2, 3]) {
    const b = 0x006a + (p - 1) * 4;
    out.push(
      { addr: b, scale: 0.1, metric: `Grid voltage ${p}`, note: `phase ${p} grid voltage 0.1 V (medium)` },
      { addr: b + 1, type: 's16', scale: 0.1, metric: `Grid current ${p}`, note: `phase ${p} inverter current 0.1 A (medium)` },
      { addr: b + 2, type: 's16', metric: `Inverter power ${p}`, note: `phase ${p} inverter power W (medium)` },
      { addr: b + 3, scale: 0.01, metric: `Grid frequency ${p}`, note: `phase ${p} frequency 0.01 Hz (medium)` },
    );
    out.push({ addr: 0x0082 + (p - 1) * 2, type: 's32', metric: `Feed-in power ${p}`, note: `UNVERIFIED: phase ${p} meter power W, + export` });
  }
  return out;
}
