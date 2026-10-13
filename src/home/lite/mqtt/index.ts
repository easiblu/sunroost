/**
 * MQTT discovery driver: any device that announces itself with Home Assistant MQTT discovery
 * (ESPHome, Zigbee2MQTT, OpenBeken, Tasmota with SetOption19, DIY firmware …) becomes a set of
 * entities. Connects to Sunroost's broker as an ordinary client so it receives retained configs, and
 * sends Home Assistant's birth message on every connect so devices re-announce themselves.
 */
import { randomBytes } from 'node:crypto';
import { connect, type MqttClient } from 'mqtt';
import { logger } from '../../../core/log.ts';
import { settings } from '../../../core/settings.ts';
import { safeUrl } from '../../../mqtt/topics.ts';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type Context, type EngineHost, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { DriverContext, DriverStatus, LiteDriver } from '../types.ts';
import { BROKER_KEYS, brokerTarget } from './broker.ts';
import { entityName, parseDiscovery, topicsOf, type DeviceInfo, type DiscoveredEntity } from './discovery.ts';
import { MqttEntity } from './entities.ts';
import { TemplateError } from './template.ts';

const log = logger('home');
export const DISCOVERY_PREFIX = 'homeassistant';
const BIRTH_TOPIC = `${DISCOVERY_PREFIX}/status`;
/** A state message within this long after a command is attributed to it (context chain). */
const COMMAND_CONTEXT_MS = 10_000;
const MAX_IGNORED = 30;

interface Tracked {
  entity: MqttEntity;
  entityId: string;
  /** Raw config, to skip identical re-announcements. */
  configJson: string;
  /** Last command, so the state change it causes carries it as parent context. */
  command?: { context: Context; until: number };
  templateErrorLogged?: boolean;
}

export class MqttDiscoveryDriver implements LiteDriver {
  id = 'mqtt';
  name = 'MQTT discovery';
  private host: EngineHost | null = null;
  private client: MqttClient | null = null;
  private target = '';
  private state: DriverStatus['state'] = 'disabled';
  private message: string | null = null;
  /** Discovery key → tracked entity. */
  private tracked = new Map<string, Tracked>();
  /** State/availability topic → discovery keys listening to it. */
  private routes = new Map<string, Set<string>>();
  private ignored = new Map<string, string>();
  /** Device info merged across entities: firmware often sends the full block with the first entity only. */
  private deviceInfo = new Map<string, DeviceInfo>();
  private restartTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private onSetting = (key: string) => {
    if (!BROKER_KEYS.includes(key as never)) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    // Let the MQTT module restart its broker first.
    this.restartTimer = setTimeout(() => void this.reconnect(), 500);
  };

  async start(ctx: DriverContext) {
    this.host = ctx.host;
    settings.on('change', this.onSetting);
    this.open();
  }

  async stop() {
    settings.off('change', this.onSetting);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.close();
    this.host = null;
  }

  private async reconnect() {
    await this.close();
    this.open();
  }

  private open() {
    this.retryTimer = null;
    const t = brokerTarget();
    if (!t.ok) {
      if (t.reason === 'error' && this.message !== t.message) log.warn(`MQTT devices: ${t.message}`);
      this.state = t.reason === 'off' ? 'disabled' : 'error';
      this.message = t.message;
      // The broker may still be (re)starting; try again shortly.
      if (t.reason === 'error' && this.host) this.retryTimer = setTimeout(() => this.open(), 5000);
      return;
    }
    this.target = safeUrl(t.url);
    this.state = 'connecting';
    this.message = null;
    const client = connect(t.url, {
      clientId: `solar_devices_${randomBytes(3).toString('hex')}`,
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
      const topics = [`${DISCOVERY_PREFIX}/#`, ...this.routes.keys()];
      client.subscribe(topics, { qos: 0 }, () => client.publish(BIRTH_TOPIC, 'online'));
      // Devices without availability topics get their last known state back; the rest re-report.
      for (const t of this.tracked.values()) this.push(t);
      log.info(`MQTT devices: connected to ${this.target}.`);
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));
    client.on('error', (err) => {
      if (err.message !== this.message) log.warn(`MQTT devices: ${err.message}`);
      this.state = 'error';
      this.message = err.message;
    });
    client.on('close', () => {
      if (this.state === 'connected') log.warn(`MQTT devices: disconnected from ${this.target}.`);
      if (this.state !== 'error') this.state = 'connecting';
      this.markAllUnavailable();
    });
  }

