/**
 * Automation subsystem: wires the legacy runner and the rule engine to the live device state,
 * runs them every 30 s and soon after relevant state changes (rules: at most every 5 s, plus the
 * engine's own timer for exact scheduled times), and exposes the operations the web API uses.
 */
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';
import { state } from '../core/state.ts';
import { devices } from '../devices/manager.ts';
import { inverterDriver } from '../devices/registry.ts';
import * as alerts from '../alerts/index.ts';
import { HISTORY_TOTAL_METRICS, meta as metaOf } from '../core/metrics.ts';
import { eskomOutages, prices as gridPrices } from '../grid/index.ts';
import { nextOutage } from '../grid/eskom.ts';
import { publishMessage } from '../mqtt/index.ts';
import { FORECAST_METRICS, outlookMetrics, SURPLUS_METRIC } from '../energy/index.ts';
import * as home from '../home/index.ts';
import { ENERGY_ROLES, servicesFor } from '../home/types.ts';
import type { StateChangedEvent } from '../home/bus.ts';
import * as weather from '../weather/index.ts';
import { CONDITIONS, localTime, ValidationError, type Inputs } from './conditions.ts';
import * as deviceRules from './devices.ts';
import * as spareSolar from './surplus.ts';
import { RuleEngine } from './engine.ts';
import * as notify from './notify.ts';
import {
  ACTION_KINDS, CONDITION_KINDS, describeTrigger, ENTITY_ID, isGroup, metricUnit, normalizeRule, OUTAGE_METRIC, SCHEDULED_KINDS,
  setEntityNamer, summarize, TRIGGER_KINDS, evalGroup, type Condition, type Group, type Rule, type RuleConfig, type RuleContext, type Target,
} from './rules.ts';
import * as runs from './runs.ts';
import { automationLabel, disableReason, Runner } from './runner.ts';
import { occurrences, sunToday } from './scheduler.ts';
import { addScene, allScenes, getScene, initScenes, normalizeScene, removeScene, updateScene, type Scene } from './scenes.ts';
import * as store from './store.ts';
import { templates as buildTemplates, type TemplateContext } from './templates.ts';
import { ymdOf, zonedTs } from './time.ts';
import {
  controllable, findDef, isAutomationType, normalizeConfig, socDiagram, TYPE_NAMES,
  type Automation, type AutomationType, type EngineContext, type SocConfig,
} from './types.ts';

export { ValidationError } from './conditions.ts';
export { ConflictError } from './store.ts';

const log = logger('automation');
const TICK_MS = 30_000;
/** Device state changes a rule watches are evaluated this soon (coalesced). */
const DEVICE_EVAL_MS = 150;

// Rule summaries name devices, rooms and roles the way the Devices page does.
setEntityNamer(deviceRules.targetName);
/** Minimum spacing of evaluations triggered by state changes. */
const CHANGE_THROTTLE_MS = 5_000;
export const SUSPEND_MINUTES = [30, 60, 120, 240, 360, 480, 720, 1440];

// ---------- Live context ----------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function connected() {
  return devices.started && devices.inverterCount > 0 && state.status.inverter.name === 'connected';
}

export function context(): EngineContext {
  const desc = inverterDriver(settings.get('inverter.driver_id'));
  const modelId = settings.get('inverter.model_id');
  const modelName =
    desc?.models?.find((m) => m.id === modelId)?.name ??
    (typeof state.inverters[0]?.['Model name'] === 'string' ? (state.inverters[0]['Model name'] as string) : desc?.name ?? '');
  return {
    connected: connected(),
    modelName,
    inverterCount: devices.inverterCount,
    defs: devices.settingDefs(0),
    // Read-only drivers can't be switched, so they offer no SOC control.
    socControl: desc && !desc.readOnly && !desc.readOnlyModels?.includes(modelId) ? (desc.socControl?.(modelId) ?? null) : null,
    protection: desc?.protectionSetting?.(modelId) ?? null,
  };
}

const priceAvailable = () => settings.get('grid.driver_id') !== 'default';

export function liveInputs(): Omit<Inputs, 'now' | 'tz'> {
  const t = state.totals;
  const voltage = num(t['Grid voltage']);
  const loss = t['Grid loss'] ?? state.grid['Grid loss'];
  const gridAvailable = loss === true ? false : voltage !== null ? voltage > 100 : null;
  return {
    soc: num(t['Battery state of charge']),
    gridAvailable,
    price: priceAvailable() ? num(state.grid['Price']) : null,
    pv: num(t['PV power']),
  };
}

