/**
 * Huawei SUN2000 / LUNA2000 settings (holding registers 47xxx, function 3). The driver is
 * read-only: these are decoded and shown, never written.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import { rawValue, type RegisterImage, type RegType } from './registers.ts';

export type Codec =
  /** Option i ↔ raw `values[i]` (or i itself). */
  | { kind: 'enum'; values?: number[] }
  | { kind: 'number'; type?: RegType; scale?: number }
  | { kind: 'bool' };

export interface HuaweiSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Spans read for settings; each is read on its own and skipped if the unit rejects it. */
export const SETTING_SPANS: [number, number][] = [
  [47000, 1],
  [47075, 15],
  [47102, 1],
  [47242, 2],
  [47415, 5],
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<HuaweiSetting, 'key' | 'label' | 'section' | 'readOnly'>): HuaweiSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const WORKING_MODES = [
  'Adaptive', 'Fixed charge/discharge', 'Maximise self consumption', 'Time of use (LG)', 'Fully fed to grid',
  'Time of use (LUNA2000)',
];

export const HUAWEI_SETTINGS: HuaweiSetting[] = [
  setting('Battery', 'Battery product model', {
    type: 'select', reg: 47000, codec: { kind: 'enum' }, options: ['None', 'LG RESU', 'Huawei LUNA2000'],
    note: 'medium: 47000 storage unit 1 product model 0 none / 1 LG-RESU / 2 LUNA2000',
  }),
  setting('Work mode', 'Storage working mode', {
    type: 'select', reg: 47086, codec: { kind: 'enum' }, options: WORKING_MODES,
    note: 'medium: 47086 storage working mode settings 0..5',
  }),
  setting('Battery', 'Max charge power', {
    type: 'number', reg: 47075, codec: { kind: 'number', type: 'u32' }, unit: 'W', min: 0, max: 30000, step: 1,
    note: 'medium: 47075 maximum charging power u32 W',
  }),
  setting('Battery', 'Max discharge power', {
    type: 'number', reg: 47077, codec: { kind: 'number', type: 'u32' }, unit: 'W', min: 0, max: 30000, step: 1,
    note: 'medium: 47077 maximum discharging power u32 W',
  }),
  setting('Battery', 'Charge cutoff state of charge', {
    type: 'number', reg: 47081, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 90, max: 100, step: 0.1,
    note: 'medium: 47081 charging cutoff capacity 0.1 %',
  }),
  setting('Battery', 'Discharge cutoff state of charge', {
    type: 'number', reg: 47082, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 20, step: 0.1,
    note: 'medium: 47082 discharge cutoff capacity 0.1 %',
  }),
  setting('Grid', 'Charge from grid', {
    type: 'checkbox', reg: 47087, codec: { kind: 'bool' },
    note: 'medium: 47087 charge from grid function 0 off / 1 on',
  }),
  setting('Grid', 'Grid charge cutoff state of charge', {
    type: 'number', reg: 47088, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 20, max: 100, step: 0.1,
    note: 'medium: 47088 grid charge cutoff SOC 0.1 %',
  }),
  setting('Battery', 'Backup power state of charge', {
    type: 'number', reg: 47102, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: 47102 backup power SOC 0.1 %',
  }),
  setting('Grid', 'Max grid charge power', {
    type: 'number', reg: 47242, codec: { kind: 'number', type: 'u32' }, unit: 'W', min: 0, max: 50000, step: 1,
    note: 'UNVERIFIED: 47242 maximum power for charging from grid u32 W',
  }),
  setting('Grid', 'Active power control mode', {
    type: 'select', reg: 47415, codec: { kind: 'enum', values: [0, 1, 5, 6, 7] },
    options: ['Unlimited', 'DI active scheduling', 'Zero power grid connection', 'Limited feed-in (W)', 'Limited feed-in (%)'],
    note: 'UNVERIFIED: 47415 0 unlimited / 1 DI / 5 zero export / 6 limit W / 7 limit %',
  }),
  setting('Grid', 'Max grid feed-in power', {
    type: 'number', reg: 47416, codec: { kind: 'number', type: 'i32' }, unit: 'W', min: 0, max: 100000, step: 1,
    note: 'UNVERIFIED: 47416 maximum grid feed-in power i32 W',
  }),
  setting('Grid', 'Max grid feed-in power percentage', {
    type: 'number', reg: 47418, codec: { kind: 'number', type: 'i16', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: 47418 maximum grid feed-in power i16 0.1 %',
  }),
];

/** Register image → setting values; settings whose registers are missing are left out. */
export function decodeSettings(defs: HuaweiSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const c = def.codec;
    const raw = rawValue({ addr: def.reg, type: c.kind === 'number' ? c.type : 'u16', metric: def.key }, regs);
    if (typeof raw !== 'number') continue;
    switch (c.kind) {
      case 'enum': {
        const i = c.values ? c.values.indexOf(raw) : raw;
        out[def.key] = def.options?.[i] ?? `Unknown (${raw})`;
        break;
      }
      case 'number':
        out[def.key] = Math.round(raw * (c.scale ?? 1) * 100) / 100;
        break;
      case 'bool':
        out[def.key] = raw !== 0;
        break;
    }
  }
  return out;
}
