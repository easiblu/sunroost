/**
 * Growatt settings as holding-register tables: each SettingDef carries the register(s) it lives in and
 * a codec that turns register words into the setting value and back.
 *
 * Settings whose register address is not confirmed against Growatt's protocol PDF are marked
 * `verified: false`. They are read and shown, but exposed as read-only so a wrong guess can never
 * write into an unrelated (possibly grid-protection) register. Flip `verified` once the address has
 * been checked with the Modbus console on a real unit.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  /** Option i ↔ raw value `values[i]` (default: the option index). */
  | { kind: 'enum'; values?: number[] }
  /** value = raw × scale. */
  | { kind: 'number'; scale?: number }
  /** true ↔ `on` (default 1), false ↔ `off` (default 0); any other non-`off` raw value reads as true. */
  | { kind: 'bool'; on?: number; off?: number }
  /** SPH slot: three registers start (h<<8|m), end (h<<8|m), enable (0/1). */
  | { kind: 'slot3' }
  /**
   * TL-XH slot: two registers. Word 0: bit 15 enable, bits 13–14 priority, bits 8–12 hour, bits 0–7
   * minute (start). Word 1: end hour<<8 | minute.
   */
  | { kind: 'tlslot' };

export interface GrowattSetting extends SettingDef {
  /** First holding register; undefined for settings with no known register (always read-only). */
  reg?: number;
  codec: Codec;
  verified: boolean;
  /** Confidence / source note. */
  note?: string;
}

export function codecWords(codec: Codec) {
  return codec.kind === 'slot3' ? 3 : codec.kind === 'tlslot' ? 2 : 1;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "HH:MM" → hour<<8 | minute (Growatt's time-slot encoding). */
export function encodeTime(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`Invalid time '${text}'`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time '${text}'`);
  return (h << 8) | min;
}

/** hour<<8 | minute → "HH:MM". Out-of-range parts are clamped so a garbage register still renders. */
export function decodeTime(word: number): string {
  const h = Math.min(23, (word >> 8) & 0x1f);
  const m = Math.min(59, word & 0xff);
  return `${pad(h)}:${pad(m)}`;
}

/** Turns raw words (starting at the setting's register) into the setting value. */
export function decodeSetting(def: GrowattSetting, words: number[]): Value {
  const c = def.codec;
  const w = words[0];
  switch (c.kind) {
    case 'enum': {
      const i = c.values ? c.values.indexOf(w) : w;
      return def.options?.[i] ?? `Unknown (${w})`;
    }
    case 'number': {
      const v = w * (c.scale ?? 1);
      return Math.round(v * 1000) / 1000;
    }
    case 'bool':
      return w !== (c.off ?? 0);
    case 'slot3':
      return `${decodeTime(words[0])},${decodeTime(words[1])},${words[2] ? 'true' : 'false'}`;
    case 'tlslot': {
      const prio = def.slotPriorities?.[(w >> 13) & 0x3] ?? def.slotPriorities?.[0] ?? 'Load first';
      return `${decodeTime(w & 0x1fff)},${decodeTime(words[1])},${prio},${w & 0x8000 ? 'true' : 'false'}`;
    }
  }
}

/** Turns a validated setting value into the register words to write at `def.reg`. */
export function encodeSetting(def: GrowattSetting, value: Value): number[] {
  const c = def.codec;
  switch (c.kind) {
    case 'enum': {
      const i = def.options?.findIndex((o) => o.toLowerCase() === String(value).toLowerCase()) ?? -1;
      if (i < 0) throw new Error(`Invalid value '${value}' for '${def.label}'`);
      return [c.values ? c.values[i] : i];
    }
    case 'number': {
      const raw = Math.round(Number(value) / (c.scale ?? 1));
      if (!Number.isFinite(raw) || raw < 0 || raw > 0xffff) throw new Error(`Value out of range for '${def.label}'`);
      return [raw];
    }
    case 'bool':
      return [value === true || value === 'true' ? (c.on ?? 1) : (c.off ?? 0)];
    case 'slot3': {
      const [start, end, enabled] = String(value).split(',');
      return [encodeTime(start), encodeTime(end), enabled === 'true' ? 1 : 0];
    }
    case 'tlslot': {
      const [start, end, prio, enabled] = String(value).split(',');
      const p = def.slotPriorities?.findIndex((o) => o.toLowerCase() === prio?.toLowerCase()) ?? -1;
      if (p < 0) throw new Error(`Invalid priority '${prio}'`);
      return [(enabled === 'true' ? 0x8000 : 0) | (p << 13) | encodeTime(start), encodeTime(end)];
    }
  }
}

/** Decodes every setting whose registers are present in the holding-register image. */
export function decodeSettings(defs: GrowattSetting[], regs: RegisterImage) {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    if (def.reg === undefined) continue;
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

/** Holding-register spans the settings table needs, for read planning. */
export function settingSpans(defs: GrowattSetting[]): [number, number][] {
  return defs.filter((d) => d.reg !== undefined).map((d) => [d.reg!, codecWords(d.codec)]);
}

/** snake_case key from a label, as the rest of the app expects. */
export const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const UNVERIFIED_HELP = 'Register address unverified for this model; read-only until confirmed in the Modbus console.';

/** Builds a GrowattSetting from a compact spec; unverified settings become read-only. */
export function setting(
  section: string,
  label: string,
  spec: Omit<GrowattSetting, 'key' | 'label' | 'section' | 'verified'> & { verified?: boolean },
): GrowattSetting {
  const verified = spec.verified ?? false;
  return {
    ...spec,
    key: keyOf(label),
    label,
    section,
    verified,
    readOnly: spec.readOnly || !verified || spec.reg === undefined,
    help: spec.help ?? (verified ? undefined : UNVERIFIED_HELP),
  };
}
