/**
 * The general "rule" automation type (docs/AUTOMATIONS.md): triggers, nested condition groups,
 * actions, options. This module holds the config shapes, validation/normalization against the
 * connected driver, the human summary sentence, and pure condition evaluation with per-condition detail.
 */
import { meta, type Value } from '../core/metrics.ts';
import type { SettingDef, SettingValues } from '../devices/types.ts';
import { DAY_NAMES, localTime, parseNumber, parseTime, ValidationError } from './conditions.ts';
import { findDef, fmtValue, normalizeValue, sameValue } from './types.ts';
import { toMinutes } from './time.ts';

// ---------- Shapes ----------

export type CompareOp = 'above' | 'below';
export type Target = number | 'all';

export type Trigger =
  | { kind: 'time'; at: string; days?: number[] }
  | { kind: 'sun'; event: 'sunrise' | 'sunset'; offsetMinutes: number }
  | { kind: 'metric'; metric: string; op: CompareOp; value: number; forMinutes: number }
  | { kind: 'grid'; event: 'lost' | 'restored' }
  | { kind: 'price'; mode?: 'cheapest' | 'most_expensive'; hours?: number; op?: CompareOp; value?: number }
  | { kind: 'forecast'; at: string; metric: ForecastMetric; op: CompareOp; value: number }
  | { kind: 'alert'; alert?: string; level?: 'bad' | 'warn' }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'device'; entity: string; to?: string; from?: string; forMinutes: number }
  | { kind: 'manual' };

export type TriggerKind = Trigger['kind'];
export type ForecastMetric = 'tomorrow_sun' | 'today_sun';

export type Condition =
  | { kind: 'time_between'; from: string; to: string }
  | { kind: 'days'; days: number[] }
  | { kind: 'metric'; metric: string; op: 'above' | 'below' | 'between'; value: number; value2?: number }
  | { kind: 'grid'; available: boolean }
  | { kind: 'price'; op?: CompareOp; value?: number; cheapest_hours?: number }
  | { kind: 'sun'; is: 'up' | 'down' }
  | { kind: 'forecast'; metric: ForecastMetric; op: CompareOp; value: number }
  | { kind: 'setting'; inverter: Target; setting: string; equals: Value }
  | { kind: 'automation'; id: number; enabled: boolean }
  | { kind: 'date_between'; from: string; to: string }
  | { kind: 'device'; entity: string; is: string; not?: boolean };

export type ConditionKind = Condition['kind'];

export interface Group {
  op: 'and' | 'or';
  items: (Condition | Group)[];
}

export type Action =
  | { kind: 'set_setting'; inverter: Target; setting: string; value: Value }
  | { kind: 'scene'; scene: number }
  | { kind: 'notify'; channel: NotifyChannel; title: string; message: string }
  | { kind: 'mqtt'; topic: string; payload: string; retain: boolean }
  | { kind: 'delay'; minutes: number }
  | { kind: 'automation'; id: number; enabled: boolean }
  | DeviceAction;

/**
 * A command to smart devices (docs/SMART_HOME.md). `target` is an entity id, "role:<energy role>"
 * (e.g. every sheddable device) or "area:<room id>"; roles and rooms are resolved when the rule runs.
 */
export interface DeviceAction {
  kind: 'device';
  target: string;
  service: string;
  data: Record<string, unknown>;
  /** Protected devices (transfer switch, chargers) are only switched by automations that say so. */
  allowProtected?: boolean;
  /** turn_on only: switch off again after this long (timed by the device itself when it can). */
  autoOffMinutes?: number;
}

export type ActionKind = Action['kind'];
export type NotifyChannel = 'app' | 'ntfy' | 'webhook';

export interface RuleOptions {
  cooldownMinutes: number;
  maxRunsPerDay: number;
  revertAfterMinutes: number;
  activeDays?: number[];
  activeFrom?: string;
  activeTo?: string;
}

export interface RuleConfig {
  description: string;
  priority: number;
  triggers: Trigger[];
  conditions: Group;
  actions: Action[];
  elseActions: Action[];
  options: RuleOptions;
}

export interface Rule {
  id: number;
  type: 'rule';
  enabled: boolean;
  name: string;
  config: RuleConfig;
  created: number;
  updated: number;
}

export const TRIGGER_KINDS: TriggerKind[] = ['time', 'sun', 'metric', 'device', 'grid', 'price', 'forecast', 'alert', 'interval', 'manual'];
export const CONDITION_KINDS: ConditionKind[] = [
  'time_between', 'days', 'metric', 'device', 'grid', 'price', 'sun', 'forecast', 'setting', 'automation', 'date_between',
];
export const ACTION_KINDS: ActionKind[] = ['set_setting', 'device', 'scene', 'notify', 'mqtt', 'delay', 'automation'];

