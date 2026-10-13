/**
 * Tuya local: Tuya / Smart Life Wi-Fi plugs, switches and breakers controlled on the LAN (protocol 3.3, 3.4,
 * 3.5), without Tuya's cloud once set up. Each device needs its *local key*, which only Tuya's cloud knows:
 * get it once from the Tuya IoT Platform or `python -m tinytuya wizard`. Re-pairing the device in the app
 * changes the key.
 *
 * - Discovery: devices broadcast on UDP 6666 (clear), 6667 (encrypted) and 7000 (3.5). A broadcast from a
 *   configured device with a new IP updates its entry.
 * - Link: one persistent TCP connection per device (port 6668); states are pushed (local push), heartbeats
 *   every 10 s, reconnects with backoff. Tuya devices take only one local connection, so close the Smart
 *   Life app's LAN control or other local integrations for the same device.
 * - Off-timer: profiles with a countdown DP (energy plugs, DP 9) honour `auto_off_s` on turn_on.
 */
import { createSocket, type Socket } from 'node:dgram';
import type { UiField } from '../../full/flows.ts';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type Context, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { Candidate, DriverContext, DriverStatus, FlowContext, FlowStep, LiteDriver, LiteEntry } from '../types.ts';
import { TuyaConnection } from './connection.ts';
import { decodePhase, defsFor, deviceClassFor, parseCustom, PROFILES, scaled, type DpDef, type ProfileId } from './profiles.ts';
import { decodeDiscovery, TuyaError, VERSIONS, type Version } from './protocol.ts';

export interface TuyaOptions {
  /** Device TCP port (6668; tests use another). */
  port?: number;
  /** UDP discovery ports (6666, 6667, 7000; tests use others, or [] for none). */
  discoveryPorts?: number[];
  timeoutMs?: number;
  heartbeatMs?: number;
  /** Waits between reconnect attempts. */
  retryMs?: number[];
}

interface Entity {
  entityId: string;
  def: DpDef;
  /** For phase DPs: which part. */
  field?: 'voltage' | 'current' | 'power';
}

