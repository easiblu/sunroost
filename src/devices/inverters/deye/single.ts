/**
 * Deye / Sunsynk single-phase families (holding registers, function 3):
 *   hybrid — single-phase LV hybrid, 3.6–16 kW (Deye SUN-xK-SG0xLP1, Sunsynk 3.6–16K, Sol-Ark 12K/15K
 *            split-phase, Turbo Energy …). The most common unit; mapped in depth.
 *   string — single-phase grid-tie string inverter (SUN-xK-G), no battery. Mostly UNVERIFIED.
 *
 * Source: the widely published Deye/Sunsynk "single phase" Modbus map (as used by the kellerza/sunsynk
 * and ha-solarman integrations). Rows not cross-checked against at least one of those say UNVERIFIED.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import type { DeyeFamily } from './family.ts';
import { decodeFaults, has, num, type RegDef } from './registers.ts';
import {
  BATTERY_MODES, ENERGY_PATTERNS, setting, touSettings, WORK_MODES, type DeyeSetting,
} from './settings.ts';

/** Run state (59 single-phase, 500 three-phase) → Device mode. */
export const RUN_STATE: Record<number, string> = {
  0: 'Standby', 1: 'Self-check', 2: 'Normal', 3: 'Alarm', 4: 'Fault', 5: 'Activating',
};

const TEMP = { offset: 1000, scale: 0.1 } as const;

export const SINGLE_LIVE: RegDef[] = [
  { addr: 59, metric: 'Run state', enum: RUN_STATE, note: 'overall state (confident; 5 UNVERIFIED)' },
  { addr: 79, scale: 0.01, metric: 'Grid frequency', note: 'grid frequency 0.01 Hz (confident)' },
  { addr: 90, ...TEMP, metric: 'Temperature DC', note: 'DC transformer temperature, 0.1 °C +1000 (confident)' },
  { addr: 91, ...TEMP, metric: 'Temperature AC', note: 'AC heat sink temperature, 0.1 °C +1000 (confident)' },
  { addr: 103, metric: 'Fault word 1', note: 'fault bits F01–F16 (confident)' },
  { addr: 104, metric: 'Fault word 2', note: 'fault bits F17–F32' },
  { addr: 105, metric: 'Fault word 3', note: 'fault bits F33–F48' },
  { addr: 106, metric: 'Fault word 4', note: 'fault bits F49–F64' },
  { addr: 109, scale: 0.1, metric: 'PV voltage 1', note: 'confident' },
  { addr: 110, scale: 0.1, metric: 'PV current 1', note: 'confident' },
  { addr: 111, scale: 0.1, metric: 'PV voltage 2', note: 'confident' },
  { addr: 112, scale: 0.1, metric: 'PV current 2', note: 'confident' },
  { addr: 113, scale: 0.1, metric: 'PV voltage 3', note: 'medium (12–16 kW units)' },
  { addr: 114, scale: 0.1, metric: 'PV current 3', note: 'medium' },
  { addr: 115, scale: 0.1, metric: 'PV voltage 4', note: 'UNVERIFIED' },
  { addr: 116, scale: 0.1, metric: 'PV current 4', note: 'UNVERIFIED' },
  { addr: 150, scale: 0.1, metric: 'Grid voltage', note: 'grid voltage L-N 0.1 V (confident)' },
  { addr: 154, scale: 0.1, metric: 'Inverter voltage', note: 'inverter output voltage 0.1 V (confident)' },
  { addr: 157, scale: 0.1, metric: 'Load voltage', note: 'medium' },
  { addr: 160, type: 's16', scale: 0.01, metric: 'Grid current', note: 'medium' },
  { addr: 166, type: 's16', metric: 'Gen port power', note: 'GEN/AUX port power W (medium)' },
  { addr: 167, type: 's16', metric: 'Grid power LD', note: 'grid-side internal (inverter) power W, +import (confident)' },
  { addr: 169, type: 's16', metric: 'Grid power total', note: 'grid power W, +import (confident)' },
  { addr: 172, type: 's16', metric: 'Grid power CT', note: 'external CT power W, +import (confident)' },
  { addr: 175, type: 's16', metric: 'Inverter power', note: 'confident' },
  { addr: 176, type: 's16', metric: 'Load power L1', note: 'UNVERIFIED: split-phase L1 load' },
  { addr: 177, type: 's16', metric: 'Load power L2', note: 'UNVERIFIED: split-phase L2 load' },
  { addr: 178, type: 's16', metric: 'Load power total', note: 'essential (backup) load W (confident)' },
  { addr: 182, ...TEMP, metric: 'Battery temperature', note: 'confident' },
  { addr: 183, scale: 0.01, metric: 'Battery voltage', note: '0.01 V (confident)' },
  { addr: 184, metric: 'Battery state of charge', note: 'confident' },
  { addr: 186, metric: 'PV power 1', note: 'confident' },
  { addr: 187, metric: 'PV power 2', note: 'confident' },
  { addr: 188, metric: 'PV power 3', note: 'medium' },
  { addr: 189, metric: 'PV power 4', note: 'UNVERIFIED' },
  { addr: 190, type: 's16', metric: 'Battery power raw', note: 'W, + = discharging (confident) — negated' },
  { addr: 191, type: 's16', scale: 0.01, metric: 'Battery current raw', note: '0.01 A, + = discharging (confident) — negated' },
  { addr: 192, scale: 0.01, metric: 'Load frequency', note: 'medium' },
  { addr: 193, scale: 0.01, metric: 'Inverter frequency', note: 'medium' },
];

