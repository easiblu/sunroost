/**
 * The evaluation loop. Every tick it evaluates each enabled automation against the live inputs
 * and writes the resulting setting value when it differs from the inverter's cached value.
 *
 * Write protection (flapping / EEPROM wear): many inverters store settings in EEPROM with a
 * limited number of write cycles, and a rule on a noisy input (PV power, price) could otherwise
 * toggle a setting on every tick. So per (inverter, setting):
 * - nothing is written when the desired value already equals the cached value;
 * - the same value is not re-sent within 5 minutes (e.g. the inverter didn't take it, or a
 *   person changed it back by hand: the engine retries at most every 5 minutes);
 * - a different value may be written sooner, but never less than 60 s after the previous write.
 * Failed writes count as writes for these limits, so a broken link isn't hammered.
 */
import type { Value } from '../core/metrics.ts';
import type { SettingDef, SettingValues } from '../devices/types.ts';
import type { SetResult } from '../devices/manager.ts';
import type { Inputs } from './conditions.ts';
import {
  evaluate, findDef, fmtValue, sameValue, targetOf, TYPE_NAMES,
  type Automation, type Decision, type EngineContext, type ProtectionConfig, type SocConfig,
} from './types.ts';

export const SAME_VALUE_INTERVAL_MS = 5 * 60_000;
export const MIN_WRITE_GAP_MS = 60_000;

export class RateLimiter {
  private last = new Map<string, { value: Value; ts: number }>();
  private sameMs: number;
  private gapMs: number;
  constructor(sameMs = SAME_VALUE_INTERVAL_MS, gapMs = MIN_WRITE_GAP_MS) {
    this.sameMs = sameMs;
    this.gapMs = gapMs;
  }

  /** Milliseconds until a write of `value` to `key` is allowed (0 = now). */
  wait(key: string, value: Value, now: number): number {
    const prev = this.last.get(key);
    if (!prev) return 0;
    const limit = sameValue(prev.value, value) ? this.sameMs : this.gapMs;
    return Math.max(0, prev.ts + limit - now);
  }

  record(key: string, value: Value, now: number) {
    this.last.set(key, { value, ts: now });
  }

  clear() {
    this.last.clear();
  }
}

export interface RunnerDeps {
  now(): number;
  tz(): string;
  /** Devices started and the inverter link is up. */
  connected(): boolean;
  overrideUntil(): number;
  context(): EngineContext;
  inputs(): Omit<Inputs, 'now' | 'tz'>;
  values(index: number): SettingValues;
  setSetting(index: number, key: string, value: Value, source: string): Promise<SetResult>;
  automations(): Automation[];
  log: { info(m: string): void; warn(m: string): void };
}

export interface DisableReason {
  code: 'not_supported' | 'no_bms';
  message: string;
}

export interface Runtime {
  /** Battery protection: shutdown in effect. undefined = not yet known (inferred on first run). */
  tripped?: boolean;
  lastActionAt?: number;
  lastAction?: string;
  lastErrorAt?: number;
  lastError?: string;
  /** Write held back by the rate limiter. */
  heldUntil?: number;
}

export const automationLabel = (a: Automation) => `${TYPE_NAMES[a.type]} #${a.id}${a.name ? ` (${a.name})` : ''}`;

/** Why an automation can't run on the connected inverter, if anything. */
export function disableReason(a: Automation, ctx: EngineContext, soc: number | null): DisableReason | null {
  if (!ctx.connected) return null;
  const model = ctx.modelName || 'this inverter';
  if (a.type === 'battery-soc') {
    if (!ctx.socControl || ctx.socControl.setting !== (a.config as SocConfig).setting) {
      return { code: 'not_supported', message: `Managing the battery state of charge of ${model} is not supported.` };
    }
  }
  if (ctx.defs.length && !findDef(ctx.defs, a.config.setting)) {
    return { code: 'not_supported', message: `"${a.config.setting}" is not supported by ${model}.` };
  }
  if ((a.type === 'battery-soc' || a.type === 'battery-protection') && soc === null) {
    return {
      code: 'no_bms',
      message: 'No battery state of charge is available. Connect a battery BMS or use the emulated BMS.',
    };
  }
  return null;
}

