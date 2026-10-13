/**
 * Contract for the lite engine's drivers (MQTT discovery, Shelly, ESPHome, Modbus, WiZ …).
 *
 * A driver registers devices and entities through the scoped EngineHost; every entity uniqueId
 * starts with the driver id ("shelly:…"), which is how commands are routed back to it.
 *
 * Drivers that need setting up (an address, a password, a device key, pressing a button) offer a
 * config flow: a few form steps ending in an *entry* (one configured device, hub or account). The
 * lite engine stores entries (their data encrypted) and shows the flows with the same forms as Home
 * Assistant's, so the Devices page works the same with either engine. Network discovery (mDNS, SSDP,
 * the driver's own probes) turns into "New devices" whose Set up button starts the flow.
 *
 * Conventions every driver follows:
 * - Register devices with `config: { entryId }` so removing the entry removes them.
 * - After any await, check the device/entry still exists before writing state (it may have been removed).
 * - Device-side off-timer (dead-man switch): a `turn_on` may carry `data.auto_off_s` (seconds). A driver
 *   whose hardware can time itself out (Shelly toggle_after, Tasmota PulseTime, Kasa countdown …) sets it
 *   on the device and gives the entity the attribute `supports_auto_off: true`; others ignore the key.
 *   Strip keys a device doesn't know before sending.
 */
import type { Logger } from '../../core/log.ts';
import type { UiField } from '../full/flows.ts';
import type { EngineHost, ServiceCall, ServiceResult } from '../types.ts';

export interface DriverStatus {
  state: 'connected' | 'connecting' | 'disabled' | 'error';
  message: string | null;
  entities: number;
  /** Driver-specific details for the UI (broker, ignored configs …). */
  details?: Record<string, unknown>;
}

/** One configured device, hub or account of a driver. `data` is stored encrypted (may hold keys). */
export interface LiteEntry {
  id: string;
  driver: string;
  title: string;
  /** Stable id of what it configures (MAC, serial, bridge id); prevents adding the same thing twice. */
  uniqueId: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

/** Something found on the network. */
export interface Found {
  source: 'mdns' | 'ssdp' | 'udp' | 'mqtt';
  /** mDNS service type ("_shelly._tcp.local"), SSDP ST, or a driver tag. */
  type: string;
  /** mDNS instance name / SSDP USN / driver name. */
  name: string;
  host: string | null;
  ip: string;
  port: number | null;
  /** mDNS TXT records / SSDP headers / driver details. */
  props: Record<string, string>;
}

/** What a driver makes of a Found: a candidate for "New devices", or null when it's not one of its own. */
export interface Candidate {
  /** Same meaning as LiteEntry.uniqueId; candidates already configured or dismissed aren't shown. */
  uniqueId: string;
  title: string;
  /** Kept for the flow (address, model …). */
  context: Record<string, unknown>;
}

/** One step of a driver's config flow. */
export type FlowStep =
  | { type: 'form'; stepId: string; title?: string; description?: string; fields: UiField[]; errors?: Record<string, string> }
  | { type: 'create_entry'; title: string; uniqueId: string | null; data: Record<string, unknown> }
  | { type: 'abort'; reason: string };

/** State of a running flow, kept by the engine between steps. */
export interface FlowContext {
  /** Set when the flow was started from a discovered candidate. */
  discovered: Candidate | null;
  /** Scratch space the driver may fill between steps. */
  state: Record<string, unknown>;
}

export interface DriverFlow {
  /** First step; `ctx.discovered` is set when started from "New devices". */
  start(ctx: FlowContext): Promise<FlowStep>;
  submit(ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep>;
}

export interface DriverContext {
  host: EngineHost;
  log: Logger;
  /** This driver's configured entries. */
  entries(): LiteEntry[];
  /** Persists changed entry data (e.g. a renewed token). */
  updateEntry(id: string, data: Record<string, unknown>, title?: string): void;
  /** Reports a candidate found by the driver's own probes (UDP broadcast, polling …). */
  candidate(c: Candidate): void;
}

export interface LiteDriver {
  /** Prefix of every entity uniqueId this driver registers ("mqtt", "shelly" …). */
  id: string;
  name: string;
  /** Catalogue entry: shown in "Add integration" when the driver has a flow. */
  iotClass?: 'local_push' | 'local_polling';
  /** mDNS service types this driver wants to hear about ("_shelly._tcp.local"). */
  mdnsTypes?: string[];
  /** SSDP search targets this driver wants ("urn:schemas-upnp-org:device:basic:1", "ssdp:all"). */
  ssdpTargets?: string[];
  start(ctx: DriverContext): Promise<void>;
  stop(): Promise<void>;
  callService(call: ServiceCall): Promise<ServiceResult>;
  status(): DriverStatus;
  flow?: DriverFlow;
  /** Turns network findings into candidates. */
  discover?(found: Found): Candidate | null;
  /** An entry was created (after its flow) or loaded at start: set the device up. */
  entryAdded?(entry: LiteEntry): Promise<void>;
  /** An entry is being removed: stop talking to its device(s). The engine removes their registry devices. */
  entryRemoved?(entry: LiteEntry): Promise<void>;
}
