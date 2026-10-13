/**
 * Senergy (Senergytec) hybrid inverter Modbus register tables and a small table decoder. Duracell
 * Dura-i and Salvare 10 PRO units are Senergy OEM builds and speak the same map.
 *
 * Every register is a holding register (function 3). Addresses are the hex addresses the Senergy
 * protocol uses: 0x1000.. inverter / PV block, 0x1300.. external meter (CT) block, 0x1A00.. product
 * info, 0x2000.. battery block, 0x2100.. hybrid settings. 32-bit values are big-endian, high word
 * first.
 *
 * Sources (facts only, nothing copied): the evcc `senergy-hybrid` and `senergy` meter templates
 * (also used for Strong Energy Alfred 10 and SolarMax SP), a community Home Assistant setup that
 * verified 0x1021 / 0x1048 / 0x1300 / 0x2000 against the vendor app on an Alfred 10, a community
 * Duracell Dura-i Home Assistant integration (single-register reads of the same blocks), and a
 * community Polycab (Senergy OEM) register write-up. Senergy's own "hybrid inverter Modbus protocol"
 * PDF is not publicly downloadable, so nothing here has been checked against it.
 *
 * Confidence notes per row: "confident" = two or more independent sources agree on address, type
 * and scale; "medium" = one source that was tested on hardware; "UNVERIFIED" = best knowledge, still
 * to be checked on a real unit (docs/HARDWARE_TEST.md).
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii' | 'version';

export interface RegDef {
  addr: number;
  /** u16 (default), s16, u32 / s32 (two registers, high word first), ascii (`words` registers) or version (hi.lo). */
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

