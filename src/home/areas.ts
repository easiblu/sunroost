/** Rooms ("areas" in Home Assistant): a name and an icon. Devices and entities point at one by id. */
import { db } from '../core/db.ts';
import * as registry from './registry.ts';
import { objectIdFrom } from './types.ts';

export interface Area {
  id: string;
  name: string;
  /** Lucide icon name. */
  icon: string;
  createdAt: number;
}

const areas = new Map<string, Area>();

export function init() {
  db().exec(`CREATE TABLE IF NOT EXISTS home_areas (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  areas.clear();
  for (const row of db().prepare(`SELECT data FROM home_areas`).all() as { data: string }[]) {
    const a = JSON.parse(row.data) as Area;
    areas.set(a.id, a);
  }
}

const save = (a: Area) => db().prepare(`INSERT OR REPLACE INTO home_areas (id, data) VALUES (?, ?)`).run(a.id, JSON.stringify(a));

export const list = () => [...areas.values()].sort((a, b) => a.name.localeCompare(b.name));
export const get = (id: string) => areas.get(id) ?? null;

/** Fails (null) when another room already has this name. */
export function create(name: string, icon = 'house', now = Date.now()): Area | null {
  if (list().some((a) => a.name.toLowerCase() === name.toLowerCase())) return null;
  const base = objectIdFrom(name);
  let id = base;
  for (let n = 2; areas.has(id); n++) id = `${base}_${n}`;
  const a: Area = { id, name, icon, createdAt: now };
  areas.set(id, a);
  save(a);
  return a;
}

export function update(id: string, changes: { name?: string; icon?: string }): Area | null {
  const a = areas.get(id);
  if (!a) return null;
  if (changes.name && list().some((x) => x.id !== id && x.name.toLowerCase() === changes.name!.toLowerCase())) return null;
  const next = { ...a, ...changes };
  areas.set(id, next);
  save(next);
  return next;
}

export function remove(id: string): boolean {
  if (!areas.delete(id)) return false;
  db().prepare(`DELETE FROM home_areas WHERE id = ?`).run(id);
  registry.clearArea(id);
  return true;
}
