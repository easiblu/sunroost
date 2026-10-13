/**
 * Publishes live state, inverter settings and energy totals as MQTT topics (compatible with
 * SolarAssistant's published MQTT API), announces them to Home Assistant, and handles /set commands.
 *
 * State topics are retained and only sent when their value changes; everything is
 * resent every 5 minutes and on every (re)connect so late subscribers and brokers
 * that lost their retained store catch up.
 */
import { db } from '../core/db.ts';
import { logger } from '../core/log.ts';
import { meta, round, type Metrics, type Value } from '../core/metrics.ts';
import type { Snapshot } from '../core/state.ts';
import type { SetResult } from '../devices/manager.ts';
import type { SettingDef, SettingValues } from '../devices/types.ts';
import {
  type DeviceInfo, type DiscoveryContext, type DiscoveryMessage, responseConfig, sensorConfig, settingConfig,
} from './discovery.ts';
import {
  availabilityTopic, commandFilter, type DeviceKind, deviceName, deviceSegment, formatPayload, metricSegment,
  parseCommandTopic, responseTopic, stateTopic,
} from './topics.ts';
import type { Transport } from './transport.ts';

const log = logger('mqtt');
export const REPUBLISH_MS = 5 * 60_000;
export const ENERGY_MS = 60_000;

/** The parts of the device manager the publisher uses (a fake in tests). */
export interface DevicesLike {
  readonly started: boolean;
  readonly inverterCount: number;
  settingDefs(index: number): SettingDef[];
  settingValues(index: number): SettingValues;
  setSetting(index: number, keyOrLabel: string, value: Value, source?: string): Promise<SetResult>;
  on(event: 'settings', fn: (index: number, values: SettingValues) => void): unknown;
  off(event: 'settings', fn: (index: number, values: SettingValues) => void): unknown;
}

export interface PublisherConfig {
  prefix: string;
  uniq: string;
  discovery: boolean;
  allowUpdate: boolean;
  resetEnergy: 'd' | 'w' | 'm';
  /** Inverter manufacturer for discovery (from the driver descriptor). */
  manufacturer: string;
  /** Battery manufacturer/driver name for discovery. */
  batteryManufacturer?: string;
}

export interface EnergyLike {
  pv: number;
  load: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
}

/** Energy topics under total/, in kWh. */
export const ENERGY_TOPICS: [keyof EnergyLike, string, string][] = [
  ['pv', 'pv_energy', 'PV energy'],
  ['load', 'load_energy', 'Load energy'],
  ['gridImport', 'grid_energy_in', 'Grid energy in'],
  ['gridExport', 'grid_energy_out', 'Grid energy out'],
  ['batteryCharge', 'battery_energy_in', 'Battery energy in'],
  ['batteryDischarge', 'battery_energy_out', 'Battery energy out'],
];

export interface TopicEntry {
  topic: string;
  value: string;
  ts: number;
  retained: boolean;
}

export class Publisher {
  /** Last value sent per state topic (also the source for full republishes and the topic browser). */
  readonly topics = new Map<string, TopicEntry>();
  /** Discovery configs announced this session: config topic → payload. */
  readonly discovered = new Map<string, string>();
  /** Discovery configs on record from earlier sessions: object id → config topic. */
  private known = new Map<string, string>();
  private ctx: DiscoveryContext;
  private timers: NodeJS.Timeout[] = [];
  private swept = false;
  private stopped = false;
  private lastSnapshot: Snapshot | null = null;
  /** State topic → the device/name its discovery config was built from, to skip rebuilding it every refresh. */
  private announcedFor = new Map<string, string>();

  private transport: Transport;
  private cfg: PublisherConfig;
  private devices: DevicesLike;
  private energy: (period: 'd' | 'w' | 'm') => EnergyLike;

  constructor(transport: Transport, cfg: PublisherConfig, devices: DevicesLike, energy: (period: 'd' | 'w' | 'm') => EnergyLike) {
    this.transport = transport;
    this.cfg = cfg;
    this.devices = devices;
    this.energy = energy;
    this.ctx = { prefix: cfg.prefix, uniq: cfg.uniq, allowUpdate: cfg.allowUpdate };
  }

