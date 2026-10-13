/**
 * Sigenergy settings: holding registers on the plant (unit 247) from 40029. The driver is
 * read-only; these are decoded and shown, never written. Every row is UNVERIFIED unless noted.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'enum' }
  | { kind: 'bool' }
  /** 32-bit unsigned, high word first, × scale. */
  | { kind: 'u32'; scale: number }
  | { kind: 'u16'; scale: number };

export interface SigenSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Settings span: holding 40029–40048 on unit 247. */
export const SETTING_SPAN: [number, number] = [40029, 20];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SigenSetting, 'key' | 'label' | 'section' | 'readOnly'>): SigenSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const REMOTE_EMS_MODES = [
  'PCS remote control', 'Standby', 'Max self consumption', 'Command charging (grid first)',
  'Command charging (PV first)', 'Command discharging (PV first)', 'Command discharging (ESS first)',
];

const kw = { type: 'number' as const, unit: 'kW', min: 0, max: 100, step: 0.1 };
const pct = { type: 'number' as const, unit: '%', min: 0, max: 100, step: 1 };

export const SIGEN_SETTINGS: SigenSetting[] = [
  setting('Work mode', 'Remote EMS', {
    type: 'checkbox', reg: 40029, codec: { kind: 'bool' },
    help: 'When on, an external controller (Modbus) drives the plant instead of the app EMS mode.',
    note: 'medium: holding 40029 remote EMS enable 0/1',
  }),
  setting('Work mode', 'Independent phase power control', {
    type: 'checkbox', reg: 40030, codec: { kind: 'bool' },
    note: 'UNVERIFIED: holding 40030 0/1 (three-phase only)',
  }),
  setting('Work mode', 'Remote EMS control mode', {
    type: 'select', reg: 40031, codec: { kind: 'enum' }, options: REMOTE_EMS_MODES,
    note: 'medium: holding 40031 0..6',
  }),
  setting('Battery', 'Max charge power', {
    ...kw, reg: 40032, codec: { kind: 'u32', scale: 0.001 },
    note: 'UNVERIFIED: holding 40032 u32 ESS max charging limit, kW gain 1000',
  }),
  setting('Battery', 'Max discharge power', {
    ...kw, reg: 40034, codec: { kind: 'u32', scale: 0.001 },
    note: 'UNVERIFIED: holding 40034 u32 ESS max discharging limit, kW gain 1000',
  }),
  setting('Grid', 'PV max power limit', {
    ...kw, reg: 40036, codec: { kind: 'u32', scale: 0.001 },
    note: 'UNVERIFIED: holding 40036 u32, kW gain 1000',
  }),
  setting('Grid', 'Max export power', {
    ...kw, reg: 40038, codec: { kind: 'u32', scale: 0.001 },
    note: 'UNVERIFIED: holding 40038 u32 grid point max export limitation, kW gain 1000',
  }),
  setting('Grid', 'Max import power', {
    ...kw, reg: 40040, codec: { kind: 'u32', scale: 0.001 },
    note: 'UNVERIFIED: holding 40040 u32 grid point max import limitation, kW gain 1000',
  }),
  setting('Battery', 'Backup SOC', {
    ...pct, reg: 40046, codec: { kind: 'u16', scale: 0.1 },
    note: 'UNVERIFIED: holding 40046 ESS backup SOC 0.1 % (V2.x)',
  }),
  setting('Battery', 'Charge cut-off SOC', {
    ...pct, reg: 40047, codec: { kind: 'u16', scale: 0.1 },
    note: 'UNVERIFIED: holding 40047 ESS charge cut-off SOC 0.1 % (V2.x)',
  }),
  setting('Battery', 'Discharge cut-off SOC', {
    ...pct, reg: 40048, codec: { kind: 'u16', scale: 0.1 },
    note: 'UNVERIFIED: holding 40048 ESS discharge cut-off SOC 0.1 % (V2.x)',
  }),
];

function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}

/** Register image → setting values; settings whose registers are missing are left out. */
export function decodeSettings(defs: SigenSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    switch (c.kind) {
      case 'enum':
        out[def.key] = def.options?.[raw] ?? `Unknown (${raw})`;
        break;
      case 'bool':
        out[def.key] = raw !== 0;
        break;
      case 'u16':
        out[def.key] = round3(raw * c.scale);
        break;
      case 'u32': {
        const lo = regs.get(def.reg + 1);
        if (lo === undefined) break;
        const v = raw * 0x10000 + lo;
        // 0xFFFFFFFF / 0xFFFFFFFE mean "no limit" in Sigenergy's convention (UNVERIFIED).
        if (v >= 0xfffffffe) out[def.key] = null;
        else out[def.key] = round3(v * c.scale);
        break;
      }
    }
  }
  return out;
}
