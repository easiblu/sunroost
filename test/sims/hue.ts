/**
 * A simulated Hue bridge: link-button pairing, CLIP v2 resources, PUT on lights and a server-sent
 * event stream, over HTTPS with a throwaway self-signed certificate (HTTP when openssl is missing).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Res = Record<string, any>;

export const BRIDGE_ID = '001788fffe123456';
export const KEY = 'sim-application-key-0123456789';

function selfSigned(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), 'huesim-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=001788fffe123456', '-days', '1',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dev = (id: string, name: string, product: string, archetype: string) => ({
  id, type: 'device', metadata: { name, archetype },
  product_data: { manufacturer_name: 'Signify Netherlands B.V.', model_id: 'X', product_name: product, software_version: '1.122.8' },
});
const own = (rid: string) => ({ rid, rtype: 'device' });

export class HueSim {
  scheme: 'https' | 'http' = 'http';
  port = 0;
  linkPressed = false;
  server: http.Server | https.Server | null = null;
  streams = new Set<http.ServerResponse>();
  resources = new Map<string, Res>();
  puts: { id: string; body: Res }[] = [];

  constructor() {
    for (const r of [
      dev('dev-bridge', 'Hue Bridge', 'Hue Bridge', 'bridge_v2'),
      dev('dev-lamp', 'Desk lamp', 'Hue color lamp', 'sultan_bulb'),
      dev('dev-plug', 'Kettle plug', 'Hue smart plug', 'plug'),
      dev('dev-motion', 'Hall sensor', 'Hue motion sensor', 'unknown_archetype'),
      { id: 'light-lamp', type: 'light', owner: own('dev-lamp'), on: { on: false }, dimming: { brightness: 50 }, color_temperature: { mirek: 366 }, metadata: { name: 'Desk lamp', archetype: 'sultan_bulb' } },
      { id: 'light-plug', type: 'light', owner: own('dev-plug'), on: { on: false }, metadata: { name: 'Kettle plug', archetype: 'plug' } },
      { id: 'motion-1', type: 'motion', owner: own('dev-motion'), enabled: true, motion: { motion: false, motion_valid: true } },
      { id: 'temp-1', type: 'temperature', owner: own('dev-motion'), enabled: true, temperature: { temperature: 21.5, temperature_valid: true } },
      { id: 'll-1', type: 'light_level', owner: own('dev-motion'), enabled: true, light: { light_level: 20001, light_level_valid: true } },
      { id: 'zc-lamp', type: 'zigbee_connectivity', owner: own('dev-lamp'), status: 'connected' },
      { id: 'zc-plug', type: 'zigbee_connectivity', owner: own('dev-plug'), status: 'connected' },
      { id: 'zc-motion', type: 'zigbee_connectivity', owner: own('dev-motion'), status: 'connected' },
    ] as Res[]) this.resources.set(r.id, r);
  }

  async start(preferHttps = true): Promise<number> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.handle(req, res);
    const tls = preferHttps ? selfSigned() : null;
    this.scheme = tls ? 'https' : 'http';
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server!.address() as { port: number }).port;
    return this.port;
  }

  async stop() {
    this.dropStreams();
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Sends an event to every open stream. */
  emit(events: Res[]) {
    const text = `id: ${Date.now()}:0\ndata: ${JSON.stringify(events)}\n\n`;
    for (const s of this.streams) s.write(text);
  }

  /** Applies a partial update and announces it, like the bridge does. */
  update(id: string, part: Res) {
    const r = this.resources.get(id)!;
    const merged = { ...r, ...part };
    this.resources.set(id, merged);
    this.emit([{ type: 'update', id: `ev-${Date.now()}`, creationtime: new Date().toISOString(), data: [{ id, type: r.type, owner: r.owner, ...part }] }]);
  }

  dropStreams() {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  private body(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let t = '';
      req.on('data', (c) => (t += c));
      req.on('end', () => {
        try {
          resolve(t ? JSON.parse(t) : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/api/0/config') return json(200, { name: 'Hue Bridge', bridgeid: BRIDGE_ID.toUpperCase(), modelid: 'BSB002' });
    if (req.method === 'POST' && url === '/api') {
      await this.body(req);
      return json(200, this.linkPressed
        ? [{ success: { username: KEY, clientkey: 'ABCDEF' } }]
        : [{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
    }
    if (req.headers['hue-application-key'] !== KEY) return json(403, { errors: [{ description: 'unauthorized user' }], data: [] });
    if (req.method === 'GET' && url === '/eventstream/clip/v2') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': hi\n\n');
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      return;
    }
    const m = /^\/clip\/v2\/resource\/([a-z_]+)(?:\/([\w-]+))?$/.exec(url);
    if (!m) return json(404, { errors: [{ description: 'not found' }], data: [] });
    const [, type, id] = m;
    if (req.method === 'GET') {
      const list = [...this.resources.values()].filter((r) => r.type === type && (!id || r.id === id));
      return json(200, { errors: [], data: list });
    }
    if (req.method === 'PUT' && type === 'light' && id && this.resources.has(id)) {
      const body = await this.body(req);
      this.puts.push({ id, body });
      json(200, { errors: [], data: [{ rid: id, rtype: 'light' }] });
      setTimeout(() => this.update(id, body), 20);
      return;
    }
    return json(405, { errors: [{ description: 'method not available' }], data: [] });
  }
}
