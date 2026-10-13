/**
 * The rule engine: detects trigger fires, applies cooldown/limits, evaluates conditions,
 * arbitrates between rules that write the same setting in one evaluation, executes actions
 * (with delays), and restores settings after `revertAfterMinutes`.
 *
 * Evaluations are serialized. They run on state refreshes (throttled by the caller), on a 30 s
 * tick and at the exact next scheduled fire / hold deadline / revert (the engine arms one timer).
 *
 * Trigger semantics:
 * - Scheduled triggers (time, sun, forecast, interval, price hours) fire for the latest scheduled
 *   time in (last fire, now], looking back at most GRACE_MS. The last fire per trigger is
 *   persisted, so a restart neither repeats a fire nor (within the grace window) misses one.
 * - Metric and price-threshold triggers are edge triggered: they fire when the value crosses into
 *   the condition and has stayed there `forMinutes`, and re-arm once it leaves. The first value
 *   seen after a start (or after creating the rule) is a baseline and never fires.
 * - Grid and alert triggers fire when the alert (grid-outage for grid) is raised/cleared between
 *   two evaluations.
 *
 * Delayed actions are in-memory timers only: a restart cancels them (pending reverts, however,
 * are persisted and still happen after a restart).
 */
import type { Value } from '../core/metrics.ts';
import type { SetResult } from '../devices/manager.ts';
import type { SettingDef, SettingValues } from '../devices/types.ts';
import { localTime } from './conditions.ts';
import {
  describeAction, describeTrigger, ENTITY_ID, evalGroup, inDateRange, inTimeRange, SCHEDULED_KINDS,
  type Action, type CondDetail, type DeviceAction, type Rule, type RuleEnv, type Target, type Trigger,
} from './rules.ts';
import * as runs from './runs.ts';
import type { RateLimiter } from './runner.ts';
import { inPriceHours, latestDue, nextFire, type PricePoint, type ScheduleEnv } from './scheduler.ts';
import type { Scene } from './scenes.ts';
import type { SendResult } from './notify.ts';
import { sunIsUp } from './sun.ts';
import { zonedTs } from './time.ts';
import { findDef, fmtValue, sameValue } from './types.ts';

/** How far back a missed scheduled fire is still executed (e.g. after a restart). */
export const GRACE_MS = 10 * 60_000;
const MAX_WAKE_MS = 6 * 3_600_000;