  start(snapshot?: Snapshot) {
    ensureTable();
    for (const r of db().prepare('SELECT object_id, topic FROM mqtt_discovery').all() as { object_id: string; topic: string }[]) {
      this.known.set(r.object_id, r.topic);
    }
    this.transport.subscribe(commandFilter(this.cfg.prefix), (topic, payload) => void this.handleCommand(topic, payload));
    this.devices.on('settings', this.onSettings);
    this.transport.onConnect = () => this.onConnect();
    if (this.cfg.discovery) this.announce(responseConfig(this.ctx, this.device('total')));
    if (snapshot) this.publishSnapshot(snapshot);
    for (let i = 0; i < this.devices.inverterCount; i++) this.publishSettings(i, this.devices.settingValues(i));
    this.publishEnergy();
    if (this.transport.connected) this.onConnect();
    this.timers.push(setInterval(() => this.publishEnergy(), ENERGY_MS));
    this.timers.push(setInterval(() => this.periodic(), REPUBLISH_MS));
  }

  /** Stops publishing. Marks the system offline; optionally removes retained topics and discovery configs. */
  async stop(opts: { clearDiscovery?: boolean; clearRetained?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.devices.off('settings', this.onSettings);
    this.transport.onConnect = null;
    if (opts.clearDiscovery) this.clearDiscovery();
    if (opts.clearRetained) for (const e of this.topics.values()) if (e.retained) this.transport.publish(e.topic, '', true);
    this.transport.publish(availabilityTopic(this.cfg.prefix), 'offline', true);
    await this.transport.flush();
  }

  /** Removes every discovery config this install has announced (empty retained payloads). */
  clearDiscovery() {
    ensureTable();
    const topics = new Set([...this.discovered.keys(), ...this.known.values()]);
    for (const t of topics) this.transport.publish(t, '', true);
    db().exec('DELETE FROM mqtt_discovery');
    this.discovered.clear();
    this.known.clear();
    if (topics.size) log.info(`Removed ${topics.size} Home Assistant discovery configs.`);
  }

  // ---------- Publishing ----------

  publishSnapshot(snap: Snapshot) {
    this.lastSnapshot = snap;
    snap.inverters.forEach((m, i) => m && this.publishMetrics('inverter', i, m));
    snap.batteries.forEach((m, i) => m && this.publishMetrics('battery', i, m));
    // Totals are aggregates; static info (serial, model) belongs to each inverter.
    const totals = Object.fromEntries(Object.entries(snap.totals).filter(([k]) => !meta(k).info));
    this.publishMetrics('total', 0, totals);
    if (snap.grid) this.publishMetrics('grid', 0, snap.grid);
  }

  publishSettings(index: number, values: SettingValues) {
    const defs = this.devices.settingDefs(index);
    const segment = deviceSegment('inverter', index);
    for (const def of defs) {
      const payload = formatPayload(values[def.key] ?? null);
      if (payload === null) continue;
      if (this.cfg.discovery) this.announce(settingConfig(this.ctx, this.device('inverter', index), def));
      this.send(stateTopic(this.cfg.prefix, segment, def.key), payload, true);
    }
  }

  publishEnergy() {
    let e: EnergyLike;
    try {
      e = this.energy(this.cfg.resetEnergy);
    } catch (err) {
      log.warn(`Energy totals unavailable: ${(err as Error).message}`);
      return;
    }
    const total = this.device('total');
    for (const [key, metric, name] of ENERGY_TOPICS) {
      const v = e[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (this.cfg.discovery) this.announce(sensorConfig(this.ctx, total, metric, name, true));
      this.send(stateTopic(this.cfg.prefix, 'total', metric), String(round(v, 2)), true);
    }
  }

  private publishMetrics(kind: DeviceKind, index: number, metrics: Metrics) {
    const segment = deviceSegment(kind, index);
    const dev = this.cfg.discovery ? this.device(kind, index, metrics) : null;
    const devKey = dev ? JSON.stringify(dev) : '';
    for (const [name, value] of Object.entries(metrics)) {
      const payload = formatPayload(value);
      if (payload === null) continue;
      const metric = metricSegment(name);
      if (!metric) continue;
      const topic = stateTopic(this.cfg.prefix, segment, metric);
      if (dev) {
        const key = `${devKey}|${name}|${typeof value}`;
        if (this.announcedFor.get(topic) !== key) {
          this.announcedFor.set(topic, key);
          this.announce(sensorConfig(this.ctx, dev, metric, name, typeof value === 'number'));
        }
      }
      this.send(topic, payload, true);
    }
  }

  /** Sends a state value when it changed since the last send. */
  private send(topic: string, payload: string, retain: boolean) {
    const prev = this.topics.get(topic);
    if (retain && prev?.value === payload) return;
    this.topics.set(topic, { topic, value: payload, ts: Date.now(), retained: retain });
    this.transport.publish(topic, payload, retain);
  }

  private announce(msg: DiscoveryMessage) {
    const payload = JSON.stringify(msg.payload);
    if (this.discovered.get(msg.topic) === payload) return;
    // Same entity under a different component (e.g. sensor → select after enabling updates): drop the old one.
    const old = this.known.get(msg.objectId);
    if (old && old !== msg.topic) {
      this.transport.publish(old, '', true);
      this.discovered.delete(old);
    }
    if (old !== msg.topic) {
      db().prepare('INSERT OR REPLACE INTO mqtt_discovery (object_id, topic) VALUES (?, ?)').run(msg.objectId, msg.topic);
      this.known.set(msg.objectId, msg.topic);
    }
    this.discovered.set(msg.topic, payload);
    this.transport.publish(msg.topic, payload, true);
  }

  private device(kind: DeviceKind, index = 0, metrics?: Metrics): DeviceInfo {
    const m = metrics ?? (kind === 'inverter' ? this.lastSnapshot?.inverters[index] : kind === 'battery' ? this.lastSnapshot?.batteries[index] : undefined);
    const str = (k: string) => (m && typeof m[k] === 'string' && m[k] ? (m[k] as string) : undefined);
    const info: DeviceInfo = { segment: deviceSegment(kind, index), name: deviceName(kind, index) };
    if (kind === 'inverter') {
      info.manufacturer = this.cfg.manufacturer;
      info.model = str('Model name');
      info.serial = str('Serial number');
      info.firmware = str('Firmware version');
    } else if (kind === 'battery') {
      info.manufacturer = this.cfg.batteryManufacturer || this.cfg.manufacturer;
      info.model = str('Model name');
      info.serial = str('Serial number');
    } else {
      info.manufacturer = this.cfg.manufacturer;
      info.model = kind === 'total' ? 'System total' : 'Grid provider';
    }
    return info;
  }

  private onSettings = (index: number, values: SettingValues) => this.publishSettings(index, values);

  /** On (re)connect: availability, then every discovery config and retained value we know. */
  private onConnect() {
    const t = this.transport;
    t.publish(availabilityTopic(this.cfg.prefix), 'online', true);
    for (const [topic, payload] of this.discovered) t.publish(topic, payload, true);
    for (const e of this.topics.values()) if (e.retained) t.publish(e.topic, e.value, true);
  }

  private periodic() {
    if (!this.transport.connected) return;
    this.onConnect();
    // Once per session, after things have settled: remove configs for metrics that no longer exist.
    if (!this.swept && this.cfg.discovery && this.devices.started && this.lastSnapshot?.inverters.some(Boolean)) {
      this.swept = true;
      this.sweepStale();
    }
  }

  /** Removes discovery configs recorded in earlier sessions that weren't announced in this one. */
  sweepStale() {
    let n = 0;
    for (const [objectId, topic] of this.known) {
      if (this.discovered.has(topic)) continue;
      this.transport.publish(topic, '', true);
      db().prepare('DELETE FROM mqtt_discovery WHERE object_id = ?').run(objectId);
      this.known.delete(objectId);
      n++;
    }
    if (n) log.info(`Removed ${n} Home Assistant discovery configs for metrics no longer reported.`);
    return n;
  }

  // ---------- Commands ----------

  /** Handles <prefix>/<device>/<setting>/set. Returns the response message (also published). */
  async handleCommand(topic: string, payload: string): Promise<string> {
    const parsed = parseCommandTopic(this.cfg.prefix, topic);
    if (!parsed) return '';
    log.info(`Received '${topic}': ${payload}`);
    const respond = (message: string, ok = false) => {
      (ok ? log.info : log.warn)(message);
      this.respond(message);
      return message;
    };
    if (!this.devices.started) return respond('Error: devices are not connected');
    if (!this.cfg.allowUpdate) return respond('Error: updates not allowed');
    const m = /^inverter_(\d+)$/.exec(parsed.device);
    const index = m ? Number(m[1]) - 1 : -1;
    if (index < 0 || index >= this.devices.inverterCount) return respond(`Error: invalid device: ${parsed.device}`);
    const def = this.devices.settingDefs(index).find((d) => d.key === parsed.metric);
    if (!def) return respond(`Error: invalid setting: ${parsed.metric}`);
    if (def.readOnly) return respond(`Error: changing '${def.label}' is not supported`);
    const result = await this.devices.setSetting(index, def.key, payload, 'mqtt');
    return respond(result.message, result.ok);
  }

  private respond(message: string) {
    const topic = responseTopic(this.cfg.prefix);
    this.topics.set(topic, { topic, value: message, ts: Date.now(), retained: false });
    this.transport.publish(topic, message, false);
  }
}

function ensureTable() {
  db().exec('CREATE TABLE IF NOT EXISTS mqtt_discovery (object_id TEXT PRIMARY KEY, topic TEXT NOT NULL)');
}
