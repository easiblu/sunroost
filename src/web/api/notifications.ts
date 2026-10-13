/**
 * In-app notification feed and channel tests (docs/AUTOMATIONS.md). New feed entries are pushed
 * to WebSocket clients as `{ type: 'notification', data: item, unread }`.
 */
import * as automation from '../../automation/index.ts';
import { broadcast, type App } from '../server.ts';

export async function register(app: App) {
  automation.notifications.events.on('notification', (item) => {
    broadcast({ type: 'notification', data: item, unread: automation.notifications.list(1).unread });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/notifications', async (req) => automation.notifications.list(Number(req.query.limit) || 50).items);

  app.get('/api/notifications/unread', async () => ({ unread: automation.notifications.list(1).unread }));

  app.post('/api/notifications/read', async () => automation.notifications.markRead());

  app.post<{ Body: { channel?: string } }>('/api/notify/test', async (req, reply) => {
    try {
      return await automation.notifications.test(req.body?.channel ?? 'app');
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });
}
