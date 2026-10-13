/**
 * INVT XD-TL hybrid (XD3.6–10KTL). The catalogue groups INVT with Megarevo, but the XD speaks INVT's
 * own register map, so it is a separate family here. Modbus RTU 9600 8N1, address 1; function 3 for
 * every read (the protocol defines only 0x03 read and 0x10 write).
 *
 * Source: "INVT SOLAR RS485 Communication Protocol V1.38" (July 2024), cross-checked against the
 * community ha-solarman "invt_xd-tl" definition (tested by its author on an XD6KTL). 32-bit values
 * are HIGH word first. "confident" = both sources agree; UNVERIFIED = one source or a guess. Nothing
 * has been checked on hardware by this project.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { has, num } from '../growatt/registers.ts';
import { type AsciiField, type MegarevoFamily, type RegDef } from './family.ts';
import { INVT_SETTINGS } from './settings.ts';

/** 0x3806 inverter working status (vendor doc). */
export const INVT_STATE: Record<number, string> = {
  0: 'Initializing', 1: 'Waiting', 2: 'Grid', 3: 'Fault', 4: 'Firmware update', 5: 'Off-grid', 6: 'Bypass',
  7: 'PID repair', 8: 'PID inhibition', 9: 'Snow removal', 10: 'SVG mode',
};

export const INVT_LIVE: RegDef[] = [
  { addr: 0x3806, metric: 'Run state', enum: INVT_STATE, note: 'confident: working status' },
  { addr: 0x3807, metric: 'Main alarm code', note: 'UNVERIFIED: main/sub alarm, shown "mm-ss"' },
  { addr: 0x3808, metric: 'Sub alarm code', note: 'UNVERIFIED' },
  { addr: 0x3809, metric: 'Main fault code', note: 'confident address: main/sub fault, shown "mm-ss"' },
  { addr: 0x380a, metric: 'Sub fault code', note: 'confident address' },
  { addr: 0x3811, scale: 0.1, metric: 'Grid voltage', note: 'confident: RS grid line voltage 0.1 V (the grid voltage on single-phase XD)' },
  { addr: 0x3817, type: 's16', scale: 0.01, metric: 'Grid current', note: 'UNVERIFIED: R phase current 0.01 A, sign unknown' },
  { addr: 0x381a, scale: 0.01, metric: 'Grid frequency', note: 'confident: 0.01 Hz' },
  { addr: 0x381d, type: 's32', scale: 0.1, metric: 'Inverter power', note: 'confident: AC active power 0.1 W, high word first' },
  { addr: 0x3826, type: 's16', scale: 0.1, metric: 'Radiator temperature', note: 'confident: 0.1 °C' },
  { addr: 0x3827, type: 's32', scale: 0.1, metric: 'Meter power', note: 'confident address, 0.1 W high word first; sign UNVERIFIED (+ = import inferred)' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 0x3836 + (n - 1) * 2, scale: 0.1, metric: `PV voltage ${n}`, note: 'confident: 0.1 V' },
    { addr: 0x3837 + (n - 1) * 2, type: 's16', scale: 0.01, metric: `PV current ${n}`, note: 'confident: 0.01 A' },
  ]),
  { addr: 0x3908, type: 's32', scale: 0.1, metric: 'Battery power', note: 'confident: 0.1 W, vendor: + = charging' },
  { addr: 0x390a, scale: 0.1, metric: 'Battery voltage', note: 'confident: 0.1 V' },
  { addr: 0x390b, type: 's16', scale: 0.1, metric: 'Battery current raw', note: 'UNVERIFIED: 0.1 A, sign undocumented — taken from the power' },
  { addr: 0x3926, scale: 0.01, metric: 'EPS frequency', note: 'UNVERIFIED: 0.01 Hz' },
  { addr: 0x3927, scale: 0.1, metric: 'EPS voltage', note: 'UNVERIFIED: EPS R phase voltage 0.1 V' },
  { addr: 0x3933, type: 's32', scale: 0.1, metric: 'EPS power', note: 'UNVERIFIED: EPS total power 0.1 W' },
  { addr: 0x393b, metric: 'Battery state of charge', note: 'confident: %' },
  { addr: 0x393c, metric: 'Battery state of health', note: 'confident: %' },
  { addr: 0x394d, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'confident: 0.1 °C' },
  ...[1, 2, 3, 4].map((n): RegDef => ({ addr: 0x3b00 + n, scale: 0.1, metric: `PV power ${n}`, note: 'confident: 0.1 W' })),
];

/**
 * Info: 0x3000 rated power (0.1 kW), 0x3001 serial (16 registers), 0x3068 model recognition
 * (1 hybrid), 0x306D model (16 registers) — one 125-register request. 0x3802/0x3805 firmware.
 */
