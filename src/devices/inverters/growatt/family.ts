/** What each Growatt model family module provides to the shared driver. */
import type { Metrics } from '../../../core/metrics.ts';
import type { SocControl } from '../../types.ts';
import { decodeAscii, type RegDef, type RegisterImage } from './registers.ts';
import type { GrowattSetting } from './settings.ts';

export interface GrowattFamily {
  id: string;
  /** Shown as the model option and used as the "Model name" fallback. */
  name: string;
  /** Input-register (fn 4) spans [start, count] read on every poll. Each must be ≤125 registers. */
  inputBlocks: [number, number][];
  /** Input-register table. */
  inputMap: RegDef[];
  /** Holding-register table for info and console decoding (not settings). */
  holdingMap: RegDef[];
  settings: GrowattSetting[];
  /** Raw table values (from inputMap) → Sunroost metrics. */
  derive(raw: Metrics): Metrics;
  socControl: SocControl | null;
  protection: { setting: string; shutdownValue: string } | null;
}

/**
 * Info registers shared by every Growatt protocol (holding, fn 3). Read once on connect.
 * Firmware 9–11 and serial 23–27 are in both the OffGrid SPF and the V1.2x storage protocol (fairly
 * confident). Newer TL-X/TL-XH units also carry a 30-char serial at 3001–3015 (UNVERIFIED, not used).
 */
export const INFO_HOLDING: RegDef[] = [
  { addr: 9, type: 'ascii', words: 3, metric: 'Firmware version', note: 'Fw version H/M/L, ASCII' },
  { addr: 12, type: 'ascii', words: 3, metric: 'Secondary firmware version', note: 'Control Fw version, ASCII' },
  { addr: 23, type: 'ascii', words: 5, metric: 'Serial number', note: 'Serial NO, 10 ASCII chars' },
  { addr: 28, type: 'u32', metric: 'Module code', note: 'Module H/L (model code) — informational' },
  { addr: 43, metric: 'Device type code', note: 'DTC — UNVERIFIED on SPF' },
];
export const INFO_SPAN: [number, number] = [0, 44];

/** Picks the info metrics out of a holding image. */
export function decodeInfo(family: GrowattFamily, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': `Growatt ${family.name}` };
  const fw = regs.has(9) ? decodeAscii([9, 10, 11].map((a) => regs.get(a) ?? 0)) : '';
  const fw2 = regs.has(12) ? decodeAscii([12, 13, 14].map((a) => regs.get(a) ?? 0)) : '';
  const sn = regs.has(23) ? decodeAscii([23, 24, 25, 26, 27].map((a) => regs.get(a) ?? 0)) : '';
  if (fw) out['Firmware version'] = fw;
  if (fw2) out['Secondary firmware version'] = fw2;
  if (sn) out['Serial number'] = sn;
  return out;
}
