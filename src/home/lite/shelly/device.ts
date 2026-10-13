/**
 * What both Shelly generations share: the entities of one device, the command context that state
 * changes are traced to, and the availability bookkeeping.
 */
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type Context, type EngineHost, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { LiteEntry } from '../types.ts';

export interface ShellyTimings {
  pollMs: number;
  /** Gen2+: wait before reconnecting the WebSocket. */
  wsRetryMs: number;
  /** Retry setting up a device that was unreachable. */
  retryMs: number;
  timeoutMs: number;
}

export type Kind = 'switch' | 'light' | 'cover' | 'power' | 'energy' | 'temperature';

export interface Channel {
  kind: Kind;
  /** Component index (switch:0 → 0). */
  index: number;
  /** Status key it reads (Gen2 "switch:0"; Gen1 "relays.0"). */
  key: string;
  entityId: string;
}

const COMMAND_CONTEXT_MS = 10_000;
const FAILS_BEFORE_UNAVAILABLE = 3;

export abstract class ShellyDevice {
  readonly entry: LiteEntry;
  readonly host: EngineHost;
  readonly t: ShellyTimings;
  readonly mac: string;
  channels: Channel[] = [];
  stopped = false;
  protected fails = 0;
  private commands = new Map<string, { context: Context; until: number }>();

  constructor(entry: LiteEntry, host: EngineHost, t: ShellyTimings) {
    this.entry = entry;
    this.host = host;
    this.t = t;
    this.mac = String(entry.data.mac);
  }

  get address() {
    return String(this.entry.data.host);
  }

  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract command(ch: Channel, call: ServiceCall): Promise<ServiceResult>;

  owns(entityId: string) {
    return this.channels.some((c) => c.entityId === entityId);
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const ch = this.channels.find((c) => c.entityId === call.entityId);
    if (!ch) return { ok: false, message: 'Unknown Shelly channel' };
    this.commands.set(call.entityId, { context: call.context, until: Date.now() + COMMAND_CONTEXT_MS });
    try {
      return await this.command(ch, call);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Registers the device and one entity per channel; later calls reuse the same ids. */
  protected registerDevice(name: string, model: string, fw: string | null) {
    return this.host.registerDevice({
      uniqueId: `shelly:${this.mac}`, name, manufacturer: 'Shelly', model, swVersion: fw, config: { entryId: this.entry.id },
    }).id;
  }

  protected addChannel(deviceId: string, kind: Kind, index: number, key: string, name: string) {
    const uniqueId = `shelly:${this.mac}:${key}${kind === 'power' || kind === 'energy' ? `:${kind}` : ''}`;
    const base = { uniqueId, name, deviceId };
    const e =
      kind === 'switch' ? this.host.registerEntity({ ...base, domain: 'switch' })
      : kind === 'light' ? this.host.registerEntity({ ...base, domain: 'light' })
      : kind === 'cover' ? this.host.registerEntity({ ...base, domain: 'cover', services: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'] })
      : kind === 'power' ? this.host.registerEntity({ ...base, domain: 'sensor', unit: 'W', deviceClass: 'power', readOnly: true })
      : kind === 'energy' ? this.host.registerEntity({ ...base, domain: 'sensor', unit: 'kWh', deviceClass: 'energy', readOnly: true })
      : this.host.registerEntity({ ...base, domain: 'sensor', unit: '°C', deviceClass: 'temperature', readOnly: true });
    if (!this.channels.some((c) => c.entityId === e.entityId)) this.channels.push({ kind, index, key, entityId: e.entityId });
  }

  /** Writes one channel's state, traced to a recent command to it. */
  protected set(ch: Channel, state: string, attributes: Record<string, unknown> = {}) {
    if (this.stopped) return;
    const cmd = this.commands.get(ch.entityId);
    const parent = cmd && cmd.until > Date.now() ? cmd.context : null;
    this.host.setState(ch.entityId, state, attributes, newContext('device', parent));
  }

  /** Counts a failed refresh; after a few, every channel is unavailable. */
  protected failed() {
    if (++this.fails < FAILS_BEFORE_UNAVAILABLE || this.stopped) return;
    for (const ch of this.channels) this.host.setState(ch.entityId, UNAVAILABLE);
  }
}

/** 0–255 (Sunroost/Home Assistant) → 1–100 (Shelly). */
export const toPct = (b: number) => Math.max(1, Math.min(100, Math.round((b / 255) * 100)));
export const toByte = (pct: number) => Math.round((pct / 100) * 255);
export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