const COPY = [
  'Grid voltage', 'Grid frequency', 'Grid current', 'Battery voltage', 'Battery state of charge', 'Battery temperature',
  'Temperature DC', 'Temperature AC',
];

/** PV metrics for MPPT 1..4; 3/4 only when that input reports anything (2-MPPT units read 0). */
export function derivePv(raw: Metrics, out: Metrics, computePower = false) {
  let total = 0;
  for (const n of [1, 2, 3, 4]) {
    const v = num(raw, `PV voltage ${n}`);
    const i = num(raw, `PV current ${n}`);
    const p = computePower ? round(v * i, 0) : num(raw, `PV power ${n}`);
    if (n > 2 && !(v > 0 || p > 0)) continue;
    if (!has(raw, `PV voltage ${n}`) && !has(raw, `PV power ${n}`)) continue;
    out[`PV power ${n}`] = p;
    if (has(raw, `PV voltage ${n}`)) out[`PV voltage ${n}`] = v;
    if (has(raw, `PV current ${n}`)) out[`PV current ${n}`] = i;
    total += p;
  }
  out['PV power'] = round(total, 0);
}

/** Device mode / Fault code / heat-sink temperature, shared by every family. */
export function deriveCommon(raw: Metrics, out: Metrics) {
  out['Device mode'] = String(raw['Run state'] ?? 'Unknown');
  const words = [1, 2, 3, 4].map((n) => raw[`Fault word ${n}`]);
  if (words.every((w) => typeof w === 'number')) out['Fault code'] = decodeFaults(words as number[]);
  const temps = ['Temperature DC', 'Temperature AC'].filter((k) => has(raw, k)).map((k) => num(raw, k));
  if (temps.length) out.Temperature = Math.max(...temps);
}

/** Deye reports battery power/current + discharging; Sunroost uses + charging. */
export function deriveBattery(raw: Metrics, out: Metrics) {
  if (has(raw, 'Battery power raw')) out['Battery power'] = -num(raw, 'Battery power raw') || 0;
  if (has(raw, 'Battery current raw')) out['Battery current'] = round(-num(raw, 'Battery current raw'), 2) || 0;
}

export function deriveSingle(raw: Metrics): Metrics {
  const out: Metrics = {};
  deriveCommon(raw, out);
  derivePv(raw, out);
  deriveBattery(raw, out);
  for (const k of COPY) if (has(raw, k)) out[k] = raw[k];
  const ct = num(raw, 'Grid power CT');
  const ld = num(raw, 'Grid power LD');
  out['Grid power'] = num(raw, 'Grid power total');
  out['Grid power CT'] = ct;
  out['Grid power LD'] = ld;
  const load = num(raw, 'Load power total');
  out['Load power'] = load;
  out['Load power essential'] = load;
  // Non-essential loads sit between the CT and the inverter's grid port: CT − LD. Without a CT the
  // CT register reads 0 and this clamps to 0. (Derivation UNVERIFIED.)
  out['Load power non-essential'] = Math.max(0, ct - ld);
  if (has(raw, 'Gen port power')) out['Generator power'] = num(raw, 'Gen port power');
  if (has(raw, 'Inverter voltage')) out['AC output voltage'] = raw['Inverter voltage'];
  const f = has(raw, 'Inverter frequency') ? 'Inverter frequency' : 'Load frequency';
  if (has(raw, f)) out['AC output frequency'] = raw[f];
  return out;
}

