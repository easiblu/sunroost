/**
 * Spare solar: runs "deferrable" devices on the solar surplus, one at a time in the user's order.
 *
 * - Start: when the surplus covers the next device's power (its power reading if it has one, else
 *   the "power when on" the user set) plus a margin, for `start_minutes`, that device is switched on.
 *   Its consumption then lowers the surplus, so the next one waits for more.
 * - Stop: when the house imports from the grid or drains the battery for `stop_minutes`, the last
 *   device Sunroost started (that has run at least `min_on_minutes`) is switched off, in reverse order.
 * - Only devices Sunroost started are stopped; one you switched on yourself is left alone. Devices held
 *   by the 2-minute anti-chatter guard, unavailable ones and a suspension are respected.
 *
 * Every switch is recorded in the automation history (trigger "Spare solar …"). See docs/AUTOMATIONS.md.
 */
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';
import { state } from '../core/state.ts';
import { currentSurplus } from '../energy/index.ts';
import * as home from '../home/index.ts';
import { servicesFor, UNAVAILABLE, type EntityEntry } from '../home/types.ts';
import { ANTI_CHATTER_MS, markSwitched, switchedAgo } from './devices.ts';
import * as runs from './runs.ts';

const log = logger('automation');
/**
 * Dead-man switch: devices that can time themselves out get an off-timer of DEADMAN_S, renewed every
 * DEADMAN_RENEW_MS while spare solar keeps them running. If Sunroost stops, they switch off on their own.
 */
const DEADMAN_S = 20 * 60;
const DEADMAN_RENEW_MS = 10 * 60_000;
const renewed = new Map<string, number>();
/** Grid import or battery discharge above this counts as a shortfall. */
const SHORTFALL_W = 100;

export interface SurplusDevice {
  entityId: string;
  name: string;
  state: string;
  /** What Sunroost assumes it draws: its power reading while on, else the user's figure. */
  powerW: number | null;
  powerSource: 'measured' | 'set' | null;
  /** The user's "power when on" figure. */
  setW: number | null;
  /** Started by Sunroost (and so stopped by Sunroost). */
  managed: boolean;
  status: 'running' | 'next' | 'waiting' | 'unavailable' | 'held' | 'manual';
  note: string | null;
}

export interface SurplusStatus {
  enabled: boolean;
  surplusW: number | null;
  shortfall: boolean;
  devices: SurplusDevice[];
  /** Seconds until the next device starts / the last one stops, when a timer is running. */
  startInS: number | null;
  stopInS: number | null;
  settings: { batterySoc: number; startMarginW: number; startMinutes: number; stopMinutes: number; minOnMinutes: number };
}

let startSince: { entityId: string; at: number } | null = null;
let stopSince: number | null = null;
let busy = false;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cfg = () => ({
  enabled: settings.get('surplus.enabled') === true,
  batterySoc: Number(settings.get('surplus.battery_soc')) || 90,
  startMarginW: Number(settings.get('surplus.start_margin_w')) || 0,
  startMinutes: Number(settings.get('surplus.start_minutes')) || 0,
  stopMinutes: Number(settings.get('surplus.stop_minutes')) || 0,
  minOnMinutes: Number(settings.get('surplus.min_on_minutes')) || 0,
});

/** Devices Sunroost started: entity id → start time. Persisted, so a restart doesn't orphan them. */
function managed(): Record<string, number> {
  const m = settings.get('surplus.managed');
  return m && typeof m === 'object' ? { ...(m as Record<string, number>) } : {};
}
const saveManaged = (m: Record<string, number>) => settings.set('surplus.managed', m);

/** Deferrable devices that can be switched on and off, in the user's order (then by name). */
export function candidates(): EntityEntry[] {
  const order = settings.get('surplus.order') as string[];
  const list = home.registry
    .allEntities()
    .filter((e) => e.role === 'deferrable' && !e.hidden && servicesFor(e).includes('turn_on') && servicesFor(e).includes('turn_off'));
  const rank = (e: EntityEntry) => (order.includes(e.entityId) ? order.indexOf(e.entityId) : order.length);
  return list.sort((a, b) => rank(a) - rank(b) || home.registry.entityName(a).localeCompare(home.registry.entityName(b)));
}

/** The device's own power reading (a W sensor on the same device), when it has one. */
function measuredW(e: EntityEntry): number | null {
  if (!e.deviceId) return null;
  const sensor = home.registry.allEntities().find((x) => x.deviceId === e.deviceId && x.domain === 'sensor' && x.unit === 'W');
  const v = sensor ? Number(home.states.get(sensor.entityId)?.state) : NaN;
  return Number.isFinite(v) ? v : null;
}

const isOn = (st: string | undefined) => !!st && st !== 'off' && st !== UNAVAILABLE && st !== 'unknown';

