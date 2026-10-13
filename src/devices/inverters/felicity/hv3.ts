/**
 * Three-phase family: Felicity IVGM hybrids (IVGM-8K…50K, incl. the HP3G2 range) and the T-Rex HP
 * (T-REX-25/50KHP3G01). RS485 on the COM RJ45 (A/B on pins 3/4), Modbus RTU, address 1. The
 * document gives 9600 8N1 for T-REX-25/50; IVGM units have been reported at 2400 and 9600 —
 * UNVERIFIED, set the baud rate to match the inverter's display.
 *
 * Source: Felicity "Inverter Communication Protocol – Series RS485" v01 (2025-03-13, IVGM) and the
 * matching T-REX-50 map, as transcribed by community projects. Addresses are from the document;
 * every scale is UNVERIFIED on hardware here. Notable field corrections reported by the community
 * and applied below: live power registers are 0.01 kW per count (the document says W), and the
 * temperatures are 0.1 °C signed.
 */
import { type Metrics } from '../../../core/metrics.ts';
import type { FelicityFamily } from './family.ts';
import { copy, has, num, type RegDef } from './registers.ts';
import { setting, type FelicitySetting } from './settings.ts';

const PHASES = [1, 2, 3] as const;
const KW100 = 10; // 0.01 kW per count → W

function phases(start: number, metric: string, def: Omit<RegDef, 'addr' | 'metric'>): RegDef[] {
  return PHASES.map((p, i) => ({ ...def, addr: start + i, metric: `${metric} ${p}` }));
}

export const HV3_LIVE: RegDef[] = [
  { addr: 0x1100, metric: 'Work mode', note: 'WorkMode code (document; enum not published — UNVERIFIED)' },
  { addr: 0x110a, metric: 'Fault code', note: 'fault code (UNVERIFIED)' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 0x1117 + n, scale: 0.1, metric: `PV voltage ${n}`, note: `PV${n} voltage 0.1 V (UNVERIFIED)` },
    { addr: 0x111b + n, type: 's16', scale: 0.1, metric: `PV current ${n}`, note: `PV${n} current 0.1 A (UNVERIFIED)` },
    { addr: 0x1127 + n, type: 's16', scale: KW100, metric: `PV power ${n}`, note: `PV${n} power 0.01 kW (UNVERIFIED; field-corrected from W)` },
  ]),
  { addr: 0x112c, scale: 0.1, metric: 'Battery voltage', note: 'Bat1 voltage 0.1 V (UNVERIFIED)' },
  { addr: 0x1130, type: 's16', scale: 0.1, metric: 'Battery current', note: 'Bat1 current 0.1 A signed (UNVERIFIED)' },
  { addr: 0x1131, type: 's16', scale: KW100, metric: 'Battery power', note: 'Bat1 power 0.01 kW, + = charging (UNVERIFIED)' },
  { addr: 0x1138, scale: 0.1, metric: 'Battery state of charge', note: 'Bat1 SOC 0.1 % (UNVERIFIED)' },
  { addr: 0x1145, type: 's16', scale: 0.1, metric: 'Temperature', note: 'inverter temperature 0.1 °C (UNVERIFIED)' },
  { addr: 0x1147, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'lead-acid sensor 0.1 °C (UNVERIFIED)' },
  ...phases(0x1150, 'Grid voltage', { scale: 0.1, note: 'grid phase voltage 0.1 V (UNVERIFIED)' }),
  ...phases(0x1153, 'Inverter voltage', { scale: 0.1, note: 'inverter phase voltage 0.1 V (UNVERIFIED)' }),
  { addr: 0x116d, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (UNVERIFIED)' },
  { addr: 0x116e, scale: 0.01, metric: 'Inverter frequency', note: '0.01 Hz (UNVERIFIED)' },
  ...phases(0x1173, 'Grid power', { type: 's16', scale: KW100, note: 'grid phase power 0.01 kW, + = import (UNVERIFIED)' }),
  ...phases(0x1179, 'Load power', { type: 's16', scale: KW100, note: 'load phase power 0.01 kW (UNVERIFIED)' }),
  ...phases(0x117c, 'Load apparent power', { scale: KW100, note: 'load apparent power 0.01 kVA (UNVERIFIED; T-REX-50 map only)' }),
  ...phases(0x117f, 'Load percentage', { note: 'load % per phase (UNVERIFIED)' }),
  { addr: 0x1192, type: 's16', scale: KW100, metric: 'Generator power', note: 'total generator power 0.01 kW (UNVERIFIED)' },
  { addr: 0x1193, type: 's16', scale: KW100, metric: 'Load power total', note: 'total load power 0.01 kW (UNVERIFIED)' },
  { addr: 0x1194, type: 's16', scale: KW100, metric: 'Grid power total', note: 'total grid power 0.01 kW, + = import (UNVERIFIED)' },
];