export interface EngineDeps {
  now(): number;
  tz(): string;
  /** Inverter link up (writes possible). */
  connected(): boolean;
  /** Automations suspended by the user (no writes). */
  suspended(): boolean;
  /** Numeric live metrics by name (system totals plus derived ones). */
  metrics(): Record<string, Value>;
  gridAvailable(): boolean | null;
  price(): number | null;
  prices(): PricePoint[];
  forecast(): { today_sun: number | null; tomorrow_sun: number | null };
  location(): { lat: number; lon: number } | null;
  alerts(): { id: string; level: string }[];
  inverterCount(): number;
  defs(): SettingDef[];
  values(index: number): SettingValues;
  setSetting(index: number, key: string, value: Value, source: string): Promise<SetResult>;
  limiter: RateLimiter;
  rules(): Rule[];
  automationEnabled(id: number): boolean | null;
  /** Enables/disables any automation; throws on conflict. */
  setAutomationEnabled(id: number, enabled: boolean): void;
  scene(id: number): Scene | null;
  notify(channel: 'app' | 'ntfy' | 'webhook', title: string, message: string): Promise<SendResult>;
  /** Publishes through the active MQTT transport; returns an error message or null. */
  mqttPublish(topic: string, payload: string, retain: boolean): string | null;
  log: { info(m: string): void; warn(m: string): void };
  /** Current state of a smart-device entity (for device triggers, conditions and readings). */
  entity?(id: string): string | null;
  /** Runs a device action (guard rails included); one result per device. `overridden` = devices a higher-priority rule won. */
  deviceAction?(rule: Rule | null, a: DeviceAction, overridden: Map<string, number>): Promise<runs.RunAction[]>;
  /** Entity ids a device action commands right now (for priority between rules). */
  deviceTargets?(a: DeviceAction): string[];
  /** Due device auto-off/revert timers. */
  deviceTimers?(now: number, suspended: boolean): Promise<void>;
  /** Loop protection: maximum executed runs of one rule in 10 minutes (0 = off). */
  maxRunsPer10Min?(): number;
  /** What a device action would do now, without doing it. */
  devicePreview?(rule: Rule | null, a: DeviceAction): { text: string; outcome: string }[];
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface EdgeState {
  inside: boolean;
  since: number;
  fired: boolean;
  /** Device triggers: the last state seen, and the state before entering the target state. */
  last?: string;
  enteredFrom?: string;
}

/** One write resolved to a concrete inverter. */
interface Write {
  index: number;
  setting: string;
  value: Value;
  /** e.g. 'scene "Night"'. */
  via?: string;
}

interface Plan {
  rule: Rule;
  trigger: string;
  at: number;
  actions: Action[];
  /** "index:setting" → id of the rule that won it. */
  overridden: Map<string, number>;
}

interface Pending {
  handle: unknown;
  runId: number;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const triggerKey = (t: Trigger, i: number) => `${i}:${JSON.stringify(t)}`;

export class RuleEngine {
  private deps: EngineDeps;
  private edges = new Map<string, EdgeState>();
  private prevAlerts: Set<string> | null = null;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private wake: unknown = null;
  private stopped = false;
  lastEvaluation = 0;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  private setTimer(fn: () => void, ms: number) {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(h: unknown) {
    if (this.deps.clearTimer) this.deps.clearTimer(h);
    else clearTimeout(h as NodeJS.Timeout);
  }

  /** Serializes evaluations, runs and delayed continuations. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() {
    this.stopped = true;
    if (this.wake) this.clearTimer(this.wake);
    this.wake = null;
    for (const p of this.pending.values()) this.clearTimer(p.handle);
    this.pending.clear();
  }

  // ---------- Environment ----------

  scheduleEnv(): ScheduleEnv {
    return { tz: this.deps.tz(), location: this.deps.location(), prices: this.deps.prices() };
  }

  env(now = this.deps.now()): RuleEnv {
    const tz = this.deps.tz();
    const m = this.deps.metrics();
    const prices = this.deps.prices();
    const loc = this.deps.location();
    return {
      now,
      tz,
      // Device readings are metrics too, by entity id ("sensor.geyser_power").
      metric: (name) => (ENTITY_ID.test(name) ? num(Number(this.deps.entity?.(name) ?? NaN)) : num(m[name])),
      entity: (id) => this.deps.entity?.(id) ?? null,
      gridAvailable: this.deps.gridAvailable(),
      price: this.deps.price(),
      inCheapestHours: (n) => inPriceHours(prices, 'cheapest', n, now, tz),
      sunUp: loc ? sunIsUp(now, loc.lat, loc.lon) : inTimeRange(localTime(now, tz).minutes, '06:00', '18:00'),
      forecast: this.deps.forecast(),
      inverterCount: this.deps.inverterCount(),
      values: (i) => this.deps.values(i),
      automationEnabled: (id) => this.deps.automationEnabled(id),
      defs: this.deps.defs(),
    };
  }

  /** Inverter indexes for a target. */
  private indexes(t: Target): number[] {
    const n = Math.max(1, this.deps.inverterCount());
    if (t === 'all') return Array.from({ length: n }, (_, i) => i);
    return [t];
  }

  /** set_setting and scene actions resolved to concrete writes. */
  writesOf(a: Action): Write[] {
    if (a.kind === 'set_setting') return this.indexes(a.inverter).map((index) => ({ index, setting: a.setting, value: a.value }));
    if (a.kind === 'scene') {
      const s = this.deps.scene(a.scene);
      if (!s) return [];
      return s.settings.flatMap((x) => this.indexes(x.inverter).map((index) => ({ index, setting: x.setting, value: x.value, via: `scene "${s.name}"` })));
    }
    return [];
  }

  // ---------- Evaluation ----------

  evaluate(reason = 'tick'): Promise<void> {
    return this.enqueue(() => this.evaluateNow(reason));
  }

  private async evaluateNow(_reason: string) {
    if (this.stopped) return;
    const now = this.deps.now();
    this.lastEvaluation = now;
    const env = this.env(now);
    const sched = this.scheduleEnv();
    const alertsNow = new Map(this.deps.alerts().map((a) => [a.id, a.level]));
    const prev = this.prevAlerts;
    const raised = prev ? [...alertsNow.keys()].filter((id) => !prev.has(id)) : [];
    const cleared = prev ? [...prev].filter((id) => !alertsNow.has(id)) : [];
    this.prevAlerts = new Set(alertsNow.keys());

    const seen = new Set<string>();
    const plans: Plan[] = [];
    for (const rule of this.deps.rules()) {
      if (!rule.enabled) continue;
      let fired: { text: string; at: number } | null = null;
      rule.config.triggers.forEach((t, i) => {
        const key = `${rule.id}:${triggerKey(t, i)}`;
        seen.add(key);
        const f = this.check(rule, t, i, key, now, env, sched, { raised, cleared, levels: alertsNow });
        if (f && (!fired || f.at > fired.at)) fired = f;
      });
      if (!fired) continue;
      const f = fired as { text: string; at: number };
      const plan = this.prepare(rule, f.text, f.at, now, env, false);
      if (plan) plans.push(plan);
    }
    for (const k of this.edges.keys()) if (!seen.has(k)) this.edges.delete(k);

    this.arbitrate(plans);
    for (const p of plans) await this.execute(p, now);
    await this.processReverts(now);
    await this.deps.deviceTimers?.(now, this.deps.suspended());
    this.armWake(now);
  }

  /** Whether one trigger fires in this evaluation; updates its state. */
  private check(
    rule: Rule, t: Trigger, i: number, key: string, now: number, env: RuleEnv, sched: ScheduleEnv,
    alerts: { raised: string[]; cleared: string[]; levels: Map<string, string> },
  ): { text: string; at: number } | null {
    const text = cap(describeTrigger(t));
    if (SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode)) {
      const tk = triggerKey(t, i);
      const last = runs.lastFire(rule.id, tk);
      const from = Math.max(last ?? 0, rule.updated, now - GRACE_MS);
      const due = latestDue(t, from, now, sched);
      if (due === null) return null;
      runs.setLastFire(rule.id, tk, due);
      if (t.kind === 'forecast') {
        const v = env.forecast[t.metric];
        if (v === null || !(t.op === 'above' ? v > t.value : v < t.value)) return null;
      }
      return { text, at: due };
    }
    if (t.kind === 'metric' || (t.kind === 'price' && t.op)) {
      const v = t.kind === 'metric' ? env.metric(t.metric) : env.price;
      if (v === null) return null;
      const op = t.op!;
      const limit = t.value!;
      const inside = op === 'above' ? v > limit : v < limit;
      const holdMs = (t.kind === 'metric' ? t.forMinutes : 0) * 60_000;
      const s = this.edges.get(key);
      if (!s) {
        // Baseline: a value already inside the condition counts as having fired.
        this.edges.set(key, { inside, since: now, fired: inside });
        return null;
      }
      if (!inside) {
        s.inside = false;
        s.fired = false;
        return null;
      }
      if (!s.inside) {
        s.inside = true;
        s.since = now;
        s.fired = false;
      }
      if (!s.fired && now - s.since >= holdMs) {
        s.fired = true;
        return { text, at: now };
      }
      return null;
    }
    if (t.kind === 'device') return this.checkDevice(t, key, now, text);
    if (t.kind === 'grid') {
      const hit = t.event === 'lost' ? alerts.raised.includes('grid-outage') : alerts.cleared.includes('grid-outage');
      return hit ? { text, at: now } : null;
    }
    if (t.kind === 'alert') {
      const hit = alerts.raised.some((id) => (t.alert ? id === t.alert : alerts.levels.get(id) === t.level));
      return hit ? { text, at: now } : null;
    }
    return null;
  }

