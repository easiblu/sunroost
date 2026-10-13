/**
 * MidNite Solar MN15-12KW-AIO ("The One") register tables and a small table decoder.
 *
 * The AIO is an OEM build of the Senergy (Senergytec) SE 11.4KHB-UL split-phase hybrid: 11.4 kW,
 * 120/240 V split phase, 48 V battery, three MPPTs. It is sold elsewhere as a Senergy model, and the
 * community ESPHome map for "Duracell / Senergy / CYD Skyline / MidNite AIO" uses the same holding
 * registers. MidNite does not publish an AIO register map of its own (the "Solar inverter charger"
 * Modbus PDFs on midnitesolar.com/firmware are SRNE documents for other products, not the AIO).
 *
 * Every register is a holding register read with function 3, 9600 8N1, unit 1. 32-bit values are
 * big-endian (high word first). Addresses are the hex addresses the Senergy protocol uses:
 *   0x1001.. inverter / PV block   0x1300.. grid (meter) block   0x1350.. EPS (backup output) block
 *   0x1A00.. product info          0x2000.. battery block        0x2100.. / 0x30B0.. settings
 *
 * Sources (facts only, no code copied): evcc's "senergy-hybrid" template (SOC, battery power, grid
 * L1/L2/L3 power, PV total power, import energy, currents, work mode), the iPeel/HA-Skyline Home
 * Assistant integration (block layout and offsets, battery V/I, grid V/I, EPS per-phase power, MPPT
 * V/I, temperature, settings at 0x2100..), and the gi1mic ESPHome map (mode codes, firmware strings,
 * rated values, grid frequency). Per-row confidence: "confident" = two or more independent sources
 * agree on address, type and scale; "medium" = one source; "UNVERIFIED" = inferred from the block
 * layout or a single unconfirmed source. Nothing here has been checked on an AIO yet
 * (docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** ascii only: register count. */
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

