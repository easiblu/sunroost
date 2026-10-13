/**
 * Simulated TP-Link devices, written from the protocol descriptions independently of the driver's
 * protocol.ts (own XOR and KLAP code), answering like the real firmware:
 * - KasaLegacySim: an HS110-style metering plug or an HS300-style metering power strip (TCP + UDP 9999).
 * - KlapSim: a Tapo P110-style plug speaking KLAP v2 over HTTP.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createSocket, type Socket as Udp } from 'node:dgram';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';

function enc(text: string) {
  const p = Buffer.from(text);
  const o = Buffer.alloc(p.length);
  let k = 171;
  p.forEach((b, i) => {
    k = k ^ b;
    o[i] = k;
  });
  return o;
}
function dec(b: Buffer) {
  const o = Buffer.alloc(b.length);
  let k = 171;
  b.forEach((c, i) => {
    o[i] = k ^ c;
    k = c;
  });
  return o.toString();
}

export interface LegacyOptions {
  kind?: 'plug' | 'strip';
  /** 'new' firmware reports mW/mV/mA/Wh, 'old' W/V/A/kWh. */
  emeter?: 'new' | 'old';
}

export class KasaLegacySim {
  tcp: Server;
  udp: Udp = createSocket('udp4');
  port = 0;
  kind: 'plug' | 'strip';
  emeterFormat: 'new' | 'old';
  deviceId = '8006A1B2C3D4E5F60718293A4B5C6D7E8F901234';
  mac = '50:C7:BF:12:34:56';
  relay = 0;
  children = [
    { id: '00', alias: 'Pool pump', state: 0 },
    { id: '01', alias: 'Geyser', state: 0 },
  ];
  powerW = 1234.5;
  /** count_down rules added, with the outlet they were for. */
  rules: { child: string | null; delay: number; act: number }[] = [];
  silent = false;
  requests: Record<string, unknown>[] = [];

  constructor(opts: LegacyOptions = {}) {
    this.kind = opts.kind ?? 'plug';
    this.emeterFormat = opts.emeter ?? 'new';
    this.tcp = createServer((s) => this.serve(s));
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.tcp.listen(0, '127.0.0.1', () => r()));
    this.port = (this.tcp.address() as { port: number }).port;
    this.udp.on('message', (msg, r) => {
      if (this.silent) return;
      const req = JSON.parse(dec(msg));
      if (req.system?.get_sysinfo) this.udp.send(enc(JSON.stringify({ system: { get_sysinfo: this.sysinfo() } })), r.port, r.address);
    });
    await new Promise<void>((r) => this.udp.bind(this.port, '127.0.0.1', () => r()));
    return this.port;
  }

  stop() {
    this.tcp.close();
    this.udp.close();
  }

  private fullChildId(id: string) {
    return `${this.deviceId}${id}`;
  }

  sysinfo() {
    const base = {
      sw_ver: '1.0.12 Build 210113 Rel.172153', hw_ver: '2.0', model: this.kind === 'strip' ? 'HS300(US)' : 'HS110(EU)',
      deviceId: this.deviceId, alias: this.kind === 'strip' ? 'Garage strip' : 'Kettle plug', mic_type: 'IOT.SMARTPLUGSWITCH',
      feature: 'TIM:ENE', mac: this.mac, rssi: -48, err_code: 0,
    };
    if (this.kind === 'strip') {
      return { ...base, child_num: 2, children: this.children.map((c) => ({ id: this.fullChildId(c.id), state: c.state, alias: c.alias, on_time: 0 })) };
    }
    return { ...base, relay_state: this.relay, on_time: 0, led_off: 0 };
  }

  private realtime() {
    const w = this.kind === 'strip' ? 0 : this.relay ? this.powerW : 0;
    return this.emeterFormat === 'new'
      ? { voltage_mv: 230100, current_ma: Math.round((w / 230.1) * 1000), power_mw: Math.round(w * 1000), total_wh: 5432, err_code: 0 }
      : { voltage: 230.1, current: w / 230.1, power: w, total: 5.432, err_code: 0 };
  }

  private handle(req: Record<string, any>): Record<string, any> {
    this.requests.push(req);
    const childIds: string[] | null = req.context?.child_ids ?? null;
    const out: Record<string, any> = {};
    if (req.system?.get_sysinfo) out.system = { get_sysinfo: this.sysinfo() };
    if (req.system?.set_relay_state) {
      const st = req.system.set_relay_state.state;
      if (childIds) for (const c of this.children) if (childIds.includes(this.fullChildId(c.id))) c.state = st;
      if (!childIds) this.relay = st;
      out.system = { set_relay_state: { err_code: 0 } };
    }
    if (req.emeter?.get_realtime) {
      if (childIds) {
        const c = this.children.find((x) => childIds.includes(this.fullChildId(x.id)));
        const w = c?.state ? (c.id === '00' ? 750 : 2000) : 0;
        out.emeter = { get_realtime: { voltage_mv: 230000, current_ma: Math.round(w / 0.23), power_mw: w * 1000, total_wh: 100, err_code: 0 } };
      } else out.emeter = { get_realtime: this.realtime() };
    }
    if (req.count_down?.delete_all_rules) {
      this.rules = this.rules.filter((r) => r.child !== (childIds?.[0] ?? null));
      out.count_down = { delete_all_rules: { err_code: 0 } };
    }
    if (req.count_down?.add_rule) {
      this.rules.push({ child: childIds?.[0] ?? null, delay: req.count_down.add_rule.delay, act: req.count_down.add_rule.act });
      out.count_down = { add_rule: { id: 'ABC', err_code: 0 } };
    }
    return out;
  }

  private serve(s: Socket) {
    let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', (d) => {
      if (this.silent) return void s.destroy();
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      const req = JSON.parse(dec(buf.subarray(4, 4 + buf.readUInt32BE(0))));
      const payload = enc(JSON.stringify(this.handle(req)));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(payload.length);
      s.end(Buffer.concat([len, payload]));
    });
  }
}

