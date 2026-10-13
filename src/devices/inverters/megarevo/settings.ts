/**
 * Megarevo / INVT settings. Shown read-only: the addresses come from the vendors' protocol documents
 * but none has been checked on a real unit, and the driver refuses every write.
 *
 * Megarevo parameter block 0x3400–0x3468 and time-of-use block 0x3504–0x350F (holding, read with
 * function 3; the document lists 0x03/0x06 for these). Source: Megarevo "Hybrid Inverter Modbus
 * Protocol" spreadsheet (V01), sheet "Data". The document says the same block covers low-voltage
 * single-phase, high-voltage single-phase, three-phase and 8 kW low-voltage single-phase units.
 */
import { setting, type DeyeSetting } from '../deye/settings.ts';

export const WORK_MODES = ['Self consumption', 'Peak shift', 'Battery priority'];
export const BATTERY_TYPES = ['DC source', 'Lead-acid', 'Lithium'];

const RO = 'Read-only: the Megarevo driver does not write settings until the map is checked on hardware.';

function pct(section: string, label: string, reg: number, note: string, min = 0, max = 100): DeyeSetting {
  return setting(section, label, {
    type: 'number', reg, codec: { kind: 'number' }, unit: '%', min, max, step: 1, readOnly: true, help: RO,
    note: `UNVERIFIED: holding 0x${reg.toString(16).toUpperCase()} ${note}`,
  });
}

function hhmm(n: number, kind: 'Charge' | 'Discharge', edge: 'start' | 'end', reg: number): DeyeSetting {
  return setting('Time of use', `${kind} time ${n} ${edge}`, {
    type: 'time', reg, codec: { kind: 'hhmm' }, readOnly: true, help: RO,
    note: `UNVERIFIED: holding 0x${reg.toString(16).toUpperCase()} HHMM decimal [0, 2359]`,
  });
}

/** Time-of-use windows: 3 charge + 3 discharge, each start/end, from 0x3504. */
function touSettings(): DeyeSetting[] {
  const out: DeyeSetting[] = [];
  for (let n = 1; n <= 3; n++) {
    const base = 0x3504 + (n - 1) * 4;
    out.push(
      hhmm(n, 'Charge', 'start', base),
      hhmm(n, 'Charge', 'end', base + 1),
      hhmm(n, 'Discharge', 'start', base + 2),
      hhmm(n, 'Discharge', 'end', base + 3),
    );
  }
  return out;
}

export const MEGAREVO_SETTINGS: DeyeSetting[] = [
  setting('Work mode', 'Work mode', {
    type: 'select', reg: 0x3400, codec: { kind: 'enum' }, options: WORK_MODES, readOnly: true, help: RO,
    note: 'UNVERIFIED (vendor doc + ha-solarman agree): holding 0x3400 0 self consume / 1 peak shift / 2 battery priority',
  }),
  setting('Work mode', 'Time of use', {
    type: 'checkbox', reg: 0x3445, codec: { kind: 'bit', mask: 1 << 4 }, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3445 (grid function word 2) bit 4 TOU enable',
  }),
  setting('Work mode', 'Charge from solar only', {
    type: 'checkbox', reg: 0x3445, codec: { kind: 'bit', mask: 1 << 7 }, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3445 bit 7',
  }),
  setting('Work mode', 'Peak shave grid power', {
    type: 'number', reg: 0x3438, codec: { kind: 'number' }, unit: 'W', min: 0, max: 8000, step: 10, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3438 W [0, 8000]',
  }),
  setting('Grid', 'Zero export', {
    type: 'checkbox', reg: 0x340d, codec: { kind: 'bool' }, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x340D anti-reflux 0/1',
  }),
  pct('Grid', 'Grid power limit', 0x3403, 'grid (export) power % [0, 100]'),
  setting('Grid', 'Grid charge', {
    type: 'checkbox', reg: 0x3445, codec: { kind: 'bit', mask: 1 << 2 }, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3445 bit 2 grid charge enable',
  }),
  pct('Grid', 'Grid charge power', 0x3428, 'grid charge power % [0, 100]'),
  setting('Grid', 'Backup output', {
    type: 'checkbox', reg: 0x3415, codec: { kind: 'bool' }, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3415 EPS/backup enable 0/1',
  }),
  setting('Battery', 'Battery type', {
    type: 'select', reg: 0x340f, codec: { kind: 'enum' }, options: BATTERY_TYPES, readOnly: true, help: RO,
    note: 'UNVERIFIED (vendor doc + ha-solarman agree): holding 0x340F 0 DC source / 1 lead-acid / 2 lithium',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0x3402, codec: { kind: 'number' }, unit: 'A', min: 1, max: 190, step: 1, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3402 A (range depends on model: 95 LV single, 50 three-phase, 190 8 kW)',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 0x3464, codec: { kind: 'number' }, unit: 'A', min: 1, max: 190, step: 1, readOnly: true, help: RO,
    note: 'UNVERIFIED: holding 0x3464 A [1, 190]',
  }),
  pct('Battery', 'Battery discharge power', 0x3404, 'battery discharge power % [0, 100]'),
  pct('Battery', 'On-grid depth of discharge', 0x3401, 'on-grid DOD % [10, 90]', 10, 90),
  pct('Battery', 'Off-grid depth of discharge', 0x341e, 'off-grid DOD % [10, 90]', 10, 90),
  pct('Battery', 'Charge SOC', 0x3465, 'charge target SOC % [0, 100]'),
  ...touSettings(),
];

/** INVT XD: only the active-power limit is documented as a simple setting. */
export const INVT_SETTINGS: DeyeSetting[] = [
  setting('Grid', 'Active power limit', {
    type: 'number', reg: 0x3019, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1, readOnly: true,
    help: 'Read-only: the INVT map has not been checked on hardware.',
    note: 'UNVERIFIED (INVT protocol V1.38 + ha-solarman agree): holding 0x3019 0.1 %',
  }),
];
