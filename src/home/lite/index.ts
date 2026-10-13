/**
 * The lite device engine: Sunroost's own drivers, light enough for every supported board (Pi 1 and
 * up). Each driver registers entities whose uniqueId starts with its id ("mqtt:…"), which is how
 * commands are routed back to it.
 *
 * It also offers the same integration API as the full engine (catalogue, config flows, discovered
 * devices, entries), so the Devices page's "Add integration" works with either engine.
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../../core/log.ts';
import type { FlowView, Integration } from '../full/flows.ts';
import type { DeviceEngine, EngineHost, ServiceCall, ServiceResult } from '../types.ts';
import { Discovery } from './discovery/index.ts';
import * as entries from './entries.ts';
import { EsphomeDriver } from './esphome/index.ts';
import { HueDriver } from './hue/index.ts';
import { KasaDriver } from './kasa/index.ts';
import { ModbusDriver } from './modbus/index.ts';
import { MqttDiscoveryDriver } from './mqtt/index.ts';
import { ShellyDriver } from './shelly/index.ts';
import { TasmotaDriver } from './tasmota/index.ts';
import { TuyaDriver } from './tuya/index.ts';
import { WizDriver } from './wiz/index.ts';
import type { Candidate, FlowContext, FlowStep, Found, LiteDriver, LiteEntry } from './types.ts';

const log = logger('home');
/** Unfinished flows are dropped after this long. */
const FLOW_TTL_MS = 60 * 60_000;

/** Every driver, in catalogue order. Add new drivers here. */
export function allDrivers(): LiteDriver[] {
  return [
    new MqttDiscoveryDriver(), new TasmotaDriver(), new ShellyDriver(), new EsphomeDriver(), new HueDriver(),
    new KasaDriver(), new TuyaDriver(), new WizDriver(), new ModbusDriver(),
  ];
}

interface RunningFlow {
  id: string;
  driver: LiteDriver;
  ctx: FlowContext;
  stepId: string | null;
  at: number;
}

export class LiteEngine implements DeviceEngine {
  id = 'lite' as const;
  name = 'Built-in device drivers';
  readonly drivers: LiteDriver[];
  private host: EngineHost | null = null;
  private discovery: Discovery | null = null;
  private flows = new Map<string, RunningFlow>();
  /** driver id → uniqueId → candidate (each with a ready flow id). */
  private candidates = new Map<string, Map<string, { candidate: Candidate; flowId: string; source: string }>>();

  constructor(drivers: LiteDriver[] = allDrivers()) {
    this.drivers = drivers;
  }

  async start(host: EngineHost) {
    this.host = host;
    entries.init();
    this.discovery = new Discovery((f) => this.found(f));
    for (const d of this.drivers) {
      this.discovery.want(d.mdnsTypes, d.ssdpTargets);
      try {
        await d.start({
          host,
          log,
          entries: () => entries.list(d.id),
          updateEntry: (id, data, title) => entries.update(id, data, title),
          candidate: (c) => this.addCandidate(d, c, 'udp'),
        });
        for (const e of entries.list(d.id)) await d.entryAdded?.(e).catch((err) => log.warn(`${d.name}: ${e.title}: ${(err as Error).message}`));
      } catch (err) {
        log.error(`${d.name} failed to start: ${(err as Error).message}`);
      }
    }
    this.discovery.start();
  }

  async stop() {
    this.discovery?.stop();
    this.discovery = null;
    for (const d of [...this.drivers].reverse()) await d.stop().catch(() => {});
    this.flows.clear();
    this.candidates.clear();
    this.host = null;
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    const entry = this.host?.entities().find((e) => e.entityId === call.entityId);
    const driver = entry && this.drivers.find((d) => entry.uniqueId.startsWith(d.id + ':'));
    if (!driver) return { ok: false, message: 'No driver handles this device' };
    return driver.callService(call);
  }

  info() {
    return { drivers: this.drivers.map((d) => ({ id: d.id, name: d.name, ...d.status() })) };
  }

  /** Sends discovery queries now (the Devices page's "Scan"). */
  scan() {
    this.discovery?.query();
  }

  // ---------- Discovery → candidates ----------

  /** Exposed for tests: feeds a network finding to every driver. */
  found(f: Found) {
    for (const d of this.drivers) {
      if (!d.discover) continue;
      let c: Candidate | null = null;
      try {
        c = d.discover(f);
      } catch {
        continue;
      }
      if (c) this.addCandidate(d, c, f.source);
    }
  }

  private addCandidate(d: LiteDriver, c: Candidate, source: string) {
    if (!d.flow || entries.findUnique(d.id, c.uniqueId) || entries.isIgnored(d.id, c.uniqueId)) return;
    const byDriver = this.candidates.get(d.id) ?? new Map();
    this.candidates.set(d.id, byDriver);
    const old = byDriver.get(c.uniqueId);
    if (old) {
      old.candidate = c; // address may have changed
      const f = this.flows.get(old.flowId);
      if (f) f.ctx.discovered = c;
      return;
    }
    const flowId = this.newFlow(d, c);
    byDriver.set(c.uniqueId, { candidate: c, flowId, source });
    log.info(`${d.name}: found ${c.title}.`);
  }

