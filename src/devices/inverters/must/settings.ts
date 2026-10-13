/**
 * MUST settings (holding registers). The driver is read-only: every setting is decoded and shown,
 * none can be written until the map has been checked on hardware.
 *
 * Charger settings live at 10101+, inverter settings at 20101+. Only the blocks below are read —
 * see the crash warning in registers.ts.
 */
import { round, type Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from '../growatt/registers.ts';

export type Codec =
  /** raw → option text. */
  | { kind: 'enum'; map: Record<number, string> }
  /** value = raw × scale. */
  | { kind: 'number'; scale?: number }
  /** 0 → false, anything else → true. */
  | { kind: 'bool' }
  /** hour×100 + minute → "HH:MM". */
  | { kind: 'hhmm' };

export interface MustSetting extends SettingDef {
  reg: number;
  codec: Codec;
  /** Confidence / source note. */
  note: string;
}

/** Holding spans read for settings (start, count): safe ranges only. */
export const PH1800_SETTING_SPANS: [number, number][] = [
  [10101, 24],
  [20101, 44],
];
export const PH10_SETTING_SPANS: [number, number][] = [[10117, 3]];

const key = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function def(
  label: string,
  section: string,
  reg: number,
  codec: Codec,
  note: string,
  extra: Partial<SettingDef> = {},
): MustSetting {
  const base: MustSetting = { key: key(label), label, section, type: 'number', reg, codec, note, readOnly: true, ...extra };
  if (codec.kind === 'enum') {
    base.type = 'select';
    base.options = Object.values(codec.map);
  } else if (codec.kind === 'bool') base.type = 'checkbox';
  else if (codec.kind === 'hhmm') base.type = 'time';
  return base;
}

const BATTERY_TYPES = { 1: 'User defined', 2: 'Lithium', 3: 'Sealed lead acid', 4: 'AGM', 5: 'Gel', 6: 'Flooded' };
const OUTPUT_PRIORITY = { 1: 'SBU priority', 2: 'SUB priority', 3: 'Utility first', 4: 'Solar only' };
const CHARGER_PRIORITY = { 0: 'Solar first', 1: 'Utility first', 2: 'Solar and utility simultaneously', 3: 'Solar only' };
const GRID_STANDARD = { 0: 'VDE4105', 1: 'UPS', 2: 'APL', 3: 'GEN' };
const SOLAR_AIM = { 0: 'Load first (LBU)', 1: 'Battery first (BLU)' };

export const PH1800_SETTINGS: MustSetting[] = [
  def('Battery type', 'Battery', 10110, { kind: 'enum', map: BATTERY_TYPES }, '1–6 confident; 0 unused'),
  def('Battery capacity', 'Battery', 10111, { kind: 'number' }, 'Ah (confident)', { unit: 'Ah' }),
  def('Bulk charge voltage', 'Battery', 10104, { kind: 'number', scale: 0.1 }, 'absorption voltage 0.1 V (confident)', { unit: 'V', step: 0.1 }),
  def('Float charge voltage', 'Battery', 10103, { kind: 'number', scale: 0.1 }, '0.1 V (confident)', { unit: 'V', step: 0.1 }),
  def('Battery low voltage', 'Battery', 10105, { kind: 'number', scale: 0.1 }, 'charger low-voltage point 0.1 V (confident address, meaning UNVERIFIED)', { unit: 'V', step: 0.1 }),
  def('Max charge current', 'Battery', 10108, { kind: 'number', scale: 0.1 }, 'solar charger max current 0.1 A (confident)', { unit: 'A' }),
  def('Max grid charge current', 'Battery', 20125, { kind: 'number', scale: 0.1 }, '0.1 A (confident address)', { unit: 'A' }),
  def('Max combined charge current', 'Battery', 20132, { kind: 'number', scale: 0.1 }, '0.1 A (UNVERIFIED)', { unit: 'A' }),
  def('Battery stop discharging voltage', 'Battery', 20118, { kind: 'number', scale: 0.1 }, 'UNVERIFIED meaning (back-to-grid point?) 0.1 V', { unit: 'V', step: 0.1 }),
  def('Battery stop charging voltage', 'Battery', 20119, { kind: 'number', scale: 0.1 }, 'UNVERIFIED meaning (back-to-battery point?) 0.1 V', { unit: 'V', step: 0.1 }),
  def('Low battery cut-off voltage', 'Battery', 20127, { kind: 'number', scale: 0.1 }, 'inverter battery low voltage 0.1 V (UNVERIFIED)', { unit: 'V', step: 0.1 }),
  def('Battery equalization', 'Battery', 10118, { kind: 'bool' }, 'UNVERIFIED'),
  def('Equalization voltage', 'Battery', 10119, { kind: 'number', scale: 0.1 }, '0.1 V (UNVERIFIED)', { unit: 'V', step: 0.1 }),
  def('Output source priority', 'Input/output', 20109, { kind: 'enum', map: OUTPUT_PRIORITY }, 'energy use mode: 1 SBU, 2 SUB, 3 UTI, 4 SOL (confident codes, labels UNVERIFIED)'),
  def('Charger source priority', 'Input/output', 20143, { kind: 'enum', map: CHARGER_PRIORITY }, '0/2/3 confident; 1 = utility first UNVERIFIED'),
  def('Grid charging', 'Input/output', 20106, { kind: 'bool' }, 'charge from grid enable (UNVERIFIED)'),
  def('Discharge to grid', 'Input/output', 20108, { kind: 'bool' }, 'PH1800 grid feed-in enable (UNVERIFIED)'),
  def('AC output voltage', 'Input/output', 20102, { kind: 'number', scale: 0.1 }, '0.1 V (confident)', { unit: 'V' }),
  def('AC output frequency', 'Input/output', 20103, { kind: 'number', scale: 0.01 }, '0.01 Hz (confident)', { unit: 'Hz' }),
  def('Grid protection standard', 'Input/output', 20111, { kind: 'enum', map: GRID_STANDARD }, 'UNVERIFIED'),
  def('Power saving mode', 'Input/output', 20104, { kind: 'bool' }, 'search mode enable (UNVERIFIED)'),
  def('Solar use aim', 'Solar PV', 20112, { kind: 'enum', map: SOLAR_AIM }, 'UNVERIFIED'),
  def('PV power balance', 'Solar PV', 20144, { kind: 'bool' }, 'solar power balance (UNVERIFIED)'),
];

export const PH10_SETTINGS: MustSetting[] = [
  def('Equalization interval', 'Battery', 10117, { kind: 'number' }, 'days (UNVERIFIED)', { unit: 'days' }),
  def('Equalization start time', 'Battery', 10118, { kind: 'hhmm' }, 'hour×100+minute (UNVERIFIED)'),
  def('Equalization end time', 'Battery', 10119, { kind: 'hhmm' }, 'hour×100+minute (UNVERIFIED)'),
];

function decodeOne(s: MustSetting, raw: number): Value {
  const c = s.codec;
  switch (c.kind) {
    case 'enum':
      return c.map[raw] ?? `Unknown (${raw})`;
    case 'bool':
      return raw !== 0;
    case 'hhmm': {
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${p2(Math.min(23, Math.floor(raw / 100)))}:${p2(Math.min(59, raw % 100))}`;
    }
    default: {
      const scale = c.scale ?? 1;
      return scale === 1 ? raw : round(raw * scale, scale < 0.1 ? 2 : 1);
    }
  }
}

/** Decodes every setting whose register is present in the image. */
export function decodeSettings(settings: MustSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const s of settings) {
    const raw = regs.get(s.reg);
    if (raw !== undefined) out[s.key] = decodeOne(s, raw);
  }
  return out;
}
