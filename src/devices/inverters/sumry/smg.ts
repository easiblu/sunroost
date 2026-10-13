/**
 * "smg" — the classic SMG-II Modbus map spoken by most Sumry-class all-in-ones (Easun ISolar SMG II,
 * Anenji ANJ, Sumry HGX/VICTOR, PowMr/Vevor rebrands …). RS232 (RJ45/DB9) or RS485, 9600 8N1,
 * unit id 1, holding registers (function 3) only, decimal addresses.
 *
 * Sources (facts only, nothing copied): the vendor "SMG II Modbus RTU" register list as published in
 * user forums, and the public ESPHome SMG-II configuration (syssi/esphome-smg-ii), which documents
 * the live block 201–234 and settings 300–343 with scales and option values. "confident" = several
 * public sources agree; "UNVERIFIED" = one source or inferred.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { has, num, type RegDef } from '../growatt/registers.ts';
import { SERIAL, setting, type SumryFamily, type SumrySetting } from './family.ts';

export const SMG_MODES: Record<number, string> = {
  0: 'Power on', 1: 'Standby', 2: 'Line', 3: 'Off-grid', 4: 'Bypass', 5: 'Charging', 6: 'Fault',
};

/** Live holding registers. */
export const SMG_LIVE: RegDef[] = [
  { addr: 100, type: 'u32', metric: 'Fault code', note: 'fault bit field, 2 registers (confident)' },
  { addr: 108, type: 'u32', metric: 'Warning code', note: 'warning bit field, 2 registers (UNVERIFIED: 104 on some firmware)' },
  { addr: 201, metric: 'Device mode', enum: SMG_MODES, note: 'working mode 0–6 (confident)' },
  { addr: 202, type: 's16', scale: 0.1, metric: 'Grid voltage', note: 'mains voltage 0.1 V (confident)' },
  { addr: 203, type: 's16', scale: 0.01, metric: 'Grid frequency', note: 'mains frequency 0.01 Hz (confident)' },
  { addr: 204, type: 's16', metric: 'Grid power raw', note: 'average mains power W (confident; sign on export UNVERIFIED)' },
  { addr: 205, type: 's16', scale: 0.1, metric: 'Inverter voltage', note: 'inverter voltage 0.1 V (confident)' },
  { addr: 206, type: 's16', scale: 0.1, metric: 'Inverter current', note: 'inverter current 0.1 A (confident)' },
  { addr: 207, type: 's16', scale: 0.01, metric: 'Inverter frequency', note: 'inverter frequency 0.01 Hz (confident)' },
  { addr: 208, type: 's16', metric: 'Inverter power', note: 'average inverter power W (confident)' },
  { addr: 209, type: 's16', metric: 'Grid charge power', note: 'mains charging power W (confident)' },
  { addr: 210, type: 's16', scale: 0.1, metric: 'AC output voltage', note: 'output voltage 0.1 V (confident)' },
  { addr: 211, type: 's16', scale: 0.1, metric: 'AC output current', note: 'output current 0.1 A (confident)' },
  { addr: 212, type: 's16', scale: 0.01, metric: 'AC output frequency', note: 'output frequency 0.01 Hz (confident)' },
  { addr: 213, type: 's16', metric: 'Load power', note: 'output active power W (confident)' },
  { addr: 214, type: 's16', metric: 'Load apparent power', note: 'output apparent power VA (confident)' },
  { addr: 215, type: 's16', scale: 0.1, metric: 'Battery voltage', note: 'battery voltage 0.1 V (confident)' },
  { addr: 216, type: 's16', scale: 0.1, metric: 'Battery current', note: 'battery current 0.1 A, + = charging (confident)' },
  { addr: 217, type: 's16', metric: 'Battery power', note: 'battery power W, + = charging (confident)' },
  { addr: 219, type: 's16', scale: 0.1, metric: 'PV voltage 1', note: 'PV voltage 0.1 V (confident)' },
  { addr: 220, type: 's16', scale: 0.1, metric: 'PV current 1', note: 'PV current 0.1 A (confident)' },
  { addr: 223, type: 's16', metric: 'PV power 1', note: 'PV power W (confident)' },
  { addr: 224, type: 's16', metric: 'PV charge power', note: 'PV charging power W (confident)' },
  { addr: 225, type: 's16', metric: 'Load percentage', note: 'load % (confident)' },
  { addr: 226, type: 's16', metric: 'DC-DC temperature', note: 'DC-DC temperature °C (confident)' },
  { addr: 227, type: 's16', metric: 'Temperature', note: 'inverter temperature °C (confident)' },
  { addr: 229, metric: 'Battery state of charge', note: 'SOC % (confident)' },
  { addr: 233, type: 's16', scale: 0.1, metric: 'Grid charge current', note: 'mains charging current 0.1 A (UNVERIFIED)' },
  { addr: 234, type: 's16', scale: 0.1, metric: 'PV charge current', note: 'PV charging current 0.1 A (UNVERIFIED)' },
];

