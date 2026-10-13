/**
 * Smart-home API: engine status, entities and devices (with the user's names, rooms and energy roles),
 * rooms, groups, and service calls. Entity state changes are pushed over the WebSocket in batches, at most once a
 * second: `{ type: 'home_states', data: EntityStateView[], removed: string[] }`.
 */
import type { FastifyReply } from 'fastify';
import * as secrets from '../../core/secrets.ts';
import { settings } from '../../core/settings.ts';
import { state as energyState } from '../../core/state.ts';
import { ymdOf, zonedTs } from '../../automation/time.ts';
import { isLocalUrl, TOKEN_SECRET, verifyToken } from '../../home/full/index.ts';
import * as home from '../../home/index.ts';
import { ENERGY_ROLES, servicesFor, type DeviceEntry, type EntityEntry, type EntityState } from '../../home/types.ts';
import { broadcast, type App } from '../server.ts';

const PUSH_MS = 1000;
const { areas, groups, registry, states } = home;

function stateView(s: EntityState) {
  return { entityId: s.entityId, state: s.state, attributes: s.attributes, lastChanged: s.lastChanged, lastUpdated: s.lastUpdated };
}

export function entityView(e: EntityEntry) {
  const s = states.get(e.entityId);
  const d = e.deviceId ? registry.device(e.deviceId) : null;
  return {
    entityId: e.entityId,
    name: registry.entityName(e),
    originalName: e.originalName,
    domain: e.domain,
    engine: e.engine,
    deviceId: e.deviceId,
    deviceName: d ? registry.deviceName(d) : null,
    unit: e.unit,
    deviceClass: e.deviceClass,
    icon: e.icon,
    role: e.role,
    powerW: e.powerW,
    interlock: e.interlock,
    areaId: e.areaId,
    hidden: e.hidden,
    readOnly: e.readOnly,
    services: servicesFor(e),
    state: s?.state ?? 'unavailable',
    attributes: s?.attributes ?? {},
    lastChanged: s?.lastChanged ?? null,
    lastUpdated: s?.lastUpdated ?? null,
  };
}

/** Devices never expose `config` (it can hold credentials). */
function deviceView(d: DeviceEntry) {
  const entityIds = registry.allEntities().filter((e) => e.deviceId === d.id).map((e) => e.entityId);
  return {
    id: d.id,
    name: registry.deviceName(d),
    originalName: d.name,
    engine: d.engine,
    manufacturer: d.manufacturer,
    model: d.model,
    swVersion: d.swVersion,
    areaId: d.areaId,
    reviewed: d.reviewed,
    hidden: d.hidden,
    /** True when at least one entity is reachable. */
    available: entityIds.some((id) => (states.get(id)?.state ?? 'unavailable') !== 'unavailable'),
    createdAt: d.createdAt,
    entities: entityIds,
  };
}

const ICON_RE = /^[a-z0-9-]{1,40}$/;
const optArea = (v: unknown) => v === null || (typeof v === 'string' && areas.get(v) !== null);

const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
const isOptText = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.trim().length > 0 && v.length <= max);