function width(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

/** ASCII, two characters per register (high byte first); NUL / 0xFF padding and non-printables dropped. */
export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < width(def); i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  const type = def.type ?? 'u16';
  if (type === 'ascii') return decodeAscii(words);
  let raw: number;
  if (type === 'u32' || type === 's32') {
    raw = words[0] * 0x10000 + words[1];
    if (type === 's32' && raw >= 0x80000000) raw -= 0x100000000;
  } else {
    raw = type === 's16' && words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
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
// Product information, read once on connect.

export const MODEL_REG = 0x1a00;
export const SERIAL_REG = 0x1a10;
/** Model, serial and protocol version: 0x1A00–0x1A18. */
export const IDENT_SPAN: [number, number] = [0x1a00, 0x19];
/** Firmware strings and rated values: 0x1A1C–0x1A48. */
export const VERSION_SPAN: [number, number] = [0x1a1c, 0x2d];

export const INFO_MAP: RegDef[] = [
  { addr: 0x1a00, type: 'ascii', words: 8, metric: 'Model name', note: 'confident: product model, 16 ASCII chars (HA-Skyline + ESPHome map)' },
  { addr: 0x1a10, type: 'ascii', words: 8, metric: 'Serial number', note: 'confident: product serial, 16 ASCII chars (HA-Skyline + ESPHome map)' },
  { addr: 0x1a18, metric: 'Protocol version', note: 'UNVERIFIED: Modbus map revision code' },
  { addr: 0x1a1c, type: 'ascii', words: 3, metric: 'Firmware version', note: 'confident: master (DSP) software version, 6 ASCII chars (HA-Skyline + ESPHome map)' },
  { addr: 0x1a26, type: 'ascii', words: 3, metric: 'Secondary firmware version', note: 'medium: slave software version, 6 ASCII chars (HA-Skyline)' },
  { addr: 0x1a46, metric: 'Rated power', note: 'medium: rated output power W (ESPHome map); used for Load percentage' },
];

// ---------------------------------------------------------------------------------------------
// Live data.

/** Running state at 0x101D. */
export const RUN_STATE: Record<number, string> = {
  0: 'Initializing', 1: 'Standby', 2: 'On-grid', 3: 'On-grid', 4: 'Off-grid', 5: 'Fault', 9: 'Shutdown',
};

/** Inverter / PV block, 0x1001–0x102C. */
export const INVERTER_SPAN: [number, number] = [0x1001, 0x2c];
export const INVERTER_MAP: RegDef[] = [
  { addr: 0x1001, scale: 0.1, metric: 'Inverter voltage 1', note: 'medium: phase A (L1) inverter AC voltage 0.1 V' },
  { addr: 0x1003, type: 's32', scale: 0.1, metric: 'Inverter power 1', note: 'medium: phase A inverter active power 0.1 W (HA-Skyline offset 2)' },
  { addr: 0x1005, scale: 0.01, metric: 'AC output frequency', note: 'medium: inverter frequency 0.01 Hz' },
  { addr: 0x1006, scale: 0.1, metric: 'Inverter voltage 2', note: 'UNVERIFIED: phase B (L2) inverter AC voltage 0.1 V' },
  { addr: 0x1008, type: 's32', scale: 0.1, metric: 'Inverter power 2', note: 'medium: phase B inverter active power 0.1 W (HA-Skyline offset 7)' },
  { addr: 0x1010, scale: 0.1, metric: 'PV voltage 1', note: 'confident: MPPT1 voltage 0.1 V (HA-Skyline + Polycab map)' },
  { addr: 0x1011, scale: 0.01, metric: 'PV current 1', note: 'confident: MPPT1 current 0.01 A (HA-Skyline + Polycab map)' },
  { addr: 0x1012, type: 'u32', scale: 0.1, metric: 'PV power 1', note: 'confident: MPPT1 power 0.1 W (HA-Skyline + ESPHome map)' },
  { addr: 0x1014, scale: 0.1, metric: 'PV voltage 2', note: 'confident: MPPT2 voltage 0.1 V (HA-Skyline + Polycab map)' },
  { addr: 0x1015, scale: 0.01, metric: 'PV current 2', note: 'confident: MPPT2 current 0.01 A (HA-Skyline + Polycab map)' },
  { addr: 0x1016, type: 'u32', scale: 0.1, metric: 'PV power 2', note: 'confident: MPPT2 power 0.1 W (HA-Skyline + ESPHome map)' },
  { addr: 0x1018, scale: 0.1, metric: 'PV voltage 3', note: 'UNVERIFIED: MPPT3 voltage 0.1 V (block pattern; AIO has 3 MPPTs)' },
  { addr: 0x1019, scale: 0.01, metric: 'PV current 3', note: 'UNVERIFIED: MPPT3 current 0.01 A (block pattern)' },
  { addr: 0x101a, type: 'u32', scale: 0.1, metric: 'PV power 3', note: 'UNVERIFIED: MPPT3 power 0.1 W (block pattern; one map reads 0x101A as a temperature)' },
  { addr: 0x101c, type: 's16', metric: 'Temperature', note: 'confident: inverter temperature 1 °C (HA-Skyline + ESPHome map)' },
  { addr: 0x101d, metric: 'Device mode', enum: RUN_STATE, note: 'medium: running state 0 init / 1 standby / 3 on-grid / 4 off-grid / 5 fault / 9 shutdown (ESPHome map); 2 UNVERIFIED' },
  { addr: 0x101e, type: 'u32', metric: 'Fault word', note: 'UNVERIFIED: fault / protection bitmask, 0 = none' },
];

/** Total PV input power, read separately (some firmware may not answer past 0x1040). */
export const PV_TOTAL_SPAN: [number, number] = [0x1048, 2];
export const PV_TOTAL_MAP: RegDef[] = [
  { addr: 0x1048, type: 'u32', scale: 0.1, metric: 'PV power total', note: 'confident: total PV input power 0.1 W (evcc, fixed and re-verified upstream)' },
];

/** Grid (meter / CT) block, 0x1300–0x1339. Grid power: + import, − export. */
export const GRID_SPAN: [number, number] = [0x1300, 0x3a];
export const GRID_MAP: RegDef[] = [
  { addr: 0x1300, type: 's32', scale: 0.1, metric: 'Grid power 1', note: 'confident: L1 grid power 0.1 W, + import (evcc + HA-Skyline + ESPHome map)' },
  { addr: 0x1302, type: 's32', scale: 0.1, metric: 'Grid power 2', note: 'medium: L2 grid power 0.1 W (evcc)' },
  { addr: 0x130a, type: 's32', scale: 0.1, metric: 'Load power non-essential', note: 'medium: load on the grid side of the inverter 0.1 W (HA-Skyline "grid tied load")' },
  { addr: 0x131a, scale: 0.1, metric: 'Grid voltage 1', note: 'confident: L1 grid voltage 0.1 V (HA-Skyline + ESPHome map)' },
  { addr: 0x131b, scale: 0.1, metric: 'Grid voltage 2', note: 'UNVERIFIED: L2 grid voltage 0.1 V (block pattern)' },
  { addr: 0x131d, type: 's32', scale: 0.01, metric: 'Grid current 1', note: 'confident: L1 grid current 0.01 A (evcc + HA-Skyline)' },
  { addr: 0x131f, type: 's32', scale: 0.01, metric: 'Grid current 2', note: 'medium: L2 grid current 0.01 A (evcc)' },
  { addr: 0x1338, scale: 0.01, metric: 'Grid frequency', note: 'medium: grid frequency 0.01 Hz (ESPHome map)' },
];

/**
 * EPS (backup / AC output) block, 0x1350–0x1363. HA-Skyline reads per-phase power at offsets 3, 9
 * and 14, which fits phase records of voltage (1) + current (2) + power (2) with one extra word
 * (frequency) after phase A. The voltage and frequency rows are inferred from that layout.
 */
export const EPS_SPAN: [number, number] = [0x1350, 0x14];
export const EPS_MAP: RegDef[] = [
  { addr: 0x1350, scale: 0.1, metric: 'AC output voltage 1', note: 'UNVERIFIED: EPS L1 voltage 0.1 V (inferred from block layout)' },
  { addr: 0x1353, type: 's32', scale: 0.1, metric: 'Load power 1', note: 'medium: EPS L1 active power 0.1 W (HA-Skyline + ESPHome map)' },
  { addr: 0x1356, scale: 0.1, metric: 'AC output voltage 2', note: 'UNVERIFIED: EPS L2 voltage 0.1 V (inferred from block layout)' },
  { addr: 0x1359, type: 's32', scale: 0.1, metric: 'Load power 2', note: 'medium: EPS L2 active power 0.1 W (HA-Skyline)' },
];

/** Battery block, 0x2000–0x2012. */
export const BATTERY_SPAN: [number, number] = [0x2000, 0x13];
export const BATTERY_MAP: RegDef[] = [
  { addr: 0x2000, metric: 'Battery state of charge', note: 'confident: SOC % (evcc + HA-Skyline + ESPHome map)' },
  { addr: 0x2006, scale: 0.1, metric: 'Battery voltage', note: 'confident: battery voltage 0.1 V (HA-Skyline + ESPHome map)' },
  { addr: 0x2007, type: 's32', scale: 0.01, metric: 'Battery current raw', note: 'confident address/scale: 0.01 A (HA-Skyline + ESPHome map); sign UNVERIFIED' },
  { addr: 0x2009, type: 's32', scale: 0.1, metric: 'Battery power raw', note: 'confident address/scale: 0.1 W (evcc + HA-Skyline); + discharging per evcc (UNVERIFIED)' },
];

/**
 * Sign of the raw battery registers: evcc treats 0x2009 as "+ discharging" (its battery convention).
 * Sunroost uses + charging, so raw power and current are negated. Flip this if a real unit
 * shows the opposite.
 */
export const RAW_BATTERY_DISCHARGE_POSITIVE = true;
