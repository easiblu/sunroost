/**
 * Automation types, their config shapes, validation and pure evaluation.
 *
 * - table: a rule table controlling one setting. Rows are checked top to bottom and the
 *   first row whose conditions all match wins; its action value ("None" = leave alone) is applied.
 * - battery-soc: SOC control. Low/high thresholds at two points of the day, interpolated
 *   linearly between them (both ways round the clock). SOC ≤ low → grid value,
 *   SOC ≥ high → battery value, in between → keep (hysteresis).
 * - battery-protection: SOC ≤ N% → shutdown value; restore a chosen value once SOC ≥ N + hysteresis.
 */
import type { Value } from '../core/metrics.ts';
import type { SettingDef, SocControl } from '../devices/types.ts';
import {
  CONDITIONS, describeCondition, isConditionKind, localTime, matchCondition, normalizeCondition, parseNumber,
  ValidationError, type CondValue, type ConditionKind, type Inputs,
} from './conditions.ts';

export type AutomationType = 'table' | 'battery-soc' | 'battery-protection';

export const TYPE_NAMES: Record<AutomationType, string> = {
  table: 'Rule table',
  'battery-soc': 'Battery state of charge control',
  'battery-protection': 'Battery protection',
};

export const isAutomationType = (t: unknown): t is AutomationType => typeof t === 'string' && t in TYPE_NAMES;

/** Index of the inverter to control, or null for every inverter. */
export type InverterTarget = number | null;

export interface TableRow {
  /** One cell per condition dimension. */
  when: CondValue[];
  /** Value to set; null = "None" (leave unchanged). */
  value: Value;
}

export interface TableConfig {
  setting: string;
  inverter: InverterTarget;
  conditions: ConditionKind[];
  rows: TableRow[];
}

export interface SocConfig {
  setting: string;
  gridValue: Value;
  batteryValue: Value;
  hourA: number;
  lowA: number;
  highA: number;
  hourB: number;
  lowB: number;
  highB: number;
}

export interface ProtectionConfig {
  setting: string;
  soc: number;
  hysteresis: number;
  shutdownValue: Value;
  restoreValue: Value;
}

export type AutomationConfig = TableConfig | SocConfig | ProtectionConfig;

export interface Automation {
  id: number;
  type: AutomationType;
  enabled: boolean;
  name: string;
  config: AutomationConfig;
  created: number;
  updated: number;
}

/** What the engine knows about the running driver when validating or evaluating. */
export interface EngineContext {
  connected: boolean;
  modelName: string;
  inverterCount: number;
  /** Settings of inverter 1 (parallel inverters share a model). Empty when not connected. */
  defs: SettingDef[];
  socControl: SocControl | null;
  protection: { setting: string; shutdownValue: Value } | null;
}

// ---------- Values ----------

/** Case-insensitive comparison of setting values ("20" = 20, "true" = true). */
export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return a === b || (a == null && b == null);
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

const NONE = new Set(['none', '', '-', '—']);

/**
 * Normalizes an action value for a setting definition. Returns null for "None".
 * Without a definition (devices not connected) the raw value is kept as text/number/bool.
 */
