/**
 * Shelly Gen2+/Gen3 (Plus, Pro, Mini …): JSON-RPC. Commands go over HTTP (`POST /rpc/<Method>`);
 * state arrives over the WebSocket (`ws://<ip>/rpc`) as NotifyStatus (changes only) and
 * NotifyFullStatus, after Sunroost has sent one request so the device knows where to notify.
 * While the WebSocket is down, Sunroost polls Shelly.GetStatus instead.
 */
import { randomBytes } from 'node:crypto';
import type { ServiceCall, ServiceResult } from '../../types.ts';
import { ShellyDevice, round, toByte, toPct, type Channel } from './device.ts';
import { request, wsAuth, type Credentials } from './http.ts';

type Status = Record<string, any>;

export class Gen2Device extends ShellyDevice {
  private status: Status = {};
  private ws: WebSocket | null = null;
  private wsUp = false;
  private timers: NodeJS.Timeout[] = [];
  private retry: NodeJS.Timeout | null = null;
  private src = `solar-${randomBytes(3).toString('hex')}`;
  private nextId = 1;

  private get auth(): Credentials | null {
    return this.entry.data.password ? { kind: 'digest', username: 'admin', password: String(this.entry.data.password) } : null;
  }

  rpc(method: string, params?: Record<string, unknown>) {
    return request(this.address, `/rpc/${method}`, { body: params ?? {}, auth: this.auth, timeoutMs: this.t.timeoutMs });
  }

  async start() {
    try {
      await this.setup();
    } catch {
      this.failed();
      if (!this.stopped) this.retry = setTimeout(() => void this.start(), this.t.retryMs);
      return;
    }
    if (this.stopped) return;
    this.connectWs();
    // Polling covers the gaps while the WebSocket is down, and a slow resync while it is up.
    this.timers.push(setInterval(() => void this.poll(), this.t.pollMs));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }

  private async setup() {
    const [info, config, status] = await Promise.all([
      request(this.address, '/shelly', { timeoutMs: this.t.timeoutMs }),
      this.rpc('Shelly.GetConfig').catch(() => ({})),
      this.rpc('Shelly.GetStatus'),
    ]);
    if (this.stopped) return;
    const devName = String(info.name || this.entry.title || `Shelly ${info.model ?? ''}`).trim();
    const deviceId = this.registerDevice(devName, String(info.model ?? info.app ?? 'Shelly'), info.ver ?? info.fw_id ?? null);
    const keys = Object.keys(status).filter((k) => /^(switch|light|cover|pm1|em1?|temperature):\d+$/.test(k)).sort();
    const count = (type: string) => keys.filter((k) => k.startsWith(`${type}:`)).length;
    for (const key of keys) {
      const [type, n] = key.split(':');
      const index = Number(n);
      const own = config?.[key]?.name;
      const label = own ? String(own) : count(type) > 1 ? `${devName} ${index + 1}` : devName;
      const st = status[key];
      if (type === 'switch' || type === 'light' || type === 'cover') this.addChannel(deviceId, type, index, key, label);
      if (type === 'temperature') this.addChannel(deviceId, 'temperature', index, key, `${label} temperature`);
      if (typeof st?.apower === 'number' || type === 'pm1' || type === 'em') this.addChannel(deviceId, 'power', index, key, `${label} power`);
      if (typeof st?.aenergy?.total === 'number') this.addChannel(deviceId, 'energy', index, key, `${label} energy`);
    }
    this.status = status;
    this.fails = 0;
    this.pushAll();
  }

  private async poll() {
    if (this.wsUp || this.stopped) return;
    try {
      const status = await this.rpc('Shelly.GetStatus');
      if (this.stopped) return;
      this.status = status;
      this.fails = 0;
      this.pushAll();
    } catch {
      this.failed();
    }
  }

  // ---------- WebSocket ----------

