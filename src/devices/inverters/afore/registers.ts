/**
 * Afore hybrid (AF-SL single-phase, AF-TH three-phase) Modbus register tables and a small decoder.
 *
 * Sources:
 *  - Afore "T6 communication protocol" V1.0 (2021-11), the vendor's Modbus RTU map. It documents the
 *    info block (input 0–53), the PV/grid block (input 500–566), energy (input 1000–1023), run state
 *    and temperatures (input 2500–2515), fault words (input 3000–3027) and the system / grid-code
 *    holding registers. Rows taken from it are marked "confident".
 *  - The community ha-solarman "afore_hybrid" definition (tested on an Afore F5K-SL and a rebadged
 *    BLUESUN BSE15KH3) for the battery block (input 2000–2014), per-phase load (input 541–546), PV
 *    energy total (input 1026–1027) and the hybrid holding registers. The vendor sheet doesn't list
 *    these, so they are "UNVERIFIED" until checked on a real unit (docs/HARDWARE_TEST.md).
 *
 * Live data is read with function 4 (input registers); settings with function 3 (holding).
 * 32-bit values are two registers, high word at the lower address (medium confidence: agrees with
 * the community definition's word order and with the sane values it reports).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii' | 'ver';

export interface RegDef {
  addr: number;
  /** u16 (default), s16, u32/s32 (two registers, high word first), ascii (`words` registers), ver (XXX.XX). */
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

