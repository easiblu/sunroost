/**
 * ESPHome devices over their native API (TCP 6053): local push, no MQTT or Home Assistant needed.
 *
 * - Discovery: mDNS `_esphomelib._tcp` (TXT mac, friendly_name, api_encryption when encrypted).
 * - Setup: confirm a discovered device (asking for its API encryption key when it uses one, or the
 *   legacy API password), or enter host[:port] by hand. uniqueId = MAC.
 * - Each entry keeps one connection: hello, login, device info, entity list, state subscription;
 *   states arrive as pushes, commands are confirmed by the next push. Keepalive pings every 20 s;
 *   a lost connection marks the entities unavailable and reconnects with backoff.
 */
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type Context, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { Candidate, DriverContext, DriverStatus, FlowContext, FlowStep, Found, LiteDriver, LiteEntry } from '../types.ts';
import { EspConnection, EspError, type DeviceInfo, type EspOptions } from './connection.ts';
import { commandFor, describeEntity, stateOf, type EspEntity } from './entities.ts';
import { MSG, type Fields } from './proto.ts';

const PING_MS = 20_000;
const BACKOFF_MS = [1000, 5000, 15_000, 30_000, 60_000];
const MDNS_TYPE = '_esphomelib._tcp.local';

export interface EsphomeOptions {
  timeoutMs?: number;
  backoffMs?: number[];
  pingMs?: number;
}

interface Tracked {
  e: EspEntity;
  entityId: string;
  state?: string;
  /** Climate: last mode other than off, for turn_on. */
  lastMode?: string;
  pending?: { context: Context; until: number };
}

interface Node {
  entry: LiteEntry;
  conn: EspConnection | null;
  /** ESPHome key → entity, its Sunroost entity id, last state, and the command waiting for confirmation. */
  entities: Map<number, Tracked>;
  attempt: number;
  timer: NodeJS.Timeout | null;
  ping: NodeJS.Timeout | null;
  state: 'connecting' | 'connected' | 'error';
  message: string | null;
  removed: boolean;
}

const macOf = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

const ERRORS: Record<string, string> = {
  cannot_connect: "Can't connect to the device. Check the address and that its api: component is enabled.",
  invalid_key: 'Wrong encryption key.',
  requires_encryption: 'This device uses encryption: enter its API encryption key (api: encryption: key: in its YAML).',
  no_encryption: "This device doesn't use encryption: leave the key empty.",
  invalid_password: 'Wrong API password.',
  timeout: 'The device did not answer in time.',
  protocol: 'The device answered in a way Sunroost does not understand.',
};

export class EsphomeDriver implements LiteDriver {
  id = 'esphome';
  name = 'ESPHome';
  iotClass = 'local_push' as const;
  mdnsTypes = [MDNS_TYPE];
  private ctx: DriverContext | null = null;
  private nodes = new Map<string, Node>();
  private timeoutMs: number;
  private backoff: number[];
  private pingMs: number;

  constructor(opts: EsphomeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.backoff = opts.backoffMs ?? BACKOFF_MS;
    this.pingMs = opts.pingMs ?? PING_MS;
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
  }

  async stop() {
    for (const n of this.nodes.values()) this.shutdown(n);
    this.nodes.clear();
    this.ctx = null;
  }

  status(): DriverStatus {
    const list = [...this.nodes.values()];
    const down = list.filter((n) => n.state !== 'connected');
    return {
      state: !list.length || !down.length ? 'connected' : down.length === list.length ? 'error' : 'connected',
      message: down.length ? `${down.length} of ${list.length} device${list.length === 1 ? '' : 's'} not connected` : null,
      entities: list.reduce((s, n) => s + n.entities.size, 0),
    };
  }

  // ---------- Discovery and setup ----------

  discover(found: Found): Candidate | null {
    if (found.source !== 'mdns' || found.type !== MDNS_TYPE) return null;
    const mac = macOf(found.props.mac);
    if (!mac) return null;
    const name = found.props.friendly_name || found.name;
    return {
      uniqueId: mac,
      title: `${name} (ESPHome)`,
      context: { host: found.ip, port: found.port ?? 6053, name, encrypted: 'api_encryption' in found.props },
    };
  }