  /**
   * Device triggers. With a target state: fires when the device enters it (from `from`, if given)
   * and has stayed there `forMinutes`; re-arms when it leaves. Without one: fires on any change.
   * The first state seen is a baseline and never fires.
   */
  private checkDevice(t: Extract<Trigger, { kind: 'device' }>, key: string, now: number, text: string): { text: string; at: number } | null {
    const st = this.deps.entity?.(t.entity) ?? null;
    if (st === null) return null;
    const eq = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
    const s = this.edges.get(key);
    if (!s) {
      const inside = t.to ? eq(st, t.to) : false;
      this.edges.set(key, { inside, since: now, fired: inside, last: st });
      return null;
    }
    if (!t.to) {
      const prev = s.last;
      s.last = st;
      if (eq(prev, st)) return null;
      return !t.from || eq(prev, t.from) ? { text, at: now } : null;
    }
    if (!eq(st, t.to)) {
      s.inside = false;
      s.fired = false;
      s.last = st;
      return null;
    }
    if (!s.inside) {
      s.inside = true;
      s.since = now;
      s.fired = false;
      s.enteredFrom = s.last;
    }
    s.last = st;
    if (t.from && !eq(s.enteredFrom, t.from)) return null;
    if (!s.fired && now - s.since >= t.forMinutes * 60_000) {
      s.fired = true;
      return { text, at: now };
    }
    return null;
  }