export const INVT_INFO: RegDef[] = [
  { addr: 0x3000, scale: 0.1, metric: 'Rated power', note: 'UNVERIFIED: rated power 0.1 kW' },
  { addr: 0x3068, metric: 'Model recognition', note: 'UNVERIFIED: 1 hybrid / 2 grid-tied / 3 off-grid' },
  { addr: 0x3802, metric: 'DSP version', note: 'UNVERIFIED: main DSP version, 1–9999 (hundreds = release, units = test)' },
  { addr: 0x3805, metric: 'ARM version', note: 'UNVERIFIED: ARM version, 1–9999' },
];
/** ASCII fields; character packing (1 or 2 per register) is ambiguous in the doc, see flexAscii. */
export const INVT_ASCII: AsciiField[] = [
  { metric: 'Serial', addr: 0x3001, words: 16, note: 'UNVERIFIED: inverter serial, 16 registers ASCII' },
  { metric: 'Model', addr: 0x306d, words: 16, note: 'UNVERIFIED: device model, 16 registers ASCII' },
];

/** INVT version word: 1023 → "10.23". */
export function invtVersion(v: number): string {
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
}

function decodeInvtInfo(raw: Metrics): Metrics {
  const out: Metrics = { 'Model name': 'INVT XD hybrid' };
  if (typeof raw.Serial === 'string' && raw.Serial) out['Serial number'] = raw.Serial;
  if (typeof raw.Model === 'string' && /[A-Za-z0-9]{3}/.test(raw.Model)) out['Model name'] = `INVT ${raw.Model}`;
  const rated = num(raw, 'Rated power');
  if (rated > 0 && rated < 200) out['Max AC output power'] = Math.round(rated * 1000);
  const valid = (k: string) => num(raw, k) > 0 && num(raw, k) <= 9999;
  if (valid('DSP version')) out['Firmware version'] = invtVersion(num(raw, 'DSP version'));
  if (valid('ARM version')) out['Secondary firmware version'] = invtVersion(num(raw, 'ARM version'));
  return out;
}

export function deriveInvt(raw: Metrics): Metrics {
  const out: Metrics = {};
  out['Device mode'] = String(raw['Run state'] ?? 'Unknown');
  if (has(raw, 'Main fault code')) {
    const main = num(raw, 'Main fault code');
    out['Fault code'] = main ? `${String(main).padStart(2, '0')}-${String(num(raw, 'Sub fault code')).padStart(2, '0')}` : 'None';
  }
  if (has(raw, 'Main alarm code')) {
    const main = num(raw, 'Main alarm code');
    out['Warning code'] = main ? `${String(main).padStart(2, '0')}-${String(num(raw, 'Sub alarm code')).padStart(2, '0')}` : 'None';
  }
  for (const k of ['Grid voltage', 'Grid frequency', 'Battery voltage', 'Battery state of charge', 'Battery state of health', 'Battery temperature']) {
    if (has(raw, k)) out[k] = raw[k];
  }
  if (has(raw, 'Radiator temperature')) out.Temperature = raw['Radiator temperature'];
  let pv = 0;
  for (const n of [1, 2, 3, 4]) {
    if (!has(raw, `PV power ${n}`)) continue;
    const p = round(num(raw, `PV power ${n}`), 0);
    if (n > 2 && !(p > 0 || num(raw, `PV voltage ${n}`) > 0)) continue;
    out[`PV power ${n}`] = p;
    out[`PV voltage ${n}`] = num(raw, `PV voltage ${n}`);
    out[`PV current ${n}`] = num(raw, `PV current ${n}`);
    pv += p;
  }
  out['PV power'] = pv;
  const battery = round(num(raw, 'Battery power'), 0);
  out['Battery power'] = battery || 0;
  if (has(raw, 'Battery current raw')) {
    const i = Math.abs(num(raw, 'Battery current raw'));
    out['Battery current'] = battery < 0 ? -i : i;
  }
  const grid = round(num(raw, 'Meter power'), 0);
  const inverter = round(num(raw, 'Inverter power'), 0);
  out['Grid power'] = grid || 0;
  // House load = inverter AC output + grid import (as the community map derives it). UNVERIFIED.
  out['Load power'] = Math.max(0, inverter + grid);
  if (has(raw, 'EPS power')) out['Load power essential'] = round(num(raw, 'EPS power'), 0);
  const eps = num(raw, 'EPS voltage');
  out['AC output voltage'] = eps > 0 ? eps : num(raw, 'Grid voltage');
  const f = num(raw, 'EPS frequency');
  out['AC output frequency'] = f > 0 ? f : num(raw, 'Grid frequency');
  return out;
}

export const invtXd: MegarevoFamily = {
  id: 'invt_xd',
  name: 'INVT XD-TL hybrid',
  liveMap: INVT_LIVE,
  derive: deriveInvt,
  infoMap: INVT_INFO,
  asciiInfo: INVT_ASCII,
  decodeInfo: decodeInvtInfo,
  settings: INVT_SETTINGS,
};
