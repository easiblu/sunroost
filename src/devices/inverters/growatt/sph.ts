/**
 * Growatt SPH single-phase hybrid (SPH 3000–6000TL BL-UP; also the SPA AC-coupled units, which simply
 * report no PV) and SPH TL3 three-phase hybrid (SPH 4000–10000TL3 BH).
 *
 * Register map: "Growatt Inverter Modbus RTU Protocol" V1.20/V1.24 — inverter block 0–124 and the
 * storage block 1000–1124 (input), storage holding 1000–1124. Addresses marked UNVERIFIED are from
 * memory of the protocol and community integrations, not checked against the PDF.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { INFO_HOLDING, type GrowattFamily } from './family.ts';
import { has, num, type RegDef } from './registers.ts';
import { setting, type GrowattSetting } from './settings.ts';

/** Storage system work mode (input 1000). */
export const SPH_WORK_MODE: Record<number, string> = {
  0: 'Waiting', 1: 'Self-test', 2: 'Reserved', 3: 'Fault', 4: 'Flash', 5: 'Normal', 6: 'Battery online',
  7: 'Off-grid (PV)', 8: 'Off-grid (battery)',
};

/** Inverter block, shared by SPH and SPH TL3 (input, fn 4). */
const SPH_INVERTER: RegDef[] = [
  { addr: 0, metric: 'Inverter status', enum: { 0: 'Waiting', 1: 'Normal', 3: 'Fault' }, note: 'Inverter status (confident)' },
  { addr: 1, type: 'u32', scale: 0.1, metric: 'PV power', note: 'Ppv 0.1 W (confident)' },
  { addr: 3, scale: 0.1, metric: 'PV voltage 1', note: 'Vpv1 0.1 V (confident)' },
  { addr: 4, scale: 0.1, metric: 'PV current 1', note: 'Ipv1 0.1 A (confident)' },
  { addr: 5, type: 'u32', scale: 0.1, metric: 'PV power 1', note: 'Ppv1 0.1 W (confident)' },
  { addr: 7, scale: 0.1, metric: 'PV voltage 2', note: 'Vpv2 0.1 V (confident)' },
  { addr: 8, scale: 0.1, metric: 'PV current 2', note: 'Ipv2 0.1 A (confident)' },
  { addr: 9, type: 'u32', scale: 0.1, metric: 'PV power 2', note: 'Ppv2 0.1 W (confident)' },
  { addr: 35, type: 'u32', scale: 0.1, metric: 'Inverter AC power', note: 'Pac 0.1 W (confident)' },
  { addr: 37, scale: 0.01, metric: 'Grid frequency', note: 'Fac 0.01 Hz (confident)' },
  { addr: 38, scale: 0.1, metric: 'Grid voltage', note: 'Vac1 0.1 V (confident)' },
  { addr: 93, type: 's16', scale: 0.1, metric: 'Temperature', note: 'Inverter temperature 0.1 °C (medium)' },
  { addr: 98, scale: 0.1, metric: 'Bus voltage', note: 'P bus voltage 0.1 V (UNVERIFIED)' },
];

/** Storage block (input, fn 4). */
const SPH_STORAGE: RegDef[] = [
  { addr: 1000, metric: 'Device mode', enum: SPH_WORK_MODE, note: 'uwSysWorkMode (medium)' },
  { addr: 1009, type: 'u32', scale: 0.1, metric: 'Battery discharge power', note: 'Pdischarge 0.1 W (confident)' },
  { addr: 1011, type: 'u32', scale: 0.1, metric: 'Battery charge power', note: 'Pcharge 0.1 W (confident)' },
  { addr: 1013, scale: 0.1, metric: 'Battery voltage', note: 'Vbat 0.1 V (UNVERIFIED scale; some docs say 0.01 V)' },
  { addr: 1014, metric: 'Battery state of charge', note: 'SOC % (confident)' },
  { addr: 1021, type: 'u32', scale: 0.1, metric: 'Grid import power', note: 'Pactouser total 0.1 W (confident)' },
  { addr: 1029, type: 'u32', scale: 0.1, metric: 'Grid export power', note: 'Pactogrid total 0.1 W (confident)' },
  { addr: 1037, type: 'u32', scale: 0.1, metric: 'Local load power', note: 'Plocal load total 0.1 W (confident)' },
  { addr: 1040, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'Battery temperature 0.1 °C (medium)' },
];