export async function register(app: App) {
  // Batched push of state changes.
  const changed = new Set<string>();
  const removed = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  home.bus.on('state_changed', (ev) => {
    if (ev.newState) {
      changed.add(ev.entityId);
      removed.delete(ev.entityId);
    } else {
      removed.add(ev.entityId);
      changed.delete(ev.entityId);
    }
    timer ??= setTimeout(() => {
      timer = null;
      const data = [...changed].map((id) => states.get(id)).filter((s): s is EntityState => !!s).map(stateView);
      broadcast({ type: 'home_states', data, removed: [...removed] });
      changed.clear();
      removed.clear();
    }, PUSH_MS);
  });

  app.get('/api/home/status', async () => home.engineStatus());

  app.get('/api/home/entities', async () => registry.allEntities().map(entityView));

  app.get<{ Params: { id: string } }>('/api/home/entities/:id', async (req, reply) => {
    const e = registry.entity(req.params.id);
    return e ? entityView(e) : reply.code(404).send({ error: `Unknown entity ${req.params.id}` });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/home/entities/:id', async (req, reply) => {
    const e = registry.entity(req.params.id);
    if (!e) return reply.code(404).send({ error: `Unknown entity ${req.params.id}` });
    const b = req.body ?? {};
    const changes: Parameters<typeof registry.updateEntity>[1] = {};
    if ('name' in b) {
      if (!isOptText(b.name, 100)) return bad(reply, 'name must be 1–100 characters, or null to reset it');
      changes.name = b.name === null ? null : String(b.name).trim();
    }
    if ('icon' in b) {
      if (b.icon !== null && !(typeof b.icon === 'string' && /^[a-z0-9-]{1,40}$/.test(b.icon))) return bad(reply, 'icon must be a Lucide icon name');
      changes.icon = b.icon as string | null;
    }
    if ('role' in b) {
      if (b.role !== null && !ENERGY_ROLES.includes(b.role as never)) return bad(reply, `role must be one of ${ENERGY_ROLES.join(', ')}, or null`);
      if (b.role !== null && servicesFor(e).length === 0) return bad(reply, 'Only controllable entities can have an energy role');
      changes.role = b.role as EntityEntry['role'];
    }
    if ('hidden' in b) {
      if (typeof b.hidden !== 'boolean') return bad(reply, 'hidden must be true or false');
      changes.hidden = b.hidden;
    }
    if ('areaId' in b) {
      if (!optArea(b.areaId)) return bad(reply, 'areaId must be a room id, or null');
      changes.areaId = b.areaId as string | null;
    }
    if ('interlock' in b) {
      const il = b.interlock as Record<string, unknown> | null;
      if (il !== null && (typeof il !== 'object' || Array.isArray(il))) return bad(reply, 'interlock must be an object or null');
      if (il) {
        const out: Record<string, unknown> = {};
        if (il.maxLoadW !== undefined && il.maxLoadW !== null) {
          if (typeof il.maxLoadW !== 'number' || il.maxLoadW < 0 || il.maxLoadW > 100_000) return bad(reply, 'interlock.maxLoadW must be 0–100000 W');
          out.maxLoadW = Math.round(il.maxLoadW);
        }
        if (il.gridAvailable !== undefined && il.gridAvailable !== null) {
          if (typeof il.gridAvailable !== 'boolean') return bad(reply, 'interlock.gridAvailable must be true or false');
          out.gridAvailable = il.gridAvailable;
        }
        if (il.minBatterySoc !== undefined && il.minBatterySoc !== null) {
          if (typeof il.minBatterySoc !== 'number' || il.minBatterySoc < 0 || il.minBatterySoc > 100) return bad(reply, 'interlock.minBatterySoc must be 0–100');
          out.minBatterySoc = Math.round(il.minBatterySoc);
        }
        changes.interlock = Object.keys(out).length ? out : null;
      } else changes.interlock = null;
    }
    if ('powerW' in b) {
      if (b.powerW !== null && !(typeof b.powerW === 'number' && Number.isFinite(b.powerW) && b.powerW >= 1 && b.powerW <= 50_000)) {
        return bad(reply, 'powerW must be 1–50000 W, or null');
      }
      changes.powerW = b.powerW === null ? null : Math.round(b.powerW as number);
    }
    return entityView(registry.updateEntity(e.entityId, changes)!);
  });

  app.get('/api/home/devices', async () => registry.allDevices().map(deviceView));

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/home/devices/:id', async (req, reply) => {
    const d = registry.device(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Unknown device' });
    const b = req.body ?? {};
    const changes: Parameters<typeof registry.updateDevice>[1] = {};
    if ('name' in b) {
      if (!isOptText(b.name, 100)) return bad(reply, 'name must be 1–100 characters, or null to reset it');
      changes.nameByUser = b.name === null ? null : String(b.name).trim();
    }
    if ('areaId' in b) {
      if (!optArea(b.areaId)) return bad(reply, 'areaId must be a room id, or null');
      changes.areaId = b.areaId as string | null;
    }
    for (const k of ['reviewed', 'hidden'] as const) {
      if (!(k in b)) continue;
      if (typeof b[k] !== 'boolean') return bad(reply, `${k} must be true or false`);
      changes[k] = b[k] as boolean;
    }
    return deviceView(registry.updateDevice(d.id, changes)!);
  });

  // Removing is for devices that are gone for good; a device that comes back is added again.
  app.delete<{ Params: { id: string } }>('/api/home/devices/:id', async (req, reply) => {
    const d = registry.device(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Unknown device' });
    if (d.engine === 'energy') return reply.code(409).send({ error: "Sunroost's own data can't be removed" });
    if (deviceView(d).available) return reply.code(409).send({ error: 'The device is online. Remove it from its integration first, or unplug it.' });
    for (const id of registry.removeDevice(d.id)) states.remove(id);
    return { ok: true };
  });

  // History of one entity: { entityId, from, to, points: [{ ts, state, num }] }
  app.get<{ Querystring: { entity?: string; hours?: string } }>('/api/home/history', async (req, reply) => {
    const e = req.query.entity ? registry.entity(req.query.entity) : null;
    if (!e) return reply.code(404).send({ error: 'Unknown entity' });
    const hours = Math.min(336, Math.max(1, Number(req.query.hours) || 24));
    const to = Date.now();
    const from = to - hours * 3_600_000;
    return { entityId: e.entityId, from, to, points: home.history.history(e.entityId, from, to) };
  });

  // Where the power goes: every device power reading now, and today's energy per device.
  app.get('/api/home/loads', async () => {
    const tz = settings.get('timezone');
    const midnight = zonedTs(ymdOf(Date.now(), tz), 0, tz);
    const loads = registry
      .allEntities()
      .filter((e) => e.engine !== 'energy' && !e.hidden && e.domain === 'sensor' && e.unit === 'W')
      .map((e) => {
        const d = e.deviceId ? registry.device(e.deviceId) : null;
        const w = Number(states.get(e.entityId)?.state);
        return {
          entityId: e.entityId, name: registry.entityName(e), device: d ? registry.deviceName(d) : null, deviceId: e.deviceId,
          w: Number.isFinite(w) ? Math.round(w) : null, kwhToday: home.history.energyKwh(e.entityId, midnight),
        };
      })
      .sort((a, b) => (b.w ?? 0) - (a.w ?? 0));
    const load = energyState.totals['Load power'];
    return { loadW: typeof load === 'number' ? load : null, loads };
  });

  // Rooms
  app.get('/api/home/areas', async () => areas.list());

  app.post<{ Body: Record<string, unknown> }>('/api/home/areas', async (req, reply) => {
    const { name, icon = 'house' } = req.body ?? {};
    if (!isOptText(name, 60) || name === null) return bad(reply, 'name must be 1–60 characters');
    if (typeof icon !== 'string' || !ICON_RE.test(icon)) return bad(reply, 'icon must be a Lucide icon name');
    const a = areas.create(String(name).trim(), icon);
    return a ?? reply.code(409).send({ error: 'A room with that name already exists' });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/home/areas/:id', async (req, reply) => {
    if (!areas.get(req.params.id)) return reply.code(404).send({ error: 'Unknown room' });
    const { name, icon } = req.body ?? {};
    if (name !== undefined && (!isOptText(name, 60) || name === null)) return bad(reply, 'name must be 1–60 characters');
    if (icon !== undefined && (typeof icon !== 'string' || !ICON_RE.test(icon))) return bad(reply, 'icon must be a Lucide icon name');
    const a = areas.update(req.params.id, { ...(name ? { name: String(name).trim() } : {}), ...(icon ? { icon: icon as string } : {}) });
    return a ?? reply.code(409).send({ error: 'A room with that name already exists' });
  });

  app.delete<{ Params: { id: string } }>('/api/home/areas/:id', async (req, reply) =>
    areas.remove(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'Unknown room' }),
  );

  // Groups
  const groupFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof home.GroupError) return bad(reply, err.message);
    throw err;
  };
  app.get('/api/home/groups', async () => groups.list());

  app.post<{ Body: Record<string, unknown> }>('/api/home/groups', async (req, reply) => {
    try {
      return groups.create(req.body ?? {});
    } catch (err) {
      return groupFail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/home/groups/:id', async (req, reply) => {
    try {
      return groups.update(req.params.id, req.body ?? {}) ?? reply.code(404).send({ error: 'Unknown group' });
    } catch (err) {
      return groupFail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/home/groups/:id', async (req, reply) =>
    groups.remove(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'Unknown group' }),
  );

  // Integrations (either engine): catalogue, setup flows, discovered devices, configured entries.
  const full = (reply: FastifyReply) => {
    const f = home.integrationEngine();
    if (!f) reply.code(409).send({ error: 'Integrations are unavailable until Home Assistant is connected.' });
    return f;
  };
  // Home Assistant rejecting input is the caller's error (400); anything else means it failed us (502).
  const haFail = (reply: FastifyReply, err: unknown) =>
    reply.code((err as { code?: string }).code === '400' ? 400 : 502).send({ error: (err as Error).message });
  const FLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

  app.get('/api/home/integrations', async (_req, reply) => {
    const f = full(reply);
    if (!f) return;
    return f.integrations().catch((err) => haFail(reply, err));
  });

  app.get('/api/home/integrations/entries', async (_req, reply) => {
    const f = full(reply);
    if (!f) return;
    return f.entries().catch((err) => haFail(reply, err));
  });

  app.delete<{ Params: { id: string } }>('/api/home/integrations/entries/:id', async (req, reply) => {
    const f = full(reply);
    if (!f) return;
    if (!FLOW_ID.test(req.params.id)) return bad(reply, 'Invalid entry id');
    return f.removeEntry(req.params.id).then(() => ({ ok: true }), (err) => haFail(reply, err));
  });

  // Polled by the Devices page: an empty list (not an error) without the full engine.
  app.get('/api/home/integrations/discovered', async (_req, reply) => {
    const f = home.integrationEngine();
    if (!f) return [];
    return f.discovered().catch((err) => haFail(reply, err));
  });

  // Removes devices left by an engine no longer in use (all unavailable).
  app.post('/api/home/cleanup', async () => ({ removed: home.removeLeftovers() }));

  // Sends discovery queries now (lite engine; Home Assistant discovers continuously).
  app.post('/api/home/scan', async () => {
    home.liteEngine()?.scan();
    return { ok: true };
  });

  app.post<{ Body: { handler?: unknown } }>('/api/home/flows', async (req, reply) => {
    const f = full(reply);
    if (!f) return;
    const handler = req.body?.handler;
    if (typeof handler !== 'string' || !/^[a-z0-9_]{1,64}$/.test(handler)) return bad(reply, 'handler must be an integration domain');
    return f.startFlow(handler).catch((err) => haFail(reply, err));
  });

  app.get<{ Params: { id: string } }>('/api/home/flows/:id', async (req, reply) => {
    const f = full(reply);
    if (!f) return;
    if (!FLOW_ID.test(req.params.id)) return bad(reply, 'Invalid flow id');
    return f.flowStep(req.params.id, null).catch((err) => haFail(reply, err));
  });

  app.post<{ Params: { id: string }; Body: { input?: unknown } }>('/api/home/flows/:id', async (req, reply) => {
    const f = full(reply);
    if (!f) return;
    const input = req.body?.input;
    if (!FLOW_ID.test(req.params.id)) return bad(reply, 'Invalid flow id');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return bad(reply, 'input must be an object');
    return f.flowStep(req.params.id, input as Record<string, unknown>).catch((err) => haFail(reply, err));
  });

  app.delete<{ Params: { id: string } }>('/api/home/flows/:id', async (req, reply) => {
    const f = full(reply);
    if (!f) return;
    if (!FLOW_ID.test(req.params.id)) return bad(reply, 'Invalid flow id');
    return f.abortFlow(req.params.id).then(() => ({ ok: true }), (err) => haFail(reply, err));
  });

  // Link Sunroost to a Home Assistant: checks the token by connecting, then stores it encrypted.
  app.post<{ Body: { url?: unknown; token?: unknown } }>('/api/home/full/link', async (req, reply) => {
    const { url, token } = req.body ?? {};
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+/.test(url)) return bad(reply, 'url must be an http(s) address, e.g. http://homeassistant.local:8123');
    if (typeof token !== 'string' || token.trim().length < 20) return bad(reply, 'token must be a Home Assistant long-lived access token');
    const clean = url.trim().replace(/\/+$/, '');
    let version: string;
    try {
      version = await verifyToken(clean, token.trim());
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    secrets.set(TOKEN_SECRET, token.trim());
    settings.setMany({ 'home.full_url': clean, 'home.engine': 'full' });
    await home.relinkFull();
    return { ok: true, version };
  });

  // Managing the Home Assistant (full engine)
  const ha = (reply: FastifyReply) => {
    const f = home.fullEngine();
    if (!f || f.info().state !== 'connected') reply.code(409).send({ error: 'Home Assistant is not connected.' });
    return f && f.info().state === 'connected' ? f : null;
  };
  app.get('/api/home/full/version', async (_req, reply) => {
    const f = ha(reply);
    if (!f) return;
    return { current: f.info().version, latest: await f.latestVersion(), local: f.info().local };
  });
  app.post('/api/home/full/restart', async (_req, reply) => {
    const f = ha(reply);
    if (!f) return;
    return f.restart().then(() => ({ ok: true }), (err) => haFail(reply, err));
  });
  app.post('/api/home/full/backup', async (_req, reply) => {
    const f = ha(reply);
    if (!f) return;
    return f.backup().then((b) => ({ ok: true, ...b }), (err) => haFail(reply, err));
  });
  app.post<{ Body: { version?: unknown } }>('/api/home/full/update', async (req, reply) => {
    const f = ha(reply);
    if (!f) return;
    const v = req.body?.version;
    if (typeof v !== 'string' || !(v === 'rollback' || /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(v))) return bad(reply, 'version must be like 2026.11.0, or "rollback"');
    return f.update(v).then((message) => ({ ok: true, message }), (err) => haFail(reply, err));
  });

  // Forget a Home Assistant elsewhere on the network. The local one keeps its token: Sunroost created its
  // only owner account, so forgetting the token would lock Sunroost out of it.
  app.post('/api/home/full/unlink', async (_req, reply) => {
    if (isLocalUrl(settings.get('home.full_url'))) return reply.code(409).send({ error: "Sunroost manages the Home Assistant on this board; there's nothing to unlink." });
    secrets.set(TOKEN_SECRET, null);
    settings.setMany({ 'home.full_url': 'http://127.0.0.1:8123', 'home.engine': 'auto' });
    await home.relinkFull();
    return { ok: true };
  });

  // Home Assistant style: POST /api/home/services/switch/turn_on { entity_id: "switch.pump", ...data }
  app.post<{ Params: { domain: string; service: string }; Body: Record<string, unknown> }>(
    '/api/home/services/:domain/:service',
    async (req, reply) => {
      const { entity_id: target, ...data } = req.body ?? {};
      const ids = Array.isArray(target) ? target : [target];
      if (!ids.length || !ids.every((id) => typeof id === 'string' && id.includes('.'))) {
        return bad(reply, 'entity_id must be an entity id or a list of them');
      }
      const res = await home.callService(req.params.domain, req.params.service, ids as string[], data, home.newContext('user'));
      return res;
    },
  );
}