export const runner = new Runner({
  now: () => Date.now(),
  tz: () => settings.get('timezone'),
  connected,
  overrideUntil: () => Number(settings.get('automation.override_until')) || 0,
  context,
  inputs: liveInputs,
  values: (i) => devices.settingValues(i),
  setSetting: (i, key, value, source) => devices.setSetting(i, key, value, source),
  automations: () => store.legacy(),
  log,
});

// ---------- Loop ----------

let timer: NodeJS.Timeout | null = null;
let soon: NodeJS.Timeout | null = null;
let lastRun = 0;
let lastSignature = '';

function run() {
  lastRun = Date.now();
  runner.tick().catch((err) => log.error(`Evaluation failed: ${(err as Error).message}`));
}

let ruleSoon: NodeJS.Timeout | null = null;
let lastPrune = 0;

function tick() {
  run();
  evaluateRules('tick');
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    try {
      runs.pruneRuns();
    } catch (err) {
      log.error(`Pruning automation runs failed: ${(err as Error).message}`);
    }
  }
}

/** Entities that enabled rules watch: device triggers and conditions, and device readings used as values. */
function watchedEntities(): Set<string> {
  const out = new Set<string>();
  const cond = (c: Condition | Group) => {
    if (isGroup(c)) c.items.forEach(cond);
    else if (c.kind === 'device') out.add(c.entity);
    else if (c.kind === 'metric' && ENTITY_ID.test(c.metric)) out.add(c.metric);
  };
  for (const r of store.rules()) {
    if (!r.enabled) continue;
    for (const t of r.config.triggers) {
      if (t.kind === 'device') out.add(t.entity);
      else if (t.kind === 'metric' && ENTITY_ID.test(t.metric)) out.add(t.metric);
    }
    cond(r.config.conditions);
  }
  return out;
}

let deviceSoon: NodeJS.Timeout | null = null;
function onDeviceState(ev: StateChangedEvent) {
  if (deviceSoon || !watchedEntities().has(ev.entityId)) return;
  deviceSoon = setTimeout(() => {
    deviceSoon = null;
    evaluateRules('device');
  }, DEVICE_EVAL_MS);
}

function evaluateRules(reason: string) {
  engine.evaluate(reason).catch((err) => log.error(`Rule evaluation failed: ${(err as Error).message}`));
  // Spare solar runs alongside the rules (same cadence: state refreshes and the 30 s tick).
  spareSolar.evaluate(overrideUntil() > 0).catch((err) => log.error(`Spare solar failed: ${(err as Error).message}`));
}

/** Rules re-evaluate on state refreshes at most every CHANGE_THROTTLE_MS. */
function onRuleRefresh() {
  if (ruleSoon) return;
  const wait = CHANGE_THROTTLE_MS - (Date.now() - engine.lastEvaluation);
  if (wait <= 0) return evaluateRules('refresh');
  ruleSoon = setTimeout(() => {
    ruleSoon = null;
    evaluateRules('refresh');
  }, wait);
}

/** Runs an evaluation shortly (coalesces bursts of triggers). */
function runSoon(delay = 200) {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    run();
  }, delay);
}

/** Re-evaluate on state changes that can change a decision, at most every CHANGE_THROTTLE_MS. */
function onRefresh() {
  const i = liveInputs();
  const sig = JSON.stringify([i.soc === null ? null : Math.round(i.soc), i.gridAvailable, i.price, i.pv === null ? null : Math.round(i.pv / 25), state.status.inverter.name]);
  if (sig === lastSignature) return;
  lastSignature = sig;
  const wait = CHANGE_THROTTLE_MS - (Date.now() - lastRun);
  runSoon(Math.max(200, wait));
}

const onStarted = () => {
  runSoon(3000);
  setTimeout(() => evaluateRules('devices started'), 3000);
};

export async function start() {
  store.initStore();
  runs.initRuns();
  deviceRules.initTimers();
  initScenes();
  notify.initNotifications();
  timer = setInterval(tick, TICK_MS);
  state.on('refresh', onRefresh);
  state.on('refresh', onRuleRefresh);
  devices.on('started', onStarted);
  home.bus.on('state_changed', onDeviceState);
  evaluateRules('start');
  const n = store.enabled().length;
  if (n) log.info(`${n} automation${n > 1 ? 's' : ''} enabled.`);
}

