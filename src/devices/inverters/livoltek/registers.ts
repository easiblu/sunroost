/**
 * Livoltek register tables and a small table decoder.
 *
 * Sources (no official public Modbus document was found; see the driver report):
 *  - A community register list for the Hyper-6000 ("Livoltek Hyper-6000 modbus", shared on the Home
 *    Assistant forum thread "Livoltek inverter integration?"): unit id 17, 9600 8N1, holding
 *    registers with 0-based addresses, live block 450.., energy 504.., info 570...
 *  - Livoltek's own cloud point table (a JSON export of the portal's parameter page, linked from
 *    the same thread). It names holding settings as 4xxxx (40001 = holding 0) and the live/BMS block
 *    as 3xxxx where 30001 = holding 450 (e.g. 30082 "BMS_ChargeCutOffVolt" = 531, 30119 "BMS_SOH" =
 *    568, both matching the community list). It gives scale factors the community list leaves out.
 *
 * Confidence per row: "confident" = address agrees in both sources and the scale is given by one of
 * them; "UNVERIFIED" = address from one source and/or the scale or sign is a best guess. Everything
 * still has to be checked on a real unit (docs/HARDWARE_TEST.md). The HP3 series is assumed to use
 * the same map (the cloud point table includes generator / parallel / split-phase settings that the
 * Hyper lacks, which suggests one protocol for both) — UNVERIFIED for HP3 as a whole.
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** Registers for ascii. */
  words?: number;
  scale?: number;
  metric: string;
  note: string;
}

/** Sparse register image: address → raw 16-bit word. */
export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

/** Live block 450–497 (inverter, PV, battery, load, EPS, temperature). */
export const LIVE_SPAN: [number, number] = [450, 48];
/** Energy, BMS and grid block 500–569. */
export const ENERGY_SPAN: [number, number] = [500, 70];
/** Product model, serial and hardware version 570–593. */
export const INFO_SPAN: [number, number] = [570, 24];
/** Firmware words 600–639 (MDSP 604, SDSP 620, ARM 636). */
export const FIRMWARE_SPAN: [number, number] = [600, 40];

export const LIVE_MAP: RegDef[] = [
  { addr: 450, scale: 0.1, metric: 'AC output voltage', note: 'confident: inverter AC voltage 0.1 V' },
  { addr: 451, scale: 0.1, metric: 'AC output current', note: 'confident: inverter AC current 0.1 A' },
  { addr: 452, type: 's16', metric: 'Inverter power', note: 'confident address, UNVERIFIED sign: inverter AC power W' },
  { addr: 453, scale: 0.01, metric: 'AC output frequency', note: 'confident: 0.01 Hz' },
  { addr: 455, scale: 0.1, metric: 'PV voltage 1', note: 'UNVERIFIED scale 0.1 V (address confirmed by community list)' },
  { addr: 456, scale: 0.1, metric: 'PV voltage 2', note: 'UNVERIFIED scale 0.1 V' },
  { addr: 457, scale: 0.1, metric: 'PV current 1', note: 'UNVERIFIED scale 0.1 A' },
  { addr: 458, scale: 0.1, metric: 'PV current 2', note: 'UNVERIFIED scale 0.1 A' },
  { addr: 463, metric: 'PV power 1', note: 'UNVERIFIED scale 1 W' },
  { addr: 464, metric: 'PV power 2', note: 'UNVERIFIED scale 1 W' },
  { addr: 466, type: 'u32', metric: 'PV power', note: 'UNVERIFIED: i32 total PV W, high word first assumed' },
  { addr: 468, metric: 'Battery state of charge', note: 'confident: %' },
  { addr: 469, scale: 0.1, metric: 'Battery voltage', note: 'UNVERIFIED scale 0.1 V' },
  { addr: 470, type: 's16', scale: 0.1, metric: 'Battery current', note: 'UNVERIFIED scale 0.1 A and sign (+ = charging assumed)' },
  { addr: 471, type: 's16', metric: 'Battery power', note: 'UNVERIFIED sign (+ = charging assumed), W' },
  { addr: 474, scale: 0.1, metric: 'Load voltage', note: 'UNVERIFIED scale 0.1 V' },
  { addr: 475, scale: 0.1, metric: 'Load current', note: 'UNVERIFIED scale 0.1 A' },
  { addr: 476, type: 's16', metric: 'Load power', note: 'confident address, UNVERIFIED scale 1 W' },
  { addr: 477, type: 's16', metric: 'EPS power', note: 'UNVERIFIED scale 1 W' },
  { addr: 478, scale: 0.1, metric: 'EPS voltage', note: 'UNVERIFIED scale 0.1 V' },
  { addr: 479, scale: 0.1, metric: 'EPS current', note: 'UNVERIFIED scale 0.1 A' },
  { addr: 481, scale: 0.01, metric: 'EPS frequency', note: 'confident: 0.01 Hz' },
  { addr: 495, type: 's16', metric: 'Temperature', note: 'confident: inverter temperature °C' },
];