/** Smart-device entity id, e.g. "switch.water_heater". */
export const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const DEVICE_TARGET = /^(?:[a-z0-9_]+\.[a-z0-9_]+|role:[a-z]+|area:[a-z0-9_]+)$/;

/** Display names for entities and device targets ("role:…", "area:…"); set by automation/index.ts. */
let nameOf: (idOrTarget: string) => string = (t) => t;
export function setEntityNamer(fn: (idOrTarget: string) => string) {
  nameOf = fn;
}
/** Triggers with a predictable fire time (shown on the upcoming timeline). */
export const SCHEDULED_KINDS = new Set<TriggerKind>(['time', 'sun', 'forecast', 'interval']);
/** Derived metric: minutes until the next planned grid outage (Eskom provider). */
export const OUTAGE_METRIC = 'Planned outage in';

/** What validation needs to know about the connected driver. */
export interface RuleContext {
  connected: boolean;
  modelName: string;
  inverterCount: number;
  /** Settings of inverter 1; empty when not connected (settings are then accepted unchecked). */
  defs: SettingDef[];
  sceneExists(id: number): boolean;
  automationExists(id: number): boolean;
  /** Whether a smart-device entity or target ("role:…", "area:…") exists. Absent = accept. */
  targetExists?(target: string): boolean;
}