export async function stop() {
  if (timer) clearInterval(timer);
  if (soon) clearTimeout(soon);
  if (ruleSoon) clearTimeout(ruleSoon);
  timer = soon = ruleSoon = null;
  engine.stop();
  state.off('refresh', onRefresh);
  state.off('refresh', onRuleRefresh);
  devices.off('started', onStarted);
  home.bus.off('state_changed', onDeviceState);
  if (deviceSoon) clearTimeout(deviceSoon);
  deviceSoon = null;
}

// ---------- Operations used by the API ----------

export class NotFoundError extends Error {}

function mustGet(id: number): Automation {
  const a = store.get(id);
  if (!a) throw new NotFoundError(`Automation #${id} not found`);
  return a;
}

export function overrideUntil() {
  const until = Number(settings.get('automation.override_until')) || 0;
  return until > Date.now() ? until : 0;
}

/** Automation plus its live status (dry-run decision, last action, disable reason). */
export function view(a: Automation, ctx = context(), inputs = runner.fullInputs()) {
  const reason = disableReason(a, ctx, inputs.soc);
  const d = runner.decide(a, inputs);
  const plan = ctx.connected && !reason ? runner.plan(a, d, ctx) : [];
  const suspended = overrideUntil() > 0;
  const status = !a.enabled
    ? 'disabled'
    : !ctx.connected
      ? 'not_connected'
      : reason
        ? 'unavailable'
        : suspended
          ? 'suspended'
          : d.value === null
            ? 'idle'
            : 'active';
  const rt = runner.runtime.get(a.id) ?? {};
  const def = findDef(ctx.defs, a.config.setting);
  return {
    ...a,
    typeName: TYPE_NAMES[a.type],
    label: automationLabel(a),
    settingLabel: def?.label ?? a.config.setting,
    settingDef: def ?? null,
    status: {
      state: status,
      disableReason: reason?.code ?? null,
      disableMessage: reason?.message ?? null,
      decision: { value: d.value, reason: d.reason, activeRow: d.activeRow ?? null, thresholds: d.thresholds ?? null, tripped: d.tripped ?? null },
      plan,
      lastActionAt: rt.lastActionAt ?? null,
      lastAction: rt.lastAction ?? null,
      lastErrorAt: rt.lastErrorAt ?? null,
      lastError: rt.lastError ?? null,
      heldUntil: rt.heldUntil ?? null,
    },
    diagram: a.type === 'battery-soc' ? socDiagram(a.config as SocConfig) : null,
  };
}

export function list() {
  const ctx = context();
  const inputs = runner.fullInputs();
  return {
    connected: ctx.connected,
    overrideUntil: overrideUntil(),
    affectedSettings: store.affectedSettings(),
    automations: store.all().map((a) => (store.isRule(a) ? ruleView(a as unknown as Rule, ctx) : view(a, ctx, inputs))),
  };
}

export function options() {
  const ctx = context();
  const soc = liveInputs().soc;
  const defs = controllable(ctx.defs);
  const sc = ctx.socControl;
  const scDef = sc ? findDef(ctx.defs, sc.setting) : undefined;
  const pr = ctx.protection;
  const socSupported = Boolean(sc && (!ctx.defs.length || scDef));
  const currency = settings.get('grid.currency');
  return {
    connected: ctx.connected,
    modelName: ctx.modelName,
    inverterCount: ctx.inverterCount,
    inverters: Array.from({ length: ctx.inverterCount }, (_, i) => ({ index: i, label: `Inverter ${i + 1}`, values: devices.settingValues(i) })),
    settings: defs,
    primarySetting: sc?.setting ?? null,
    affectedSettings: store.affectedSettings(),
    conditions: Object.values(CONDITIONS).map((c) => ({
      ...c,
      unit: c.kind === 'price' ? `${currency}/kWh` : c.unit ?? null,
      available: c.kind !== 'price' || priceAvailable(),
      note: c.kind === 'price' && !priceAvailable() ? 'Configure a grid price provider to use price conditions.' : null,
    })),
    types: [
      { type: 'table', name: TYPE_NAMES.table, available: true, reason: null },
      {
        type: 'battery-soc',
        name: TYPE_NAMES['battery-soc'],
        available: socSupported,
        reason: socSupported ? (soc === null && ctx.connected ? 'No battery state of charge is available yet.' : null)
          : `Managing the battery state of charge of ${ctx.modelName || 'this inverter'} is not supported.`,
      },
      { type: 'battery-protection', name: TYPE_NAMES['battery-protection'], available: defs.length > 0 || !ctx.connected, reason: null },
    ],
    socControl: sc ? { supported: socSupported, ...sc, def: scDef ?? null } : { supported: false },
    protection: { supported: true, setting: pr?.setting ?? null, shutdownValue: pr?.shutdownValue ?? null, def: pr ? findDef(ctx.defs, pr.setting) ?? null : null },
    override: { until: overrideUntil(), durations: SUSPEND_MINUTES },
    ruleOptions: ruleOptions(),
  };
}

