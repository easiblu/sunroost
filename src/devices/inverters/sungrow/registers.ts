/**
 * Sungrow Modbus register tables and a small table decoder.
 *
 * Sources: Sungrow's public "Communication Protocol of PV Grid-Connected String Inverters" (SG) and
 * "Communication Protocol of Residential Hybrid Inverter" (SH) documents, cross-checked against
 * public register lists (facts only).
 *
 * ADDRESSING: the documents number registers from 1. The address on the wire is the documented
 * number minus 1, so documented 5000 (device type code) is wire 4999. Every `addr` below is the WIRE
 * address; the comment gives the documented number as "doc NNNN".
 *
 * 32-bit values (u32 / s32) are two registers with the LOW word first (at the lower address).
 *
 * Confidence notes per row: "confident" = address, scale and sign agree across the documents and
 * public register lists; "medium" = agreed by most sources; "UNVERIFIED" = best knowledge that must
 * be checked on a real unit (see docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  /** Wire address (documented number − 1). */
  addr: number;
  type?: RegType;
  /** Register count for ascii. */
  words?: number;
  scale?: number;
  metric: string;
  enum?: Record<number, string>;
  note: string;
}

/** A sparse register image: wire address → raw 16-bit value. */
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
  let raw: number;
  switch (def.type ?? 'u16') {
    case 'ascii':
      return decodeAscii(words);
    case 's16':
      raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
      break;
    case 'u32':
      raw = words[1] * 0x10000 + words[0];
      break;
    case 's32': {
      const u = words[1] * 0x10000 + words[0];
      raw = u > 0x7fffffff ? u - 0x100000000 : u;
      break;
    }
    default:
      raw = words[0];
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (0x${raw.toString(16).toUpperCase().padStart(4, '0')})`;
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
// Device type codes (input doc 5000 → wire 4999).

export type ModelId = 'hybrid3' | 'hybrid' | 'grid';

export interface TypeCode {
  name: string;
  model: ModelId;
  confidence: 'confident' | 'medium' | 'UNVERIFIED';
}

/** Known device type codes. Only the family (high byte) is relied on for the model id. */
export const DEVICE_TYPES: Record<number, TypeCode> = {
  // SH-RT three-phase hybrid
  0x0e00: { name: 'SH5.0RT', model: 'hybrid3', confidence: 'medium' },
  0x0e01: { name: 'SH6.0RT', model: 'hybrid3', confidence: 'medium' },
  0x0e02: { name: 'SH8.0RT', model: 'hybrid3', confidence: 'medium' },
  0x0e03: { name: 'SH10RT', model: 'hybrid3', confidence: 'medium' },
  0x0e0c: { name: 'SH5.0RT-20', model: 'hybrid3', confidence: 'UNVERIFIED' },
  0x0e0d: { name: 'SH6.0RT-20', model: 'hybrid3', confidence: 'UNVERIFIED' },
  0x0e0e: { name: 'SH8.0RT-20', model: 'hybrid3', confidence: 'UNVERIFIED' },
  0x0e0f: { name: 'SH10RT-20', model: 'hybrid3', confidence: 'UNVERIFIED' },
  // SH-RS / older SH-K single-phase hybrid
  0x0d03: { name: 'SH5K-20', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d06: { name: 'SH3K6', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d07: { name: 'SH4K6', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d0c: { name: 'SH5K-V13', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d0d: { name: 'SH3.6RS', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d0e: { name: 'SH4.6RS', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d0f: { name: 'SH5.0RS', model: 'hybrid', confidence: 'UNVERIFIED' },
  0x0d10: { name: 'SH6.0RS', model: 'hybrid', confidence: 'UNVERIFIED' },
  // SG-RT three-phase grid-tied
  0x2430: { name: 'SG5.0RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2431: { name: 'SG6.0RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2432: { name: 'SG8.0RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2433: { name: 'SG10RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2434: { name: 'SG12RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2435: { name: 'SG15RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2436: { name: 'SG17RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x2437: { name: 'SG20RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x243c: { name: 'SG7.0RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x243d: { name: 'SG3.0RT', model: 'grid', confidence: 'UNVERIFIED' },
  0x243e: { name: 'SG4.0RT', model: 'grid', confidence: 'UNVERIFIED' },
};

/**
 * Type code → family. Exact codes first, then the high byte: 0x0D single-phase hybrid, 0x0E
 * three-phase hybrid (SH-RT, SH-T: UNVERIFIED which low bytes), 0x22–0x27 SG string inverters
 * (UNVERIFIED family range). Anything else (incl. 0x0000 / 0xFFFF) → undefined.
 */
export function typeFamily(code: number): TypeCode | undefined {
  const exact = DEVICE_TYPES[code];
  if (exact) return exact;
  const hi = code >> 8;
  const hex = `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
  if (hi === 0x0d) return { name: `SH hybrid (type ${hex})`, model: 'hybrid', confidence: 'UNVERIFIED' };
  if (hi === 0x0e) return { name: `SH three-phase hybrid (type ${hex})`, model: 'hybrid3', confidence: 'UNVERIFIED' };
  if (hi >= 0x22 && hi <= 0x27) return { name: `SG string inverter (type ${hex})`, model: 'grid', confidence: 'UNVERIFIED' };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Identity and common block (input registers, function 4).

/** Serial (doc 4990–4999) through output type (doc 5002): wire 4989–5001. Used by detect. */
export const IDENTITY_SPAN: [number, number] = [4989, 13];
export const SERIAL_ADDR = 4989;
export const TYPE_ADDR = 4999;
export const NOMINAL_ADDR = 5000;

/** Firmware strings (doc 4954–4983): wire 4953–4982, 30 registers. Optional; read on connect. */
export const FIRMWARE_SPAN: [number, number] = [4953, 30];
export const FIRMWARE_MAP: RegDef[] = [
  { addr: 4953, type: 'ascii', words: 15, metric: 'Firmware version', note: 'UNVERIFIED: doc 4954 ARM software version, 15 regs ASCII (newer protocol revisions only)' },
  { addr: 4968, type: 'ascii', words: 15, metric: 'Secondary firmware version', note: 'UNVERIFIED: doc 4969 DSP (master) software version, 15 regs ASCII' },
];

/** Live common block: wire 4989–5044 (doc 4990–5045). */
export const COMMON_SPAN: [number, number] = [4989, 56];

export const OUTPUT_TYPE: Record<number, string> = { 0: 'Single-phase', 1: 'Three-phase 4-wire', 2: 'Three-phase 3-wire' };

/** Work / system state codes (SG doc 5038, SH doc 13000). */
export const WORK_STATE: Record<number, string> = {
  0x0000: 'Run', 0x0040: 'Run', 0x0410: 'Off-grid charge', 0x0200: 'Update failed', 0x0400: 'Maintenance',
  0x0800: 'Forced mode', 0x1000: 'Off-grid', 0x1111: 'Uninitialized', 0x1200: 'Initial standby',
  0x1300: 'Shutdown', 0x1400: 'Standby', 0x1500: 'Emergency stop', 0x1600: 'Starting',
  0x1700: 'AFCI self test', 0x1800: 'Intelligent station building', 0x1900: 'Safe mode',
  0x2000: 'Open loop', 0x2501: 'Restarting', 0x4000: 'External EMS', 0x5500: 'Fault', 0x8000: 'Stop',
  0x8100: 'Derating run', 0x8200: 'Dispatch run', 0x9100: 'Warning run',
};

export const INFO_MAP: RegDef[] = [
  { addr: 4989, type: 'ascii', words: 10, metric: 'Serial number', note: 'doc 4990–4999 serial, 10 regs ASCII (confident)' },
  { addr: 4999, metric: 'Device type code', note: 'doc 5000 device type code (confident)' },
  { addr: 5000, scale: 100, metric: 'Rated power', note: 'doc 5001 nominal active power 0.1 kW → W (confident)' },
  { addr: 5001, metric: 'Output type', enum: OUTPUT_TYPE, note: 'doc 5002 output type 0 1P / 1 3P4L / 2 3P3L (confident)' },
];

export const COMMON_MAP: RegDef[] = [
  { addr: 5007, type: 's16', scale: 0.1, metric: 'Temperature', note: 'doc 5008 inside temperature 0.1 °C (confident)' },
  { addr: 5010, scale: 0.1, metric: 'PV voltage 1', note: 'doc 5011 MPPT1 voltage 0.1 V (confident)' },
  { addr: 5011, scale: 0.1, metric: 'PV current 1', note: 'doc 5012 MPPT1 current 0.1 A (confident)' },
  { addr: 5012, scale: 0.1, metric: 'PV voltage 2', note: 'doc 5013 MPPT2 voltage 0.1 V (confident)' },
  { addr: 5013, scale: 0.1, metric: 'PV current 2', note: 'doc 5014 MPPT2 current 0.1 A (confident)' },
  { addr: 5016, type: 'u32', metric: 'PV power', note: 'doc 5017–5018 total DC power W, u32 (confident)' },
  { addr: 5018, scale: 0.1, metric: 'Grid voltage 1', note: 'doc 5019 phase A voltage 0.1 V (confident; line A-B on 3P3L)' },
  { addr: 5021, scale: 0.1, metric: 'Inverter current 1', note: 'doc 5022 phase A current 0.1 A (confident)' },
  { addr: 5030, type: 's32', metric: 'Inverter power', note: 'doc 5031–5032 total active power W (confident; u32 on SG, s32 on SH)' },
  { addr: 5035, scale: 0.1, metric: 'Grid frequency', note: 'doc 5036 grid frequency 0.1 Hz (medium; some SH firmware gives 0.01 Hz at doc 5242)' },
];

/** Third MPPT (SH-T, larger SG-RT). */
export const PV3_MAP: RegDef[] = [
  { addr: 5014, scale: 0.1, metric: 'PV voltage 3', note: 'doc 5015 MPPT3 voltage 0.1 V (medium; 0 when absent)' },
  { addr: 5015, scale: 0.1, metric: 'PV current 3', note: 'doc 5016 MPPT3 current 0.1 A (medium; 0 when absent)' },
];

export const PHASE23_MAP: RegDef[] = [
  { addr: 5019, scale: 0.1, metric: 'Grid voltage 2', note: 'doc 5020 phase B voltage 0.1 V (confident)' },
  { addr: 5020, scale: 0.1, metric: 'Grid voltage 3', note: 'doc 5021 phase C voltage 0.1 V (confident)' },
  { addr: 5022, scale: 0.1, metric: 'Inverter current 2', note: 'doc 5023 phase B current 0.1 A (confident)' },
  { addr: 5023, scale: 0.1, metric: 'Inverter current 3', note: 'doc 5024 phase C current 0.1 A (confident)' },
];

// ---------------------------------------------------------------------------------------------
// SG grid-tied only.

export const SG_MAP: RegDef[] = [
  { addr: 5002, scale: 0.1, metric: 'PV energy today', note: 'doc 5003 daily power yield 0.1 kWh (confident)' },
  { addr: 5003, type: 'u32', metric: 'PV energy total', note: 'doc 5004–5005 total power yield kWh (medium: 1 kWh on SG, 0.1 kWh on SH)' },
  { addr: 5037, metric: 'Device mode', enum: WORK_STATE, note: 'doc 5038 work state (medium)' },
  { addr: 5044, metric: 'Fault word', note: 'UNVERIFIED: doc 5045 fault/alarm code 1' },
];

/** Meter block (only with a Sungrow meter): wire 5082–5091. Optional read. */
export const SG_METER_SPAN: [number, number] = [5082, 10];
export const SG_METER_MAP: RegDef[] = [
  { addr: 5082, type: 's32', metric: 'Meter power', note: 'UNVERIFIED: doc 5083–5084 meter power W, + import / − export' },
  { addr: 5090, type: 's32', metric: 'Load power raw', note: 'UNVERIFIED: doc 5091–5092 load power W' },
];

// ---------------------------------------------------------------------------------------------
// SH hybrid block: wire 12999–13046 (doc 13000–13047).

export const HYBRID_SPAN: [number, number] = [12999, 48];

/** Running state bits (doc 13001). */
export const RUN_BIT = { pv: 0x01, charging: 0x02, discharging: 0x04, loadPositive: 0x08, feedIn: 0x10, importing: 0x20 } as const;

export const HYBRID_MAP: RegDef[] = [
  { addr: 12999, metric: 'Device mode', enum: WORK_STATE, note: 'doc 13000 system state (medium)' },
  { addr: 13000, metric: 'Running state', note: 'doc 13001 running state bits: 1 PV, 2 charging, 4 discharging, 16 feed-in, 32 import (confident)' },
  { addr: 13001, scale: 0.1, metric: 'PV energy today', note: 'doc 13002 daily PV generation 0.1 kWh (confident)' },
  { addr: 13002, type: 'u32', scale: 0.1, metric: 'PV energy total', note: 'doc 13003–13004 total PV generation 0.1 kWh (confident)' },
  { addr: 13007, type: 's32', metric: 'Load power', note: 'doc 13008–13009 load power W (confident)' },
  { addr: 13009, type: 's32', metric: 'Export power', note: 'doc 13010–13011 export power W, + export / − import (confident)' },
  { addr: 13019, scale: 0.1, metric: 'Battery voltage', note: 'doc 13020 battery voltage 0.1 V (confident)' },
  { addr: 13020, metric: 'Battery current raw', note: 'doc 13021 battery current 0.1 A; unsigned on most firmware, direction from running state (medium)' },
  { addr: 13021, metric: 'Battery power raw', note: 'doc 13022 battery power W; unsigned, direction from running state (confident)' },
  { addr: 13022, scale: 0.1, metric: 'Battery state of charge', note: 'doc 13023 SOC 0.1 % (confident)' },
  { addr: 13023, scale: 0.1, metric: 'Battery state of health', note: 'doc 13024 SOH 0.1 % (medium)' },
  { addr: 13024, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'doc 13025 battery temperature 0.1 °C (confident)' },
  { addr: 13025, scale: 0.1, metric: 'Discharge energy today', note: 'doc 13026 daily battery discharge 0.1 kWh (medium)' },
  { addr: 13026, type: 'u32', scale: 0.1, metric: 'Discharge energy total', note: 'doc 13027–13028 total battery discharge 0.1 kWh (medium)' },
  { addr: 13035, scale: 0.1, metric: 'Import energy today', note: 'doc 13036 daily import 0.1 kWh (medium)' },
  { addr: 13036, type: 'u32', scale: 0.1, metric: 'Import energy total', note: 'doc 13037–13038 total import 0.1 kWh (medium)' },
  { addr: 13039, scale: 0.1, metric: 'Charge energy today', note: 'UNVERIFIED: doc 13040 daily battery charge 0.1 kWh' },
  { addr: 13040, type: 'u32', scale: 0.1, metric: 'Charge energy total', note: 'UNVERIFIED: doc 13041–13042 total battery charge 0.1 kWh' },
  { addr: 13044, scale: 0.1, metric: 'Export energy today', note: 'doc 13045 daily export 0.1 kWh (medium)' },
  { addr: 13045, type: 'u32', scale: 0.1, metric: 'Export energy total', note: 'doc 13046–13047 total export 0.1 kWh (medium)' },
];
