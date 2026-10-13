/**
 * The state machine: the latest state of every entity, with Home Assistant's semantics. Writing an
 * identical state and attributes is a no-op; a change to attributes alone keeps `lastChanged`.
 */
import { isDeepStrictEqual } from 'node:util';
import { emit, newContext } from './bus.ts';
import type { Context, EntityState } from './types.ts';

const states = new Map<string, EntityState>();

export function get(entityId: string): EntityState | null {
  return states.get(entityId) ?? null;
}

export function all(): EntityState[] {
  return [...states.values()];
}

/** Sets an entity's state; returns false when nothing changed (and no event fired). */
export function set(entityId: string, state: string, attributes: Record<string, unknown> = {}, context?: Context, now = Date.now()): boolean {
  const old = states.get(entityId) ?? null;
  const sameState = old?.state === state;
  if (old && sameState && isDeepStrictEqual(old.attributes, attributes)) return false;
  const ctx = context ?? newContext('device');
  const next: EntityState = {
    entityId,
    state,
    attributes,
    lastChanged: old && sameState ? old.lastChanged : now,
    lastUpdated: now,
    context: ctx,
  };
  states.set(entityId, next);
  emit('state_changed', { entityId, oldState: old, newState: next, context: ctx });
  return true;
}

export function remove(entityId: string, context?: Context) {
  const old = states.get(entityId);
  if (!old) return;
  states.delete(entityId);
  const ctx = context ?? newContext('system');
  emit('state_changed', { entityId, oldState: old, newState: null, context: ctx });
}

/** For tests. */
export function reset() {
  states.clear();
}