function nameOf(raw: unknown) {
  return String(raw ?? '').trim().slice(0, 80);
}

export function create(body: { type?: unknown; name?: unknown; enabled?: unknown; config?: unknown }) {
  if (body.type === 'rule') return createRule(body);
  if (!isAutomationType(body.type)) throw new ValidationError(`Unknown automation type '${body.type}'.`);
  const type: AutomationType = body.type;
  const ctx = context();
  const config = normalizeConfig(type, body.config, ctx);
  let enabled = body.enabled !== false;
  let warning: string | null = null;
  if (enabled && (store.findConflict({ id: -1, type, config }) || ruleOwning(config.setting, legacyTarget(type, config)))) {
    enabled = false;
    warning = store.conflictMessage(config.setting, ctx.defs);
  }
  const a = store.add(type, nameOf(body.name), config, enabled);
  log.info(`${automationLabel(a)} created${enabled ? '' : ' (disabled)'}.`);
  if (enabled) runSoon();
  return { automation: view(a), warning };
}

export function update(id: number, body: { name?: unknown; config?: unknown }) {
  const cur = mustGet(id);
  if (store.isRule(cur)) return updateRule(cur as unknown as Rule, body);
  const ctx = context();
  const config = body.config === undefined ? cur.config : normalizeConfig(cur.type, body.config, ctx);
  if (cur.enabled && (store.findConflict({ id, type: cur.type, config }) || ruleOwning(config.setting, legacyTarget(cur.type, config)))) {
    throw new store.ConflictError(store.conflictMessage(config.setting, ctx.defs));
  }
  const a = store.update(id, { config, name: body.name === undefined ? undefined : nameOf(body.name) });
  runner.reset(id);
  log.info(`${automationLabel(a)} updated.`);
  if (a.enabled) runSoon();
  return view(a);
}

export function remove(id: number) {
  const a = mustGet(id);
  if (store.isRule(a)) return removeRule(a as unknown as Rule);
  store.remove(id);
  runner.runtime.delete(id);
  log.info(`${automationLabel(a)} deleted.`);
}

export function setEnabled(id: number, on: boolean) {
  const cur = mustGet(id);
  if (store.isRule(cur)) return setRuleEnabled(cur as unknown as Rule, on);
  if (on && ruleOwning(cur.config.setting, legacyTarget(cur.type, cur.config))) {
    throw new store.ConflictError(store.conflictMessage(cur.config.setting, context().defs));
  }
  const a = on ? store.enable(id, context().defs) : store.disable(id);
  runner.reset(id);
  log.info(`${automationLabel(a)} ${on ? 'enabled' : 'disabled'}.`);
  if (on) runSoon();
  return view(a);
}

const hhmm = (ts: number) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: settings.get('timezone') }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
};

/** Suspends all automations so the user can change settings by hand. */
export function activateOverride(minutes: number) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 1 || m > 7 * 1440) throw new ValidationError('Choose a duration between 1 minute and 7 days.');
  const until = Date.now() + Math.round(m) * 60_000;
  settings.set('automation.override_until', until);
  log.info(`Automations suspended until ${hhmm(until)}.`);
  return { until };
}

export function cancelOverride() {
  const was = overrideUntil();
  settings.set('automation.override_until', 0);
  if (was) log.info('Automation suspension cancelled.');
  runSoon();
  evaluateRules('resumed');
  return { until: 0 };
}

/** What an automation would do right now. */
export function preview(id: number) {
  const a = mustGet(id);
  if (store.isRule(a)) return engine.dryRun(a as unknown as Rule);
  const v = view(a);
  return { id, enabled: a.enabled, state: v.status.state, decision: v.status.decision, plan: v.status.plan, disableMessage: v.status.disableMessage, suspendedUntil: overrideUntil() || null };
}

// ---------- Rules (type "rule") ----------

const provider = () => String(settings.get('grid.driver_id'));

function location() {
  const lat = settings.get('site.latitude');
  const lon = settings.get('site.longitude');
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
}

