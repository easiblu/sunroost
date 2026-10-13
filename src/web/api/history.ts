/**
 * History and totals API.
 *  GET /api/history?hours=24 | from=&to= (unix ms) &metrics=A,B [&inverter=N]
 *      → { xs (unix s), series: { metric: (number|null)[] }, resolution (s) }
 *  GET /api/totals?period=day|week|month|year&count=N → { period, rows, summary, tariff }
 *  GET /api/totals.csv?period=…&count=N
 */
import { HISTORY_METRICS, queryHistory } from '../../stats/history.ts';
import { PERIOD_DEFAULT_COUNT, totalsCsv, totalsReport, type Period } from '../../stats/totals.ts';
import type { App } from '../server.ts';

const PERIODS = Object.keys(PERIOD_DEFAULT_COUNT) as Period[];
const MAX_SPAN_MS = 400 * 86_400_000;

export async function register(app: App) {
  app.get<{ Querystring: { hours?: string; from?: string; to?: string; metrics?: string; inverter?: string } }>(
    '/api/history',
    async (req, reply) => {
      const q = req.query;
      const to = q.to ? Number(q.to) : Date.now();
      const from = q.from ? Number(q.from) : to - (Number(q.hours) || 24) * 3_600_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return reply.code(400).send({ error: 'Invalid time range' });
      if (to - from > MAX_SPAN_MS) return reply.code(400).send({ error: 'Time range too long' });
      const metrics = (q.metrics || 'PV power,Load power,Grid power').split(',').map((m) => m.trim()).filter(Boolean).slice(0, HISTORY_METRICS.length);
      const inverter = q.inverter !== undefined && q.inverter !== '' ? Number(q.inverter) : undefined;
      if (inverter !== undefined && !(Number.isInteger(inverter) && inverter >= 0)) return reply.code(400).send({ error: 'Invalid inverter' });
      return queryHistory({ from, to, metrics, inverter });
    },
  );

  const parse = (q: { period?: string; count?: string }) => {
    const period = (PERIODS.includes(q.period as Period) ? q.period : 'day') as Period;
    const count = Number(q.count) > 0 ? Math.floor(Number(q.count)) : PERIOD_DEFAULT_COUNT[period];
    return { period, count };
  };

  app.get<{ Querystring: { period?: string; count?: string } }>('/api/totals', async (req) => {
    const { period, count } = parse(req.query);
    return totalsReport(period, count);
  });

  app.get<{ Querystring: { period?: string; count?: string } }>('/api/totals.csv', async (req, reply) => {
    const { period, count } = parse(req.query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="sunroost-totals-${period}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return totalsCsv(period, count);
  });
}
