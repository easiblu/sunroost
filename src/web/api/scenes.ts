/**
 * Scenes API (docs/AUTOMATIONS.md): list/create/update/delete and apply. Applying writes every
 * setting of the scene and returns the run record with per-setting results.
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
  if (!Number.isInteger(id) || id < 1) throw new automation.NotFoundError(`Scene #${raw} not found`);
  return id;
};

export async function register(app: App) {
  app.get('/api/scenes', async () => automation.sceneList());

  app.post<{ Body: unknown }>('/api/scenes', async (req, reply) => {
    try {
      return automation.createScene(req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<IdParams & { Body: unknown }>('/api/scenes/:id', async (req, reply) => {
    try {
      return automation.editScene(idOf(req.params.id), req.body ?? {});
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<IdParams>('/api/scenes/:id', async (req, reply) => {
    try {
      automation.deleteScene(idOf(req.params.id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams>('/api/scenes/:id/apply', async (req, reply) => {
    try {
      return await automation.applyScene(idOf(req.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  });
}