function forecast() {
  const w = weather.current().weather;
  const tz = settings.get('timezone');
  const today = ymdOf(Date.now(), tz);
  const tomorrow = ymdOf(Date.now() + 86_400_000, tz);
  const day = (d: string) => {
    const v = w?.daily.find((x) => x.date === d)?.radiationMj;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return { today_sun: day(today), tomorrow_sun: day(tomorrow) };
}

function ruleMetrics() {
  const m: Record<string, number | string | boolean | null> = { ...state.totals };
  if (provider() === 'eskom') {
    try {
      const now = Date.now();
      const next = nextOutage(eskomOutages(now), now);
      m[OUTAGE_METRIC] = next ? Math.max(0, Math.round((next.start - now) / 60_000)) : null;
    } catch {
      m[OUTAGE_METRIC] = null;
    }
  }
  const price = liveInputs().price;
  if (price !== null) m.Price = price;
  // Solar surplus and expected solar (src/energy).
  Object.assign(m, outlookMetrics());
  return m;
}

function priceList() {
  if (provider() !== 'energy_charts') return [];
  try {
    return gridPrices();
  } catch {
    return [];
  }
}

export const engine = new RuleEngine({
  now: () => Date.now(),
  tz: () => settings.get('timezone'),
  connected,
  suspended: () => overrideUntil() > 0,
  metrics: ruleMetrics,
  gridAvailable: () => liveInputs().gridAvailable,
  price: () => liveInputs().price,
  prices: priceList,
  forecast,
  location,
  alerts: () => alerts.list().active.map((a) => ({ id: a.id, level: a.level })),
  inverterCount: () => devices.inverterCount,
  defs: () => devices.settingDefs(0),
  values: (i) => devices.settingValues(i),
  setSetting: (i, key, value, source) => devices.setSetting(i, key, value, source),
  limiter: runner.limiter,
  rules: () => store.rules(),
  automationEnabled: (id) => store.get(id)?.enabled ?? null,
  setAutomationEnabled: (id, on) => {
    setEnabled(id, on);
  },
  scene: (id) => getScene(id),
  notify: (channel, title, message) =>
    notify.send(channel, title, message, { ntfy: settings.get('notify.ntfy_url'), webhook: settings.get('notify.webhook_url') }),
  mqttPublish: (topic, payload, retain) => publishMessage(topic, payload, retain),
  entity: (id) => home.states.get(id)?.state ?? null,
  deviceAction: (rule, a, overridden) => deviceRules.run(rule, a, Date.now(), overridden),
  deviceTargets: (a) => deviceRules.targetsOf(a),
  deviceTimers: (now, suspended) => deviceRules.processTimers(now, suspended),
  maxRunsPer10Min: () => Number(settings.get('automation.max_runs_per_10min')) || 0,
  devicePreview: (rule, a) => deviceRules.preview(rule, a),
  log,
});

function ruleContext(ctx = context()): RuleContext {
  return {
    connected: ctx.connected,
    modelName: ctx.modelName,
    inverterCount: ctx.inverterCount,
    defs: ctx.defs,
    sceneExists: (id) => getScene(id) !== null,
    automationExists: (id) => store.get(id) !== null,
    targetExists: deviceRules.targetExists,
  };
}

/** Smart devices for the rule editor: everything visible except Sunroost's own readings (those are metrics already). */
function deviceOptions() {
  const entities = home.registry
    .allEntities()
    .filter((e) => !e.hidden && e.engine !== 'energy')
    .map((e) => {
      const st = home.states.get(e.entityId);
      const d = e.deviceId ? home.registry.device(e.deviceId) : null;
      const num = st && st.state !== '' && Number.isFinite(Number(st.state));
      return {
        id: e.entityId,
        name: home.registry.entityName(e),
        device: d ? home.registry.deviceName(d) : null,
        domain: e.domain,
        unit: e.unit,
        role: e.role,
        areaId: e.areaId ?? d?.areaId ?? null,
        state: st?.state ?? null,
        numeric: Boolean(num) && !servicesFor(e).length,
        services: servicesFor(e),
        // What the editor offers as states and option values.
        attributes: Object.fromEntries(Object.entries(st?.attributes ?? {}).filter(([k]) =>
          ['hvac_modes', 'fan_modes', 'options', 'min', 'max', 'step', 'min_temp', 'max_temp', 'target_temp_step', 'supports_brightness', 'supports_auto_off'].includes(k))),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    entities,
    areas: home.areas.list().map((a) => ({ id: a.id, name: a.name })),
    roles: ENERGY_ROLES,
  };
}

const legacyTarget = (type: string, config: unknown): number | null =>
  type === 'table' ? ((config as { inverter?: number | null }).inverter ?? null) : null;

/** Every (inverter, setting) a rule may write, scenes expanded. */
function ruleTargets(cfg: RuleConfig): { inverter: Target; setting: string }[] {
  const out: { inverter: Target; setting: string }[] = [];
  for (const a of [...cfg.actions, ...cfg.elseActions]) {
    if (a.kind === 'set_setting') out.push({ inverter: a.inverter, setting: a.setting });
    if (a.kind === 'scene') for (const s of getScene(a.scene)?.settings ?? []) out.push({ inverter: s.inverter, setting: s.setting });
  }
  return out;
}

/** The enabled legacy automation owning one of the rule's settings, if any. */
function legacyConflict(cfg: RuleConfig) {
  for (const t of ruleTargets(cfg)) {
    const inverter = t.inverter === 'all' ? null : t.inverter;
    const other = store.findConflict({ id: -1, type: 'table', config: { setting: t.setting, inverter, conditions: [], rows: [] } });
    if (other) return { setting: t.setting, other };
  }
  return null;
}

/** An enabled rule writing `setting` on an overlapping inverter (blocks enabling a legacy automation). */
function ruleOwning(setting: string, inverter: number | null): Rule | null {
  return (
    store.rules().find((r) => r.enabled && ruleTargets(r.config).some((t) => t.setting === setting && (inverter === null || t.inverter === 'all' || t.inverter === inverter))) ?? null
  );
}

const ruleConflictMessage = (setting: string, defs = context().defs) =>
  `Unable to enable this rule. ${defs.find((d) => d.key === setting)?.label ?? setting} is already controlled by a different automation.`;

function ruleLabel(r: Rule) {
  return `Rule #${r.id}${r.name ? ` (${r.name})` : ''}`;
}

function midnight(now = Date.now()) {
  const tz = settings.get('timezone');
  return zonedTs(localTime(now, tz).date, 0, tz);
}

const hasScheduled = (cfg: RuleConfig) => cfg.triggers.some((t) => SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode));

/** Next predicted fire of a rule within 8 days (respecting active days / season), or null. */
function nextRunOf(r: Rule, now = Date.now()): number | null {
  if (!r.enabled) return null;
  const sched = engine.scheduleEnv();
  let best: number | null = null;
  for (const t of r.config.triggers) {
    if (!(SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode))) continue;
    const ts = occurrences(t, now, now + 8 * 86_400_000, sched).find((x) => engine.activeNow(r, x, sched.tz));
    if (ts !== undefined && (best === null || ts < best)) best = ts;
  }
  return best;
}

export function ruleView(r: Rule, ctx = context()) {
  const env = engine.env();
  const detail = evalGroup(r.config.conditions, env);
  const targets = ruleTargets(r.config);
  const missing = ctx.connected && ctx.defs.length ? targets.find((t) => !ctx.defs.some((d) => d.key === t.setting)) : undefined;
  const conflict = legacyConflict(r.config);
  const pendingRevert = runs.reverts().some((x) => x.ruleId === r.id);
  const pendingDelay = engine.hasPending(r.id);
  let status: 'disabled' | 'active' | 'idle' | 'suspended' | 'not_supported' | 'conflict';
  let reason: string | null = null;
  if (!r.enabled) status = 'disabled';
  else if (missing) {
    status = 'not_supported';
    reason = `"${missing.setting}" is not supported by ${ctx.modelName || 'this inverter'}.`;
  } else if (conflict) {
    status = 'conflict';
    reason = store.conflictMessage(conflict.setting, ctx.defs);
  } else if (overrideUntil() > 0) status = 'suspended';
  else if (pendingDelay || pendingRevert || (r.config.conditions.items.length > 0 && detail.match)) status = 'active';
  else status = 'idle';
  const last = runs.lastRun(r.id);
  const sceneName = (id: number) => getScene(id)?.name ?? null;
  return {
    ...r,
    typeName: 'Rule',
    label: ruleLabel(r),
    status: { state: status, disableMessage: reason },
    view: {
      summary: summarize(r.config, ctx.defs, sceneName),
      nextRun: nextRunOf(r),
      onCondition: r.config.triggers.some((t) => !(SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode)) && t.kind !== 'manual'),
      lastRun: last ? { ts: last.ts, result: last.result } : null,
      runsToday: runs.countRuns(r.id, midnight()),
      status,
      statusMessage: reason,
      conditionsMet: detail.match,
      conditions: detail,
      pendingDelay,
      pendingRevert,
    },
  };
}

