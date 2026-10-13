/**
 * MQTT subsystem: runs the built-in broker or connects to an external one, and keeps a
 * Publisher attached to it. Restarts the relevant part whenever MQTT settings change:
 * broker settings (mode, port, URL, credentials) restart the connection; publishing
 * settings (prefix, unique id, discovery, allow updates) restart only the publisher.
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../core/log.ts';
import { settings, type SettingKey } from '../core/settings.ts';
import { state, type Snapshot } from '../core/state.ts';
import { devices } from '../devices/manager.ts';
import { bmsDriver, inverterDriver } from '../devices/registry.ts';
import { energyTotals } from '../stats/totals.ts';
import { Publisher, type TopicEntry } from './publisher.ts';
import { availabilityTopic, safeUrl } from './topics.ts';
import { BuiltinBroker, ExternalBroker, type Transport } from './transport.ts';

const log = logger('mqtt');

const BROKER_KEYS: SettingKey[] = ['publish_mqtt', 'mqtt.broker', 'mqtt.port', 'mqtt.url', 'mqtt_username', 'mqtt_password'];
const PUBLISH_KEYS: SettingKey[] = ['mqtt_prefix', 'mqtt_uniq_id', 'mqtt_discovery', 'mqtt_allow_update', 'reset_energy', 'inverter.driver_id', 'bms.driver_id'];
const RELEVANT = new Set<string>([...BROKER_KEYS, ...PUBLISH_KEYS]);

let transport: Transport | null = null;
let transportKey = '';
let publisher: Publisher | null = null;
let publisherKey = '';
let publisherPrefix = '';
let publisherDiscovery = false;
let publisherUniq = '';
let startError: string | null = null;
let listening = false;
let queue: Promise<void> = Promise.resolve();
let debounce: NodeJS.Timeout | null = null;
const clientId = `solar_${randomBytes(4).toString('hex')}`;

/** Host to bind the built-in broker to (tests use 127.0.0.1). */
let bindHost = '0.0.0.0';

export async function start(opts: { host?: string } = {}) {
  if (opts.host) bindHost = opts.host;
  if (!listening) {
    listening = true;
    settings.on('change', onSettingChange);
    state.on('refresh', onRefresh);
  }
  await apply();
}

export async function stop() {
  if (listening) {
    listening = false;
    settings.off('change', onSettingChange);
    state.off('refresh', onRefresh);
  }
  if (debounce) clearTimeout(debounce);
  await enqueue(() => teardown());
}

/** Re-reads settings and brings the broker/publisher in line with them. Serialized. */
export function apply() {
  return enqueue(reconcile);
}

function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch((err) => {
    startError = (err as Error).message;
    log.error(`MQTT: ${startError}`);
  });
  return queue;
}

function onSettingChange(key: string) {
  if (!RELEVANT.has(key)) return;
  // setMany() emits one 'change' per key; apply once after the burst.
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void apply();
  }, 50);
}

function onRefresh(snap: Snapshot) {
  publisher?.publishSnapshot(snap);
}

function brokerConfig() {
  return {
    mode: settings.get('mqtt.broker') === 'external' ? 'external' : 'builtin',
    port: Number(settings.get('mqtt.port')) || 1883,
    url: settings.get('mqtt.url').trim(),
    username: settings.get('mqtt_username'),
    password: settings.get('mqtt_password'),
  } as const;
}

function publisherConfig() {
  const inv = inverterDriver(settings.get('inverter.driver_id'));
  const bms = bmsDriver(settings.get('bms.driver_id'));
  return {
    prefix: (settings.get('mqtt_prefix') || 'sunroost').replace(/^\/+|\/+$/g, ''),
    uniq: (settings.get('mqtt_uniq_id') || 'sr').replace(/[^a-zA-Z0-9_-]/g, '_'),
    discovery: Boolean(settings.get('mqtt_discovery')),
    allowUpdate: Boolean(settings.get('mqtt_allow_update')),
    resetEnergy: settings.get('reset_energy'),
    manufacturer: inv?.manufacturer ?? 'Unknown',
    batteryManufacturer: bms?.name,
  };
}

