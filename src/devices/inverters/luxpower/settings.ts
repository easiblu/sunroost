/**
 * Luxpower holding-register settings. The driver is read-only: every setting is decoded and shown,
 * none is written. Labels and keys follow Luxpower's own setting names and the power
 * management page (grid_charge_slot_N, charge_first_slot_N, forced_discharge_slot_N).
 *
 * Register addresses come from the public LuxPower Modbus protocol (holding block 0–199) as
 * documented by open-source Luxpower/EG4 tools. Notes say "confident" or "UNVERIFIED".
 *
 * Time slots: two registers (start, end), each packing hour in the low byte and minute in the
 * high byte (medium confidence).
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'number'; scale?: number }
  /** One bit of a register. */
  | { kind: 'bit'; bit: number }
  /** start, end registers (hour low byte, minute high byte); enabled when start ≠ end. */
  | { kind: 'slot' };

export interface LuxSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

const snakeKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function setting(section: string, label: string, reg: number, codec: Codec, note: string, extra: Partial<SettingDef> = {}): LuxSetting {
  const type = codec.kind === 'bit' ? 'checkbox' : codec.kind === 'slot' ? 'slot' : 'number';
  return { key: snakeKey(label), label, section, type, readOnly: true, reg, codec, note, ...extra };
}

const pct = { unit: '%', min: 0, max: 100, step: 1 };
const volts = { unit: 'V', min: 40, max: 60, step: 0.1 };

function slots(label: string, base: number, note: string): LuxSetting[] {
  return [1, 2, 3].map((n) =>
    setting('Schedule', `${label} slot ${n}`, base + (n - 1) * 2, { kind: 'slot' }, `${note}, slot ${n} at holding ${base + (n - 1) * 2}–${base + (n - 1) * 2 + 1}`),
  );
}

