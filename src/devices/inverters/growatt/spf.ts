/**
 * Growatt SPF off-grid (SPF 3000TL LVM, 5000ES, 6000ES …), "OffGrid SPF Modbus RS485/RS232 RTU Protocol".
 *
 * Wiring: the inverter's RS232 (DB9) or USB-B port, 9600 8N1, unit id 1.
 * Input registers 0–27 are carried over from the v1 driver (decoded against the protocol PDF).
 * The SPF has no grid or battery power register, so both are derived by energy balance.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { INFO_HOLDING, type GrowattFamily } from './family.ts';
import { has, num, type RegDef } from './registers.ts';
import { setting, type GrowattSetting } from './settings.ts';

export const SPF_STATUS: Record<number, string> = {
  0: 'Standby', 1: 'No use', 2: 'Discharge', 3: 'Fault', 4: 'Flash', 5: 'PV charge', 6: 'AC charge',
  7: 'Combine charge', 8: 'Combine charge & bypass', 9: 'PV charge & bypass', 10: 'AC charge & bypass',
  11: 'Bypass', 12: 'PV charge & discharge',
};
/** Statuses where the load is fed straight from the grid. */
const BYPASS = new Set(['Combine charge & bypass', 'PV charge & bypass', 'AC charge & bypass', 'Bypass']);

/** Input registers (fn 4). */
export const SPF_INPUT: RegDef[] = [
  { addr: 0, metric: 'Device mode', enum: SPF_STATUS, note: 'System status (v1, confident)' },
  { addr: 1, scale: 0.1, metric: 'PV voltage 1', note: 'Vpv1 0.1 V' },
  { addr: 2, scale: 0.1, metric: 'PV voltage 2', note: 'Vpv2 0.1 V' },
  { addr: 3, type: 'u32', scale: 0.1, metric: 'PV power 1', note: 'Ppv1 0.1 W' },
  { addr: 5, type: 'u32', scale: 0.1, metric: 'PV power 2', note: 'Ppv2 0.1 W' },
  { addr: 7, scale: 0.1, metric: 'PV current 1', note: 'Buck1 current 0.1 A (medium confidence)' },
  { addr: 8, scale: 0.1, metric: 'PV current 2', note: 'Buck2 current 0.1 A (medium confidence)' },
  { addr: 9, type: 'u32', scale: 0.1, metric: 'Load power', note: 'OP_Watt output active power 0.1 W' },
  { addr: 11, type: 'u32', scale: 0.1, metric: 'Load apparent power', note: 'OP_VA 0.1 VA' },
  { addr: 13, type: 'u32', scale: 0.1, metric: 'AC charge power', note: 'ACChr_Watt 0.1 W' },
  { addr: 15, type: 'u32', scale: 0.1, metric: 'AC charge apparent power', note: 'ACChr_VA 0.1 VA' },
  { addr: 17, scale: 0.01, metric: 'Battery voltage', note: 'Bat volt 0.01 V' },
  { addr: 18, metric: 'Battery state of charge', note: 'SOC %' },
  { addr: 19, scale: 0.1, metric: 'Bus voltage', note: 'Bus volt 0.1 V' },
  { addr: 20, scale: 0.1, metric: 'Grid voltage', note: 'Grid volt 0.1 V' },
  { addr: 21, scale: 0.01, metric: 'Grid frequency', note: 'Line freq 0.01 Hz' },
  { addr: 22, scale: 0.1, metric: 'AC output voltage', note: 'Output volt 0.1 V' },
  { addr: 23, scale: 0.01, metric: 'AC output frequency', note: 'Output freq 0.01 Hz' },
  { addr: 24, scale: 0.1, metric: 'Output DC voltage', note: 'Output DCV 0.1 V' },
  { addr: 25, type: 's16', scale: 0.1, metric: 'Temperature', note: 'Inverter temp 0.1 °C' },
  { addr: 26, type: 's16', scale: 0.1, metric: 'DC-DC temperature', note: 'DC-DC temp 0.1 °C' },
  { addr: 27, scale: 0.1, metric: 'Load percentage', note: 'Load percent 0.1 %' },
];

/** Holding registers (fn 3) decoded in the console besides the settings. */
export const SPF_HOLDING: RegDef[] = [
  { addr: 0, metric: 'On/off', note: '0 off, 1 on' },
  ...INFO_HOLDING.filter((d) => d.addr !== 43),
];

const OUTPUT_PRIORITIES = ['Solar/Battery/Utility', 'Solar first', 'Utility first', 'Solar/Utility/Battery'];

