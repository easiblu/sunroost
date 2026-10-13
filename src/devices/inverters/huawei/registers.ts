/**
 * Huawei SUN2000 register tables and a small table decoder.
 *
 * Source: Huawei's public "SUN2000 MODBUS Interface Definitions" (SUN2000-(2KTL-6KTL)-L1,
 * SUN2000-(3KTL-10KTL)-M1 and later -M3 issues) plus the LUNA2000 / DTSU666-H sections of the same
 * document. Every register is a holding register read with function 3; multi-word values are
 * big-endian, high word first. Addresses are decimal as in the document.
 *
 * Confidence per row: "confident" = address, type and gain agree across the Huawei issues and the
 * widely used open-source register lists; "UNVERIFIED" = best knowledge, still to be checked on a
 * real unit (see docs/HARDWARE_TEST.md).
 *
 * Read planning: Huawei rejects a read that crosses an undefined register and caps reads at 125
 * registers, so the driver reads small known-contiguous spans only (constants below).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 'i16' | 'u32' | 'i32' | 'ascii';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** Registers for ascii. */
  words?: number;
  /** Multiplier applied to the raw value (Huawei "gain" 10 → 0.1). */
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

/** Huawei pads strings with NUL (sometimes 0xFF or spaces). */
export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

function width(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 'i32' ? 2 : 1;
}