  private newFlow(d: LiteDriver, discovered: Candidate | null): string {
    const now = Date.now();
    for (const [id, f] of this.flows) if (now - f.at > FLOW_TTL_MS && !this.isCandidateFlow(id)) this.flows.delete(id);
    const id = randomBytes(10).toString('hex');
    this.flows.set(id, { id, driver: d, ctx: { discovered, state: {} }, stepId: null, at: now });
    return id;
  }

  private isCandidateFlow(flowId: string) {
    for (const m of this.candidates.values()) for (const c of m.values()) if (c.flowId === flowId) return true;
    return false;
  }

  // ---------- Integration API (same shape as FullEngine) ----------

  async integrations(): Promise<Integration[]> {
    return this.drivers
      .filter((d) => d.flow)
      .map((d) => ({ domain: d.id, name: d.name, iotClass: d.iotClass ?? 'local_polling', brand: null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async discovered() {
    const out: { flowId: string; handler: string; name: string; title: string; source: string }[] = [];
    for (const [driverId, m] of this.candidates) {
      const d = this.drivers.find((x) => x.id === driverId)!;
      for (const [uid, c] of m) {
        if (entries.findUnique(driverId, uid) || entries.isIgnored(driverId, uid)) {
          m.delete(uid);
          continue;
        }
        out.push({ flowId: c.flowId, handler: driverId, name: d.name, title: c.candidate.title, source: c.source === 'udp' ? 'dhcp' : c.source === 'mdns' ? 'zeroconf' : c.source });
      }
    }
    return out;
  }

  async entries() {
    return entries.list().map((e) => ({
      entryId: e.id, domain: e.driver, title: e.title, state: 'loaded',
      name: this.drivers.find((d) => d.id === e.driver)?.name ?? e.driver,
    }));
  }

  async removeEntry(entryId: string) {
    const e = entries.get(entryId);
    if (!e) throw new Error('Unknown integration entry');
    const d = this.drivers.find((x) => x.id === e.driver);
    await d?.entryRemoved?.(e);
    // Devices registered for this entry carry its id in their config.
    if (this.host) for (const dev of this.host.devices()) if (dev.config.entryId === e.id) this.host.removeDevice(dev.id);
    entries.remove(entryId);
  }

  async startFlow(handler: string): Promise<FlowView> {
    const d = this.drivers.find((x) => x.id === handler && x.flow);
    if (!d) throw new Error(`No setup for "${handler}"`);
    const id = this.newFlow(d, null);
    return this.run(id, null);
  }

  async flowStep(flowId: string, input: Record<string, unknown> | null): Promise<FlowView> {
    if (!this.flows.has(flowId)) throw new Error('This setup has expired; start it again');
    return this.run(flowId, input);
  }

  async abortFlow(flowId: string) {
    const f = this.flows.get(flowId);
    this.flows.delete(flowId);
    // Dismissing a discovered device keeps it dismissed.
    if (f?.ctx.discovered) {
      entries.ignore(f.driver.id, f.ctx.discovered.uniqueId);
      this.candidates.get(f.driver.id)?.delete(f.ctx.discovered.uniqueId);
    }
  }

  private async run(flowId: string, input: Record<string, unknown> | null): Promise<FlowView> {
    const f = this.flows.get(flowId)!;
    const d = f.driver;
    let step: FlowStep;
    try {
      step = f.stepId === null || input === null ? await d.flow!.start(f.ctx) : await d.flow!.submit(f.ctx, f.stepId, input);
    } catch (err) {
      step = { type: 'abort', reason: (err as Error).message };
    }
    f.at = Date.now();
    if (step.type === 'form') {
      f.stepId = step.stepId;
      return {
        type: 'form', flowId, handler: d.id, stepId: step.stepId, title: step.title ?? d.name, description: step.description ?? null,
        fields: step.fields, errors: step.errors ?? {}, lastStep: null,
      };
    }
    this.flows.delete(flowId);
    if (f.ctx.discovered) this.candidates.get(d.id)?.delete(f.ctx.discovered.uniqueId);
    if (step.type === 'abort') return { type: 'abort', handler: d.id, title: d.name, reason: step.reason };
    if (step.uniqueId && entries.findUnique(d.id, step.uniqueId)) {
      return { type: 'abort', handler: d.id, title: d.name, reason: 'This device is already set up.' };
    }
    const entry = entries.add(d.id, step.title, step.uniqueId, step.data);
    try {
      await d.entryAdded?.(entry);
    } catch (err) {
      log.warn(`${d.name}: ${entry.title}: ${(err as Error).message}`);
    }
    log.info(`${d.name}: set up ${entry.title}.`);
    return { type: 'create_entry', handler: d.id, title: entry.title, description: null };
  }
}

export type { LiteEntry };