export const SETTINGS: LuxSetting[] = [
  // Info
  setting('Info', 'Address', 15, { kind: 'number' }, 'holding 15 com address (medium)', { min: 1, max: 247, step: 1 }),
  // Input/output
  setting('Input/output', 'EPS output', 21, { kind: 'bit', bit: 0 }, 'holding 21 bit 0 EPS enable (medium)'),
  setting('Input/output', 'EPS output voltage', 90, { kind: 'number' }, 'UNVERIFIED: holding 90 EPS voltage set, V', { unit: 'V', min: 100, max: 250, step: 1 }),
  setting('Input/output', 'EPS output frequency', 91, { kind: 'number' }, 'UNVERIFIED: holding 91 EPS frequency set, Hz', { unit: 'Hz', min: 50, max: 60, step: 10 }),
  setting('Input/output', 'Feed-in grid', 21, { kind: 'bit', bit: 15 }, 'holding 21 bit 15 feed-in grid enable (medium)'),
  setting('Input/output', 'Feed-in grid power', 103, { kind: 'number' }, 'UNVERIFIED: holding 103 feed-in power percent', pct),
  // Charge settings
  setting('Charge settings', 'Absorption charge voltage', 99, { kind: 'number', scale: 0.1 }, 'holding 99 lead-acid charge voltage ref 0.1 V (medium)', volts),
  setting('Charge settings', 'Float charge voltage', 144, { kind: 'number', scale: 0.1 }, 'UNVERIFIED: holding 144 float charge voltage 0.1 V', volts),
  setting('Charge settings', 'Max charge current', 101, { kind: 'number' }, 'holding 101 charge current limit A (medium)', { unit: 'A', min: 0, max: 250, step: 1 }),
  setting('Charge settings', 'Charge power', 64, { kind: 'number' }, 'holding 64 charge power percent (medium)', pct),
  setting('Charge settings', 'Grid charge', 21, { kind: 'bit', bit: 7 }, 'holding 21 bit 7 AC charge enable (confident)'),
  setting('Charge settings', 'Grid charge power', 66, { kind: 'number' }, 'holding 66 AC charge power percent (medium)', pct),
  setting('Charge settings', 'Grid charge stop capacity', 67, { kind: 'number' }, 'holding 67 AC charge SOC limit % (medium)', pct),
  setting('Charge settings', 'Grid charge start capacity', 160, { kind: 'number' }, 'UNVERIFIED: holding 160 AC charge start SOC %', pct),
  setting('Charge settings', 'Grid charge current', 168, { kind: 'number' }, 'UNVERIFIED: holding 168 AC charge current A', { unit: 'A', min: 0, max: 250, step: 1 }),
  setting('Charge settings', 'Charge first', 21, { kind: 'bit', bit: 11 }, 'holding 21 bit 11 charge priority enable (medium)'),
  setting('Charge settings', 'Charge first power', 74, { kind: 'number' }, 'holding 74 charge priority power percent (medium)', pct),
  setting('Charge settings', 'Charge first stop capacity', 75, { kind: 'number' }, 'holding 75 charge priority SOC limit % (medium)', pct),
  // Discharge settings
  setting('Discharge settings', 'Max discharge current', 102, { kind: 'number' }, 'holding 102 discharge current limit A (medium)', { unit: 'A', min: 0, max: 250, step: 1 }),
  setting('Discharge settings', 'Discharge power', 65, { kind: 'number' }, 'holding 65 discharge power percent (medium)', pct),
  setting('Discharge settings', 'Stop discharge voltage', 100, { kind: 'number', scale: 0.1 }, 'holding 100 lead-acid discharge cut-off 0.1 V (medium)', volts),
  setting('Discharge settings', 'Stop discharge capacity', 105, { kind: 'number' }, 'holding 105 on-grid discharge cut-off SOC % (medium)', pct),
  setting('Discharge settings', 'Shutdown battery capacity', 125, { kind: 'number' }, 'UNVERIFIED: holding 125 off-grid (EPS) cut-off SOC %', pct),
  setting('Discharge settings', 'Forced discharge', 21, { kind: 'bit', bit: 10 }, 'holding 21 bit 10 forced discharge enable (medium)'),
  setting('Discharge settings', 'Forced discharge power', 82, { kind: 'number' }, 'holding 82 forced discharge power percent (medium)', pct),
  setting('Discharge settings', 'Forced discharge stop capacity', 83, { kind: 'number' }, 'holding 83 forced discharge SOC limit % (medium)', pct),
  // Schedule (power management page)
  ...slots('Grid charge', 68, 'holding 68–73 AC charge time (medium)'),
  ...slots('Charge first', 76, 'holding 76–81 charge priority time (medium)'),
  ...slots('Forced discharge', 84, 'holding 84–89 forced discharge time (medium)'),
];

export function codecWords(c: Codec) {
  return c.kind === 'slot' ? 2 : 1;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** hour (low byte) | minute (high byte) → "HH:MM"; out-of-range parts are clamped. */
export function decodeTime(word: number): string {
  return `${pad(Math.min(23, word & 0xff))}:${pad(Math.min(59, (word >> 8) & 0xff))}`;
}

export function decodeSetting(def: LuxSetting, words: number[]): Value {
  const c = def.codec;
  switch (c.kind) {
    case 'bit':
      return Boolean((words[0] >> c.bit) & 1);
    case 'slot': {
      const enabled = words[0] !== words[1];
      return `${decodeTime(words[0])},${decodeTime(words[1])},${enabled ? 'true' : 'false'}`;
    }
    default: {
      const v = words[0] * (c.scale ?? 1);
      return Math.round(v * 1000) / 1000;
    }
  }
}

/** Decodes every setting whose registers are present. */
export function decodeSettings(defs: LuxSetting[], regs: RegisterImage): SettingValues {
  const out: SettingValues = {};
  for (const def of defs) {
    const words: number[] = [];
    for (let i = 0; i < codecWords(def.codec); i++) {
      const w = regs.get(def.reg + i);
      if (w === undefined) break;
      words.push(w);
    }
    if (words.length === codecWords(def.codec)) out[def.key] = decodeSetting(def, words);
  }
  return out;
}

/** Holding spans read for settings: [start, count], each ≤ 40 registers (a dongle-friendly size). */
export const SETTING_BLOCKS: [number, number][] = [[0, 40], [40, 40], [80, 40], [120, 40], [160, 40]];