  /** Active days / seasonal window. */
  activeNow(rule: Rule, ts: number, tz = this.deps.tz()): boolean {
    const o = rule.config.options;
    const lt = localTime(ts, tz);
    if (o.activeDays && !o.activeDays.includes(lt.dow)) return false;
    if (o.activeFrom && o.activeTo && !inDateRange(lt.date.slice(5), o.activeFrom, o.activeTo)) return false;
    return true;
  }

  /** Why a triggered rule may not run now (cooldown / daily limit), or null. */
  private limitReason(rule: Rule, now: number): string | null {
    const o = rule.config.options;
    if (o.cooldownMinutes > 0) {
      const last = runs.lastExecuted(rule.id);
      if (last !== null && now - last < o.cooldownMinutes * 60_000) {
        return `Cooldown: last run ${Math.max(0, Math.round((now - last) / 60_000))} min ago (cooldown ${o.cooldownMinutes} min)`;
      }
    }
    const loop = this.deps.maxRunsPer10Min?.() ?? 0;
    if (loop > 0) {
      const n = runs.countRuns(rule.id, now - 10 * 60_000);
      if (n >= loop) return `Paused by loop protection: ran ${n} times in 10 minutes (limit ${loop})`;
    }
    if (o.maxRunsPerDay > 0) {
      const tz = this.deps.tz();
      const midnight = zonedTs(localTime(now, tz).date, 0, tz);
      const n = runs.countRuns(rule.id, midnight);
      if (n >= o.maxRunsPerDay) return `Daily limit reached (${n} of ${o.maxRunsPerDay} runs today)`;
    }
    return null;
  }

  /** Gates, conditions and branch choice for a fired rule. Returns null when nothing should run. */
  private prepare(rule: Rule, trigger: string, at: number, now: number, env: RuleEnv, manual: boolean, force = false): Plan | null {
    if (!manual) {
      if (!this.activeNow(rule, now, env.tz)) return null;
      const why = this.limitReason(rule, now);
      if (why) {
        runs.addRun({ automationId: rule.id, sceneId: null, ts: now, trigger, dryRun: false, result: 'skipped', actions: [{ text: 'Run skipped', ok: true, skipped: true, message: why }] });
        return null;
      }
    }
    const detail = evalGroup(rule.config.conditions, env);
    const actions = force || detail.match ? rule.config.actions : rule.config.elseActions;
    if (!actions.length) {
      runs.addRun({
        automationId: rule.id, sceneId: null, ts: now, trigger, dryRun: false, result: 'skipped',
        actions: [{ text: 'Conditions not met', ok: true, skipped: true, message: failedConditions(detail) }],
      });
      return null;
    }
    return { rule, trigger: detail.match || force ? trigger : `${trigger} (conditions not met: else actions)`, at, actions, overridden: new Map() };
  }

  /** Higher priority wins a setting written by several rules in one evaluation; ties go to the most recently triggered. */
  private arbitrate(plans: Plan[]) {
    const claims = new Map<string, Plan[]>();
    for (const p of plans) {
      const immediate = p.actions.slice(0, firstDelay(p.actions));
      const keys = new Set([
        ...immediate.flatMap((a) => this.writesOf(a)).map((w) => `${w.index}:${w.setting}`),
        // Devices count as "settings" too: one key per entity a device action commands.
        ...immediate.flatMap((a) => (a.kind === 'device' ? (this.deps.deviceTargets?.(a) ?? []) : [])).map((id) => `device:${id}`),
      ]);
      for (const k of keys) claims.set(k, [...(claims.get(k) ?? []), p]);
    }
    for (const [k, list] of claims) {
      if (list.length < 2) continue;
      const winner = [...list].sort(
        (a, b) => b.rule.config.priority - a.rule.config.priority || b.at - a.at || b.rule.id - a.rule.id,
      )[0];
      for (const p of list) if (p !== winner) p.overridden.set(k, winner.rule.id);
    }
  }

  cancel(ruleId: number, why: string) {
    const p = this.pending.get(ruleId);
    if (!p) return;
    this.clearTimer(p.handle);
    this.pending.delete(ruleId);
    const run = runs.getRun(p.runId);
    if (run) {
      runs.updateRun(p.runId, [...run.actions, { text: 'Remaining delayed actions', ok: true, skipped: true, message: `Cancelled: ${why}` }]);
    }
  }