interface Device {
  entry: LiteEntry;
  defs: DpDef[];
  entities: Entity[];
  conn: TuyaConnection | null;
  dps: Record<string, unknown>;
  retry: NodeJS.Timeout | null;
  attempt: number;
  removed: boolean;
  /** Context of the last command, so the status push it causes is traced to it. */
  last: { context: Context; until: number } | null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export class TuyaDriver implements LiteDriver {
  id = 'tuya';
  name = 'Tuya (local)';
  iotClass = 'local_push' as const;
  private ctx: DriverContext | null = null;
  private o: Required<TuyaOptions>;
  private udp: Socket[] = [];
  private devices = new Map<string, Device>(); // entry id → device
  private stopped = false;

  constructor(o: TuyaOptions = {}) {
    this.o = { port: 6668, discoveryPorts: [6666, 6667, 7000], timeoutMs: 5000, heartbeatMs: 10_000, retryMs: [5000, 15_000, 30_000, 60_000], ...o };
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
    this.stopped = false;
    for (const port of this.o.discoveryPorts) {
      const s = createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', (err) => ctx.log.warn(`Tuya discovery on UDP ${port}: ${err.message}`));
      s.on('message', (msg, rinfo) => this.onBroadcast(msg, rinfo.address));
      s.bind(port);
      this.udp.push(s);
    }
  }

  async stop() {
    this.stopped = true;
    for (const s of this.udp) s.close();
    this.udp = [];
    for (const d of this.devices.values()) this.drop(d);
    this.devices.clear();
  }

  status(): DriverStatus {
    const all = [...this.devices.values()];
    const down = all.filter((d) => !d.conn?.open).length;
    return {
      state: 'connected',
      message: down ? `${down} of ${all.length} device${all.length === 1 ? '' : 's'} not connected` : null,
      entities: all.reduce((n, d) => n + d.entities.length, 0),
    };
  }

  // ---------- Discovery ----------

  /** Exposed for tests. */
  onBroadcast(msg: Buffer, from: string) {
    const a = decodeDiscovery(msg);
    if (!a || !this.ctx) return;
    const ip = IPV4.test(a.ip) ? a.ip : from;
    // A configured device that moved to a new address: follow it.
    const known = [...this.devices.values()].find((d) => d.entry.data.deviceId === a.gwId);
    if (known) {
      if (known.entry.data.host !== ip) {
        known.entry = { ...known.entry, data: { ...known.entry.data, host: ip } };
        this.ctx.updateEntry(known.entry.id, known.entry.data);
        this.ctx.log.info(`Tuya: ${known.entry.title} moved to ${ip}.`);
        this.reconnect(known, 0);
      }
      return;
    }
    const version = VERSIONS.includes(a.version as Version) ? a.version : null;
    this.ctx.candidate({ uniqueId: a.gwId, title: `Tuya device at ${ip}`, context: { host: ip, deviceId: a.gwId, version, productKey: a.productKey } });
  }

  // ---------- Config flow ----------

  private form(ctx: FlowContext, values: Record<string, unknown> = {}, errors: Record<string, string> = {}): FlowStep {
    const d = ctx.discovered?.context ?? {};
    const v = (k: string, dflt: unknown) => (values[k] !== undefined ? values[k] : dflt);
    const fields: UiField[] = [
      { name: 'host', label: 'IP address', help: null, kind: 'text', required: true, default: v('host', d.host ?? undefined) },
      { name: 'device_id', label: 'Device ID', help: 'Shown in the Tuya IoT Platform and by the tinytuya wizard.', kind: 'text', required: true, default: v('device_id', d.deviceId ?? undefined) },
      { name: 'local_key', label: 'Local key', help: '16 characters. Changes if you re-pair the device in the app.', kind: 'password', required: true, default: v('local_key', undefined) },
      {
        name: 'version', label: 'Protocol version', help: d.version ? 'Detected from the device.' : 'Most devices from 2020–2022 use 3.3; newer ones 3.4 or 3.5.',
        kind: 'select', required: true, default: v('version', d.version ?? '3.3'), options: VERSIONS.map((x) => ({ value: x, label: x })),
      },
      { name: 'profile', label: 'Device type', help: null, kind: 'select', required: true, default: v('profile', 'switch'), options: PROFILES.map((p) => ({ value: p.value, label: p.label })) },
      { name: 'outlets', label: 'Outlets (switch or plug)', help: null, kind: 'number', required: false, min: 1, max: 6, step: 1, default: v('outlets', 1) },
      {
        name: 'custom', label: 'Custom data points', kind: 'text', multiline: true, required: false, default: v('custom', undefined),
        help: 'Only for "Custom": one per line, dp:kind[:scale[:unit[:name]]] — kinds switch, sensor, binary_sensor, countdown. Example: 1:switch and 19:sensor:0.1:W:power',
      },
    ];
    return {
      type: 'form', stepId: 'user', title: ctx.discovered ? 'Add Tuya device' : 'Add a Tuya device', errors, fields,
      description:
        'Tuya devices are controlled locally, but each needs its local key, which only Tuya\'s cloud knows. Get it once from the Tuya IoT Platform '
        + '(link your Smart Life account to a cloud project and open the device) or by running `python -m tinytuya wizard` on a computer.',
    };
  }

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => this.form(ctx),
    submit: async (ctx: FlowContext, _stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      const host = String(input.host ?? '').trim();
      const deviceId = String(input.device_id ?? '').trim();
      const localKey = String(input.local_key ?? '');
      const version = String(input.version ?? '3.3') as Version;
      const profile = String(input.profile ?? 'switch') as ProfileId;
      const outlets = Number(input.outlets ?? 1);
      const customText = String(input.custom ?? '');
      const errors: Record<string, string> = {};
      if (!IPV4.test(host) && !HOSTNAME.test(host)) errors.host = 'Enter an IP address, e.g. 192.168.1.50';
      if (!/^[a-z0-9]{10,32}$/i.test(deviceId)) errors.device_id = 'A Tuya device ID is 20–22 letters and digits';
      if (localKey.length !== 16) errors.local_key = 'The local key is exactly 16 characters';
      if (!VERSIONS.includes(version)) errors.version = 'Choose 3.3, 3.4 or 3.5';
      if (!PROFILES.some((p) => p.value === profile)) errors.profile = 'Choose a device type';
      if (profile === 'switch' && !(Number.isInteger(outlets) && outlets >= 1 && outlets <= 6)) errors.outlets = 'Between 1 and 6';
      let custom: DpDef[] = [];
      if (profile === 'custom') {
        try {
          custom = parseCustom(customText);
        } catch (err) {
          errors.custom = (err as Error).message;
        }
      }
      if (Object.keys(errors).length) return this.form(ctx, input, errors);
      if (this.ctx?.entries().some((e) => e.data.deviceId === deviceId)) return { type: 'abort', reason: 'This device is already set up.' };

      // Connection test: a real link and a status query.
      const conn = new TuyaConnection({ host, port: this.o.port, deviceId, localKey, version, timeoutMs: this.o.timeoutMs, heartbeatMs: this.o.heartbeatMs });
      let dps: Record<string, unknown>;
      try {
        await conn.connect();
        dps = await conn.query();
      } catch (err) {
        const e = err as TuyaError;
        const msg = e.code === 'unreachable'
          ? `Nothing answered at ${host}:${this.o.port}. Check the address, and that no other app holds the device's local connection.`
          : e.code === 'auth' ? `${e.message}.` : `${e.message}.`;
        return this.form(ctx, input, e.code === 'auth' ? { local_key: msg } : { base: msg });
      } finally {
        conn.close();
      }
      const defs = defsFor(profile, outlets, custom);
      if (!defs.some((d) => d.dp in dps)) {
        const seen = Object.keys(dps).join(', ') || 'none';
        return this.form(ctx, input, { profile: `This device doesn't report the data points of that type (it reports: ${seen}). Try another type, or Custom.` });
      }
      const p = PROFILES.find((x) => x.value === profile)!;
      return {
        type: 'create_entry', title: `${p.title} ${host}`, uniqueId: deviceId,
        data: { host, deviceId, localKey, version, profile, outlets, custom },
      };
    },
  };