/** Three-phase extras for SPH TL3. */
const SPH3_EXTRA: RegDef[] = [
  { addr: 42, scale: 0.1, metric: 'Grid voltage 2', note: 'Vac2 0.1 V (medium)' },
  { addr: 46, scale: 0.1, metric: 'Grid voltage 3', note: 'Vac3 0.1 V (medium)' },
  { addr: 1015, type: 'u32', scale: 0.1, metric: 'Grid import power 1', note: 'Pactouser R 0.1 W (medium)' },
  { addr: 1017, type: 'u32', scale: 0.1, metric: 'Grid import power 2', note: 'Pactouser S (medium)' },
  { addr: 1019, type: 'u32', scale: 0.1, metric: 'Grid import power 3', note: 'Pactouser T (medium)' },
  { addr: 1023, type: 'u32', scale: 0.1, metric: 'Grid export power 1', note: 'Pactogrid R (medium)' },
  { addr: 1025, type: 'u32', scale: 0.1, metric: 'Grid export power 2', note: 'Pactogrid S (medium)' },
  { addr: 1027, type: 'u32', scale: 0.1, metric: 'Grid export power 3', note: 'Pactogrid T (medium)' },
];

const PRIORITIES = ['Load first', 'Battery first', 'Grid first'];

export const SPH_SETTINGS: GrowattSetting[] = [
  // Work mode — the storage holding block 1044–1108 is widely used by community integrations.
  setting('Work mode', 'Work mode priority', {
    type: 'select', reg: 1044, codec: { kind: 'enum' }, options: PRIORITIES, verified: true,
    note: 'holding 1044 Priority 0 Load / 1 Battery / 2 Grid (medium-high)',
  }),
  setting('Work mode', 'Battery first charge rate', {
    type: 'number', reg: 1090, codec: { kind: 'number' }, unit: '%', min: 1, max: 100, step: 1, verified: true,
    note: 'holding 1090 BatFirst power rate %',
  }),
  setting('Work mode', 'Battery first stop charge', {
    type: 'number', reg: 1091, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1, verified: true,
    note: 'holding 1091 BatFirst stop SOC %',
  }),
  setting('Work mode', 'Battery first grid charge', {
    type: 'checkbox', reg: 1092, codec: { kind: 'bool' }, verified: true,
    note: 'holding 1092 AC charge switch 0 off / 1 on',
  }),
  setting('Work mode', 'Grid first discharge rate', {
    type: 'number', reg: 1070, codec: { kind: 'number' }, unit: '%', min: 1, max: 100, step: 1, verified: true,
    note: 'holding 1070 GridFirst discharge power rate %',
  }),
  setting('Work mode', 'Grid first stop discharge', {
    type: 'number', reg: 1071, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1, verified: true,
    note: 'holding 1071 GridFirst stop SOC %',
  }),
  // Grid
  setting('Grid', 'AC output voltage', {
    type: 'select', reg: 1061, codec: { kind: 'enum' }, unit: 'V', options: ['230', '208', '240'],
    note: 'UNVERIFIED: holding 1061 EPS (backup) voltage 0 230 / 1 208 / 2 240',
  }),
  setting('Grid', 'AC output frequency', {
    type: 'select', reg: 1062, codec: { kind: 'enum' }, unit: 'Hz', options: ['50', '60'],
    note: 'UNVERIFIED: holding 1062 EPS frequency 0 50 / 1 60',
  }),
  setting('Grid', 'Backup EPS', {
    type: 'checkbox', reg: 1060, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 1060 EPS (UPS) function enable',
  }),
  setting('Grid', 'Export limiter', {
    type: 'checkbox', reg: 122, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 122 ExportLimit 0 off / 1 RS485 meter / 2 RS232 / 3 CT (non-zero reads as on)',
  }),
  setting('Grid', 'Export power rate', {
    type: 'number', reg: 123, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: holding 123 ExportLimitPowerRate 0.1 %',
  }),
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 1048, codec: { kind: 'enum' }, options: ['Lead-acid', 'Lithium'],
    note: 'UNVERIFIED: holding 1048 battery type (low confidence)',
  }),
  // Schedule: three Battery-first and three Grid-first windows; outside them the unit runs Load first.
  ...[1, 2, 3].map((n) =>
    setting('Schedule', `Battery first slot ${n}`, {
      type: 'slot', reg: 1100 + (n - 1) * 3, codec: { kind: 'slot3' }, verified: true,
      note: `holding ${1100 + (n - 1) * 3}–${1102 + (n - 1) * 3} start, stop (h<<8|m), enable`,
    }),
  ),
  ...[1, 2, 3].map((n) =>
    setting('Schedule', `Grid first slot ${n}`, {
      type: 'slot', reg: 1080 + (n - 1) * 3, codec: { kind: 'slot3' }, verified: true,
      note: `holding ${1080 + (n - 1) * 3}–${1082 + (n - 1) * 3} start, stop (h<<8|m), enable`,
    }),
  ),
];

