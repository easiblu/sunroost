/**
 * Device actions for rules: resolves targets (a device, every device with an energy role, or a room)
 * and applies the energy guard rails before anything is sent:
 *
 * - protected devices (transfer switch, chargers) are skipped unless the action allows them, and any
 *   interlock on the device (load, grid, battery) must hold — checked again by the core for every command;
 * - critical devices are never switched off by an automation;
 * - a device switched by an automation isn't switched again by one within ANTI_CHATTER_MS, nor more
 *   than `automation.device_max_switches_per_hour` times an hour (protects compressors and relays);
 * - a device already in the wanted state isn't sent the command again;
 * - when two rules command the same device in one evaluation, the higher priority wins (engine arbitration).
 *
 * Timers, persisted so they survive a restart (`automation_device_timers`):
 * - auto-off: a turn_on with `autoOffMinutes` switches off again after that long. Devices that can time
 *   themselves (`supports_auto_off`) get it as `auto_off_s`, so they switch off even if Sunroost is down;
 *   for the rest Sunroost does it.
 * - revert: with the rule's `revertAfterMinutes`, the previous state is restored after that long, if
 *   the device still has the state the rule set.
 *
 * Commands go through the smart-home core's callService, with the rule as the context's origin.
 */
import { db } from '../core/db.ts';
import { settings } from '../core/settings.ts';
import * as home from '../home/index.ts';
import { expectedState, interlockReason } from '../home/services.ts';
import { servicesFor, UNAVAILABLE, type EntityEntry } from '../home/types.ts';
import { describeDeviceAction, type DeviceAction, type Rule } from './rules.ts';
import * as runs from './runs.ts';
import type { RunAction } from './runs.ts';

export const ANTI_CHATTER_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
/** Commands that switch something off (refused for critical devices). */
const OFF_SERVICES = new Set(['turn_off', 'close_valve', 'close_cover', 'stop']);

/** Entity id → times an automation changed it in the last hour (newest last). */
const switches = new Map<string, number[]>();

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function initTimers() {
  db().exec(`CREATE TABLE IF NOT EXISTS automation_device_timers (
    entity_id TEXT NOT NULL, kind TEXT NOT NULL, rule_id INTEGER, due INTEGER NOT NULL,
    service TEXT NOT NULL, data TEXT NOT NULL, written TEXT, minutes INTEGER NOT NULL,
    PRIMARY KEY (entity_id, kind)
  )`);
}

/** Area of an entity: its own, else its device's. */
function areaOf(e: EntityEntry): string | null {
  return e.areaId ?? (e.deviceId ? home.registry.device(e.deviceId)?.areaId ?? null : null);
}

/** Display name of a device action target. */
export function targetName(target: string): string {
  if (target.startsWith('role:')) return `every ${target.slice(5)} device`;
  if (target.startsWith('area:')) return `everything in ${home.areas.get(target.slice(5))?.name ?? target.slice(5)}`;
  const e = home.registry.entity(target);
  return e ? home.registry.entityName(e) : target;
}

/** Whether a target names something that exists. */
export function targetExists(target: string): boolean {
  if (target.startsWith('role:')) return ['critical', 'essential', 'deferrable', 'sheddable', 'protected'].includes(target.slice(5));
  if (target.startsWith('area:')) return home.areas.get(target.slice(5)) !== null;
  return home.registry.entity(target) !== null;
}

/** The entities a target means right now. Role and room targets take visible, controllable devices that support the command. */
function resolve(a: DeviceAction): EntityEntry[] {
  if (!a.target.startsWith('role:') && !a.target.startsWith('area:')) {
    const e = home.registry.entity(a.target);
    return e ? [e] : [];
  }
  const generic = ['turn_on', 'turn_off', 'toggle'].includes(a.service);
  return home.registry.allEntities().filter((e) => {
    if (e.hidden || e.engine === 'energy') return false;
    const services = servicesFor(e);
    if (!services.length || !(services.includes(a.service) || (generic && services.includes('turn_on')))) return false;
    return a.target.startsWith('role:') ? e.role === a.target.slice(5) : areaOf(e) === a.target.slice(5);
  });
}

/** Entity ids an action would command (for arbitration between rules). */
export const targetsOf = (a: DeviceAction) => resolve(a).map((e) => e.entityId);

function recentSwitches(entityId: string, now: number) {
  const list = (switches.get(entityId) ?? []).filter((t) => now - t < HOUR_MS);
  switches.set(entityId, list);
  return list;
}

interface Step {
  entity: EntityEntry;
  text: string;
  /** Why it isn't sent; null = send. */
  skip: string | null;
}

