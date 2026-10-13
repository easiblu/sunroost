/**
 * Growatt MIN TL-X (grid-tie, no battery) and MIN TL-XH / MOD XH (hybrid) — the "3000 range" of the
 * Growatt Inverter Modbus RTU Protocol V1.24 (input 3000–3124 inverter, 3125–3249 storage; holding
 * 3000–3124).
 *
 * Confidence is lower than for SPF/SPH: everything here is from memory of the V1.24 tables and
 * community integrations. Every TL setting is UNVERIFIED and therefore read-only until confirmed.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { INFO_HOLDING, type GrowattFamily } from './family.ts';
import { has, num, type RegDef } from './registers.ts';
import { setting, type GrowattSetting } from './settings.ts';

export const TL_STATUS: Record<number, string> = { 0: 'Waiting', 1: 'Normal', 3: 'Fault', 5: 'Normal (battery)' };

const TL_INVERTER: RegDef[] = [
  { addr: 3000, metric: 'Device mode', enum: TL_STATUS, note: 'Inverter status (medium; TL-XH may use more codes)' },
  { addr: 3001, type: 'u32', scale: 0.1, metric: 'PV power', note: 'Ppv 0.1 W (medium)' },
  { addr: 3003, scale: 0.1, metric: 'PV voltage 1', note: 'Vpv1 0.1 V (medium)' },
  { addr: 3004, scale: 0.1, metric: 'PV current 1', note: 'Ipv1 0.1 A (medium)' },
  { addr: 3005, type: 'u32', scale: 0.1, metric: 'PV power 1', note: 'Ppv1 0.1 W (medium)' },
  { addr: 3007, scale: 0.1, metric: 'PV voltage 2', note: 'Vpv2 0.1 V (medium)' },
  { addr: 3008, scale: 0.1, metric: 'PV current 2', note: 'Ipv2 0.1 A (medium)' },
  { addr: 3009, type: 'u32', scale: 0.1, metric: 'PV power 2', note: 'Ppv2 0.1 W (medium)' },
  { addr: 3023, type: 's32', scale: 0.1, metric: 'Inverter AC power', note: 'Pac 0.1 W (UNVERIFIED)' },
  { addr: 3025, scale: 0.01, metric: 'Grid frequency', note: 'Fac 0.01 Hz (UNVERIFIED)' },
  { addr: 3026, scale: 0.1, metric: 'Grid voltage', note: 'Vac1 0.1 V (UNVERIFIED)' },
  { addr: 3041, type: 'u32', scale: 0.1, metric: 'Grid import power', note: 'Pactouser total 0.1 W (UNVERIFIED)' },
  { addr: 3043, type: 'u32', scale: 0.1, metric: 'Grid export power', note: 'Pactogrid total 0.1 W (UNVERIFIED)' },
  { addr: 3045, type: 'u32', scale: 0.1, metric: 'Local load power', note: 'Plocal load total 0.1 W (UNVERIFIED)' },
  { addr: 3093, type: 's16', scale: 0.1, metric: 'Temperature', note: 'Inverter temperature 0.1 °C (UNVERIFIED)' },
  { addr: 3098, scale: 0.1, metric: 'Bus voltage', note: 'P bus voltage 0.1 V (UNVERIFIED)' },
];

const TL_STORAGE: RegDef[] = [
  { addr: 3169, scale: 0.01, metric: 'Battery voltage', note: 'Vbat 0.01 V (UNVERIFIED)' },
  { addr: 3171, metric: 'Battery state of charge', note: 'SOC % (UNVERIFIED)' },
  { addr: 3176, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'Battery temperature 0.1 °C (UNVERIFIED)' },
  { addr: 3178, type: 'u32', scale: 0.1, metric: 'Battery discharge power', note: 'Pdischarge 0.1 W (UNVERIFIED)' },
  { addr: 3180, type: 'u32', scale: 0.1, metric: 'Battery charge power', note: 'Pcharge 0.1 W (UNVERIFIED)' },
];

const SLOT_PRIORITIES = ['Load first', 'Battery first', 'Grid first'];

const GRID_SETTINGS: GrowattSetting[] = [
  setting('Grid', 'Export limiter', {
    type: 'checkbox', reg: 122, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 122 ExportLimit 0 off / non-zero on',
  }),
  setting('Grid', 'Export power rate', {
    type: 'number', reg: 123, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: holding 123 ExportLimitPowerRate 0.1 %',
  }),
];

export const TLXH_SETTINGS: GrowattSetting[] = [
  ...GRID_SETTINGS,
  setting('Priority', 'Work mode priority', {
    type: 'select', codec: { kind: 'enum' }, options: SLOT_PRIORITIES,
    note: 'No known holding register; TL-XH priority follows the time slots. Read-only placeholder.',
  }),
  setting('Priority', 'Grid first discharge rate', {
    type: 'number', reg: 3036, codec: { kind: 'number' }, unit: '%', min: 1, max: 100, step: 1,
    note: 'UNVERIFIED: holding 3036',
  }),
  setting('Priority', 'Grid first stop discharge', {
    type: 'number', reg: 3037, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1,
    note: 'UNVERIFIED: holding 3037',
  }),
  setting('Priority', 'Battery first charge rate', {
    type: 'number', reg: 3047, codec: { kind: 'number' }, unit: '%', min: 1, max: 100, step: 1,
    note: 'UNVERIFIED: holding 3047',
  }),
  setting('Priority', 'Battery first stop charge', {
    type: 'number', reg: 3048, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1,
    note: 'UNVERIFIED: holding 3048',
  }),
  setting('Priority', 'Battery first grid charge', {
    type: 'checkbox', reg: 3049, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 3049 AC charge enable',
  }),
  ...[1, 2, 3, 4].map((n) =>
    setting('Schedule', `Work mode slot ${n}`, {
      type: 'slot', reg: 3038 + (n - 1) * 2, codec: { kind: 'tlslot' }, slotPriorities: SLOT_PRIORITIES,
      note: `UNVERIFIED: holding ${3038 + (n - 1) * 2}/${3039 + (n - 1) * 2} (enable bit 15, priority bits 13–14, start h/m; end h<<8|m)`,
    }),
  ),
];

const TL_HOLDING: RegDef[] = [{ addr: 0, metric: 'On/off', note: '0 off, 1 on' }, ...INFO_HOLDING];

function deriveTl(raw: Metrics, battery: boolean): Metrics {
  const pv1 = num(raw, 'PV power 1');
  const pv2 = num(raw, 'PV power 2');
  const pv = has(raw, 'PV power') ? num(raw, 'PV power') : pv1 + pv2;
  const grid = num(raw, 'Grid import power') - num(raw, 'Grid export power');
  const load = num(raw, 'Local load power') > 0 ? num(raw, 'Local load power') : Math.max(0, num(raw, 'Inverter AC power') + grid);
  const out: Metrics = {
    'Device mode': String(raw['Device mode'] ?? ''),
    'PV power': round(pv, 0),
    'PV power 1': round(pv1, 0),
    'PV power 2': round(pv2, 0),
    'Grid power': round(grid, 0),
    'Load power': round(load, 0),
  };
  for (const k of ['PV voltage 1', 'PV voltage 2', 'PV current 1', 'PV current 2', 'Grid voltage', 'Grid frequency', 'Temperature', 'Bus voltage']) {
    if (has(raw, k)) out[k] = raw[k];
  }
  if (has(raw, 'Grid voltage')) out['AC output voltage'] = raw['Grid voltage'];
  if (has(raw, 'Grid frequency')) out['AC output frequency'] = raw['Grid frequency'];
  if (battery) {
    const p = num(raw, 'Battery charge power') - num(raw, 'Battery discharge power');
    const v = num(raw, 'Battery voltage');
    out['Battery power'] = round(p, 0);
    out['Battery current'] = v > 0 ? round(p / v, 1) : 0;
    for (const k of ['Battery voltage', 'Battery state of charge', 'Battery temperature']) if (has(raw, k)) out[k] = raw[k];
  }
  return out;
}

export const tlxh: GrowattFamily = {
  id: 'tlxh',
  name: 'MIN TL-XH / MOD XH (hybrid)',
  inputBlocks: [[3000, 100], [3164, 20]],
  inputMap: [...TL_INVERTER, ...TL_STORAGE],
  holdingMap: TL_HOLDING,
  settings: TLXH_SETTINGS,
  derive: (raw) => deriveTl(raw, true),
  socControl: { setting: 'work_mode_priority', gridValue: 'Battery first', batteryValue: 'Load first' },
  protection: null,
};

export const tlx: GrowattFamily = {
  id: 'tlx',
  name: 'MIN TL-X (grid-tie)',
  inputBlocks: [[3000, 100]],
  inputMap: TL_INVERTER,
  holdingMap: TL_HOLDING,
  settings: GRID_SETTINGS,
  derive: (raw) => deriveTl(raw, false),
  socControl: null,
  protection: null,
};
