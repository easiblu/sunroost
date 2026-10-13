/**
 * What each Felicity register family provides to the shared driver, and the product-information
 * block at 0xF800 that every Felicity protocol seen so far shares.
 *
 * Info block (holding, fn 3):
 *   0xF800 device type       — confident (IVEM doc: 0x50 = high-frequency inverter; an IVGM-15K
 *                              reported 84 = 0x54 per community field data, UNVERIFIED for others)
 *   0xF801 device subtype    — confident on IVEM (0x0204 = 3024, 0x0408 = 5048)
 *   0xF804–0xF808 serial     — confident on IVEM: five words, each four decimal digits
 *                              (e.g. 0135 4820 2500 0100 0000 → "01354820250001", 14 digits)
 *   0xF809 serial length     — UNVERIFIED: only in the newer RS485 (IVGM / T-REX HP) document
 *   0xF80B CPU1 firmware     — confident on IVEM: hundredths (103 → 1.03), 0xFFFF = invalid
 *   0xF80C CPU2 firmware     — confident on IVEM, as CPU1
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { Metrics } from '../../../core/metrics.ts';
import type { SocControl } from '../../types.ts';
import type { RegDef, RegisterImage } from './registers.ts';
import type { FelicitySetting } from './settings.ts';

export interface FelicityFamily {
  id: string;
  /** Model option name and "Model name" fallback. */
  name: string;
  /** Holding spans [start, count] read on every poll (each ≤125). */
  blocks: [number, number][];
  live: RegDef[];
  derive(raw: Metrics): Metrics;
  settings: FelicitySetting[];
  socControl: SocControl | null;
}

export const INFO_START = 0xf800;
export const INFO_COUNT = 16; // 0xF800–0xF80F
/** The smaller span the IVEM document defines, used when the full read is rejected. */
export const INFO_COUNT_MIN = 13; // 0xF800–0xF80C

export const DEVICE_TYPES: Record<number, string> = {
  0x50: 'high-frequency inverter (IVEM / IVPA)',
  0x54: 'three-phase hybrid (IVGM)',
};

/** Device type → model id (detect). 0x50 confident; 0x54 from one IVGM-15K report. */
export const TYPE_MODEL: Record<number, string> = { 0x50: 'ivem', 0x54: 'hv3' };

const IVEM_SUBTYPES: Record<number, string> = { 0x0204: 'IVEM3024', 0x0408: 'IVEM5048' };

/**
 * Serial from 0xF804–0xF808. Felicity packs four decimal digits per word; a firmware that stores
 * ASCII instead is accepted too. Returns '' for blank/0xFFFF data.
 */
export function decodeSerial(words: number[], length?: number): string {
  if (words.length < 5) return '';
  const w = words.slice(0, 5);
  if (w.every((x) => x === 0) || w.every((x) => x === 0xffff)) return '';
  if (w.every((x) => x <= 9999)) {
    const digits = w.map((x) => String(x).padStart(4, '0')).join('');
    const len = length && length >= 8 && length <= 20 ? length : 14;
    const sn = digits.slice(0, len);
    return /[1-9]/.test(sn) ? sn : '';
  }
  const text = regsToAscii(w);
  return plausibleId(text) ? text : '';
}

/** Firmware word in hundredths → "1.03"; '' when invalid. */
export function decodeVersion(word: number | undefined): string {
  if (word === undefined || word === 0 || word === 0xffff) return '';
  return (word / 100).toFixed(2);
}

/** Picks info metrics out of an image that holds (part of) 0xF800–0xF80F. */
export function decodeInfo(family: FelicityFamily, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': `Felicity ${family.name}` };
  const type = regs.get(0xf800);
  const sub = regs.get(0xf801);
  if (type === 0x50 && sub !== undefined && IVEM_SUBTYPES[sub]) out['Model name'] = `Felicity ${IVEM_SUBTYPES[sub]}`;
  const words = [0, 1, 2, 3, 4].map((i) => regs.get(0xf804 + i));
  if (words.every((w) => w !== undefined)) {
    const len = regs.get(0xf809);
    const sn = decodeSerial(words as number[], len);
    if (sn) out['Serial number'] = sn;
  }
  const cpu1 = decodeVersion(regs.get(0xf80b));
  const cpu2 = decodeVersion(regs.get(0xf80c));
  if (cpu1) out['Firmware version'] = cpu1;
  if (cpu2) out['Secondary firmware version'] = cpu2;
  return out;
}
