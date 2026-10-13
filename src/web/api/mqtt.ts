/**
 * MQTT API: status, start/stop, broker password, and the live topic list for the topic browser.
 * The MQTT password is write-only: no endpoint ever returns it.
 */
import { networkInterfaces } from 'node:os';
import { logger } from '../../core/log.ts';
import { settings } from '../../core/settings.ts';
import * as mqtt from '../../mqtt/index.ts';
import type { App } from '../server.ts';

const log = logger('mqtt');

/** IPv4 addresses of this machine, for the "broker address" hint. */
function addresses() {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export async function register(app: App) {
  app.get('/api/mqtt/status', async () => ({ ...mqtt.status(), addresses: addresses() }));

  app.post('/api/mqtt/start', async () => {
    settings.set('publish_mqtt', true);
    await mqtt.apply();
    return mqtt.status();
  });

  app.post('/api/mqtt/stop', async () => {
    settings.set('publish_mqtt', false);
    await mqtt.apply();
    return mqtt.status();
  });

  app.post<{ Body: { password?: string | null } }>('/api/mqtt/password', async (req, reply) => {
    const pw = req.body?.password ?? null;
    if (pw !== null && typeof pw !== 'string') return reply.code(400).send({ error: 'Invalid password' });
    if (pw && (pw.length < 4 || pw.length > 64)) {
      return reply.code(400).send({ error: 'Password must be 4 to 64 characters' });
    }
    settings.set('mqtt_password', pw || '');
    log.info(pw ? 'Broker password updated.' : 'Broker password cleared.');
    await mqtt.apply();
    return { ok: true, passwordSet: Boolean(pw) };
  });

  app.get<{ Querystring: { discovery?: string } }>('/api/mqtt/topics', async (req) =>
    mqtt.topics({ discovery: req.query.discovery === '1' || req.query.discovery === 'true' }),
  );
}