const sha256 = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const sha1 = (s: string) => createHash('sha1').update(s).digest();

export class KlapSim {
  http: HttpServer;
  port = 0;
  username: string;
  password: string;
  on = false;
  powerMw = 0;
  countdowns: Record<string, unknown>[] = [];
  private sessions = new Map<string, { local: Buffer; remote: Buffer; ok: boolean }>();

  constructor(username = 'owner@example.com', password = 'correct horse') {
    this.username = username;
    this.password = password;
    this.http = createHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.route(req.url ?? '', req.headers.cookie ?? '', Buffer.concat(chunks), res));
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', () => r()));
    this.port = (this.http.address() as { port: number }).port;
    return this.port;
  }

  stop() {
    this.http.close();
    this.http.closeAllConnections();
  }

  private auth() {
    return sha256(sha1(this.username), sha1(this.password));
  }

  private route(url: string, cookie: string, body: Buffer, res: import('node:http').ServerResponse) {
    const sid = /TP_SESSIONID=([^;]+)/.exec(cookie)?.[1];
    if (url === '/app/handshake1') {
      const remote = randomBytes(16);
      const id = randomBytes(8).toString('hex');
      this.sessions.set(id, { local: body, remote, ok: false });
      res.writeHead(200, { 'set-cookie': `TP_SESSIONID=${id};TIMEOUT=86400` });
      return res.end(Buffer.concat([remote, sha256(body, remote, this.auth())]));
    }
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s) {
      res.writeHead(403);
      return res.end();
    }
    if (url === '/app/handshake2') {
      s.ok = sha256(s.remote, s.local, this.auth()).equals(body);
      res.writeHead(s.ok ? 200 : 403);
      return res.end();
    }
    const m = /^\/app\/request\?seq=(-?\d+)$/.exec(url);
    if (!m || !s.ok) {
      res.writeHead(403);
      return res.end();
    }
    const seq = Number(m[1]);
    const a = this.auth();
    const ivFull = sha256(Buffer.from('iv'), s.local, s.remote, a);
    const key = sha256(Buffer.from('lsk'), s.local, s.remote, a).subarray(0, 16);
    const sig = sha256(Buffer.from('ldk'), s.local, s.remote, a).subarray(0, 28);
    const sb = Buffer.alloc(4);
    sb.writeInt32BE(seq);
    const iv = Buffer.concat([ivFull.subarray(0, 12), sb]);
    const ct = body.subarray(32);
    if (!sha256(sig, sb, ct).equals(body.subarray(0, 32))) {
      res.writeHead(400);
      return res.end();
    }
    const d = createDecipheriv('aes-128-cbc', key, iv);
    const req = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString());
    const reply = this.handle(req.method, req.params);
    const c = createCipheriv('aes-128-cbc', key, iv);
    const out = Buffer.concat([c.update(JSON.stringify(reply)), c.final()]);
    res.writeHead(200);
    res.end(Buffer.concat([sha256(sig, sb, out), out]));
  }

  private handle(method: string, params: Record<string, any> | null) {
    switch (method) {
      case 'get_device_info':
        return {
          error_code: 0,
          result: {
            device_id: 'TAPO123', model: 'P110', type: 'SMART.TAPOPLUG', mac: 'B0-A7-B9-01-02-03', device_on: this.on,
            nickname: Buffer.from('Washing machine').toString('base64'), fw_ver: '1.3.0',
          },
        };
      case 'get_energy_usage':
        return { error_code: 0, result: { today_runtime: 12, month_runtime: 300, today_energy: 1530, month_energy: 20000, current_power: this.on ? this.powerMw : 0 } };
      case 'set_device_info':
        this.on = params?.device_on === true;
        return { error_code: 0 };
      case 'add_countdown_rule':
        this.countdowns.push(params ?? {});
        return { error_code: 0 };
      default:
        return { error_code: -1 };
    }
  }
}