async function reconcile() {
  if (!settings.get('publish_mqtt')) {
    if (transport) log.info('MQTT stopped.');
    await teardown();
    startError = null;
    return;
  }
  const bc = brokerConfig();
  const bKey = JSON.stringify(bc);
  const pc = publisherConfig();
  const pKey = JSON.stringify(pc);

  if (transport && bKey !== transportKey) {
    log.info('Broker settings changed; restarting MQTT.');
    await teardown();
  }

  if (publisher && pKey !== publisherKey) {
    // Old entities/topics would linger in Home Assistant and the broker otherwise.
    const identityChanged = pc.prefix !== publisherPrefix || pc.uniq !== publisherUniq;
    await publisher.stop({ clearDiscovery: publisherDiscovery && (identityChanged || !pc.discovery), clearRetained: pc.prefix !== publisherPrefix });
    publisher = null;
  }

  if (!transport) {
    startError = null;
    if (bc.mode === 'external') {
      if (!bc.url) {
        startError = 'No broker URL configured';
        log.warn('External broker selected but no URL is configured.');
        return;
      }
      transport = new ExternalBroker(bc.url, bc, { topic: availabilityTopic(pc.prefix), payload: 'offline' }, clientId);
    } else {
      const b = new BuiltinBroker(bc.port, bindHost, bc);
      if (!(await b.listen())) {
        startError = b.lastError;
        await b.close();
        return;
      }
      transport = b;
    }
    transportKey = bKey;
  }

  if (!publisher) {
    publisher = new Publisher(transport, pc, devices, energyTotals);
    publisherKey = pKey;
    publisherPrefix = pc.prefix;
    publisherDiscovery = pc.discovery;
    publisherUniq = pc.uniq;
    // Discovery was switched off: remove what earlier sessions announced.
    if (!pc.discovery) publisher.clearDiscovery();
    publisher.start(state.snapshot());
  }
}

async function teardown() {
  if (publisher) await publisher.stop();
  publisher = null;
  publisherKey = '';
  if (transport) await transport.close();
  transport = null;
  transportKey = '';
}

// ---------- Status for the API ----------

export function status() {
  const bc = brokerConfig();
  const t = transport;
  return {
    enabled: Boolean(settings.get('publish_mqtt')),
    broker: bc.mode,
    port: t instanceof BuiltinBroker ? t.boundPort : bc.port,
    url: bc.url ? safeUrl(bc.url) : '',
    running: Boolean(t && publisher),
    connected: Boolean(t?.connected),
    clients: t?.clients ?? 0,
    lastError: t?.lastError ?? startError,
    topicCount: publisher?.topics.size ?? 0,
    discoveryCount: publisher?.discovered.size ?? 0,
    prefix: publisherConfig().prefix,
    uniqId: publisherConfig().uniq,
  };
}

/** Every topic published this session, sorted. Discovery configs only when asked for. */
export function topics(opts: { discovery?: boolean } = {}): TopicEntry[] {
  if (!publisher) return [];
  const list = [...publisher.topics.values()];
  if (opts.discovery) {
    for (const [topic, value] of publisher.discovered) list.push({ topic, value, ts: 0, retained: true });
  }
  return list.sort((a, b) => a.topic.localeCompare(b.topic));
}

/** For tests: the active publisher. */
export const current = () => publisher;

/** Publishes one message through the active transport (used by automations). Returns an error message, or null when sent. */
export function publishMessage(topic: string, payload: string, retain = false): string | null {
  if (!transport) return settings.get('publish_mqtt') ? 'MQTT is not running' : 'MQTT is disabled';
  if (!transport.connected) return 'Not connected to the MQTT broker';
  transport.publish(topic, payload, retain);
  return null;
}
