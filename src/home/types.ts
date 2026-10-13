/**
 * Smart-home model, shaped like Home Assistant's core so both device engines (Sunroost's own "lite"
 * drivers and the embedded Home Assistant "full" engine) map onto it without translation:
 *
 * - A device is a physical box; an entity is one capability of it (switch.pump, sensor.pump_power).
 * - Entity ids are `<domain>.<object_id>` and stay stable across restarts (registry.ts).
 * - States are strings, like Home Assistant. "unavailable" means the engine can't reach the device;
 *   "unknown" means it's reachable but hasn't reported a value.
 * - Every state change and service call carries a Context, so a change can be traced to its cause.
 */

export type EngineId = 'energy' | 'lite' | 'full' | 'group';

export const UNAVAILABLE = 'unavailable';
export const UNKNOWN = 'unknown';

/** Domains with known services. Other Home Assistant domains pass through from the full engine. */
export type KnownDomain =
  | 'sensor' | 'binary_sensor' | 'switch' | 'light' | 'fan' | 'climate' | 'cover' | 'media_player'
  | 'select' | 'number' | 'button' | 'lock' | 'group';
export type Domain = KnownDomain | (string & {});

/**
 * How a device takes part in energy management. Only controllable entities have one.
 * critical: never switched off by automations. essential: switched off only in emergencies.
 * deferrable: run when there's surplus. sheddable: first off when energy is short.
 * protected: automations may not touch it unless allowed for this entity (ATS, chargers).
 */
export type EnergyRole = 'critical' | 'essential' | 'deferrable' | 'sheddable' | 'protected';
export const ENERGY_ROLES: EnergyRole[] = ['critical', 'essential', 'deferrable', 'sheddable', 'protected'];

/**
 * Conditions checked before any command (manual or automatic) reaches the device, against Sunroost's
 * live readings. A command is refused, with the reason, when one fails or a reading is unknown.
 */
export interface Interlock {
  /** Refuse while the house load is above this (W). */
  maxLoadW?: number;
  /** Refuse unless the grid is available (true) or down (false). */
  gridAvailable?: boolean;
  /** Refuse while the battery is below this (%). */
  minBatterySoc?: number;
}

export type ContextOrigin = 'device' | 'user' | 'rule' | 'system';

export interface Context {
  id: string;
  /** The context that caused this one (a rule run caused by a state change, a state change caused by a command). */
  parentId: string | null;
  origin: ContextOrigin;
  /** Automation id when origin is "rule". */
  ruleId?: number;
}

export interface EntityState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  /** Last time `state` changed. */
  lastChanged: number;
  /** Last time `state` or `attributes` changed. */
  lastUpdated: number;
  context: Context;
}

export interface DeviceEntry {
  id: string;
  engine: EngineId;
  /** Engine-scoped stable id: MAC address, serial number, or the Home Assistant device id. */
  uniqueId: string;
  /** Name from the engine; `nameByUser` overrides it. */
  name: string;
  nameByUser: string | null;
  manufacturer: string | null;
  model: string | null;
  swVersion: string | null;
  areaId: string | null;
  /** False until the user has looked at it: new devices show in the Devices page's "New" list. */
  reviewed: boolean;
  /** Ignored by the user: kept, but out of the way. */
  hidden: boolean;
  /** Engine-private settings (address, credentials ref …). Never sent to the UI. */
  config: Record<string, unknown>;
  createdAt: number;
}

export interface EntityEntry {
  entityId: string;
  engine: EngineId;
  uniqueId: string;
  deviceId: string | null;
  domain: Domain;
  /** Name from the engine; `name` (user) overrides it. */
  originalName: string;
  name: string | null;
  icon: string | null;
  unit: string | null;
  deviceClass: string | null;
  role: EnergyRole | null;
  /** What the device draws when on (W), set by the user; for running it on spare solar. */
  powerW: number | null;
  /** Safety conditions every command to this entity must meet (transfer switches, chargers …). */
  interlock: Interlock | null;
  areaId: string | null;
  hidden: boolean;
  /** Services the engine supports for this entity; null = the domain's defaults (DOMAIN_SERVICES). */
  services: string[] | null;
  /** True for entities nothing can command (energy readings, sensors). */
  readOnly: boolean;
  createdAt: number;
}

/** What an engine passes to register a device. */
export interface DeviceInput {
  uniqueId: string;
  name: string;
  /** Initial "reviewed" for a new device (e.g. already set up in Home Assistant); the user's choice wins afterwards. */
  reviewed?: boolean;
  /** Room name for a device seen for the first time (created if needed); ignored afterwards. */
  suggestedArea?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  swVersion?: string | null;
  config?: Record<string, unknown>;
}

/** What an engine passes to register an entity. */
export interface EntityInput {
  uniqueId: string;
  domain: Domain;
  name: string;
  /** Preferred object id (the part after the dot); defaults to the snake-cased name. */
  objectId?: string;
  /** Registry id of the device this entity belongs to. */
  deviceId?: string | null;
  icon?: string | null;
  unit?: string | null;
  deviceClass?: string | null;
  services?: string[] | null;
  readOnly?: boolean;
  /** Initial visibility for a new entity (diagnostic entities start hidden); the user's choice wins afterwards. */
  hidden?: boolean;
}

export interface ServiceCall {
  domain: string;
  service: string;
  entityId: string;
  data: Record<string, unknown>;
  context: Context;
}

export interface ServiceResult {
  ok: boolean;
  message?: string;
}

/** What the home core offers an engine. Engines never touch the registry or state machine directly. */
export interface EngineHost {
  registerDevice(input: DeviceInput): DeviceEntry;
  registerEntity(input: EntityInput): EntityEntry;
  removeEntity(entityId: string): void;
  /** Removes one of this engine's devices with its entities. */
  removeDevice(deviceId: string): void;
  /** Writes an entity's state; `context` defaults to a new device-origin context. */
  setState(entityId: string, state: string, attributes?: Record<string, unknown>, context?: Context): void;
  /** Entities this engine registered before (restored from the database), so it can re-attach to them. */
  entities(): EntityEntry[];
  devices(): DeviceEntry[];
}

export interface DeviceEngine {
  id: EngineId;
  name: string;
  start(host: EngineHost): Promise<void>;
  stop(): Promise<void>;
  /** Sends a command. The core validates the call first and waits for the state to confirm it. */
  callService(call: ServiceCall): Promise<ServiceResult>;
  /** Engine-specific status for the UI (connection, drivers …). */
  info?(): Record<string, unknown>;
}

/** Default services per domain (Home Assistant's names). Sensors have none. */
export const DOMAIN_SERVICES: Record<KnownDomain, string[]> = {
  sensor: [],
  binary_sensor: [],
  switch: ['turn_on', 'turn_off', 'toggle'],
  light: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle', 'set_percentage'],
  climate: ['turn_on', 'turn_off', 'set_hvac_mode', 'set_temperature', 'set_fan_mode'],
  cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
  media_player: ['turn_on', 'turn_off', 'toggle', 'volume_set', 'volume_mute', 'media_play', 'media_pause', 'select_source'],
  select: ['select_option'],
  number: ['set_value'],
  button: ['press'],
  lock: ['lock', 'unlock'],
  group: ['turn_on', 'turn_off', 'toggle'],
};

export function servicesFor(entry: EntityEntry): string[] {
  if (entry.readOnly) return [];
  return entry.services ?? DOMAIN_SERVICES[entry.domain as KnownDomain] ?? [];
}

/** "Battery state of charge" → "battery_state_of_charge"; never empty. */
export function objectIdFrom(text: string): string {
  const id = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'entity';
}

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}