  private async probe(opts: EspOptions): Promise<{ info: DeviceInfo }> {
    const c = new EspConnection({ ...opts, timeoutMs: this.timeoutMs });
    await c.open();
    try {
      return { info: await c.deviceInfo() };
    } finally {
      c.close();
    }
  }

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => {
      const d = ctx.discovered;
      if (d) {
        const encrypted = d.context.encrypted === true;
        return {
          type: 'form', stepId: 'confirm', title: `Add ${d.context.name}`,
          description: encrypted
            ? `${d.context.name} at ${d.context.host} uses an encrypted API. Enter the key from its YAML (api: encryption: key:).`
            : `Add the ESPHome device ${d.context.name} at ${d.context.host}?`,
          fields: encrypted
            ? [{ name: 'key', label: 'API encryption key', help: '44 characters, ends in =', kind: 'password', required: true }]
            : [{ name: 'password', label: 'API password (old firmware only)', help: null, kind: 'password', required: false }],
        };
      }
      return {
        type: 'form', stepId: 'user', title: 'Add an ESPHome device',
        description: 'Devices on this network appear under "New devices" by themselves. To add one by hand, enter its address.',
        fields: [
          { name: 'host', label: 'Host or IP address', help: 'e.g. 192.168.1.50 or living-room.local', kind: 'text', required: true },
          { name: 'port', label: 'Port', help: null, kind: 'number', required: true, default: 6053, min: 1, max: 65535, step: 1 },
          { name: 'key', label: 'API encryption key', help: 'Leave empty if the device has no encryption', kind: 'password', required: false },
          { name: 'password', label: 'API password (old firmware only)', help: null, kind: 'password', required: false },
        ],
      };
    },
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      const d = ctx.discovered;
      const host = stepId === 'confirm' ? String(d?.context.host ?? '') : String(input.host ?? '').trim();
      const port = stepId === 'confirm' ? Number(d?.context.port ?? 6053) : Number(input.port ?? 6053) || 6053;
      const key = String(input.key ?? '').trim();
      const password = String(input.password ?? '');
      const again = async (field: string, message: string): Promise<FlowStep> => {
        const form = await this.flow.start(ctx);
        return form.type === 'form' ? { ...form, errors: { [field]: message } } : form;
      };
      if (!host) return again('host', 'Enter the device address.');
      let info: DeviceInfo;
      try {
        ({ info } = await this.probe({ host, port, key, password }));
      } catch (err) {
        const code = err instanceof EspError ? err.code : 'cannot_connect';
        const field = code === 'invalid_key' || code === 'requires_encryption' || code === 'no_encryption' ? 'key' : code === 'invalid_password' ? 'password' : 'base';
        return again(field, ERRORS[code] ?? (err as Error).message);
      }
      const mac = info.mac || macOf(d?.uniqueId);
      return {
        type: 'create_entry', title: info.friendlyName || info.name || host, uniqueId: mac || null,
        data: { host, port, key, password, mac, name: info.name },
      };
    },
  };

  // ---------- Entries ----------

  async entryAdded(entry: LiteEntry) {
    const n: Node = { entry, conn: null, entities: new Map(), attempt: 0, timer: null, ping: null, state: 'connecting', message: null, removed: false };
    this.nodes.set(entry.id, n);
    await this.connect(n);
  }

  async entryRemoved(entry: LiteEntry) {
    const n = this.nodes.get(entry.id);
    if (!n) return;
    this.shutdown(n);
    this.nodes.delete(entry.id);
  }

  private shutdown(n: Node) {
    n.removed = true;
    if (n.timer) clearTimeout(n.timer);
    if (n.ping) clearInterval(n.ping);
    n.timer = n.ping = null;
    n.conn?.close();
    n.conn = null;
  }

  private alive(n: Node) {
    return !n.removed && this.nodes.get(n.entry.id) === n && !!this.ctx;
  }

  private async connect(n: Node) {
    if (!this.alive(n)) return;
    const data = n.entry.data;
    const conn = new EspConnection({
      host: String(data.host), port: Number(data.port ?? 6053), key: String(data.key ?? ''), password: String(data.password ?? ''), timeoutMs: this.timeoutMs,
    });
    n.conn = conn;
    n.state = 'connecting';
    try {
      await conn.open();
      const info = await conn.deviceInfo();
      const list = await conn.listEntities();
      if (!this.alive(n) || n.conn !== conn) return conn.close();
      this.register(n, info, list.map((x) => describeEntity(x.type, x.f)).filter((e): e is EspEntity => !!e));
      conn.on('message', (type, f) => this.onState(n, type, f));
      conn.on('close', () => this.onLost(n, conn));
      conn.send(MSG.SubscribeStatesRequest, Buffer.alloc(0));
      n.ping = setInterval(() => {
        conn.request(MSG.PingRequest, Buffer.alloc(0), MSG.PingResponse).catch(() => conn.close());
      }, this.pingMs);
      n.attempt = 0;
      n.state = 'connected';
      n.message = null;
      this.ctx?.log.info(`ESPHome: connected to ${n.entry.title}.`);
    } catch (err) {
      conn.close();
      if (!this.alive(n)) return;
      n.state = 'error';
      const msg = err instanceof EspError ? ERRORS[err.code] ?? err.message : (err as Error).message;
      if (msg !== n.message) this.ctx?.log.warn(`ESPHome: ${n.entry.title}: ${msg}`);
      n.message = msg;
      this.markUnavailable(n);
      this.retry(n);
    }
  }

  private retry(n: Node) {
    if (!this.alive(n) || n.timer) return;
    const ms = this.backoff[Math.min(n.attempt++, this.backoff.length - 1)];
    n.timer = setTimeout(() => {
      n.timer = null;
      void this.connect(n);
    }, ms);
  }

  private onLost(n: Node, conn: EspConnection) {
    if (n.conn !== conn) return;
    if (n.ping) clearInterval(n.ping);
    n.ping = null;
    n.conn = null;
    if (!this.alive(n)) return;
    n.state = 'error';
    n.message = 'Connection lost; reconnecting';
    this.ctx?.log.warn(`ESPHome: lost ${n.entry.title}; reconnecting.`);
    this.markUnavailable(n);
    this.retry(n);
  }

  private markUnavailable(n: Node) {
    for (const x of n.entities.values()) {
      x.state = UNAVAILABLE;
      this.ctx?.host.setState(x.entityId, UNAVAILABLE, x.e.attributes);
    }
  }

  private register(n: Node, info: DeviceInfo, list: EspEntity[]) {
    const host = this.ctx!.host;
    const mac = info.mac || String(n.entry.data.mac ?? n.entry.id);
    const devName = info.friendlyName || info.name || n.entry.title;
    const dev = host.registerDevice({
      uniqueId: `esphome:${mac}`, name: devName, manufacturer: info.manufacturer || 'Espressif', model: info.model || null,
      swVersion: info.esphomeVersion ? `ESPHome ${info.esphomeVersion}` : null, config: { entryId: n.entry.id },
    });
    const keep = new Set<string>();
    const old = n.entities;
    n.entities = new Map();
    for (const e of list) {
      const name = !e.name ? devName : e.name.toLowerCase().startsWith(devName.toLowerCase()) ? e.name : `${devName} ${e.name}`;
      const entry = host.registerEntity({
        uniqueId: `esphome:${mac}:${e.domain}:${e.objectId}`, domain: e.domain, name, deviceId: dev.id,
        unit: e.unit, deviceClass: e.deviceClass, services: e.services, readOnly: e.services.length === 0, hidden: e.diagnostic,
      });
      keep.add(entry.entityId);
      n.entities.set(e.key, { e, entityId: entry.entityId, lastMode: [...old.values()].find((x) => x.entityId === entry.entityId)?.lastMode });
      // Buttons have no state of their own.
      if (e.domain === 'button') host.setState(entry.entityId, 'unknown', e.attributes);
    }
    // Entities the device no longer has (YAML changed).
    for (const x of old.values()) if (!keep.has(x.entityId)) host.removeEntity(x.entityId);
    for (const ent of host.entities()) {
      if (ent.deviceId === dev.id && !keep.has(ent.entityId)) host.removeEntity(ent.entityId);
    }
  }

  private onState(n: Node, type: number, f: Fields) {
    if (!this.alive(n)) return;
    const key = f.fixed32(1);
    const x = n.entities.get(key);
    if (!x || x.e.stateType !== type) return;
    const s = stateOf(x.e, f);
    if (x.e.domain === 'climate' && s.state !== 'off') x.lastMode = s.state;
    x.state = s.state;
    // The change is traced to the command that caused it, when there is one pending.
    const ctx = x.pending && x.pending.until > Date.now() ? newContext('device', x.pending.context) : newContext('device');
    this.ctx!.host.setState(x.entityId, s.state, s.attributes, ctx);
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    for (const n of this.nodes.values()) {
      for (const x of n.entities.values()) {
        if (x.entityId !== call.entityId) continue;
        if (!n.conn || n.state !== 'connected') return { ok: false, message: 'Not connected to the device' };
        const cmd = commandFor(x.e, call.service, call.data, x.state, x.lastMode);
        if ('error' in cmd) return { ok: false, message: cmd.error };
        x.pending = { context: call.context, until: Date.now() + 10_000 };
        n.conn.send(cmd.type, cmd.payload);
        return { ok: true };
      }
    }
    return { ok: false, message: 'Unknown ESPHome entity' };
  }
}
