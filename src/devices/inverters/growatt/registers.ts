/**
 * Declarative Growatt register tables and the generic decoder that applies them.
 *
 * Every table row names one register (or register pair) and the metric it feeds. Family modules
 * decode a poll with `decodeTable`, then derive the Sunroost metrics (grid/battery balance,
 * device mode text …) from those raw values.
 */
import { round, type Metrics } from '../../../core/metrics.ts';

export type RegType = 'u16' | 's16' | 'u32' | 's32' | 'ascii';

export interface RegDef {
  /** Register address (protocol numbering, 0-based, as sent on the wire). */
  addr: number;
  type?: RegType;
  /** Number of registers for 'ascii' (two characters per register). */
  words?: number;
  /** Multiplier applied to the raw value, e.g. 0.1 for "0.1 V" registers. */
  scale?: number;
  /** Metric (or raw value) name this register is decoded into. */
  metric: string;
  /** Raw value → text, for status registers. */
  enum?: Record<number, string>;
  /** Confidence / source note. Anything not checked against a protocol PDF says UNVERIFIED. */
  note?: string;
}

/** A sparse register image: address → raw 16-bit value. */
export type RegisterImage = Map<number, number>;

export function image(start: number, values: number[], into: RegisterImage = new Map()): RegisterImage {
  values.forEach((v, i) => into.set(start + i, v & 0xffff));
  return into;
}

export function wordCount(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32' || def.type === 's32' ? 2 : 1;
}

function digitsFor(scale: number) {
  if (scale >= 1) return 0;
  return Math.min(4, Math.round(-Math.log10(scale)));
}

export function decodeAscii(words: number[]) {
  let text = '';
  for (const w of words) text += String.fromCharCode((w >> 8) & 0xff, w & 0xff);
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

/** Decodes one table row from an image, or undefined if any of its registers is missing. */
export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const n = wordCount(def);
  const words: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = regs.get(def.addr + i);
    if (w === undefined) return undefined;
    words.push(w);
  }
  if (def.type === 'ascii') return decodeAscii(words);
  let raw: number;
  switch (def.type ?? 'u16') {
    case 's16':
      raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
      break;
    case 'u32':
      raw = ((words[0] << 16) | words[1]) >>> 0;
      break;
    case 's32':
      raw = (words[0] << 16) | words[1];
      break;
    default:
      raw = words[0];
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (${raw})`;
  const scale = def.scale ?? 1;
  return scale === 1 ? raw : round(raw * scale, digitsFor(scale));
}

/** Decodes every table row whose registers are all present in the image. */
export function decodeTable(defs: RegDef[], regs: RegisterImage): Metrics {
  const out: Metrics = {};
  for (const def of defs) {
    const v = decodeOne(def, regs);
    if (v !== undefined) out[def.metric] = v;
  }
  return out;
}

/**
 * Splits a list of register spans into read requests: neighbouring spans are merged when the gap
 * is small, and no request exceeds `max` registers.
 */
export function planReads(spans: [number, number][], maxGap = 8, max = 125): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, count] of sorted) {
    const end = start + count;
    const last = out[out.length - 1];
    if (last && start <= last[0] + last[1] + maxGap && end - last[0] <= max) {
      last[1] = Math.max(last[1], end - last[0]);
    } else out.push([start, count]);
  }
  return out;
}

/** Number helper for derived metrics: a table value as a number (0 when absent or text). */
export const num = (m: Metrics, key: string) => (typeof m[key] === 'number' ? (m[key] as number) : 0);
export const has = (m: Metrics, key: string) => typeof m[key] === 'number';
