/**
 * Scenes: named sets of inverter setting values applied together (by hand or from a rule's
 * `scene` action). Stored in `automation_scenes`; applying lives in the engine.
 */
import { db } from '../core/db.ts';
import type { Value } from '../core/metrics.ts';
import type { SettingDef } from '../devices/types.ts';
import { parseNumber, ValidationError } from './conditions.ts';
import { resolveSetting, type Target } from './rules.ts';
import { normalizeValue } from './types.ts';

export const SCENE_COLORS = ['solar', 'load', 'grid', 'battery', 'accent'] as const;
export type SceneColor = (typeof SCENE_COLORS)[number];

export interface SceneSetting {
  inverter: Target;
  setting: string;
  value: Value;
}

export interface Scene {
  id: number;
  name: string;
  icon: string;
  color: SceneColor;
  settings: SceneSetting[];
  created: number;
  updated: number;
}

export function initScenes() {
  db().exec(`CREATE TABLE IF NOT EXISTS automation_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
    settings TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
  )`);
}

interface Row {
  id: number;
  name: string;
  icon: string;
  color: string;
  settings: string;
  created: number;
  updated: number;
}

function fromRow(r: Row): Scene | null {
  try {
    return { ...r, color: r.color as SceneColor, settings: JSON.parse(r.settings) };
  } catch {
    return null;
  }
}

export function allScenes(): Scene[] {
  return (db().prepare(`SELECT * FROM automation_scenes ORDER BY id`).all() as unknown as Row[]).map(fromRow).filter((s): s is Scene => s !== null);
}

export function getScene(id: number): Scene | null {
  const r = db().prepare(`SELECT * FROM automation_scenes WHERE id = ?`).get(id) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export interface SceneContext {
  connected: boolean;
  modelName: string;
  inverterCount: number;
  defs: SettingDef[];
}

export function normalizeScene(raw: unknown, ctx: SceneContext): Omit<Scene, 'id' | 'created' | 'updated'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim().slice(0, 60);
  if (!name) throw new ValidationError('Enter a name for the scene.');
  const icon = String(r.icon ?? 'sparkles').trim() || 'sparkles';
  if (!/^[a-z0-9-]{1,40}$/.test(icon)) throw new ValidationError(`Invalid icon '${icon}'. Use a Lucide icon name.`);
  const color = String(r.color ?? 'accent');
  if (!(SCENE_COLORS as readonly string[]).includes(color)) throw new ValidationError(`Color must be one of: ${SCENE_COLORS.join(', ')}.`);
  const list = Array.isArray(r.settings) ? r.settings : [];
  if (!list.length) throw new ValidationError('Add at least one setting to the scene.');
  if (list.length > 50) throw new ValidationError('A scene can have at most 50 settings.');
  const settings = list.map((item, i): SceneSetting => {
    const s = (item ?? {}) as Record<string, unknown>;
    const label = `Setting ${i + 1}`;
    const { key, def } = resolveSetting(s.setting, ctx.defs, ctx.modelName, label);
    let inverter: Target = 'all';
    if (s.inverter !== undefined && s.inverter !== null && s.inverter !== '' && s.inverter !== 'all') {
      const n = parseNumber(s.inverter);
      if (n === null || !Number.isInteger(n) || n < 0 || n > 63) throw new ValidationError(`${label}: invalid inverter.`);
      if (ctx.connected && n >= ctx.inverterCount) throw new ValidationError(`${label}: inverter ${n + 1} does not exist.`);
      inverter = n;
    }
    try {
      return { inverter, setting: key, value: normalizeValue(def, s.value, false) };
    } catch (err) {
      throw new ValidationError(`${label}: ${(err as Error).message}`);
    }
  });
  return { name, icon, color: color as SceneColor, settings };
}

export function addScene(s: Omit<Scene, 'id' | 'created' | 'updated'>, now = Date.now()): Scene {
  const res = db()
    .prepare(`INSERT INTO automation_scenes (name, icon, color, settings, created, updated) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(s.name, s.icon, s.color, JSON.stringify(s.settings), now, now);
  return getScene(Number(res.lastInsertRowid))!;
}

export function updateScene(id: number, s: Omit<Scene, 'id' | 'created' | 'updated'>, now = Date.now()): Scene {
  db()
    .prepare(`UPDATE automation_scenes SET name = ?, icon = ?, color = ?, settings = ?, updated = ? WHERE id = ?`)
    .run(s.name, s.icon, s.color, JSON.stringify(s.settings), now, id);
  return getScene(id)!;
}

export function removeScene(id: number): boolean {
  return Number(db().prepare(`DELETE FROM automation_scenes WHERE id = ?`).run(id).changes) > 0;
}