function width(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

/** Every register address a table touches (for per-register fallback reads). */
export function addresses(defs: RegDef[]): number[] {
  const out = new Set<number>();
  for (const d of defs) for (let i = 0; i < width(d); i++) out.add(d.addr + i);
  return [...out].sort((a, b) => a - b);
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
  for (let i = 0; i < width(def); i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  const type = def.type ?? 'u16';
  if (type === 'ascii') return decodeAscii(words);
  if (type === 'version') return `${words[0] >> 8}.${String(words[0] & 0xff).padStart(2, '0')}`;
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
// Product information, read once on connect (0x1A00–0x1A47).

export const INFO_SPAN: [number, number] = [0x1a00, 0x48];
export const MODEL_REG = 0x1a00;
export const SERIAL_REG = 0x1a10;

export const INFO_MAP: RegDef[] = [
  { addr: 0x1a00, type: 'ascii', words: 8, metric: 'Model name', note: 'medium: product model, 16 ASCII chars (Polycab write-up, tested)' },
  { addr: 0x1a10, type: 'ascii', words: 8, metric: 'Serial number', note: 'medium: product SN, 16 ASCII chars (Polycab write-up, tested)' },
  { addr: 0x1a18, type: 'version', metric: 'Protocol version', note: 'UNVERIFIED: Modbus map revision, hi.lo bytes (0x0115 = 1.21)' },
  { addr: 0x1a19, type: 'ascii', words: 4, metric: 'Firmware version', note: 'UNVERIFIED: control MCU firmware, 8 ASCII chars' },
  { addr: 0x1a46, metric: 'Max AC output power', note: 'UNVERIFIED: rated power W' },
];

// ---------------------------------------------------------------------------------------------
// Inverter / PV block (0x1000–0x1049).

/** Running state at 0x101D. Only the codes the source documents; hybrids may add more. */
export const RUN_STATE: Record<number, string> = {
  0: 'Initializing',
  1: 'Standby',
  2: 'Grid-tied',
  3: 'Fault',
  4: 'Shutdown',
};

export const INVERTER_SPAN: [number, number] = [0x1000, 0x4a];

export const INVERTER_MAP: RegDef[] = [
  { addr: 0x1001, scale: 0.1, metric: 'Grid voltage 1', note: 'confident: phase A (L1) AC voltage 0.1 V (Polycab + Dura-i)' },
  { addr: 0x1002, scale: 0.01, metric: 'Grid current 1', note: 'medium: phase A inverter AC current 0.01 A' },
  { addr: 0x1003, type: 's32', scale: 0.1, metric: 'Inverter power 1', note: 'medium: phase A inverter active power 0.1 W' },
  { addr: 0x1005, scale: 0.01, metric: 'Grid frequency', note: 'confident: 0.01 Hz (Polycab + Dura-i)' },
  { addr: 0x1010, scale: 0.1, metric: 'PV voltage 1', note: 'confident: PV1 voltage 0.1 V (Polycab + Dura-i)' },
  { addr: 0x1011, scale: 0.01, metric: 'PV current 1', note: 'confident: PV1 current 0.01 A (Polycab + Dura-i)' },
  { addr: 0x1012, type: 'u32', scale: 0.1, metric: 'PV power 1', note: 'confident: MPPT1 power 0.1 W (Polycab u32; Dura-i reads the low word)' },
  { addr: 0x1014, scale: 0.1, metric: 'PV voltage 2', note: 'medium: PV2 voltage 0.1 V' },
  { addr: 0x1015, scale: 0.01, metric: 'PV current 2', note: 'UNVERIFIED: PV2 current 0.01 A' },
  { addr: 0x1016, type: 'u32', scale: 0.1, metric: 'PV power 2', note: 'UNVERIFIED: MPPT2 power 0.1 W' },
  { addr: 0x101c, type: 's16', metric: 'Temperature', note: 'confident: heat-sink temperature 1 °C (Polycab + Dura-i)' },
  { addr: 0x101d, metric: 'Device mode', enum: RUN_STATE, note: 'medium: running state (codes 0–4 from the Polycab write-up; hybrid codes UNVERIFIED)' },
  { addr: 0x101e, type: 'u32', metric: 'Fault word', note: 'medium: fault / protection bitmask, 0 = none' },
  { addr: 0x1021, type: 'u32', metric: 'PV energy total', note: 'confident: lifetime yield 1 kWh (evcc + verified on Alfred 10)' },
  { addr: 0x1027, type: 'u32', scale: 0.001, metric: 'PV energy today', note: 'medium: today yield in Wh → kWh' },
  { addr: 0x1037, type: 's32', scale: 0.1, metric: 'Inverter power', note: 'confident: total AC active power 0.1 W (evcc senergy PAC + Polycab)' },
  { addr: 0x1048, type: 'u32', scale: 0.1, metric: 'PV power', note: 'confident: total PV input power 0.1 W (evcc + verified on Alfred 10)' },
];

/** Third MPPT on three-phase units. */
export const PV3_MAP: RegDef[] = [
  { addr: 0x1018, scale: 0.1, metric: 'PV voltage 3', note: 'UNVERIFIED: PV3 voltage 0.1 V' },
  { addr: 0x1019, scale: 0.01, metric: 'PV current 3', note: 'UNVERIFIED: PV3 current 0.01 A' },
  { addr: 0x101a, type: 'u32', scale: 0.1, metric: 'PV power 3', note: 'UNVERIFIED: MPPT3 power 0.1 W' },
];

/** Phase B (L2) and C (L3) inverter rows: 5 registers per phase from 0x1006 / 0x100B. */
export function phaseMap(p: 2 | 3): RegDef[] {
  const b = p === 2 ? 0x1006 : 0x100b;
  const note = `UNVERIFIED: phase ${p === 2 ? 'B' : 'C'} block at 0x${b.toString(16).toUpperCase()}`;
  return [
    { addr: b, scale: 0.1, metric: `Grid voltage ${p}`, note },
    { addr: b + 1, scale: 0.01, metric: `Grid current ${p}`, note },
    { addr: b + 2, type: 's32', scale: 0.1, metric: `Inverter power ${p}`, note },
  ];
}

// ---------------------------------------------------------------------------------------------
// External meter / CT block (0x1300–0x1322). Grid power: + import, − export.

export const METER_SPAN: [number, number] = [0x1300, 0x23];

export function meterMap(phases: number): RegDef[] {
  const out: RegDef[] = [
    { addr: 0x1300, type: 's32', scale: 0.1, metric: 'Grid power 1', note: 'confident address/scale (evcc + verified on Alfred 10); sign + import medium' },
    { addr: 0x1306, type: 'u32', scale: 0.01, metric: 'Import energy total', note: 'confident: grid import 0.01 kWh (evcc)' },
    { addr: 0x1308, type: 'u32', scale: 0.01, metric: 'Export energy total', note: 'UNVERIFIED: grid export 0.01 kWh (scale unsure)' },
    { addr: 0x130a, type: 's32', scale: 0.1, metric: 'Load power', note: 'medium: house load 0.1 W (Polycab write-up; Dura-i BLE log reads its low word at 0x130B)' },
    { addr: 0x131d, type: 's32', scale: 0.01, metric: 'Grid CT current 1', note: 'confident: meter phase A current 0.01 A (evcc; Dura-i reads the low word)' },
  ];
  if (phases >= 2) {
    out.push(
      { addr: 0x1302, type: 's32', scale: 0.1, metric: 'Grid power 2', note: 'confident: meter phase B power 0.1 W (evcc)' },
      { addr: 0x131f, type: 's32', scale: 0.01, metric: 'Grid CT current 2', note: 'confident: meter phase B current 0.01 A (evcc)' },
    );
  }
  if (phases >= 3) {
    out.push(
      { addr: 0x1304, type: 's32', scale: 0.1, metric: 'Grid power 3', note: 'confident: meter phase C power 0.1 W (evcc)' },
      { addr: 0x1321, type: 's32', scale: 0.01, metric: 'Grid CT current 3', note: 'confident: meter phase C current 0.01 A (evcc)' },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Battery block (0x2000–0x201B).

export const BATTERY_SPAN: [number, number] = [0x2000, 0x1c];

export const BATTERY_MAP: RegDef[] = [
  { addr: 0x2000, metric: 'Battery state of charge', note: 'confident: SOC % (evcc + Alfred 10 + Dura-i)' },
  { addr: 0x2006, scale: 0.1, metric: 'Battery voltage', note: 'medium: 0.1 V (Dura-i integration)' },
  // 0x2007–0x2008 may be one int32; reading 0x2008 alone as s16 gives the same value below ±327 A.
  { addr: 0x2008, type: 's16', scale: 0.01, metric: 'Battery current raw', note: 'medium: 0.01 A, + discharging (Dura-i integration; sign UNVERIFIED)' },
  { addr: 0x2009, type: 's32', scale: 0.1, metric: 'Battery power raw', note: 'confident address/scale (evcc + Alfred 10); + discharging per evcc (medium)' },
  { addr: 0x2011, type: 'u32', scale: 0.01, metric: 'Discharge energy total', note: 'medium: 0.01 kWh (evcc)' },
  { addr: 0x201b, type: 's16', metric: 'Battery temperature', note: 'medium: 1 °C (Dura-i integration)' },
];
