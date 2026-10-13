/**
 * WiZ bulbs and plugs (Philips/Signify's Wi-Fi line): JSON over UDP port 38899, no account needed.
 *
 *   discovery  broadcast {"method":"registration","params":{"register":false,…}} → each device answers with its MAC
 *   info       getSystemConfig → { mac, moduleName ("ESP01_SHRGB1C_31", "ESP10_SOCKET_06" …), fwVersion }
 *   state      getPilot        → { state, dimming (10–100), temp, r, g, b, rssi }
 *   command    setPilot { state, dimming }
 *
 * WiZ devices don't push changes without a registration that can't cross NAT reliably, so this
 * driver polls every 5 s (local polling) and right after each command.
 */
import { createSocket, type Socket } from 'node:dgram';
import { newContext } from '../../bus.ts';
import { UNAVAILABLE, type EngineHost, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { Candidate, DriverContext, DriverStatus, FlowContext, FlowStep, LiteDriver, LiteEntry } from '../types.ts';

const POLL_MS = 5000;
const TIMEOUT_MS = 2500;
const DISCOVER_MS = 5 * 60_000;
const FAILS_BEFORE_UNAVAILABLE = 3;

export interface WizOptions {
  /** Device port (38899; tests use another). */
  port?: number;
  /** Where discovery broadcasts go (tests use 127.0.0.1). */
  broadcast?: string;
  /** Poll interval (tests use less). */
  pollMs?: number;
}

interface Pilot {
  state?: boolean;
  dimming?: number;
  mac?: string;
}

interface Bulb {
  entry: LiteEntry;
  entityId: string;
  isPlug: boolean;
  fails: number;
}

const isPlugModel = (model: string) => /SOCKET/i.test(model);
const macOf = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

export class WizDriver implements LiteDriver {
  id = 'wiz';
  name = 'WiZ';
  iotClass = 'local_polling' as const;
  private ctx: DriverContext | null = null;
  private sock: Socket | null = null;
  private port: number;
  private broadcast: string;
  private bulbs = new Map<string, Bulb>(); // entry id → bulb
  private pending = new Map<string, (r: Record<string, any>) => void>(); // `${ip}|${method}` → resolver
  private timers: NodeJS.Timeout[] = [];
  private pollMs: number;

  constructor(opts: WizOptions = {}) {
    this.port = opts.port ?? 38899;
    this.broadcast = opts.broadcast ?? '255.255.255.255';
    this.pollMs = opts.pollMs ?? POLL_MS;
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (err) => ctx.log.warn(`WiZ: ${err.message}`));
    sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
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
    this.bulbs.clear();
  }

  status(): DriverStatus {
    return { state: this.sock ? 'connected' : 'disabled', message: null, entities: this.bulbs.size };
  }

  // ---------- Protocol ----------

  private onMessage(buf: Buffer, ip: string) {
    let m: Record<string, any>;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const key = `${ip}|${m.method}`;
    const resolve = this.pending.get(key);
    if (resolve) {
      this.pending.delete(key);
      resolve(m);
    }
    // Discovery answers come from any device.
    if (m.method === 'registration' && m.result?.mac) {
      const mac = macOf(m.result.mac);
      this.ctx?.candidate({ uniqueId: mac, title: `WiZ device at ${ip}`, context: { host: ip, mac } });
    }
  }

  /** One request/response; resolves null on timeout. */
  request(host: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
      if (!this.sock) return resolve(null);
      const key = `${host}|${method}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(null);
      }, TIMEOUT_MS);
      this.pending.set(key, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.sock.send(JSON.stringify({ method, params }), this.port, host, () => {});
    });
  }

  /** Broadcasts a discovery request; answers become candidates. */
  scan() {
    const msg = JSON.stringify({ method: 'registration', params: { phoneIp: '0.0.0.0', register: false, phoneMac: 'AAAAAAAAAAAA' } });
    this.sock?.send(msg, this.port, this.broadcast, () => {});
  }

  // ---------- Config flow ----------

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => {
      if (ctx.discovered) {
        return { type: 'form', stepId: 'confirm', title: 'Add WiZ device', description: `Add the WiZ device found at ${ctx.discovered.context.host}?`, fields: [] };
      }
      return {
        type: 'form', stepId: 'user', title: 'Add a WiZ device',
        description: 'Enter its IP address (see your router or the WiZ app). Devices on this network also appear under "New devices" by themselves.',
        fields: [{ name: 'host', label: 'IP address', help: null, kind: 'text', required: true }],
      };
    },
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      const host = stepId === 'confirm' ? String(ctx.discovered?.context.host ?? '') : String(input.host ?? '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return { ...(await this.flow.start(ctx)), errors: { host: 'Enter an IPv4 address, e.g. 192.168.1.40' } } as FlowStep;
      }
      const cfg = await this.request(host, 'getSystemConfig');
      if (!cfg?.result?.mac) {
        const form = await this.flow.start(ctx);
        return form.type === 'form' ? { ...form, errors: { base: `No WiZ device answered at ${host}.` } } : form;
      }
      const model = String(cfg.result.moduleName ?? 'WiZ');
      const kind = isPlugModel(model) ? 'plug' : 'light';
      return { type: 'create_entry', title: `WiZ ${kind} ${host}`, uniqueId: macOf(cfg.result.mac), data: { host, mac: macOf(cfg.result.mac), model, fw: cfg.result.fwVersion ?? null } };
    },
  };

  discover(): Candidate | null {
    return null; // WiZ answers our UDP broadcast instead (see onMessage).
  }

  // ---------- Entries → devices ----------

  async entryAdded(entry: LiteEntry) {
    const host = this.ctx!.host;
    const mac = String(entry.data.mac);
    const model = String(entry.data.model ?? 'WiZ');
    const isPlug = isPlugModel(model);
    const dev = host.registerDevice({
      uniqueId: `wiz:${mac}`, name: entry.title, manufacturer: 'WiZ', model, swVersion: entry.data.fw ? String(entry.data.fw) : null,
      config: { entryId: entry.id },
    });
    const e = host.registerEntity({
      uniqueId: `wiz:${mac}`, domain: isPlug ? 'switch' : 'light', name: entry.title, deviceId: dev.id,
    });
    this.bulbs.set(entry.id, { entry, entityId: e.entityId, isPlug, fails: 0 });
    await this.poll(entry.id);
  }

  async entryRemoved(entry: LiteEntry) {
    this.bulbs.delete(entry.id);
  }

  private pollAll() {
    for (const id of this.bulbs.keys()) void this.poll(id);
  }

  private async poll(entryId: string, context = newContext('device')) {
    const b = this.bulbs.get(entryId);
    const host: EngineHost | undefined = this.ctx?.host;
    if (!b || !host) return;
    const r = await this.request(String(b.entry.data.host), 'getPilot');
    if (this.bulbs.get(entryId) !== b) return; // removed while waiting
    const p = r?.result as Pilot | undefined;
    if (!p || typeof p.state !== 'boolean') {
      if (++b.fails >= FAILS_BEFORE_UNAVAILABLE) host.setState(b.entityId, UNAVAILABLE);
      return;
    }
    b.fails = 0;
    const attributes: Record<string, unknown> = {};
    if (!b.isPlug) {
      attributes.supports_brightness = true;
      if (typeof p.dimming === 'number') attributes.brightness = Math.round((p.dimming / 100) * 255);
    }
    host.setState(b.entityId, p.state ? 'on' : 'off', attributes, context);
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const b = [...this.bulbs.values()].find((x) => x.entityId === call.entityId);
    if (!b) return { ok: false, message: 'Unknown WiZ device' };
    const on = call.service === 'toggle' ? !(await this.isOn(b)) : call.service === 'turn_on';
    const params: Record<string, unknown> = { state: on };
    if (on && !b.isPlug && typeof call.data.brightness === 'number') {
      params.dimming = Math.max(10, Math.min(100, Math.round((call.data.brightness / 255) * 100)));
    }
    const r = await this.request(String(b.entry.data.host), 'setPilot', params);
    if (!r?.result?.success) return { ok: false, message: r ? 'The device refused the command' : 'The device did not answer' };
    await this.poll(b.entry.id, newContext('device', call.context));
    return { ok: true };
  }

  private async isOn(b: Bulb) {
    const r = await this.request(String(b.entry.data.host), 'getPilot');
    return r?.result?.state === true;
  }
}
