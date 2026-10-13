/**
 * Felicity register tables and the small decoder that applies them.
 *
 * Every Felicity protocol uses holding registers only (function 3), big-endian words. A table row
 * names one register (or a pair) and the raw metric it feeds; each family's `derive` then turns the
 * raw values into Sunroost metrics.
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32';

export interface RegDef {
  /** Holding register address as sent on the wire. */
  addr: number;
  type?: RegType;
  /** Multiplier applied to the raw value, e.g. 0.1 for "0.1 V" registers, 10 for "0.01 kW". */
  scale?: number;
  /** Raw metric name. */
  metric: string;
  /** Raw value → text, for status registers. */
  enum?: Record<number, string>;
  /** Source and confidence: "confident" (vendor document) or "UNVERIFIED". */
  note: string;
}

/** A sparse register image: address → raw 16-bit word. */
export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

export const s16 = (w: number) => (w > 0x7fff ? w - 0x10000 : w);

function digitsFor(scale: number) {
  if (scale >= 1) return 0;
  return Math.min(4, Math.round(-Math.log10(scale)));
}

/** One row, or undefined when any of its registers is missing from the image. */
export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const wide = def.type === 'u32' || def.type === 's32';
  const hi = regs.get(def.addr);
  const lo = wide ? regs.get(def.addr + 1) : 0;
  if (hi === undefined || lo === undefined) return undefined;
  let raw: number;
  switch (def.type ?? 'u16') {
    case 's16':
      raw = s16(hi);
      break;
    case 'u32':
      raw = ((hi << 16) | lo) >>> 0;
      break;
    case 's32':
      raw = (hi << 16) | lo;
      break;
    default:
      raw = hi;
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (${raw})`;
  const scale = def.scale ?? 1;
  return scale === 1 ? raw : round(raw * scale, digitsFor(scale));
}

export function decodeTable(defs: RegDef[], regs: RegisterImage): Metrics {
  const out: Metrics = {};
  for (const def of defs) {
    const v = decodeOne(def, regs);
    if (v !== undefined) out[def.metric] = v;
  }
  return out;
}

/** A table value as a number (0 when absent or text). */
export const num = (m: Metrics, key: string) => (typeof m[key] === 'number' ? (m[key] as number) : 0);
export const has = (m: Metrics, key: string) => typeof m[key] === 'number';

/** Copies the listed keys from raw to out when present. */
export function copy(raw: Metrics, out: Metrics, keys: string[]) {
  for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k];
}
