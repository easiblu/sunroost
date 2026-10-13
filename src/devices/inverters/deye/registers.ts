/**
 * Declarative Deye / Sunsynk register tables and the decoder that applies them.
 *
 * Deye differs from Growatt in three ways that the table handles:
 *  - 32-bit values are stored LOW word first ('u32le' / 's32le').
 *  - Temperatures carry a +1000 offset in 0.1 °C units (raw 1250 → 25.0 °C), via `offset`.
 *  - Everything (live readings, info and settings) is a holding register (function 3).
 *
 * The generic helpers (register image, ASCII decode, read-span planning) are shared with Growatt.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { decodeAscii, image, planReads, type RegisterImage } from '../growatt/registers.ts';

export { decodeAscii, image, planReads, type RegisterImage };

export type RegType = 'u16' | 's16' | 'u32le' | 's32le' | 'ascii';

export interface RegDef {
  /** Holding register address as sent on the wire (0-based). */
  addr: number;
  type?: RegType;
  /** Register count for 'ascii' (two characters per register). */
  words?: number;
  /** Subtracted from the raw value before scaling (Deye temperatures: 1000). */
  offset?: number;
  /** Multiplier applied after the offset, e.g. 0.1 for "0.1 V" registers. */
  scale?: number;
  /** Raw metric name the register is decoded into (the family's derive() turns these into SA metrics). */
  metric: string;
  enum?: Record<number, string>;
  /** Confidence / source note. Anything not cross-checked against the public map says UNVERIFIED. */
  note?: string;
}

export function wordCount(def: RegDef) {
  if (def.type === 'ascii') return def.words ?? 1;
  return def.type === 'u32le' || def.type === 's32le' ? 2 : 1;
}

function digitsFor(scale: number) {
  return scale >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(scale)));
}

/** Decodes one row, or undefined if any of its registers is missing from the image. */
export function decodeOne(def: RegDef, regs: RegisterImage): number | string | undefined {
  const words: number[] = [];
  for (let i = 0; i < wordCount(def); i++) {
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
    case 'u32le':
      raw = ((words[1] << 16) | words[0]) >>> 0;
      break;
    case 's32le':
      raw = (words[1] << 16) | words[0];
      break;
    default:
      raw = words[0];
  }
  if (def.enum) return def.enum[raw] ?? `Unknown (${raw})`;
  const scale = def.scale ?? 1;
  const v = (raw - (def.offset ?? 0)) * scale;
  return scale === 1 ? v : round(v, digitsFor(scale));
}

export function decodeTable(defs: RegDef[], regs: RegisterImage): Metrics {
  const out: Metrics = {};
  for (const def of defs) {
    const v = decodeOne(def, regs);
    if (v !== undefined) out[def.metric] = v;
  }
  return out;
}

/**
 * Deye reads are cheap per register but each request costs a full serial round trip (~50 ms at
 * 9600 baud), so close spans are merged generously: a 30-register gap costs about as much as a
 * second request.
 */
export const READ_GAP = 30;

/** Read requests covering every row of the given tables. */
export function planTable(defs: RegDef[], maxGap = READ_GAP): [number, number][] {
  return planReads(
    defs.map((d) => [d.addr, wordCount(d)]),
    maxGap,
  );
}

/**
 * Deye fault words (4 registers, 64 bits): bit n set means fault F(n+1), e.g. bit 12 → "F13".
 * Returns "None" when no bit is set.
 */
export function decodeFaults(words: number[]): string {
  const codes: string[] = [];
  words.forEach((w, i) => {
    for (let b = 0; b < 16; b++) if (w & (1 << b)) codes.push(`F${String(i * 16 + b + 1).padStart(2, '0')}`);
  });
  return codes.length ? codes.join(', ') : 'None';
}

/** Deye firmware words are shown as hex nibbles: 0x1234 → "1.2.3.4". */
export function decodeVersion(word: number): string {
  return [12, 8, 4, 0].map((s) => ((word >> s) & 0xf).toString(16).toUpperCase()).join('.');
}

export const num = (m: Metrics, key: string) => (typeof m[key] === 'number' ? (m[key] as number) : 0);
export const has = (m: Metrics, key: string) => typeof m[key] === 'number';
