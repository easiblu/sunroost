/**
 * Deye / Sunsynk three-phase hybrids (holding registers, function 3):
 *   hybrid3   — LV (48 V battery) 5–12 kW: Deye SUN-xK-SG04LP3, Sunsynk 3-phase 5–12K.
 *   hybrid3hv — HV battery 5–50 kW: Deye SUN-xK-SG01HP3 / SG01HP3-EU-AM2 and rebrands.
 *
 * Source: the public Deye three-phase map (live block 500–683, settings 98–177) as used by the
 * ha-solarman "deye_sg04lp3" / kellerza three_phase definitions. Best knowledge; notes say how sure.
 * The HV map is assumed identical except where noted; all HV settings are read-only.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import type { DeyeFamily } from './family.ts';
import { has, num, type RegDef } from './registers.ts';
import { deriveBattery, deriveCommon, derivePv, RUN_STATE } from './single.ts';
import {
  BATTERY_MODES, ENERGY_PATTERNS, setting, touSettings, WORK_MODES, type DeyeSetting,
} from './settings.ts';

const TEMP = { offset: 1000, scale: 0.1 } as const;

function phases(base: number, metric: string, opts: Partial<RegDef>, note: string): RegDef[] {
  return [1, 2, 3].map((p) => ({ addr: base + p - 1, metric: `${metric} ${p}`, ...opts, note }));
}

export const THREE_LIVE: RegDef[] = [
  { addr: 500, metric: 'Run state', enum: RUN_STATE, note: 'run state (confident)' },
  { addr: 540, ...TEMP, metric: 'Temperature DC', note: 'DC transformer temperature (medium)' },
  { addr: 541, ...TEMP, metric: 'Temperature AC', note: 'AC heat sink temperature (medium)' },
  { addr: 555, metric: 'Fault word 1', note: 'medium' },
  { addr: 556, metric: 'Fault word 2', note: 'medium' },
  { addr: 557, metric: 'Fault word 3', note: 'medium' },
  { addr: 558, metric: 'Fault word 4', note: 'medium' },
  { addr: 586, ...TEMP, metric: 'Battery temperature', note: 'medium' },
  { addr: 587, scale: 0.01, metric: 'Battery voltage', note: '0.01 V (confident on LV)' },
  { addr: 588, metric: 'Battery state of charge', note: 'confident' },
  { addr: 590, type: 's16', metric: 'Battery power raw', note: 'W, + = discharging (confident on LV) — negated' },
  { addr: 591, type: 's16', scale: 0.01, metric: 'Battery current raw', note: '0.01 A, + = discharging (medium)' },
  ...phases(598, 'Grid voltage', { scale: 0.1 }, 'grid L-N voltage 0.1 V (confident)'),
  ...phases(604, 'Grid power LD', { type: 's16' }, 'internal (inverter-side) grid power W (medium)'),
  { addr: 607, type: 's16', metric: 'Grid power LD total', note: 'medium' },
  { addr: 609, scale: 0.01, metric: 'Grid frequency', note: 'confident' },
  ...phases(616, 'Grid power CT', { type: 's16' }, 'external CT power W (medium)'),
  { addr: 619, type: 's16', metric: 'Grid power CT total', note: 'medium' },
  { addr: 625, type: 's16', metric: 'Grid power total', note: 'total grid power W, +import (confident)' },
  ...phases(627, 'Inverter voltage', { scale: 0.1 }, 'UNVERIFIED: inverter output voltage per phase'),
  { addr: 638, scale: 0.01, metric: 'Inverter frequency', note: 'UNVERIFIED: inverter output frequency' },
  ...phases(650, 'Load power', { type: 's16' }, 'load power per phase W (medium)'),
  { addr: 653, type: 's16', metric: 'Load power total', note: 'total (essential) load W (confident)' },
  { addr: 667, type: 's16', metric: 'Gen port power', note: 'UNVERIFIED: GEN port total power' },
  ...[1, 2, 3, 4].map((n) => ({ addr: 671 + n, metric: `PV power ${n}`, note: n > 2 ? 'medium' : 'confident' })),
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 674 + n * 2, scale: 0.1, metric: `PV voltage ${n}`, note: n > 2 ? 'medium' : 'confident' },
    { addr: 675 + n * 2, scale: 0.1, metric: `PV current ${n}`, note: n > 2 ? 'medium' : 'confident' },
  ]),
];

/**
 * HV variant: same addresses, but battery voltage is 0.1 V and battery power is in 10 W units on the
 * larger HV models (UNVERIFIED — compare against the inverter display before trusting).
 */
export const THREE_HV_LIVE: RegDef[] = THREE_LIVE.map((d) => {
  if (d.addr === 587) return { ...d, scale: 0.1, note: 'UNVERIFIED: HV battery voltage 0.1 V' };
  if (d.addr === 590) return { ...d, scale: 10, note: 'UNVERIFIED: HV battery power 10 W, + = discharging — negated' };
  return d;
});

