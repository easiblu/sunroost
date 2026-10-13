/**
 * What each Megarevo-protocol model family provides to the shared driver, plus small helpers.
 *
 * Register tables reuse the Growatt table format and decoder (16-bit words, 32-bit values HIGH word
 * first, ASCII two characters per register); settings reuse the Deye setting/codec helpers. Every
 * register this driver touches is a holding register read with function 3.
 */
import type { Metrics } from '../../../core/metrics.ts';
import { type DeyeSetting } from '../deye/settings.ts';
import { decodeTable, image, planReads, type RegDef, type RegisterImage } from '../growatt/registers.ts';

export { decodeTable, image, planReads, type RegDef, type RegisterImage };

export interface AsciiField {
  metric: string;
  addr: number;
  words: number;
  note: string;
}

/** Read requests for the info registers and ASCII fields. */
export function infoPlan(f: Pick<MegarevoFamily, 'infoMap' | 'asciiInfo'>): [number, number][] {
  return planReads(
    [...f.infoMap.map((d): [number, number] => [d.addr, 1]), ...f.asciiInfo.map((a): [number, number] => [a.addr, a.words])],
    30,
  );
}

/** Decodes the info image into raw values (numbers by table, text by flexAscii). */
export function decodeInfoRaw(f: Pick<MegarevoFamily, 'infoMap' | 'asciiInfo'>, regs: RegisterImage): Metrics {
  const out = decodeTable(f.infoMap, regs);
  for (const a of f.asciiInfo) {
    const words: number[] = [];
    for (let i = 0; i < a.words; i++) words.push(regs.get(a.addr + i) ?? 0);
    if (a.words && words.some((w) => w !== 0)) out[a.metric] = flexAscii(words);
  }
  return out;
}

export interface MegarevoFamily {
  id: string;
  /** Model option text and "Model name" fallback. */
  name: string;
  /** Live holding registers read on every poll. */
  liveMap: RegDef[];
  /** Raw table values → Sunroost metrics. */
  derive(raw: Metrics): Metrics;
  /** Numeric info holding registers, read once on connect (each request's failure is tolerated). */
  infoMap: RegDef[];
  /** ASCII info fields (serial, model), decoded with flexAscii into raw metric `metric`. */
  asciiInfo: AsciiField[];
  /** Raw info table values → "Serial number", "Model name", "Firmware version" … */
  decodeInfo(raw: Metrics): Metrics;
  /** Shown read-only: nothing on this protocol is verified on hardware yet. */
  settings: DeyeSetting[];
}

/** Read requests for a table. Gaps up to 30 registers are read through (one round trip is dearer). */
export function planTable(defs: RegDef[], maxGap = 30): [number, number][] {
  return planReads(
    defs.map((d) => [d.addr, d.type === 'ascii' ? d.words ?? 1 : d.type === 'u32' || d.type === 's32' ? 2 : 1]),
    maxGap,
  );
}

/**
 * ASCII held either two characters per register (high byte first) or one character per register
 * (low byte, high byte 0); INVT documents its 16-register serial ambiguously, so both are accepted.
 */
export function flexAscii(words: number[]): string {
  const oneCharPerWord = words.some((w) => w !== 0) && words.every((w) => w >> 8 === 0);
  const bytes = oneCharPerWord ? words.map((w) => w & 0xff) : words.flatMap((w) => [w >> 8, w & 0xff]);
  return bytes
    .map((c) => String.fromCharCode(c))
    .join('')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

/** Bit names set in `word`, e.g. a fault word against its bit table. */
export function bitNames(word: number, names: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (let b = 0; b < 16; b++) if (word & (1 << b) && names[b]) out.push(names[b]!);
  return out;
}
