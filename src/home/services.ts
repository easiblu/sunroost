/**
 * The single command path, like Home Assistant's service registry. The UI, automations and MQTT all
 * call `callService`, so validation (and, later, the energy guard rails) live in one place.
 *
 * After the engine accepts a command, the call waits briefly for the entity's state to confirm it
 * ("on" after turn_on). Push devices confirm in well under a second; polled ones on their next poll.
 */
import { logger } from '../core/log.ts';
import { bus, emit, newContext, type StateChangedEvent } from './bus.ts';
import * as registry from './registry.ts';
import * as states from './states.ts';
import { servicesFor, UNAVAILABLE, type Context, type DeviceEngine, type EngineId, type Interlock, type ServiceResult } from './types.ts';

const log = logger('home');
const ENGINE_TIMEOUT_MS = 10_000;
export const CONFIRM_TIMEOUT_MS = 5_000;

/** Services that work on any on/off domain, like Home Assistant's `homeassistant.turn_on`. */
const GENERIC_DOMAIN = 'homeassistant';
const GENERIC_SERVICES = ['turn_on', 'turn_off', 'toggle'];

export interface EntityResult extends ServiceResult {
  /** True when the state reflected the command in time; null when there's nothing to confirm. */
  confirmed: boolean | null;
}

export interface ServiceCallResult {
  ok: boolean;
  context: Context;
  results: Record<string, EntityResult>;
}

let engineLookup: (id: EngineId) => DeviceEngine | null = () => null;

/** Set by home/index.ts once the engines are running. */
export function setEngineLookup(fn: (id: EngineId) => DeviceEngine | null) {
  engineLookup = fn;
}

const ON_OFF_DOMAINS = ['switch', 'light', 'fan', 'group'];

/** Why an interlock refuses a command now, or null. Uses the energy entities (sensor.load_power …). */
export function interlockReason(il: Interlock | null | undefined): string | null {
  if (!il) return null;
  const num = (id: string) => {
    const v = Number(states.get(id)?.state);
    return Number.isFinite(v) ? v : null;
  };
  if (il.maxLoadW !== undefined) {
    const load = num('sensor.load_power');
    if (load === null) return 'the house load is unknown';
    if (load > il.maxLoadW) return `the house load is ${Math.round(load)} W (limit ${il.maxLoadW} W)`;
  }
  if (il.gridAvailable !== undefined) {
    const g = states.get('binary_sensor.grid_available')?.state;
    if (g !== 'on' && g !== 'off') return 'grid availability is unknown';
    if ((g === 'on') !== il.gridAvailable) return il.gridAvailable ? 'the grid is down' : 'the grid is available';
  }
  if (il.minBatterySoc !== undefined) {
    const soc = num('sensor.battery_state_of_charge');
    if (soc === null) return 'the battery level is unknown';
    if (soc < il.minBatterySoc) return `the battery is at ${Math.round(soc)}% (minimum ${il.minBatterySoc}%)`;
  }
  return null;
}

/** The state a successful command should lead to, when it's predictable. */
export function expectedState(domain: string, service: string, data: Record<string, unknown>, current: string | undefined): string | null {
  if (ON_OFF_DOMAINS.includes(domain)) {
    if (service === 'turn_on') return 'on';
    if (service === 'turn_off') return 'off';
    if (service === 'toggle') return current === 'on' ? 'off' : current === 'off' ? 'on' : null;
  }
  if (domain === 'climate' || domain === 'media_player') {
    if (service === 'turn_off') return 'off';
    if (service === 'set_hvac_mode' && typeof data.hvac_mode === 'string') return data.hvac_mode;
  }
  if (domain === 'lock' && (service === 'lock' || service === 'unlock')) return `${service}ed`;
  if (domain === 'select' && service === 'select_option' && typeof data.option === 'string') return data.option;
  return null;
}

/** Resolves true when the entity reaches `want`, false after the timeout or `cancel()`. */
function waitForState(entityId: string, want: string, timeoutMs: number): { done: Promise<boolean>; cancel: () => void } {
  if (states.get(entityId)?.state === want) return { done: Promise.resolve(true), cancel: () => {} };
  let finish: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    const onChange = (ev: StateChangedEvent) => {
      if (ev.entityId === entityId && ev.newState?.state === want) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    finish = (ok) => {
      clearTimeout(timer);
      bus.off('state_changed', onChange);
      resolve(ok);
    };
    bus.on('state_changed', onChange);
  });
  return { done, cancel: () => finish(false) };
}

async function callOne(
  domain: string, service: string, entityId: string, data: Record<string, unknown>, context: Context, confirmMs: number,
): Promise<EntityResult> {
  const entry = registry.entity(entityId);
  if (!entry) return { ok: false, confirmed: null, message: `Unknown entity ${entityId}` };
  if (domain !== entry.domain && !(domain === GENERIC_DOMAIN && GENERIC_SERVICES.includes(service))) {
    return { ok: false, confirmed: null, message: `${entityId} is not a ${domain} entity` };
  }
  if (!servicesFor(entry).includes(service)) {
    return { ok: false, confirmed: null, message: entry.readOnly ? `${entityId} is read-only` : `${entityId} doesn't support ${service}` };
  }
  const current = states.get(entityId);
  if (!current || current.state === UNAVAILABLE) return { ok: false, confirmed: null, message: `${entityId} is unavailable` };
  const blocked = interlockReason(entry.interlock);
  if (blocked) return { ok: false, confirmed: null, message: `Interlock: ${blocked}` };
  const engine = engineLookup(entry.engine);
  if (!engine) return { ok: false, confirmed: null, message: `The ${entry.engine} device engine isn't running` };

  const want = expectedState(entry.domain, service, data, current.state);
  // Start listening before sending, so a fast push confirmation isn't missed.
  const confirmation = want ? waitForState(entityId, want, confirmMs) : null;
  let result: ServiceResult;
  try {
    result = await Promise.race([
      engine.callService({ domain: entry.domain, service, entityId, data, context }),
      new Promise<ServiceResult>((resolve) =>
        setTimeout(() => resolve({ ok: false, message: 'The device did not answer in time' }), ENGINE_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    result = { ok: false, message: (err as Error).message };
  }
  if (!result.ok) {
    confirmation?.cancel();
    return { ...result, confirmed: null };
  }
  const confirmed = confirmation ? await confirmation.done : null;
  return { ...result, confirmed, message: result.message ?? (confirmed === false ? 'Sent, but the device has not confirmed it yet' : undefined) };
}

/**
 * Calls `domain.service` on one or more entities. Entities run in parallel; a failure on one doesn't
 * stop the others. `ok` is true only when every entity accepted the command.
 */
export async function callService(
  domain: string,
  service: string,
  entityIds: string | string[],
  data: Record<string, unknown> = {},
  context: Context = newContext('user'),
  opts: { confirmMs?: number } = {},
): Promise<ServiceCallResult> {
  const ids = [...new Set(Array.isArray(entityIds) ? entityIds : [entityIds])];
  const confirmMs = opts.confirmMs ?? CONFIRM_TIMEOUT_MS;
  const list = await Promise.all(ids.map((id) => callOne(domain, service, id, data, context, confirmMs)));
  const results = Object.fromEntries(ids.map((id, i) => [id, list[i]]));
  for (const [id, r] of Object.entries(results)) {
    if (!r.ok) log.warn(`${domain}.${service} on ${id} failed: ${r.message}`);
  }
  emit('call_service', { domain, service, entityIds: ids, data, context, results });
  return { ok: list.every((r) => r.ok), context, results };
}