export const SINGLE_SETTINGS: DeyeSetting[] = [
  // Work mode
  setting('Work mode', 'System work mode', {
    type: 'select', reg: 244, codec: { kind: 'enum' }, options: WORK_MODES, verified: true,
    note: 'holding 244 limit control: 0 selling first / 1 zero export to load / 2 zero export to CT (confident)',
  }),
  setting('Work mode', 'Solar export', {
    type: 'checkbox', reg: 247, codec: { kind: 'bool' },
    help: 'Sell surplus solar when the battery is full.',
    note: 'UNVERIFIED: holding 247 solar sell 0/1',
  }),
  setting('Work mode', 'Energy pattern', {
    type: 'select', reg: 243, codec: { kind: 'enum' }, options: ENERGY_PATTERNS, verified: true,
    note: 'holding 243 0 battery first / 1 load first (confident)',
  }),
  setting('Work mode', 'Max sell power', {
    type: 'number', reg: 245, codec: { kind: 'number' }, unit: 'W', min: 0, max: 16000, step: 10, verified: true,
    note: 'holding 245 W (confident)',
  }),
  // Battery
  setting('Battery', 'Battery capacity', {
    type: 'number', reg: 204, codec: { kind: 'number' }, unit: 'Ah', min: 0, max: 2000, step: 1,
    note: 'UNVERIFIED (medium): holding 204 Ah',
  }),
  setting('Battery', 'Battery operation', {
    type: 'select', reg: 111, codec: { kind: 'enum' }, options: BATTERY_MODES,
    note: 'UNVERIFIED: holding 111 0 voltage / 1 lithium (SOC) / 2 no battery',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 210, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1, verified: true,
    note: 'holding 210 A (confident; 108 is the three-phase address)',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 211, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1, verified: true,
    note: 'holding 211 A (confident; 109 is the three-phase address)',
  }),
  setting('Battery', 'Battery shutdown SOC', {
    type: 'number', reg: 217, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1, verified: true,
    note: 'holding 217 shutdown capacity % (confident)',
  }),
  setting('Battery', 'Battery restart SOC', {
    type: 'number', reg: 218, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1, verified: true,
    note: 'holding 218 restart capacity % (confident)',
  }),
  setting('Battery', 'Battery low SOC', {
    type: 'number', reg: 219, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1, verified: true,
    note: 'holding 219 low capacity % (confident); 220–222 are the matching voltages (0.01 V)',
  }),
  // Grid
  setting('Grid', 'Grid charge', {
    type: 'checkbox', reg: 232, codec: { kind: 'bool' }, verified: true,
    help: 'Allow charging from the grid in time-of-use points with "Grid charge" ticked.',
    note: 'holding 232 0/1 (medium-high)',
  }),
  setting('Grid', 'Grid charge current', {
    type: 'number', reg: 230, codec: { kind: 'number' }, unit: 'A', min: 0, max: 350, step: 1, verified: true,
    note: 'holding 230 A (medium-high)',
  }),
  setting('Grid', 'Generator charge enabled', {
    type: 'checkbox', codec: { kind: 'bool' },
    note: 'UNVERIFIED: address unknown (somewhere in 225–229); not read',
  }),
  ...touSettings({
    enable: 248, time: 250, power: 256, voltage: 262, soc: 268, charge: 274, maxPower: 16000, verified: true,
    note: 'single-phase TOU block 248–279 (confident)',
  }),
];

export const hybrid: DeyeFamily = {
  id: 'hybrid',
  name: 'single-phase hybrid',
  liveMap: SINGLE_LIVE,
  derive: deriveSingle,
  settings: SINGLE_SETTINGS,
  // Low SOC → enable grid charging: within time-of-use points that have "Grid charge" ticked the
  // inverter then holds/charges the battery to that point's SOC from the grid instead of discharging.
  // This only toggles one boolean and never rewrites the user's program, so it is the safest lever.
  socControl: { setting: 'grid_charge', gridValue: 'true', batteryValue: 'false' },
};

/** Grid-tie string inverter (SUN-xK-G). Everything but 59/109–116 is UNVERIFIED. */
export const STRING_LIVE: RegDef[] = [
  { addr: 59, metric: 'Run state', enum: RUN_STATE, note: 'medium' },
  { addr: 73, scale: 0.1, metric: 'Grid voltage', note: 'UNVERIFIED: grid voltage 0.1 V' },
  { addr: 76, scale: 0.1, metric: 'Grid current', note: 'UNVERIFIED: grid current 0.1 A' },
  { addr: 79, scale: 0.01, metric: 'Grid frequency', note: 'UNVERIFIED' },
  { addr: 86, type: 'u32le', scale: 0.1, metric: 'AC power', note: 'UNVERIFIED: active output power 0.1 W, low word first' },
  { addr: 90, ...TEMP, metric: 'Temperature DC', note: 'UNVERIFIED' },
  { addr: 91, ...TEMP, metric: 'Temperature AC', note: 'UNVERIFIED' },
  { addr: 103, metric: 'Fault word 1', note: 'UNVERIFIED' },
  { addr: 104, metric: 'Fault word 2', note: 'UNVERIFIED' },
  { addr: 105, metric: 'Fault word 3', note: 'UNVERIFIED' },
  { addr: 106, metric: 'Fault word 4', note: 'UNVERIFIED' },
  ...SINGLE_LIVE.filter((d) => d.addr >= 109 && d.addr <= 116),
];

export function deriveString(raw: Metrics): Metrics {
  const out: Metrics = {};
  deriveCommon(raw, out);
  derivePv(raw, out, true);
  for (const k of ['Grid voltage', 'Grid frequency', 'Grid current', 'Temperature DC', 'Temperature AC']) {
    if (has(raw, k)) out[k] = raw[k];
  }
  const ac = round(num(raw, 'AC power'), 0);
  // No meter: everything the inverter produces is reported as export.
  out['Grid power'] = -ac || 0;
  if (has(raw, 'Grid voltage')) out['AC output voltage'] = raw['Grid voltage'];
  if (has(raw, 'Grid frequency')) out['AC output frequency'] = raw['Grid frequency'];
  return out;
}

export const stringInverter: DeyeFamily = {
  id: 'string',
  name: 'string inverter',
  liveMap: STRING_LIVE,
  derive: deriveString,
  settings: [],
  socControl: null,
};