  hasPending(ruleId: number) {
    return this.pending.has(ruleId);
  }

  private async execute(p: Plan, now: number) {
    this.cancel(p.rule.id, 'a newer run of this rule started');
    const run = runs.addRun({ automationId: p.rule.id, sceneId: null, ts: now, trigger: p.trigger, dryRun: false, result: 'skipped', actions: [] });
    const done = await this.runActions(p.rule, p.actions, run.id, [], p.overridden);
    this.deps.log.info(`Rule #${p.rule.id}${p.rule.name ? ` (${p.rule.name})` : ''}: ${p.trigger} → ${runs.resultOf(done)}`);
  }

  /** Runs actions until the first delay, then schedules the rest. Persists the run as it goes. */
  private async runActions(rule: Rule, actions: Action[], runId: number, sofar: runs.RunAction[], overridden: Map<string, number>): Promise<runs.RunAction[]> {
    const out = [...sofar];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.kind === 'delay') {
        const rest = actions.slice(i + 1);
        out.push({ text: cap(describeAction(a)), ok: true, message: rest.length ? `Continuing at ${this.hhmm(this.deps.now() + a.minutes * 60_000)}` : 'Nothing left to run' });
        runs.updateRun(runId, out);
        if (rest.length) {
          const handle = this.setTimer(() => {
            this.pending.delete(rule.id);
            void this.enqueue(() => this.continueRun(rule.id, runId, rest));
          }, a.minutes * 60_000);
          this.pending.set(rule.id, { handle, runId });
        }
        return out;
      }
      out.push(...(await this.runAction(rule, a, overridden)));
      runs.updateRun(runId, out);
    }
    return out;
  }

  private async continueRun(ruleId: number, runId: number, rest: Action[]) {
    const run = runs.getRun(runId);
    if (!run || this.stopped) return;
    const rule = this.deps.rules().find((r) => r.id === ruleId);
    if (!rule || !rule.enabled) {
      runs.updateRun(runId, [...run.actions, { text: 'Remaining delayed actions', ok: true, skipped: true, message: 'Cancelled: the rule was disabled or deleted' }]);
      return;
    }
    await this.runActions(rule, rest, runId, run.actions, new Map());
  }

