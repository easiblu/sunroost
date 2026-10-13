/**
 * MidNite AIO (Senergy-based) settings: holding registers 0x2100.. (hybrid settings) and 0x30B0..
 * (grid / meter settings). The driver is read-only: these are decoded and shown, never written.
 *
 * Sources as in registers.ts: evcc's senergy-hybrid template (work mode 0x2100, time-based control
 * enable 0x214C, charge window 1 at 0x2102/0x2103 with hour in the high byte), HA-Skyline (0x2116–
 * 0x211C, 0x30BA) and the ESPHome map (mode names, 0x2104/0x2105, 0x2112, 0x2115, 0x211B).
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  | { kind: 'enum' }
  | { kind: 'number'; scale?: number }
  | { kind: 'bool' }
  /** start, end registers, each hour (high byte) | minute (low byte); enabled when start ≠ end. */
  | { kind: 'slot' };

export interface MidniteSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Spans read for settings: 0x2100–0x2121, 0x214C and 0x30B0–0x30BB. */
export const SETTING_SPANS: [number, number][] = [
  [0x2100, 0x22],
  [0x214c, 1],
  [0x30b0, 0x0c],
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<MidniteSetting, 'key' | 'label' | 'section' | 'readOnly'>): MidniteSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

export const WORK_MODES = ['Self use', 'Feed-in priority', 'Time-based control', 'Backup', 'Battery discharge'];

const pct = { unit: '%', min: 0, max: 100, step: 1 };
const watts = { unit: 'W', min: 0, max: 12000, step: 50 };

export const MIDNITE_SETTINGS: MidniteSetting[] = [
  // Work mode
  setting('Work mode', 'Work mode', {
    type: 'select', reg: 0x2100, codec: { kind: 'enum' }, options: WORK_MODES,
    note: 'confident address (evcc + HA-Skyline + ESPHome map): 0 self use / 3 backup (evcc); 1, 2, 4 names from the ESPHome map (medium)',
  }),
  setting('Work mode', 'Time-based control', {
    type: 'checkbox', reg: 0x214c, codec: { kind: 'bool' }, note: 'medium: time-based control enable (evcc)',
  }),
  setting('Work mode', 'Charge slot 1', {
    type: 'slot', reg: 0x2102, codec: { kind: 'slot' }, note: 'medium: charge window 1 start/end, hour high byte (evcc writes 0x173B = 23:59)',
  }),
  setting('Work mode', 'Discharge slot 1', {
    type: 'slot', reg: 0x2104, codec: { kind: 'slot' }, note: 'UNVERIFIED: discharge window 1 start/end (ESPHome map), same packing as the charge window',
  }),
  // Battery
  setting('Battery', 'Battery capacity', {
    type: 'number', reg: 0x2112, codec: { kind: 'number' }, unit: 'Ah', min: 50, max: 1000, step: 10, note: 'UNVERIFIED: battery capacity Ah (ESPHome map)',
  }),
  setting('Battery', 'Max charge power', {
    type: 'number', reg: 0x2118, codec: { kind: 'number' }, ...watts, note: 'medium: battery max charge power W (HA-Skyline; unit UNVERIFIED)',
  }),
  setting('Battery', 'Charge stop capacity', {
    type: 'number', reg: 0x2119, codec: { kind: 'number' }, ...pct, note: 'medium: battery max SOC % (HA-Skyline + ESPHome map)',
  }),
  setting('Battery', 'Max discharge power', {
    type: 'number', reg: 0x211a, codec: { kind: 'number' }, ...watts, note: 'medium: battery max discharge power W (HA-Skyline; unit UNVERIFIED)',
  }),
  setting('Battery', 'Discharge stop capacity', {
    type: 'number', reg: 0x211b, codec: { kind: 'number' }, ...pct, note: 'UNVERIFIED: discharge end SOC % (ESPHome map)',
  }),
  // Grid
  setting('Grid', 'Grid charge', {
    type: 'checkbox', reg: 0x2115, codec: { kind: 'bool' }, note: 'medium: grid charge enable 0/1 (ESPHome map)',
  }),
  setting('Grid', 'Grid charge power', {
    type: 'number', reg: 0x2116, codec: { kind: 'number' }, ...watts, note: 'medium: grid max charge power W (HA-Skyline; unit UNVERIFIED)',
  }),
  setting('Grid', 'Grid charge stop capacity', {
    type: 'number', reg: 0x2117, codec: { kind: 'number' }, ...pct, note: 'medium: grid charge end SOC % (HA-Skyline + ESPHome map)',
  }),
  setting('Grid', 'Max feed-in power', {
    type: 'number', reg: 0x30ba, codec: { kind: 'number' }, ...watts, note: 'medium: grid max feed-in power W (HA-Skyline; ESPHome reads 0x30B9 as u32)',
  }),
  // Output
  setting('Output', 'EPS output', {
    type: 'checkbox', reg: 0x211c, codec: { kind: 'bool' }, note: 'medium: EPS (backup output) enable (HA-Skyline + ESPHome map)',
  }),
];

const pad = (n: number) => String(n).padStart(2, '0');

/** hour (high byte) | minute (low byte) → "HH:MM", clamped. */
export function decodeTime(word: number) {
  return `${pad(Math.min(23, (word >> 8) & 0xff))}:${pad(Math.min(59, word & 0xff))}`;
}

function words(def: MidniteSetting) {
  return def.codec.kind === 'slot' ? 2 : 1;
}

export function decodeSetting(def: MidniteSetting, ws: number[]): Value {
  const c = def.codec;
  switch (c.kind) {
    case 'enum':
      return def.options?.[ws[0]] ?? `Unknown (${ws[0]})`;
    case 'bool':
      return ws[0] !== 0;
    case 'slot':
      return `${decodeTime(ws[0])},${decodeTime(ws[1])},${ws[0] !== ws[1] ? 'true' : 'false'}`;
    default:
      return Math.round(ws[0] * (c.scale ?? 1) * 1000) / 1000;
  }
}

export function decodeSettings(defs: MidniteSetting[], regs: RegisterImage): SettingValues {
  const out: SettingValues = {};
  for (const def of defs) {
    const ws: number[] = [];
    for (let i = 0; i < words(def); i++) {
      const w = regs.get(def.reg + i);
      if (w === undefined) break;
      ws.push(w);
    }
    if (ws.length === words(def)) out[def.key] = decodeSetting(def, ws);
  }
  return out;
}
