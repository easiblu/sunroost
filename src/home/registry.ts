/**
 * Device and entity registries, persisted in SQLite. An engine identifies things by its own unique
 * id; the registry maps that to a stable entity id that never changes once given out, and keeps the
 * user's overrides (name, icon, area, energy role, hidden) when the engine re-registers.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../core/db.ts';
import {
  domainOf, objectIdFrom, type DeviceEntry, type DeviceInput, type EnergyRole, type EngineId, type EntityEntry, type EntityInput,
} from './types.ts';

const devices = new Map<string, DeviceEntry>();
const entities = new Map<string, EntityEntry>();
/** `${engine}\0${uniqueId}` → id, for both maps. */
const deviceByUnique = new Map<string, string>();
const entityByUnique = new Map<string, string>();

const key = (engine: string, uniqueId: string) => `${engine}\0${uniqueId}`;

export function init() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS home_devices (
      id TEXT PRIMARY KEY, engine TEXT NOT NULL, unique_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE (engine, unique_id)
    );
    CREATE TABLE IF NOT EXISTS home_entities (
      entity_id TEXT PRIMARY KEY, engine TEXT NOT NULL, unique_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE (engine, unique_id)
    );
  `);
  devices.clear();
  entities.clear();
  deviceByUnique.clear();
  entityByUnique.clear();
  for (const row of db().prepare(`SELECT data FROM home_devices`).all() as { data: string }[]) {
    const d = JSON.parse(row.data) as DeviceEntry;
    // Rows from before these fields existed.
    d.reviewed ??= true;
    d.hidden ??= false;
    devices.set(d.id, d);
    deviceByUnique.set(key(d.engine, d.uniqueId), d.id);
  }
  for (const row of db().prepare(`SELECT data FROM home_entities`).all() as { data: string }[]) {
    const e = JSON.parse(row.data) as EntityEntry;
    e.powerW ??= null;
    e.interlock ??= null;
    entities.set(e.entityId, e);
    entityByUnique.set(key(e.engine, e.uniqueId), e.entityId);
  }
}

function saveDevice(d: DeviceEntry) {
  db().prepare(`INSERT OR REPLACE INTO home_devices (id, engine, unique_id, data) VALUES (?, ?, ?, ?)`)
    .run(d.id, d.engine, d.uniqueId, JSON.stringify(d));
}

function saveEntity(e: EntityEntry) {
  db().prepare(`INSERT OR REPLACE INTO home_entities (entity_id, engine, unique_id, data) VALUES (?, ?, ?, ?)`)
    .run(e.entityId, e.engine, e.uniqueId, JSON.stringify(e));
}

/** Creates or updates a device; engine-provided fields are refreshed, user fields are kept. */
export function registerDevice(engine: EngineId, input: DeviceInput, now = Date.now()): DeviceEntry {
  const existingId = deviceByUnique.get(key(engine, input.uniqueId));
  const old = existingId ? devices.get(existingId)! : null;
  const next: DeviceEntry = {
    id: old?.id ?? randomBytes(8).toString('hex'),
    engine,
    uniqueId: input.uniqueId,
    name: input.name,
    nameByUser: old?.nameByUser ?? null,
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? null,
    swVersion: input.swVersion ?? null,
    areaId: old?.areaId ?? null,
    // Sunroost's own devices never need reviewing; discovered hardware does.
    reviewed: old?.reviewed ?? input.reviewed ?? (engine === 'energy' || engine === 'group'),
    hidden: old?.hidden ?? false,
    config: input.config ?? old?.config ?? {},
    createdAt: old?.createdAt ?? now,
  };
  if (old && JSON.stringify(old) === JSON.stringify(next)) return old;
  devices.set(next.id, next);
  deviceByUnique.set(key(engine, next.uniqueId), next.id);
  saveDevice(next);
  return next;
}

/** Picks `domain.objectId`, adding _2, _3 … when another entity already has it. */
function freeEntityId(domain: string, objectId: string): string {
  const base = `${domain}.${objectIdFrom(objectId)}`;
  if (!entities.has(base)) return base;
  for (let n = 2; ; n++) if (!entities.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Creates or updates an entity. Its entity id is fixed the first time it's seen. */
export function registerEntity(engine: EngineId, input: EntityInput, now = Date.now()): EntityEntry {
  const existingId = entityByUnique.get(key(engine, input.uniqueId));
  const old = existingId ? entities.get(existingId)! : null;
  if (old && domainOf(old.entityId) !== input.domain) {
    // A domain change (a plug re-flashed as a light) is a different entity: retire the old id.
    removeEntity(old.entityId);
    return registerEntity(engine, input, now);
  }
  const next: EntityEntry = {
    entityId: old?.entityId ?? freeEntityId(input.domain, input.objectId ?? input.name),
    engine,
    uniqueId: input.uniqueId,
    deviceId: input.deviceId ?? null,
    domain: input.domain,
    originalName: input.name,
    name: old?.name ?? null,
    icon: old?.icon ?? input.icon ?? null,
    unit: input.unit ?? null,
    deviceClass: input.deviceClass ?? null,
    role: old?.role ?? null,
    powerW: old?.powerW ?? null,
    interlock: old?.interlock ?? null,
    areaId: old?.areaId ?? null,
    hidden: old?.hidden ?? input.hidden ?? false,
    services: input.services ?? null,
    readOnly: input.readOnly ?? false,
    createdAt: old?.createdAt ?? now,
  };
  if (old && JSON.stringify(old) === JSON.stringify(next)) return old;
  entities.set(next.entityId, next);
  entityByUnique.set(key(engine, next.uniqueId), next.entityId);
  saveEntity(next);
  return next;
}

export function removeEntity(entityId: string) {
  const e = entities.get(entityId);
  if (!e) return;
  entities.delete(entityId);
  entityByUnique.delete(key(e.engine, e.uniqueId));
  db().prepare(`DELETE FROM home_entities WHERE entity_id = ?`).run(entityId);
}

export interface EntityUpdate {
  name?: string | null;
  icon?: string | null;
  role?: EnergyRole | null;
  powerW?: number | null;
  interlock?: import('./types.ts').Interlock | null;
  areaId?: string | null;
  hidden?: boolean;
}

/** Applies user changes. Validation of values happens in the API layer. */
export function updateEntity(entityId: string, changes: EntityUpdate): EntityEntry | null {
  const e = entities.get(entityId);
  if (!e) return null;
  const next = { ...e, ...changes };
  entities.set(entityId, next);
  saveEntity(next);
  return next;
}

export function updateDevice(
  id: string,
  changes: { nameByUser?: string | null; areaId?: string | null; reviewed?: boolean; hidden?: boolean },
): DeviceEntry | null {
  const d = devices.get(id);
  if (!d) return null;
  const next = { ...d, ...changes };
  devices.set(id, next);
  saveDevice(next);
  return next;
}

/** Removes a device and all its entities. Returns the removed entity ids. */
export function removeDevice(id: string): string[] {
  const d = devices.get(id);
  if (!d) return [];
  const ids = [...entities.values()].filter((e) => e.deviceId === id).map((e) => e.entityId);
  for (const entityId of ids) removeEntity(entityId);
  devices.delete(id);
  deviceByUnique.delete(key(d.engine, d.uniqueId));
  db().prepare(`DELETE FROM home_devices WHERE id = ?`).run(id);
  return ids;
}

/** Clears an area from every device and entity (when the area is deleted). */
export function clearArea(areaId: string) {
  for (const d of devices.values()) if (d.areaId === areaId) updateDevice(d.id, { areaId: null });
  for (const e of entities.values()) if (e.areaId === areaId) updateEntity(e.entityId, { areaId: null });
}

export const entity = (entityId: string) => entities.get(entityId) ?? null;
export const device = (id: string) => devices.get(id) ?? null;
export const allEntities = (engine?: EngineId) => [...entities.values()].filter((e) => !engine || e.engine === engine);
export const allDevices = (engine?: EngineId) => [...devices.values()].filter((d) => !engine || d.engine === engine);

/** Display name: user override, else the engine's name. */
export const entityName = (e: EntityEntry) => e.name ?? e.originalName;
export const deviceName = (d: DeviceEntry) => d.nameByUser ?? d.name;
