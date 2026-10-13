/**
 * Automations API: CRUD, enable/disable (with conflict detection), options for the editors,
 * suspend/resume, a dry-run preview, and for rules: run now / dry run, run history, the
 * upcoming timeline and templates (docs/AUTOMATIONS.md).
 */
import type { FastifyReply } from 'fastify';
import * as automation from '../../automation/index.ts';
import type { App } from '../server.ts';

function fail(reply: FastifyReply, err: unknown) {
  const message = (err as Error).message;
  if (err instanceof automation.ValidationError) return reply.code(400).send({ error: message });
  if (err instanceof automation.ConflictError) return reply.code(409).send({ error: message });
  if (err instanceof automation.NotFoundError) return reply.code(404).send({ error: message });
  return reply.code(500).send({ error: message });
}

type IdParams = { Params: { id: string } };
const idOf = (raw: string) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new automation.NotFoundError(`Automation #${raw} not found`);
  return id;
};

export async function register(app: App) {
  app.get('/api/automations', async () => automation.list());

  app.get('/api/automations/options', async () => automation.options());

  app.get('/api/automations/templates', async () => automation.ruleTemplates());

  app.get<{ Querystring: { hours?: string } }>('/api/automations/upcoming', async (req) => automation.upcoming(Number(req.query.hours) || 24));

  app.get<{ Querystring: { limit?: string } }>('/api/automations/runs', async (req) => automation.runHistory(null, Number(req.query.limit) || 50));

  app.get<IdParams & { Querystring: { limit?: string } }>('/api/automations/:id/runs', async (req, reply) => {
    try {
      return automation.runHistory(idOf(req.params.id), Number(req.query.limit) || 50);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams & { Querystring: { dry?: string; force?: string } }>('/api/automations/:id/run', async (req, reply) => {
    const flag = (v?: string) => v === '1' || v === 'true';
    try {
      return await automation.runRule(idOf(req.params.id), { dry: flag(req.query.dry), force: flag(req.query.force) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: { type?: string; name?: string; enabled?: boolean; config?: unknown } }>('/api/automations', async (req, reply) => {
    try {
      return automation.create(req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: { minutes?: number } }>('/api/automations/suspend', async (req, reply) => {
    try {
      return automation.activateOverride(Number(req.body?.minutes));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/automations/suspend', async () => automation.cancelOverride());

  app.get<IdParams>('/api/automations/:id/preview', async (req, reply) => {
    try {
      return automation.preview(idOf(req.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<IdParams & { Body: { name?: string; config?: unknown } }>('/api/automations/:id', async (req, reply) => {
    try {
      return automation.update(idOf(req.params.id), req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<IdParams>('/api/automations/:id', async (req, reply) => {
    try {
      automation.remove(idOf(req.params.id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post<IdParams>(`/api/automations/:id/${action}`, async (req, reply) => {
      try {
        return automation.setEnabled(idOf(req.params.id), action === 'enable');
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
}
