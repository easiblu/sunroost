/**
 * The smart-home event bus, like Home Assistant's: every state change and every service call is an
 * event, and automations, the WebSocket push and history are just listeners.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../core/log.ts';
import type { Context, ContextOrigin, EntityState, ServiceResult } from './types.ts';

const log = logger('home');

export interface StateChangedEvent {
  entityId: string;
  /** null when the entity is new. */
  oldState: EntityState | null;
  /** null when the entity was removed. */
  newState: EntityState | null;
  context: Context;
}

export interface CallServiceEvent {
  domain: string;
  service: string;
  entityIds: string[];
  data: Record<string, unknown>;
  context: Context;
  results: Record<string, ServiceResult & { confirmed: boolean | null }>;
}

interface BusEvents {
  state_changed: [StateChangedEvent];
  call_service: [CallServiceEvent];
}

export const bus = new EventEmitter<BusEvents>();
bus.setMaxListeners(50);

/**
 * Emits to every listener even if one throws: a faulty listener (a group, the UI push …) must not
 * stop a device's state from reaching automations and the rest.
 */
export function emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]) {
  for (const fn of bus.listeners(event) as ((...a: BusEvents[K]) => void)[]) {
    try {
      fn(...args);
    } catch (err) {
      log.error(`${event} listener failed: ${(err as Error).message}`);
    }
  }
}

export function newContext(origin: ContextOrigin, parent?: Context | null, ruleId?: number): Context {
  return { id: randomUUID(), parentId: parent?.id ?? null, origin, ...(ruleId !== undefined ? { ruleId } : {}) };
}