// ---------- Validation ----------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function num(raw: unknown, label: string, min = -Infinity, max = Infinity, integer = false): number {
  const n = parseNumber(raw);
  if (n === null) throw new ValidationError(`${label}: enter a number.`);
  if (integer && !Number.isInteger(n)) throw new ValidationError(`${label} must be a whole number.`);
  if (n < min || n > max) throw new ValidationError(`${label} must be between ${min} and ${max}.`);
  return n;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], label: string): T {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}.`);
}

function bool(raw: unknown, label: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1) return true;
  if (raw === 'false' || raw === 0) return false;
  throw new ValidationError(`${label} must be true or false.`);
}

function days(raw: unknown, label: string): number[] {
  const list = arr(raw).map((d) => {
    if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6) return d;
    const i = DAY_NAMES.findIndex((n) => n.toLowerCase() === String(d).slice(0, 3).toLowerCase());
    if (i < 0) throw new ValidationError(`${label}: invalid day '${d}'.`);
    return i;
  });
  const out = [...new Set(list)].sort();
  if (!out.length) throw new ValidationError(`${label}: select at least one day.`);
  return out;
}

function monthDay(raw: unknown, label: string): string {
  const text = String(raw ?? '').trim();
  const m = /^(\d{2})-(\d{2})$/.exec(text);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) < 1 || Number(m[2]) > 31) {
    throw new ValidationError(`${label}: invalid date '${text}'. Use MM-DD.`);
  }
  return text;
}

function hhmm(raw: unknown, label: string): string {
  try {
    const t = parseTime(raw, true);
    return t === '24:00' ? '00:00' : t;
  } catch {
    throw new ValidationError(`${label}: invalid time '${raw}'. Use HH:MM.`);
  }
}

function text(raw: unknown, label: string, max: number, required = true): string {
  const t = String(raw ?? '').trim().slice(0, max);
  if (required && !t) throw new ValidationError(`${label}: enter a value.`);
  return t;
}

function metricName(raw: unknown, label: string): string {
  return text(raw, `${label} metric`, 80);
}

function target(raw: unknown, ctx: RuleContext, label: string): Target {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return 'all';
  const n = num(raw, `${label} inverter`, 0, 63, true);
  if (ctx.connected && n >= ctx.inverterCount) throw new ValidationError(`${label}: inverter ${n + 1} does not exist.`);
  return n;
}

/** Resolves a setting key/label against the driver. Without settings (not connected) the key is kept. */
export function resolveSetting(raw: unknown, defs: SettingDef[], modelName: string, label: string): { key: string; def?: SettingDef } {
  const t = String(raw ?? '').trim();
  if (!t) throw new ValidationError(`${label}: choose a setting.`);
  if (!defs.length) return { key: t };
  const def = findDef(defs, t);
  if (!def) throw new ValidationError(`${label}: "${t}" is not a setting of ${modelName || 'this inverter'}.`);
  if (def.readOnly) throw new ValidationError(`${label}: "${def.label}" is read-only.`);
  return { key: def.key, def };
}

export function normalizeTrigger(raw: unknown, i: number): Trigger {
  const r = obj(raw);
  const label = `Trigger ${i + 1}`;
  const kind = oneOf(r.kind, TRIGGER_KINDS, `${label} kind`);
  switch (kind) {
    case 'time': {
      const t: Trigger = { kind, at: hhmm(r.at, label) };
      if (r.days !== undefined && r.days !== null && arr(r.days).length) t.days = days(r.days, label);
      return t;
    }
    case 'sun':
      return { kind, event: oneOf(r.event, ['sunrise', 'sunset'] as const, `${label} event`), offsetMinutes: num(r.offsetMinutes ?? 0, `${label} offset`, -720, 720, true) };
    case 'metric':
      return {
        kind, metric: metricName(r.metric, label), op: oneOf(r.op, ['above', 'below'] as const, `${label} comparison`),
        value: num(r.value, `${label} value`), forMinutes: num(r.forMinutes ?? 0, `${label} duration`, 0, 1440, true),
      };
    case 'grid':
      return { kind, event: oneOf(r.event, ['lost', 'restored'] as const, `${label} event`) };
    case 'price': {
      if (r.mode !== undefined && r.mode !== null && r.mode !== '') {
        return { kind, mode: oneOf(r.mode, ['cheapest', 'most_expensive'] as const, `${label} mode`), hours: num(r.hours ?? 1, `${label} hours`, 1, 23, true) };
      }
      return { kind, op: oneOf(r.op, ['above', 'below'] as const, `${label} comparison`), value: num(r.value, `${label} price`) };
    }
    case 'forecast':
      return {
        kind, at: hhmm(r.at, label), metric: oneOf(r.metric, ['tomorrow_sun', 'today_sun'] as const, `${label} forecast`),
        op: oneOf(r.op, ['above', 'below'] as const, `${label} comparison`), value: num(r.value, `${label} value`, 0, 100),
      };
    case 'alert': {
      if (r.alert) return { kind, alert: text(r.alert, `${label} alert`, 40) };
      if (r.level) return { kind, level: oneOf(r.level, ['bad', 'warn'] as const, `${label} level`) };
      throw new ValidationError(`${label}: choose an alert or a level.`);
    }
    case 'interval':
      return { kind, everyMinutes: num(r.everyMinutes, `${label} interval`, 5, 1440, true) };
    case 'device': {
      const t: Trigger = { kind, entity: entityId(r.entity, label), forMinutes: num(r.forMinutes ?? 0, `${label} duration`, 0, 1440, true) };
      const to = text(r.to, `${label} state`, 60, false);
      const from = text(r.from, `${label} previous state`, 60, false);
      if (to) t.to = to;
      if (from) t.from = from;
      return t;
    }
    case 'manual':
      return { kind };
  }
}

function entityId(raw: unknown, label: string, ctx?: RuleContext): string {
  const id = String(raw ?? '').trim();
  if (!ENTITY_ID.test(id)) throw new ValidationError(`${label}: choose a device.`);
  if (ctx?.targetExists && !ctx.targetExists(id)) throw new ValidationError(`${label}: device "${id}" not found.`);
  return id;
}

/** Device action data: plain JSON values only, kept small. */
function actionData(raw: unknown, label: string): Record<string, unknown> {
  const d = obj(raw);
  for (const [k, v] of Object.entries(d)) {
    if (!/^[a-z_]{1,40}$/.test(k)) throw new ValidationError(`${label}: invalid option "${k}".`);
    const ok = v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => ['string', 'number'].includes(typeof x)));
    if (!ok) throw new ValidationError(`${label}: invalid value for "${k}".`);
  }
  if (JSON.stringify(d).length > 2000) throw new ValidationError(`${label}: options are too large.`);
  return d;
}

export function normalizeCondition(raw: unknown, ctx: RuleContext, label: string): Condition {
  const r = obj(raw);
  const kind = oneOf(r.kind, CONDITION_KINDS, `${label} kind`);
  switch (kind) {
    case 'time_between':
      return { kind, from: hhmm(r.from, label), to: hhmm(r.to, label) };
    case 'days':
      return { kind, days: days(r.days, label) };
    case 'metric': {
      const op = oneOf(r.op, ['above', 'below', 'between'] as const, `${label} comparison`);
      const c: Condition = { kind, metric: metricName(r.metric, label), op, value: num(r.value, `${label} value`) };
      if (op === 'between') {
        c.value2 = num(r.value2, `${label} upper value`);
        if (c.value2 < c.value) [c.value, c.value2] = [c.value2, c.value];
      }
      return c;
    }
    case 'grid':
      return { kind, available: bool(r.available, `${label} available`) };
    case 'price':
      if (r.cheapest_hours !== undefined && r.cheapest_hours !== null && r.cheapest_hours !== '') {
        return { kind, cheapest_hours: num(r.cheapest_hours, `${label} cheapest hours`, 1, 23, true) };
      }
      return { kind, op: oneOf(r.op, ['above', 'below'] as const, `${label} comparison`), value: num(r.value, `${label} price`) };
    case 'sun':
      return { kind, is: oneOf(r.is, ['up', 'down'] as const, `${label} sun`) };
    case 'forecast':
      return {
        kind, metric: oneOf(r.metric, ['tomorrow_sun', 'today_sun'] as const, `${label} forecast`),
        op: oneOf(r.op, ['above', 'below'] as const, `${label} comparison`), value: num(r.value, `${label} value`, 0, 100),
      };
    case 'setting': {
      const { key, def } = resolveSetting(r.setting, ctx.defs, ctx.modelName, label);
      return { kind, inverter: target(r.inverter, ctx, label), setting: key, equals: normalizeValue(def, r.equals, false) };
    }
    case 'automation': {
      const id = num(r.id, `${label} automation`, 1, Number.MAX_SAFE_INTEGER, true);
      if (!ctx.automationExists(id)) throw new ValidationError(`${label}: automation #${id} does not exist.`);
      return { kind, id, enabled: bool(r.enabled, `${label} enabled`) };
    }
    case 'date_between':
      return { kind, from: monthDay(r.from, label), to: monthDay(r.to, label) };
    case 'device': {
      const c: Condition = { kind, entity: entityId(r.entity, label, ctx), is: text(r.is, `${label} state`, 60) };
      if (r.not === true) c.not = true;
      return c;
    }
  }
}

