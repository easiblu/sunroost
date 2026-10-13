/**
 * Philips Hue bridge, local CLIP API v2 (local push).
 *
 *   discovery  mDNS _hue._tcp (TXT bridgeid, modelid)
 *   pairing    POST /api {"devicetype","generateclientkey"} after the link button is pressed → application key
 *   resources  GET /clip/v2/resource/{device,light,motion,temperature,light_level,contact,zigbee_connectivity}
 *   live       GET /eventstream/clip/v2 (server-sent events), reconnecting with backoff
 *   command    PUT /clip/v2/resource/light/<id> {on:{on}, dimming:{brightness}}; confirmed by the event stream
 *
 * The bridge's certificate is self-signed (or signed by Signify's own CA), so certificate checks are
 * switched off for requests to the bridge only. Hue has no device-side off timer for plugs, so
 * `auto_off_s` is ignored.
 */
import http from 'node:http';
import https from 'node:https';
import { hostname } from 'node:os';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, UNKNOWN, type Context, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { Candidate, DriverContext, DriverStatus, FlowContext, FlowStep, Found, LiteDriver, LiteEntry } from '../types.ts';

const RESOURCE_TYPES = ['device', 'light', 'motion', 'temperature', 'light_level', 'contact', 'zigbee_connectivity'] as const;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const REQUEST_TIMEOUT_MS = 10_000;
const CONTEXT_TTL_MS = 10_000;
const RESYNC_DEBOUNCE_MS = 1_000;

export interface HueOptions {
  /** 'https' for real bridges; tests may use 'http'. */
  scheme?: 'https' | 'http';
  /** Bridge port (443; tests use another). */
  port?: number;
  /** Reconnect delays for the event stream. */
  retryMs?: number[];
}

type Res = Record<string, any>;

interface Bridge {
  entry: LiteEntry;
  host: string;
  key: string;
  bridgeId: string;
  /** Resource id → resource (merged with event updates). */
  cache: Map<string, Res>;
  /** Resource id → Sunroost entity id. */
  entities: Map<string, string>;
  /** Hue device id → Sunroost device id. */
  devices: Map<string, string>;
  /** Hue device id → reachable over Zigbee. */
  reachable: Map<string, boolean>;
  /** Light resource id → last command context. */
  commands: Map<string, { context: Context; until: number }>;
  stream: http.ClientRequest | null;
  streaming: boolean;
  attempt: number;
  retry: NodeJS.Timeout | null;
  resync: NodeJS.Timeout | null;
  /** Whether the bridge answered the last full sync. */
  online: boolean;
}

/** Hue light level (10000·log10(lux) + 1) → lux. */
export const luxFrom = (v: number) => Math.round(10 ** ((v - 1) / 10000));

const isPlug = (light: Res, device: Res | undefined) => light.metadata?.archetype === 'plug' || device?.metadata?.archetype === 'plug';

export class HueDriver implements LiteDriver {
  id = 'hue';
  name = 'Philips Hue';
  iotClass = 'local_push' as const;
  mdnsTypes = ['_hue._tcp.local'];
  private ctx: DriverContext | null = null;
  private scheme: 'https' | 'http';
  private port: number;
  private retryMs: number[];
  private bridges = new Map<string, Bridge>(); // entry id → bridge
  private agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

  constructor(opts: HueOptions = {}) {
    this.scheme = opts.scheme ?? 'https';
    this.port = opts.port ?? (this.scheme === 'https' ? 443 : 80);
    this.retryMs = opts.retryMs ?? RETRY_MS;
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
  }