function nameOfRule(raw: unknown) {
  return String(raw ?? '').trim().slice(0, 80);
}

export function createRule(body: { name?: unknown; enabled?: unknown; config?: unknown }) {
  const ctx = context();
  const config = normalizeRule(body.config, ruleContext(ctx));
  let enabled = body.enabled !== false;
  let warning: string | null = null;
  const conflict = enabled ? legacyConflict(config) : null;
  if (conflict) {
    enabled = false;
    warning = ruleConflictMessage(conflict.setting, ctx.defs);
  }
  const a = store.add('rule', nameOfRule(body.name), config, enabled) as unknown as Rule;
  log.info(`${ruleLabel(a)} created${enabled ? '' : ' (disabled)'}.`);
  evaluateRules('rule created');
  return { automation: ruleView(a, ctx), warning };
}

function updateRule(cur: Rule, body: { name?: unknown; config?: unknown }) {
  const ctx = context();
  const config = body.config === undefined ? cur.config : normalizeRule(body.config, ruleContext(ctx));
  const conflict = cur.enabled ? legacyConflict(config) : null;
  if (conflict) throw new store.ConflictError(ruleConflictMessage(conflict.setting, ctx.defs));
  const a = store.update(cur.id, { config, name: body.name === undefined ? undefined : nameOfRule(body.name) }) as unknown as Rule;
  log.info(`${ruleLabel(a)} updated.`);
  evaluateRules('rule updated');
  return ruleView(a, ctx);
}