export function rawValue(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < width(def); i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  switch (def.type ?? 'u16') {
    case 'ascii':
      return decodeAscii(words);
    case 'i16':
      return words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
    case 'u32':
      return ((words[0] << 16) | words[1]) >>> 0;
    case 'i32':
      return (words[0] << 16) | words[1];
    default:
      return words[0];
  }
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const raw = rawValue(def, regs);
  if (raw === undefined || typeof raw === 'string') return raw;
  if (def.enum) return def.enum[raw] ?? `Unknown (0x${raw.toString(16).padStart(4, '0')})`;
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
// Identity (read once on connect).

/** Model name + serial number + part number: 30000–30034. */
export const IDENT_SPAN: [number, number] = [30000, 35];
/** Firmware / software version strings: 30035–30064. */
export const VERSION_SPAN: [number, number] = [30035, 30];
/** Model id, string count, MPPT count, rated power: 30070–30076. */
export const RATING_SPAN: [number, number] = [30070, 7];

export const INFO_MAP: RegDef[] = [
  { addr: 30000, type: 'ascii', words: 15, metric: 'Model name', note: 'confident: model, e.g. "SUN2000-5KTL-L1"' },
  { addr: 30015, type: 'ascii', words: 10, metric: 'Serial number', note: 'confident: SN' },
  { addr: 30025, type: 'ascii', words: 10, metric: 'Part number', note: 'confident: PN (BOM code)' },
  { addr: 30035, type: 'ascii', words: 15, metric: 'Secondary firmware version', note: 'UNVERIFIED: "firmware version" string' },
  { addr: 30050, type: 'ascii', words: 15, metric: 'Firmware version', note: 'confident: software version, e.g. V100R001C00SPC124' },
  { addr: 30070, metric: 'Model ID', note: 'confident: numeric model id' },
  { addr: 30071, metric: 'PV string count', note: 'confident: number of PV strings' },
  { addr: 30072, metric: 'MPPT count', note: 'confident: number of MPP trackers' },
  { addr: 30073, type: 'u32', metric: 'Max AC output power', note: 'confident: rated power Pn, u32 W (kW gain 1000)' },
];

// ---------------------------------------------------------------------------------------------
// Inverter live data.

/** Alarm words 1–3 (bitfields): 32008–32010. confident. */
export const ALARM_SPAN: [number, number] = [32008, 3];
/** PV strings start here: voltage i16 0.1 V, current i16 0.01 A, per string (up to 24). confident. */
export const PV_BASE = 32016;
/** Input power .. fault code: 32064–32095. */
export const MAIN_SPAN: [number, number] = [32064, 32];
/** Energy counters: 32106–32117. */
export const ENERGY_SPAN: [number, number] = [32106, 12];

export function pvMap(strings: number): RegDef[] {
  const out: RegDef[] = [];
  for (let n = 1; n <= strings; n++) {
    const a = PV_BASE + (n - 1) * 2;
    out.push({ addr: a, type: 'i16', scale: 0.1, metric: `PV voltage ${n}`, note: 'confident: 0.1 V' });
    out.push({ addr: a + 1, type: 'i16', scale: 0.01, metric: `PV current ${n}`, note: 'confident: 0.01 A' });
  }
  return out;
}

/** Device status (32089). confident for the common codes. */
export const DEVICE_STATUS: Record<number, string> = {
  0x0000: 'Standby: initializing',
  0x0001: 'Standby: detecting insulation resistance',
  0x0002: 'Standby: detecting irradiation',
  0x0003: 'Standby: grid detecting',
  0x0100: 'Starting',
  0x0200: 'On-grid',
  0x0201: 'On-grid: power limited',
  0x0202: 'On-grid: self-derating',
  0x0203: 'Off-grid',
  0x0300: 'Shutdown: fault',
  0x0301: 'Shutdown: command',
  0x0302: 'Shutdown: OVGR',
  0x0303: 'Shutdown: communication disconnected',
  0x0304: 'Shutdown: power limited',
  0x0305: 'Shutdown: manual startup required',
  0x0306: 'Shutdown: DC switches disconnected',
  0x0307: 'Shutdown: rapid cutoff',
  0x0308: 'Shutdown: input underpower',
  0x0401: 'Grid scheduling: cosphi-P curve',
  0x0402: 'Grid scheduling: Q-U curve',
  0x0403: 'Grid scheduling: PF-U curve',
  0x0404: 'Grid scheduling: dry contact',
  0x0405: 'Grid scheduling: Q-P curve',
  0x0500: 'Spot-check ready',
  0x0501: 'Spot-checking',
  0x0600: 'Inspecting',
  0x0700: 'AFCI self check',
  0x0800: 'I-V scanning',
  0x0900: 'DC input detection',
  0x0a00: 'Off-grid charging',
  0xa000: 'Standby: no irradiation',
};

export const MAIN_MAP: RegDef[] = [
  { addr: 32064, type: 'i32', metric: 'Input power', note: 'confident: DC input power i32 W' },
  { addr: 32066, scale: 0.1, metric: 'Line voltage A-B', note: 'confident: 0.1 V (three-phase)' },
  { addr: 32067, scale: 0.1, metric: 'Line voltage B-C', note: 'confident: 0.1 V (three-phase)' },
  { addr: 32068, scale: 0.1, metric: 'Line voltage C-A', note: 'confident: 0.1 V (three-phase)' },
  { addr: 32069, scale: 0.1, metric: 'Inverter voltage 1', note: 'confident: phase A voltage 0.1 V' },
  { addr: 32070, scale: 0.1, metric: 'Inverter voltage 2', note: 'confident: phase B voltage 0.1 V' },
  { addr: 32071, scale: 0.1, metric: 'Inverter voltage 3', note: 'confident: phase C voltage 0.1 V' },
  { addr: 32072, type: 'i32', scale: 0.001, metric: 'Inverter current 1', note: 'confident: phase A current i32 0.001 A' },
  { addr: 32074, type: 'i32', scale: 0.001, metric: 'Inverter current 2', note: 'confident: phase B current i32 0.001 A' },
  { addr: 32076, type: 'i32', scale: 0.001, metric: 'Inverter current 3', note: 'confident: phase C current i32 0.001 A' },
  { addr: 32078, type: 'i32', metric: 'Peak power today', note: 'confident: peak active power of the day i32 W' },
  { addr: 32080, type: 'i32', metric: 'Inverter power', note: 'confident: AC active power i32 W, + = output' },
  { addr: 32082, type: 'i32', metric: 'Reactive power', note: 'confident: i32 var' },
  { addr: 32084, type: 'i16', scale: 0.001, metric: 'Power factor', note: 'confident: i16 0.001' },
  { addr: 32085, scale: 0.01, metric: 'Inverter frequency', note: 'confident: grid frequency 0.01 Hz' },
  { addr: 32086, scale: 0.01, metric: 'Efficiency', note: 'confident: 0.01 %' },
  { addr: 32087, type: 'i16', scale: 0.1, metric: 'Temperature', note: 'confident: internal temperature i16 0.1 °C' },
  { addr: 32088, scale: 0.001, metric: 'Insulation resistance', note: 'confident: 0.001 MΩ' },
  { addr: 32089, metric: 'Device mode', enum: DEVICE_STATUS, note: 'confident: device status' },
  { addr: 32090, metric: 'Fault word', note: 'confident: fault code (0 = none)' },
];

export const ALARM_MAP: RegDef[] = [
  { addr: 32008, metric: 'Alarm word 1', note: 'confident: alarm 1 bitfield' },
  { addr: 32009, metric: 'Alarm word 2', note: 'confident: alarm 2 bitfield' },
  { addr: 32010, metric: 'Alarm word 3', note: 'confident: alarm 3 bitfield' },
];

export const ENERGY_MAP: RegDef[] = [
  { addr: 32106, type: 'u32', scale: 0.01, metric: 'Inverter energy total', note: 'confident: accumulated energy yield u32 0.01 kWh' },
  { addr: 32114, type: 'u32', scale: 0.01, metric: 'Inverter energy today', note: 'confident: daily energy yield u32 0.01 kWh' },
];

// ---------------------------------------------------------------------------------------------
// Power meter (DTSU666-H / DTSU666 via the inverter): 37100–37138.

export const METER_SPAN: [number, number] = [37100, 39];
export const METER_MAP: RegDef[] = [
  { addr: 37100, metric: 'Meter status', note: 'confident: 0 offline, 1 normal' },
  { addr: 37101, type: 'i32', scale: 0.1, metric: 'Meter voltage 1', note: 'confident: phase A voltage i32 0.1 V' },
  { addr: 37103, type: 'i32', scale: 0.1, metric: 'Meter voltage 2', note: 'confident: phase B voltage i32 0.1 V' },
  { addr: 37105, type: 'i32', scale: 0.1, metric: 'Meter voltage 3', note: 'confident: phase C voltage i32 0.1 V' },
  { addr: 37107, type: 'i32', scale: 0.01, metric: 'Meter current 1', note: 'confident: phase A current i32 0.01 A' },
  { addr: 37109, type: 'i32', scale: 0.01, metric: 'Meter current 2', note: 'confident: phase B current i32 0.01 A' },
  { addr: 37111, type: 'i32', scale: 0.01, metric: 'Meter current 3', note: 'confident: phase C current i32 0.01 A' },
  {
    addr: 37113, type: 'i32', metric: 'Meter power',
    note: 'confident address; sign UNVERIFIED: Huawei documents + = feed-in to grid (export), − = import',
  },
  { addr: 37118, type: 'i16', scale: 0.01, metric: 'Meter frequency', note: 'confident: i16 0.01 Hz' },
  { addr: 37119, type: 'i32', scale: 0.01, metric: 'Export energy total', note: 'medium: positive active energy (feed-in) i32 0.01 kWh' },
  { addr: 37121, type: 'i32', scale: 0.01, metric: 'Import energy total', note: 'medium: reverse active energy (from grid) i32 0.01 kWh' },
  { addr: 37125, metric: 'Meter type', note: 'medium: 0 single-phase, 1 three-phase' },
  { addr: 37132, type: 'i32', metric: 'Meter power 1', note: 'medium: phase A active power i32 W, same sign as 37113' },
  { addr: 37134, type: 'i32', metric: 'Meter power 2', note: 'medium: phase B active power i32 W' },
  { addr: 37136, type: 'i32', metric: 'Meter power 3', note: 'medium: phase C active power i32 W' },
];

// ---------------------------------------------------------------------------------------------
// Battery (LUNA2000).

export const BATTERY_STATUS: Record<number, string> = {
  0: 'Offline', 1: 'Standby', 2: 'Running', 3: 'Fault', 4: 'Sleep',
};

/** Storage unit 1: 37000–37022. */
export const UNIT1_SPAN: [number, number] = [37000, 23];
export const UNIT1_MAP: RegDef[] = [
  { addr: 37000, metric: 'Unit 1 status raw', note: 'confident: unit 1 running status 0 offline/1 standby/2 running/3 fault/4 sleep' },
  { addr: 37001, type: 'i32', metric: 'Unit 1 power', note: 'confident: unit 1 charge/discharge power i32 W, + = charging' },
  { addr: 37003, scale: 0.1, metric: 'Unit 1 voltage', note: 'confident: unit 1 bus voltage 0.1 V' },
  { addr: 37004, scale: 0.1, metric: 'Unit 1 state of charge', note: 'confident: unit 1 SOC 0.1 %' },
  { addr: 37015, type: 'u32', scale: 0.01, metric: 'Unit 1 charge energy today', note: 'medium: u32 0.01 kWh' },
  { addr: 37017, type: 'u32', scale: 0.01, metric: 'Unit 1 discharge energy today', note: 'medium: u32 0.01 kWh' },
  { addr: 37021, type: 'i16', scale: 0.1, metric: 'Unit 1 current', note: 'medium: unit 1 bus current i16 0.1 A' },
  { addr: 37022, type: 'i16', scale: 0.1, metric: 'Battery temperature', note: 'medium: unit 1 battery temperature i16 0.1 °C' },
];

/** Whole storage system: 37758–37787. */
export const SYSTEM_SPAN: [number, number] = [37758, 30];
export const SYSTEM_MAP: RegDef[] = [
  { addr: 37758, type: 'u32', metric: 'Rated capacity raw', note: 'confident: rated capacity u32 Wh' },
  { addr: 37760, scale: 0.1, metric: 'System state of charge', note: 'confident: SOC 0.1 %' },
  { addr: 37762, metric: 'System status raw', note: 'confident: running status, same codes as 37000' },
  { addr: 37763, scale: 0.1, metric: 'System voltage', note: 'confident: bus voltage 0.1 V' },
  { addr: 37764, type: 'i16', scale: 0.1, metric: 'System current', note: 'confident: bus current i16 0.1 A' },
  { addr: 37765, type: 'i32', metric: 'System power', note: 'confident: charge/discharge power i32 W, + = charging' },
  { addr: 37780, type: 'u32', scale: 0.01, metric: 'Charge energy total', note: 'confident: u32 0.01 kWh' },
  { addr: 37782, type: 'u32', scale: 0.01, metric: 'Discharge energy total', note: 'confident: u32 0.01 kWh' },
  { addr: 37784, type: 'u32', scale: 0.01, metric: 'Charge energy today', note: 'confident: u32 0.01 kWh' },
  { addr: 37786, type: 'u32', scale: 0.01, metric: 'Discharge energy today', note: 'confident: u32 0.01 kWh' },
];
