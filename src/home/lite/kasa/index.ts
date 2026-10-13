/**
 * TP-Link Kasa plugs, power strips, dimmers and bulbs, and KLAP devices (newer Kasa firmware, Tapo).
 * Local polling, modelled on python-kasa; protocol details in protocol.ts.
 *
 * - Legacy devices answer the UDP discovery broadcast on port 9999 and show up under "New devices".
 * - KLAP devices don't (their discovery is RSA-encrypted): add them by IP address; the flow asks for
 *   the TP-Link account email and password, which only ever go into the device handshake.
 * - Entities: a switch per outlet (strip children too), a light for dimmers and bulbs, and power (W)
 *   and energy (kWh) sensors when the device meters.
 * - auto_off_s on turn_on sets the device's own countdown rule (count_down / add_countdown_rule).
 */
import { createSocket, type Socket } from 'node:dgram';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type Context, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { DriverContext, DriverStatus, FlowContext, FlowStep, LiteDriver, LiteEntry } from '../types.ts';
import { KlapClient, KlapError, legacyRequest, xorDecrypt, xorEncrypt } from './protocol.ts';

const POLL_MS = 10_000;
const DISCOVER_MS = 5 * 60_000;
const FAILS_BEFORE_UNAVAILABLE = 3;

export interface KasaOptions {
  /** Legacy TCP/UDP port (9999). */
  port?: number;
  /** KLAP HTTP port (80). */
  klapPort?: number;
  /** Discovery broadcast address (tests use 127.0.0.1). */
  broadcast?: string;
  pollMs?: number;
  timeoutMs?: number;
}

/** What an entry looks like, decided when it is set up (so entities exist even while offline). */
interface Layout {
  protocol: 'legacy' | 'klap';
  host: string;
  mac: string;
  alias: string;
  model: string;
  kind: 'plug' | 'strip' | 'dimmer' | 'bulb';
  /** Strip outlets (full child ids). */
  children: { id: string; alias: string }[];
  emeter: boolean;
  deviceId: string;
  username?: string;
  password?: string;
}

interface Dev {
  entry: LiteEntry;
  layout: Layout;
  /** Outlet key ('' for the device itself, else child id) → entity id. */
  outlets: Map<string, string>;
  power: Map<string, string>;
  energy: Map<string, string>;
  klap: KlapClient | null;
  fails: number;
  queue: Promise<unknown>;
}

const macOf = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
const isHost = (h: string) => /^[a-z0-9.-]{1,253}$/i.test(h);

function b64(s: unknown): string {
  try {
    return Buffer.from(String(s ?? ''), 'base64').toString('utf8');
  } catch {
    return String(s ?? '');
  }
}

/** Layout of a legacy device from its sysinfo. Exported for tests. */
export function legacyLayout(host: string, si: Record<string, any>): Layout {
  const isBulb = typeof si.mic_type === 'string' && /BULB/i.test(si.mic_type) || si.light_state !== undefined;
  const children = Array.isArray(si.children)
    ? si.children.map((c: Record<string, any>) => ({ id: String(c.id).length <= 2 ? `${si.deviceId}${c.id}` : String(c.id), alias: String(c.alias ?? `Outlet ${c.id}`) }))
    : [];
  const kind: Layout['kind'] = isBulb ? 'bulb' : children.length ? 'strip' : si.brightness !== undefined ? 'dimmer' : 'plug';
  return {
    protocol: 'legacy', host, mac: macOf(si.mac ?? si.mic_mac ?? si.ethernet_mac), alias: String(si.alias ?? 'Kasa device'),
    model: String(si.model ?? 'Kasa'), kind, children, deviceId: String(si.deviceId ?? ''),
    emeter: /ENE/.test(String(si.feature ?? '')) && !isBulb,
  };
}

/** Power (W) and lifetime energy (kWh) from emeter.get_realtime: new firmware uses mW/Wh, old W/kWh. */
export function emeterReading(r: Record<string, any> | undefined): { w: number | null; kwh: number | null } {
  if (!r) return { w: null, kwh: null };
  const w = typeof r.power_mw === 'number' ? r.power_mw / 1000 : typeof r.power === 'number' ? r.power : null;
  const kwh = typeof r.total_wh === 'number' ? r.total_wh / 1000 : typeof r.total === 'number' ? r.total : null;
  return { w: w === null ? null : Math.round(w * 10) / 10, kwh: kwh === null ? null : Math.round(kwh * 1000) / 1000 };
}