export function normalizeValue(def: SettingDef | undefined, raw: unknown, allowNone = true): Value {
  if (raw === null || raw === undefined || (typeof raw === 'string' && NONE.has(raw.trim().toLowerCase()))) {
    if (allowNone) return null;
    throw new ValidationError(`Choose a value${def ? ` for '${def.label}'` : ''}.`);
  }
  if (!def) return typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw).trim();
  const text = String(raw).trim();
  switch (def.type) {
    case 'select': {
      const match = def.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      if (!match) throw new ValidationError(`Invalid value '${text}' for '${def.label}'. Valid values: ${def.options?.join(', ')}`);
      return match;
    }
    case 'number': {
      const n = parseNumber(raw);
      if (n === null) throw new ValidationError(`Enter a number for '${def.label}'.`);
      if (def.min !== undefined && n < def.min) throw new ValidationError(`'${def.label}' must be at least ${def.min}.`);
      if (def.max !== undefined && n > def.max) throw new ValidationError(`'${def.label}' must be at most ${def.max}.`);
      return n;
    }
    case 'checkbox': {
      const t = text.toLowerCase();
      if (['true', '1', 'on', 'yes', 'enabled'].includes(t)) return true;
      if (['false', '0', 'off', 'no', 'disabled'].includes(t)) return false;
      throw new ValidationError(`Invalid value '${text}' for '${def.label}'. Use enabled or disabled.`);
    }
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new ValidationError(`Invalid time '${text}' for '${def.label}'. Use HH:MM.`);
      return text;
    case 'slot': {
      const parts = text.split(',').map((p) => p.trim());
      const prio = Boolean(def.slotPriorities?.length);
      const n = prio ? 4 : 3;
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (parts.length !== n || !time.test(parts[0]) || !time.test(parts[1]) || !['true', 'false'].includes(parts[n - 1].toLowerCase())) {
        throw new ValidationError(`Invalid slot '${text}' for '${def.label}'. Use ${prio ? 'HH:MM,HH:MM,<priority>,true|false' : 'HH:MM,HH:MM,true|false'}.`);
      }
      if (prio) {
        const p = def.slotPriorities!.find((o) => o.toLowerCase() === parts[2].toLowerCase());
        if (!p) throw new ValidationError(`Invalid priority '${parts[2]}'. Valid values: ${def.slotPriorities!.join(', ')}`);
        parts[2] = p;
      }
      parts[n - 1] = parts[n - 1].toLowerCase();
      return parts.join(',');
    }
  }
}

export function fmtValue(def: SettingDef | undefined, v: Value): string {
  if (v === null) return 'None';
  if (def?.type === 'checkbox') return v === true || v === 'true' ? 'Enabled' : 'Disabled';
  return `${v}${def?.unit && def.type === 'number' ? ' ' + def.unit : ''}`;
}

export const findDef = (defs: SettingDef[], keyOrLabel: string) =>
  defs.find((d) => d.key === keyOrLabel || d.label.toLowerCase() === keyOrLabel.toLowerCase());

/** Settings an automation may control: everything writable. */
export const controllable = (defs: SettingDef[]) => defs.filter((d) => !d.readOnly);

// ---------- Config validation ----------