  private connectWs() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.address}/rpc`);
    } catch {
      return this.scheduleWs();
    }
    this.ws = ws;
    ws.onopen = () => this.send({ method: 'Shelly.GetStatus' });
    ws.onmessage = (ev) => this.onWs(String(ev.data));
    ws.onclose = () => {
      this.wsUp = false;
      if (this.ws === ws) this.ws = null;
      this.scheduleWs();
    };
    ws.onerror = () => {};
  }

  private scheduleWs() {
    if (!this.stopped) setTimeout(() => this.connectWs(), this.t.wsRetryMs).unref();
  }

  private send(msg: Record<string, unknown>) {
    this.ws?.send(JSON.stringify({ id: this.nextId++, src: this.src, ...msg }));
  }

  private onWs(text: string) {
    let m: Record<string, any>;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    // Password needed: answer the challenge in-band and ask again.
    if (m.error?.code === 401 && this.entry.data.password) {
      try {
        const ch = JSON.parse(m.error.message);
        this.send({ method: 'Shelly.GetStatus', auth: wsAuth(ch, String(this.entry.data.password)) });
      } catch {}
      return;
    }
    if (m.result && typeof m.result === 'object' && m.id) {
      this.wsUp = true;
      this.fails = 0;
      this.status = m.result;
      this.pushAll();
      return;
    }
    if (m.method === 'NotifyFullStatus' && m.params) {
      this.status = m.params;
      this.pushAll();
    } else if (m.method === 'NotifyStatus' && m.params) {
      for (const [k, v] of Object.entries(m.params as Record<string, unknown>)) {
        if (k === 'ts' || !v || typeof v !== 'object') continue;
        this.status[k] = merge(this.status[k] ?? {}, v as Record<string, unknown>);
        for (const ch of this.channels.filter((c) => c.key === k)) this.push(ch);
      }
    }
  }

  // ---------- States ----------

  private pushAll() {
    for (const ch of this.channels) this.push(ch);
  }

  private push(ch: Channel) {
    const st = this.status[ch.key];
    if (!st) return;
    switch (ch.kind) {
      case 'switch':
        return this.set(ch, st.output ? 'on' : 'off', { supports_auto_off: true });
      case 'light':
        return this.set(ch, st.output ? 'on' : 'off', { supports_brightness: true, brightness: toByte(Number(st.brightness ?? 100)), supports_auto_off: true });
      case 'cover': {
        const pos = typeof st.current_pos === 'number' ? st.current_pos : null;
        const state = st.state === 'opening' || st.state === 'closing' ? st.state
          : st.state === 'closed' || pos === 0 ? 'closed' : 'open';
        return this.set(ch, state, pos === null ? {} : { current_position: pos });
      }
      case 'power': {
        const w = st.apower ?? st.total_act_power ?? st.act_power;
        if (typeof w === 'number') this.set(ch, String(round(w)));
        return;
      }
      case 'energy':
        if (typeof st.aenergy?.total === 'number') this.set(ch, String(round(st.aenergy.total / 1000, 3)));
        return;
      case 'temperature':
        if (typeof st.tC === 'number') this.set(ch, String(round(st.tC)));
        return;
    }
  }

  // ---------- Commands ----------

  async command(ch: Channel, call: ServiceCall): Promise<ServiceResult> {
    const id = ch.index;
    const d = call.data;
    const timer = typeof d.auto_off_s === 'number' && d.auto_off_s > 0 ? { toggle_after: d.auto_off_s } : {};
    if (ch.kind === 'switch' || ch.kind === 'light') {
      const type = ch.kind === 'switch' ? 'Switch' : 'Light';
      if (call.service === 'toggle') await this.rpc(`${type}.Toggle`, { id });
      else {
        const on = call.service === 'turn_on';
        const params: Record<string, unknown> = { id, on, ...(on ? timer : {}) };
        if (on && ch.kind === 'light' && typeof d.brightness === 'number') params.brightness = toPct(d.brightness);
        await this.rpc(`${type}.Set`, params);
      }
    } else if (ch.kind === 'cover') {
      if (call.service === 'open_cover') await this.rpc('Cover.Open', { id });
      else if (call.service === 'close_cover') await this.rpc('Cover.Close', { id });
      else if (call.service === 'stop_cover') await this.rpc('Cover.Stop', { id });
      else if (call.service === 'set_cover_position') await this.rpc('Cover.GoToPosition', { id, pos: Math.round(Number(d.position)) });
      else return { ok: false, message: `Shelly covers can't ${call.service}` };
    } else return { ok: false, message: 'This Shelly channel only reports' };
    // Without the WebSocket, read the result back now.
    if (!this.wsUp) await this.poll();
    return { ok: true };
  }
}

function merge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
}
