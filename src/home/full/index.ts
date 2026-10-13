/**
 * The full device engine: every Home Assistant integration, through a Home Assistant instance Sunroost
 * controls (installed by deploy/install.sh, listening on 127.0.0.1 only) or one the user points it
 * at with an access token.
 *
 * Mirrors Home Assistant's devices and entities into Sunroost's registry (same entity ids), streams
 * states with `subscribe_entities`, sends commands with `call_service`, and exposes Home Assistant's
 * config flows so the Devices page can add any integration. See docs/SMART_HOME.md.
 */
import { logger } from '../../core/log.ts';
import { existsSync } from 'node:fs';
import { execPriv, hasPrivileges } from '../../system/exec.ts';
import * as secrets from '../../core/secrets.ts';
import { settings } from '../../core/settings.ts';
import { newContext } from '../bus.ts';
import { UNAVAILABLE, type Context, type DeviceEngine, type EngineHost, type ServiceCall, type ServiceResult } from '../types.ts';
import { HaClient, HaError } from './client.ts';
import { catalogue, flowView, initialValue, type FlowView, type Integration, type Translations } from './flows.ts';
import {
  applyCompressed, includeEntity, INTERNAL_PLATFORMS, servicesFor, SKIPPED_DOMAINS, uiAttributes, type HaDevice, type HaEntityEntry, type HaState,
} from './mapping.ts';
import { onboard, onboardingStatus } from './onboard.ts';

const log = logger('home');
export const TOKEN_SECRET = 'home.full_token';
export const PASSWORD_SECRET = 'home.full_password';
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
/** A state change of an entity within this long after a command to it is traced to that command. */
const CONTEXT_TTL_MS = 10_000;
const CATALOGUE_TTL_MS = 6 * 3600_000;
/** Root-owned update script installed by deploy/install.sh. */
const UPDATE_SCRIPT = '/usr/local/sbin/sunroost-ha-update';

export const isLocalUrl = (url: string) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

export class FullEngine implements DeviceEngine {
  id = 'full' as const;
  name = 'Home Assistant integrations';
  private host: EngineHost | null = null;
  private client: HaClient | null = null;
  private state: 'connecting' | 'connected' | 'error' | 'setup' = 'connecting';
  private message: string | null = null;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Waits between reconnect attempts (shortened in tests). */
  retryMs = RETRY_MS;
  resyncMs = 1000;
  private cache = new Map<string, HaState>();
  /** Home Assistant entity id ↔ Sunroost entity id. */
  private toSolar = new Map<string, string>();
  private toHa = new Map<string, string>();
  private haServices: Record<string, Record<string, unknown>> = {};
  /**
   * Home Assistant entity id → the last command sent to it. Home Assistant reports the change while
   * the command is still running (before its reply), so the reply's context id can't be used.
   */
  private commandContexts = new Map<string, { context: Context; until: number }>();
  private catalogueCache: { at: number; list: Integration[] } | null = null;
  /** Each open flow's current form schema: input is completed with its defaults before submitting. */
  private flowSchemas = new Map<string, unknown[]>();
  private translationCache = new Map<string, Translations>();

  get url() {
    return settings.get('home.full_url').replace(/\/+$/, '');
  }

  async start(host: EngineHost) {
    this.host = host;
    this.stopped = false;
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.client?.close();
    this.client = null;
    this.markUnavailable();
    this.host = null;
  }

