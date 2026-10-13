/**
 * IVEM / IVPA family: Felicity's high-frequency off-grid / hybrid all-in-ones (IVEM3024, IVEM5048,
 * IVEM6048, IVPA7548 …) on the RS232 RJ45 port, Modbus RTU 2400 8N1, address 1.
 *
 * Source: Felicity "High-frequency inverter external communication protocol" (2021-06-08B), as
 * transcribed in public community projects and field-tested on IVEM5048 by several of them. Rows
 * from that document are marked "confident" (for IVEM). IVPA is assumed to speak the same protocol
 * (same RS232 port and product generation) — UNVERIFIED.
 *
 * The document has no battery state of charge and no grid power register; grid power is derived.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import type { FelicityFamily } from './family.ts';
import { copy, has, num, type RegDef } from './registers.ts';
import { setting, type FelicitySetting } from './settings.ts';

export const IVEM_MODES: Record<number, string> = {
  0: 'Power on',
  1: 'Standby',
  2: 'Bypass',
  3: 'Battery',
  4: 'Fault',
  5: 'Line',
  6: 'PV charge',
};

export const IVEM_LIVE: RegDef[] = [
  { addr: 0x1101, metric: 'Device mode', enum: IVEM_MODES, note: 'working mode 0–6 (confident)' },
  { addr: 0x1102, metric: 'Charge stage', enum: { 0: 'Not charging', 1: 'Bulk', 2: 'Absorption', 3: 'Float' }, note: 'battery charging stage (confident)' },
  { addr: 0x1103, metric: 'Fault code', note: 'fault id (confident; fault table not transcribed)' },
  { addr: 0x1104, metric: 'Power flow', note: 'PowerFlowMsg bit field (confident; not decoded)' },
  { addr: 0x1108, scale: 0.01, metric: 'Battery voltage', note: '0.01 V (confident)' },
  { addr: 0x1109, type: 's16', metric: 'Battery current', note: '1 A, signed, − = discharging (confident)' },
  { addr: 0x110a, type: 's16', metric: 'Battery power', note: '1 W, signed, − = discharging (confident)' },
  { addr: 0x1111, scale: 0.1, metric: 'AC output voltage', note: '0.1 V (confident)' },
  { addr: 0x1117, scale: 0.1, metric: 'Grid voltage', note: 'AC input voltage 0.1 V (confident)' },
  { addr: 0x1119, scale: 0.01, metric: 'Grid frequency', note: 'AC input frequency 0.01 Hz (confident)' },
  { addr: 0x111e, type: 's16', metric: 'Load power', note: 'AC output active power W (confident)' },
  { addr: 0x111f, metric: 'Load apparent power', note: 'AC output apparent power VA (confident)' },
  { addr: 0x1120, metric: 'Load percentage', note: '% (confident)' },
  { addr: 0x1126, scale: 0.1, metric: 'PV voltage 1', note: 'PV input voltage 0.1 V (confident)' },
  { addr: 0x112a, type: 's16', metric: 'PV power', note: 'PV input power W (confident)' },
];

/** Raw values → Sunroost metrics. */
export function deriveIvem(raw: Metrics): Metrics {
  const out: Metrics = {};
  copy(raw, out, [
    'Device mode', 'Fault code', 'Battery voltage', 'Battery current', 'Battery power', 'AC output voltage',
    'Grid voltage', 'Grid frequency', 'Load power', 'Load apparent power', 'Load percentage', 'PV voltage 1',
  ]);
  const pv = Math.max(0, num(raw, 'PV power'));
  const pvV = num(raw, 'PV voltage 1');
  out['PV power'] = pv;
  out['PV power 1'] = pv;
  out['PV current 1'] = pvV > 0 ? round(pv / pvV, 1) : 0;
  // No grid power register: on Line/Bypass the utility covers whatever the load and the charger take
  // beyond PV. Derived, ignores conversion losses; 0 on battery (the unit never exports).
  const mode = raw['Device mode'];
  const onGrid = mode === 'Line' || mode === 'Bypass';
  out['Grid power'] = onGrid ? round(Math.max(0, num(raw, 'Load power') + num(raw, 'Battery power') - pv), 0) : 0;
  // The output follows the grid frequency when passing it through; no output-frequency register.
  if (onGrid && has(raw, 'Grid frequency')) out['AC output frequency'] = raw['Grid frequency'];
  return out;
}