/** Holding registers decoded in the console besides the settings. */
export const SPH_HOLDING: RegDef[] = [{ addr: 0, metric: 'On/off', note: '0 off, 1 on' }, ...INFO_HOLDING];

function deriveHybrid(raw: Metrics, phases: boolean): Metrics {
  const pv1 = num(raw, 'PV power 1');
  const pv2 = num(raw, 'PV power 2');
  const pv = has(raw, 'PV power') ? num(raw, 'PV power') : pv1 + pv2;
  const grid = num(raw, 'Grid import power') - num(raw, 'Grid export power');
  const battery = num(raw, 'Battery charge power') - num(raw, 'Battery discharge power');
  const battV = num(raw, 'Battery voltage');
  // The local-load register needs the meter/CT; fall back to an AC-side balance without it.
  const load = num(raw, 'Local load power') > 0 ? num(raw, 'Local load power') : Math.max(0, num(raw, 'Inverter AC power') + grid);
  const status = String(raw['Inverter status'] ?? '');
  const out: Metrics = {
    'Device mode': String(raw['Device mode'] ?? status),
    'PV power': round(pv, 0),
    'PV power 1': round(pv1, 0),
    'PV power 2': round(pv2, 0),
    'Battery power': round(battery, 0),
    'Battery current': battV > 0 ? round(battery / battV, 1) : 0,
    'Grid power': round(grid, 0),
    'Load power': round(load, 0),
  };
  for (const k of [
    'PV voltage 1', 'PV voltage 2', 'PV current 1', 'PV current 2', 'Battery voltage', 'Battery state of charge',
    'Battery temperature', 'Grid voltage', 'Grid frequency', 'Temperature', 'Bus voltage',
  ]) {
    if (has(raw, k)) out[k] = raw[k];
  }
  // On a hybrid the AC port is both grid tie and output.
  if (has(raw, 'Grid voltage')) out['AC output voltage'] = raw['Grid voltage'];
  if (has(raw, 'Grid frequency')) out['AC output frequency'] = raw['Grid frequency'];
  if (phases) {
    if (has(raw, 'Grid voltage')) out['Grid voltage 1'] = raw['Grid voltage'];
    for (const p of [1, 2, 3]) {
      if (p > 1 && has(raw, `Grid voltage ${p}`)) out[`Grid voltage ${p}`] = raw[`Grid voltage ${p}`];
      if (has(raw, `Grid import power ${p}`) || has(raw, `Grid export power ${p}`)) {
        out[`Grid power ${p}`] = round(num(raw, `Grid import power ${p}`) - num(raw, `Grid export power ${p}`), 0);
      }
    }
  }
  return out;
}

const hybridSoc = { setting: 'work_mode_priority', gridValue: 'Battery first', batteryValue: 'Load first' };

export const sph: GrowattFamily = {
  id: 'sph',
  name: 'SPH / SPA (single-phase hybrid)',
  inputBlocks: [[0, 100], [1000, 41]],
  inputMap: [...SPH_INVERTER, ...SPH_STORAGE],
  holdingMap: SPH_HOLDING,
  settings: SPH_SETTINGS,
  derive: (raw) => deriveHybrid(raw, false),
  socControl: hybridSoc,
  protection: null,
};

export const sph3: GrowattFamily = {
  id: 'sph3',
  name: 'SPH TL3 (three-phase hybrid)',
  inputBlocks: [[0, 100], [1000, 41]],
  inputMap: [...SPH_INVERTER, ...SPH_STORAGE, ...SPH3_EXTRA],
  holdingMap: SPH_HOLDING,
  settings: SPH_SETTINGS,
  derive: (raw) => deriveHybrid(raw, true),
  socControl: hybridSoc,
  protection: null,
};