function describe(now: number): SurplusStatus {
  const c = cfg();
  const surplus = currentSurplus();
  const t = state.totals;
  const shortfall = (num(t['Grid power']) ?? 0) > SHORTFALL_W || (num(t['Battery power']) ?? 0) < -SHORTFALL_W;
  const m = managed();
  let nextFound = false;
  const devices = candidates().map((e): SurplusDevice => {
    const st = home.states.get(e.entityId)?.state ?? UNAVAILABLE;
    const measured = isOn(st) ? measuredW(e) : null;
    const powerW = measured !== null && measured > 0 ? Math.round(measured) : e.powerW;
    const base = {
      entityId: e.entityId, name: home.registry.entityName(e), state: st, powerW,
      powerSource: measured !== null && measured > 0 ? ('measured' as const) : e.powerW ? ('set' as const) : null, setW: e.powerW,
      managed: e.entityId in m,
    };
    if (st === UNAVAILABLE) return { ...base, status: 'unavailable', note: 'Unavailable' };
    if (isOn(st)) return { ...base, status: e.entityId in m ? 'running' : 'manual', note: e.entityId in m ? null : 'Switched on by hand: Sunroost leaves it alone' };
    const ago = switchedAgo(e.entityId, now);
    if (ago !== null && ago < ANTI_CHATTER_MS) return { ...base, status: 'held', note: `Recently switched; can start again in ${Math.ceil((ANTI_CHATTER_MS - ago) / 1000)} s` };
    if (!nextFound) {
      nextFound = true;
      const need = (e.powerW ?? 0) + c.startMarginW;
      return { ...base, status: 'next', note: `Starts when the surplus stays above ${need} W for ${c.startMinutes} min${e.powerW ? '' : ' (set its power for better timing)'}` };
    }
    return { ...base, status: 'waiting', note: null };
  });
  const startInS = startSince ? Math.max(0, Math.ceil((startSince.at + c.startMinutes * 60_000 - now) / 1000)) : null;
  const stopInS = stopSince !== null ? Math.max(0, Math.ceil((stopSince + c.stopMinutes * 60_000 - now) / 1000)) : null;
  return {
    enabled: c.enabled, surplusW: surplus, shortfall, devices, startInS, stopInS,
    settings: { batterySoc: c.batterySoc, startMarginW: c.startMarginW, startMinutes: c.startMinutes, stopMinutes: c.stopMinutes, minOnMinutes: c.minOnMinutes },
  };
}

export const status = (now = Date.now()) => describe(now);

const timesItself = (entityId: string) => home.states.get(entityId)?.attributes.supports_auto_off === true;

async function switchDevice(e: SurplusDevice, service: 'turn_on' | 'turn_off', why: string, now: number) {
  const entry = home.registry.entity(e.entityId);
  if (!entry) return false;
  const data = service === 'turn_on' && timesItself(e.entityId) ? { auto_off_s: DEADMAN_S } : {};
  const res = await home.callService(entry.domain, service, e.entityId, data, home.newContext('system'));
  if (res.results[e.entityId]?.ok && service === 'turn_on') renewed.set(e.entityId, now);
  const r = res.results[e.entityId];
  if (r.ok) markSwitched(e.entityId, now);
  const text = `${service === 'turn_on' ? 'Turn on' : 'Turn off'} ${e.name}`;
  runs.addRun({
    automationId: null, sceneId: null, ts: now, trigger: `Spare solar: ${why}`, dryRun: false,
    result: r.ok ? 'ok' : 'failed', actions: [{ text, ok: r.ok, message: r.ok ? (r.confirmed === false ? 'Sent; not confirmed yet' : 'Done') : r.message ?? 'Failed' }],
  });
  log.info(`Spare solar: ${text} (${why})${r.ok ? '' : `: ${r.message}`}.`);
  return r.ok;
}

/** One control step. `suspended` stops it from switching anything. */
export async function evaluate(suspended: boolean, now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const c = cfg();
    // Forget devices that are off (switched off by hand, or by Sunroost).
    const m = managed();
    let changed = false;
    for (const id of Object.keys(m)) {
      if (!isOn(home.states.get(id)?.state)) {
        delete m[id];
        changed = true;
      }
    }
    if (changed) saveManaged(m);
    if (!c.enabled || suspended) {
      startSince = null;
      stopSince = null;
      return;
    }
    const s = describe(now);
    // Renew the dead-man off-timer of running devices that time themselves (no state change, no history entry).
    for (const d of s.devices) {
      if (d.status !== 'running' || !timesItself(d.entityId)) continue;
      if (now - (renewed.get(d.entityId) ?? m[d.entityId] ?? 0) < DEADMAN_RENEW_MS) continue;
      const entry = home.registry.entity(d.entityId);
      if (!entry) continue;
      const r = await home.callService(entry.domain, 'turn_on', d.entityId, { auto_off_s: DEADMAN_S }, home.newContext('system'), { confirmMs: 0 });
      if (r.ok) renewed.set(d.entityId, now);
    }
    if (s.surplusW === null) return;

    // Shortfall: stop the most recently started device (reverse order) once it has run long enough.
    if (s.shortfall) {
      startSince = null;
      stopSince ??= now;
      if (now - stopSince < c.stopMinutes * 60_000) return;
      const victim = [...s.devices].reverse().find((d) => d.status === 'running' && now - (m[d.entityId] ?? 0) >= c.minOnMinutes * 60_000);
      if (victim && (await switchDevice(victim, 'turn_off', 'importing or using the battery', now))) {
        delete m[victim.entityId];
        saveManaged(m);
      }
      stopSince = now; // wait again before stopping another
      return;
    }
    stopSince = null;

    // Surplus: start the next device once it has been enough for long enough.
    const next = s.devices.find((d) => d.status === 'next');
    if (!next) {
      startSince = null;
      return;
    }
    const need = (home.registry.entity(next.entityId)?.powerW ?? 0) + c.startMarginW;
    if (s.surplusW < need) {
      startSince = null;
      return;
    }
    if (!startSince || startSince.entityId !== next.entityId) startSince = { entityId: next.entityId, at: now };
    if (now - startSince.at < c.startMinutes * 60_000) return;
    startSince = null;
    if (await switchDevice(next, 'turn_on', `${(s.surplusW / 1000).toFixed(2)} kW spare`, now)) {
      m[next.entityId] = now;
      saveManaged(m);
    }
  } finally {
    busy = false;
  }
}

/** For tests. */
export function reset() {
  renewed.clear();
  startSince = null;
  stopSince = null;
  busy = false;
}
