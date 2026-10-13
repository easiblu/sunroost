/**
 * SRNE settings (holding registers, function 3). Battery parameters live at 0xE000.., inverter
 * parameters at 0xE200... The driver is read-only: these are decoded and shown, never written.
 *
 * Battery voltage parameters: SRNE's documents give them in 0.1 V. Some firmware reports them on a
 * 12 V basis (×system voltage / 12), so values below 20 V on a 24/48 V system are scaled up
 * (UNVERIFIED which firmware does which).
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'enum'; values?: number[] }
  | { kind: 'number'; scale?: number }
  /** Battery voltage parameter, 0.1 V, maybe on a 12 V basis. */
  | { kind: 'battv' }
  | { kind: 'bool'; on?: number; off?: number };

export interface SrneSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** System (battery) voltage register: 12 / 24 / 36 / 48, 0xFF = auto. */
export const SYSTEM_VOLTAGE_REG = 0xe003;

/** Spans read for settings: 0xE000–0xE01F and 0xE200–0xE212. */
export const SETTING_SPANS: [number, number][] = [
  [0xe000, 0x20],
  [0xe200, 0x13],
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SrneSetting, 'key' | 'label' | 'section' | 'readOnly'>): SrneSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const BATTERY_TYPES = ['User defined', 'Sealed lead acid', 'Flooded', 'Gel', 'Lithium (LFP)', 'Lithium (NCM)'];

export const SRNE_SETTINGS: SrneSetting[] = [
  // Battery
  setting('Battery', 'Battery type', {
    type: 'select', reg: 0xe004, codec: { kind: 'enum' }, options: BATTERY_TYPES,
    note: 'UNVERIFIED: 0xE004 0 USE / 1 SLd / 2 FLd / 3 GEL / 4 LFP / 5 NCM',
  }),
  setting('Battery', 'Battery capacity', {
    type: 'number', reg: 0xe002, codec: { kind: 'number' }, unit: 'Ah', min: 10, max: 2000, step: 1,
    note: 'UNVERIFIED: 0xE002 nominal capacity Ah',
  }),
  setting('Battery', 'Battery equalization voltage', {
    type: 'number', reg: 0xe007, codec: { kind: 'battv' }, unit: 'V', min: 9, max: 64, step: 0.1,
    note: 'UNVERIFIED: 0xE007 equalizing charge voltage 0.1 V',
  }),
  setting('Battery', 'Battery absorption charge voltage', {
    type: 'number', reg: 0xe008, codec: { kind: 'battv' }, unit: 'V', min: 9, max: 64, step: 0.1,
    note: 'UNVERIFIED: 0xE008 boost charge voltage 0.1 V',
  }),
  setting('Battery', 'Battery float charge voltage', {
    type: 'number', reg: 0xe009, codec: { kind: 'battv' }, unit: 'V', min: 9, max: 64, step: 0.1,
    note: 'UNVERIFIED: 0xE009 float charge voltage 0.1 V',
  }),
  setting('Battery', 'Shutdown battery voltage', {
    type: 'number', reg: 0xe00d, codec: { kind: 'battv' }, unit: 'V', min: 9, max: 64, step: 0.1,
    note: 'UNVERIFIED: 0xE00D over-discharge (cut-off) voltage 0.1 V',
  }),
  setting('Battery', 'To grid battery voltage', {
    type: 'number', reg: 0xe01b, codec: { kind: 'battv' }, unit: 'V', min: 9, max: 64, step: 0.1,
    note: 'UNVERIFIED: 0xE01B battery-to-mains switching voltage 0.1 V',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 0xe20a, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 300, step: 1,
    note: 'UNVERIFIED: 0xE20A max (total) charge current 0.1 A',
  }),
  setting('Battery', 'Max grid charge current', {
    type: 'number', reg: 0xe205, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 1,
    note: 'UNVERIFIED: 0xE205 mains charge current limit 0.1 A',
  }),
  setting('Battery', 'Charger source priority', {
    type: 'select', reg: 0xe20f, codec: { kind: 'enum' },
    options: ['Solar first', 'Utility first', 'Solar and utility simultaneously', 'Solar only'],
    help: 'SRNE calls these CSO, CUB, SNU and OSO.',
    note: 'medium: 0xE20F 0 CSO (PV first) / 1 CUB (mains first) / 2 SNU (hybrid) / 3 OSO (PV only)',
  }),
  // Input/output
  setting('Input/output', 'Output source priority', {
    type: 'select', reg: 0xe204, codec: { kind: 'enum' },
    options: ['Solar first', 'Utility first', 'Solar/Battery/Utility'],
    help: 'SRNE calls these SOL, UTI and SBU.',
    note: 'medium: 0xE204 0 SOL / 1 UTI / 2 SBU',
  }),
  setting('Input/output', 'AC output voltage', {
    type: 'number', reg: 0xe208, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 100, max: 240, step: 1,
    note: 'UNVERIFIED: 0xE208 output voltage 0.1 V',
  }),
  setting('Input/output', 'AC output frequency', {
    type: 'number', reg: 0xe209, codec: { kind: 'number', scale: 0.01 }, unit: 'Hz', min: 50, max: 60, step: 10,
    note: 'UNVERIFIED: 0xE209 output frequency 0.01 Hz',
  }),
  setting('Input/output', 'AC input voltage range', {
    type: 'select', reg: 0xe20b, codec: { kind: 'enum' }, options: ['Appliance', 'UPS'],
    note: 'UNVERIFIED: 0xE20B 0 APL (wide) / 1 UPS (narrow)',
  }),
  setting('Input/output', 'Power saving mode', {
    type: 'checkbox', reg: 0xe20c, codec: { kind: 'bool' },
    note: 'UNVERIFIED: 0xE20C 0 off / 1 on',
  }),
  setting('Input/output', 'Overload restart', {
    type: 'checkbox', reg: 0xe20d, codec: { kind: 'bool' },
    note: 'UNVERIFIED: 0xE20D overload auto-restart 0 off / 1 on',
  }),
  // Miscellaneous
  setting('Miscellaneous', 'Over temperature restart', {
    type: 'checkbox', reg: 0xe20e, codec: { kind: 'bool' },
    note: 'UNVERIFIED: 0xE20E over-temperature auto-restart 0 off / 1 on',
  }),
  setting('Miscellaneous', 'Buzzer', {
    type: 'checkbox', reg: 0xe210, codec: { kind: 'bool' },
    note: 'UNVERIFIED: 0xE210 alarm enable 0 off / 1 on',
  }),
];

function round1(v: number) {
  return Math.round(v * 100) / 100;
}

/** Register image → setting values; settings whose register is missing are left out. */
export function decodeSettings(defs: SrneSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  const sys = regs.get(SYSTEM_VOLTAGE_REG);
  const factor = sys === 24 || sys === 36 || sys === 48 ? sys / 12 : 1;
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    switch (c.kind) {
      case 'enum': {
        const i = c.values ? c.values.indexOf(raw) : raw;
        out[def.key] = def.options?.[i] ?? `Unknown (${raw})`;
        break;
      }
      case 'number':
        out[def.key] = round1(raw * (c.scale ?? 1));
        break;
      case 'battv': {
        const v = raw * 0.1;
        out[def.key] = round1(v < 20 ? v * factor : v);
        break;
      }
      case 'bool':
        out[def.key] = raw !== (c.off ?? 0);
        break;
    }
  }
  return out;
}
