/**
 * Groups, like Home Assistant's group helper: a `group.*` entity that switches its members together.
 * State: "any" mode is on when any member is on, "all" mode when every available member is on;
 * unavailable when no member is. Commands fan out to the members, each a child of the group's context.
 */
import { db } from '../core/db.ts';
import { bus, newContext, type StateChangedEvent } from './bus.ts';
import * as registry from './registry.ts';
import { callService } from './services.ts';
import * as states from './states.ts';
import { UNAVAILABLE, UNKNOWN, type DeviceEngine, type EngineHost, type ServiceCall, type ServiceResult } from './types.ts';

/** Domains a group can switch. */
export const GROUPABLE = ['switch', 'light', 'fan', 'climate', 'media_player'];
export const MAX_MEMBERS = 50;

export interface Group {
  id: string;
  name: string;
  icon: string;
  members: string[];
  mode: 'any' | 'all';
  createdAt: number;
}

export class GroupError extends Error {}

const isOn = (state: string | undefined) => !!state && state !== 'off' && state !== UNAVAILABLE && state !== UNKNOWN;

export class GroupEngine implements DeviceEngine {
  id = 'group' as const;
  name = 'Groups';
  private host: EngineHost | null = null;
  private groups = new Map<string, Group>();
  /** group id → entity id. */
  private entityIds = new Map<string, string>();
  private onState = (ev: StateChangedEvent) => {
    for (const g of this.groups.values()) if (g.members.includes(ev.entityId)) this.refresh(g);
  };

  async start(host: EngineHost) {
    this.host = host;
    this.groups.clear();
    this.entityIds.clear();
    db().exec(`CREATE TABLE IF NOT EXISTS home_groups (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    for (const row of db().prepare(`SELECT data FROM home_groups`).all() as { data: string }[]) {
      const g = JSON.parse(row.data) as Group;
      this.groups.set(g.id, g);
      this.register(g);
    }
    bus.on('state_changed', this.onState);
  }

  async stop() {
    bus.off('state_changed', this.onState);
    this.host = null;
  }

  list(): (Group & { entityId: string })[] {
    return [...this.groups.values()].map((g) => ({ ...g, entityId: this.entityIds.get(g.id)! }));
  }

  private validate(input: { name?: unknown; icon?: unknown; members?: unknown; mode?: unknown }, selfEntityId?: string) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw new GroupError('name must be 1–100 characters');
    const icon = input.icon === undefined ? 'boxes' : input.icon;
    if (typeof icon !== 'string' || !/^[a-z0-9-]{1,40}$/.test(icon)) throw new GroupError('icon must be a Lucide icon name');
    const mode = input.mode === undefined ? 'any' : input.mode;
    if (mode !== 'any' && mode !== 'all') throw new GroupError('mode must be "any" or "all"');
    if (!Array.isArray(input.members) || input.members.length === 0) throw new GroupError('a group needs at least one member');
    const members = [...new Set(input.members)];
    if (members.length > MAX_MEMBERS) throw new GroupError(`a group can have at most ${MAX_MEMBERS} members`);
    for (const m of members) {
      const e = typeof m === 'string' ? registry.entity(m) : null;
      if (!e) throw new GroupError(`unknown entity ${String(m)}`);
      if (m === selfEntityId) throw new GroupError('a group cannot contain itself');
      if (!GROUPABLE.includes(e.domain)) throw new GroupError(`${m} can't be switched by a group`);
    }
    return { name, icon, mode: mode as Group['mode'], members: members as string[] };
  }

  create(input: Record<string, unknown>, now = Date.now()): Group & { entityId: string } {
    const v = this.validate(input);
    let id = `g${now.toString(36)}`;
    while (this.groups.has(id)) id += 'x';
    const g: Group = { id, ...v, createdAt: now };
    this.save(g);
    return { ...g, entityId: this.entityIds.get(id)! };
  }

  update(id: string, input: Record<string, unknown>): (Group & { entityId: string }) | null {
    const old = this.groups.get(id);
    if (!old) return null;
    const v = this.validate({ ...old, ...input }, this.entityIds.get(id));
    const g = { ...old, ...v };
    this.save(g);
    return { ...g, entityId: this.entityIds.get(id)! };
  }

  remove(id: string): boolean {
    if (!this.groups.delete(id)) return false;
    db().prepare(`DELETE FROM home_groups WHERE id = ?`).run(id);
    const entityId = this.entityIds.get(id);
    this.entityIds.delete(id);
    if (entityId) this.host?.removeEntity(entityId);
    return true;
  }

  private save(g: Group) {
    this.groups.set(g.id, g);
    db().prepare(`INSERT OR REPLACE INTO home_groups (id, data) VALUES (?, ?)`).run(g.id, JSON.stringify(g));
    this.register(g);
  }

  private register(g: Group) {
    if (!this.host) return;
    const e = this.host.registerEntity({ uniqueId: g.id, domain: 'group', name: g.name, icon: g.icon, services: ['turn_on', 'turn_off', 'toggle'] });
    this.entityIds.set(g.id, e.entityId);
    this.refresh(g);
  }

  private refresh(g: Group) {
    const entityId = this.entityIds.get(g.id);
    if (!entityId || !this.host) return;
    const memberStates = g.members.map((m) => states.get(m)?.state).filter((s) => s !== undefined && s !== UNAVAILABLE);
    let state: string;
    if (!memberStates.length) state = UNAVAILABLE;
    else if (g.mode === 'any') state = memberStates.some(isOn) ? 'on' : 'off';
    else state = memberStates.every(isOn) ? 'on' : 'off';
    const on = memberStates.filter(isOn).length;
    this.host.setState(entityId, state, { entity_id: g.members, mode: g.mode, members_on: on, members_available: memberStates.length });
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const g = [...this.groups.values()].find((x) => this.entityIds.get(x.id) === call.entityId);
    if (!g) return { ok: false, message: 'Unknown group' };
    const service = call.service === 'toggle' ? (isOn(states.get(call.entityId)?.state) ? 'turn_off' : 'turn_on') : call.service;
    // Members that are unavailable are skipped rather than failing the whole group.
    const targets = g.members.filter((m) => {
      const s = states.get(m)?.state;
      return s !== undefined && s !== UNAVAILABLE;
    });
    if (!targets.length) return { ok: false, message: 'No member of the group is available' };
    const res = await callService('homeassistant', service, targets, call.data, newContext(call.context.origin, call.context, call.context.ruleId));
    const failed = Object.entries(res.results).filter(([, r]) => !r.ok);
    if (failed.length === targets.length) return { ok: false, message: failed.map(([id, r]) => `${id}: ${r.message}`).join('; ') };
    const skipped = g.members.length - targets.length;
    const notes = [
      ...(failed.length ? [`${failed.length} of ${targets.length} failed (${failed.map(([id]) => id).join(', ')})`] : []),
      ...(skipped ? [`${skipped} unavailable, skipped`] : []),
    ];
    return { ok: true, message: notes.length ? notes.join('; ') : undefined };
  }
}
