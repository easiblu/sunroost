/**
 * GoodWe ET-family settings (holding registers, function 3). The driver is read-only: these are
 * decoded and shown, never written. Addresses from GoodWe's public ET/EH Modbus register list as
 * documented by open-source GoodWe tools; each note says "confident" or "UNVERIFIED".
 *
 * The legacy ES family (AA55 protocol) exposes settings through separate AA55 commands that are
 * not implemented, so ES models show no settings.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'number'; scale?: number }
  | { kind: 'enum'; values: Record<number, string> }
  | { kind: 'bool' };

export interface GoodweSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

const snakeKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function setting(section: string, label: string, reg: number, codec: Codec, note: string, extra: Partial<SettingDef> = {}): GoodweSetting {
  const type = codec.kind === 'bool' ? 'checkbox' : codec.kind === 'enum' ? 'select' : 'number';
  const options = codec.kind === 'enum' ? Object.values(codec.values) : undefined;
  return { key: snakeKey(label), label, section, type, ...(options ? { options } : {}), readOnly: true, reg, codec, note, ...extra };
}

/** 47000 work mode (UNVERIFIED beyond 0–3). */
export const WORK_MODE_SETTING: Record<number, string> = {
  0: 'General',
  1: 'Off-grid',
  2: 'Backup',
  3: 'Eco',
  4: 'Peak shaving',
  5: 'Self-use',
};

const pct = { unit: '%', min: 0, max: 100, step: 1 };

export const SETTINGS: GoodweSetting[] = [
  setting('Work mode', 'Work mode', 47000, { kind: 'enum', values: WORK_MODE_SETTING }, '47000 operation mode (0–3 medium, 4–5 UNVERIFIED)'),
  setting('Battery', 'Battery capacity', 45350, { kind: 'number' }, '45350 battery capacity Ah (UNVERIFIED)', { unit: 'Ah', min: 0, max: 2000, step: 1 }),
  setting('Battery', 'Battery charge voltage', 45352, { kind: 'number', scale: 0.1 }, '45352 charge voltage 0.1 V (UNVERIFIED)', { unit: 'V', min: 0, max: 600, step: 0.1 }),
  setting('Battery', 'Max charge current', 45353, { kind: 'number', scale: 0.1 }, '45353 charge current limit 0.1 A (UNVERIFIED)', { unit: 'A', min: 0, max: 100, step: 0.1 }),
  setting('Battery', 'Battery discharge voltage', 45354, { kind: 'number', scale: 0.1 }, '45354 discharge cut-off voltage 0.1 V (UNVERIFIED)', { unit: 'V', min: 0, max: 600, step: 0.1 }),
  setting('Battery', 'Max discharge current', 45355, { kind: 'number', scale: 0.1 }, '45355 discharge current limit 0.1 A (UNVERIFIED)', { unit: 'A', min: 0, max: 100, step: 0.1 }),
  setting('Battery', 'Depth of discharge (on-grid)', 45356, { kind: 'number' }, '45356 on-grid DoD % (medium)', pct),
  setting('Battery', 'Depth of discharge (off-grid)', 45358, { kind: 'number' }, '45358 off-grid DoD % (medium)', pct),
  setting('Grid', 'Backup supply', 45252, { kind: 'bool' }, '45252 back-up output enable (UNVERIFIED)'),
  setting('Grid', 'Export limit enabled', 47509, { kind: 'bool' }, '47509 grid export limit enable (medium)'),
  setting('Grid', 'Export limit', 47510, { kind: 'number' }, '47510 grid export limit W (medium)', { unit: 'W', min: 0, max: 30000, step: 10 }),
];

/** Spans read for settings. */
export const SETTING_SPANS: [number, number][] = [
  [45252, 1],
  [45350, 9],
  [47000, 1],
  [47509, 2],
];

export function decodeSettings(defs: GoodweSetting[], regs: RegisterImage): SettingValues {
  const out: SettingValues = {};
  for (const d of defs) {
    const raw = regs.get(d.reg);
    if (raw === undefined) continue;
    let v: Value;
    if (d.codec.kind === 'bool') v = raw !== 0;
    else if (d.codec.kind === 'enum') v = d.codec.values[raw] ?? null;
    else v = d.codec.scale ? Math.round(raw * d.codec.scale * 1000) / 1000 : raw;
    if (v !== null) out[d.key] = v;
  }
  return out;
}
