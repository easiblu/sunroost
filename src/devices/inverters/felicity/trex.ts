/**
 * T-REX LP family: Felicity's newer low-voltage hybrids (T-REX-5KLP1G01, T-REX-6KLP1G01; the
 * three-phase T-REX-10KLP3G01 shares the map). RS485 on the COM RJ45, Modbus RTU 2400 8N1,
 * address 1 (2400 is the factory default on T-REX 5–10K).
 *
 * The live block starts at 0x1100 like IVEM's but is laid out differently (0x1108 is the fault
 * code here, battery voltage on IVEM). Source: community register maps for T-REX-5K/10K built from
 * Felicity's T-REX protocol document and checked on running units. No public vendor PDF was
 * available to cross-check, so every row is UNVERIFIED; the ones the community uses daily for its
 * dashboards are marked "medium".
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import type { FelicityFamily } from './family.ts';
import { copy, num, type RegDef } from './registers.ts';
import { setting, type FelicitySetting } from './settings.ts';

export const TREX_MODES: Record<number, string> = {
  0: 'Power on',
  1: 'Standby',
  2: 'Bypass',
  3: 'Battery',
  4: 'Fault',
  5: 'Line',
  6: 'PV charge',
};

export const TREX_LIVE: RegDef[] = [
  { addr: 0x1101, metric: 'Device mode', enum: TREX_MODES, note: 'working mode, same codes as IVEM (UNVERIFIED, medium)' },
  { addr: 0x1108, metric: 'Fault code', note: 'UNVERIFIED' },
  { addr: 0x1109, scale: 0.1, metric: 'Grid voltage', note: 'AC input voltage 0.1 V (UNVERIFIED, medium)' },
  { addr: 0x110a, scale: 0.1, metric: 'Grid current', note: 'AC input current 0.1 A (UNVERIFIED)' },
  { addr: 0x110b, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (UNVERIFIED, medium)' },
  { addr: 0x110c, type: 's16', metric: 'Grid power', note: 'AC input power W, + = import (UNVERIFIED, medium)' },
  { addr: 0x110d, scale: 0.1, metric: 'Battery voltage', note: '0.1 V (UNVERIFIED, medium)' },
  { addr: 0x110e, type: 's16', scale: 0.1, metric: 'Battery current', note: '0.1 A signed (UNVERIFIED)' },
  { addr: 0x110f, type: 's16', metric: 'Battery power', note: 'W signed, + = charging (UNVERIFIED, medium)' },
  { addr: 0x1110, scale: 0.1, metric: 'Battery state of charge', note: 'battery capacity 0.1 % (UNVERIFIED, medium)' },
  { addr: 0x1111, scale: 0.1, metric: 'AC output voltage', note: '0.1 V (UNVERIFIED, medium)' },
  { addr: 0x1113, scale: 0.01, metric: 'AC output frequency', note: '0.01 Hz (UNVERIFIED)' },
  { addr: 0x1114, type: 's16', metric: 'Load power', note: 'AC output active power W (UNVERIFIED, medium)' },
  { addr: 0x1115, metric: 'Load apparent power', note: 'VA (UNVERIFIED)' },
  { addr: 0x1116, metric: 'Load percentage', note: '% (UNVERIFIED)' },
  { addr: 0x1117, scale: 0.1, metric: 'PV voltage 1', note: '0.1 V (UNVERIFIED, medium)' },
  { addr: 0x1118, scale: 0.1, metric: 'PV current 1', note: '0.1 A (UNVERIFIED)' },
  { addr: 0x1119, metric: 'PV power 1', note: 'W (UNVERIFIED, medium)' },
  { addr: 0x111a, scale: 0.1, metric: 'PV voltage 2', note: '0.1 V (UNVERIFIED)' },
  { addr: 0x111b, scale: 0.1, metric: 'PV current 2', note: '0.1 A (UNVERIFIED)' },
  { addr: 0x111c, metric: 'PV power 2', note: 'W (UNVERIFIED)' },
  { addr: 0x1144, scale: 0.1, metric: 'Bus voltage', note: 'P-bus voltage 0.1 V (UNVERIFIED)' },
  { addr: 0x114c, type: 's16', scale: 0.1, metric: 'Temperature', note: 'heatsink temperature 1, 0.1 °C (UNVERIFIED)' },
];

export function deriveTrex(raw: Metrics): Metrics {
  const out: Metrics = {};
  copy(raw, out, [
    'Device mode', 'Fault code', 'Grid voltage', 'Grid frequency', 'Grid power', 'Battery voltage', 'Battery current',
    'Battery power', 'Battery state of charge', 'AC output voltage', 'AC output frequency', 'Load power',
    'Load apparent power', 'Load percentage', 'PV voltage 1', 'PV current 1', 'PV power 1', 'PV voltage 2',
    'PV current 2', 'PV power 2', 'Bus voltage', 'Temperature',
  ]);
  out['PV power'] = round(num(raw, 'PV power 1') + num(raw, 'PV power 2'), 0);
  return out;
}

export const TREX_SETTINGS: FelicitySetting[] = [
  setting('Work mode', 'Operating mode', {
    type: 'select', reg: 0x2103, codec: { kind: 'enum' }, options: ['General', 'Backup', 'Economic'],
    note: 'UNVERIFIED: 0x2103 0 general (self-use) / 1 backup / 2 economic (time-of-use)',
  }),
  setting('Battery', 'Battery type', {
    type: 'select', reg: 0x2123, codec: { kind: 'enum' },
    options: ['User-defined', 'Lithium', 'Felicity LPBF', 'Felicity LPBA', 'No battery'],
    note: 'UNVERIFIED: 0x2123',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 0x2125, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 40, max: 60, step: 0.1,
    note: 'UNVERIFIED: 0x2125 0.1 V',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 0x2126, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 40, max: 60, step: 0.1,
    note: 'UNVERIFIED: 0x2126 0.1 V',
  }),
  setting('Battery', 'Shutdown battery voltage (grid)', {
    type: 'number', reg: 0x2127, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 40, max: 60, step: 0.1,
    note: 'UNVERIFIED: 0x2127 on-grid cut-off without BMS 0.1 V',
  }),
  setting('Battery', 'Shutdown battery voltage (off-grid)', {
    type: 'number', reg: 0x2128, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 40, max: 60, step: 0.1,
    note: 'UNVERIFIED: 0x2128 off-grid cut-off without BMS 0.1 V',
  }),
  setting('Battery', 'Discharge depth (grid)', {
    type: 'number', reg: 0x212a, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 0x212A on-grid depth of discharge with BMS %',
  }),
  setting('Battery', 'Discharge depth (off-grid)', {
    type: 'number', reg: 0x212b, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 0x212B off-grid depth of discharge with BMS %',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0x212d, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 0.1,
    note: 'UNVERIFIED: 0x212D 0.1 A',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 0x212e, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 0.1,
    note: 'UNVERIFIED: 0x212E 0.1 A',
  }),
];

export const trex: FelicityFamily = {
  id: 'trex',
  name: 'T-REX LP hybrid (5–10 kW)',
  blocks: [[0x1100, 0x52]], // 0x1100–0x1151
  live: TREX_LIVE,
  derive: deriveTrex,
  settings: TREX_SETTINGS,
  socControl: null,
};