  private close() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const c = this.client;
    this.client = null;
    this.markAllUnavailable();
    if (!c) return Promise.resolve();
    return new Promise<void>((resolve) => {
      c.end(true, {}, () => resolve());
      setTimeout(resolve, 1000).unref();
    });
  }

  private markAllUnavailable() {
    if (!this.host) return;
    for (const t of this.tracked.values()) this.host.setState(t.entityId, UNAVAILABLE, t.entity.attributes);
  }

  /** Exposed for tests: handles one incoming message. */
  onMessage(topic: string, payload: string) {
    if (topic.startsWith(DISCOVERY_PREFIX + '/') && topic.endsWith('/config')) this.onDiscovery(topic, payload);
    const keys = this.routes.get(topic);
    if (!keys) return;
    for (const key of keys) {
      const t = this.tracked.get(key);
      if (!t) continue;
      try {
        if (t.entity.handle(topic, payload)) this.push(t);
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        if (!t.templateErrorLogged) log.warn(`${t.entityId}: template error: ${err.message}`);
        t.templateErrorLogged = true;
      }
    }
  }

  private push(t: Tracked) {
    const cmd = t.command && t.command.until > Date.now() ? t.command.context : null;
    this.host?.setState(t.entityId, t.entity.available ? t.entity.state : UNAVAILABLE, t.entity.attributes, newContext('device', cmd));
  }

  private onDiscovery(topic: string, payload: string) {
    const res = parseDiscovery(DISCOVERY_PREFIX, topic, payload);
    if (res.kind === 'ignore') {
      if (payload.trim()) this.ignore(topic, res.reason);
      return;
    }
    if (res.kind === 'remove') {
      for (const key of [...this.tracked.keys()]) if (key === res.keyPrefix || key.startsWith(res.keyPrefix + '#')) this.remove(key);
      this.ignored.delete(topic);
      return;
    }
    for (const key of res.removed) this.remove(key);
    const ownPrefix = (settings.get('mqtt_prefix') || 'sunroost').replace(/^\/+|\/+$/g, '') + '/';
    for (const d of res.entities) {
      // Sunroost announces its own inverter data the same way; those are already energy entities.
      if (topicsOf(d.config).some((x) => x.startsWith(ownPrefix))) continue;
      this.add(d);
    }
  }

  private ignore(key: string, reason: string) {
    if (!this.ignored.has(key) && this.ignored.size >= MAX_IGNORED) return;
    this.ignored.set(key, reason);
  }

  private add(d: DiscoveredEntity) {
    const host = this.host;
    if (!host) return;
    const configJson = JSON.stringify(d.config);
    const existing = this.tracked.get(d.key);
    if (existing && existing.configJson === configJson) return;

    let entity: MqttEntity;
    try {
      entity = new MqttEntity(d);
      entity.validateTemplates();
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      this.ignore(d.key, `Unsupported template: ${err.message}`);
      log.warn(`MQTT devices: ignored ${d.key}: unsupported template (${err.message}).`);
      return;
    }
    if (existing) this.unroute(d.key, existing.entity);

    const info = d.device ? this.mergeDevice(d.device) : null;
    const device = info
      ? host.registerDevice({
          uniqueId: `mqtt:${info.uniqueId}`, name: info.name ?? info.uniqueId, manufacturer: info.manufacturer, model: info.model, swVersion: info.swVersion,
        })
      : null;
    const name = entityName(d, info?.name ?? null);
    const entry = host.registerEntity({
      uniqueId: `mqtt:${d.component}:${d.uniqueId}`,
      domain: entity.domain,
      name,
      objectId: d.objectId ?? undefined,
      deviceId: device?.id ?? null,
      unit: typeof d.config.unit_of_measurement === 'string' ? d.config.unit_of_measurement : null,
      deviceClass: typeof d.config.device_class === 'string' ? d.config.device_class : null,
      services: entity.services,
      readOnly: entity.services.length === 0,
    });
    if (existing && existing.entityId !== entry.entityId) host.removeEntity(existing.entityId);
    const t: Tracked = { entity, entityId: entry.entityId, configJson };
    this.tracked.set(d.key, t);
    this.ignored.delete(d.key);
    for (const topic of entity.subscriptions()) {
      const set = this.routes.get(topic) ?? new Set();
      if (!set.size) this.client?.subscribe(topic, { qos: 0 });
      set.add(d.key);
      this.routes.set(topic, set);
    }
    if (!existing) log.info(`MQTT devices: added ${entry.entityId} (${name}).`);
    this.push(t);
  }

  /** Keeps every field any entity of the device has supplied; later non-empty values win. */
  private mergeDevice(dev: DeviceInfo): DeviceInfo {
    const old = this.deviceInfo.get(dev.uniqueId);
    const merged: DeviceInfo = old
      ? {
          uniqueId: dev.uniqueId,
          name: dev.name ?? old.name,
          manufacturer: dev.manufacturer ?? old.manufacturer,
          model: dev.model ?? old.model,
          swVersion: dev.swVersion ?? old.swVersion,
        }
      : dev;
    this.deviceInfo.set(dev.uniqueId, merged);
    return merged;
  }

  private unroute(key: string, entity: MqttEntity) {
    for (const topic of entity.subscriptions()) {
      const set = this.routes.get(topic);
      if (!set) continue;
      set.delete(key);
      if (!set.size) {
        this.routes.delete(topic);
        if (!topic.startsWith(DISCOVERY_PREFIX + '/')) this.client?.unsubscribe(topic);
      }
    }
  }

  private remove(key: string) {
    const t = this.tracked.get(key);
    if (!t) return;
    this.unroute(key, t.entity);
    this.tracked.delete(key);
    this.host?.removeEntity(t.entityId);
    log.info(`MQTT devices: removed ${t.entityId}.`);
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const t = [...this.tracked.values()].find((x) => x.entityId === call.entityId);
    if (!t) return { ok: false, message: 'The device has not announced itself since Sunroost started' };
    if (!this.client?.connected) return { ok: false, message: 'Not connected to the MQTT broker' };
    let res;
    try {
      res = t.entity.command(call.service, call.data);
    } catch (err) {
      return { ok: false, message: `Command template error: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, message: res.message };
    t.command = { context: call.context, until: Date.now() + COMMAND_CONTEXT_MS };
    for (const p of res.publish) this.client.publish(p.topic, p.payload, { qos: p.qos, retain: p.retain });
    if (t.entity.optimistic || t.entity.domain === 'button') this.push(t);
    return { ok: true };
  }

  status(): DriverStatus {
    return {
      state: this.state,
      message: this.message,
      entities: this.tracked.size,
      details: {
        broker: this.target || null,
        ignored: [...this.ignored].map(([topic, reason]) => ({ topic, reason })),
      },
    };
  }
}