  discover(): Candidate | null {
    return null; // Devices announce themselves on UDP (see onBroadcast).
  }

  // ---------- Entries → devices ----------

  async entryAdded(entry: LiteEntry) {
    const host = this.ctx!.host;
    const data = entry.data;
    const defs = defsFor(data.profile as ProfileId, Number(data.outlets ?? 1), (data.custom as DpDef[]) ?? []);
    const devId = String(data.deviceId);
    const dev = host.registerDevice({
      uniqueId: `tuya:${devId}`, name: entry.title, manufacturer: 'Tuya', model: PROFILES.find((p) => p.value === data.profile)?.label ?? null,
      config: { entryId: entry.id },
    });
    const name = (suffix: string) => (suffix ? `${entry.title} ${suffix}` : entry.title);
    const entities: Entity[] = [];
    for (const d of defs) {
      if (d.kind === 'countdown') continue;
      if (d.kind === 'phase') {
        for (const [field, unit] of [['voltage', 'V'], ['current', 'A'], ['power', 'W']] as const) {
          const e = host.registerEntity({ uniqueId: `tuya:${devId}:${d.dp}:${field}`, domain: 'sensor', name: name(field), deviceId: dev.id, unit, deviceClass: deviceClassFor(unit), readOnly: true });
          entities.push({ entityId: e.entityId, def: d, field });
        }
        continue;
      }
      const domain = d.kind === 'switch' ? 'switch' : d.kind === 'binary_sensor' ? 'binary_sensor' : 'sensor';
      const e = host.registerEntity({
        uniqueId: `tuya:${devId}:${d.dp}`, domain, name: name(d.name), deviceId: dev.id, unit: d.unit ?? null,
        deviceClass: deviceClassFor(d.unit), readOnly: domain !== 'switch',
      });
      entities.push({ entityId: e.entityId, def: d });
    }
    const device: Device = { entry, defs, entities, conn: null, dps: {}, retry: null, attempt: 0, removed: false, last: null };
    this.devices.set(entry.id, device);
    for (const e of entities) host.setState(e.entityId, UNAVAILABLE);
    void this.link(device);
  }

  async entryRemoved(entry: LiteEntry) {
    const d = this.devices.get(entry.id);
    if (!d) return;
    this.drop(d);
    this.devices.delete(entry.id);
  }

  private drop(d: Device) {
    d.removed = true;
    if (d.retry) clearTimeout(d.retry);
    d.retry = null;
    const c = d.conn;
    d.conn = null;
    c?.close('Removed');
  }

  private reconnect(d: Device, delay: number) {
    if (d.removed || this.stopped) return;
    if (d.retry) clearTimeout(d.retry);
    d.conn?.close('Reconnecting');
    d.retry = setTimeout(() => {
      d.retry = null;
      void this.link(d);
    }, delay);
  }