export function deriveThree(raw: Metrics): Metrics {
  const out: Metrics = {};
  deriveCommon(raw, out);
  derivePv(raw, out);
  deriveBattery(raw, out);
  for (const k of ['Battery voltage', 'Battery state of charge', 'Battery temperature', 'Grid frequency', 'Temperature DC', 'Temperature AC']) {
    if (has(raw, k)) out[k] = raw[k];
  }
  for (const p of [1, 2, 3]) {
    for (const k of ['Grid voltage', 'Grid power CT', 'Grid power LD', 'Load power']) {
      if (has(raw, `${k} ${p}`)) out[`${k} ${p}`] = raw[`${k} ${p}`];
    }
    if (has(raw, `Inverter voltage ${p}`)) out[`AC output voltage ${p}`] = raw[`Inverter voltage ${p}`];
  }
  // The first phase's voltage doubles as the headline (unnumbered) value.
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'Inverter voltage 1')) out['AC output voltage'] = raw['Inverter voltage 1'];
  for (const p of [1, 2, 3]) {
    if (has(raw, `Grid power CT ${p}`) || has(raw, `Grid power LD ${p}`)) {
      // Per-phase grid power follows the CT when one reports, otherwise the internal reading.
      const ct = num(raw, `Grid power CT ${p}`);
      out[`Grid power ${p}`] = ct !== 0 ? ct : num(raw, `Grid power LD ${p}`);
    }
  }
  const ct = num(raw, 'Grid power CT total');
  const ld = num(raw, 'Grid power LD total');
  out['Grid power'] = num(raw, 'Grid power total');
  out['Grid power CT'] = ct;
  out['Grid power LD'] = ld;
  const load = num(raw, 'Load power total');
  out['Load power'] = load;
  out['Load power essential'] = load;
  out['Load power non-essential'] = Math.max(0, ct - ld);
  if (has(raw, 'Gen port power')) out['Generator power'] = num(raw, 'Gen port power');
  out['AC output frequency'] = has(raw, 'Inverter frequency') && num(raw, 'Inverter frequency') > 0
    ? raw['Inverter frequency']
    : round(num(raw, 'Grid frequency'), 2);
  return out;
}

export const THREE_SETTINGS: DeyeSetting[] = [
  setting('Work mode', 'System work mode', {
    type: 'select', reg: 142, codec: { kind: 'enum' }, options: WORK_MODES, verified: true,
    note: 'holding 142 limit control 0/1/2 (medium-high)',
  }),
  setting('Work mode', 'Solar export', {
    type: 'checkbox', reg: 145, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 145 solar sell 0/1',
  }),
  setting('Work mode', 'Energy pattern', {
    type: 'select', reg: 141, codec: { kind: 'enum' }, options: ENERGY_PATTERNS,
    note: 'UNVERIFIED: holding 141 energy management 0 battery first / 1 load first',
  }),
  setting('Work mode', 'Max sell power', {
    type: 'number', reg: 143, codec: { kind: 'number' }, unit: 'W', min: 0, max: 50000, step: 10,
    note: 'UNVERIFIED: holding 143 W',
  }),
  setting('Battery', 'Battery capacity', {
    type: 'number', reg: 102, codec: { kind: 'number' }, unit: 'Ah', min: 0, max: 2000, step: 1,
    note: 'UNVERIFIED: holding 102 Ah',
  }),
  setting('Battery', 'Battery operation', {
    type: 'select', codec: { kind: 'enum' }, options: BATTERY_MODES,
    note: 'UNVERIFIED: address unknown on three-phase; not read',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 108, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1, verified: true,
    note: 'holding 108 A (confident)',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 109, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1, verified: true,
    note: 'holding 109 A (confident)',
  }),
  setting('Battery', 'Battery shutdown SOC', {
    type: 'number', reg: 115, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: holding 115',
  }),
  setting('Battery', 'Battery restart SOC', {
    type: 'number', reg: 116, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: holding 116',
  }),
  setting('Battery', 'Battery low SOC', {
    type: 'number', reg: 117, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: holding 117',
  }),
  setting('Grid', 'Grid charge', {
    type: 'checkbox', reg: 130, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 130',
  }),
  setting('Grid', 'Grid charge current', {
    type: 'number', reg: 128, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1,
    note: 'UNVERIFIED: holding 128 A',
  }),
  setting('Grid', 'Generator charge enabled', {
    type: 'checkbox', codec: { kind: 'bool' },
    note: 'UNVERIFIED: address unknown; not read',
  }),
  ...touSettings({
    enable: 146, time: 148, power: 154, voltage: 160, soc: 166, charge: 172, maxPower: 20000, verified: true,
    note: 'three-phase TOU block 146–177 (medium-high)',
  }),
];

/** HV: same table, nothing writable until confirmed on a real unit. */
export const THREE_HV_SETTINGS: DeyeSetting[] = THREE_SETTINGS.map((s) => ({
  ...s,
  verified: false,
  readOnly: true,
  help: 'Read-only on HV models until the register map is confirmed in the Modbus console.',
  note: `UNVERIFIED on HV: ${s.note ?? ''}`,
}));

export const hybrid3: DeyeFamily = {
  id: 'hybrid3',
  name: 'three-phase LV hybrid',
  liveMap: THREE_LIVE,
  derive: deriveThree,
  settings: THREE_SETTINGS,
  // The grid-charge enable register is UNVERIFIED on three-phase, so automations get no lever.
  socControl: null,
};

export const hybrid3hv: DeyeFamily = {
  id: 'hybrid3hv',
  name: 'three-phase HV hybrid',
  liveMap: THREE_HV_LIVE,
  derive: deriveThree,
  settings: THREE_HV_SETTINGS,
  socControl: null,
};
