/**
 * What each Sumry register map provides to the shared driver, plus the read-only setting helper.
 *
 * The register-table machinery (RegDef, decodeTable, setting codecs) is shared with the Growatt
 * driver; only the tables differ. Everything on these inverters is a holding register (function 3).
 */
import type { Metrics } from '../../../core/metrics.ts';
import { decodeAscii, type RegDef, type RegisterImage } from '../growatt/registers.ts';
import { keyOf, type GrowattSetting } from '../growatt/settings.ts';

export type SumrySetting = GrowattSetting;

export interface SumryFamily {
  id: string;
  /** Shown as the model option and used as the "Model name" fallback. */
  name: string;
  /** Holding-register spans [start, count] read on every poll (each ≤125). */
  liveBlocks: [number, number][];
  liveMap: RegDef[];
  /** Holding-register spans read once on connect. */
  infoBlocks: [number, number][];
  infoMap: RegDef[];
  settings: SumrySetting[];
  /** Raw table values → Sunroost metrics. */
  derive(raw: Metrics): Metrics;
}

/**
 * Serial number: holding 186–197, ASCII, two characters per register, high byte first. Shared by
 * both maps (confident for the classic SMG-II map, from the public map and ESPHome configs; the
 * extended map lists the same range).
 */
export const SERIAL: RegDef = { addr: 186, type: 'ascii', words: 12, metric: 'Serial number', note: 'serial, 12 registers ASCII (confident)' };

/** Picks the info metrics out of a holding image. */
export function decodeInfo(family: SumryFamily, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': family.name };
  const words: number[] = [];
  for (let a = SERIAL.addr; a < SERIAL.addr + (SERIAL.words ?? 0); a++) {
    if (!regs.has(a)) break;
    words.push(regs.get(a)!);
  }
  const sn = words.length ? decodeAscii(words) : '';
  if (sn) out['Serial number'] = sn;
  return out;
}

const HELP = 'Read-only: Sumry register map not yet verified on hardware.';

/** Builds a setting. Every Sumry setting is read-only until checked on a real unit. */
export function setting(
  section: string,
  label: string,
  spec: Omit<SumrySetting, 'key' | 'label' | 'section' | 'verified' | 'readOnly'> & { key?: string },
): SumrySetting {
  const { key, ...rest } = spec;
  return { ...rest, key: key ?? keyOf(label), label, section, verified: false, readOnly: true, help: spec.help ?? HELP };
}
