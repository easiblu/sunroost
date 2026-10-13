/**
 * Solax settings (holding registers, function 3, from 0x001F). The driver is read-only: these are
 * decoded and shown, never written. Addresses follow the X1/X3-G4 protocol; G3 and X1 Lite LV units
 * may differ (UNVERIFIED).
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec = { kind: 'enum' } | { kind: 'number'; scale?: number };

export interface SolaxSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** One read covers every setting: 0x001F–0x0066. */
export const SETTING_SPAN: [number, number] = [0x001f, 0x48];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SolaxSetting, 'key' | 'label' | 'section' | 'readOnly'>): SolaxSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const SOLAX_SETTINGS: SolaxSetting[] = [
  setting('Work mode', 'Work mode', {
    type: 'select', reg: 0x001f, codec: { kind: 'enum' },
    options: ['Self use', 'Feed-in priority', 'Back up', 'Manual'],
    help: 'Solax "charger use mode".',
    note: 'medium: 0x001F charger use mode 0 self use / 1 feed-in priority / 2 back up / 3 manual (G4)',
  }),
  setting('Work mode', 'Manual mode', {
    type: 'select', reg: 0x0020, codec: { kind: 'enum' },
    options: ['Stop charge and discharge', 'Force charge', 'Force discharge'],
    note: 'UNVERIFIED: 0x0020 manual mode (G4)',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0x0024, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: 0x0024 battery charge max current 0.1 A',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 0x0025, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 100, step: 0.1,
    note: 'UNVERIFIED: 0x0025 battery discharge max current 0.1 A',
  }),
  setting('Grid', 'Export limit', {
    type: 'number', reg: 0x0042, codec: { kind: 'number' }, unit: 'W', min: 0, max: 30000, step: 100,
    note: 'UNVERIFIED: 0x0042 export control user limit W (some firmware ×10)',
  }),
  setting('Battery', 'Self use minimum SOC', {
    type: 'number', reg: 0x0061, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1,
    note: 'UNVERIFIED: 0x0061 self-use discharge min SOC % (G4)',
  }),
  setting('Battery', 'Feed-in minimum SOC', {
    type: 'number', reg: 0x0065, codec: { kind: 'number' }, unit: '%', min: 10, max: 100, step: 1,
    note: 'UNVERIFIED: 0x0065 feed-in priority discharge min SOC % (G4)',
  }),
];

/** Register image → setting values; settings whose register is missing are left out. */
export function decodeSettings(defs: SolaxSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    if (def.codec.kind === 'enum') out[def.key] = def.options?.[raw] ?? `Unknown (${raw})`;
    else out[def.key] = Math.round(raw * (def.codec.scale ?? 1) * 100) / 100;
  }
  return out;
}
