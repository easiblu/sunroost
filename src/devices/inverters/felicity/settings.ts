/**
 * Felicity settings as holding-register rows. The whole driver is read-only until a real unit has
 * been checked, so there is no encoder: values are decoded and shown, never written.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import { round } from '../../../core/metrics.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  /** Option i ↔ raw `values[i]` (default: the index). */
  | { kind: 'enum'; values?: number[] }
  /** value = raw × scale. */
  | { kind: 'number'; scale?: number }
  /** 0 = false, anything else = true. */
  | { kind: 'bool' };

export interface FelicitySetting extends SettingDef {
  reg: number;
  codec: Codec;
  /** Source and confidence ("confident" / "UNVERIFIED"). */
  note: string;
}

export const settingKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function setting(
  section: string,
  label: string,
  rest: Omit<FelicitySetting, 'key' | 'label' | 'section' | 'readOnly'>,
): FelicitySetting {
  return { key: settingKey(label), label, section, readOnly: true, ...rest };
}

/** The public SettingDef (register bookkeeping stripped), always read-only. */
export function publicDef(s: FelicitySetting): SettingDef {
  const { reg: _r, codec: _c, note: _n, ...def } = s;
  return { ...def, readOnly: true };
}

export function decodeSetting(s: FelicitySetting, regs: RegisterImage): Value | undefined {
  const raw = regs.get(s.reg);
  if (raw === undefined) return undefined;
  switch (s.codec.kind) {
    case 'enum': {
      const i = s.codec.values ? s.codec.values.indexOf(raw) : raw;
      return s.options?.[i] ?? `Unknown (${raw})`;
    }
    case 'bool':
      return raw !== 0;
    case 'number': {
      const scale = s.codec.scale ?? 1;
      return scale === 1 ? raw : round(raw * scale, scale >= 1 ? 0 : Math.round(-Math.log10(scale)));
    }
  }
}

export function decodeSettings(defs: FelicitySetting[], regs: RegisterImage): SettingValues {
  const out: SettingValues = {};
  for (const s of defs) {
    const v = decodeSetting(s, regs);
    if (v !== undefined) out[s.key] = v;
  }
  return out;
}

/** Holding spans [start, count] covering every setting, merged into reads of at most 125 registers. */
export function settingReads(defs: FelicitySetting[], maxGap = 16, max = 125): [number, number][] {
  const addrs = [...new Set(defs.map((d) => d.reg))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const a of addrs) {
    const last = out[out.length - 1];
    if (last && a <= last[0] + last[1] + maxGap && a - last[0] + 1 <= max) last[1] = a - last[0] + 1;
    else out.push([a, 1]);
  }
  return out;
}