export const isGroup = (c: Condition | Group): c is Group => (c as Group).items !== undefined && (c as Group).op !== undefined;

/** Root group plus up to two levels of nested groups. */
const MAX_GROUP_DEPTH = 2;

export function normalizeGroup(raw: unknown, ctx: RuleContext, depth = 0, path = 'Condition'): Group {
  const r = obj(raw);
  const op = r.op === undefined ? 'and' : oneOf(r.op, ['and', 'or'] as const, `${path} group operator`);
  const items = arr(r.items);
  if (items.length > 30) throw new ValidationError('A condition group can have at most 30 items.');
  return {
    op,
    items: items.map((item, i) => {
      const label = depth === 0 ? `Condition ${i + 1}` : `${path}.${i + 1}`;
      const o = obj(item);
      if (o.items !== undefined || (o.op !== undefined && o.kind === undefined)) {
        if (depth >= MAX_GROUP_DEPTH) throw new ValidationError(`${label}: condition groups can be nested at most ${MAX_GROUP_DEPTH} levels.`);
        return normalizeGroup(item, ctx, depth + 1, label);
      }
      return normalizeCondition(item, ctx, label);
    }),
  };
}

export function normalizeAction(raw: unknown, ctx: RuleContext, label: string): Action {
  const r = obj(raw);
  const kind = oneOf(r.kind, ACTION_KINDS, `${label} kind`);
  switch (kind) {
    case 'set_setting': {
      const { key, def } = resolveSetting(r.setting, ctx.defs, ctx.modelName, label);
      let value: Value;
      try {
        value = normalizeValue(def, r.value, false);
      } catch (err) {
        throw new ValidationError(`${label}: ${(err as Error).message}`);
      }
      return { kind, inverter: target(r.inverter, ctx, label), setting: key, value };
    }
    case 'scene': {
      const scene = num(r.scene, `${label} scene`, 1, Number.MAX_SAFE_INTEGER, true);
      if (!ctx.sceneExists(scene)) throw new ValidationError(`${label}: scene #${scene} does not exist.`);
      return { kind, scene };
    }
    case 'notify':
      return {
        kind, channel: oneOf(r.channel ?? 'app', ['app', 'ntfy', 'webhook'] as const, `${label} channel`),
        title: text(r.title, `${label} title`, 120, false) || 'Sunroost', message: text(r.message, `${label} message`, 1000),
      };
    case 'mqtt': {
      const topic = text(r.topic, `${label} topic`, 200);
      if (/[#+]/.test(topic)) throw new ValidationError(`${label}: the topic may not contain wildcards.`);
      return { kind, topic, payload: String(r.payload ?? '').slice(0, 10_000), retain: r.retain === true };
    }
    case 'delay':
      return { kind, minutes: num(r.minutes, `${label} delay`, 1, 240, true) };
    case 'automation': {
      const id = num(r.id, `${label} automation`, 1, Number.MAX_SAFE_INTEGER, true);
      if (!ctx.automationExists(id)) throw new ValidationError(`${label}: automation #${id} does not exist.`);
      return { kind, id, enabled: bool(r.enabled, `${label} enabled`) };
    }
    case 'device': {
      const target = String(r.target ?? '').trim();
      if (!DEVICE_TARGET.test(target)) throw new ValidationError(`${label}: choose a device, a room or an energy role.`);
      if (ctx.targetExists && !ctx.targetExists(target)) throw new ValidationError(`${label}: "${target}" not found.`);
      const service = String(r.service ?? '').trim();
      if (!/^[a-z_]{2,40}$/.test(service)) throw new ValidationError(`${label}: choose what to do.`);
      const a: DeviceAction = { kind, target, service, data: actionData(r.data, label) };
      if (r.allowProtected === true) a.allowProtected = true;
      if (r.autoOffMinutes !== undefined && r.autoOffMinutes !== null && r.autoOffMinutes !== '' && r.autoOffMinutes !== 0) {
        if (service !== 'turn_on') throw new ValidationError(`${label}: an off-timer only applies to "turn on".`);
        a.autoOffMinutes = num(r.autoOffMinutes, `${label} off-timer`, 1, 1440, true);
      }
      if ('auto_off_s' in a.data) throw new ValidationError(`${label}: use the off-timer option instead of auto_off_s.`);
      return a;
    }
  }
}

function normalizeActions(raw: unknown, ctx: RuleContext, prefix: string): Action[] {
  const list = arr(raw);
  if (list.length > 30) throw new ValidationError(`At most 30 ${prefix.toLowerCase()}s.`);
  return list.map((a, i) => normalizeAction(a, ctx, `${prefix} ${i + 1}`));
}

export function normalizeRule(raw: unknown, ctx: RuleContext): RuleConfig {
  const r = obj(raw);
  const triggers = arr(r.triggers).map((t, i) => normalizeTrigger(t, i));
  triggers.forEach((t, i) => {
    if (t.kind === 'device' && ctx.targetExists && !ctx.targetExists(t.entity)) throw new ValidationError(`Trigger ${i + 1}: device "${t.entity}" not found.`);
  });
  if (!triggers.length) throw new ValidationError('Add at least one trigger.');
  if (triggers.length > 10) throw new ValidationError('A rule can have at most 10 triggers.');
  const actions = normalizeActions(r.actions, ctx, 'Action');
  const elseActions = normalizeActions(r.elseActions, ctx, 'Else action');
  if (!actions.length && !elseActions.length) throw new ValidationError('Add at least one action.');
  const o = obj(r.options);
  const options: RuleOptions = {
    cooldownMinutes: num(o.cooldownMinutes ?? 5, 'Cooldown', 0, 10_080, true),
    maxRunsPerDay: num(o.maxRunsPerDay ?? 0, 'Maximum runs per day', 0, 1440, true),
    revertAfterMinutes: num(o.revertAfterMinutes ?? 0, 'Revert after', 0, 10_080, true),
  };
  if (o.activeDays !== undefined && o.activeDays !== null) options.activeDays = days(o.activeDays, 'Active days');
  const hasFrom = o.activeFrom !== undefined && o.activeFrom !== null && o.activeFrom !== '';
  const hasTo = o.activeTo !== undefined && o.activeTo !== null && o.activeTo !== '';
  if (hasFrom !== hasTo) throw new ValidationError('Seasonal window: enter both a start and an end (MM-DD).');
  if (hasFrom) {
    options.activeFrom = monthDay(o.activeFrom, 'Active from');
    options.activeTo = monthDay(o.activeTo, 'Active to');
  }
  return {
    description: text(r.description, 'Description', 500, false),
    priority: num(r.priority ?? 50, 'Priority', 1, 100, true),
    triggers,
    conditions: normalizeGroup(r.conditions ?? { op: 'and', items: [] }, ctx),
    actions,
    elseActions,
    options,
  };
}

/** Every (inverter, setting) a rule writes directly. Scenes are expanded by the caller. */
export function directSettings(cfg: RuleConfig): { inverter: Target; setting: string }[] {
  return [...cfg.actions, ...cfg.elseActions]
    .filter((a): a is Extract<Action, { kind: 'set_setting' }> => a.kind === 'set_setting')
    .map((a) => ({ inverter: a.inverter, setting: a.setting }));
}

// ---------- Evaluation ----------

/** Live values conditions are evaluated against. */
export interface RuleEnv {
  now: number;
  tz: string;
  metric(name: string): number | null;
  gridAvailable: boolean | null;
  price: number | null;
  /** Whether `now` lies in one of the N cheapest hours of today; null without prices. */
  inCheapestHours(n: number): boolean | null;
  sunUp: boolean;
  forecast: { today_sun: number | null; tomorrow_sun: number | null };
  inverterCount: number;
  values(index: number): SettingValues;
  automationEnabled(id: number): boolean | null;
  defs: SettingDef[];
  /** Current state of a smart-device entity; null when unknown. */
  entity?(id: string): string | null;
}

export interface CondDetail {
  kind: string;
  match: boolean;
  text: string;
  /** Present for groups. */
  op?: 'and' | 'or';
  items?: CondDetail[];
}

const fmt = (n: number) => `${Math.round(n * 100) / 100}`;

export function metricUnit(name: string) {
  if (name === OUTAGE_METRIC) return 'min';
  return meta(name).unit ?? '';
}

/** Metric display name: entity ids (device readings) by their device name. */
const metricLabel = (m: string) => (ENTITY_ID.test(m) ? nameOf(m) : m.toLowerCase());

const withUnit = (n: number, metric: string) => {
  const u = metricUnit(metric);
  return `${fmt(n)}${u === '%' ? '%' : u ? ' ' + u : ''}`;
};

export function inTimeRange(minutes: number, from: string, to: string) {
  const f = toMinutes(from);
  const t = toMinutes(to);
  return f === t ? true : f < t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

export function inDateRange(md: string, from: string, to: string) {
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

const compare = (v: number, op: CompareOp, value: number) => (op === 'above' ? v > value : v < value);

export function evalCondition(c: Condition, env: RuleEnv): CondDetail {
  const lt = localTime(env.now, env.tz);
  const d = (match: boolean, text: string): CondDetail => ({ kind: c.kind, match, text });
  switch (c.kind) {
    case 'time_between': {
      const m = inTimeRange(lt.minutes, c.from, c.to);
      return d(m, `Time ${String(Math.floor(lt.minutes / 60)).padStart(2, '0')}:${String(lt.minutes % 60).padStart(2, '0')} ${m ? 'is' : 'is not'} between ${c.from} and ${c.to}`);
    }
    case 'days': {
      const m = c.days.includes(lt.dow);
      return d(m, `Today is ${DAY_NAMES[lt.dow]} (${m ? 'in' : 'not in'} ${c.days.map((x) => DAY_NAMES[x]).join(', ')})`);
    }
    case 'date_between': {
      const md = lt.date.slice(5);
      const m = inDateRange(md, c.from, c.to);
      return d(m, `Date ${md} ${m ? 'is' : 'is not'} between ${c.from} and ${c.to}`);
    }
    case 'metric': {
      const v = env.metric(c.metric);
      if (v === null) return d(false, `${c.metric} unknown`);
      const m = c.op === 'between' ? v >= c.value && v <= (c.value2 ?? c.value) : compare(v, c.op, c.value);
      const want = c.op === 'between' ? `between ${withUnit(c.value, c.metric)} and ${withUnit(c.value2 ?? c.value, c.metric)}` : `${c.op} ${withUnit(c.value, c.metric)}`;
      return d(m, `${c.metric} ${withUnit(v, c.metric)} ${m ? 'is' : 'is not'} ${want}`);
    }
    case 'grid': {
      if (env.gridAvailable === null) return d(false, 'Grid availability unknown');
      return d(env.gridAvailable === c.available, env.gridAvailable ? 'Grid is available' : 'Grid is unavailable');
    }
    case 'price': {
      if (c.cheapest_hours !== undefined) {
        const m = env.inCheapestHours(c.cheapest_hours);
        if (m === null) return d(false, 'No price data');
        return d(m, `Now ${m ? 'is' : 'is not'} among the ${c.cheapest_hours} cheapest hours today`);
      }
      if (env.price === null) return d(false, 'Price unknown');
      const m = compare(env.price, c.op!, c.value!);
      return d(m, `Price ${fmt(env.price)} ${m ? 'is' : 'is not'} ${c.op} ${fmt(c.value!)}`);
    }
    case 'sun':
      return d((c.is === 'up') === env.sunUp, `Sun is ${env.sunUp ? 'up' : 'down'}`);
    case 'forecast': {
      const v = env.forecast[c.metric];
      const name = c.metric === 'today_sun' ? "Today's solar radiation" : "Tomorrow's solar radiation";
      if (v === null) return d(false, `${name} unknown (no forecast)`);
      const m = compare(v, c.op, c.value);
      return d(m, `${name} ${fmt(v)} MJ/m² ${m ? 'is' : 'is not'} ${c.op} ${fmt(c.value)}`);
    }
    case 'setting': {
      const idx = c.inverter === 'all' ? Array.from({ length: Math.max(1, env.inverterCount) }, (_, i) => i) : [c.inverter];
      const def = findDef(env.defs, c.setting);
      const label = def?.label ?? c.setting;
      const vals = idx.map((i) => env.values(i)[c.setting]);
      if (vals.every((v) => v === undefined)) return d(false, `${label} unknown`);
      const m = vals.every((v) => sameValue(v, c.equals));
      return d(m, `${label} is ${fmtValue(def, vals[0] ?? null)}${m ? '' : ` (not ${fmtValue(def, c.equals)})`}`);
    }
    case 'automation': {
      const en = env.automationEnabled(c.id);
      if (en === null) return d(false, `Automation #${c.id} not found`);
      return d(en === c.enabled, `Automation #${c.id} is ${en ? 'enabled' : 'disabled'}`);
    }
    case 'device': {
      const st = env.entity?.(c.entity) ?? null;
      const name = nameOf(c.entity);
      if (st === null) return d(false, `${name} unknown`);
      const is = st.toLowerCase() === c.is.toLowerCase();
      const m = c.not ? !is : is;
      return d(m, `${name} is ${stateText(st)}${m ? '' : ` (${c.not ? 'should not be' : 'not'} ${stateText(c.is)})`}`);
    }
  }
}

/** "fan_only" → "fan only". */
const stateText = (s: string) => s.replace(/_/g, ' ');

export function evalGroup(g: Group, env: RuleEnv): CondDetail {
  const items = g.items.map((it) => (isGroup(it) ? evalGroup(it, env) : evalCondition(it, env)));
  const match = items.length === 0 ? true : g.op === 'and' ? items.every((i) => i.match) : items.some((i) => i.match);
  return { kind: 'group', op: g.op, match, items, text: items.length ? `${g.op === 'and' ? 'All' : 'Any'} of ${items.length}` : 'No conditions' };
}

// ---------- Human text ----------

const DAY_LIST = (d: number[]) =>
  d.length === 7 ? 'every day' : d.join() === '1,2,3,4,5' ? 'on weekdays' : d.join() === '0,6' ? 'at weekends' : `on ${d.map((x) => DAY_NAMES[x]).join(', ')}`;

const offsetText = (m: number) => (m === 0 ? 'at' : `${Math.abs(m)} min ${m < 0 ? 'before' : 'after'}`);

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case 'time':
      return `at ${t.at}${t.days ? ' ' + DAY_LIST(t.days) : ''}`;
    case 'sun':
      return `${offsetText(t.offsetMinutes)} ${t.event}`;
    case 'metric':
      return `when ${metricLabel(t.metric)} ${t.op === 'above' ? 'rises above' : 'drops below'} ${withUnit(t.value, t.metric)}${t.forMinutes ? ` for ${t.forMinutes} min` : ''}`;
    case 'device': {
      const change = t.to ? `${t.from ? `changes from ${stateText(t.from)} ` : 'turns '}${t.from ? 'to ' : ''}${stateText(t.to)}` : `changes${t.from ? ` from ${stateText(t.from)}` : ''}`;
      return `when ${nameOf(t.entity)} ${change}${t.forMinutes ? ` for ${t.forMinutes} min` : ''}`;
    }
    case 'grid':
      return t.event === 'lost' ? 'when the grid is lost' : 'when the grid is restored';
    case 'price':
      return t.mode
        ? `at the start of each of the ${t.hours} ${t.mode === 'cheapest' ? 'cheapest' : 'most expensive'} hours of the day`
        : `when the price ${t.op === 'above' ? 'rises above' : 'drops below'} ${fmt(t.value!)}`;
    case 'forecast':
      return `at ${t.at} if ${t.metric === 'today_sun' ? "today's" : "tomorrow's"} solar forecast is ${t.op} ${fmt(t.value)} MJ/m²`;
    case 'alert':
      return t.alert ? `when alert "${t.alert}" is raised` : `when a ${t.level === 'bad' ? 'critical' : 'warning'} alert is raised`;
    case 'interval':
      return `every ${t.everyMinutes} min`;
    case 'manual':
      return 'when run manually';
  }
}

export function describeCondition(c: Condition, defs: SettingDef[] = []): string {
  switch (c.kind) {
    case 'time_between':
      return `between ${c.from} and ${c.to}`;
    case 'days':
      return DAY_LIST(c.days);
    case 'date_between':
      return `between ${c.from} and ${c.to} (date)`;
    case 'metric':
      return c.op === 'between'
        ? `${metricLabel(c.metric)} is between ${withUnit(c.value, c.metric)} and ${withUnit(c.value2 ?? c.value, c.metric)}`
        : `${metricLabel(c.metric)} is ${c.op} ${withUnit(c.value, c.metric)}`;
    case 'device':
      return `${nameOf(c.entity)} is ${c.not ? 'not ' : ''}${stateText(c.is)}`;
    case 'grid':
      return c.available ? 'the grid is available' : 'the grid is down';
    case 'price':
      return c.cheapest_hours !== undefined ? `now is among the ${c.cheapest_hours} cheapest hours` : `the price is ${c.op} ${fmt(c.value!)}`;
    case 'sun':
      return `the sun is ${c.is}`;
    case 'forecast':
      return `${c.metric === 'today_sun' ? "today's" : "tomorrow's"} solar forecast is ${c.op} ${fmt(c.value)} MJ/m²`;
    case 'setting': {
      const def = findDef(defs, c.setting);
      return `${def?.label ?? c.setting} is ${fmtValue(def, c.equals)}`;
    }
    case 'automation':
      return `automation #${c.id} is ${c.enabled ? 'enabled' : 'disabled'}`;
  }
}

function describeGroup(g: Group, defs: SettingDef[], nested = false): string {
  const parts = g.items.map((it) => (isGroup(it) ? describeGroup(it, defs, true) : describeCondition(it, defs)));
  const joined = parts.join(g.op === 'and' ? ' and ' : ' or ');
  return nested && parts.length > 1 ? `(${joined})` : joined;
}

export function describeAction(a: Action, defs: SettingDef[] = [], sceneName?: (id: number) => string | null): string {
  switch (a.kind) {
    case 'set_setting': {
      const def = findDef(defs, a.setting);
      return `set ${def?.label ?? a.setting} to ${fmtValue(def, a.value)}${a.inverter === 'all' ? '' : ` on inverter ${a.inverter + 1}`}`;
    }
    case 'scene':
      return `apply scene "${sceneName?.(a.scene) ?? `#${a.scene}`}"`;
    case 'notify':
      return a.channel === 'app' ? 'send an app notification' : `notify via ${a.channel}`;
    case 'mqtt':
      return `publish to MQTT ${a.topic}`;
    case 'delay':
      return `wait ${a.minutes} min`;
    case 'automation':
      return `${a.enabled ? 'enable' : 'disable'} automation #${a.id}`;
    case 'device':
      return describeDeviceAction(a);
  }
}

/** "turn off every sheddable device", "set Bedroom AC temperature to 22°". */
export function describeDeviceAction(a: DeviceAction, targetName = nameOf(a.target)): string {
  const v = (k: string) => stateText(String(a.data[k]));
  switch (a.service) {
    case 'turn_on':
      return `turn on ${targetName}${a.data.brightness !== undefined ? ` at ${Math.round((Number(a.data.brightness) / 255) * 100)}%` : ''}${a.autoOffMinutes ? ` for ${a.autoOffMinutes} min` : ''}`;
    case 'turn_off':
      return `turn off ${targetName}`;
    case 'toggle':
      return `toggle ${targetName}`;
    case 'set_temperature':
      return `set ${targetName} to ${v('temperature')}°${a.data.hvac_mode ? ` (${v('hvac_mode')})` : ''}`;
    case 'set_hvac_mode':
      return `set ${targetName} to ${v('hvac_mode')}`;
    case 'set_value':
      return `set ${targetName} to ${v('value')}`;
    case 'select_option':
      return `set ${targetName} to ${v('option')}`;
    case 'set_percentage':
      return `set ${targetName} to ${v('percentage')}%`;
    default:
      return `${stateText(a.service)} ${targetName}`;
  }
}

const joinList = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/** One human sentence, e.g. "At 22:00 on weekdays, if the grid is available, set Work mode priority to Battery first." */
export function summarize(cfg: RuleConfig, defs: SettingDef[] = [], sceneName?: (id: number) => string | null): string {
  const when = cfg.triggers.map(describeTrigger).join(' or ');
  const cond = cfg.conditions.items.length ? `, if ${describeGroup(cfg.conditions, defs)}` : '';
  const actions = joinList(cfg.actions.map((a) => describeAction(a, defs, sceneName)));
  const otherwise = cfg.elseActions.length ? `; otherwise ${joinList(cfg.elseActions.map((a) => describeAction(a, defs, sceneName)))}` : '';
  const revert = cfg.options.revertAfterMinutes ? `, reverting after ${cfg.options.revertAfterMinutes} min` : '';
  const s = `${when}${cond}, ${actions || 'do nothing'}${revert}${otherwise}.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
