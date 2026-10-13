/**
 * ACME HTTP-01 challenge responses (and the own-domain port-80 self-test) at
 * /.well-known/acme-challenge/:token. Outside /api, so the auth preHandler doesn't apply, and
 * exempt from the http → https redirect in server.ts.
 */
import { getChallenge } from '../../remote/domain/acme.ts';
import type { App } from '../server.ts';

export async function register(app: App) {
  app.get<{ Params: { token: string } }>('/.well-known/acme-challenge/:token', async (req, reply) => {
    const value = /^[A-Za-z0-9_-]{1,128}$/.test(req.params.token) ? getChallenge(req.params.token) : null;
    if (!value) return reply.code(404).type('text/plain').send('Not found');
    return reply.type('text/plain').send(value);
  });
}