export const SMG_INFO: RegDef[] = [
  SERIAL,
  { addr: 643, metric: 'Max AC output power', note: 'rated power W (UNVERIFIED: one source only)' },
];

const OUTPUT_PRIORITIES = ['Utility first', 'Solar first', 'Solar/Battery/Utility', 'Solar/Utility/Battery'];
const CHARGER_PRIORITIES = ['Utility first', 'Solar first', 'Solar and utility simultaneously', 'Solar only'];
const BATTERY_TYPES = ['AGM', 'Flooded', 'User-defined', 'Lithium 1', 'Lithium 2', 'Lithium 3', 'Lithium 4', 'Lithium (BMS)'];
const V = { kind: 'number', scale: 0.1 } as const;

export const SMG_SETTINGS: SumrySetting[] = [
  // Input/output
  setting('Input/output', 'Output source priority', {
    type: 'select', reg: 301, codec: { kind: 'enum' }, options: OUTPUT_PRIORITIES,
    note: 'holding 301: 0 UTI / 1 SOL / 2 SBU / 3 SUB (confident; SUB not on every firmware)',
  }),
  setting('Input/output', 'AC input voltage range', {
    type: 'select', reg: 302, codec: { kind: 'enum' }, options: ['Appliance', 'UPS'],
    note: 'holding 302: 0 wide (APL) / 1 narrow (UPS) (confident)',
  }),
  setting('Input/output', 'AC output voltage', {
    type: 'number', reg: 320, codec: V, unit: 'V', min: 100, max: 240, step: 0.1, note: 'holding 320 0.1 V (confident)',
  }),
  setting('Input/output', 'AC output frequency', {
    type: 'number', reg: 321, codec: { kind: 'number', scale: 0.01 }, unit: 'Hz', min: 50, max: 60, step: 0.01,
    note: 'holding 321 0.01 Hz (confident)',
  }),
  setting('Input/output', 'Overload restart', { type: 'checkbox', reg: 308, codec: { kind: 'bool' }, note: 'holding 308 (confident)' }),
  setting('Input/output', 'Overload to bypass', { type: 'checkbox', reg: 310, codec: { kind: 'bool' }, note: 'holding 310 (confident)' }),
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 322, codec: { kind: 'enum', values: [0, 1, 2, 3, 4, 5, 6, 8] }, options: BATTERY_TYPES,
    note: 'holding 322: 0 AGM / 1 FLD / 2 USER / 3–6 Li1–Li4 / 8 LiB (confident)',
  }),
  setting('Battery', 'Charger source priority', {
    type: 'select', reg: 331, codec: { kind: 'enum' }, options: CHARGER_PRIORITIES,
    note: 'holding 331: 0 utility / 1 PV / 2 PV+utility / 3 PV only (confident)',
  }),
  setting('Battery', 'Battery over voltage protection', {
    type: 'number', reg: 323, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 323 0.1 V (confident)',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 324, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 324 bulk 0.1 V (confident)',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 325, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 325 0.1 V (confident)',
  }),
  setting('Battery', 'Back to battery voltage', {
    type: 'number', reg: 326, codec: V, unit: 'V', min: 10, max: 70, step: 0.1,
    note: 'holding 326 discharge recovery point in line mode 0.1 V (confident)',
  }),
  setting('Battery', 'To grid battery voltage', {
    type: 'number', reg: 327, codec: V, unit: 'V', min: 10, max: 70, step: 0.1,
    note: 'holding 327 low-voltage point in line mode 0.1 V (confident)',
  }),
  setting('Battery', 'Shutdown battery voltage', {
    type: 'number', reg: 329, codec: V, unit: 'V', min: 10, max: 70, step: 0.1,
    note: 'holding 329 low-voltage cut-off off-grid 0.1 V (confident)',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 332, codec: V, unit: 'A', min: 0, max: 200, step: 0.1, note: 'holding 332 0.1 A (confident)',
  }),
  setting('Battery', 'Max grid charge current', {
    type: 'number', reg: 333, codec: V, unit: 'A', min: 0, max: 200, step: 0.1, note: 'holding 333 0.1 A (confident)',
  }),
  setting('Battery', 'Battery equalization', { type: 'checkbox', reg: 313, codec: { kind: 'bool' }, note: 'holding 313 (confident)' }),
  setting('Battery', 'Battery equalization voltage', {
    type: 'number', reg: 334, codec: V, unit: 'V', min: 10, max: 70, step: 0.1, note: 'holding 334 0.1 V (confident)',
  }),
  setting('Battery', 'To grid battery capacity', {
    key: 'back_to_grid_battery_capacity', type: 'number', reg: 341, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 341 SOC back to utility % (medium)',
  }),
  setting('Battery', 'Back to battery capacity', {
    key: 'back_to_battery_capacity', type: 'number', reg: 342, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 342 SOC back to battery % (medium)',
  }),
  setting('Battery', 'Shutdown battery capacity', {
    key: 'shutdown_battery_capacity', type: 'number', reg: 343, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 343 low DC cut-off SOC % (medium)',
  }),
  // Miscellaneous
  setting('Miscellaneous', 'Buzzer mode', {
    type: 'select', reg: 303, codec: { kind: 'enum' },
    options: ['Silent', 'Source change, warnings and faults', 'Warnings and faults', 'Faults only'],
    note: 'holding 303 (confident)',
  }),
  setting('Miscellaneous', 'LCD backlight', { type: 'checkbox', reg: 305, codec: { kind: 'bool' }, note: 'holding 305 0 timed off / 1 always on (confident)' }),
  setting('Miscellaneous', 'Energy saving mode', { type: 'checkbox', reg: 307, codec: { kind: 'bool' }, note: 'holding 307 (confident)' }),
  setting('Miscellaneous', 'Over temperature restart', { type: 'checkbox', reg: 309, codec: { kind: 'bool' }, note: 'holding 309 (confident)' }),
];

