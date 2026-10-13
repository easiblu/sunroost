/**
 * Persisted automations (table `automations`, config stored as JSON) and conflict detection:
 * a setting on a given inverter may be controlled by only one enabled automation.
 */
import { db } from '../core/db.ts';
import type { SettingDef } from '../devices/types.ts';
import { ValidationError } from './conditions.ts';
import { directSettings, type Rule, type RuleConfig } from './rules.ts';
import { findDef, targetOf, type Automation, type AutomationConfig, type AutomationType } from './types.ts';

interface Row {
  id: number;
  type: string;
  enabled: number;
  name: string;
  config: string;
  created: number;
  updated: number;
}

export class ConflictError extends Error {}

export function initStore() {
  db().exec(`CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`);
}

function fromRow(r: Row): Automation | null {
  try {
    return {
      id: r.id,
      type: r.type as AutomationType,
      enabled: Boolean(r.enabled),
      name: r.name,
      config: JSON.parse(r.config) as AutomationConfig,
      created: r.created,
      updated: r.updated,
    };
  } catch {
    return null; // corrupt row: skip rather than break the engine
  }
}

export function all(): Automation[] {
  const rows = db().prepare(`SELECT * FROM automations ORDER BY id`).all() as unknown as Row[];
  return rows.map(fromRow).filter((a): a is Automation => a !== null);
}

export function get(id: number): Automation | null {
  const r = db().prepare(`SELECT * FROM automations WHERE id = ?`).get(id) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export const enabled = () => all().filter((a) => a.enabled);

/** Rows of the general "rule" type share the table; legacy code only sees the other types. */
export const isRule = (a: { type: string }) => a.type === 'rule';
export const legacy = () => all().filter((a) => !isRule(a));
export const rules = () => all().filter(isRule) as unknown as Rule[];
export const getRule = (id: number) => {
  const a = get(id);
  return a && isRule(a) ? (a as unknown as Rule) : null;
};
const legacyEnabled = () => legacy().filter((a) => a.enabled);

const overlaps = (a: number | null, b: number | null) => a === null || b === null || a === b;

/**
 * The enabled automation (other than `self`) that already controls the same setting on an
 * overlapping inverter, if any.
 */
export function findConflict(candidate: Pick<Automation, 'id' | 'type' | 'config'>): Automation | null {
  const setting = candidate.config.setting;
  const target = targetOf(candidate as Automation);
  return legacyEnabled().find((o) => o.id !== candidate.id && o.config.setting === setting && overlaps(targetOf(o), target)) ?? null;
}

export function conflictMessage(setting: string, defs: SettingDef[] = []) {
  const label = findDef(defs, setting)?.label ?? setting;
  return `Unable to enable automation. ${label} is already controlled by a different automation.`;
}

/** Settings (keys) controlled by enabled automations (rules: the settings their actions write directly). */
export const affectedSettings = () => [
  ...new Set([
    ...legacyEnabled().map((a) => a.config.setting),
    ...rules().filter((r) => r.enabled).flatMap((r) => directSettings(r.config).map((s) => s.setting)),
  ]),
];

export function add(type: AutomationType | 'rule', name: string, config: AutomationConfig | RuleConfig, isEnabled: boolean, now = Date.now()): Automation {
  const res = db()
    .prepare(`INSERT INTO automations (type, enabled, name, config, created, updated) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(type, isEnabled ? 1 : 0, name, JSON.stringify(config), now, now);
  return get(Number(res.lastInsertRowid))!;
}

export function update(id: number, changes: { name?: string; config?: AutomationConfig | RuleConfig; enabled?: boolean }, now = Date.now()): Automation {
  const cur = get(id);
  if (!cur) throw new ValidationError(`Automation #${id} not found`);
  const next = { ...cur, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as Automation;
  db()
    .prepare(`UPDATE automations SET enabled = ?, name = ?, config = ?, updated = ? WHERE id = ?`)
    .run(next.enabled ? 1 : 0, next.name, JSON.stringify(next.config), now, id);
  return get(id)!;
}

export function remove(id: number): boolean {
  return Number(db().prepare(`DELETE FROM automations WHERE id = ?`).run(id).changes) > 0;
}

/** Enables an automation after checking for a conflict; throws ConflictError with the UI message. */
export function enable(id: number, defs: SettingDef[] = []): Automation {
  const a = get(id);
  if (!a) throw new ValidationError(`Automation #${id} not found`);
  if (findConflict(a)) throw new ConflictError(conflictMessage(a.config.setting, defs));
  return update(id, { enabled: true });
}

export function disable(id: number): Automation {
  return update(id, { enabled: false });
}