function removeRule(r: Rule) {
  engine.cancel(r.id, 'the rule was deleted');
  store.remove(r.id);
  runs.forgetTriggers(r.id);
  log.info(`${ruleLabel(r)} deleted.`);
}

function setRuleEnabled(r: Rule, on: boolean) {
  if (on) {
    const conflict = legacyConflict(r.config);
    if (conflict) throw new store.ConflictError(ruleConflictMessage(conflict.setting));
  } else engine.cancel(r.id, 'the rule was disabled');
  const a = store.update(r.id, { enabled: on }) as unknown as Rule;
  log.info(`${ruleLabel(a)} ${on ? 'enabled' : 'disabled'}.`);
  evaluateRules(on ? 'rule enabled' : 'rule disabled');
  return ruleView(a);
}

function mustGetRule(id: number): Rule {
  const a = mustGet(id);
  if (!store.isRule(a)) throw new ValidationError(`${automationLabel(a)} is not a rule; only rules can be run.`);
  return a as unknown as Rule;
}

/** POST /api/automations/:id/run[?dry=1][&force=1] */
export async function runRule(id: number, opts: { dry?: boolean; force?: boolean } = {}) {
  const r = mustGetRule(id);
  if (opts.dry) return engine.dryRun(r, opts.force);
  return engine.runNow(r, opts.force);
}

export function runHistory(id: number | null, limit = 50) {
  if (id !== null) mustGet(id);
  return runs.listRuns({ automationId: id ?? undefined, limit });
}

/** Predicted fires of scheduled triggers in the next `hours`, then rules that fire on a condition (at: null). */
export function upcoming(hours = 24) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const now = Date.now();
  const sched = engine.scheduleEnv();
  const defs = context().defs;
  const timeline: { at: number | null; automationId: number; name: string; trigger: string; summary: string; onCondition?: boolean }[] = [];
  const onCondition: typeof timeline = [];
  for (const r of store.rules()) {
    if (!r.enabled) continue;
    const summary = summarize(r.config, defs, (id) => getScene(id)?.name ?? null);
    for (const t of r.config.triggers) {
      const scheduled = SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode);
      if (scheduled) {
        for (const at of occurrences(t, now, now + h * 3_600_000, sched)) {
          if (engine.activeNow(r, at, sched.tz)) timeline.push({ at, automationId: r.id, name: r.name, trigger: describeTrigger(t), summary });
        }
      } else if (t.kind !== 'manual') {
        onCondition.push({ at: null, automationId: r.id, name: r.name, trigger: `On condition: ${describeTrigger(t)}`, summary, onCondition: true });
      }
    }
  }
  timeline.sort((a, b) => a.at! - b.at! || a.automationId - b.automationId);
  return [...timeline.slice(0, 500), ...onCondition];
}

