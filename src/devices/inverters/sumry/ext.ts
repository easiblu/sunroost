/**
 * "smg_ext" — the newer, extended SMG Modbus map (protocol number 3–6 in holding 184) used by
 * larger/parallel-capable units: Easun ISolar SMG II 11 kW, Anenji ANJ-HHS 11 kW, and very likely
 * the GES split-phase hybrids (Tingen, POWLAND, LiveFun, Busbyr). Per-phase blocks repeat every 38
 * registers (L1 338–, L2 376–, L3 414–); settings move to 600–709.
 *
 * Source (facts only): the register list published with the open "easun-smg-ii-11kw" project
 * (alcestide), itself transcribed from the vendor protocol PDF. One source only, so every register
 * here is UNVERIFIED unless it matches the classic map too.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { has, num, type RegDef } from '../growatt/registers.ts';
import { SERIAL, setting, type SumryFamily, type SumrySetting } from './family.ts';
import { SMG_MODES } from './smg.ts';

const STRIDE = 38;

function phase(p: number): RegDef[] {
  const b = 338 + (p - 1) * STRIDE;
  const n = `L${p}`;
  return [
    { addr: b, scale: 0.1, metric: `Grid voltage ${p}`, note: `${n} grid voltage 0.1 V (UNVERIFIED)` },
    { addr: b + 1, scale: 0.1, metric: `Grid current ${p}`, note: `${n} grid current 0.1 A (UNVERIFIED)` },
    { addr: b + 2, type: 's16', metric: `Grid power ${p}`, note: `${n} grid active power W (UNVERIFIED)` },
    { addr: b + 4, scale: 0.1, metric: `Inverter voltage ${p}`, note: `${n} inverter voltage 0.1 V (UNVERIFIED)` },
    { addr: b + 6, type: 's16', metric: `Inverter power ${p}`, note: `${n} inverter active power W (UNVERIFIED)` },
    { addr: b + 8, scale: 0.1, metric: `AC output voltage ${p}`, note: `${n} output voltage 0.1 V (UNVERIFIED)` },
    { addr: b + 9, scale: 0.1, metric: `AC output current ${p}`, note: `${n} output current 0.1 A (UNVERIFIED)` },
    { addr: b + 10, metric: `Load power ${p}`, note: `${n} output active power W (UNVERIFIED)` },
    { addr: b + 11, metric: `Load apparent power ${p}`, note: `${n} output apparent power VA (UNVERIFIED)` },
    { addr: b + 13, scale: 0.1, metric: `PV voltage ${p}`, note: `PV${p} voltage 0.1 V (UNVERIFIED)` },
    { addr: b + 14, scale: 0.1, metric: `PV current ${p}`, note: `PV${p} current 0.1 A (UNVERIFIED)` },
    { addr: b + 15, metric: `PV power ${p}`, note: `PV${p} power W (UNVERIFIED)` },
  ];
}

export const EXT_LIVE: RegDef[] = [
  { addr: 100, type: 'u32', metric: 'Fault code', note: 'fault bit field (confident: same as classic map)' },
  { addr: 104, type: 'u32', metric: 'Warning code', note: 'warning bit field (UNVERIFIED)' },
  { addr: 201, metric: 'Device mode', enum: SMG_MODES, note: 'working mode (UNVERIFIED: assumed same codes as classic map)' },
  { addr: 203, scale: 0.01, metric: 'Grid frequency', note: 'total grid frequency 0.01 Hz (UNVERIFIED)' },
  { addr: 204, type: 's16', metric: 'Grid power total', note: 'total grid active power W, + = import (UNVERIFIED sign)' },
  { addr: 206, metric: 'Grid charge power', note: 'grid charging power W (UNVERIFIED)' },
  { addr: 228, type: 's16', metric: 'Inverter power', note: 'total inverter active power W (UNVERIFIED)' },
  { addr: 231, type: 's16', metric: 'Temperature', note: 'inverter module temperature °C (UNVERIFIED)' },
  { addr: 253, scale: 0.01, metric: 'AC output frequency', note: 'output frequency 0.01 Hz (UNVERIFIED)' },
  { addr: 254, metric: 'Load power total', note: 'total output active power W (UNVERIFIED; protocol 4/6 only)' },
  { addr: 255, metric: 'Load apparent power total', note: 'total output apparent power VA (UNVERIFIED; protocol 4/6 only)' },
  { addr: 256, metric: 'Load percentage', note: 'load % (UNVERIFIED; protocol 4/6 only)' },
  { addr: 277, scale: 0.1, metric: 'Battery voltage', note: 'battery voltage 0.1 V (UNVERIFIED)' },
  { addr: 278, type: 's16', scale: 0.1, metric: 'Battery current', note: 'battery current 0.1 A, + = charging (UNVERIFIED sign)' },
  { addr: 279, type: 's16', metric: 'Battery power', note: 'battery power W, + = charging (UNVERIFIED sign)' },
  { addr: 280, metric: 'Battery state of charge', note: 'SOC % (UNVERIFIED)' },
  { addr: 281, type: 's16', metric: 'DC-DC temperature', note: 'DC module temperature °C (UNVERIFIED)' },
  { addr: 302, metric: 'PV power total', note: 'total PV power W (UNVERIFIED; protocol 3/4 only)' },
  { addr: 305, type: 's16', metric: 'PV temperature', note: 'PV module temperature °C (UNVERIFIED)' },
  { addr: 326, type: 's32', metric: 'External CT power', note: 'external CT power balance W (UNVERIFIED)' },
  ...phase(1),
  ...phase(2),
  ...phase(3),
];

export const EXT_INFO: RegDef[] = [
  SERIAL,
  { addr: 171, metric: 'Device type code', note: 'device type (UNVERIFIED)' },
  { addr: 184, metric: 'Protocol number', note: 'protocol version 3–6 (UNVERIFIED)' },
];

const V = { kind: 'number', scale: 0.1 } as const;
const PCT = { kind: 'number' } as const;

export const EXT_SETTINGS: SumrySetting[] = [
  // Input/output
  setting('Input/output', 'Output source priority', {
    type: 'select', reg: 601, codec: { kind: 'enum', values: [1, 2, 3] },
    options: ['Solar/Utility/Battery', 'Solar/Battery/Utility', 'Solar first'],
    help: 'Vendor names: SUB, SBU, SUF. Read-only until verified on hardware.',
    note: 'holding 601 primary output priority 1 SUB / 2 SBU / 3 SUF (UNVERIFIED)',
  }),
  setting('Input/output', 'AC output voltage', {
    type: 'number', reg: 606, codec: V, unit: 'V', min: 100, max: 240, step: 0.1, note: 'holding 606 0.1 V (UNVERIFIED)',
  }),
  setting('Input/output', 'AC output frequency', {
    type: 'number', reg: 607, codec: { kind: 'number', scale: 0.01 }, unit: 'Hz', min: 50, max: 60, step: 0.01,
    note: 'holding 607 0.01 Hz (UNVERIFIED)',
  }),
  setting('Input/output', 'AC input voltage range', {
    type: 'select', reg: 677, codec: { kind: 'enum' }, options: ['Appliance', 'UPS', 'Generator'],
    note: 'holding 677 0 APL / 1 UPS / 2 GNT (UNVERIFIED)',
  }),
  setting('Input/output', 'Overload restart', { type: 'checkbox', reg: 682, codec: { kind: 'bool' }, note: 'holding 682 (UNVERIFIED)' }),
  setting('Input/output', 'Overload to bypass', { type: 'checkbox', reg: 684, codec: { kind: 'bool' }, note: 'holding 684 (UNVERIFIED)' }),
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 630, codec: { kind: 'enum', values: [0, 1, 2, 4, 6, 8] },
    options: ['AGM', 'Flooded', 'User-defined', 'Lithium 2', 'Lithium 4', 'Lithium (BMS)'],
    note: 'holding 630 0 AGM / 1 FLD / 2 USER / 4 Li2 / 6 Li4 / 8 LiB (UNVERIFIED)',
  }),
  setting('Battery', 'Charger source priority', {
    type: 'select', reg: 632, codec: { kind: 'enum', values: [1, 2, 3, 4] },
    options: ['Solar first', 'Solar and utility simultaneously', 'Solar only', 'Solar first, utility reserve'],
    help: 'Vendor names: SOF, SNU, OSO, SOR. Read-only until verified on hardware.',
    note: 'holding 632 primary charger source 1 SOF / 2 SNU / 3 OSO / 4 SOR (UNVERIFIED)',
  }),
  setting('Battery', 'Battery over voltage protection', {
    type: 'number', reg: 631, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 631 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 637, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 637 bulk 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 638, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 638 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 640, codec: V, unit: 'A', min: 0, max: 300, step: 0.1, note: 'holding 640 0.1 A (UNVERIFIED)',
  }),
  setting('Battery', 'Max grid charge current', {
    type: 'number', reg: 641, codec: V, unit: 'A', min: 0, max: 300, step: 0.1, note: 'holding 641 0.1 A (UNVERIFIED)',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 642, codec: PCT, unit: 'A', min: 0, max: 500, step: 1, note: 'holding 642 1 A (UNVERIFIED)',
  }),
  setting('Battery', 'Back to battery voltage', {
    type: 'number', reg: 643, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 643 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'To grid battery voltage', {
    type: 'number', reg: 644, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 644 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'Shutdown battery voltage', {
    type: 'number', reg: 646, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 646 off-grid cut-off 0.1 V (UNVERIFIED)',
  }),
  setting('Battery', 'Back to battery capacity', {
    key: 'back_to_battery_capacity', type: 'number', reg: 647, codec: PCT, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 647 % (UNVERIFIED)',
  }),
  setting('Battery', 'To grid battery capacity', {
    key: 'back_to_grid_battery_capacity', type: 'number', reg: 648, codec: PCT, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 648 % (UNVERIFIED)',
  }),
  setting('Battery', 'Shutdown battery capacity', {
    key: 'shutdown_battery_capacity', type: 'number', reg: 650, codec: PCT, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 650 off-grid low SOC % (UNVERIFIED)',
  }),
  setting('Battery', 'Battery equalization', { type: 'checkbox', reg: 651, codec: { kind: 'bool' }, note: 'holding 651 (UNVERIFIED)' }),
  setting('Battery', 'Battery equalization voltage', {
    type: 'number', reg: 652, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 652 0.1 V (UNVERIFIED)',
  }),
  // Miscellaneous
  setting('Miscellaneous', 'Buzzer mode', {
    type: 'select', reg: 678, codec: { kind: 'enum' },
    options: ['Silent', 'Source change, warnings and faults', 'Warnings and faults', 'Faults only'],
    note: 'holding 678 0–3 (UNVERIFIED: option order assumed as classic map)',
  }),
  setting('Miscellaneous', 'LCD backlight', { type: 'checkbox', reg: 679, codec: { kind: 'bool' }, note: 'holding 679 (UNVERIFIED)' }),
  setting('Miscellaneous', 'Energy saving mode', { type: 'checkbox', reg: 681, codec: { kind: 'bool' }, note: 'holding 681 (UNVERIFIED)' }),
  setting('Miscellaneous', 'Over temperature restart', { type: 'checkbox', reg: 683, codec: { kind: 'bool' }, note: 'holding 683 (UNVERIFIED)' }),
];

const PASS = [
  'Fault code', 'Warning code', 'Grid frequency', 'AC output frequency', 'Load percentage', 'Battery voltage',
  'Battery current', 'Battery power', 'Battery state of charge', 'Temperature', 'DC-DC temperature', 'Inverter power',
];

/** Raw table values → Sunroost metrics (per-phase names follow the Deye three-phase driver). */
export function deriveExt(raw: Metrics): Metrics {
  const out: Metrics = {};
  if (typeof raw['Device mode'] === 'string') out['Device mode'] = raw['Device mode'];
  for (const k of PASS) if (has(raw, k)) out[k] = raw[k];

  // Phases 2 and 3 only exist on split-/three-phase setups: emit them when that phase is live.
  const live = [1, 2, 3].filter((p) => p === 1 || num(raw, `AC output voltage ${p}`) > 0 || num(raw, `Grid voltage ${p}`) > 0);
  const multi = live.length > 1;
  let pv = 0;
  let pvSeen = false;
  let load = 0;
  let loadVa = 0;
  let grid = 0;
  for (const p of [1, 2, 3]) {
    // PV strings are independent of AC phases: report any string with voltage or power.
    if (has(raw, `PV power ${p}`) && (p === 1 || num(raw, `PV voltage ${p}`) > 0 || num(raw, `PV power ${p}`) > 0)) {
      for (const k of ['PV voltage', 'PV current', 'PV power']) out[`${k} ${p}`] = raw[`${k} ${p}`];
      pv += num(raw, `PV power ${p}`);
      pvSeen = true;
    }
    if (!live.includes(p)) continue;
    load += num(raw, `Load power ${p}`);
    loadVa += num(raw, `Load apparent power ${p}`);
    grid += num(raw, `Grid power ${p}`);
    if (!multi) continue;
    for (const k of ['Grid voltage', 'Grid power', 'Load power', 'AC output voltage']) {
      if (has(raw, `${k} ${p}`)) out[`${k} ${p}`] = raw[`${k} ${p}`];
    }
  }
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'AC output voltage 1')) out['AC output voltage'] = raw['AC output voltage 1'];
  if (has(raw, 'PV power total') && num(raw, 'PV power total') > 0) out['PV power'] = num(raw, 'PV power total');
  else if (pvSeen) out['PV power'] = pv;
  out['Load power'] = has(raw, 'Load power total') && num(raw, 'Load power total') > 0 ? num(raw, 'Load power total') : load;
  out['Load apparent power'] = has(raw, 'Load apparent power total') && num(raw, 'Load apparent power total') > 0
    ? num(raw, 'Load apparent power total') : loadVa;
  if (has(raw, 'Grid power total')) out['Grid power'] = num(raw, 'Grid power total');
  else out['Grid power'] = grid;
  if (!has(raw, 'Battery current') && num(raw, 'Battery voltage') > 0) {
    out['Battery current'] = round(num(raw, 'Battery power') / num(raw, 'Battery voltage'), 1);
  }
  return out;
}

export const smgExt: SumryFamily = {
  id: 'smg_ext',
  name: 'SMG Modbus (extended map, split-phase / 11 kW)',
  liveBlocks: [[100, 6], [201, 56], [277, 29], [326, 28], [376, 16], [414, 16]],
  liveMap: EXT_LIVE,
  infoBlocks: [[171, 27]],
  infoMap: EXT_INFO,
  settings: EXT_SETTINGS,
  derive: deriveExt,
};
