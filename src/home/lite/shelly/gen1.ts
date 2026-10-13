/**
 * Shelly Gen1 (Shelly 1, 1PM, 2.5, Plug S, Dimmer …): HTTP REST, polled every few seconds.
 *
 *   /settings  name, mode ("relay" | "roller"), device.hostname
 *   /status    relays[].ison, meters[].power/total (Wmin), lights[].ison/brightness, rollers[].state/current_pos
 *   /relay/N?turn=on|off|toggle&timer=S   /light/N?turn=…&brightness=1-100   /roller/N?go=open|close|stop|to_pos&roller_pos=P
 */
import type { ServiceCall, ServiceResult } from '../../types.ts';
import { ShellyDevice, round, toByte, toPct, type Channel } from './device.ts';
import { request, type Credentials } from './http.ts';

type Status = Record<string, any>;

export class Gen1Device extends ShellyDevice {
  private status: Status = {};
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;

  private get auth(): Credentials | null {
    return this.entry.data.password
      ? { kind: 'basic', username: String(this.entry.data.username || 'admin'), password: String(this.entry.data.password) }
      : null;
  }

  private get(path: string) {
    return request(this.address, path, { auth: this.auth, timeoutMs: this.t.timeoutMs });
  }

  async start() {
    try {
      await this.setup();
    } catch {
      this.failed();
      if (!this.stopped) this.retry = setTimeout(() => void this.start(), this.t.retryMs);
      return;
    }
    if (!this.stopped) this.timer = setInterval(() => void this.poll(), this.t.pollMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
  }

  private async setup() {
    const [settings, status] = await Promise.all([this.get('/settings'), this.get('/status')]);
    if (this.stopped) return;
    const devName = String(settings?.name || this.entry.title || 'Shelly').trim();
    const deviceId = this.registerDevice(devName, String(this.entry.data.model ?? settings?.device?.type ?? 'Shelly'), settings?.fw ?? (this.entry.data.fw as string) ?? null);
    const roller = settings?.mode === 'roller';
    const label = (n: number, list: unknown[]) => (list.length > 1 ? `${devName} ${n + 1}` : devName);
    const relays: unknown[] = roller ? [] : status.relays ?? [];
    const lights: unknown[] = status.lights ?? [];
    const rollers: unknown[] = roller ? status.rollers ?? [] : [];
    const meters: { power?: number; total?: number }[] = status.meters ?? [];
    relays.forEach((_, i) => this.addChannel(deviceId, 'switch', i, `relays.${i}`, label(i, relays)));
    lights.forEach((_, i) => this.addChannel(deviceId, 'light', i, `lights.${i}`, label(i, lights)));
    rollers.forEach((_, i) => this.addChannel(deviceId, 'cover', i, `rollers.${i}`, label(i, rollers)));
    meters.forEach((m, i) => {
      if (typeof m.power === 'number') this.addChannel(deviceId, 'power', i, `meters.${i}`, `${label(i, meters)} power`);
      if (typeof m.total === 'number') this.addChannel(deviceId, 'energy', i, `meters.${i}`, `${label(i, meters)} energy`);
    });
    this.status = status;
    this.fails = 0;
    this.pushAll();
  }

  private async poll() {
    if (this.stopped) return;
    try {
      const status = await this.get('/status');
      if (this.stopped) return;
      this.status = status;
      this.fails = 0;
      this.pushAll();
    } catch {
      this.failed();
    }
  }

  private pushAll() {
    for (const ch of this.channels) {
      const [list, n] = ch.key.split('.');
      const st = this.status[list]?.[Number(n)];
      if (!st) continue;
      switch (ch.kind) {
        case 'switch':
          this.set(ch, st.ison ? 'on' : 'off', { supports_auto_off: true });
          break;
        case 'light':
          this.set(ch, st.ison ? 'on' : 'off', { supports_brightness: true, brightness: toByte(Number(st.brightness ?? 100)), supports_auto_off: true });
          break;
        case 'cover': {
          const pos = typeof st.current_pos === 'number' ? st.current_pos : null;
          // Gen1 reports the motion ("open" = opening), not the position.
          const state = st.state === 'open' ? 'opening' : st.state === 'close' ? 'closing' : pos === 0 ? 'closed' : 'open';
          this.set(ch, state, pos === null ? {} : { current_position: pos });
          break;
        }
        case 'power':
          if (typeof st.power === 'number') this.set(ch, String(round(st.power)));
          break;
        case 'energy':
          // Watt-minutes.
          if (typeof st.total === 'number') this.set(ch, String(round(st.total / 60_000, 3)));
          break;
      }
    }
  }

  async command(ch: Channel, call: ServiceCall): Promise<ServiceResult> {
    const d = call.data;
    const q = new URLSearchParams();
    if (ch.kind === 'switch' || ch.kind === 'light') {
      q.set('turn', call.service === 'toggle' ? 'toggle' : call.service === 'turn_on' ? 'on' : 'off');
      if (call.service === 'turn_on' && typeof d.auto_off_s === 'number' && d.auto_off_s > 0) q.set('timer', String(Math.round(d.auto_off_s)));
      if (call.service === 'turn_on' && ch.kind === 'light' && typeof d.brightness === 'number') q.set('brightness', String(toPct(d.brightness)));
      await this.get(`/${ch.kind === 'switch' ? 'relay' : 'light'}/${ch.index}?${q}`);
    } else if (ch.kind === 'cover') {
      if (call.service === 'set_cover_position') {
        q.set('go', 'to_pos');
        q.set('roller_pos', String(Math.round(Number(d.position))));
      } else q.set('go', call.service === 'open_cover' ? 'open' : call.service === 'close_cover' ? 'close' : 'stop');
      await this.get(`/roller/${ch.index}?${q}`);
    } else return { ok: false, message: 'This Shelly channel only reports' };
    // No push on Gen1: read the result back now.
    await this.poll();
    return { ok: true };
  }
}