const OUTPUT_PRIORITY = ['Utility first', 'Solar first', 'Solar/Battery/Utility'];
const CHARGER_PRIORITY = ['Utility first', 'Solar first', 'Solar and utility simultaneously', 'Solar only'];

export const IVEM_SETTINGS: FelicitySetting[] = [
  setting('Input/output', 'Output source priority', {
    type: 'select', reg: 0x212a, codec: { kind: 'enum' }, options: OUTPUT_PRIORITY,
    note: '0x212A 0 utility / 1 solar / 2 SBU (confident)',
  }),
  setting('Battery', 'Charger source priority', {
    type: 'select', reg: 0x212c, codec: { kind: 'enum' }, options: CHARGER_PRIORITY,
    note: '0x212C 1 solar first / 2 solar+utility / 3 solar only (confident); 0 utility first is UNVERIFIED (community only)',
  }),
  setting('Input/output', 'AC output frequency', {
    type: 'select', reg: 0x2129, codec: { kind: 'enum' }, options: ['50', '60'], unit: 'Hz',
    note: '0x2129 0 = 50 Hz / 1 = 60 Hz (confident)',
  }),
  setting('Input/output', 'AC input voltage range', {
    type: 'select', reg: 0x212b, codec: { kind: 'enum' }, options: ['Appliance', 'UPS'],
    note: '0x212B application mode 0 APL / 1 UPS (confident)',
  }),
  setting('Battery', 'Battery type', {
    type: 'select', reg: 0x212d, codec: { kind: 'enum' }, options: ['AGM', 'Flooded', 'User-defined', 'Lithium (LiFePO4)'],
    note: '0x212D 0 AGM / 1 flooded / 2 user / 3 LiFePO4 (confident)',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0x212e, codec: { kind: 'number' }, unit: 'A', min: 10, max: 100, step: 1,
    note: '0x212E 1 A (confident)',
  }),
  setting('Battery', 'Max grid charge current', {
    type: 'number', reg: 0x2130, codec: { kind: 'number' }, unit: 'A', min: 10, max: 100, step: 1,
    note: '0x2130 1 A (confident)',
  }),
  setting('Battery', 'Shutdown battery voltage', {
    type: 'number', reg: 0x211f, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 21, max: 54, step: 0.1,
    note: '0x211F cut-off 0.1 V (confident); range 21–27 V on 24 V, 42–54 V on 48 V',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 0x2122, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 24, max: 60, step: 0.1,
    note: '0x2122 C.V voltage 0.1 V (confident)',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 0x2123, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 24, max: 60, step: 0.1,
    note: '0x2123 float voltage 0.1 V (confident)',
  }),
  setting('Battery', 'To grid battery voltage', {
    type: 'number', reg: 0x2156, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 22, max: 54, step: 0.1,
    note: '0x2156 back-to-charge (utility) voltage 0.1 V (confident)',
  }),
  setting('Battery', 'Back to battery voltage', {
    type: 'number', reg: 0x2159, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 24, max: 60.1, step: 0.1,
    note: '0x2159 back-to-discharge voltage 0.1 V; 30.1 / 60.1 = FULL (confident)',
  }),
  setting('Miscellaneous', 'Buzzer', { type: 'checkbox', reg: 0x2131, codec: { kind: 'bool' }, note: '0x2131 (confident)' }),
  setting('Input/output', 'Overload restart', { type: 'checkbox', reg: 0x2133, codec: { kind: 'bool' }, note: '0x2133 (confident)' }),
  setting('Miscellaneous', 'Over temperature restart', { type: 'checkbox', reg: 0x2134, codec: { kind: 'bool' }, note: '0x2134 (confident)' }),
  setting('Miscellaneous', 'LCD backlight', { type: 'checkbox', reg: 0x2135, codec: { kind: 'bool' }, note: '0x2135 (confident)' }),
  setting('Input/output', 'Overload bypass', { type: 'checkbox', reg: 0x2137, codec: { kind: 'bool' }, note: '0x2137 (confident)' }),
];

export const ivem: FelicityFamily = {
  id: 'ivem',
  name: 'IVEM / IVPA (off-grid and hybrid all-in-one)',
  blocks: [[0x1100, 0x2b]], // 0x1100–0x112A
  live: IVEM_LIVE,
  derive: deriveIvem,
  settings: IVEM_SETTINGS,
  socControl: { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' },
};
