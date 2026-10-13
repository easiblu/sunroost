/**
 * Sungrow settings (holding registers, function 3). Addresses are WIRE addresses (documented
 * number − 1). The driver is read-only: these are decoded and shown, never written.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { ModelId, RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'enum'; values: number[] }
  | { kind: 'number'; scale?: number }
  | { kind: 'bool'; on: number; off: number };

export interface SungrowSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SungrowSetting, 'key' | 'label' | 'section' | 'readOnly'>): SungrowSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

/** Sungrow's "enable / disable" pair used by many switches. */
const AA55 = { kind: 'bool', on: 0xaa, off: 0x55 } as const;

export const HYBRID_SETTINGS: SungrowSetting[] = [
  setting('Work mode', 'EMS mode', {
    type: 'select', reg: 13049, codec: { kind: 'enum', values: [0, 2, 3] },
    options: ['Self-consumption', 'Forced mode', 'External EMS'],
    note: 'doc 13050 EMS mode 0 self-consumption / 2 forced / 3 external EMS (medium)',
  }),
  setting('Work mode', 'Forced charge/discharge command', {
    type: 'select', reg: 13050, codec: { kind: 'enum', values: [0xaa, 0xbb, 0xcc] },
    options: ['Charge', 'Discharge', 'Stop'],
    help: 'Only used in forced mode.',
    note: 'doc 13051 0xAA charge / 0xBB discharge / 0xCC stop (medium)',
  }),
  setting('Work mode', 'Forced charge/discharge power', {
    type: 'number', reg: 13051, codec: { kind: 'number' }, unit: 'W', min: 0, max: 15000, step: 100,
    note: 'doc 13052 forced charge/discharge power W (medium)',
  }),
  setting('Battery', 'Max battery SOC', {
    type: 'number', reg: 13057, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 50, max: 100, step: 1,
    note: 'doc 13058 max SOC 0.1 % (medium)',
  }),
  setting('Battery', 'Min battery SOC', {
    type: 'number', reg: 13058, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 50, step: 1,
    note: 'doc 13059 min SOC 0.1 % (medium)',
  }),
  setting('Battery', 'Backup reserve SOC', {
    type: 'number', reg: 13099, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: doc 13100 reserved SOC for backup %',
  }),
  setting('Grid', 'Export power limit', {
    type: 'number', reg: 13073, codec: { kind: 'number' }, unit: 'W', min: 0, max: 30000, step: 100,
    note: 'UNVERIFIED: doc 13074 export power limit W',
  }),
  setting('Grid', 'Export power limitation', {
    type: 'checkbox', reg: 13086, codec: AA55,
    note: 'UNVERIFIED: doc 13087 export limitation 0xAA on / 0x55 off',
  }),
  setting('Grid', 'Backup mode', {
    type: 'checkbox', reg: 13074, codec: AA55,
    note: 'UNVERIFIED: doc 13075 backup (EPS) mode 0xAA on / 0x55 off',
  }),
];

export const GRID_SETTINGS: SungrowSetting[] = [
  setting('Inverter', 'Inverter on', {
    type: 'checkbox', reg: 5005, codec: { kind: 'bool', on: 0xcf, off: 0xce },
    note: 'UNVERIFIED: doc 5006 start/stop 0xCF start / 0xCE stop',
  }),
  setting('Grid', 'Power limitation', {
    type: 'checkbox', reg: 5006, codec: AA55,
    note: 'UNVERIFIED: doc 5007 power limitation switch 0xAA on / 0x55 off',
  }),
  setting('Grid', 'Power limitation setting', {
    type: 'number', reg: 5007, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 110, step: 1,
    note: 'UNVERIFIED: doc 5008 power limitation 0.1 % of nominal',
  }),
];

export function settingsFor(model: ModelId): SungrowSetting[] {
  return model === 'grid' ? GRID_SETTINGS : HYBRID_SETTINGS;
}

/** Holding spans read for settings, per model. Each is read on its own so one failure doesn't hide the rest. */
export function settingSpans(model: ModelId): [number, number][] {
  return model === 'grid' ? [[5005, 3]] : [[13049, 10], [13073, 2], [13086, 1], [13099, 1]];
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

/** Register image → setting values; settings whose register is missing are left out. */
export function decodeSettings(defs: SungrowSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    switch (c.kind) {
      case 'enum': {
        const i = c.values.indexOf(raw);
        out[def.key] = i >= 0 && def.options ? def.options[i] : `Unknown (${raw})`;
        break;
      }
      case 'number':
        out[def.key] = round2(raw * (c.scale ?? 1));
        break;
      case 'bool':
        out[def.key] = raw === c.on ? true : raw === c.off ? false : `Unknown (${raw})`;
        break;
    }
  }
  return out;
}