function wordsOf(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < wordsOf(def); i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  let raw: number;
  switch (def.type ?? 'u16') {
    case 'ascii':
      return decodeAscii(words);
    case 'ver':
      return (words[0] / 100).toFixed(2);
    case 'u32':
      raw = words[0] * 0x10000 + words[1];
      break;
    case 's32':
      raw = (((words[0] << 16) | words[1]) >> 0);
      break;
    case 's16':
      raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
      break;
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
// Information block (input 0–53), read once on connect and by the auto-detect probe.

export const INFO_SPAN: [number, number] = [0, 54];
/** Inverter type at input 6: 0–99 single-phase on-grid, 100–199 three-phase on-grid,
 * 200–299 single/split-phase hybrid, 300–399 three-phase hybrid (confident, vendor doc). */
export const TYPE_REG = 6;
export const SERIAL_REG = 41;

export const INFO_MAP: RegDef[] = [
  { addr: 0, type: 'ascii', words: 6, metric: 'Model name', note: 'UNVERIFIED: "inverter name", 6 registers; ASCII assumed' },
  { addr: 6, metric: 'Inverter type', note: 'confident: type code, see TYPE_REG' },
  { addr: 7, type: 'u32', metric: 'Max AC output power', note: 'confident: rated power W' },
  { addr: 20, type: 'ver', metric: 'Protocol version', note: 'confident: XXX.XX' },
  { addr: 25, type: 'ver', metric: 'Firmware version', note: 'confident: master DSP version XXX.XX' },
  { addr: 30, type: 'ver', metric: 'Secondary firmware version', note: 'confident: slave DSP version XXX.XX' },
  { addr: 35, type: 'ver', metric: 'HMI firmware version', note: 'confident: HMI (display board) version XXX.XX' },
  { addr: 41, type: 'ascii', words: 8, metric: 'Serial number', note: 'confident: 16 ASCII chars, high byte first' },
  { addr: 52, type: 'u32', metric: 'Inverter character', note: 'confident: B0–2 0 on-grid / 1 LV hybrid / 2 HV hybrid; B3–5 0 single / 1 split / 2 three phase; B6–9 MPPT count − 1' },
];

// ---------------------------------------------------------------------------------------------
// Live data.

/** PV and grid block, input 500–566. */
export const GRID_SPAN: [number, number] = [500, 67];
export const GRID_MAP: RegDef[] = [
  { addr: 500, scale: 0.1, metric: 'Bus voltage', note: 'confident: DC bus 0.1 V' },
  { addr: 507, scale: 0.1, metric: 'Grid voltage 1', note: 'confident: R phase 0.1 V' },
  { addr: 508, scale: 0.1, metric: 'Grid voltage 2', note: 'confident: S phase 0.1 V (three-phase only)' },
  { addr: 509, scale: 0.1, metric: 'Grid voltage 3', note: 'confident: T phase 0.1 V (three-phase only)' },
  { addr: 510, type: 's16', scale: 0.01, metric: 'Inverter current 1', note: 'confident: R phase inverter current 0.01 A' },
  { addr: 511, type: 's16', scale: 0.01, metric: 'Inverter current 2', note: 'confident: S phase 0.01 A' },
  { addr: 512, type: 's16', scale: 0.01, metric: 'Inverter current 3', note: 'confident: T phase 0.01 A' },
  { addr: 513, scale: 0.01, metric: 'Grid frequency', note: 'confident: R phase frequency 0.01 Hz' },
  { addr: 516, type: 's32', metric: 'Inverter power 1', note: 'confident: R phase inverter active power W' },
  { addr: 518, type: 's32', metric: 'Inverter power 2', note: 'confident: S phase W' },
  { addr: 520, type: 's32', metric: 'Inverter power 3', note: 'confident: T phase W' },
  { addr: 522, type: 's32', metric: 'Inverter power', note: 'confident: total inverter active power W' },
  { addr: 527, type: 'u32', metric: 'Inverter apparent power', note: 'confident: total apparent power VA' },
  { addr: 529, type: 's32', metric: 'Meter power 1', note: 'confident: R phase meter power W, + = export (vendor sign)' },
  { addr: 531, type: 's32', metric: 'Meter power 2', note: 'confident: S phase meter power W, + = export' },
  { addr: 533, type: 's32', metric: 'Meter power 3', note: 'confident: T phase meter power W, + = export' },
  { addr: 535, type: 's32', metric: 'Meter power', note: 'confident: total grid power W, + = export (negated for SA)' },
  { addr: 541, type: 's32', metric: 'Load power 1', note: 'UNVERIFIED: R phase load W (community map only)' },
  { addr: 543, type: 's32', metric: 'Load power 2', note: 'UNVERIFIED: S phase load W' },
  { addr: 545, type: 's32', metric: 'Load power 3', note: 'UNVERIFIED: T phase load W' },
  { addr: 547, type: 's32', metric: 'Load power total', note: 'confident: total load active power W' },
  { addr: 553, type: 'u32', metric: 'PV power', note: 'confident: PV total W' },
  { addr: 555, scale: 0.1, metric: 'PV voltage 1', note: 'confident: 0.1 V' },
  { addr: 556, scale: 0.01, metric: 'PV current 1', note: 'confident: 0.01 A' },
  { addr: 557, metric: 'PV power 1', note: 'confident: W' },
  { addr: 558, scale: 0.1, metric: 'PV voltage 2', note: 'confident: 0.1 V' },
  { addr: 559, scale: 0.01, metric: 'PV current 2', note: 'confident: 0.01 A' },
  { addr: 560, metric: 'PV power 2', note: 'confident: W' },
  { addr: 561, scale: 0.1, metric: 'PV voltage 3', note: 'confident: 0.1 V (shown only when non-zero)' },
  { addr: 562, scale: 0.01, metric: 'PV current 3', note: 'confident: 0.01 A' },
  { addr: 563, metric: 'PV power 3', note: 'confident: W' },
  { addr: 564, scale: 0.1, metric: 'PV voltage 4', note: 'confident: 0.1 V (shown only when non-zero)' },
  { addr: 565, scale: 0.01, metric: 'PV current 4', note: 'confident: 0.01 A' },
  { addr: 566, metric: 'PV power 4', note: 'confident: W' },
];

/** Energy counters, input 1000–1027 (0.1 kWh). */
export const ENERGY_SPAN: [number, number] = [1000, 28];
export const ENERGY_MAP: RegDef[] = [
  { addr: 1002, scale: 0.1, metric: 'Export energy today', note: 'confident: fed into grid today 0.1 kWh' },
  { addr: 1003, scale: 0.1, metric: 'Import energy today', note: 'confident: received from grid today 0.1 kWh' },
  { addr: 1004, scale: 0.1, metric: 'Load energy today', note: 'confident: to load today 0.1 kWh' },
  { addr: 1006, type: 'u32', scale: 0.1, metric: 'PV energy today', note: 'confident: PV today 0.1 kWh' },
  { addr: 1018, type: 'u32', scale: 0.1, metric: 'Export energy total', note: 'confident: 0.1 kWh' },
  { addr: 1020, type: 'u32', scale: 0.1, metric: 'Import energy total', note: 'confident: 0.1 kWh' },
  { addr: 1022, type: 'u32', scale: 0.1, metric: 'Load energy total', note: 'confident: 0.1 kWh' },
  { addr: 1026, type: 'u32', scale: 0.1, metric: 'PV energy total', note: 'UNVERIFIED: PV total 0.1 kWh (community map; vendor sheet gap)' },
];

/** Battery state codes at input 2000 (community map). */
export const BATTERY_STATE: Record<number, string> = { 4: 'Charging', 5: 'Discharging', 6: 'Idle' };

/** Battery block, input 2000–2014. Not in the on-grid vendor sheet: all UNVERIFIED. */
export const BATTERY_SPAN: [number, number] = [2000, 15];
export const BATTERY_MAP: RegDef[] = [
  { addr: 2000, metric: 'Battery state', enum: BATTERY_STATE, note: 'UNVERIFIED: 4 charging / 5 discharging / 6 idle' },
  { addr: 2001, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'UNVERIFIED: 0.1 °C' },
  { addr: 2002, metric: 'Battery state of charge', note: 'UNVERIFIED: SOC %' },
  { addr: 2003, metric: 'Battery state of health', note: 'UNVERIFIED: SOH %' },
  { addr: 2004, scale: 0.1, metric: 'Battery voltage', note: 'UNVERIFIED: 0.1 V' },
  { addr: 2005, type: 's16', scale: 0.01, metric: 'Battery current', note: 'UNVERIFIED: 0.01 A, sign fixed from the battery state' },
  { addr: 2008, type: 's16', metric: 'Battery power', note: 'UNVERIFIED: W, sign fixed from the battery state' },
  { addr: 2009, scale: 0.1, metric: 'Charge energy today', note: 'UNVERIFIED: 0.1 kWh' },
  { addr: 2010, scale: 0.1, metric: 'Discharge energy today', note: 'UNVERIFIED: 0.1 kWh' },
  { addr: 2011, type: 'u32', scale: 0.1, metric: 'Charge energy total', note: 'UNVERIFIED: 0.1 kWh' },
  { addr: 2013, type: 'u32', scale: 0.1, metric: 'Discharge energy total', note: 'UNVERIFIED: 0.1 kWh' },
];

/** Run state at input 2500 (confident, vendor doc), mapped to Sunroost's wording. */
export const RUN_STATE: Record<number, string> = {
  0: 'Initializing', 1: 'Standby', 2: 'Starting', 3: 'Grid', 4: 'Off-grid', 5: 'Generator',
  6: 'Switching to off-grid', 7: 'Switching to grid', 8: 'Shutting down', 9: 'Off', 10: 'Fault',
  11: 'Updating', 12: 'Aging', 13: 'Open loop', 14: 'Calibration',
};

/** System block, input 2500–2515. */
export const SYSTEM_SPAN: [number, number] = [2500, 16];
export const SYSTEM_MAP: RegDef[] = [
  { addr: 2500, metric: 'Device mode', enum: RUN_STATE, note: 'confident: run state' },
  { addr: 2514, type: 's16', scale: 0.1, metric: 'Temperature', note: 'confident: inverter inner temperature 0.1 °C' },
  { addr: 2515, type: 's16', scale: 0.1, metric: 'Temperature transformer', note: 'confident: transformer (DC side) temperature 0.1 °C' },
];

/** Fault and warning words, input 3000–3027, each U32 (confident addresses; bit meanings not mapped). */
export const FAULT_SPAN: [number, number] = [3000, 28];
export const FAULT_WORDS: { addr: number; name: string }[] = [
  { addr: 3000, name: 'PV error 1' },
  { addr: 3002, name: 'PV error 2' },
  { addr: 3008, name: 'Grid error' },
  { addr: 3010, name: 'Off-grid error' },
  { addr: 3012, name: 'DC error 1' },
  { addr: 3014, name: 'DC error 2' },
  { addr: 3016, name: 'AC error' },
  { addr: 3018, name: 'System error 1' },
  { addr: 3020, name: 'System error 2' },
  { addr: 3022, name: 'Permanent error' },
  { addr: 3024, name: 'Internal warning' },
  { addr: 3026, name: 'External warning' },
];