export class Runner {
  readonly limiter = new RateLimiter();
  readonly runtime = new Map<number, Runtime>();
  private busy = false;
  private deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  rt(id: number): Runtime {
    let r = this.runtime.get(id);
    if (!r) this.runtime.set(id, (r = {}));
    return r;
  }

  /** Forget runtime state, e.g. after the automation was edited or disabled. */
  reset(id: number) {
    const r = this.runtime.get(id);
    if (r) delete r.tripped;
  }

  fullInputs(): Inputs {
    return { now: this.deps.now(), tz: this.deps.tz(), ...this.deps.inputs() };
  }

  suspended() {
    return this.deps.overrideUntil() > this.deps.now();
  }

  /** Infers protection state after a restart from the setting's current value. */
  private trippedFor(a: Automation, inputs: Inputs): boolean {
    const r = this.rt(a.id);
    if (r.tripped !== undefined) return r.tripped;
    const cfg = a.config as ProtectionConfig;
    const current = this.deps.values(0)[cfg.setting];
    return sameValue(current, cfg.shutdownValue) && inputs.soc !== null && inputs.soc < cfg.soc + cfg.hysteresis;
  }

  /** Dry run: the decision for one automation right now, without side effects. */
  decide(a: Automation, inputs = this.fullInputs()): Decision {
    return evaluate(a, inputs, a.type === 'battery-protection' ? this.trippedFor(a, inputs) : false);
  }

  /** Inverter indexes an automation writes to. */
  targets(a: Automation, ctx: EngineContext): number[] {
    const t = targetOf(a);
    if (t !== null) return t < ctx.inverterCount ? [t] : [];
    return Array.from({ length: ctx.inverterCount }, (_, i) => i);
  }

  /**
   * What applying a decision would do per inverter: 'write', 'unchanged' (already set),
   * 'none' (leave alone) or 'held' (rate limited).
   */
  plan(a: Automation, d: Decision, ctx: EngineContext, now = this.deps.now()) {
    return this.targets(a, ctx).map((index) => {
      const current = this.deps.values(index)[d.setting] ?? null;
      let action: 'write' | 'unchanged' | 'none' | 'held' = 'write';
      let wait = 0;
      if (d.value === null) action = 'none';
      else if (sameValue(current, d.value)) action = 'unchanged';
      else if ((wait = this.limiter.wait(`${index}:${d.setting}`, d.value, now)) > 0) action = 'held';
      return { index, current, desired: d.value, action, wait };
    });
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.deps.connected() || this.suspended()) return;
      const ctx = this.deps.context();
      const inputs = this.fullInputs();
      for (const a of this.deps.automations()) {
        if (!a.enabled) continue;
        if (disableReason(a, ctx, inputs.soc)) continue;
        await this.apply(a, ctx, inputs);
      }
    } finally {
      this.busy = false;
    }
  }

  private async apply(a: Automation, ctx: EngineContext, inputs: Inputs) {
    const d = this.decide(a, inputs);
    const r = this.rt(a.id);
    if (d.tripped !== undefined) r.tripped = d.tripped;
    const def = findDef(ctx.defs, d.setting);
    const label = def?.label ?? d.setting;
    delete r.heldUntil;
    for (const p of this.plan(a, d, ctx, inputs.now)) {
      if (p.action === 'held') r.heldUntil = inputs.now + p.wait;
      if (p.action !== 'write') continue;
      const where = ctx.inverterCount > 1 ? ` on inverter ${p.index + 1}` : '';
      const text = `${automationLabel(a)}: ${d.reason} → ${label} = ${fmtValue(def, d.value)}${where}`;
      this.limiter.record(`${p.index}:${d.setting}`, d.value, inputs.now);
      let res: SetResult;
      try {
        res = await this.deps.setSetting(p.index, d.setting, d.value, 'automation');
      } catch (err) {
        res = { ok: false, message: (err as Error).message };
      }
      if (res.ok) {
        this.deps.log.info(text);
        r.lastActionAt = inputs.now;
        r.lastAction = text;
      } else {
        const msg = `${automationLabel(a)}: failed to set '${label}' to '${fmtValue(def, d.value)}'${where}: ${res.message}`;
        this.deps.log.warn(msg);
        r.lastErrorAt = inputs.now;
        r.lastError = msg;
      }
    }
  }
}
