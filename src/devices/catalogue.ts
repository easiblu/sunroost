/**
 * The brand catalogue: every inverter brand/series we know of, which driver and model serve it,
 * and how well. Lets users pick "PowMr HVM P-series" without knowing it speaks SRNE.
 */
import { CATALOGUE, type CatalogueRow } from './catalogue-data.ts';
import { inverterDriver } from './registry.ts';

/**
 * supported — a driver and model exist; read-only — readings only, settings can't be changed yet;
 * planned — the protocol is known but has no driver yet; auto — protocol unknown, use auto-detect.
 */
export type Support = 'supported' | 'read-only' | 'planned' | 'auto';

export interface CatalogueEntry {
  brand: string;
  series: string;
  models: string[];
  protocol: string | null;
  driverId: string | null;
  modelId: string | null;
  connections: string[];
  support: Support;
}

/** Protocol id → our driver id, where they differ. */
const DRIVER_FOR: Record<string, string> = {};

export function resolve(row: CatalogueRow): CatalogueEntry {
  const base = { brand: row.b, series: row.s, models: row.n, protocol: row.p, connections: row.c };
  if (!row.p) return { ...base, driverId: null, modelId: null, support: 'auto' };
  const driverId = DRIVER_FOR[row.p] ?? row.p;
  const desc = inverterDriver(driverId);
  const modelId = row.m ?? (desc?.models?.length ? null : '');
  if (!desc || modelId === null) return { ...base, driverId: desc ? driverId : null, modelId: null, support: 'planned' };
  const readOnly = desc.readOnly === true || (desc.readOnlyModels?.includes(modelId) ?? false);
  return { ...base, driverId, modelId: modelId || null, support: readOnly ? 'read-only' : 'supported' };
}

export function catalogue(): CatalogueEntry[] {
  return CATALOGUE.map(resolve);
}

/** Counts per support level, by series and by brand (a brand counts as its best series). */
export function coverage() {
  const rows = catalogue();
  const rank: Support[] = ['supported', 'read-only', 'auto', 'planned'];
  const best = new Map<string, Support>();
  for (const r of rows) {
    const cur = best.get(r.brand);
    if (!cur || rank.indexOf(r.support) < rank.indexOf(cur)) best.set(r.brand, r.support);
  }
  const count = (list: Support[]) => Object.fromEntries(rank.map((s) => [s, list.filter((x) => x === s).length]));
  return { series: count(rows.map((r) => r.support)), brands: count([...best.values()]) };
}
