/**
 * Simulated Tasmota devices on a real MQTT broker: native discovery (retained config + sensors),
 * LWT, and answers to POWER, Dimmer, PulseTime, STATE and STATUS 10 like the firmware.
 */
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { connectAsync, type MqttClient } from 'mqtt';

const createBroker = createRequire(import.meta.url)('aedes') as typeof import('aedes').createBroker;

/** An aedes broker on an ephemeral port. */
export async function startBroker(): Promise<{ url: string; close(): Promise<void> }> {
  const broker = createBroker();
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    broker.handle(sock);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        broker.close(() => server.close(() => r()));
      }),
  };
}

export interface SimOptions {
  mac: string;
  topic: string;
  name: string;
  /** rl: 1 relay, 2 light. */
  relays: number[];
  lightType?: number;
  energy?: boolean;
  friendly?: (string | null)[];
}

export class TasmotaSim {
  client!: MqttClient;
  o: SimOptions;
  power: boolean[];
  dimmer = 100;
  pulse: number[] = [];
  /** Watts drawn per relay when on (energy devices). */
  load = 1500;

  constructor(o: SimOptions) {
    this.o = o;
    this.power = o.relays.map(() => false);
  }

  private t(prefix: string, cmd: string) {
    return `${prefix}/${this.o.topic}/${cmd}`;
  }

  private count() {
    return this.o.relays.filter((r) => r === 1 || r === 2).length;
  }

  private key(i: number) {
    return this.count() === 1 ? 'POWER' : `POWER${i + 1}`;
  }

  config() {
    const rl = [...this.o.relays, ...Array(8 - this.o.relays.length).fill(0)];
    return {
      ip: '192.168.1.50', dn: this.o.name, fn: this.o.friendly ?? [this.o.name, null, null, null, null, null, null, null],
      hn: `${this.o.topic}-1234`, mac: this.o.mac, md: 'Sonoff Pow R2', ty: 0, if: 0, ofln: 'Offline', onln: 'Online',
      state: ['OFF', 'ON', 'TOGGLE', 'HOLD'], sw: '14.3.0', t: this.o.topic, ft: '%prefix%/%topic%/', tp: ['cmnd', 'stat', 'tele'],
      rl, swc: Array(8).fill(-1), swn: Array(8).fill(null), btn: Array(8).fill(0),
      so: { '4': 0, '11': 0, '13': 0, '17': 0, '20': 0, '30': 0, '68': 0, '73': 0, '82': 0, '114': 0, '117': 0 },
      lk: 0, lt_st: this.o.lightType ?? 0, sho: [0, 0, 0, 0], sht: [], ver: 1,
    };
  }

  energy() {
    const w = this.power.some(Boolean) ? this.load : 0;
    return { TotalStartTime: '2026-01-01T00:00:00', Total: 12.345, Yesterday: 1.2, Today: 0.5, Power: w, ApparentPower: w, ReactivePower: 0, Factor: w ? 1 : 0, Voltage: 231, Current: Math.round((w / 231) * 1000) / 1000 };
  }

  sensors() {
    return this.o.energy ? { Time: '2026-10-13T12:00:00', ENERGY: this.energy() } : { Time: '2026-10-13T12:00:00', AM2301: { Temperature: 22.4, Humidity: 48 }, TempUnit: 'C' };
  }

  async start(url: string) {
    this.client = await connectAsync(url, {
      clientId: `DVES_${this.o.mac.slice(-6)}`,
      will: { topic: this.t('tele', 'LWT'), payload: Buffer.from('Offline'), qos: 1, retain: true },
    });
    this.client.on('message', (topic, payload) => this.onCommand(topic, payload.toString()));
    await this.client.subscribeAsync(`cmnd/${this.o.topic}/#`);
    await this.client.publishAsync(this.t('tele', 'LWT'), 'Online', { retain: true });
    await this.announce();
  }

  async announce() {
    await this.client.publishAsync(`tasmota/discovery/${this.o.mac}/config`, JSON.stringify(this.config()), { retain: true });
    await this.client.publishAsync(`tasmota/discovery/${this.o.mac}/sensors`, JSON.stringify({ sn: this.sensors(), ver: 1 }), { retain: true });
  }

  /** Clean shutdown publishes Offline; `crash` drops the connection so the broker sends the will. */
  async stop(crash = false) {
    if (crash) {
      // Drop the socket (the broker then publishes the will), and stop the client reconnecting.
      (this.client as unknown as { stream: { destroy(): void } }).stream.destroy();
      this.client.end(true);
    } else await this.client.endAsync();
  }

  async removeDiscovery() {
    await this.client.publishAsync(`tasmota/discovery/${this.o.mac}/config`, '', { retain: true });
    await this.client.publishAsync(`tasmota/discovery/${this.o.mac}/sensors`, '', { retain: true });
  }

  private stateJson() {
    const s: Record<string, unknown> = { Time: '2026-10-13T12:00:00', Uptime: '0T01:00:00' };
    this.power.forEach((p, i) => (s[this.key(i)] = p ? 'ON' : 'OFF'));
    if (this.o.lightType) s.Dimmer = this.dimmer;
    return s;
  }

  private pub(topic: string, payload: unknown) {
    this.client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  private onCommand(topic: string, payload: string) {
    const cmd = topic.split('/').pop()!;
    const m = /^POWER(\d*)$/i.exec(cmd);
    if (m) {
      const i = (Number(m[1]) || 1) - 1;
      if (i >= this.power.length) return;
      const p = payload.toUpperCase();
      if (p === '') return this.pub(this.t('stat', 'RESULT'), { [this.key(i)]: this.power[i] ? 'ON' : 'OFF' });
      this.power[i] = p === 'TOGGLE' ? !this.power[i] : p === 'ON' || p === '1';
      this.pub(this.t('stat', 'RESULT'), { [this.key(i)]: this.power[i] ? 'ON' : 'OFF' });
      this.pub(this.t('stat', this.key(i)), this.power[i] ? 'ON' : 'OFF');
      if (this.o.energy) this.pub(this.t('tele', 'SENSOR'), { Time: '2026-10-13T12:00:01', ENERGY: this.energy() });
      return;
    }
    const pt = /^PulseTime(\d+)$/i.exec(cmd);
    if (pt) {
      this.pulse[Number(pt[1]) - 1] = Number(payload);
      return this.pub(this.t('stat', 'RESULT'), { [`PulseTime${pt[1]}`]: { Set: Number(payload), Remaining: 0 } });
    }
    if (/^Dimmer\d*$/i.test(cmd)) {
      this.dimmer = Number(payload);
      const li = this.o.relays.indexOf(2);
      if (li >= 0) this.power[li] = this.dimmer > 0;
      return this.pub(this.t('stat', 'RESULT'), { [this.key(li)]: this.power[li] ? 'ON' : 'OFF', Dimmer: this.dimmer });
    }
    if (cmd === 'STATE') return this.pub(this.t('tele', 'STATE'), this.stateJson());
    if (cmd === 'STATUS' && payload === '10') return this.pub(this.t('stat', 'STATUS10'), { StatusSNS: this.sensors() });
  }
}