const PASS = [
  'Fault code', 'Warning code', 'Grid voltage', 'Grid frequency', 'AC output voltage', 'AC output current', 'AC output frequency',
  'Load power', 'Load apparent power', 'Load percentage', 'Battery voltage', 'Battery current', 'Battery power',
  'Battery state of charge', 'PV voltage 1', 'PV current 1', 'PV power 1', 'Temperature', 'DC-DC temperature',
  'Inverter voltage', 'Inverter frequency', 'Inverter power',
];

/** Raw table values → Sunroost metrics. */
export function deriveSmg(raw: Metrics): Metrics {
  const out: Metrics = {};
  if (typeof raw['Device mode'] === 'string') out['Device mode'] = raw['Device mode'];
  for (const k of PASS) if (k in raw) out[k] = raw[k];
  if (has(raw, 'PV power 1')) out['PV power'] = num(raw, 'PV power 1');
  // Mains power: what the inverter draws from the grid (load in bypass + AC charging), + = import.
  // Feed-in capable units may report export as negative (UNVERIFIED), which is passed through.
  if (has(raw, 'Grid power raw')) out['Grid power'] = num(raw, 'Grid power raw');
  if (!has(raw, 'Battery current') && has(raw, 'Battery power') && num(raw, 'Battery voltage') > 0) {
    out['Battery current'] = round(num(raw, 'Battery power') / num(raw, 'Battery voltage'), 1);
  }
  return out;
}

export const smg: SumryFamily = {
  id: 'smg',
  name: 'SMG-II Modbus (classic map)',
  liveBlocks: [[100, 10], [201, 34]],
  liveMap: SMG_LIVE,
  infoBlocks: [[186, 12], [643, 1]],
  infoMap: SMG_INFO,
  settings: SMG_SETTINGS,
  derive: deriveSmg,
};