export const ENERGY_MAP: RegDef[] = [
  { addr: 501, scale: 0.01, metric: 'Modbus protocol version', note: 'UNVERIFIED: cloud 30052 "modbus version" 0.01' },
  { addr: 504, type: 'u32', scale: 0.1, metric: 'Charge energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 506, type: 'u32', scale: 0.1, metric: 'Export energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 508, type: 'u32', scale: 0.1, metric: 'EPS energy total', note: 'UNVERIFIED scale 0.1 kWh' },
  { addr: 510, type: 'u32', scale: 0.1, metric: 'Import energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 512, type: 'u32', scale: 0.1, metric: 'Discharge energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 514, type: 'u32', scale: 0.1, metric: 'PV energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 516, type: 'u32', scale: 0.1, metric: 'Load energy total', note: 'confident address, UNVERIFIED word order: kWh' },
  { addr: 524, scale: 0.1, metric: 'Export energy today', note: 'confident: 0.1 kWh' },
  { addr: 525, scale: 0.1, metric: 'Discharge energy today', note: 'confident: 0.1 kWh' },
  { addr: 526, scale: 0.1, metric: 'PV energy today', note: 'confident: 0.1 kWh' },
  { addr: 527, scale: 0.1, metric: 'Load energy today', note: 'confident: 0.1 kWh' },
  { addr: 530, metric: 'BMS state of charge', note: 'UNVERIFIED: BMS-reported SOC %' },
  { addr: 531, scale: 0.1, metric: 'BMS charge voltage', note: 'confident: cloud 30082 0.1 V' },
  { addr: 532, scale: 0.1, metric: 'BMS discharge voltage', note: 'confident: cloud 30083 0.1 V' },
  { addr: 533, scale: 0.1, metric: 'Battery charge current limit', note: 'confident: cloud 30084 0.1 A' },
  { addr: 534, scale: 0.1, metric: 'Battery discharge current limit', note: 'confident: cloud 30085 0.1 A' },
  { addr: 535, type: 's16', metric: 'Battery temperature', note: 'UNVERIFIED: BMS max cell temperature °C, scale 1' },
  { addr: 536, type: 's16', metric: 'Battery temperature min', note: 'UNVERIFIED: BMS min cell temperature °C, scale 1' },
  { addr: 543, scale: 0.1, metric: 'Grid voltage', note: 'UNVERIFIED scale 0.1 V' },
  { addr: 544, type: 's16', scale: 0.1, metric: 'Grid current', note: 'UNVERIFIED sign; 0.1 A from community list' },
  { addr: 545, type: 's16', scale: 0.1, metric: 'Grid power', note: 'UNVERIFIED: community list says scale 0.1; sign (+ = import) assumed' },
  { addr: 549, scale: 0.01, metric: 'Grid frequency', note: 'confident: 0.01 Hz' },
  { addr: 568, metric: 'Battery state of health', note: 'confident: cloud 30119 BMS_SOH %' },
];

export const INFO_MAP: RegDef[] = [
  { addr: 570, type: 'ascii', words: 5, metric: 'Model name', note: 'UNVERIFIED: 570–574 product model ASCII (exact text unknown)' },
  { addr: 578, type: 'ascii', words: 8, metric: 'Serial number', note: 'confident: 578–585 device SN ASCII' },
  { addr: 586, type: 'ascii', words: 8, metric: 'Hardware version', note: 'UNVERIFIED: 586–593 ASCII' },
];

export const FIRMWARE_MAP: RegDef[] = [
  { addr: 604, metric: 'MDSP version', note: 'UNVERIFIED: raw word (format unknown)' },
  { addr: 620, metric: 'SDSP version', note: 'UNVERIFIED: raw word (format unknown)' },
  { addr: 636, metric: 'ARM version', note: 'UNVERIFIED: cloud 30187 shows e.g. 113' },
];

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const type = def.type ?? 'u16';
  const n = type === 'ascii' ? (def.words ?? 1) : type === 'u32' || type === 's32' ? 2 : 1;
  const words: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  if (type === 'ascii') return decodeAscii(words);
  let raw: number;
  if (type === 'u32' || type === 's32') {
    raw = words[0] * 0x10000 + words[1];
    if (type === 's32' && raw >= 0x80000000) raw -= 0x100000000;
  } else {
    raw = type === 's16' && words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
  }
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