export class KasaDriver implements LiteDriver {
  id = 'kasa';
  name = 'TP-Link Kasa / Tapo';
  iotClass = 'local_polling' as const;
  private ctx: DriverContext | null = null;
  private sock: Socket | null = null;
  private port: number;
  private klapPort: number;
  private broadcast: string;
  private pollMs: number;
  private timeoutMs: number;
  private devs = new Map<string, Dev>(); // entry id → device
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: KasaOptions = {}) {
    this.port = opts.port ?? 9999;
    this.klapPort = opts.klapPort ?? 80;
    this.broadcast = opts.broadcast ?? '255.255.255.255';
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (err) => ctx.log.warn(`Kasa: ${err.message}`));
    sock.on('message', (msg, rinfo) => this.onDiscovery(msg, rinfo.address));
    await new Promise<void>((resolve) => sock.bind(0, () => resolve()));
    try {
      sock.setBroadcast(true);
    } catch {}
    this.timers.push(setInterval(() => this.pollAll(), this.pollMs));
    this.timers.push(setInterval(() => this.scan(), DISCOVER_MS));
    setTimeout(() => this.scan(), 300).unref();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.sock?.close();
    this.sock = null;
    this.devs.clear();
  }

  status(): DriverStatus {
    let n = 0;
    for (const d of this.devs.values()) n += d.outlets.size + d.power.size + d.energy.size;
    return { state: this.sock ? 'connected' : 'disabled', message: null, entities: n };
  }

  // ---------- Discovery ----------

  scan() {
    this.sock?.send(xorEncrypt(JSON.stringify({ system: { get_sysinfo: {} } })), this.port, this.broadcast, () => {});
  }

  private onDiscovery(msg: Buffer, ip: string) {
    let si: Record<string, any> | undefined;
    try {
      si = JSON.parse(xorDecrypt(msg))?.system?.get_sysinfo;
    } catch {
      return;
    }
    if (!si) return;
    const l = legacyLayout(ip, si);
    if (!l.mac) return;
    this.ctx?.candidate({ uniqueId: l.mac, title: `${l.alias} (${l.model})`, context: { host: ip } });
  }

  discover() {
    return null; // devices answer our own UDP broadcast (see onDiscovery)
  }

  // ---------- Config flow ----------

  private hostForm(errors?: Record<string, string>): FlowStep {
    return {
      type: 'form', stepId: 'user', title: 'Add a TP-Link Kasa or Tapo device',
      description: 'Enter its IP address. Older Kasa devices on this network also appear under "New devices" by themselves.',
      fields: [{ name: 'host', label: 'IP address', help: null, kind: 'text', required: true }],
      ...(errors ? { errors } : {}),
    };
  }

  private credentialsForm(host: string, errors?: Record<string, string>): FlowStep {
    return {
      type: 'form', stepId: 'credentials', title: 'TP-Link account',
      description: `The device at ${host} uses TP-Link's newer encrypted protocol. Enter the email and password of the TP-Link (Kasa/Tapo app) account it is linked to; they are only used to talk to the device.`,
      fields: [
        { name: 'username', label: 'Email', help: null, kind: 'text', required: true },
        { name: 'password', label: 'Password', help: null, kind: 'password', required: true },
      ],
      ...(errors ? { errors } : {}),
    };
  }

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => {
      if (ctx.discovered) {
        return { type: 'form', stepId: 'confirm', title: 'Add TP-Link device', description: `Add ${ctx.discovered.title} at ${ctx.discovered.context.host}?`, fields: [] };
      }
      return this.hostForm();
    },
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      if (stepId === 'credentials') return this.submitCredentials(ctx, input);
      const host = stepId === 'confirm' ? String(ctx.discovered?.context.host ?? '') : String(input.host ?? '').trim();
      if (!isHost(host)) return this.hostForm({ host: 'Enter an IP address, e.g. 192.168.1.50' });
      try {
        const r = await legacyRequest(host, this.port, { system: { get_sysinfo: {} } }, this.timeoutMs);
        const si = r?.system?.get_sysinfo;
        if (si) {
          const l = legacyLayout(host, si);
          return { type: 'create_entry', title: l.alias, uniqueId: l.mac || null, data: l as unknown as Record<string, unknown> };
        }
      } catch {
        // Not a legacy device: try KLAP below.
      }
      if (await KlapClient.probe(host, this.klapPort, this.timeoutMs)) {
        ctx.state.host = host;
        return this.credentialsForm(host);
      }
      const err = { base: `No TP-Link device answered at ${host}.` };
      return stepId === 'confirm' ? { type: 'abort', reason: err.base } : this.hostForm(err);
    },
  };

  private async submitCredentials(ctx: FlowContext, input: Record<string, unknown>): Promise<FlowStep> {
    const host = String(ctx.state.host ?? '');
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    if (!username || !password) return this.credentialsForm(host, { base: 'Enter the email and password.' });
    const client = new KlapClient(host, this.klapPort, username, password, this.timeoutMs);
    let info: Record<string, any>;
    try {
      info = await client.request('get_device_info');
    } catch (err) {
      const e = err as KlapError;
      return this.credentialsForm(host, { base: e.code === 'auth' ? 'Wrong TP-Link email or password.' : e.message });
    }
    let emeter = false;
    try {
      await client.request('get_energy_usage');
      emeter = true;
    } catch {}
    const alias = b64(info.nickname) || String(info.model ?? 'Tapo device');
    const l: Layout = {
      protocol: 'klap', host, mac: macOf(info.mac), alias, model: String(info.model ?? 'Tapo'),
      kind: typeof info.brightness === 'number' ? 'bulb' : 'plug', children: [], emeter, deviceId: String(info.device_id ?? ''),
      username, password,
    };
    return { type: 'create_entry', title: alias, uniqueId: l.mac || null, data: l as unknown as Record<string, unknown> };
  }

  // ---------- Entries → devices ----------

  async entryAdded(entry: LiteEntry) {
    const host = this.ctx!.host;
    const l = entry.data as unknown as Layout;
    const dev = host.registerDevice({
      uniqueId: `kasa:${l.mac}`, name: l.alias, manufacturer: 'TP-Link', model: l.model, config: { entryId: entry.id },
    });
    const d: Dev = {
      entry, layout: l, outlets: new Map(), power: new Map(), energy: new Map(), fails: 0, queue: Promise.resolve(),
      klap: l.protocol === 'klap' ? new KlapClient(l.host, this.klapPort, String(l.username ?? ''), String(l.password ?? ''), this.timeoutMs) : null,
    };
    const lightish = l.kind === 'dimmer' || l.kind === 'bulb';
    const outlet = (key: string, uid: string, name: string, domain: 'switch' | 'light') =>
      d.outlets.set(key, host.registerEntity({ uniqueId: uid, domain, name, deviceId: dev.id }).entityId);
    const sensors = (key: string, uid: string, name: string) => {
      d.power.set(key, host.registerEntity({ uniqueId: `${uid}:power`, domain: 'sensor', name: `${name} power`, deviceId: dev.id, unit: 'W', deviceClass: 'power', readOnly: true }).entityId);
      if (l.protocol === 'legacy') {
        d.energy.set(key, host.registerEntity({ uniqueId: `${uid}:energy`, domain: 'sensor', name: `${name} energy`, deviceId: dev.id, unit: 'kWh', deviceClass: 'energy', readOnly: true }).entityId);
      } else {
        d.energy.set(key, host.registerEntity({ uniqueId: `${uid}:energy_today`, domain: 'sensor', name: `${name} energy today`, deviceId: dev.id, unit: 'kWh', deviceClass: 'energy', readOnly: true }).entityId);
      }
    };
    if (l.kind === 'strip') {
      for (const c of l.children) {
        outlet(c.id, `kasa:${l.mac}:${c.id}`, c.alias, 'switch');
        if (l.emeter) sensors(c.id, `kasa:${l.mac}:${c.id}`, c.alias);
      }
    } else {
      outlet('', `kasa:${l.mac}`, l.alias, lightish ? 'light' : 'switch');
      if (l.emeter) sensors('', `kasa:${l.mac}`, l.alias);
    }
    this.devs.set(entry.id, d);
    await this.poll(entry.id);
  }

  async entryRemoved(entry: LiteEntry) {
    this.devs.delete(entry.id);
  }

  /** Runs device I/O one at a time (the plugs handle one connection at a time). */
  private serial<T>(d: Dev, fn: () => Promise<T>): Promise<T> {
    const p = d.queue.then(fn, fn);
    d.queue = p.catch(() => {});
    return p;
  }

  private legacy(d: Dev, obj: unknown) {
    return this.serial(d, () => legacyRequest(d.layout.host, this.port, obj, this.timeoutMs));
  }

  private klap(d: Dev, method: string, params: Record<string, unknown> | null = null) {
    return this.serial(d, () => d.klap!.request(method, params));
  }

  private pollAll() {
    for (const id of this.devs.keys()) void this.poll(id);
  }

  private async poll(entryId: string, context: Context = newContext('device')) {
    const d = this.devs.get(entryId);
    if (!d || !this.ctx) return;
    try {
      if (d.layout.protocol === 'legacy') await this.pollLegacy(d, context);
      else await this.pollKlap(d, context);
      d.fails = 0;
    } catch {
      if (this.devs.get(entryId) !== d) return; // removed while waiting
      if (++d.fails >= FAILS_BEFORE_UNAVAILABLE) {
        for (const id of [...d.outlets.values(), ...d.power.values(), ...d.energy.values()]) this.ctx.host.setState(id, UNAVAILABLE);
      }
    }
  }

  private set(d: Dev, entityId: string | undefined, state: string, attrs: Record<string, unknown>, context: Context) {
    if (!entityId || this.devs.get(d.entry.id) !== d) return;
    this.ctx?.host.setState(entityId, state, attrs, context);
  }

  private async pollLegacy(d: Dev, context: Context) {
    const l = d.layout;
    const req: Record<string, unknown> = { system: { get_sysinfo: {} } };
    if (l.emeter && l.kind !== 'strip') req.emeter = { get_realtime: {} };
    const r = await this.legacy(d, req);
    const si = r?.system?.get_sysinfo;
    if (!si) throw new Error('No sysinfo');
    const plugAttrs = { supports_auto_off: true };
    if (l.kind === 'bulb') {
      const ls = si.light_state ?? {};
      const on = ls.on_off === 1;
      const bri = on ? ls.brightness : ls.dft_on_state?.brightness;
      this.set(d, d.outlets.get(''), on ? 'on' : 'off', { supports_brightness: true, ...(typeof bri === 'number' ? { brightness: Math.round((bri / 100) * 255) } : {}) }, context);
    } else if (l.kind === 'strip') {
      for (const c of si.children ?? []) {
        const id = String(c.id).length <= 2 ? `${si.deviceId}${c.id}` : String(c.id);
        this.set(d, d.outlets.get(id), c.state === 1 ? 'on' : 'off', plugAttrs, context);
      }
      if (l.emeter) {
        for (const c of l.children) {
          const er = await this.legacy(d, { context: { child_ids: [c.id] }, emeter: { get_realtime: {} } });
          this.setEmeter(d, c.id, er?.emeter?.get_realtime, context);
        }
      }
    } else {
      const attrs: Record<string, unknown> = { ...plugAttrs };
      if (l.kind === 'dimmer') {
        attrs.supports_brightness = true;
        if (typeof si.brightness === 'number') attrs.brightness = Math.round((si.brightness / 100) * 255);
      }
      this.set(d, d.outlets.get(''), si.relay_state === 1 ? 'on' : 'off', attrs, context);
      if (l.emeter) this.setEmeter(d, '', r?.emeter?.get_realtime, context);
    }
  }

  private setEmeter(d: Dev, key: string, rt: Record<string, any> | undefined, context: Context) {
    const { w, kwh } = emeterReading(rt);
    if (w !== null) this.set(d, d.power.get(key), String(w), {}, context);
    if (kwh !== null) this.set(d, d.energy.get(key), String(kwh), {}, context);
  }

  private async pollKlap(d: Dev, context: Context) {
    const info = await this.klap(d, 'get_device_info');
    const attrs: Record<string, unknown> = { supports_auto_off: d.layout.kind === 'plug' };
    if (d.layout.kind === 'bulb') {
      attrs.supports_brightness = true;
      if (typeof info.brightness === 'number') attrs.brightness = Math.round((info.brightness / 100) * 255);
    }
    this.set(d, d.outlets.get(''), info.device_on ? 'on' : 'off', attrs, context);
    if (d.layout.emeter) {
      const e = await this.klap(d, 'get_energy_usage');
      if (typeof e.current_power === 'number') this.set(d, d.power.get(''), String(Math.round(e.current_power / 100) / 10), {}, context);
      if (typeof e.today_energy === 'number') this.set(d, d.energy.get(''), String(e.today_energy / 1000), {}, context);
    }
  }

  // ---------- Commands ----------

  async callService(call: ServiceCall): Promise<ServiceResult> {
    let found: { d: Dev; key: string } | null = null;
    for (const d of this.devs.values()) {
      for (const [key, id] of d.outlets) if (id === call.entityId) found = { d, key };
    }
    if (!found) return { ok: false, message: 'Unknown TP-Link device' };
    const { d, key } = found;
    try {
      const on = call.service === 'toggle' ? !(await this.isOn(d, key)) : call.service === 'turn_on';
      const bri = typeof call.data.brightness === 'number' ? Math.max(1, Math.min(100, Math.round((call.data.brightness / 255) * 100))) : null;
      const autoOff = on && typeof call.data.auto_off_s === 'number' && call.data.auto_off_s > 0 ? Math.round(call.data.auto_off_s) : null;
      if (d.layout.protocol === 'klap') await this.commandKlap(d, on, bri, autoOff);
      else await this.commandLegacy(d, key, on, bri, autoOff);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    await this.poll(d.entry.id, newContext('device', call.context));
    return { ok: true };
  }

  private async isOn(d: Dev, key: string) {
    if (d.layout.protocol === 'klap') return (await this.klap(d, 'get_device_info')).device_on === true;
    const si = (await this.legacy(d, { system: { get_sysinfo: {} } }))?.system?.get_sysinfo ?? {};
    if (d.layout.kind === 'bulb') return si.light_state?.on_off === 1;
    if (key) return (si.children ?? []).some((c: Record<string, any>) => (String(c.id).length <= 2 ? `${si.deviceId}${c.id}` : String(c.id)) === key && c.state === 1);
    return si.relay_state === 1;
  }

  private async commandLegacy(d: Dev, key: string, on: boolean, bri: number | null, autoOff: number | null) {
    const ctxPart = key ? { context: { child_ids: [key] } } : {};
    const check = (r: Record<string, any> | undefined, mod: string, method: string) => {
      const code = r?.[mod]?.[method]?.err_code;
      if (code !== 0) throw new Error(r?.[mod]?.[method]?.err_msg ?? 'The device refused the command');
    };
    if (d.layout.kind === 'bulb') {
      const state: Record<string, unknown> = { on_off: on ? 1 : 0, transition_period: 0 };
      if (on && bri !== null) state.brightness = bri;
      const mod = 'smartlife.iot.smartbulb.lightingservice';
      check(await this.legacy(d, { [mod]: { transition_light_state: state } }), mod, 'transition_light_state');
      return;
    }
    if (on && bri !== null && d.layout.kind === 'dimmer') {
      const mod = 'smartlife.iot.dimmer';
      check(await this.legacy(d, { [mod]: { set_brightness: { brightness: bri } } }), mod, 'set_brightness');
    }
    check(await this.legacy(d, { ...ctxPart, system: { set_relay_state: { state: on ? 1 : 0 } } }), 'system', 'set_relay_state');
    if (autoOff !== null) {
      // One countdown rule per outlet: clear any old one, then switch off after the delay.
      await this.legacy(d, { ...ctxPart, count_down: { delete_all_rules: {} } }).catch(() => {});
      const r = await this.legacy(d, { ...ctxPart, count_down: { add_rule: { enable: 1, delay: autoOff, act: 0, name: 'Sunroost auto-off' } } });
      check(r, 'count_down', 'add_rule');
    }
  }

  private async commandKlap(d: Dev, on: boolean, bri: number | null, autoOff: number | null) {
    const params: Record<string, unknown> = { device_on: on };
    if (on && bri !== null && d.layout.kind === 'bulb') params.brightness = bri;
    await this.klap(d, 'set_device_info', params);
    if (autoOff !== null && d.layout.kind === 'plug') {
      await this.klap(d, 'add_countdown_rule', { delay: autoOff, desired_states: { on: false }, enable: true, remain: autoOff });
    }
  }
}
