/**
 * Sigenergy Modbus register tables and a small table decoder.
 *
 * Source: Sigenergy's public "Sigenergy Modbus Protocol" (V1.x / V2.x) as summarised from vendor
 * documents and open-source register lists (facts only). Two address spaces on one Modbus TCP
 * endpoint (port 502 on the SigenStor / gateway):
 *   - plant (system) data on unit id 247, input registers (function 4) from 30000;
 *   - per-inverter data on unit id 1 (2, 3 … for further inverters), input registers from 30500.
 * Settings are holding registers from 40000 on unit 247 (decoded only; the driver never writes).
 *
 * Power registers are documented in kW with gain 1000, so the raw 32-bit value is watts.
 * 32-bit values are high word first.
 *
 * Confidence notes per row: "confident" = address, type and gain agree across the documents and
 * open-source lists; "medium" = agreed address, sign or enum wording less certain; "UNVERIFIED" =
 * best knowledge that still has to be checked on a real unit (docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export const PLANT_UNIT = 247;
export const INVERTER_UNIT = 1;

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  addr: number;
  type?: RegType;
  /** ascii: register count. */
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

function wordCount(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < wordCount(def); i++) {
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
// Plant (unit 247, input registers).

export const EMS_WORK_MODE: Record<number, string> = {
  0: 'Max self consumption', 1: 'AI mode', 2: 'Time of use', 5: 'Fully fed to grid', 7: 'Remote EMS',
};
export const RUNNING_STATE: Record<number, string> = {
  0: 'Standby', 1: 'Running', 2: 'Fault', 3: 'Shutdown', 7: 'Environment abnormal',
};
export const GRID_STATUS: Record<number, string> = {
  0: 'On-grid', 1: 'Off-grid (auto)', 2: 'Off-grid (manual)',
};

/** Plant span: 30000–30057. */
export const PLANT_SPAN: [number, number] = [30000, 58];
export const PLANT_MAP: RegDef[] = [
  { addr: 30003, metric: 'EMS work mode', enum: EMS_WORK_MODE, note: 'medium: 0 max self consumption / 1 AI / 2 TOU / 5 full feed-in / 7 remote EMS' },
  { addr: 30004, metric: 'Grid sensor status', enum: { 0: 'Not connected', 1: 'Connected' }, note: 'medium' },
  { addr: 30005, type: 's32', metric: 'Grid power', note: 'grid sensor active power W, + = import (address confident; sign medium)' },
  { addr: 30009, metric: 'Grid status', enum: GRID_STATUS, note: 'on/off-grid status (medium)' },
  { addr: 30014, scale: 0.1, metric: 'Battery state of charge', note: 'ESS SOC 0.1 % (confident)' },
  { addr: 30027, metric: 'Alarm word 1', note: 'general alarm 1 (medium)' },
  { addr: 30028, metric: 'Alarm word 2', note: 'general alarm 2 (medium)' },
  { addr: 30029, metric: 'Alarm word 3', note: 'general alarm 3 (medium)' },
  { addr: 30030, metric: 'Alarm word 4', note: 'general alarm 4 (medium)' },
  { addr: 30031, type: 's32', metric: 'Plant active power', note: 'plant AC active power W, + = output (confident)' },
  { addr: 30035, type: 's32', metric: 'PV power', note: 'plant PV power W (confident)' },
  { addr: 30037, type: 's32', metric: 'Battery power', note: 'ESS power W, + = charging (address confident; sign medium)' },
  { addr: 30051, metric: 'Plant running state', enum: RUNNING_STATE, note: 'plant running state (medium)' },
];
/** Grid sensor per-phase active power (protocol V2.x only). */
export const PLANT_PHASE_MAP: RegDef[] = [1, 2, 3].map((p) => ({
  addr: 30052 + (p - 1) * 2, type: 's32' as const, metric: `Grid power ${p}`,
  note: 'UNVERIFIED: grid sensor phase active power W, + = import (V2.x firmware only)',
}));

// ---------------------------------------------------------------------------------------------
// Inverter (unit 1, input registers).

/** Info span: 30500–30549 (model, serial, firmware, ratings). */
export const INFO_SPAN: [number, number] = [30500, 50];
export const INFO_MAP: RegDef[] = [
  { addr: 30500, type: 'ascii', words: 15, metric: 'Model name', note: 'model type ASCII, e.g. "SigenStor EC 10.0 TP" (confident)' },
  { addr: 30515, type: 'ascii', words: 10, metric: 'Serial number', note: 'serial ASCII (confident)' },
  { addr: 30525, type: 'ascii', words: 15, metric: 'Firmware version', note: 'machine firmware ASCII (confident)' },
  { addr: 30540, type: 'u32', metric: 'Max AC output power', note: 'UNVERIFIED: rated active power W' },
  { addr: 30548, type: 'u32', scale: 0.01, metric: 'Battery capacity', note: 'UNVERIFIED: rated battery capacity 0.01 kWh' },
];

/** Inverter/battery span: 30578–30623. */
export const INVERTER_SPAN: [number, number] = [30578, 46];
export const INVERTER_MAP: RegDef[] = [
  { addr: 30578, metric: 'Inverter state', enum: RUNNING_STATE, note: 'inverter running state (medium)' },
  { addr: 30587, type: 's32', metric: 'Inverter power', note: 'inverter AC active power W (confident)' },
  { addr: 30599, type: 's32', metric: 'Inverter battery power', note: 'ESS charge/discharge power W, + = charging (medium)' },
  { addr: 30601, scale: 0.1, metric: 'Inverter battery SOC', note: 'ESS SOC 0.1 % (confident)' },
  { addr: 30602, scale: 0.1, metric: 'Battery state of health', note: 'ESS SOH 0.1 % (medium)' },
  { addr: 30603, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'average cell temperature 0.1 °C (medium)' },
  { addr: 30604, scale: 0.001, metric: 'Battery cell voltage average', note: 'UNVERIFIED: average cell voltage 0.001 V' },
  { addr: 30620, type: 's16', scale: 0.1, metric: 'Battery temperature max', note: 'UNVERIFIED: max cell temperature 0.1 °C' },
  { addr: 30621, type: 's16', scale: 0.1, metric: 'Battery temperature min', note: 'UNVERIFIED: min cell temperature 0.1 °C' },
  { addr: 30622, scale: 0.001, metric: 'Battery cell voltage max', note: 'UNVERIFIED: max cell voltage 0.001 V' },
  { addr: 30623, scale: 0.001, metric: 'Battery cell voltage min', note: 'UNVERIFIED: min cell voltage 0.001 V' },
];

/** Grid/PV span: 31000–31037. */
export const AC_SPAN: [number, number] = [31000, 38];
export const AC_MAP: RegDef[] = [
  { addr: 31002, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (confident)' },
  { addr: 31003, type: 's16', scale: 0.1, metric: 'Temperature', note: 'PCS internal temperature 0.1 °C (medium)' },
  { addr: 31004, metric: 'Output type', enum: { 0: 'L/N', 1: 'L1/L2/L3', 2: 'L1/L2/L3/N', 3: 'L1/L2/N' }, note: 'medium' },
  ...[1, 2, 3].flatMap((p): RegDef[] => [
    { addr: 31011 + (p - 1) * 2, type: 'u32', scale: 0.01, metric: `Grid voltage ${p}`, note: 'phase voltage 0.01 V (medium)' },
    { addr: 31017 + (p - 1) * 2, type: 's32', scale: 0.01, metric: `AC output current ${p}`, note: 'phase current 0.01 A (medium)' },
  ]),
  { addr: 31023, type: 's16', scale: 0.001, metric: 'Power factor', note: 'UNVERIFIED: 0.001' },
  { addr: 31025, metric: 'PV string count', note: 'medium' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 31027 + (n - 1) * 2, type: 's16', scale: 0.1, metric: `PV voltage ${n}`, note: 'PVn voltage 0.1 V (medium)' },
    { addr: 31028 + (n - 1) * 2, type: 's16', scale: 0.01, metric: `PV current ${n}`, note: 'PVn current 0.01 A (medium)' },
  ]),
  { addr: 31035, type: 's32', metric: 'Inverter PV power', note: 'inverter DC PV power W (medium)' },
];
