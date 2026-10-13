/**
 * Tasmota driver: Tasmota's native MQTT discovery, so devices work without SetOption19 (local push).
 *
 * Tasmota publishes retained `tasmota/discovery/<MAC>/config` (relays, topics, payloads) and
 * `tasmota/discovery/<MAC>/sensors`. From them this driver builds a device with:
 * - relays as switches, or lights (with brightness when the light dims), shutters as covers;
 * - sensors (energy, temperature, humidity …) from the sensors message;
 * - availability from tele/LWT; state from stat/RESULT, stat/POWER<n>, tele/STATE, tele/SENSOR,
 *   stat/STATUS8/10/11.
 * An empty retained config removes the device. A device with SetOption19 (legacy Home Assistant
 * discovery) doesn't publish native discovery, so it never appears twice.
 *
 * Off-timer: a turn_on with `auto_off_s` sets PulseTime<n> first; the next plain turn_on clears it
 * again, so a relay doesn't keep switching itself off after an automation used the timer.
 */
import { randomBytes } from 'node:crypto';
import { connect, type MqttClient } from 'mqtt';
import { logger } from '../../../core/log.ts';
import { settings } from '../../../core/settings.ts';
import { safeUrl } from '../../../mqtt/topics.ts';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, UNKNOWN, type Context, type EngineHost, type ServiceCall, type ServiceResult } from '../../types.ts';
import { BROKER_KEYS, brokerTarget } from '../mqtt/broker.ts';
import type { DriverContext, DriverStatus, LiteDriver } from '../types.ts';
import {
  channels, flattenSensors, normMac, parseConfig, powerKey, pulseTime, shutterState, topicFor, type TasmotaConfig,
} from './model.ts';

const log = logger('home');
const DISCOVERY = 'tasmota/discovery';
const COMMAND_CONTEXT_MS = 10_000;

export interface TasmotaOptions {
  /** Broker to use instead of Sunroost's (tests). */
  url?: string;
  username?: string;
  password?: string;
}

interface Relay {
  index: number;
  kind: 'switch' | 'light';
  entityId: string;
  state: string;
  brightness?: number;
  /** PulseTime set by an off-timer, to clear before a plain turn_on. */
  pulseSet: boolean;
}

interface Shutter {
  index: number;
  entityId: string;
  state: string;
  position: number | null;
}

interface Dev {
  mac: string;
  cfg: TasmotaConfig;
  deviceId: string;
  relays: Relay[];
  shutters: Shutter[];
  /** Sensor key → entity id. */
  sensors: Map<string, string>;
  sensorValues: Map<string, number>;
  /** Raw sensors message, applied once the config is known. */
  available: boolean;
  /** Last command per entity, so the state change it causes carries it as parent context. */
  commands: Map<string, { context: Context; until: number }>;
}