function plan(a: DeviceAction, now: number, overridden?: Map<string, number>): Step[] {
  const maxPerHour = Number(settings.get('automation.device_max_switches_per_hour')) || 0;
  return resolve(a).map((entity) => {
    const text = cap(describeDeviceAction(a, home.registry.entityName(entity)));
    const st = home.states.get(entity.entityId)?.state;
    const winner = overridden?.get(`device:${entity.entityId}`);
    let skip: string | null = null;
    if (winner !== undefined) skip = `Overridden by rule #${winner} (higher priority)`;
    else if (entity.role === 'protected' && !a.allowProtected) skip = 'Protected device: this action is not allowed to switch it';
    else if (entity.role === 'critical' && (OFF_SERVICES.has(a.service) || (a.service === 'toggle' && st === 'on') || (a.service === 'set_hvac_mode' && a.data.hvac_mode === 'off'))) {
      skip = 'Critical device: automations never switch it off';
    } else if (!st || st === UNAVAILABLE) skip = 'Device is unavailable';
    else {
      const want = expectedState(entity.domain, a.service, a.data, st);
      const il = interlockReason(entity.interlock);
      const recent = recentSwitches(entity.entityId, now);
      const last = recent.at(-1);
      if (want !== null && want === st) skip = `Already ${want.replace(/_/g, ' ')}`;
      else if (il) skip = `Interlock: ${il}`;
      else if (last !== undefined && now - last < ANTI_CHATTER_MS) {
        skip = `Held: an automation switched it ${Math.round((now - last) / 1000)} s ago (minimum ${ANTI_CHATTER_MS / 60_000} min)`;
      } else if (maxPerHour > 0 && recent.length >= maxPerHour) {
        skip = `Held: switched ${recent.length} times in the last hour (limit ${maxPerHour})`;
      }
    }
    return { entity, text, skip };
  });
}

/** What the action would do now (dry run). */
export function preview(_rule: Rule | null, a: DeviceAction, now = Date.now()): { text: string; outcome: string }[] {
  const steps = plan(a, now);
  if (!steps.length) return [{ text: cap(describeDeviceAction(a, targetName(a.target))), outcome: 'No device matches right now' }];
  return steps.map((s) => ({
    text: s.text,
    outcome: s.skip ?? (a.autoOffMinutes && a.service === 'turn_on'
      ? `Would send; off again after ${a.autoOffMinutes} min${s.entity && home.states.get(s.entity.entityId)?.attributes.supports_auto_off ? ' (timed by the device)' : ''}`
      : 'Would send'),
  }));
}

/** The command that puts a device back to `state`, or null when it can't be restored. */
function restoreCommand(e: EntityEntry, state: string, attributes: Record<string, unknown>): { service: string; data: Record<string, unknown> } | null {
  const services = servicesFor(e);
  const can = (s: string) => services.includes(s);
  if (['switch', 'light', 'fan', 'group', 'media_player'].includes(e.domain) && (state === 'on' || state === 'off')) {
    const svc = state === 'on' ? 'turn_on' : 'turn_off';
    const data = e.domain === 'light' && state === 'on' && typeof attributes.brightness === 'number' ? { brightness: attributes.brightness } : {};
    return can(svc) ? { service: svc, data } : null;
  }
  if (e.domain === 'climate' && can('set_hvac_mode')) return { service: 'set_hvac_mode', data: { hvac_mode: state } };
  if (e.domain === 'number' && can('set_value') && Number.isFinite(Number(state))) return { service: 'set_value', data: { value: Number(state) } };
  if (e.domain === 'select' && can('select_option')) return { service: 'select_option', data: { option: state } };
  if (e.domain === 'lock' && (state === 'locked' || state === 'unlocked')) return { service: state === 'locked' ? 'lock' : 'unlock', data: {} };
  return null;
}

