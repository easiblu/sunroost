/**
 * Shelly relays, plugs, dimmers and covers, locally, no cloud account.
 *
 * - Gen2+/Gen3 (Plus, Pro, Mini …): JSON-RPC with WebSocket push (gen2.ts).
 * - Gen1: HTTP REST, polled (gen1.ts).
 * - Discovery: mDNS `_shelly._tcp` (Gen2+) and `_http._tcp` instances named "shelly…" (Gen1).
 * - Setup: confirm a discovered device, or enter its address; a password is asked for when the
 *   device has one (Gen2 digest auth as user "admin"; Gen1 basic auth).
 * - Device-side off-timer: `auto_off_s` becomes Gen2 `toggle_after` / Gen1 `timer`.
 */
import type { UiField } from '../../full/flows.ts';
import type { ServiceCall, ServiceResult } from '../../types.ts';
import type { Candidate, DriverContext, DriverStatus, FlowContext, FlowStep, Found, LiteDriver, LiteEntry } from '../types.ts';
import type { ShellyDevice, ShellyTimings } from './device.ts';
import { Gen1Device } from './gen1.ts';
import { Gen2Device } from './gen2.ts';
import { normMac, probe, request, ShellyHttpError, type Probe } from './http.ts';

export type ShellyOptions = Partial<ShellyTimings>;

const field = (name: string, label: string, kind: UiField['kind'], required: boolean, extra: Partial<UiField> = {}): UiField => ({
  name, label, help: null, kind, required, ...extra,
});

/** The MAC in a Shelly id: "shellyplus1pm-a8032ab12345" → "a8032ab12345" (Gen1 ids carry only half of it). */
const macFromId = (id: string) => normMac(id.slice(id.lastIndexOf('-') + 1));

export class ShellyDriver implements LiteDriver {
  id = 'shelly';
  name = 'Shelly';
  iotClass = 'local_push' as const;
  mdnsTypes = ['_shelly._tcp.local', '_http._tcp.local'];
  private ctx: DriverContext | null = null;
  private devices = new Map<string, ShellyDevice>(); // entry id → device
  private t: ShellyTimings;

  constructor(opts: ShellyOptions = {}) {
    this.t = { pollMs: 5000, wsRetryMs: 10_000, retryMs: 30_000, timeoutMs: 5000, ...opts };
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
  }

  async stop() {
    for (const d of this.devices.values()) d.stop();
    this.devices.clear();
  }

  status(): DriverStatus {
    return { state: 'connected', message: null, entities: [...this.devices.values()].reduce((n, d) => n + d.channels.length, 0) };
  }

  // ---------- Discovery ----------

  discover(f: Found): Candidate | null {
    if (f.source !== 'mdns') return null;
    const host = f.port && f.port !== 80 ? `${f.ip}:${f.port}` : f.ip;
    let uniqueId: string;
    let title: string;
    if (f.type === '_shelly._tcp.local') {
      const id = f.props.id || f.name;
      uniqueId = macFromId(id);
      title = `Shelly ${f.props.app || id.replace(/^shelly/i, '').replace(/-.*$/, '')} at ${f.ip}`;
    } else if (f.type === '_http._tcp.local' && /^shelly/i.test(f.name)) {
      uniqueId = f.name.toLowerCase();
      title = `Shelly ${f.name.replace(/^shelly/i, '').replace(/-.*$/, '') || 'device'} at ${f.ip}`;
    } else return null;
    // Already set up (Gen1 candidates have no full MAC to compare, so compare addresses too).
    if (this.ctx?.entries().some((e) => e.data.host === host || e.uniqueId === uniqueId || String(e.data.id ?? '').toLowerCase() === f.name.toLowerCase())) return null;
    return { uniqueId, title, context: { host } };
  }

  // ---------- Config flow ----------

