/**
 * Storage API.
 *  GET  /api/storage                  usage figures
 *  GET  /api/storage/backup           consistent SQLite copy (sunroost-backup-YYYY-MM-DD.db)
 *  POST /api/storage/restore          raw .db body (application/octet-stream); staged for next start.
 *                                     ?restart=1 also stops the process after replying so the
 *                                     service manager starts it again with the restored database.
 *  POST /api/storage/resample-totals  recompute daily totals from history (progress in log tag 'db')
 *  POST /api/storage/clear-history    { confirm: true } clears history and totals
 */
import { createReadStream, rmSync } from 'node:fs';
import { logger } from '../../core/log.ts';
import { clearHistory } from '../../stats/history.ts';
import { createBackup, stageRestore, storageInfo } from '../../stats/storage.ts';
import { clearTotals, isResampling, resampleTotals } from '../../stats/totals.ts';
import type { App } from '../server.ts';

const l = logger('db');

export async function register(app: App) {
  app.get('/api/storage', async () => ({ ...(await storageInfo()), resampling: isResampling() }));

  app.get('/api/storage/backup', async (_req, reply) => {
    let file: string;
    try {
      file = createBackup();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
    l.info('Backup created for download.');
    const stream = createReadStream(file);
    const cleanup = () => rmSync(file, { force: true });
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    reply.header('content-type', 'application/vnd.sqlite3');
    reply.header('content-disposition', `attachment; filename="sunroost-backup-${new Date().toISOString().slice(0, 10)}.db"`);
    return reply.send(stream);
  });

  // Raw uploads need a binary body parser; keep it scoped to this route.
  await app.register(async (scope) => {
    scope.addContentTypeParser(['application/octet-stream', 'application/vnd.sqlite3', 'application/x-sqlite3'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post<{ Querystring: { restart?: string } }>('/api/storage/restore', async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Upload a .db file as the request body' });
      try {
        stageRestore(body);
      } catch (err) {
        l.warn(`Restore rejected: ${(err as Error).message}`);
        return reply.code(400).send({ error: (err as Error).message });
      }
      const restart = req.query.restart === '1' || req.query.restart === 'true';
      if (restart) {
        l.info('Restarting to apply the restored database.');
        reply.raw.on('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300));
      }
      return { ok: true, staged: true, restarting: restart, message: 'The backup applies when the service restarts.' };
    });
  });

  app.post('/api/storage/resample-totals', async (_req, reply) => {
    if (isResampling()) return reply.code(409).send({ error: 'Resampling is already running' });
    // Long-running: answer right away; progress shows in the 'db' log.
    resampleTotals().catch(() => {});
    return { ok: true, started: true };
  });

  app.post<{ Body: { confirm?: boolean } }>('/api/storage/clear-history', async (req, reply) => {
    if (req.body?.confirm !== true) return reply.code(400).send({ error: 'Confirmation required' });
    if (isResampling()) return reply.code(409).send({ error: 'Wait for resampling to finish' });
    clearHistory();
    clearTotals();
    l.info('Cleared all historic charts and totals.');
    return { ok: true };
  });
}
