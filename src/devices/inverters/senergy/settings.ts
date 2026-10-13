/**
 * Senergy hybrid settings (holding registers at 0x2100.., function 3). The driver is read-only:
 * these are decoded and shown, never written.
 *
 * Sources: the evcc `senergy-hybrid` template (work mode, time-of-use window and enable, which it
 * writes) and a community Duracell Dura-i Home Assistant integration (power / SOC limits, read only).
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'enum'; values: number[] }
  | { kind: 'number'; scale?: number }
  | { kind: 'bool' }
  /** hi byte = hour, lo byte = minute (0x173B = 23:59). */
  | { kind: 'time' };

export interface SenergySetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Span read for settings: 0x2100–0x2150. */
export const SETTING_SPANS: [number, number][] = [[0x2100, 0x51]];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SenergySetting, 'key' | 'label' | 'section' | 'readOnly'>): SenergySetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

const W = { type: 'number' as const, codec: { kind: 'number' as const }, unit: 'W', min: 0, max: 20000, step: 100 };
const SOC = { type: 'number' as const, codec: { kind: 'number' as const }, unit: '%', min: 0, max: 100, step: 1 };

export const SENERGY_SETTINGS: SenergySetting[] = [
  // Work mode
  setting('Work mode', 'Work mode', {
    type: 'select', reg: 0x2100, codec: { kind: 'enum', values: [0, 1, 2, 3] },
    options: ['Self use', 'Mode 1', 'Mode 2', 'Back-up'],
    help: 'Codes 1 and 2 are not documented publicly.',
    note: 'confident: 0x2100 hybrid work mode, 0 self use / 3 back-up (evcc); 1, 2 UNVERIFIED',
  }),
  setting('Work mode', 'Time of use', {
    type: 'checkbox', reg: 0x214c, codec: { kind: 'bool' },
    note: 'confident: 0x214C time-based control enable 0/1 (evcc)',
  }),
  setting('Work mode', 'Time of use repeat', {
    type: 'select', reg: 0x2101, codec: { kind: 'enum', values: [0, 1] }, options: ['Once', 'Every day'],
    note: 'confident: 0x2101 once / every day for window 1 (evcc)',
  }),
  setting('Work mode', 'Charge start time 1', {
    type: 'time', reg: 0x2102, codec: { kind: 'time' },
    note: 'confident: 0x2102 hi = hour, lo = minute (evcc)',
  }),
  setting('Work mode', 'Charge end time 1', {
    type: 'time', reg: 0x2103, codec: { kind: 'time' },
    note: 'confident: 0x2103 hi = hour, lo = minute (evcc)',
  }),
  // Battery
  setting('Battery', 'Max grid charge power', { ...W, reg: 0x2116, note: 'UNVERIFIED: 0x2116 grid charge power limit W (Dura-i integration)' }),
  setting('Battery', 'Max charge power', { ...W, reg: 0x2118, note: 'UNVERIFIED: 0x2118 W (Dura-i integration)' }),
  setting('Battery', 'Charge end SOC', { ...SOC, reg: 0x2119, note: 'UNVERIFIED: 0x2119 % (Dura-i integration)' }),
  setting('Battery', 'Max discharge power', { ...W, reg: 0x211a, note: 'UNVERIFIED: 0x211A W (Dura-i integration)' }),
  setting('Battery', 'Discharge end SOC', { ...SOC, reg: 0x211b, note: 'UNVERIFIED: 0x211B off-grid discharge cut-off % (Dura-i integration)' }),
  setting('Battery', 'Discharge end SOC on grid', { ...SOC, reg: 0x214a, note: 'UNVERIFIED: 0x214A % (Dura-i integration)' }),
  setting('Battery', 'Force charge start SOC', { ...SOC, reg: 0x2144, note: 'UNVERIFIED: 0x2144 % (Dura-i integration)' }),
  setting('Battery', 'Force charge stop SOC', { ...SOC, reg: 0x2145, note: 'UNVERIFIED: 0x2145 % (Dura-i integration)' }),
  // Grid
  setting('Grid', 'Max grid input power', { ...W, reg: 0x2125, note: 'UNVERIFIED: 0x2125 W (Dura-i integration)' }),
  setting('Grid', 'Max grid force charge power', { ...W, reg: 0x2150, note: 'UNVERIFIED: 0x2150 W (Dura-i integration)' }),
];

/** Register image → setting values; settings whose register is missing are left out. */
export function decodeSettings(defs: SenergySetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    switch (c.kind) {
      case 'enum': {
        const i = c.values.indexOf(raw);
        out[def.key] = i >= 0 ? (def.options?.[i] ?? `Unknown (${raw})`) : `Unknown (${raw})`;
        break;
      }
      case 'number':
        out[def.key] = Math.round(raw * (c.scale ?? 1) * 100) / 100;
        break;
      case 'bool':
        out[def.key] = raw !== 0;
        break;
      case 'time': {
        const h = raw >> 8;
        const m = raw & 0xff;
        if (h < 24 && m < 60) out[def.key] = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        break;
      }
    }
  }
  return out;
}