export const SPF_SETTINGS: GrowattSetting[] = [
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 39, codec: { kind: 'enum' }, options: ['AGM', 'Flooded', 'User-defined', 'Lithium'],
    note: 'UNVERIFIED: holding 39 BatType 0 AGM / 1 Flooded / 2 User / 3 Lithium (some firmware adds more)',
  }),
  setting('Battery', 'Charger source priority', {
    type: 'select', reg: 2, codec: { kind: 'enum' }, verified: true,
    options: ['Solar first', 'Solar and utility simultaneously', 'Solar only'],
    note: 'holding 2 ChargeConfig 0 PV first / 1 PV&UTI / 2 PV only (v1, confident)',
  }),
  setting('Battery', 'To grid battery voltage', {
    type: 'number', reg: 37, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 20, max: 64, step: 0.1,
    note: 'UNVERIFIED: holding 37 BatLowToUtiVolt 0.1 V',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 35, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 20, max: 64, step: 0.1,
    note: 'UNVERIFIED: holding 35 BulkChargeVolt 0.1 V',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 36, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 20, max: 64, step: 0.1,
    note: 'UNVERIFIED: holding 36 FloatChargeVolt 0.1 V',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 34, codec: { kind: 'number' }, unit: 'A', min: 10, max: 200, step: 1,
    note: 'UNVERIFIED: holding 34 MaxChargeCurr 1 A',
  }),
  setting('Battery', 'Max grid charge current', {
    type: 'number', reg: 38, codec: { kind: 'number' }, unit: 'A', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: holding 38 AC (utility) charge current 1 A',
  }),
  // Input/output
  setting('Input/output', 'AC input voltage range', {
    type: 'select', reg: 8, codec: { kind: 'enum' }, options: ['Appliance', 'UPS', 'Generator'],
    note: 'UNVERIFIED: holding 8 ACinModel 0 APL / 1 UPS / 2 GEN',
  }),
  setting('Input/output', 'AC output voltage', {
    type: 'select', reg: 18, codec: { kind: 'enum' }, unit: 'V', options: ['208', '230', '240', '220', '100', '110', '120'],
    note: 'UNVERIFIED: holding 18 OutputVoltType',
  }),
  setting('Input/output', 'AC output frequency', {
    type: 'select', reg: 19, codec: { kind: 'enum' }, unit: 'Hz', options: ['50', '60'],
    note: 'UNVERIFIED: holding 19 OutputFreqType 0 50 Hz / 1 60 Hz',
  }),
  setting('Input/output', 'Output source priority', {
    type: 'select', reg: 1, codec: { kind: 'enum' }, verified: true, options: OUTPUT_PRIORITIES,
    help: 'Growatt calls these SBU, SOL, UTI and SUB.',
    note: 'holding 1 OutputConfig 0 SBU / 1 SOL / 2 UTI / 3 SUB (v1, confident; SUB not on every firmware)',
  }),
  setting('Input/output', 'Overload restart', {
    type: 'checkbox', reg: 20, codec: { kind: 'bool', on: 0, off: 1 },
    note: 'UNVERIFIED: holding 20 OverLoadRestart 0 yes / 1 no / 2 switch to utility',
  }),
  // Miscellaneous
  setting('Miscellaneous', 'Over temperature restart', {
    type: 'checkbox', reg: 21, codec: { kind: 'bool', on: 0, off: 1 },
    note: 'UNVERIFIED: holding 21 OverTempRestart 0 yes / 1 no',
  }),
  setting('Miscellaneous', 'Buzzer', {
    type: 'checkbox', reg: 22, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 22 BuzzerEN 0 off / 1 on',
  }),
];

/** Raw SPF table values → metrics, deriving grid and battery power by energy balance (as v1 did). */
export function deriveSpf(raw: Metrics): Metrics {
  const pv1 = num(raw, 'PV power 1');
  const pv2 = num(raw, 'PV power 2');
  const pv = pv1 + pv2;
  const load = num(raw, 'Load power');
  const acCharge = num(raw, 'AC charge power');
  const mode = String(raw['Device mode'] ?? '');
  // Grid feeds the AC charger, plus the whole load while in bypass.
  const grid = acCharge + (BYPASS.has(mode) ? load : 0);
  // Energy balance; ignores conversion losses, so it reads a little high.
  const battery = pv + grid - load;
  const battV = num(raw, 'Battery voltage');
  const out: Metrics = {
    'Device mode': mode,
    'PV power': round(pv, 0),
    'PV power 1': round(pv1, 0),
    'PV power 2': round(pv2, 0),
    'Battery power': round(battery, 0),
    'Battery current': battV > 0 ? round(battery / battV, 1) : 0,
    'Grid power': round(grid, 0),
    'Load power': round(load, 0),
  };
  for (const k of [
    'PV voltage 1', 'PV voltage 2', 'PV current 1', 'PV current 2', 'Load apparent power', 'Battery voltage',
    'Battery state of charge', 'Bus voltage', 'Grid voltage', 'Grid frequency', 'AC output voltage',
    'AC output frequency', 'Temperature', 'Load percentage',
  ]) {
    if (has(raw, k)) out[k] = k === 'Load apparent power' ? round(num(raw, k), 0) : raw[k];
  }
  return out;
}

export const spf: GrowattFamily = {
  id: 'spf',
  name: 'SPF (off-grid)',
  inputBlocks: [[0, 28]],
  inputMap: SPF_INPUT,
  holdingMap: SPF_HOLDING,
  settings: SPF_SETTINGS,
  derive: deriveSpf,
  socControl: { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' },
  protection: { setting: 'output_source_priority', shutdownValue: 'Utility first' },
};