  flow = {
    start: async (ctx: FlowContext): Promise<FlowStep> => {
      if (!ctx.discovered) {
        return {
          type: 'form', stepId: 'user', title: 'Add a Shelly device',
          description: 'Enter its IP address (shown in the Shelly app or your router). Shelly devices on this network also appear under "New devices" by themselves.',
          fields: [field('host', 'IP address', 'text', true), field('password', 'Password (if you set one)', 'password', false)],
        };
      }
      const host = String(ctx.discovered.context.host);
      const p = await probe(host, this.t.timeoutMs);
      if (!p) return { type: 'abort', reason: `The Shelly device at ${host} no longer answers.` };
      ctx.state.host = host;
      ctx.state.probe = p;
      return this.confirmForm(p, host);
    },
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      let host = String(ctx.state.host ?? '');
      let p = ctx.state.probe as Probe | undefined;
      if (stepId === 'user') {
        host = String(input.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!host) return { ...(await this.flow.start(ctx)), errors: { host: 'Enter the IP address' } } as FlowStep;
        p = (await probe(host, this.t.timeoutMs)) ?? undefined;
        if (!p) return { ...(await this.flow.start(ctx)), errors: { base: `No Shelly device answered at ${host}.` } } as FlowStep;
        ctx.state.host = host;
        ctx.state.probe = p;
        if (p.auth && !input.password) return { ...this.confirmForm(p, host), errors: { password: 'This device has a password' } };
      }
      if (!p) return { type: 'abort', reason: 'Start again.' };
      const password = String(input.password ?? '');
      const username = String(input.username || 'admin');
      try {
        if (p.gen >= 2) await request(host, '/rpc/Shelly.GetStatus', { body: {}, auth: password ? { kind: 'digest', username: 'admin', password } : null, timeoutMs: this.t.timeoutMs });
        else await request(host, '/settings', { auth: password ? { kind: 'basic', username, password } : null, timeoutMs: this.t.timeoutMs });
      } catch (err) {
        const msg = err instanceof ShellyHttpError && err.status === 401 ? (password ? 'Wrong password' : 'This device has a password') : `The device didn't answer: ${(err as Error).message}`;
        return { ...this.confirmForm(p, host), errors: err instanceof ShellyHttpError && err.status === 401 ? { password: msg } : { base: msg } };
      }
      return {
        type: 'create_entry', title: p.name || `Shelly ${p.model}`, uniqueId: p.mac,
        data: { host, gen: p.gen, mac: p.mac, model: p.model, fw: p.fw, id: p.id, ...(password ? { password } : {}), ...(p.gen === 1 && password ? { username } : {}) },
      };
    },
  };

  private confirmForm(p: Probe, host: string): Extract<FlowStep, { type: 'form' }> {
    const fields: UiField[] = [];
    if (p.auth && p.gen === 1) fields.push(field('username', 'Username', 'text', true, { default: 'admin' }));
    if (p.auth) fields.push(field('password', 'Password', 'password', true));
    return {
      type: 'form', stepId: 'confirm', title: `Add ${p.name || `Shelly ${p.model}`}`,
      description: `Shelly ${p.model} (generation ${p.gen}) at ${host}.${p.auth ? ' It is protected by a password.' : ''}`,
      fields,
    };
  }

  // ---------- Entries → devices ----------

  async entryAdded(entry: LiteEntry) {
    if (!this.ctx) return;
    const dev = Number(entry.data.gen) >= 2 ? new Gen2Device(entry, this.ctx.host, this.t) : new Gen1Device(entry, this.ctx.host, this.t);
    this.devices.set(entry.id, dev);
    await dev.start();
  }

  async entryRemoved(entry: LiteEntry) {
    this.devices.get(entry.id)?.stop();
    this.devices.delete(entry.id);
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const dev = [...this.devices.values()].find((d) => d.owns(call.entityId));
    if (!dev) return { ok: false, message: 'Unknown Shelly device' };
    return dev.callService(call);
  }
}