  private async link(d: Device) {
    if (d.removed || this.stopped) return;
    const data = d.entry.data;
    const conn = new TuyaConnection({
      host: String(data.host), port: this.o.port, deviceId: String(data.deviceId), localKey: String(data.localKey),
      version: String(data.version) as Version, timeoutMs: this.o.timeoutMs, heartbeatMs: this.o.heartbeatMs,
    });
    d.conn = conn;
    conn.on('dps', (dps) => {
      if (d.conn !== conn || d.removed) return;
      Object.assign(d.dps, dps);
      this.publish(d);
    });
    conn.on('close', (reason) => {
      if (d.conn !== conn || d.removed) return;
      d.conn = null;
      this.unavailable(d);
      const wait = this.o.retryMs[Math.min(d.attempt++, this.o.retryMs.length - 1)];
      this.ctx?.log.warn(`Tuya: ${d.entry.title}: ${reason}; reconnecting in ${Math.round(wait / 1000)} s.`);
      this.reconnect(d, wait);
    });
    try {
      await conn.connect();
      const dps = await conn.query();
      if (d.conn !== conn || d.removed) return conn.close('Removed');
      d.attempt = 0;
      Object.assign(d.dps, dps);
      this.publish(d);
    } catch (err) {
      if (d.conn !== conn || d.removed) return;
      // `close` handles the retry when the socket had opened; otherwise schedule it here.
      if (!conn.open) {
        d.conn = null;
        this.unavailable(d);
        const wait = this.o.retryMs[Math.min(d.attempt++, this.o.retryMs.length - 1)];
        this.ctx?.log.warn(`Tuya: ${d.entry.title}: ${(err as Error).message}; retrying in ${Math.round(wait / 1000)} s.`);
        this.reconnect(d, wait);
      } else {
        conn.close((err as Error).message);
      }
    }
  }

  private unavailable(d: Device) {
    for (const e of d.entities) this.ctx?.host.setState(e.entityId, UNAVAILABLE);
  }

  private publish(d: Device) {
    const host = this.ctx?.host;
    if (!host) return;
    const cmd = d.last && d.last.until > Date.now() ? d.last.context : null;
    const hasCountdown = d.defs.some((x) => x.kind === 'countdown');
    for (const e of d.entities) {
      const v = d.dps[e.def.dp];
      if (v === undefined) continue;
      const ctx = newContext('device', cmd);
      if (e.def.kind === 'switch') {
        host.setState(e.entityId, v === true ? 'on' : 'off', hasCountdown && e.def === d.defs.find((x) => x.kind === 'switch') ? { supports_auto_off: true } : {}, ctx);
      } else if (e.def.kind === 'binary_sensor') {
        host.setState(e.entityId, v === true || v === 1 || v === '1' ? 'on' : 'off', {}, ctx);
      } else if (e.def.kind === 'phase') {
        const p = decodePhase(v);
        if (p) host.setState(e.entityId, String(p[e.field!]), {}, ctx);
      } else {
        const n = scaled(v, e.def.scale ?? 1);
        host.setState(e.entityId, n === null ? String(v) : String(n), {}, ctx);
      }
    }
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const d = [...this.devices.values()].find((x) => x.entities.some((e) => e.entityId === call.entityId));
    const ent = d?.entities.find((e) => e.entityId === call.entityId);
    if (!d || !ent) return { ok: false, message: 'Unknown Tuya device' };
    if (ent.def.kind !== 'switch') return { ok: false, message: "This data point can't be controlled" };
    if (!d.conn?.open) return { ok: false, message: 'The device is not connected' };
    const on = call.service === 'toggle' ? d.dps[ent.def.dp] !== true : call.service === 'turn_on';
    const dps: Record<string, unknown> = { [ent.def.dp]: on };
    // Device-side off-timer: the countdown DP of the first switch (energy plugs: DP 9).
    const countdown = d.defs.find((x) => x.kind === 'countdown');
    const firstSwitch = d.defs.find((x) => x.kind === 'switch');
    const autoOff = Number(call.data.auto_off_s);
    if (on && countdown && ent.def === firstSwitch && Number.isFinite(autoOff) && autoOff > 0) dps[countdown.dp] = Math.min(86_400, Math.round(autoOff));
    d.last = { context: call.context, until: Date.now() + 10_000 };
    try {
      await d.conn.set(dps);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