export class TasmotaDriver implements LiteDriver {
  id = 'tasmota';
  name = 'Tasmota';
  iotClass = 'local_push' as const;
  private host: EngineHost | null = null;
  private client: MqttClient | null = null;
  private opts: TasmotaOptions;
  private state: DriverStatus['state'] = 'disabled';
  private message: string | null = null;
  private devices = new Map<string, Dev>(); // mac → device
  /** Sensors messages that arrived before their config. */
  private pendingSensors = new Map<string, unknown>();
  /** Topic → mac, for routing state messages. */
  private routes = new Map<string, string>();
  private retryTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private onSetting = (key: string) => {
    if (this.opts.url || !BROKER_KEYS.includes(key as never)) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.reconnect(), 600);
  };

  constructor(opts: TasmotaOptions = {}) {
    this.opts = opts;
  }

  async start(ctx: DriverContext) {
    this.host = ctx.host;
    settings.on('change', this.onSetting);
    this.open();
  }

  async stop() {
    settings.off('change', this.onSetting);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.close();
    this.devices.clear();
    this.routes.clear();
    this.pendingSensors.clear();
    this.host = null;
  }

  status(): DriverStatus {
    const entities = [...this.devices.values()].reduce((n, d) => n + d.relays.length + d.shutters.length + d.sensors.size, 0);
    return { state: this.state, message: this.message, entities, details: { devices: this.devices.size } };
  }

  // ---------- Connection ----------

  private async reconnect() {
    await this.close();
    if (this.host) this.open();
  }

  private open() {
    this.retryTimer = null;
    const t = this.opts.url
      ? { ok: true as const, url: this.opts.url, username: this.opts.username, password: this.opts.password }
      : brokerTarget();
    if (!t.ok) {
      this.state = t.reason === 'off' ? 'disabled' : 'error';
      this.message = t.message;
      if (t.reason === 'error' && this.host) this.retryTimer = setTimeout(() => this.open(), 5000);
      return;
    }
    this.state = 'connecting';
    this.message = null;
    const client = connect(t.url, {
      clientId: `solar_tasmota_${randomBytes(3).toString('hex')}`,
      username: t.username,
      password: t.password,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      queueQoSZero: false,
    });
    this.client = client;
    client.on('connect', () => {
      this.state = 'connected';
      this.message = null;
      client.subscribe([`${DISCOVERY}/+/config`, `${DISCOVERY}/+/sensors`, ...this.routes.keys()], { qos: 0 });
      for (const d of this.devices.values()) this.askState(d);
      log.info(`Tasmota: connected to ${safeUrl(t.url)}.`);
    });
    client.on('message', (topic, payload) => {
      try {
        this.onMessage(topic, payload.toString());
      } catch (err) {
        log.warn(`Tasmota: ${topic}: ${(err as Error).message}`);
      }
    });
    client.on('error', (err) => {
      this.state = 'error';
      this.message = err.message;
    });
    client.on('close', () => {
      if (this.state !== 'error') this.state = 'connecting';
      for (const d of this.devices.values()) this.setAvailable(d, false);
    });
  }

  private close() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const c = this.client;
    this.client = null;
    for (const d of this.devices.values()) this.setAvailable(d, false);
    if (!c) return Promise.resolve();
    return new Promise<void>((resolve) => {
      c.end(true, {}, () => resolve());
      setTimeout(resolve, 1000).unref();
    });
  }

  private publish(topic: string, payload: string) {
    this.client?.publish(topic, payload, { qos: 0, retain: false });
  }

  /** Asks a device for its relay state and sensors (on discovery and every (re)connect). */
  private askState(d: Dev) {
    this.publish(topicFor(d.cfg, 0, 'STATE'), '');
    this.publish(topicFor(d.cfg, 0, 'STATUS'), '10');
  }

  // ---------- Messages ----------

  /** Exposed for tests. */
  onMessage(topic: string, payload: string) {
    if (topic.startsWith(`${DISCOVERY}/`)) {
      const [, , mac, kind] = topic.split('/');
      if (kind === 'config') return this.onConfig(normMac(mac), payload);
      if (kind === 'sensors') return this.onSensorsConfig(normMac(mac), payload);
      return;
    }
    const mac = this.routes.get(topic);
    const d = mac ? this.devices.get(mac) : undefined;
    if (!d) return;
    const c = d.cfg;
    if (topic === topicFor(c, 2, 'LWT')) {
      if (payload === c.online) {
        this.setAvailable(d, true);
        this.askState(d);
      } else if (payload === c.offline) this.setAvailable(d, false);
      return;
    }
    // A message from the device itself means it's online (LWT may be missed after a broker restart).
    if (!d.available) this.setAvailable(d, true);
    let json: unknown = null;
    try {
      json = JSON.parse(payload);
    } catch {}
    const statPrefix = topicFor(c, 1, '');
    if (topic.startsWith(statPrefix) && /^POWER\d*$/.test(topic.slice(statPrefix.length))) {
      this.applyState(d, { [topic.slice(statPrefix.length)]: payload });
      return;
    }
    if (!json || typeof json !== 'object') return;
    const j = json as Record<string, any>;
    if (topic === topicFor(c, 1, 'RESULT') || topic === topicFor(c, 2, 'STATE')) this.applyState(d, j);
    if (topic === topicFor(c, 1, 'STATUS11') && j.StatusSTS) this.applyState(d, j.StatusSTS);
    if (topic === topicFor(c, 2, 'SENSOR')) this.applySensors(d, j);
    if ((topic === topicFor(c, 1, 'STATUS10') || topic === topicFor(c, 1, 'STATUS8')) && j.StatusSNS) this.applySensors(d, j.StatusSNS);
    if (topic === topicFor(c, 1, 'RESULT')) this.applySensors(d, j);
  }

  private onConfig(mac: string, payload: string) {
    if (!payload.trim()) return this.removeDevice(mac);
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const cfg = parseConfig(raw);
    if (!cfg || cfg.mac !== mac) return;
    const host = this.host;
    if (!host) return;
    const old = this.devices.get(mac);
    if (old && JSON.stringify(old.cfg) === JSON.stringify(cfg)) return;
    if (old) this.unroute(old);

    const dev = host.registerDevice({ uniqueId: `tasmota:${mac}`, name: cfg.name, manufacturer: 'Tasmota', model: cfg.model, swVersion: cfg.version });
    const relays: Relay[] = channels(cfg).map((ch) => {
      const named = cfg.friendly[ch.index - 1];
      const count = channels(cfg).length;
      const name = named && !(count === 1 && named === cfg.name) ? (named.startsWith(cfg.name) ? named : `${cfg.name} ${named}`) : count === 1 ? cfg.name : `${cfg.name} ${ch.index}`;
      const e = host.registerEntity({ uniqueId: `tasmota:${mac}:relay:${ch.index}`, domain: ch.kind, name, deviceId: dev.id });
      const prev = old?.relays.find((r) => r.index === ch.index);
      return { index: ch.index, kind: ch.kind, entityId: e.entityId, state: prev?.state ?? UNKNOWN, brightness: prev?.brightness, pulseSet: prev?.pulseSet ?? false };
    });
    const shutters: Shutter[] = Array.from({ length: cfg.shutters }, (_, i) => {
      const e = host.registerEntity({
        uniqueId: `tasmota:${mac}:shutter:${i + 1}`, domain: 'cover', name: cfg.shutters === 1 ? `${cfg.name} shutter` : `${cfg.name} shutter ${i + 1}`,
        deviceId: dev.id, services: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
      });
      return { index: i + 1, entityId: e.entityId, state: UNKNOWN, position: null };
    });
    // Entities of channels that disappeared (relay reconfigured).
    for (const r of old?.relays ?? []) if (!relays.some((x) => x.entityId === r.entityId)) host.removeEntity(r.entityId);
    const d: Dev = {
      mac, cfg, deviceId: dev.id, relays, shutters, sensors: old?.sensors ?? new Map(), sensorValues: old?.sensorValues ?? new Map(),
      available: old?.available ?? false, commands: old?.commands ?? new Map(),
    };
    this.devices.set(mac, d);
    this.route(d);
    if (!old) log.info(`Tasmota: added ${cfg.name} (${cfg.model}).`);
    const pending = this.pendingSensors.get(mac);
    if (pending !== undefined) {
      this.pendingSensors.delete(mac);
      this.registerSensors(d, pending);
    }
    this.pushAll(d);
    if (this.client?.connected) this.askState(d);
  }

  private onSensorsConfig(mac: string, payload: string) {
    const d = this.devices.get(mac);
    if (!payload.trim()) {
      if (d) {
        for (const id of d.sensors.values()) this.host?.removeEntity(id);
        d.sensors.clear();
      }
      this.pendingSensors.delete(mac);
      return;
    }
    let raw: any;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const sn = raw?.sn ?? raw;
    if (!d) {
      this.pendingSensors.set(mac, sn);
      return;
    }
    this.registerSensors(d, sn);
  }

  private registerSensors(d: Dev, sn: unknown) {
    const host = this.host;
    if (!host) return;
    const found = flattenSensors(sn);
    for (const [key, { value, def }] of found) {
      if (!d.sensors.has(key)) {
        const e = host.registerEntity({
          uniqueId: `tasmota:${d.mac}:sensor:${key}`, domain: 'sensor', name: `${d.cfg.name} ${def.label}`, deviceId: d.deviceId,
          unit: def.unit, deviceClass: def.deviceClass, readOnly: true,
        });
        d.sensors.set(key, e.entityId);
      }
      d.sensorValues.set(key, value);
    }
    this.pushAll(d);
  }

  private route(d: Dev) {
    const c = d.cfg;
    const topics = [
      topicFor(c, 2, 'LWT'), topicFor(c, 1, 'RESULT'), topicFor(c, 2, 'STATE'), topicFor(c, 2, 'SENSOR'),
      topicFor(c, 1, 'STATUS8'), topicFor(c, 1, 'STATUS10'), topicFor(c, 1, 'STATUS11'),
      ...d.relays.map((r) => topicFor(c, 1, powerKey(c, r.index))),
    ];
    for (const t of topics) {
      if (!this.routes.has(t)) this.client?.subscribe(t, { qos: 0 });
      this.routes.set(t, d.mac);
    }
  }

  private unroute(d: Dev) {
    for (const [t, mac] of this.routes) {
      if (mac !== d.mac) continue;
      this.routes.delete(t);
      this.client?.unsubscribe(t);
    }
  }

  private removeDevice(mac: string) {
    const d = this.devices.get(mac);
    this.pendingSensors.delete(mac);
    if (!d) return;
    this.unroute(d);
    this.devices.delete(mac);
    this.host?.removeDevice(d.deviceId);
    log.info(`Tasmota: removed ${d.cfg.name}.`);
  }

  // ---------- State ----------

  private applyState(d: Dev, j: Record<string, any>) {
    const c = d.cfg;
    for (const r of d.relays) {
      const v = j[powerKey(c, r.index)] ?? (r.index === 1 ? j.POWER ?? j.POWER1 : undefined);
      if (typeof v === 'string') {
        if (v === c.states[1] || v.toUpperCase() === 'ON') r.state = 'on';
        else if (v === c.states[0] || v.toUpperCase() === 'OFF') r.state = 'off';
      }
      if (r.kind === 'light' && typeof j.Dimmer === 'number') r.brightness = Math.round((j.Dimmer / 100) * 255);
    }
    for (const s of d.shutters) {
      const st = shutterState(j[`Shutter${s.index}`]);
      if (st) {
        s.state = st.state;
        s.position = st.position;
      }
    }
    this.pushAll(d);
  }

  private applySensors(d: Dev, j: Record<string, any>) {
    const found = flattenSensors(j);
    let changed = false;
    for (const [key, { value }] of found) {
      if (!d.sensors.has(key)) continue;
      d.sensorValues.set(key, value);
      changed = true;
    }
    // Shutter positions also come with tele/SENSOR.
    for (const s of d.shutters) {
      const st = shutterState(j[`Shutter${s.index}`]);
      if (st) {
        s.state = st.state;
        s.position = st.position;
        changed = true;
      }
    }
    if (changed) this.pushAll(d);
  }

  private setAvailable(d: Dev, available: boolean) {
    if (d.available === available) return;
    d.available = available;
    this.pushAll(d);
  }

  private pushAll(d: Dev) {
    const host = this.host;
    if (!host || this.devices.get(d.mac) !== d) return;
    const ctx = (entityId: string) => {
      const cmd = d.commands.get(entityId);
      return newContext('device', cmd && cmd.until > Date.now() ? cmd.context : null);
    };
    for (const r of d.relays) {
      const attrs: Record<string, unknown> = { supports_auto_off: true };
      if (r.kind === 'light' && d.cfg.lightType > 0) {
        attrs.supports_brightness = true;
        if (r.brightness !== undefined) attrs.brightness = r.brightness;
      }
      host.setState(r.entityId, d.available ? r.state : UNAVAILABLE, attrs, ctx(r.entityId));
    }
    for (const s of d.shutters) {
      host.setState(s.entityId, d.available ? s.state : UNAVAILABLE, s.position === null ? {} : { current_position: s.position }, ctx(s.entityId));
    }
    for (const [key, entityId] of d.sensors) {
      const v = d.sensorValues.get(key);
      host.setState(entityId, !d.available ? UNAVAILABLE : v === undefined ? UNKNOWN : String(v), {});
    }
  }

  // ---------- Commands ----------

  async callService(call: ServiceCall): Promise<ServiceResult> {
    if (!this.client?.connected) return { ok: false, message: 'Not connected to the MQTT broker' };
    for (const d of this.devices.values()) {
      const relay = d.relays.find((r) => r.entityId === call.entityId);
      const shutter = d.shutters.find((s) => s.entityId === call.entityId);
      if (!relay && !shutter) continue;
      d.commands.set(call.entityId, { context: call.context, until: Date.now() + COMMAND_CONTEXT_MS });
      const c = d.cfg;
      if (relay) return this.relayCommand(d, relay, call);
      const s = shutter!;
      switch (call.service) {
        case 'open_cover':
          this.publish(topicFor(c, 0, `ShutterOpen${s.index}`), '');
          return { ok: true };
        case 'close_cover':
          this.publish(topicFor(c, 0, `ShutterClose${s.index}`), '');
          return { ok: true };
        case 'stop_cover':
          this.publish(topicFor(c, 0, `ShutterStop${s.index}`), '');
          return { ok: true };
        case 'set_cover_position': {
          const pos = Number(call.data.position);
          if (!(pos >= 0 && pos <= 100)) return { ok: false, message: 'position must be 0–100' };
          this.publish(topicFor(c, 0, `ShutterPosition${s.index}`), String(Math.round(pos)));
          return { ok: true };
        }
        default:
          return { ok: false, message: `A Tasmota shutter can't ${call.service}` };
      }
    }
    return { ok: false, message: 'Unknown Tasmota device' };
  }

  private relayCommand(d: Dev, r: Relay, call: ServiceCall): ServiceResult {
    const c = d.cfg;
    const n = r.index;
    if (!['turn_on', 'turn_off', 'toggle'].includes(call.service)) return { ok: false, message: `This Tasmota relay can't ${call.service}` };
    if (call.service === 'turn_on') {
      const auto = Number(call.data.auto_off_s);
      if (auto > 0) {
        const pt = pulseTime(auto);
        if (pt === null) return { ok: false, message: 'auto_off_s is out of range for Tasmota (max 64800 s)' };
        this.publish(topicFor(c, 0, `PulseTime${n}`), String(pt));
        r.pulseSet = true;
      } else if (r.pulseSet) {
        this.publish(topicFor(c, 0, `PulseTime${n}`), '0');
        r.pulseSet = false;
      }
      if (r.kind === 'light' && typeof call.data.brightness === 'number' && c.lightType > 0) {
        const pct = Math.max(1, Math.min(100, Math.round((call.data.brightness / 255) * 100)));
        this.publish(topicFor(c, 0, d.relays.filter((x) => x.kind === 'light').length > 1 ? `Dimmer${n}` : 'Dimmer'), String(pct));
        return { ok: true };
      }
    }
    const payload = call.service === 'turn_on' ? c.states[1] : call.service === 'turn_off' ? c.states[0] : c.states[2];
    this.publish(topicFor(c, 0, `POWER${n}`), payload);
    return { ok: true };
  }
}
