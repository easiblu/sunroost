/**
 * Deye / Sunsynk settings as holding-register tables. Each setting names its register and a codec
 * that turns the register word into the setting value and back.
 *
 * Only addresses that are well established in the public Deye/Sunsynk map are `verified` (writable).
 * Everything else is shown read-only, so a wrong guess can never write into an unrelated register.
 * Deye accepts writes only as function 16 (write multiple), which the driver always uses.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec =
  /** Option i ↔ raw value `values[i]` (default: the option index). */
  | { kind: 'enum'; values?: number[] }
  /** value = raw × scale. */
  | { kind: 'number'; scale?: number }
  /** Whole register: 0 = false, anything else = true; writes 1/0. */
  | { kind: 'bool' }
  /** One bit (mask) of a shared register; written read-modify-write so the other bits are kept. */
  | { kind: 'bit'; mask: number }
  /** Time as decimal HHMM (22:30 ↔ 2230), Deye's time-of-use encoding. */
  | { kind: 'hhmm' };

export interface DeyeSetting extends SettingDef {
  /** Holding register; undefined when no address is known (always read-only, never read). */
  reg?: number;
  codec: Codec;
  verified: boolean;
  note?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "HH:MM" → HHMM decimal (22:30 → 2230). */
export function encodeHhmm(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`Invalid time '${text}'`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time '${text}'`);
  return h * 100 + min;
}

/** HHMM decimal → "HH:MM". Out-of-range parts are clamped so a garbage register still renders. */
export function decodeHhmm(word: number): string {
  const h = Math.min(23, Math.floor(word / 100));
  const m = Math.min(59, word % 100);
  return `${pad(h)}:${pad(m)}`;
}

export function decodeSetting(def: DeyeSetting, w: number): Value {
  const c = def.codec;
  switch (c.kind) {
    case 'enum': {
      const i = c.values ? c.values.indexOf(w) : w;
      return def.options?.[i] ?? `Unknown (${w})`;
    }
    case 'number':
      return Math.round(w * (c.scale ?? 1) * 1000) / 1000;
    case 'bool':
      return w !== 0;
    case 'bit':
      return (w & c.mask) !== 0;
    case 'hhmm':
      return decodeHhmm(w);
  }
}

/**
 * The register word to write for a validated value. `current` is the register's present value; the
 * 'bit' codec needs it to preserve the other bits (the driver reads it first).
 */
export function encodeSetting(def: DeyeSetting, value: Value, current = 0): number {
  const c = def.codec;
  const on = value === true || value === 'true';
  switch (c.kind) {
    case 'enum': {
      const i = def.options?.findIndex((o) => o.toLowerCase() === String(value).toLowerCase()) ?? -1;
      if (i < 0) throw new Error(`Invalid value '${value}' for '${def.label}'`);
      return c.values ? c.values[i] : i;
    }
    case 'number': {
      const raw = Math.round(Number(value) / (c.scale ?? 1));
      if (!Number.isFinite(raw) || raw < 0 || raw > 0xffff) throw new Error(`Value out of range for '${def.label}'`);
      return raw;
    }
    case 'bool':
      return on ? 1 : 0;
    case 'bit':
      return on ? (current | c.mask) & 0xffff : current & ~c.mask & 0xffff;
    case 'hhmm':
      return encodeHhmm(String(value));
  }
}

export function decodeSettings(defs: DeyeSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const def of defs) {
    if (def.reg === undefined) continue;
    const w = regs.get(def.reg);
    if (w !== undefined) out[def.key] = decodeSetting(def, w);
  }
  return out;
}

/** Holding-register spans the settings table needs, for read planning. */
export function settingSpans(defs: DeyeSetting[]): [number, number][] {
  return defs.filter((d) => d.reg !== undefined).map((d) => [d.reg!, 1]);
}

export const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const UNVERIFIED_HELP = 'Register address unverified for this model; read-only until confirmed in the Modbus console.';

export function setting(
  section: string,
  label: string,
  spec: Omit<DeyeSetting, 'key' | 'label' | 'section' | 'verified'> & { verified?: boolean },
): DeyeSetting {
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

export const WORK_MODES = ['Selling first', 'Zero export to load', 'Zero export to CT'];
export const ENERGY_PATTERNS = ['Battery first', 'Load first'];
export const BATTERY_MODES = ['Voltage', 'Lithium', 'No battery'];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Register layout of the 6-point time-of-use program; differs per family. */
export interface TouLayout {
  /** Bit 0 enable, bits 1–7 Monday … Sunday. */
  enable: number;
  time: number;
  power: number;
  voltage: number;
  soc: number;
  /** Bit 0 grid charge, bit 1 generator charge. */
  charge: number;
  maxPower: number;
  verified: boolean;
  note: string;
}

/** The "Time of use" section: enable + weekday mask + 6 points × (time, power, voltage, SOC, grid, gen). */
export function touSettings(t: TouLayout): DeyeSetting[] {
  const v = t.verified;
  const out: DeyeSetting[] = [
    setting('Time of use', 'Use timer', {
      type: 'checkbox', reg: t.enable, codec: { kind: 'bit', mask: 1 }, verified: v,
      help: 'Use the program below ("Use timer" on the inverter).',
      note: `holding ${t.enable} bit 0 (${t.note})`,
    }),
    ...WEEKDAYS.map((day, i) =>
      setting('Time of use', `Time of use ${day}`, {
        type: 'checkbox', reg: t.enable, codec: { kind: 'bit', mask: 2 << i }, verified: v,
        note: `holding ${t.enable} bit ${i + 1} (${t.note})`,
      }),
    ),
  ];
  for (let n = 1; n <= 6; n++) {
    const i = n - 1;
    out.push(
      setting('Time of use', `Time point ${n}`, {
        type: 'time', reg: t.time + i, codec: { kind: 'hhmm' }, verified: v,
        help: n === 1 ? 'Each point runs until the next point starts.' : undefined,
        note: `holding ${t.time + i} HHMM decimal (${t.note})`,
      }),
      setting('Time of use', `Power point ${n}`, {
        type: 'number', reg: t.power + i, codec: { kind: 'number' }, unit: 'W', min: 0, max: t.maxPower, step: 10, verified: v,
        note: `holding ${t.power + i} W (${t.note})`,
      }),
      setting('Time of use', `Voltage point ${n}`, {
        type: 'number', reg: t.voltage + i, codec: { kind: 'number', scale: 0.01 }, unit: 'V', min: 0, max: 100, step: 0.1,
        help: 'Shown for reference; only used when Battery operation is "Voltage".',
        note: `holding ${t.voltage + i} 0.01 V — read-only: only used with Battery operation "Voltage"`,
      }),
      setting('Time of use', `Capacity point ${n}`, {
        type: 'number', reg: t.soc + i, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1, verified: v,
        note: `holding ${t.soc + i} SOC % (${t.note})`,
      }),
      setting('Time of use', `Grid charge point ${n}`, {
        type: 'checkbox', reg: t.charge + i, codec: { kind: 'bit', mask: 1 }, verified: v,
        note: `holding ${t.charge + i} bit 0 (${t.note})`,
      }),
      setting('Time of use', `Gen charge point ${n}`, {
        type: 'checkbox', reg: t.charge + i, codec: { kind: 'bit', mask: 2 }, verified: v,
        note: `holding ${t.charge + i} bit 1 (${t.note})`,
      }),
    );
  }
  return out;
}