function setTimer(entityId: string, kind: 'revert' | 'auto_off', ruleId: number | null, due: number, cmd: { service: string; data: Record<string, unknown> }, written: string | null, minutes: number) {
  db().prepare(`INSERT OR REPLACE INTO automation_device_timers (entity_id, kind, rule_id, due, service, data, written, minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entityId, kind, ruleId, due, cmd.service, JSON.stringify(cmd.data), written, minutes);
}

function getTimer(entityId: string, kind: string) {
  return db().prepare(`SELECT * FROM automation_device_timers WHERE entity_id = ? AND kind = ?`).get(entityId, kind) as
    | { entity_id: string; kind: string; rule_id: number | null; due: number; service: string; data: string; written: string | null; minutes: number }
    | undefined;
}

const clearTimer = (entityId: string, kind: string) => db().prepare(`DELETE FROM automation_device_timers WHERE entity_id = ? AND kind = ?`).run(entityId, kind);

/** Runs the action: one result per device. `overridden` holds devices a higher-priority rule won this evaluation. */
export async function run(rule: Rule | null, a: DeviceAction, now = Date.now(), overridden?: Map<string, number>): Promise<RunAction[]> {
  const steps = plan(a, now, overridden);
  if (!steps.length) return [{ text: cap(describeDeviceAction(a, targetName(a.target))), ok: true, skipped: true, message: 'No device matches right now' }];
  const context = home.newContext('rule', null, rule?.id);
  const revertMinutes = rule?.config.options.revertAfterMinutes ?? 0;
  return Promise.all(
    steps.map(async (s): Promise<RunAction> => {
      if (s.skip) return { text: s.text, ok: true, skipped: true, message: s.skip };
      const before = home.states.get(s.entity.entityId);
      const data = { ...a.data };
      const autoOff = a.service === 'turn_on' && a.autoOffMinutes ? a.autoOffMinutes : 0;
      const deviceTimed = autoOff > 0 && before?.attributes.supports_auto_off === true;
      if (deviceTimed) data.auto_off_s = autoOff * 60;
      const res = await home.callService(s.entity.domain, a.service, s.entity.entityId, data, context);
      const r = res.results[s.entity.entityId];
      if (!r.ok) return { text: s.text, ok: false, message: r.message ?? 'Failed' };
      markSwitched(s.entity.entityId, now);
      const notes: string[] = [];
      // Auto-off: the device times itself when it can; Sunroost keeps a timer either way (belt and braces).
      if (autoOff > 0) {
        setTimer(s.entity.entityId, 'auto_off', rule?.id ?? null, now + autoOff * 60_000, { service: 'turn_off', data: {} }, 'on', autoOff);
        notes.push(`off again after ${autoOff} min${deviceTimed ? ' (timed by the device too)' : ''}`);
      }
      // Revert: keep the state from before the first change; a later revert-rule write extends it.
      if (revertMinutes > 0 && before) {
        const existing = getTimer(s.entity.entityId, 'revert');
        const cmd = existing ? { service: existing.service, data: JSON.parse(existing.data) } : restoreCommand(s.entity, before.state, before.attributes);
        const written = expectedState(s.entity.domain, a.service, a.data, before.state);
        if (cmd) {
          setTimer(s.entity.entityId, 'revert', rule?.id ?? null, now + revertMinutes * 60_000, cmd, written, revertMinutes);
          notes.push(`restored after ${revertMinutes} min`);
        }
      } else if (getTimer(s.entity.entityId, 'revert')) {
        clearTimer(s.entity.entityId, 'revert'); // a rule without revert takes over the device
      }
      const base = r.confirmed === false ? 'Sent; the device has not confirmed it yet' : r.message ?? 'Done';
      return { text: s.text, ok: true, message: notes.length ? `${base}; ${notes.join(', ')}` : base };
    }),
  );
}

/**
 * Due auto-off and revert timers (called on every evaluation). A timer only acts when the device
 * still has the state the automation left it in; otherwise someone changed it since and it is left alone.
 * Waits while automations are suspended.
 */
export async function processTimers(now = Date.now(), suspended = false): Promise<void> {
  if (suspended) return;
  const due = db().prepare(`SELECT * FROM automation_device_timers WHERE due <= ? ORDER BY due`).all(now) as {
    entity_id: string; kind: string; rule_id: number | null; service: string; data: string; written: string | null; minutes: number;
  }[];
  for (const t of due) {
    clearTimer(t.entity_id, t.kind);
    const e = home.registry.entity(t.entity_id);
    const st = home.states.get(t.entity_id)?.state;
    const label = t.kind === 'revert' ? `Revert after ${t.minutes} min` : `Auto-off after ${t.minutes} min`;
    if (!e) continue;
    const text = cap(describeDeviceAction({ kind: 'device', target: t.entity_id, service: t.service, data: JSON.parse(t.data) }, home.registry.entityName(e)));
    let action: RunAction;
    if (t.written !== null && st !== t.written) {
      action = { text, ok: true, skipped: true, message: `Not restored: it was changed since (now ${st ?? 'unknown'})` };
    } else {
      const res = await home.callService(e.domain, t.service, t.entity_id, JSON.parse(t.data), home.newContext('rule', null, t.rule_id ?? undefined));
      const r = res.results[t.entity_id];
      if (r.ok) markSwitched(t.entity_id, now);
      action = { text, ok: r.ok, message: r.ok ? 'Done' : r.message ?? 'Failed' };
    }
    runs.addRun({ automationId: t.rule_id, sceneId: null, ts: now, trigger: label, dryRun: false, result: runs.resultOf([action]), actions: [action] });
  }
}

/** How long ago an automation (or spare solar) last switched a device; null when never. */
export function switchedAgo(entityId: string, now = Date.now()): number | null {
  const t = switches.get(entityId)?.at(-1);
  return t === undefined ? null : now - t;
}

export function markSwitched(entityId: string, now = Date.now()) {
  switches.set(entityId, [...recentSwitches(entityId, now), now]);
}

/** For tests. */
export function resetGuards() {
  switches.clear();
}