export function ruleTemplates() {
  const ctx = context();
  const tctx: TemplateContext = { ...ruleContext(ctx), socControl: ctx.socControl };
  return buildTemplates(tctx);
}

const ALERT_IDS = [
  { id: 'battery-low', title: 'Battery low' },
  { id: 'battery-full', title: 'Battery full' },
  { id: 'grid-outage', title: 'Grid outage' },
  { id: 'planned-outage', title: 'Planned grid outage soon' },
  { id: 'inverter-hot', title: 'Inverter running hot' },
  { id: 'inverter-link', title: 'Inverter connection lost' },
  { id: 'battery-link', title: 'Battery connection lost' },
  { id: 'fault-0', title: 'Inverter fault' },
];

const RULE_METRICS = [
  'Battery state of charge', 'PV power', 'Load power', 'Grid power', 'Battery power', 'Grid voltage', 'Temperature',
  'Battery voltage', 'Battery temperature', 'Load percentage', 'Grid frequency',
];

function ruleOptions() {
  const names = new Set<string>([SURPLUS_METRIC, ...Object.values(FORECAST_METRICS), ...RULE_METRICS, ...HISTORY_TOTAL_METRICS]);
  for (const [k, v] of Object.entries(state.totals)) if (typeof v === 'number' && !metaOf(k).info) names.add(k);
  if (provider() === 'eskom') names.add(OUTAGE_METRIC);
  const loc = location();
  const fc = forecast();
  const now = Date.now();
  return {
    triggerKinds: TRIGGER_KINDS,
    conditionKinds: CONDITION_KINDS,
    actionKinds: ACTION_KINDS,
    metrics: [...names].map((name) => ({ name, unit: metricUnit(name) || null })),
    alerts: ALERT_IDS,
    sun: loc ? sunToday(now, { tz: settings.get('timezone'), location: loc }) : null,
    sunWarning: loc ? null : 'No site location set (Configuration › General): sunrise and sunset use 06:00 and 18:00.',
    priceAvailable: provider() === 'energy_charts',
    priceUnit: `${settings.get('grid.currency')}/kWh`,
    outageAvailable: provider() === 'eskom',
    forecastAvailable: fc.today_sun !== null || fc.tomorrow_sun !== null,
    forecast: fc,
    notify: { ntfy: Boolean(settings.get('notify.ntfy_url').trim()), webhook: Boolean(settings.get('notify.webhook_url').trim()) },
    scenes: allScenes().map((s) => ({ id: s.id, name: s.name })),
    devices: deviceOptions(),
  };
}

// ---------- Scenes ----------

export function sceneList() {
  return allScenes();
}

function sceneContext() {
  const ctx = context();
  return { connected: ctx.connected, modelName: ctx.modelName, inverterCount: ctx.inverterCount, defs: ctx.defs };
}

function mustGetScene(id: number): Scene {
  const s = getScene(id);
  if (!s) throw new NotFoundError(`Scene #${id} not found`);
  return s;
}

export function createScene(body: unknown) {
  const s = addScene(normalizeScene(body, sceneContext()));
  log.info(`Scene "${s.name}" created.`);
  return s;
}

export function editScene(id: number, body: unknown) {
  mustGetScene(id);
  return updateScene(id, normalizeScene(body, sceneContext()));
}

export function deleteScene(id: number) {
  const s = mustGetScene(id);
  const users = store.rules().filter((r) => [...r.config.actions, ...r.config.elseActions].some((a) => a.kind === 'scene' && a.scene === id));
  if (users.length) throw new store.ConflictError(`Scene "${s.name}" is used by ${users.map(ruleLabel).join(', ')}.`);
  removeScene(id);
  log.info(`Scene "${s.name}" deleted.`);
}

export function applyScene(id: number) {
  return engine.applyScene(mustGetScene(id));
}

// ---------- Notifications ----------

export const notifications = {
  list: (limit = 50) => notify.feed(limit),
  markRead: () => {
    notify.markAllRead();
    return { ok: true, unread: 0 };
  },
  test: async (channel: unknown) => {
    if (channel !== 'app' && channel !== 'ntfy' && channel !== 'webhook') throw new ValidationError('Channel must be app, ntfy or webhook.');
    return notify.send(channel, 'Sunroost test notification', 'Notifications from Sunroost are working.', {
      ntfy: settings.get('notify.ntfy_url'),
      webhook: settings.get('notify.webhook_url'),
    });
  },
  events: notify.events,
};