function int(raw: unknown, label: string, min: number, max: number): number {
  const n = parseNumber(raw);
  if (n === null || !Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function resolveSetting(raw: unknown, ctx: EngineContext): { key: string; def?: SettingDef } {
  const text = String(raw ?? '').trim();
  if (!text) throw new ValidationError('Choose a setting to control.');
  if (!ctx.defs.length) return { key: text };
  const def = findDef(ctx.defs, text);
  if (!def) throw new ValidationError(`"${text}" is not a setting of ${ctx.modelName || 'this inverter'}.`);
  if (def.readOnly) throw new ValidationError(`"${def.label}" is read-only.`);
  return { key: def.key, def };
}

function inverterTarget(raw: unknown, ctx: EngineContext): InverterTarget {
  if (raw === null || raw === undefined || raw === '' || raw === 'all') return null;
  const n = int(raw, 'Inverter', 0, 63);
  if (ctx.connected && n >= ctx.inverterCount) throw new ValidationError(`Inverter ${n + 1} does not exist.`);
  return n;
}

export function normalizeTable(raw: Record<string, unknown>, ctx: EngineContext): TableConfig {
  const { key, def } = resolveSetting(raw.setting, ctx);
  const conds = Array.isArray(raw.conditions) ? raw.conditions.filter((c) => c !== null && c !== '' && c !== undefined) : [];
  if (conds.length < 1 || conds.length > 2) throw new ValidationError('Choose one or two conditions.');
  for (const c of conds) if (!isConditionKind(c)) throw new ValidationError(`Unknown condition '${c}'.`);
  const conditions = conds as ConditionKind[];
  if (conditions.length === 2 && conditions[0] === conditions[1]) throw new ValidationError('Choose two different conditions.');
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  if (rawRows.length > 50) throw new ValidationError('A rule table can have at most 50 rows.');
  const rows: TableRow[] = rawRows.map((r: unknown, i: number) => {
    const row = (r ?? {}) as { when?: unknown[]; value?: unknown };
    try {
      return {
        when: conditions.map((k, j) => normalizeCondition(k, Array.isArray(row.when) ? row.when[j] : null)),
        value: normalizeValue(def, row.value),
      };
    } catch (err) {
      throw new ValidationError(`Row ${i + 1}: ${(err as Error).message}`);
    }
  });
  return { setting: key, inverter: inverterTarget(raw.inverter, ctx), conditions, rows };
}

export function normalizeSoc(raw: Record<string, unknown>, ctx: EngineContext): SocConfig {
  const sc = ctx.socControl;
  const setting = String(raw.setting ?? sc?.setting ?? '');
  const { key, def } = resolveSetting(setting, ctx);
  const cfg: SocConfig = {
    setting: key,
    gridValue: normalizeValue(def, raw.gridValue ?? sc?.gridValue, false),
    batteryValue: normalizeValue(def, raw.batteryValue ?? sc?.batteryValue, false),
    hourA: int(raw.hourA ?? 6, 'Point A hour', 0, 23),
    lowA: int(raw.lowA ?? 30, 'Point A low', 0, 100),
    highA: int(raw.highA ?? 50, 'Point A high', 0, 100),
    hourB: int(raw.hourB ?? 18, 'Point B hour', 0, 23),
    lowB: int(raw.lowB ?? 50, 'Point B low', 0, 100),
    highB: int(raw.highB ?? 80, 'Point B high', 0, 100),
  };
  if (cfg.lowA >= cfg.highA) throw new ValidationError('Point A: the low threshold must be below the high threshold.');
  if (cfg.lowB >= cfg.highB) throw new ValidationError('Point B: the low threshold must be below the high threshold.');
  if (sameValue(cfg.gridValue, cfg.batteryValue)) throw new ValidationError('The grid and battery values must differ.');
  return cfg;
}

export function normalizeProtection(raw: Record<string, unknown>, ctx: EngineContext): ProtectionConfig {
  const pd = ctx.protection;
  const { key, def } = resolveSetting(raw.setting ?? pd?.setting, ctx);
  const shutdown = raw.shutdownValue ?? (pd && pd.setting === key ? pd.shutdownValue : undefined);
  const cfg: ProtectionConfig = {
    setting: key,
    soc: int(raw.soc ?? 10, 'State of charge', 1, 95),
    hysteresis: int(raw.hysteresis ?? 5, 'Hysteresis', 1, 50),
    shutdownValue: normalizeValue(def, shutdown, false),
    restoreValue: normalizeValue(def, raw.restoreValue ?? (ctx.socControl?.setting === key ? ctx.socControl.batteryValue : undefined), false),
  };
  if (cfg.soc + cfg.hysteresis > 100) throw new ValidationError('State of charge plus hysteresis must not exceed 100%.');
  if (sameValue(cfg.shutdownValue, cfg.restoreValue)) throw new ValidationError('The shutdown and restore values must differ.');
  return cfg;
}

export function normalizeConfig(type: AutomationType, raw: unknown, ctx: EngineContext): AutomationConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (type === 'table') return normalizeTable(r, ctx);
  if (type === 'battery-soc') return normalizeSoc(r, ctx);
  return normalizeProtection(r, ctx);
}

export const targetOf = (a: Automation): InverterTarget => (a.type === 'table' ? (a.config as TableConfig).inverter : null);

// ---------- Evaluation ----------

export interface Decision {
  setting: string;
  /** Value to apply; null = leave the setting as it is. */
  value: Value;
  /** Why, e.g. "Battery SOC 18% ≤ 20%". */
  reason: string;
  /** Rule table: index of the active row, -1 when none matches. */
  activeRow?: number;
  /** Battery protection: whether the shutdown is in effect after this evaluation. */
  tripped?: boolean;
  /** SOC control: thresholds at the current time. */
  thresholds?: { low: number; high: number };
}

export function evaluateTable(cfg: TableConfig, inputs: Inputs): Decision {
  const lt = localTime(inputs.now, inputs.tz);
  for (let i = 0; i < cfg.rows.length; i++) {
    const row = cfg.rows[i];
    const results = cfg.conditions.map((k, j) => matchCondition(k, row.when[j] ?? null, inputs, lt));
    if (results.every((r) => r.match)) {
      const reason = results.map((r) => r.text).filter(Boolean).join(', ') || `Row ${i + 1} (any)`;
      return { setting: cfg.setting, value: row.value, reason, activeRow: i };
    }
  }
  return { setting: cfg.setting, value: null, reason: 'No row matches', activeRow: -1 };
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Low/high thresholds at a (fractional) hour of day. Moving forward from A to B the thresholds
 * blend from A's to B's, and from B back round to A they blend back, so the curve is continuous.
 */
export function socThresholds(cfg: SocConfig, hour: number): { low: number; high: number } {
  if (cfg.hourA === cfg.hourB) return { low: cfg.lowA, high: cfg.highA };
  const spanAB = (cfg.hourB - cfg.hourA + 24) % 24;
  const t = (((hour - cfg.hourA) % 24) + 24) % 24;
  if (t <= spanAB) {
    const f = t / spanAB;
    return { low: r1(lerp(cfg.lowA, cfg.lowB, f)), high: r1(lerp(cfg.highA, cfg.highB, f)) };
  }
  const f = (t - spanAB) / (24 - spanAB);
  return { low: r1(lerp(cfg.lowB, cfg.lowA, f)), high: r1(lerp(cfg.highB, cfg.highA, f)) };
}

/** 24 hourly thresholds for the diagram (index = hour). */
export function socDiagram(cfg: SocConfig): { low: number[]; high: number[] } {
  const low: number[] = [];
  const high: number[] = [];
  for (let h = 0; h < 24; h++) {
    const t = socThresholds(cfg, h);
    low.push(t.low);
    high.push(t.high);
  }
  return { low, high };
}

export function evaluateSoc(cfg: SocConfig, inputs: Inputs): Decision {
  const lt = localTime(inputs.now, inputs.tz);
  const th = socThresholds(cfg, lt.hour);
  const base = { setting: cfg.setting, thresholds: th };
  const soc = inputs.soc;
  if (soc === null) return { ...base, value: null, reason: 'Battery SOC unknown' };
  if (soc <= th.low) return { ...base, value: cfg.gridValue, reason: `Battery SOC ${soc}% ≤ ${th.low}%` };
  if (soc >= th.high) return { ...base, value: cfg.batteryValue, reason: `Battery SOC ${soc}% ≥ ${th.high}%` };
  return { ...base, value: null, reason: `Battery SOC ${soc}% between ${th.low}% and ${th.high}%, keeping current value` };
}

/** `tripped` is whether the shutdown is currently in effect (runtime state kept by the runner). */
export function evaluateProtection(cfg: ProtectionConfig, inputs: Inputs, tripped: boolean): Decision {
  const base = { setting: cfg.setting };
  const soc = inputs.soc;
  const recover = cfg.soc + cfg.hysteresis;
  if (soc === null) return { ...base, value: tripped ? cfg.shutdownValue : null, tripped, reason: 'Battery SOC unknown' };
  if (soc <= cfg.soc) return { ...base, value: cfg.shutdownValue, tripped: true, reason: `Battery SOC ${soc}% ≤ ${cfg.soc}%` };
  if (tripped && soc >= recover) return { ...base, value: cfg.restoreValue, tripped: false, reason: `Battery SOC ${soc}% recovered to ≥ ${recover}%` };
  if (tripped) return { ...base, value: cfg.shutdownValue, tripped: true, reason: `Battery SOC ${soc}% below ${recover}%, waiting to recover` };
  return { ...base, value: null, tripped: false, reason: `Battery SOC ${soc}% above ${cfg.soc}%` };
}

export function evaluate(a: Automation, inputs: Inputs, tripped = false): Decision {
  if (a.type === 'table') return evaluateTable(a.config as TableConfig, inputs);
  if (a.type === 'battery-soc') return evaluateSoc(a.config as SocConfig, inputs);
  return evaluateProtection(a.config as ProtectionConfig, inputs, tripped);
}

/** Human summary of a table cell for logs and the API. */
export function describeRow(cfg: TableConfig, row: TableRow): string[] {
  return cfg.conditions.map((k, j) => `${CONDITIONS[k].label}: ${describeCondition(k, row.when[j] ?? null)}`);
}