  /** Reconnects now (after a new token or URL). */
  reconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.client?.close();
    this.client = null;
    void this.connect();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const ms = this.retryMs[Math.min(this.attempt++, this.retryMs.length - 1)];
    this.retryTimer = setTimeout(() => void this.connect(), ms);
  }

  private setStatus(state: FullEngine['state'], message: string | null) {
    if (message && message !== this.message) (state === 'error' ? log.warn : log.info)(`Home Assistant: ${message}`);
    this.state = state;
    this.message = message;
  }

  private async connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    const url = this.url;
    let token = secrets.get(TOKEN_SECRET);
    try {
      if (!token) {
        if (!isLocalUrl(url)) return this.setStatus('setup', `Enter an access token for the Home Assistant at ${url}.`);
        const steps = await onboardingStatus(url);
        if (!steps) throw new HaError(`Home Assistant isn't running at ${url} yet.`, 'unreachable');
        if (steps.find((s) => s.step === 'user')?.done) {
          return this.setStatus('setup', 'Home Assistant already has an owner. Enter an access token from its profile page.');
        }
        log.info('Home Assistant: setting it up for Sunroost.');
        const res = await onboard(url, settings.get('timezone'));
        secrets.set(TOKEN_SECRET, res.token);
        secrets.set(PASSWORD_SECRET, res.password);
        token = res.token;
      }
      const client = new HaClient(url, token);
      await client.connect();
      if (this.stopped) return client.close();
      this.client = client;
      client.on('close', () => {
        if (this.client !== client) return;
        this.client = null;
        this.markUnavailable();
        this.setStatus('error', 'Connection to Home Assistant lost; reconnecting.');
        this.scheduleRetry();
      });
      await this.sync(true);
      await client.subscribe({ type: 'subscribe_events', event_type: 'entity_registry_updated' }, () => this.resyncSoon());
      await client.subscribe({ type: 'subscribe_events', event_type: 'device_registry_updated' }, () => this.resyncSoon());
      this.attempt = 0;
      this.setStatus('connected', null);
      log.info(`Home Assistant ${client.haVersion}: connected, ${this.toSolar.size} entities.`);
      void this.ensureMqtt();
    } catch (err) {
      const e = err as HaError;
      if (e.code === 'invalid_auth') return this.setStatus('setup', 'Home Assistant rejected Sunroost\'s access token. Enter a new one.');
      this.setStatus('error', e.message);
      this.scheduleRetry();
    }
  }

  private resyncSoon() {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => void this.sync(false).catch((err) => log.warn(`Home Assistant sync: ${(err as Error).message}`)), this.resyncMs);
  }

  /** Reads the registries and mirrors them; on first sync also subscribes to states. */
  private async sync(subscribe: boolean) {
    const client = this.client;
    const host = this.host;
    if (!client || !host) return;
    if (subscribe) {
      let first: () => void = () => {};
      const firstEvent = new Promise<void>((resolve) => (first = resolve));
      await client.subscribe({ type: 'subscribe_entities' }, (ev) => {
        const { changed, removed } = applyCompressed(this.cache, ev);
        first();
        this.onStates(ev, changed, removed);
      });
      await Promise.race([firstEvent, new Promise((r) => setTimeout(r, 10_000))]);
    }
    const [services, entities, devices, areas] = await Promise.all([
      client.command<Record<string, Record<string, unknown>>>({ type: 'get_services' }),
      client.command<HaEntityEntry[]>({ type: 'config/entity_registry/list' }),
      client.command<HaDevice[]>({ type: 'config/device_registry/list' }),
      client.command<{ area_id: string; name: string }[]>({ type: 'config/area_registry/list' }),
    ]);
    this.haServices = services;
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
    const uniq = (settings.get('mqtt_uniq_id') || 'sr').replace(/[^a-zA-Z0-9_-]/g, '_');
    const solarDevice = new Map<string, string>();
    const seen = new Set<string>();
    // Devices already in Home Assistant when Solar first links to it were set up by their owner: not "new".
    const firstLink = host.devices().length === 0;
    const register = (haId: string, uniqueId: string, dev: HaDevice | undefined, hidden: boolean) => {
      const domain = haId.split('.')[0];
      let deviceId: string | null = null;
      if (dev) {
        deviceId = solarDevice.get(dev.id) ?? null;
        if (!deviceId) {
          deviceId = host.registerDevice({
            uniqueId: dev.id, name: dev.name_by_user ?? dev.name ?? 'Device', manufacturer: dev.manufacturer, model: dev.model, swVersion: dev.sw_version,
            ...(firstLink ? { reviewed: true } : {}),
            suggestedArea: dev.area_id ? areaName.get(dev.area_id) ?? null : null,
          }).id;
          solarDevice.set(dev.id, deviceId);
        }
      }
      const st = this.cache.get(haId);
      const services = servicesFor(domain, this.haServices);
      const e = host.registerEntity({
        uniqueId,
        domain,
        name: String(st?.a.friendly_name ?? haId),
        objectId: haId.slice(domain.length + 1),
        deviceId,
        unit: typeof st?.a.unit_of_measurement === 'string' ? st.a.unit_of_measurement : null,
        deviceClass: typeof st?.a.device_class === 'string' ? st.a.device_class : null,
        services,
        readOnly: services.length === 0,
        hidden,
      });
      this.toSolar.set(haId, e.entityId);
      this.toHa.set(e.entityId, haId);
      seen.add(e.entityId);
      this.push(haId);
    };
    const inRegistry = new Set<string>();
    for (const e of entities) {
      inRegistry.add(e.entity_id);
      const dev = e.device_id ? deviceById.get(e.device_id) : undefined;
      if (!includeEntity(e, dev, uniq)) continue;
      // Diagnostic and configuration entities (signal strength, firmware …) start hidden.
      register(e.entity_id, e.id, dev, e.entity_category !== null && e.entity_category !== undefined);
    }
    // Entities without a registry entry (no unique id, e.g. some YAML ones) still have states.
    for (const haId of this.cache.keys()) {
      if (!inRegistry.has(haId) && !SKIPPED_DOMAINS.has(haId.split('.')[0])) register(haId, `state:${haId}`, undefined, false);
    }
    // Gone from Home Assistant: gone from Sunroost.
    for (const e of host.entities()) {
      if (!seen.has(e.entityId)) {
        const haId = this.toHa.get(e.entityId);
        if (haId) this.toSolar.delete(haId);
        this.toHa.delete(e.entityId);
        host.removeEntity(e.entityId);
      }
    }
  }

  private onStates(ev: Record<string, any>, changed: string[], removed: string[]) {
    let unknown = removed.length > 0;
    for (const haId of changed) {
      if (!this.toSolar.has(haId)) {
        if (!SKIPPED_DOMAINS.has(haId.split('.')[0])) unknown = true;
        continue;
      }
      this.push(haId);
    }
    if (unknown && this.state === 'connected') this.resyncSoon();
  }

  private push(haId: string) {
    const id = this.toSolar.get(haId);
    const st = this.cache.get(haId);
    if (!id || !st || !this.host) return;
    const cmd = this.commandContexts.get(haId);
    const parent = cmd && cmd.until > Date.now() ? cmd.context : null;
    this.host.setState(id, st.s, uiAttributes(haId.split('.')[0], st.a), newContext('device', parent));
  }

  private markUnavailable() {
    if (!this.host) return;
    for (const id of this.toSolar.values()) {
      const cur = this.cache.get(this.toHa.get(id)!);
      this.host.setState(id, UNAVAILABLE, cur?.a ?? {});
    }
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const client = this.client;
    const haId = this.toHa.get(call.entityId);
    if (!client?.connected) return { ok: false, message: 'Not connected to Home Assistant' };
    if (!haId) return { ok: false, message: 'Home Assistant no longer has this entity' };
    const now = Date.now();
    for (const [k, v] of this.commandContexts) if (v.until < now) this.commandContexts.delete(k);
    this.commandContexts.set(haId, { context: call.context, until: now + CONTEXT_TTL_MS });
    try {
      await client.command({
        type: 'call_service', domain: haId.split('.')[0], service: call.service, service_data: call.data, target: { entity_id: haId },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * Points Home Assistant's MQTT integration at Sunroost's broker, so Tasmota, Zigbee2MQTT and other
   * MQTT devices work in the full engine too. Only for a local Home Assistant, and only once.
   */
  private async ensureMqtt() {
    const client = this.client;
    if (!client || !isLocalUrl(this.url) || !settings.get('publish_mqtt') || settings.get('mqtt.broker') === 'external') return;
    try {
      const entries = await client.rest<{ domain: string }[]>('GET', '/api/config/config_entries/entry?domain=mqtt');
      if (entries.length) return;
      const step = await client.rest<Record<string, any>>('POST', '/api/config/config_entries/flow', { handler: 'mqtt', show_advanced_options: false });
      if (step.type !== 'form') return;
      // Sunroost's built-in broker (aedes) speaks MQTT 3.1.1; Home Assistant defaults to 5, which it can't connect with.
      const input: Record<string, unknown> = { broker: '127.0.0.1', port: Number(settings.get('mqtt.port')) || 1883, protocol: '3.1.1' };
      if (settings.get('mqtt_username')) Object.assign(input, { username: settings.get('mqtt_username'), password: settings.get('mqtt_password') });
      const done = await client.rest<Record<string, any>>('POST', `/api/config/config_entries/flow/${step.flow_id}`, withDefaults(input, step.data_schema ?? []));
      if (done.type === 'create_entry') log.info("Home Assistant: connected its MQTT integration to Sunroost's broker.");
      else {
        await client.rest('DELETE', `/api/config/config_entries/flow/${step.flow_id}`).catch(() => {});
        log.warn(`Home Assistant: couldn't connect its MQTT integration to Sunroost's broker (${JSON.stringify(done.errors ?? done.reason ?? done.type)}).`);
      }
    } catch (err) {
      log.warn(`Home Assistant MQTT setup: ${(err as Error).message}`);
    }
  }

  // ---------- Integrations (for the Devices page) ----------

  private need(): HaClient {
    if (!this.client?.connected) throw new HaError(this.message ?? 'Not connected to Home Assistant', 'closed');
    return this.client;
  }

  async integrations(): Promise<Integration[]> {
    if (this.catalogueCache && Date.now() - this.catalogueCache.at < CATALOGUE_TTL_MS) return this.catalogueCache.list;
    const list = catalogue(await this.need().command({ type: 'integration/descriptions' }));
    this.catalogueCache = { at: Date.now(), list };
    return list;
  }

  private async translations(domain: string): Promise<Translations> {
    const hit = this.translationCache.get(domain);
    if (hit) return hit;
    const res = await this.need().command<{ resources: Translations }>({
      type: 'frontend/get_translations', language: 'en', category: 'config', integration: [domain],
    });
    // The selector option labels are in the "selector" category.
    const sel = await this.need().command<{ resources: Translations }>({
      type: 'frontend/get_translations', language: 'en', category: 'selector', integration: [domain],
    }).catch(() => ({ resources: {} }));
    const tr = { ...res.resources, ...sel.resources };
    this.translationCache.set(domain, tr);
    return tr;
  }

  private async view(step: Record<string, any>): Promise<FlowView> {
    const handler = String(step.handler);
    const name = (await this.integrations().catch(() => [] as Integration[])).find((i) => i.domain === handler)?.name ?? handler;
    const view = flowView(step, await this.translations(handler), name);
    if (view.type === 'form') this.flowSchemas.set(view.flowId, step.data_schema ?? []);
    else if ('flowId' in view) this.flowSchemas.delete(view.flowId);
    if (view.type === 'create_entry') this.resyncSoon();
    return view;
  }

  async startFlow(handler: string): Promise<FlowView> {
    return this.view(await this.need().rest('POST', '/api/config/config_entries/flow', { handler, show_advanced_options: false }));
  }

  async flowStep(flowId: string, input: Record<string, unknown> | null): Promise<FlowView> {
    const path = `/api/config/config_entries/flow/${encodeURIComponent(flowId)}`;
    if (input === null) return this.view(await this.need().rest('GET', path));
    return this.view(await this.need().rest('POST', path, withDefaults(input, this.flowSchemas.get(flowId) ?? [])));
  }

  async abortFlow(flowId: string): Promise<void> {
    await this.need().rest('DELETE', `/api/config/config_entries/flow/${encodeURIComponent(flowId)}`);
  }

  /** Devices Home Assistant discovered (zeroconf, SSDP, DHCP, Bluetooth …) and waiting for confirmation. */
  async discovered(): Promise<{ flowId: string; handler: string; name: string; title: string; source: string }[]> {
    const flows = await this.need().command<{ flow_id: string; handler: string; context: Record<string, any> }[]>({ type: 'config_entries/flow/progress' });
    const list = await this.integrations().catch(() => [] as Integration[]);
    return flows
      .filter((f) => f.context?.source && f.context.source !== 'user' && f.context.source !== 'reauth' && f.context.source !== 'ignore')
      .map((f) => {
        const name = list.find((i) => i.domain === f.handler)?.name ?? f.handler;
        const ph = f.context.title_placeholders ?? {};
        return { flowId: f.flow_id, handler: f.handler, name, title: String(ph.name ?? ph.title ?? name), source: f.context.source };
      });
  }

  /** Integrations set up in Home Assistant. */
  async entries(): Promise<{ entryId: string; domain: string; title: string; state: string; name: string }[]> {
    const list = await this.integrations().catch(() => [] as Integration[]);
    const raw = await this.need().rest<{ entry_id: string; domain: string; title: string; state: string; source: string }[]>('GET', '/api/config/config_entries/entry');
    // Leave out what Home Assistant set up for itself (onboarding defaults, internals).
    return raw
      .filter((e) => !['system', 'onboarding', 'ignore'].includes(e.source) && !SKIPPED_DOMAINS.has(e.domain) && !INTERNAL_PLATFORMS.has(e.domain))
      .map((e) => ({ entryId: e.entry_id, domain: e.domain, title: e.title, state: e.state, name: list.find((i) => i.domain === e.domain)?.name ?? e.domain }));
  }

  async removeEntry(entryId: string): Promise<void> {
    await this.need().rest('DELETE', `/api/config/config_entries/entry/${encodeURIComponent(entryId)}`);
    this.resyncSoon();
  }

  // ---------- Managing Home Assistant ----------

  /** Restarts Home Assistant (its own restart service; works in a container too). */
  async restart(): Promise<void> {
    await this.need().command({ type: 'call_service', domain: 'homeassistant', service: 'restart' }).catch((err: HaError) => {
      // The connection may close before the answer arrives: that's the restart happening.
      if (err.code !== 'closed') throw err;
    });
  }

  /** Makes a backup in Home Assistant's local store; resolves with its name and date once written. */
  async backup(name = `Sunroost ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`): Promise<{ name: string; date: string }> {
    const c = this.need();
    // Home Assistant refuses new backups until its backup manager is idle (shortly after a start).
    for (let i = 0; ; i++) {
      const info = await c.command<{ state: string }>({ type: 'backup/info' });
      if (info.state === 'idle') break;
      if (i >= 30) throw new HaError(`Home Assistant's backup manager is busy (${info.state})`, 'busy');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const before = new Set((await c.command<{ backups: { backup_id: string }[] }>({ type: 'backup/info' })).backups.map((b) => b.backup_id));
    await c.command({ type: 'backup/generate', agent_ids: ['backup.local'], include_homeassistant: true, include_database: true, name }, 60_000);
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const info = await c.command<{ state: string; backups: { backup_id: string; name: string; date: string }[] }>({ type: 'backup/info' });
      const made = info.backups.find((b) => !before.has(b.backup_id));
      if (made && info.state === 'idle') return { name: made.name, date: made.date };
    }
    throw new HaError('The backup did not finish within 3 minutes', 'timeout');
  }

  private latest: { at: number; version: string | null } | null = null;

  /** The current stable Home Assistant release (cached 6 h); null when offline. */
  async latestVersion(): Promise<string | null> {
    if (this.latest && Date.now() - this.latest.at < CATALOGUE_TTL_MS) return this.latest.version;
    let version: string | null = null;
    try {
      const res = await fetch('https://version.home-assistant.io/stable.json', { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { homeassistant?: { default?: string } };
      version = /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(j.homeassistant?.default ?? '') ? j.homeassistant!.default! : null;
    } catch {}
    this.latest = { at: Date.now(), version };
    return version;
  }

  /**
   * Backs up, then switches the local Home Assistant to `version` (or back to the previous one) with
   * the root-owned update script. Only for the Home Assistant Sunroost installed on this board.
   */
  async update(version: string | 'rollback'): Promise<string> {
    if (!isLocalUrl(this.url)) throw new HaError('Update the Home Assistant at that address from Home Assistant itself.', 'remote');
    if (version !== 'rollback' && !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(version)) throw new HaError('Not a Home Assistant version', 'invalid');
    // Check we may run the update before making a backup for nothing.
    if (!existsSync(UPDATE_SCRIPT) || !(await hasPrivileges())) {
      throw new HaError('Updating needs the Home Assistant that deploy/install.sh installed on this board.', 'update');
    }
    const b = await this.backup(`Before ${version === 'rollback' ? 'rollback' : `update to ${version}`}`);
    log.info(`Home Assistant: backup "${b.name}" made; ${version === 'rollback' ? 'rolling back' : `updating to ${version}`}.`);
    const r = await execPriv(UPDATE_SCRIPT, [version], { timeout: 15 * 60_000 });
    if (!r.ok) throw new HaError(r.denied ? 'Not allowed to update Home Assistant (run deploy/install.sh again).' : r.message || 'Update failed', 'update');
    return r.stdout.trim().split('\n').at(-1) ?? 'Updated';
  }

  info() {
    return {
      state: this.state,
      message: this.message,
      url: this.url,
      local: isLocalUrl(this.url),
      version: this.client?.haVersion || null,
      entities: this.toSolar.size,
      tokenSet: secrets.has(TOKEN_SECRET),
    };
  }
}

/**
 * Completes form input the way Home Assistant's own UI does: every field left out gets its starting
 * value (`initialValue`), and every section is submitted as an object (completed the same way). Home Assistant rejects a form
 * that leaves out a section or a required field even when the schema has a default for it.
 */
export function withDefaults(input: Record<string, unknown>, schema: unknown[]): Record<string, unknown> {
  const out = { ...input };
  for (const raw of schema) {
    const f = raw as Record<string, any>;
    if (typeof f?.name !== 'string') continue;
    if (f.type === 'expandable') {
      const given = out[f.name];
      out[f.name] = withDefaults(given && typeof given === 'object' ? (given as Record<string, unknown>) : {}, f.schema ?? []);
    } else if (out[f.name] === undefined && initialValue(f) !== undefined) {
      out[f.name] = initialValue(f);
    }
  }
  return out;
}

/** Checks a URL and token by connecting; returns the Home Assistant version. */
export async function verifyToken(url: string, token: string): Promise<string> {
  const c = new HaClient(url, token);
  await c.connect();
  const v = c.haVersion;
  c.close();
  return v;
}