export function deriveHv3(raw: Metrics): Metrics {
  const out: Metrics = {};
  const mode = raw['Work mode'];
  if (mode !== undefined) out['Device mode'] = `Mode ${mode}`;
  copy(raw, out, [
    'Fault code', 'Battery voltage', 'Battery current', 'Battery power', 'Battery state of charge', 'Temperature',
    'Battery temperature', 'Grid frequency', 'Generator power',
  ]);
  let pv = 0;
  for (const n of [1, 2, 3, 4]) {
    for (const k of ['PV voltage', 'PV current', 'PV power']) copy(raw, out, [`${k} ${n}`]);
    pv += Math.max(0, num(raw, `PV power ${n}`));
  }
  out['PV power'] = pv;
  let apparent = 0;
  let pct = 0;
  for (const p of PHASES) {
    copy(raw, out, [`Grid voltage ${p}`, `Grid power ${p}`, `Load power ${p}`]);
    if (has(raw, `Inverter voltage ${p}`)) out[`AC output voltage ${p}`] = raw[`Inverter voltage ${p}`];
    apparent += num(raw, `Load apparent power ${p}`);
    pct = Math.max(pct, num(raw, `Load percentage ${p}`));
  }
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'Inverter voltage 1')) out['AC output voltage'] = raw['Inverter voltage 1'];
  if (has(raw, 'Inverter frequency')) out['AC output frequency'] = raw['Inverter frequency'];
  const phaseSum = (k: string) => PHASES.reduce((s, p) => s + num(raw, `${k} ${p}`), 0);
  out['Grid power'] = has(raw, 'Grid power total') ? num(raw, 'Grid power total') : phaseSum('Grid power');
  out['Load power'] = has(raw, 'Load power total') ? num(raw, 'Load power total') : phaseSum('Load power');
  out['Load apparent power'] = apparent;
  out['Load percentage'] = pct;
  return out;
}

export const HV3_SETTINGS: FelicitySetting[] = [
  setting('Work mode', 'System work mode', {
    type: 'select', reg: 0x2144, codec: { kind: 'enum' }, options: ['Selling', 'Zero export to load', 'Zero export to CT'],
    note: 'UNVERIFIED: 0x2144 0 selling / 1 zero export to load / 2 zero export to CT',
  }),
  setting('Work mode', 'Grid peak shaving', {
    type: 'checkbox', reg: 0x2148, codec: { kind: 'bool' }, note: 'UNVERIFIED: 0x2148 enable',
  }),
  setting('Battery', 'Grid charge', {
    type: 'checkbox', reg: 0x2127, codec: { kind: 'bool' }, note: 'UNVERIFIED: 0x2127 grid charge battery enable',
  }),
  setting('Battery', 'Grid charge current', {
    type: 'number', reg: 0x2124, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 300, step: 0.1,
    note: 'UNVERIFIED: 0x2124 0.1 A',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0x2117, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 300, step: 0.1,
    note: 'UNVERIFIED: 0x2117 battery 1 max charge current 0.1 A',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 0x2118, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 300, step: 0.1,
    note: 'UNVERIFIED: 0x2118 battery 1 max discharge current 0.1 A',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 0x2134, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 40, max: 60, step: 0.1,
    note: 'UNVERIFIED: 0x2134 0.1 V',
  }),
  setting('Battery', 'Battery restart SOC', {
    type: 'number', reg: 0x213a, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 0x213A %',
  }),
  setting('Battery', 'Battery low alarm SOC', {
    type: 'number', reg: 0x213b, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 0x213B %',
  }),
  setting('Battery', 'Battery shutdown SOC', {
    type: 'number', reg: 0x213c, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 0x213C %',
  }),
];

export const hv3: FelicityFamily = {
  id: 'hv3',
  name: 'IVGM / T-Rex HP (three-phase hybrid)',
  blocks: [
    [0x1100, 0x47], // 0x1100–0x1146
    [0x1147, 0x4e], // 0x1147–0x1194
  ],
  live: HV3_LIVE,
  derive: deriveHv3,
  settings: HV3_SETTINGS,
  socControl: null,
};