  private hhmm(ts: number) {
    const m = localTime(ts, this.deps.tz()).minutes;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /** Message templates: {soc} {pv} {load} {grid} {battery} {price} {time} {rule}. */
  renderTemplate(text: string, rule: Rule | null, now = this.deps.now()): string {
    const m = this.deps.metrics();
    const w = (k: string) => (num(m[k]) === null ? '?' : `${Math.round(num(m[k])!)} W`);
    const vars: Record<string, string> = {
      soc: num(m['Battery state of charge']) === null ? '?' : `${Math.round(num(m['Battery state of charge'])!)}%`,
      pv: w('PV power'),
      load: w('Load power'),
      grid: w('Grid power'),
      battery: w('Battery power'),
      price: this.deps.price() === null ? '?' : String(this.deps.price()),
      time: this.hhmm(now),
      rule: rule?.name || (rule ? `Rule #${rule.id}` : ''),
    };
    return text.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
  }

  private async runAction(rule: Rule, a: Action, overridden: Map<string, number>): Promise<runs.RunAction[]> {
    const defs = this.deps.defs();
    const text = cap(describeAction(a, defs, (id) => this.deps.scene(id)?.name ?? null));
    switch (a.kind) {
      case 'set_setting':
      case 'scene': {
        if (a.kind === 'scene' && !this.deps.scene(a.scene)) return [{ text, ok: false, message: `Scene #${a.scene} no longer exists` }];
        const out: runs.RunAction[] = [];
        for (const w of this.writesOf(a)) out.push(await this.write(rule, w, overridden, rule.config.options.revertAfterMinutes));
        return out;
      }
      case 'notify': {
        const title = this.renderTemplate(a.title, rule);
        const res = await this.deps.notify(a.channel, title, this.renderTemplate(a.message, rule));
        return [{ text, ok: res.ok, message: res.ok ? 'Sent' : res.error ?? 'Failed' }];
      }
      case 'mqtt': {
        const err = this.deps.mqttPublish(a.topic, this.renderTemplate(a.payload, rule), a.retain);
        return [{ text, ok: !err, message: err ?? 'Published' }];
      }
      case 'automation': {
        try {
          this.deps.setAutomationEnabled(a.id, a.enabled);
          return [{ text, ok: true, message: a.enabled ? 'Enabled' : 'Disabled' }];
        } catch (err) {
          return [{ text, ok: false, message: (err as Error).message }];
        }
      }
      case 'delay':
        return [];
      case 'device': {
        // Device actions don't need the inverter, but do respect a suspension.
        if (this.deps.suspended()) return [{ text, ok: true, skipped: true, message: 'Skipped: automations are suspended' }];
        if (!this.deps.deviceAction) return [{ text, ok: false, message: 'Smart devices are not available' }];
        return this.deps.deviceAction(rule, a, overridden);
      }
    }
  }

  /** Why writes can't happen right now, or null. */
  blockedReason(): string | null {
    if (this.deps.suspended()) return 'Skipped: automations are suspended';
    if (!this.deps.connected()) return 'Skipped: not connected to the inverter';
    return null;
  }

  private writeText(w: Write) {
    const def = findDef(this.deps.defs(), w.setting);
    const where = this.deps.inverterCount() > 1 ? ` on inverter ${w.index + 1}` : '';
    return `${w.via ? cap(w.via) + ': set' : 'Set'} ${def?.label ?? w.setting} to ${fmtValue(def, w.value)}${where}`;
  }

  /** One setting write for a rule (or a scene applied by hand when `rule` is null). */
  private async write(rule: Rule | null, w: Write, overridden: Map<string, number>, revertMinutes: number, bypass = false): Promise<runs.RunAction> {
    const text = this.writeText(w);
    const k = `${w.index}:${w.setting}`;
    const winner = overridden.get(k);
    if (winner !== undefined) return { text, ok: true, skipped: true, message: `skipped (overridden by #${winner})` };
    const blocked = bypass ? (this.deps.connected() ? null : 'Skipped: not connected to the inverter') : this.blockedReason();
    if (blocked) return { text, ok: true, skipped: true, message: blocked };
    const now = this.deps.now();
    const current = this.deps.values(w.index)[w.setting] ?? null;
    if (sameValue(current, w.value)) {
      this.trackRevert(rule, w, current, false, revertMinutes, now);
      return { text, ok: true, skipped: true, message: 'Already set' };
    }
    // Scenes applied by hand are user writes: like UI changes they bypass the automation rate limiter.
    if (!bypass) {
      const wait = this.deps.limiter.wait(k, w.value, now);
      if (wait > 0) return { text, ok: false, message: `Held by write protection (retry possible in ${Math.ceil(wait / 1000)} s)` };
      this.deps.limiter.record(k, w.value, now);
    }
    let res: SetResult;
    try {
      res = await this.deps.setSetting(w.index, w.setting, w.value, rule ? `automation #${rule.id}` : 'scene');
    } catch (err) {
      res = { ok: false, message: (err as Error).message };
    }
    if (res.ok) this.trackRevert(rule, w, current, true, revertMinutes, now);
    return { text, ok: res.ok, message: res.message };
  }

  /** Revert bookkeeping after a write (or a no-op because the value was already set). */
  private trackRevert(rule: Rule | null, w: Write, previous: Value, changed: boolean, revertMinutes: number, now: number) {
    const existing = runs.findRevert(w.index, w.setting);
    if (rule && revertMinutes > 0) {
      const due = now + revertMinutes * 60_000;
      if (existing) runs.updateRevert(existing.id, { ruleId: rule.id, applied: w.value, due, setAt: now });
      else if (changed && previous !== null) runs.addRevert({ ruleId: rule.id, inverter: w.index, setting: w.setting, previous, applied: w.value, due, setAt: now });
    } else if (existing && changed) {
      // Another run changed the setting in between: its value stands.
      runs.removeRevert(existing.id);
    }
  }

  private async processReverts(now: number) {
    for (const r of runs.reverts()) {
      if (r.due > now) continue;
      if (this.blockedReason()) continue; // retried once writes are possible again
      const rule = this.deps.rules().find((x) => x.id === r.ruleId) ?? null;
      const def = findDef(this.deps.defs(), r.setting);
      const label = def?.label ?? r.setting;
      const trigger = `Revert after ${rule?.config.options.revertAfterMinutes ?? '?'} min`;
      const current = this.deps.values(r.inverter)[r.setting];
      if (current === undefined) continue; // settings not read yet
      const text = `Restore ${label} to ${fmtValue(def, r.previous)}`;
      if (!sameValue(current, r.applied)) {
        runs.removeRevert(r.id);
        runs.addRun({ automationId: r.ruleId, sceneId: null, ts: now, trigger, dryRun: false, result: 'skipped', actions: [{ text, ok: true, skipped: true, message: `Not restored: ${label} was changed to ${fmtValue(def, current)} in the meantime` }] });
        continue;
      }
      const k = `${r.inverter}:${r.setting}`;
      if (this.deps.limiter.wait(k, r.previous, now) > 0) continue;
      this.deps.limiter.record(k, r.previous, now);
      runs.removeRevert(r.id);
      let res: SetResult;
      try {
        res = await this.deps.setSetting(r.inverter, r.setting, r.previous, `automation #${r.ruleId} (revert)`);
      } catch (err) {
        res = { ok: false, message: (err as Error).message };
      }
      runs.addRun({ automationId: r.ruleId, sceneId: null, ts: now, trigger, dryRun: false, result: res.ok ? 'ok' : 'failed', actions: [{ text, ok: res.ok, message: res.message }] });
      this.deps.log.info(`Rule #${r.ruleId}: ${text}: ${res.message}`);
    }
  }

  // ---------- Wake-up timer ----------

  /** Earliest moment something is due: a scheduled fire, a hold deadline or a revert. */
  nextWake(now: number): number | null {
    const sched = this.scheduleEnv();
    let next: number | null = null;
    const consider = (ts: number | null) => {
      if (ts !== null && ts > now && (next === null || ts < next)) next = ts;
    };
    for (const rule of this.deps.rules()) {
      if (!rule.enabled) continue;
      rule.config.triggers.forEach((t, i) => {
        if (SCHEDULED_KINDS.has(t.kind) || (t.kind === 'price' && t.mode)) consider(nextFire(t, now, sched, MAX_WAKE_MS));
        if (t.kind === 'metric' && t.forMinutes > 0) {
          const s = this.edges.get(`${rule.id}:${triggerKey(t, i)}`);
          if (s?.inside && !s.fired) consider(s.since + t.forMinutes * 60_000);
        }
      });
    }
    for (const r of runs.reverts()) consider(r.due);
    return next;
  }

  private armWake(now: number) {
    if (this.stopped) return;
    if (this.wake) this.clearTimer(this.wake);
    this.wake = null;
    const next = this.nextWake(now);
    if (next === null || next - now > MAX_WAKE_MS) return;
    this.wake = this.setTimer(() => {
      this.wake = null;
      void this.evaluate('scheduled');
    }, Math.max(0, next - now) + 20);
  }

  // ---------- Manual operations ----------

  /** "Run now": ignores triggers, cooldown and limits; conditions choose actions vs else actions unless `force`. */
  runNow(rule: Rule, force = false): Promise<runs.Run> {
    return this.enqueue(async () => {
      const now = this.deps.now();
      const env = this.env(now);
      const plan = this.prepare(rule, force ? 'Run now (conditions ignored)' : 'Run now', now, now, env, true, force);
      if (!plan) return runs.lastRun(rule.id)!;
      this.cancel(rule.id, 'a newer run of this rule started');
      const run = runs.addRun({ automationId: rule.id, sceneId: null, ts: now, trigger: plan.trigger, dryRun: false, result: 'skipped', actions: [] });
      await this.runActions(rule, plan.actions, run.id, [], new Map());
      this.armWake(now);
      return runs.getRun(run.id)!;
    });
  }

  /** Applies a scene by hand (allowed while suspended; needs a connection). */
  applyScene(scene: Scene): Promise<runs.Run> {
    return this.enqueue(async () => {
      const now = this.deps.now();
      const out: runs.RunAction[] = [];
      for (const s of scene.settings) {
        for (const index of this.indexes(s.inverter)) out.push(await this.write(null, { index, setting: s.setting, value: s.value }, new Map(), 0, true));
      }
      const run = runs.addRun({ automationId: null, sceneId: scene.id, ts: now, trigger: `Scene "${scene.name}" applied`, dryRun: false, result: runs.resultOf(out), actions: out });
      this.deps.log.info(`Scene "${scene.name}" applied: ${run.result}.`);
      return run;
    });
  }

  /** What running the rule now would do. No writes, no persisted state. */
  dryRun(rule: Rule, force = false) {
    const now = this.deps.now();
    const env = this.env(now);
    const conditions = evalGroup(rule.config.conditions, env);
    const branch = force || conditions.match ? 'actions' : rule.config.elseActions.length ? 'elseActions' : 'none';
    const list = branch === 'actions' ? rule.config.actions : branch === 'elseActions' ? rule.config.elseActions : [];
    const defs = this.deps.defs();
    const blocked = this.blockedReason();
    const would: { kind: string; text: string; inverter?: number; setting?: string; value?: Value; current?: Value; outcome: string }[] = [];
    let delayed = 0;
    for (const a of list) {
      const text = cap(describeAction(a, defs, (id) => this.deps.scene(id)?.name ?? null));
      if (a.kind === 'delay') {
        delayed += a.minutes;
        would.push({ kind: a.kind, text, outcome: `Later actions run ${delayed} min after the start` });
        continue;
      }
      if (a.kind === 'set_setting' || a.kind === 'scene') {
        const ws = this.writesOf(a);
        if (!ws.length) would.push({ kind: a.kind, text, outcome: 'Scene not found' });
        for (const w of ws) {
          const current = this.deps.values(w.index)[w.setting] ?? null;
          const wait = this.deps.limiter.wait(`${w.index}:${w.setting}`, w.value, now);
          const outcome = blocked ?? (sameValue(current, w.value) ? 'Already set' : delayed ? `Would write after ${delayed} min` : wait > 0 ? `Held by write protection (${Math.ceil(wait / 1000)} s)` : 'Would write');
          would.push({ kind: 'set_setting', text: this.writeText(w), inverter: w.index, setting: w.setting, value: w.value, current, outcome });
        }
        continue;
      }
      if (a.kind === 'notify') {
        would.push({ kind: a.kind, text, outcome: `Would send "${this.renderTemplate(a.title, rule, now)}: ${this.renderTemplate(a.message, rule, now)}"` });
        continue;
      }
      if (a.kind === 'device') {
        const suspended = this.deps.suspended() ? 'Skipped: automations are suspended' : null;
        const list2 = this.deps.devicePreview?.(rule, a) ?? [{ text, outcome: 'Smart devices are not available' }];
        for (const p of list2) would.push({ kind: a.kind, text: p.text, outcome: suspended ?? (delayed ? `${p.outcome} (after ${delayed} min)` : p.outcome) });
        continue;
      }
      would.push({ kind: a.kind, text, outcome: a.kind === 'mqtt' ? `Would publish ${a.topic}` : 'Would run' });
    }
    // Arbitration against other enabled rules writing the same settings.
    const mine = new Set(list.flatMap((a) => this.writesOf(a)).map((w) => `${w.index}:${w.setting}`));
    const arbitration: { inverter: number; setting: string; competitors: { id: number; name: string; priority: number }[]; wins: boolean }[] = [];
    for (const k of mine) {
      const [idx, setting] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
      const competitors = this.deps
        .rules()
        .filter((r) => r.enabled && r.id !== rule.id)
        .filter((r) => [...r.config.actions, ...r.config.elseActions].flatMap((a) => this.writesOf(a)).some((w) => w.index === idx && w.setting === setting))
        .map((r) => ({ id: r.id, name: r.name, priority: r.config.priority }));
      if (!competitors.length) continue;
      // The run being simulated is the most recent trigger, so it wins ties.
      arbitration.push({ inverter: idx, setting, competitors, wins: competitors.every((c) => rule.config.priority >= c.priority) });
    }
    const actions: runs.RunAction[] = would.map((w) => ({ text: w.text, ok: true, message: w.outcome }));
    if (!list.length) actions.push({ text: 'Conditions not met', ok: true, skipped: true, message: failedConditions(conditions) });
    return {
      id: 0,
      automationId: rule.id,
      sceneId: null,
      ts: now,
      trigger: 'Dry run',
      dryRun: true,
      result: (list.length ? 'ok' : 'skipped') as runs.RunResult,
      actions,
      conditions,
      branch,
      wouldRun: would,
      arbitration,
      blocked,
      limits: this.limitReason(rule, now),
      active: this.activeNow(rule, now),
    };
  }
}

const firstDelay = (actions: Action[]) => {
  const i = actions.findIndex((a) => a.kind === 'delay');
  return i < 0 ? actions.length : i;
};

/** Texts of the conditions that failed. */
export function failedConditions(d: CondDetail): string {
  const out: string[] = [];
  const walk = (x: CondDetail) => {
    if (x.items) x.items.forEach(walk);
    else if (!x.match) out.push(x.text);
  };
  walk(d);
  return out.join('; ') || 'Conditions not met';
}