  async stop() {
    for (const b of this.bridges.values()) this.close(b);
    this.bridges.clear();
    this.agent.destroy();
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  status(): DriverStatus {
    const list = [...this.bridges.values()];
    const down = list.filter((b) => !b.streaming);
    return {
      state: !list.length ? 'disabled' : down.length ? 'connecting' : 'connected',
      message: down.length ? `Connecting to ${down.map((b) => b.entry.title).join(', ')}` : null,
      entities: list.reduce((n, b) => n + b.entities.size, 0),
    };
  }

  // ---------- HTTP ----------

  private requestOpts(host: string, method: string, path: string, key: string | null, extra: Record<string, string> = {}) {
    return {
      host, port: this.port, method, path,
      headers: { ...(key ? { 'hue-application-key': key } : {}), ...extra },
      ...(this.scheme === 'https' ? { agent: this.agent } : {}),
    };
  }

  /** One JSON request to a bridge. Rejects on network errors and timeouts. */
  request(host: string, method: string, path: string, body?: unknown, key: string | null = null): Promise<{ status: number; json: any }> {
    const lib = this.scheme === 'https' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(
        this.requestOpts(host, method, path, key, payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let json: any = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {}
            resolve({ status: res.statusCode ?? 0, json });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('The bridge did not answer')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ---------- Discovery and pairing ----------

  discover(f: Found): Candidate | null {
    if (f.source !== 'mdns' || !f.type.startsWith('_hue._tcp')) return null;
    const id = String(f.props.bridgeid ?? '').toLowerCase();
    if (!id) return null;
    return { uniqueId: id, title: `Hue bridge at ${f.ip}`, context: { host: f.ip, bridgeId: id } };
  }

  private linkForm(errors?: Record<string, string>): FlowStep {
    return {
      type: 'form', stepId: 'link', title: 'Pair the Hue bridge',
      description: 'Press the round link button on top of the Hue bridge, then press Submit within 30 seconds.',
      fields: [], ...(errors ? { errors } : {}),
    };
  }

  private hostForm(errors?: Record<string, string>): FlowStep {
    return {
      type: 'form', stepId: 'user', title: 'Add a Hue bridge',
      description: 'Enter the bridge\'s IP address (see your router or the Hue app). Bridges on this network also appear under "New devices" by themselves.',
      fields: [{ name: 'host', label: 'IP address', help: null, kind: 'text', required: true }], ...(errors ? { errors } : {}),
    };
  }

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => {
      if (ctx.discovered) {
        ctx.state.host = ctx.discovered.context.host;
        ctx.state.bridgeId = ctx.discovered.context.bridgeId;
        return this.linkForm();
      }
      return this.hostForm();
    },
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      if (stepId === 'user') {
        const host = String(input.host ?? '').trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !/^[a-z0-9][a-z0-9.-]*$/i.test(host)) return this.hostForm({ host: 'Enter the bridge\'s IP address, e.g. 192.168.1.20' });
        let cfg: { status: number; json: any };
        try {
          cfg = await this.request(host, 'GET', '/api/0/config');
        } catch {
          return this.hostForm({ base: `No Hue bridge answered at ${host}.` });
        }
        const id = String(cfg.json?.bridgeid ?? '').toLowerCase();
        if (!id) return this.hostForm({ base: `The device at ${host} doesn't look like a Hue bridge.` });
        ctx.state.host = host;
        ctx.state.bridgeId = id;
        return this.linkForm();
      }
      const host = String(ctx.state.host ?? '');
      let res: { status: number; json: any };
      try {
        res = await this.request(host, 'POST', '/api', { devicetype: `sunroost#${hostname().slice(0, 19)}`, generateclientkey: true });
      } catch {
        return this.linkForm({ base: `Can't reach the bridge at ${host}.` });
      }
      const item = Array.isArray(res.json) ? res.json[0] : null;
      if (item?.error) {
        if (item.error.type === 101) return this.linkForm({ base: 'The link button has not been pressed. Press it, then Submit again.' });
        return this.linkForm({ base: `The bridge refused: ${item.error.description ?? 'unknown error'}` });
      }
      const key = item?.success?.username;
      if (!key) return this.linkForm({ base: 'Unexpected answer from the bridge.' });
      let bridgeId = String(ctx.state.bridgeId ?? '');
      if (!bridgeId) {
        const cfg = await this.request(host, 'GET', '/api/0/config').catch(() => null);
        bridgeId = String(cfg?.json?.bridgeid ?? host).toLowerCase();
      }
      return { type: 'create_entry', title: `Hue bridge ${host}`, uniqueId: bridgeId, data: { host, bridgeId, key } };
    },
  };

  // ---------- Entries ----------

  async entryAdded(entry: LiteEntry) {
    const b: Bridge = {
      entry, host: String(entry.data.host), key: String(entry.data.key), bridgeId: String(entry.data.bridgeId),
      cache: new Map(), entities: new Map(), devices: new Map(), reachable: new Map(), commands: new Map(),
      stream: null, streaming: false, attempt: 0, retry: null, resync: null, online: false,
    };
    this.bridges.set(entry.id, b);
    await this.sync(b).catch((err) => this.ctx?.log.warn(`Hue: ${entry.title}: ${(err as Error).message}`));
    if (this.bridges.get(entry.id) === b) this.openStream(b);
  }

  async entryRemoved(entry: LiteEntry) {
    const b = this.bridges.get(entry.id);
    if (!b) return;
    this.bridges.delete(entry.id);
    this.close(b);
  }

  private close(b: Bridge) {
    if (b.retry) clearTimeout(b.retry);
    if (b.resync) clearTimeout(b.resync);
    b.retry = b.resync = null;
    b.stream?.destroy();
    b.stream = null;
    b.streaming = false;
  }

  private alive(b: Bridge) {
    return this.bridges.get(b.entry.id) === b;
  }

  /** Reads every resource and (re)registers devices and entities. */
  private async sync(b: Bridge) {
    const lists = await Promise.all(
      RESOURCE_TYPES.map(async (t) => {
        const r = await this.request(b.host, 'GET', `/clip/v2/resource/${t}`, undefined, b.key);
        if (r.status === 403 || r.status === 401) throw new Error('The bridge no longer accepts Sunroost\'s key; set the bridge up again.');
        if (r.status !== 200) throw new Error(`The bridge answered HTTP ${r.status}`);
        return (r.json?.data ?? []) as Res[];
      }),
    );
    if (!this.alive(b)) return;
    b.online = true;
    b.cache.clear();
    for (const list of lists) for (const r of list) b.cache.set(r.id, r);
    this.register(b);
    for (const id of b.entities.keys()) this.push(b, id);
  }

  private device(b: Bridge, r: Res): Res | undefined {
    const owner = r.owner?.rid;
    return owner ? b.cache.get(owner) : undefined;
  }

  /** The Sunroost device for a Hue device, registered on first use. */
  private solarDevice(b: Bridge, hueDeviceId: string): string | null {
    const known = b.devices.get(hueDeviceId);
    if (known) return known;
    const d = b.cache.get(hueDeviceId);
    if (!d || !this.ctx) return null;
    const p = d.product_data ?? {};
    const dev = this.ctx.host.registerDevice({
      uniqueId: `hue:${b.bridgeId}:${d.id}`,
      name: String(d.metadata?.name ?? p.product_name ?? 'Hue device'),
      manufacturer: p.manufacturer_name ?? 'Signify',
      model: p.product_name ?? p.model_id ?? null,
      swVersion: p.software_version ?? null,
      config: { entryId: b.entry.id },
    });
    b.devices.set(hueDeviceId, dev.id);
    return dev.id;
  }

  private register(b: Bridge) {
    const host = this.ctx!.host;
    // The bridge itself, so it appears with the rest.
    const bridgeDev = [...b.cache.values()].find((r) => r.type === 'device' && /bridge/.test(String(r.metadata?.archetype)));
    if (bridgeDev) this.solarDevice(b, bridgeDev.id);
    const seen = new Set<string>();
    const add = (r: Res, domain: string, suffix: string | null, extra: { unit?: string; deviceClass?: string; readOnly?: boolean } = {}) => {
      const d = this.device(b, r);
      const devName = String(d?.metadata?.name ?? 'Hue');
      const name = suffix ? `${devName} ${suffix}` : String(r.metadata?.name ?? devName);
      const e = host.registerEntity({
        uniqueId: `hue:${b.bridgeId}:${r.id}`, domain, name,
        deviceId: d ? this.solarDevice(b, d.id) : null,
        unit: extra.unit ?? null, deviceClass: extra.deviceClass ?? null, readOnly: extra.readOnly ?? false,
      });
      b.entities.set(r.id, e.entityId);
      seen.add(r.id);
    };
    for (const r of b.cache.values()) {
      if (r.type === 'light') add(r, isPlug(r, this.device(b, r)) ? 'switch' : 'light', null);
      else if (r.type === 'motion') add(r, 'binary_sensor', 'motion', { deviceClass: 'motion', readOnly: true });
      else if (r.type === 'temperature') add(r, 'sensor', 'temperature', { unit: '°C', deviceClass: 'temperature', readOnly: true });
      else if (r.type === 'light_level') add(r, 'sensor', 'light level', { unit: 'lx', deviceClass: 'illuminance', readOnly: true });
      else if (r.type === 'contact') add(r, 'binary_sensor', 'contact', { deviceClass: 'door', readOnly: true });
      else if (r.type === 'zigbee_connectivity' && r.owner?.rid) b.reachable.set(r.owner.rid, r.status === 'connected');
    }
    // Resources gone from the bridge: gone from Sunroost.
    for (const [rid, entityId] of [...b.entities]) {
      if (!seen.has(rid)) {
        host.removeEntity(entityId);
        b.entities.delete(rid);
      }
    }
  }

  /** Writes one resource's state. */
  private push(b: Bridge, rid: string) {
    const host = this.ctx?.host;
    const r = b.cache.get(rid);
    const entityId = b.entities.get(rid);
    if (!host || !r || !entityId) return;
    const owner = r.owner?.rid as string | undefined;
    const reachable = b.online && (owner ? b.reachable.get(owner) !== false : true);
    const cmd = b.commands.get(rid);
    const ctx = newContext('device', cmd && cmd.until > Date.now() ? cmd.context : null);
    if (!reachable) {
      host.setState(entityId, UNAVAILABLE, {}, ctx);
      return;
    }
    switch (r.type) {
      case 'light': {
        const attrs: Record<string, unknown> = {};
        if (!isPlug(r, this.device(b, r)) && r.dimming) {
          attrs.supports_brightness = true;
          if (typeof r.dimming.brightness === 'number') attrs.brightness = Math.round((r.dimming.brightness / 100) * 255);
        }
        if (typeof r.color_temperature?.mirek === 'number') attrs.color_temp = r.color_temperature.mirek;
        host.setState(entityId, r.on?.on === true ? 'on' : r.on?.on === false ? 'off' : UNKNOWN, attrs, ctx);
        return;
      }
      case 'motion': {
        const m = r.motion ?? {};
        host.setState(entityId, m.motion_valid === false || r.enabled === false ? UNKNOWN : m.motion ? 'on' : 'off', {}, ctx);
        return;
      }
      case 'temperature': {
        const t = r.temperature ?? {};
        host.setState(entityId, typeof t.temperature === 'number' && t.temperature_valid !== false ? String(t.temperature) : UNKNOWN, {}, ctx);
        return;
      }
      case 'light_level': {
        const l = r.light ?? {};
        host.setState(entityId, typeof l.light_level === 'number' && l.light_level_valid !== false ? String(luxFrom(l.light_level)) : UNKNOWN, {}, ctx);
        return;
      }
      case 'contact': {
        const s = r.contact_report?.state;
        host.setState(entityId, s === 'no_contact' ? 'on' : s === 'contact' ? 'off' : UNKNOWN, {}, ctx);
        return;
      }
    }
  }

  /** All entities of one Hue device (after a connectivity change). */
  private pushDevice(b: Bridge, hueDeviceId: string) {
    for (const r of b.cache.values()) if (r.owner?.rid === hueDeviceId && b.entities.has(r.id)) this.push(b, r.id);
  }

  private markOffline(b: Bridge) {
    b.online = false;
    for (const rid of b.entities.keys()) this.push(b, rid);
  }

  // ---------- Event stream ----------

  private openStream(b: Bridge) {
    if (!this.alive(b)) return;
    const lib = this.scheme === 'https' ? https : http;
    const req = lib.request(this.requestOpts(b.host, 'GET', '/eventstream/clip/v2', b.key, { accept: 'text/event-stream' }), (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return this.streamDown(b, `HTTP ${res.statusCode}`);
      }
      b.streaming = true;
      b.attempt = 0;
      // Catch up on whatever happened while the stream was down.
      if (!b.online) void this.sync(b).catch(() => {});
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try {
            this.onEvents(b, JSON.parse(data));
          } catch {}
        }
      });
      res.on('end', () => this.streamDown(b, 'stream ended'));
      res.on('error', () => this.streamDown(b, 'stream error'));
    });
    req.on('error', (err) => this.streamDown(b, err.message));
    req.end();
    b.stream = req;
  }

  private streamDown(b: Bridge, why: string) {
    if (!this.alive(b) || b.retry) return;
    const was = b.streaming;
    b.streaming = false;
    b.stream?.destroy();
    b.stream = null;
    if (was) this.ctx?.log.warn(`Hue: ${b.entry.title}: event stream lost (${why}); reconnecting.`);
    const ms = this.retryMs[Math.min(b.attempt++, this.retryMs.length - 1)];
    b.retry = setTimeout(async () => {
      b.retry = null;
      if (!this.alive(b)) return;
      // Reachable at all? Without the bridge every entity is unavailable.
      try {
        await this.sync(b);
      } catch {
        if (this.alive(b)) this.markOffline(b);
      }
      if (this.alive(b)) this.openStream(b);
    }, ms);
  }

  private onEvents(b: Bridge, events: unknown) {
    if (!Array.isArray(events)) return;
    let structural = false;
    for (const ev of events as Res[]) {
      if (ev.type === 'add' || ev.type === 'delete') {
        structural = true;
        continue;
      }
      if (ev.type !== 'update') continue;
      for (const part of (ev.data ?? []) as Res[]) {
        const cur = b.cache.get(part.id);
        if (!cur) continue;
        const merged = mergeDeep(cur, part);
        b.cache.set(part.id, merged);
        if (merged.type === 'zigbee_connectivity' && merged.owner?.rid) {
          b.reachable.set(merged.owner.rid, merged.status === 'connected');
          this.pushDevice(b, merged.owner.rid);
        } else if (b.entities.has(part.id)) this.push(b, part.id);
      }
    }
    if (structural && !b.resync) {
      b.resync = setTimeout(() => {
        b.resync = null;
        if (this.alive(b)) void this.sync(b).catch(() => {});
      }, RESYNC_DEBOUNCE_MS);
    }
  }

  // ---------- Commands ----------

  async callService(call: ServiceCall): Promise<ServiceResult> {
    let b: Bridge | undefined;
    let rid: string | undefined;
    for (const x of this.bridges.values()) {
      for (const [r, e] of x.entities) if (e === call.entityId) [b, rid] = [x, r];
    }
    if (!b || !rid) return { ok: false, message: 'Unknown Hue device' };
    const r = b.cache.get(rid);
    if (r?.type !== 'light') return { ok: false, message: 'This Hue device can\'t be controlled' };
    const on = call.service === 'toggle' ? r.on?.on !== true : call.service === 'turn_on';
    if (!['turn_on', 'turn_off', 'toggle'].includes(call.service)) return { ok: false, message: `Unsupported command ${call.service}` };
    const body: Res = { on: { on } };
    if (on && r.dimming && typeof call.data.brightness === 'number') {
      body.dimming = { brightness: Math.max(1, Math.min(100, Math.round((call.data.brightness / 255) * 100))) };
    }
    b.commands.set(rid, { context: call.context, until: Date.now() + CONTEXT_TTL_MS });
    let res: { status: number; json: any };
    try {
      res = await this.request(b.host, 'PUT', `/clip/v2/resource/light/${rid}`, body, b.key);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const errors = (res.json?.errors ?? []) as { description?: string }[];
    if (res.status !== 200 || errors.length) return { ok: false, message: errors[0]?.description ?? `The bridge answered HTTP ${res.status}` };
    // Without the event stream, read the light back so the change still shows.
    if (!b.streaming && this.alive(b)) {
      const back = await this.request(b.host, 'GET', `/clip/v2/resource/light/${rid}`, undefined, b.key).catch(() => null);
      const fresh = back?.json?.data?.[0];
      if (fresh && this.alive(b)) {
        b.cache.set(rid, fresh);
        this.push(b, rid);
      }
    }
    return { ok: true };
  }
}

/** Merges a partial resource update into the cached resource (objects deep, everything else replaced). */
export function mergeDeep(base: Res, part: Res): Res {
  const out: Res = { ...base };
  for (const [k, v] of Object.entries(part)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}
