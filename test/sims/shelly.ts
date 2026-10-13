/**
 * Simulated Shelly devices for tests, answering like the real firmware:
 * - Gen2: HTTP `/shelly`, `/rpc/<Method>` (digest auth when a password is set) and a WebSocket
 *   `/rpc` (in-band digest auth, NotifyStatus after each change).
 * - Gen1: HTTP `/shelly`, `/settings`, `/status`, `/relay/N` (basic auth when a password is set).
 */
import { createHash, randomBytes } from 'node:crypto';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function params(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^\s*Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

export class Gen2Sim {
  app = Fastify();
  port = 0;
  id: string;
  name: string;
  password: string | null;
  sw = { id: 0, source: 'init', output: false, apower: 0, voltage: 231.2, aenergy: { total: 1234.5 }, temperature: { tC: 41.2 } };
  lastToggleAfter: number | null = null;
  wsAuthed = false;
  calls: string[] = [];
  private nonce = String(Math.floor(Date.now() / 1000));
  private clients = new Set<{ send(t: string): void; close(): void }>();

  constructor(opts: { mac?: string; name?: string; password?: string | null } = {}) {
    const mac = (opts.mac ?? 'A8032AB12345').toLowerCase();
    this.id = `shellyplus1pm-${mac}`;
    this.name = opts.name ?? 'Pool pump';
    this.password = opts.password ?? null;
  }

  status() {
    return { sys: { mac: this.id.split('-')[1].toUpperCase() }, 'switch:0': this.sw };
  }

  private rpc(method: string, p: Record<string, any>): unknown {
    this.calls.push(method);
    switch (method) {
      case 'Shelly.GetStatus':
        return this.status();
      case 'Shelly.GetConfig':
        return { 'switch:0': { id: 0, name: null } };
      case 'Switch.Set': {
        const was = this.sw.output;
        this.lastToggleAfter = p.toggle_after ?? null;
        this.setOutput(Boolean(p.on));
        return { was_on: was };
      }
      case 'Switch.Toggle': {
        const was = this.sw.output;
        this.setOutput(!was);
        return { was_on: was };
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  setOutput(on: boolean) {
    this.sw.output = on;
    this.sw.apower = on ? 1480.5 : 0;
    const msg = JSON.stringify({ src: this.id, dst: 'solar', method: 'NotifyStatus', params: { ts: Date.now() / 1000, 'switch:0': { id: 0, output: on, apower: this.sw.apower } } });
    for (const c of this.clients) c.send(msg);
  }

  /** Checks an HTTP digest Authorization header. */
  private httpAuthOk(req: FastifyRequest) {
    const h = req.headers.authorization;
    if (!h) return false;
    const a = params(h);
    const ha1 = sha256(`admin:${this.id}:${this.password}`);
    const ha2 = sha256(`${req.method}:${a.uri}`);
    return a.response === sha256(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`);
  }

  private wsAuthOk(auth: Record<string, any> | undefined) {
    if (!auth) return false;
    const ha1 = sha256(`admin:${this.id}:${this.password}`);
    const ha2 = sha256('dummy_method:dummy_uri');
    return auth.response === sha256(`${ha1}:${auth.nonce}:1:${auth.cnonce}:auth:${ha2}`);
  }

  async start() {
    const app = this.app;
    await app.register(fastifyWebsocket);
    app.get('/shelly', async () => ({
      name: this.name, id: this.id, mac: this.id.split('-')[1].toUpperCase(), slot: 0, model: 'SNSW-001P16EU', gen: 2,
      fw_id: '20240819-074343/1.4.2-gc2639da', ver: '1.4.2', app: 'Plus1PM', auth_en: !!this.password, auth_domain: this.password ? this.id : null,
    }));
    const handler = async (req: FastifyRequest<{ Params: { method: string } }>, reply: FastifyReply) => {
      if (this.password && !this.httpAuthOk(req)) {
        reply.header('www-authenticate', `Digest qop="auth", realm="${this.id}", nonce="${this.nonce}", algorithm=SHA-256`);
        return reply.code(401).send({ code: 401, message: 'Unauthorized' });
      }
      try {
        return this.rpc(req.params.method, (req.body as Record<string, any>) ?? (req.query as Record<string, any>) ?? {});
      } catch (err) {
        return reply.code(500).send({ code: -114, message: (err as Error).message });
      }
    };
    app.post('/rpc/:method', handler);
    app.get('/rpc/:method', handler);
    app.register(async (scope) => {
      scope.get('/rpc', { websocket: true }, (socket) => {
        socket.on('message', (raw: Buffer) => {
          const m = JSON.parse(raw.toString());
          const reply = (body: Record<string, unknown>) => socket.send(JSON.stringify({ id: m.id, src: this.id, dst: m.src, ...body }));
          if (this.password && !this.wsAuthOk(m.auth)) {
            return reply({ error: { code: 401, message: JSON.stringify({ auth_type: 'digest', nonce: Number(this.nonce), nc: 1, realm: this.id, algorithm: 'SHA-256' }) } });
          }
          if (this.password) this.wsAuthed = true;
          this.clients.add(socket);
          socket.on('close', () => this.clients.delete(socket));
          try {
            reply({ result: this.rpc(m.method, m.params ?? {}) });
          } catch (err) {
            reply({ error: { code: -114, message: (err as Error).message } });
          }
        });
      });
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    this.port = (app.server.address() as { port: number }).port;
    return this.port;
  }

  /** Drops WebSocket clients (the device restarted, Wi-Fi blip …). */
  dropClients() {
    for (const c of this.clients) c.close();
    this.clients.clear();
  }

  async stop() {
    this.dropClients();
    await this.app.close();
  }
}

export class Gen1Sim {
  app = Fastify();
  port = 0;
  password: string | null;
  relay = { ison: false, has_timer: false, timer_duration: 0, source: 'http' };
  meter = { power: 0, total: 61_234, is_valid: true };
  lastTimer: number | null = null;
  /** Stop answering (device unplugged): requests hang until the client times out. */
  silent = false;

  constructor(opts: { password?: string | null } = {}) {
    this.password = opts.password ?? null;
  }

  async start() {
    const app = this.app;
    const mac = 'A4CF12F45678';
    app.addHook('onRequest', async (req, reply) => {
      if (this.silent) await new Promise((r) => setTimeout(r, 2000));
      if (req.url === '/shelly' || !this.password) return;
      const ok = req.headers.authorization === `Basic ${Buffer.from(`admin:${this.password}`).toString('base64')}`;
      if (!ok) return reply.code(401).send('401 Unauthorized');
    });
    app.get('/shelly', async () => ({ type: 'SHSW-PM', mac, auth: !!this.password, fw: '20230913-112003/v1.14.0-gcb84623', discoverable: true, num_outputs: 1, num_meters: 1 }));
    app.get('/settings', async () => ({
      device: { type: 'SHSW-PM', mac, hostname: 'shelly1pm-F45678', num_outputs: 1, num_meters: 1 }, name: 'Garage', mode: 'relay',
      fw: '20230913-112003/v1.14.0-gcb84623',
    }));
    app.get('/status', async () => ({ relays: [this.relay], meters: [this.meter], temperature: 44.1, uptime: 1234 }));
    app.get<{ Params: { n: string }; Querystring: { turn?: string; timer?: string } }>('/relay/:n', async (req) => {
      const t = req.query.turn;
      this.relay.ison = t === 'toggle' ? !this.relay.ison : t === 'on' ? true : t === 'off' ? false : this.relay.ison;
      this.lastTimer = req.query.timer ? Number(req.query.timer) : null;
      this.relay.has_timer = !!this.lastTimer;
      this.relay.timer_duration = this.lastTimer ?? 0;
      this.meter.power = this.relay.ison ? 2003.4 : 0;
      return this.relay;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    this.port = (app.server.address() as { port: number }).port;
    return this.port;
  }

  async stop() {
    await this.app.close();
  }
}

export const randomMac = () => randomBytes(6).toString('hex').toUpperCase();
