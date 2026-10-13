/**
 * Grid provider API: day-ahead prices or load-shedding schedules, supported areas, manual refresh.
 *
 * Eskom (provider "eskom"):
 * - GET  /api/grid/eskom/areas?q=<text>  → { query, areas: [{ id, name, municipality, province, areaName }], selected, error }
 *   `id` is the eskom-calendar area to store; `name` the matching place; `areaName` the schedule's own name.
 * - POST /api/grid/eskom/area { area, name? } → the grid status (as GET /api/grid). An empty area clears it.
 */
import {
  PROVIDERS, areas, currencies, refresh, searchEskomAreas, selectEskomArea, status,
} from '../../grid/index.ts';
import type { App } from '../server.ts';

export async function register(app: App) {
  app.get<{ Querystring: { resolution?: string } }>('/api/grid', async (req) => ({
    ...status({ hourly: req.query.resolution === 'hour' }),
    providers: PROVIDERS,
    currencies: currencies(),
  }));

  app.get('/api/grid/areas', async () => areas());

  app.post('/api/grid/refresh', async () => {
    await refresh(true);
    return status();
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/grid/eskom/areas', async (req) =>
    searchEskomAreas(String(req.query.q ?? '').slice(0, 100), Math.min(Number(req.query.limit) || 50, 200)),
  );

  app.post<{ Body: { area?: string; name?: string } }>('/api/grid/eskom/area', async (req, reply) => {
    try {
      return { ...(await selectEskomArea(String(req.body?.area ?? ''), req.body?.name)), providers: PROVIDERS };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
