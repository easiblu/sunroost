/**
 * HTTP + WebSocket server. Serves the single-page UI from public/, vendor libraries from
 * node_modules, and every module in src/web/api/ (each exports `register(app)`).
 * The WebSocket at /ws pushes live state snapshots, log lines and setting changes.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { log } from '../core/log.ts';
import { state } from '../core/state.ts';
import { devices } from '../devices/manager.ts';
import { httpsDomain } from '../remote/domain/index.ts';
import { isAuthenticated, isBlocked, requireAuth } from './auth.ts';

const root = join(import.meta.dirname, '..', '..');
/** Vendor packages are served straight from node_modules (some don't export package.json). */
const pkgDir = (name: string) => join(root, 'node_modules', name);

export type App = FastifyInstance;

/** Broadcasts a message to every connected UI. */
export let broadcast: (msg: unknown) => void = () => {};

export async function startServer(host: string, port: number): Promise<App> {
  // Forwarded headers are trusted only from this machine (cloudflared, or a local reverse proxy),
  // so req.ip / req.protocol reflect the real client behind the tunnel.
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 * 1024, trustProxy: ['127.0.0.1', '::1'] });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: join(root, 'public') });
  await app.register(fastifyStatic, { root: join(pkgDir('uplot'), 'dist'), prefix: '/vendor/uplot/', decorateReply: false });
  await app.register(fastifyStatic, { root: pkgDir('htm'), prefix: '/vendor/htm/', decorateReply: false });
  await app.register(fastifyStatic, { root: join(pkgDir('@fontsource/exo'), 'files'), prefix: '/vendor/exo/', decorateReply: false });
  await app.register(fastifyStatic, { root: join(pkgDir('@fontsource-variable/inter'), 'files'), prefix: '/vendor/inter/', decorateReply: false });
  await app.register(fastifyStatic, { root: join(pkgDir('lucide-static'), 'icons'), prefix: '/vendor/lucide/', decorateReply: false, maxAge: '7d' });

  // Addresses banned for repeated failed sign-ins get nothing (LAN addresses are exempt, see auth.ts).
  app.addHook('onRequest', async (req, reply) => {
    if (isBlocked(req.ip)) return reply.code(403).send({ error: 'Blocked after too many failed sign-ins. Try again tomorrow.' });
  });

  // Own-domain mode: plain-HTTP visits to the domain go to HTTPS once a certificate is live.
  // ACME HTTP-01 challenges must stay on plain HTTP.
  app.addHook('onRequest', async (req, reply) => {
    const domain = httpsDomain();
    if (!domain || req.protocol !== 'http' || req.url.startsWith('/.well-known/acme-challenge/')) return;
    if (req.hostname.replace(/:\d+$/, '').toLowerCase() !== domain) return;
    return reply.redirect(`https://${domain}${req.url}`, 301);
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
  });

  // Reject cross-site state changes and WebSocket upgrades (defence in depth on top of SameSite cookies).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
    if (origin && (unsafe || req.url.startsWith('/ws'))) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== req.headers.host) return reply.code(403).send({ error: 'Cross-origin request blocked' });
    }
  });

  // Everything under /api except /api/auth/* requires a session when a password is set.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/auth/')) return requireAuth(req, reply);
  });

  const apiDir = join(import.meta.dirname, 'api');
  for (const file of readdirSync(apiDir).filter((f) => f.endsWith('.ts')).sort()) {
    const mod = await import(join(apiDir, file));
    if (typeof mod.register === 'function') await mod.register(app);
  }

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!isAuthenticated(req)) {
      socket.close(4401, 'Sign in required');
      return;
    }
    socket.send(JSON.stringify({ type: 'snapshot', data: state.snapshot() }));
  });

  broadcast = (msg) => {
    const text = JSON.stringify(msg);
    for (const client of app.websocketServer.clients) if (client.readyState === 1) client.send(text);
  };
  state.on('refresh', (snap) => broadcast({ type: 'snapshot', data: snap }));
  log.on('line', (line) => broadcast({ type: 'log', line }));
  devices.on('settings', (index, values) => broadcast({ type: 'settings', index, values }));

  // Client-side routing: unknown non-API paths get the app shell (a dot in the query, e.g. an entity id, is fine).
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.split('?')[0].includes('.')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  await app.listen({ host, port });
  return app;
}
