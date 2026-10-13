/**
 * Afore settings (holding registers, function 3). The driver is read-only: these are decoded and
 * shown, never written.
 *
 * Registers 200–2040 come from Afore's T6 protocol sheet (confident addresses and scaling). The
 * hybrid registers 2500–2516 and 3000 come only from the community ha-solarman "afore_hybrid" map,
 * so they are UNVERIFIED.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  /** Index into `options` (or into `values` when given). */
  | { kind: 'enum'; values?: number[] }
  | { kind: 'number'; scale?: number; words?: 1 | 2; signed?: boolean }
  /** One bit of a 32-bit word (high word at `reg`). */
  | { kind: 'bit'; bit: number }
  | { kind: 'onoff'; on: number; off: number }
  /** High byte hour, low byte minute. */
  | { kind: 'time' };

export interface AforeSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Spans read for settings (each tried separately; on-grid units lack the hybrid ones). */
export const SETTING_SPANS: [number, number][] = [
  [200, 13],
  [1500, 5],
  [2037, 4],
  [2500, 17],
  [3000, 1],
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<AforeSetting, 'key' | 'label' | 'section' | 'readOnly'>): AforeSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

/** Grid code ("country") list at holding 204, by code (vendor table). */
export const COUNTRIES = [
  '50 Hz wide range', '60 Hz wide range', 'China', 'Japan 50 Hz', 'Japan 60 Hz', 'US 240 V single-phase',
  'US 240 V split-phase', 'US 208 V single-phase', 'US 208 V split-phase', 'Australia', 'UK G98', 'UK G99',
  'Germany LV', 'Germany MV (BDEW)', 'France', 'France islands 50 Hz', 'France islands 60 Hz', 'Poland', 'Italy',
  'Thailand ME', 'Thailand PE', 'India', 'South Korea', 'Philippines', 'North Korea', 'Malaysia', 'Cyprus',
  'Netherlands', 'EU EN50549-1 (16 A)', 'Spain', 'Greece', 'Greece islands', 'Portugal', 'Belgium', 'Denmark',
  'Denmark 16 A', 'Czech Republic', 'Slovakia', 'Sweden', 'Austria', 'Bulgaria', 'Romania', 'Ukraine',
  'South Africa', 'Mauritius', 'Israel', 'Mexico', 'Brazil', 'Sri Lanka', 'Chile', 'Mexico CONNERA', 'EU EN50549-1',
];

export const EMS_MODES = [
  'Self use', 'Charging first', 'Export first', 'Battery maintenance', 'Command', 'EMS', 'Time of use',
  'Imbalance compensation', 'Q compensation',
];

const slot = (n: number, edge: 'start' | 'end', reg: number) =>
  setting('Time of use', `Timed charge ${n} ${edge}`, {
    type: 'time', reg, codec: { kind: 'time' }, note: `UNVERIFIED: ${reg} hi = hour, lo = minute`,
  });

export const AFORE_SETTINGS: AforeSetting[] = [
  // Work mode
  setting('Work mode', 'Inverter enabled', {
    type: 'checkbox', reg: 206, codec: { kind: 'bit', bit: 0 }, note: 'confident: 206–207 run-function word, B0 on/off',
  }),
  setting('Work mode', 'Energy management mode', {
    type: 'select', reg: 2500, codec: { kind: 'enum' }, options: EMS_MODES,
    note: 'UNVERIFIED: holding 2500 EMS mode 0–8 (community map)',
  }),
  setting('Work mode', 'Time of use', {
    type: 'checkbox', reg: 206, codec: { kind: 'bit', bit: 4 }, note: 'UNVERIFIED: 206–207 B4 timed charge enable',
  }),
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 3000, codec: { kind: 'enum' }, options: ['No battery', 'Lithium', 'Lead-acid', 'Simulated'],
    note: 'UNVERIFIED: holding 3000 battery control mode 0–3',
  }),
  setting('Battery', 'Battery charge and discharge', {
    type: 'checkbox', reg: 2501, codec: { kind: 'onoff', on: 0xaa, off: 0xbb },
    note: 'UNVERIFIED: holding 2501 0xAA enable / 0xBB disable',
  }),
  setting('Time of use', 'Timed charge power', {
    type: 'number', reg: 2504, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 5,
    note: 'UNVERIFIED: holding 2504 0.1 %',
  }),
  setting('Time of use', 'Timed charge max SOC', {
    type: 'number', reg: 2505, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 5,
    note: 'UNVERIFIED: holding 2505 0.1 %',
  }),
  slot(1, 'start', 2509), slot(1, 'end', 2510),
  slot(2, 'start', 2511), slot(2, 'end', 2512),
  slot(3, 'start', 2513), slot(3, 'end', 2514),
  slot(4, 'start', 2515), slot(4, 'end', 2516),
  // Grid
  setting('Grid', 'Grid code', {
    type: 'select', reg: 204, codec: { kind: 'enum' }, options: COUNTRIES, note: 'confident: holding 204 country code',
  }),
  setting('Grid', 'Meter type', {
    type: 'select', reg: 211, codec: { kind: 'enum' }, options: ['No meter', 'CT', 'Meter'], note: 'confident: holding 211',
  }),
  setting('Grid', 'Active power limit', {
    type: 'number', reg: 1502, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 1,
    note: 'confident: holding 1502 0.1 % (1E-3 of rated)',
  }),
  setting('Grid', 'Max active output power', {
    type: 'number', reg: 1503, codec: { kind: 'number', words: 2 }, unit: 'W', min: 0, max: 200000, step: 100,
    note: 'confident: holding 1503–1504 U32 W',
  }),
  setting('Grid', 'Grid feed-in limit', {
    type: 'number', reg: 2039, codec: { kind: 'number', words: 2, signed: true, scale: 0.1 }, unit: '%', min: 0, max: 100, step: 1,
    note: 'confident address: holding 2039–2040 S32 1E-3 of rated (shown in %)',
  }),
  setting('Grid', 'Fault reconnection time', {
    type: 'number', reg: 2038, codec: { kind: 'number' }, unit: 's', min: 20, max: 600, step: 1, note: 'confident: holding 2038 s',
  }),
  // PV
  setting('PV', 'PV input mode', {
    type: 'select', reg: 205, codec: { kind: 'enum' }, options: ['Independent', 'Parallel', 'No PV'], note: 'confident: holding 205',
  }),
  setting('PV', 'PV start-up voltage', {
    type: 'number', reg: 210, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 0, max: 1000, step: 1, note: 'confident: holding 210 0.1 V',
  }),
];

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

/** Register image → setting values; settings whose registers are missing are left out. */
export function decodeSettings(defs: AforeSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    const lo = regs.get(def.reg + 1);
    switch (c.kind) {
      case 'enum': {
        const i = c.values ? c.values.indexOf(raw) : raw;
        out[def.key] = def.options?.[i] ?? `Unknown (${raw})`;
        break;
      }
      case 'number': {
        let v = raw;
        if (c.words === 2) {
          if (lo === undefined) continue;
          v = c.signed ? ((raw << 16) | lo) >> 0 : raw * 0x10000 + lo;
        } else if (c.signed && v > 0x7fff) v -= 0x10000;
        out[def.key] = round2(v * (c.scale ?? 1));
        break;
      }
      case 'bit': {
        if (lo === undefined) continue;
        const word = raw * 0x10000 + lo;
        out[def.key] = Math.floor(word / 2 ** c.bit) % 2 === 1;
        break;
      }
      case 'onoff':
        if (raw === c.on) out[def.key] = true;
        else if (raw === c.off) out[def.key] = false;
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
