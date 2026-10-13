/**
 * Remote access API: configure the public domain (own domain, Cloudflare Tunnel or own proxy),
 * dynamic DNS, and test reachability.
 */
import { logger } from '../../core/log.ts';
import { settings } from '../../core/settings.ts';
import { DDNS_PROVIDERS, duckSubdomain, type DdnsProvider } from '../../remote/domain/ddns.ts';
import { isTunnelToken, localPort, normalizeDomain, retryDomain, status } from '../../remote/index.ts';
import { INSTANCE, testReachability } from '../../remote/reach.ts';
import type { App } from '../server.ts';

const log = logger('remote');
const MODES = ['off', 'domain', 'cloudflare', 'proxy'] as const;
type Mode = (typeof MODES)[number];

const view = () => ({ ...status(), localPort: localPort(), httpsPort: settings.get('remote.https_port'), upnp: settings.get('remote.upnp'), acmeEmail: settings.get('remote.acme_email'), ddnsTokenSet: Boolean(settings.get('remote.ddns_token')) });

export async function register(app: App) {
  app.get('/api/remote', async () => view());

  app.post<{ Body: { mode: Mode; domain?: string; token?: string; acmeEmail?: string } }>(
    '/api/remote',
    async (req, reply) => {
      const { mode, token, acmeEmail } = req.body ?? ({} as never);
      if (!MODES.includes(mode)) return reply.code(400).send({ error: 'Invalid mode' });
      const domain = req.body.domain === undefined ? settings.get('remote.domain') : normalizeDomain(req.body.domain);
      if (mode !== 'off') {
        if (!settings.get('auth.password_hash')) {
          return reply.code(409).send({ error: 'Set a local password first. Anyone who can reach the domain could otherwise change inverter settings.' });
        }
        if (!domain) return reply.code(400).send({ error: 'Enter a valid domain, e.g. solar.example.com' });
      }
      const updates: Record<string, unknown> = { 'remote.mode': mode, 'remote.domain': domain };
      if (acmeEmail !== undefined) {
        const email = String(acmeEmail).trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'That email address doesn’t look right.' });
        updates['remote.acme_email'] = email;
      }
      if (token !== undefined && token !== '') {
        if (!isTunnelToken(token)) {
          return reply.code(400).send({ error: 'That is not a Cloudflare Tunnel token. Copy the token from the tunnel’s install command (the long string after --token).' });
        }
        updates['remote.cloudflare_token'] = token.trim();
      }
      if (mode === 'cloudflare' && !updates['remote.cloudflare_token'] && !settings.get('remote.cloudflare_token')) {
        return reply.code(400).send({ error: 'Paste your Cloudflare Tunnel token.' });
      }
      settings.setMany(updates as never);
      log.info(mode === 'off' ? 'Remote access turned off.' : `Remote access set to ${mode} on ${domain}.`);
      return view();
    },
  );

  app.delete('/api/remote/token', async () => {
    settings.setMany({ 'remote.cloudflare_token': '', ...(settings.get('remote.mode') === 'cloudflare' ? { 'remote.mode': 'off' as const } : {}) });
    log.info('Tunnel token removed.');
    return view();
  });

  /** Dynamic DNS provider + secret. The token is write-only: it is never returned. */
  app.post<{ Body: { provider: DdnsProvider; token?: string } }>('/api/remote/ddns', async (req, reply) => {
    const { provider, token } = req.body ?? ({} as never);
    if (!DDNS_PROVIDERS.includes(provider)) return reply.code(400).send({ error: 'Unknown dynamic DNS provider' });
    const updates: Record<string, unknown> = { 'remote.ddns_provider': provider };
    if (token !== undefined && token !== '') {
      const t = String(token).trim();
      if (t.length > 2048) return reply.code(400).send({ error: 'Token too long' });
      if (provider === 'url' && !/^https?:\/\/\S+$/i.test(t)) return reply.code(400).send({ error: 'Enter the full update URL, starting with https://' });
      updates['remote.ddns_token'] = t;
    }
    if (provider === 'duckdns' && !duckSubdomain(settings.get('remote.domain'))) {
      return reply.code(400).send({ error: 'DuckDNS only works with a <name>.duckdns.org domain.' });
    }
    if (provider !== 'none' && !updates['remote.ddns_token'] && !settings.get('remote.ddns_token')) {
      return reply.code(400).send({ error: provider === 'url' ? 'Enter the update URL.' : 'Enter the token.' });
    }
    settings.setMany(updates as never);
    log.info(provider === 'none' ? 'Dynamic DNS turned off.' : `Dynamic DNS set to ${provider}.`);
    return view();
  });

  app.delete('/api/remote/ddns', async () => {
    settings.setMany({ 'remote.ddns_provider': 'none', 'remote.ddns_token': '' });
    log.info('Dynamic DNS token removed.');
    return view();
  });

  /** Re-runs the own-domain checks now (public IP, DNS, UPnP, certificate order without back-off). */
  app.post('/api/remote/domain/retry', async (_req, reply) => {
    if (settings.get('remote.mode') !== 'domain') return reply.code(409).send({ error: 'Own domain mode is not on.' });
    await retryDomain();
    return view();
  });

  /** Unauthenticated (under /api/auth/) so the reachability test can call it from outside. */
  app.get<{ Querystring: { nonce?: string } }>('/api/auth/remote-ping', async (req) => ({
    instance: INSTANCE,
    nonce: String(req.query.nonce ?? '').slice(0, 64),
  }));

  /** Fetches https://<domain>/api/auth/remote-ping from the device and checks it comes back to us. */
  app.post('/api/remote/test', async () => {
    const mode = settings.get('remote.mode');
    const hint =
      mode === 'domain' ? 'check that the router forwards port 443 to this device'
      : mode === 'proxy' ? `check that your proxy forwards to http://localhost:${localPort()}`
      : `check that the tunnel routes it to http://localhost:${localPort()}`;
    return testReachability(settings.get('remote.domain'), hint);
  });
}
