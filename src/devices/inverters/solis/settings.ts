/**
 * Solis hybrid settings (holding registers, function 3, around 43000+). The driver is read-only:
 * these are decoded and shown, never written. String inverters have no battery settings; reads of
 * the ranges below simply fail there and the settings stay blank.
 *
 * All rows UNVERIFIED unless noted: addresses come from Ginlong's energy-storage protocol document
 * and community register lists, and differ between firmware generations.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'number'; scale?: number }
  /** Energy storage control word at 43110: one select derived from mode bits. */
  | { kind: 'mode' }
  /** One bit of a word. */
  | { kind: 'bit'; bit: number }
  /** Time slot: start hour, start minute, end hour, end minute in four registers; enabled = TOU bit. */
  | { kind: 'slot' };

export interface SolisSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Energy storage control switch (43110) bits (medium confidence). */
export const MODE_REG = 43110;
export const MODE_BITS = { selfUse: 0, timeOfUse: 1, offGrid: 2, batteryWake: 3, reserve: 4, gridCharge: 5, feedIn: 6 } as const;

/** Spans read for settings: 43010–43024 and 43110–43150. */
export const SETTING_SPANS: [number, number][] = [
  [43010, 15],
  [43110, 41],
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<SolisSetting, 'key' | 'label' | 'section' | 'readOnly'>): SolisSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const WORK_MODES = ['Self-use', 'Feed-in priority', 'Backup', 'Off-grid'];

export const SOLIS_SETTINGS: SolisSetting[] = [
  setting('Work mode', 'Energy storage mode', {
    type: 'select', reg: MODE_REG, codec: { kind: 'mode' }, options: WORK_MODES,
    help: 'From the energy storage control word (43110).',
    note: 'medium: 43110 bit0 self-use, bit2 off-grid, bit4 reserve battery (backup), bit6 feed-in priority',
  }),
  setting('Work mode', 'Time of use', {
    type: 'checkbox', reg: MODE_REG, codec: { kind: 'bit', bit: MODE_BITS.timeOfUse },
    note: 'medium: 43110 bit1 time-of-use charge/discharge',
  }),
  setting('Work mode', 'Grid charging', {
    type: 'checkbox', reg: MODE_REG, codec: { kind: 'bit', bit: MODE_BITS.gridCharge },
    note: 'medium: 43110 bit5 allow charging the battery from the grid',
  }),
  setting('Battery', 'Overdischarge SOC', {
    type: 'number', reg: 43011, codec: { kind: 'number' }, unit: '%', min: 5, max: 100, step: 1,
    note: 'UNVERIFIED: 43011 over-discharge (minimum) SOC %',
  }),
  setting('Battery', 'Force charge SOC', {
    type: 'number', reg: 43018, codec: { kind: 'number' }, unit: '%', min: 5, max: 100, step: 1,
    note: 'UNVERIFIED: 43018 force-charge SOC %',
  }),
  setting('Battery', 'Backup SOC', {
    type: 'number', reg: 43024, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'UNVERIFIED: 43024 backup / reserve SOC %',
  }),
  setting('Battery', 'Max charge current', {
    type: 'number', reg: 43117, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 1,
    note: 'UNVERIFIED: 43117 battery charge current limit 0.1 A',
  }),
  setting('Battery', 'Max discharge current', {
    type: 'number', reg: 43118, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 1,
    note: 'UNVERIFIED: 43118 battery discharge current limit 0.1 A',
  }),
  setting('Time of use', 'Time charge current', {
    type: 'number', reg: 43141, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 1,
    note: 'medium: 43141 timed charge current 0.1 A',
  }),
  setting('Time of use', 'Time discharge current', {
    type: 'number', reg: 43142, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 200, step: 1,
    note: 'medium: 43142 timed discharge current 0.1 A',
  }),
  setting('Time of use', 'Charge slot 1', {
    type: 'slot', reg: 43143, codec: { kind: 'slot' },
    note: 'medium: 43143–43146 charge start h/m, end h/m; enabled = 43110 bit1',
  }),
  setting('Time of use', 'Discharge slot 1', {
    type: 'slot', reg: 43147, codec: { kind: 'slot' },
    note: 'medium: 43147–43150 discharge start h/m, end h/m; enabled = 43110 bit1',
  }),
];

function hhmm(h: number, m: number) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Control word → work mode name (feed-in and off-grid take precedence over self-use). */
export function workMode(word: number): string {
  if (word & (1 << MODE_BITS.offGrid)) return 'Off-grid';
  if (word & (1 << MODE_BITS.feedIn)) return 'Feed-in priority';
  if (word & (1 << MODE_BITS.reserve)) return 'Backup';
  if (word & (1 << MODE_BITS.selfUse)) return 'Self-use';
  return `Unknown (${word})`;
}

/** Register image → setting values; settings whose registers are missing are left out. */
export function decodeSettings(defs: SolisSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    const raw = regs.get(def.reg);
    if (raw === undefined) continue;
    const c = def.codec;
    switch (c.kind) {
      case 'number':
        out[def.key] = Math.round(raw * (c.scale ?? 1) * 100) / 100;
        break;
      case 'mode':
        out[def.key] = workMode(raw);
        break;
      case 'bit':
        out[def.key] = Boolean(raw & (1 << c.bit));
        break;
      case 'slot': {
        const w = [0, 1, 2, 3].map((i) => regs.get(def.reg + i));
        if (w.some((x) => x === undefined || x > 59)) break;
        const [sh, sm, eh, em] = w as number[];
        if (sh > 23 || eh > 23) break;
        const mode = regs.get(MODE_REG);
        const on = mode !== undefined && Boolean(mode & (1 << MODE_BITS.timeOfUse));
        out[def.key] = `${hhmm(sh, sm)},${hhmm(eh, em)},${on}`;
        break;
      }
    }
  }
  return out;
}
