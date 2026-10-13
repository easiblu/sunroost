/**
 * Smart-home subsystem: registries, state machine, service calls, and the device engines.
 *
 * The "energy" engine always runs. One device engine runs next to it: "full" (every Home Assistant
 * integration) on boards that can run it, otherwise "lite" (Sunroost's own drivers). `home.engine`
 * overrides the choice. Full needs a Home Assistant: the one deploy/install.sh runs on this board, or
 * one elsewhere (`home.full_url` plus a token). Until one is reachable, lite stands in and Sunroost
 * checks again every minute.
 */
import { logger } from '../core/log.ts';
import * as secrets from '../core/secrets.ts';
import { settings } from '../core/settings.ts';
import { hardwareProfile } from '../system/index.ts';
import type { BoardProfile } from '../system/board.ts';
import * as areas from './areas.ts';
import * as history from './history.ts';
import { EnergyEngine } from './energy.ts';
import { FullEngine, isLocalUrl, TOKEN_SECRET } from './full/index.ts';
import { onboardingStatus } from './full/onboard.ts';
import { GroupEngine } from './groups.ts';
import { LiteEngine } from './lite/index.ts';
import { BROKER_KEYS } from './lite/mqtt/broker.ts';
import { DemoDevices } from './lite/mqtt/demo.ts';
import * as registry from './registry.ts';
import { setEngineLookup } from './services.ts';
import * as states from './states.ts';
import { UNAVAILABLE, type DeviceEngine, type EngineHost, type EngineId } from './types.ts';

export { bus, newContext } from './bus.ts';
export { callService } from './services.ts';
export { areas, history, registry, states };
export { GroupError } from './groups.ts';

/** Always running, so groups exist whichever device engine is active. */
export const groups = new GroupEngine();

const log = logger('home');
const running = new Map<EngineId, DeviceEngine>();
let demo: DemoDevices | null = null;
let demoRestart: NodeJS.Timeout | null = null;
/** Serializes engine switches so quick setting changes can't interleave starts and stops. */
let queue: Promise<void> = Promise.resolve();

let fullProbe: NodeJS.Timeout | null = null;
const FULL_PROBE_MS = 60_000;

/** The running full engine, for the integrations API. */
export const fullEngine = () => (running.get('full') as FullEngine | undefined) ?? null;
export const liteEngine = () => (running.get('lite') as LiteEngine | undefined) ?? null;

/** What the Devices page's "Add integration" talks to: both engines offer it. */
export type IntegrationProvider = Pick<FullEngine, 'integrations' | 'entries' | 'removeEntry' | 'discovered' | 'startFlow' | 'flowStep' | 'abortFlow'>;

/** Home Assistant when connected, otherwise the lite engine's drivers. */
export function integrationEngine(): IntegrationProvider | null {
  const full = fullEngine();
  if (full) return full.info().state === 'connected' ? full : null;
  return liteEngine();
}

/** A Home Assistant Sunroost can use: linked before (token stored), or reachable now. */
async function fullAvailable(): Promise<boolean> {
  if (secrets.has(TOKEN_SECRET)) return true;
  return (await onboardingStatus(settings.get('home.full_url'))) !== null;
}

/** The engine API, scoped so an engine can only touch its own devices and entities. */
export function hostFor(engine: EngineId): EngineHost {
  return {
    registerDevice: (input) => {
      const isNew = !registry.allDevices(engine).some((d) => d.uniqueId === input.uniqueId);
      const d = registry.registerDevice(engine, input);
      // A room suggested by the engine (Home Assistant's area) applies only when the device first appears.
      if (isNew && input.suggestedArea) {
        const name = input.suggestedArea;
        const area = areas.list().find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? areas.create(name);
        if (area) return registry.updateDevice(d.id, { areaId: area.id })!;
      }
      return d;
    },
    registerEntity: (input) => {
      const e = registry.registerEntity(engine, input);
      if (!states.get(e.entityId)) states.set(e.entityId, UNAVAILABLE);
      return e;
    },
    removeEntity: (entityId) => {
      if (registry.entity(entityId)?.engine !== engine) return;
      registry.removeEntity(entityId);
      states.remove(entityId);
    },
    removeDevice: (deviceId) => {
      if (registry.device(deviceId)?.engine !== engine) return;
      for (const id of registry.removeDevice(deviceId)) states.remove(id);
    },
    setState: (entityId, state, attributes, context) => {
      const e = registry.entity(entityId);
      // Removed meanwhile (a poll finishing after its device was deleted): normal for network drivers.
      if (!e) return;
      if (e.engine !== engine) {
        log.error(`${engine} engine tried to set ${entityId}, which belongs to the ${e.engine} engine.`);
        return;
      }
      states.set(entityId, state, attributes, context);
    },
    entities: () => registry.allEntities(engine),
    devices: () => registry.allDevices(engine),
  };
}

async function startEngine(engine: DeviceEngine) {
  try {
    await engine.start(hostFor(engine.id));
    running.set(engine.id, engine);
  } catch (err) {
    log.error(`${engine.name} failed to start: ${(err as Error).message}`);
  }
}

export interface EngineStatus {
  /** The setting: auto, lite or full. */
  setting: 'auto' | 'lite' | 'full';
  /** What `auto` resolves to on this board. */
  recommended: 'lite' | 'full';
  /** The device engine the setting asks for on this board. */
  selected: 'lite' | 'full';
  /** The device engine actually running (lite stands in while full isn't installed). */
  active: 'lite' | 'full' | null;
  demoDevices: boolean;
  /** Whether "Add integration" is available (Home Assistant connected, or the lite engine). */
  integrations: boolean;
  /** Devices from an engine not in use any more, ready to be cleaned up. */
  leftovers: number;
  board: BoardProfile;
  engines: { id: EngineId; name: string; running: boolean; info: Record<string, unknown> | null }[];
}

async function selectedEngine(): Promise<{ board: BoardProfile; selected: 'lite' | 'full'; remote: boolean }> {
  const board = await hardwareProfile();
  const setting = settings.get('home.engine');
  // A board that can't run Home Assistant itself can still use one elsewhere on the network.
  const remote = !isLocalUrl(settings.get('home.full_url'));
  const selected = setting === 'auto' ? board.engine.recommended : setting === 'full' && board.engine.full === 'no' && !remote ? 'lite' : setting;
  return { board, selected, remote };
}

/** Devices left by an engine that isn't running (e.g. after switching from lite to full), all unavailable. */
export function leftovers(): { engine: EngineId; deviceId: string; name: string }[] {
  return registry
    .allDevices()
    .filter((d) => d.engine !== 'energy' && d.engine !== 'group' && !running.has(d.engine))
    .filter((d) => registry.allEntities().filter((e) => e.deviceId === d.id).every((e) => (states.get(e.entityId)?.state ?? UNAVAILABLE) === UNAVAILABLE))
    .map((d) => ({ engine: d.engine, deviceId: d.id, name: registry.deviceName(d) }));
}

/** Removes those leftover devices; returns how many. */
export function removeLeftovers(): number {
  const list = leftovers();
  for (const l of list) for (const id of registry.removeDevice(l.deviceId)) states.remove(id);
  if (list.length) log.info(`Smart devices: removed ${list.length} leftover device${list.length === 1 ? '' : 's'} from an engine no longer in use.`);
  return list.length;
}

export async function engineStatus(): Promise<EngineStatus> {
  const { board, selected } = await selectedEngine();
  const names: Record<EngineId, string> = {
    energy: 'Sunroost energy data', lite: 'Built-in device drivers', full: 'Home Assistant integrations', group: 'Groups',
  };
  return {
    setting: settings.get('home.engine'),
    recommended: board.engine.recommended,
    selected,
    active: running.has('full') ? 'full' : running.has('lite') ? 'lite' : null,
    demoDevices: settings.get('home.demo_devices'),
    integrations: integrationEngine() !== null,
    leftovers: leftovers().length,
    board,
    engines: (['energy', 'lite', 'full', 'group'] as EngineId[]).map((id) => ({
      id, name: names[id], running: running.has(id), info: running.get(id)?.info?.() ?? null,
    })),
  };
}

function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch((err) => log.error(`Smart devices: ${(err as Error).message}`));
  return queue;
}

/** Starts or switches the device engine to match the settings and board. */
async function applyEngine() {
  const { board, selected } = await selectedEngine();
  const wanted = selected === 'full' && (await fullAvailable()) ? 'full' : 'lite';
  const current = running.has('full') ? 'full' : running.has('lite') ? 'lite' : null;
  if (current !== wanted) {
    await stopDemo(false);
    if (current) {
      await running.get(current)!.stop().catch(() => {});
      running.delete(current);
    }
    await startEngine(wanted === 'full' ? new FullEngine() : new LiteEngine());
    const note = selected === 'full' && wanted === 'lite' ? ' (standing in until Home Assistant is reachable)' : '';
    log.info(`Smart devices on ${board.name}: ${wanted} device engine${note}.`);
  }
  // While lite stands in for full, look for Home Assistant now and then.
  if (fullProbe) clearInterval(fullProbe);
  fullProbe = selected === 'full' && wanted === 'lite' ? setInterval(() => void enqueue(applyEngine), FULL_PROBE_MS) : null;
  await applyDemo();
}

/** After a new Home Assistant URL or token: switch to (or reconnect) the full engine. */
export function relinkFull() {
  return enqueue(async () => {
    fullEngine()?.reconnect();
    await applyEngine();
  });
}

async function applyDemo() {
  const want = settings.get('home.demo_devices') && running.has('lite');
  if (want && !demo) {
    demo = new DemoDevices();
    demo.start();
  } else if (!want && demo) {
    await stopDemo(settings.get('home.demo_devices') === false);
  }
}

async function stopDemo(remove: boolean) {
  const d = demo;
  demo = null;
  await d?.stop(remove);
}

function onSetting(key: string) {
  if (key === 'home.engine') {
    void enqueue(applyEngine);
    return;
  }
  if (key === 'home.full_url') {
    void relinkFull();
    return;
  }
  if (key !== 'home.demo_devices' && !(settings.get('home.demo_devices') && BROKER_KEYS.includes(key as never))) return;
  // Wait for the MQTT module to (re)start its broker, which the same settings change may have triggered.
  if (demoRestart) clearTimeout(demoRestart);
  demoRestart = setTimeout(() => void enqueue(async () => {
    if (demo && settings.get('home.demo_devices')) await stopDemo(false); // reconnect to the moved broker
    await applyDemo();
  }), 600);
}

export async function start() {
  registry.init();
  areas.init();
  history.start();
  // Like Home Assistant's restored entities: everything known starts unavailable until its engine reports.
  for (const e of registry.allEntities()) states.set(e.entityId, UNAVAILABLE);
  setEngineLookup((id) => running.get(id) ?? null);
  await startEngine(new EnergyEngine());
  await startEngine(groups);
  settings.on('change', onSetting);
  await enqueue(applyEngine);
}

export async function stop() {
  settings.off('change', onSetting);
  if (fullProbe) clearInterval(fullProbe);
  if (demoRestart) clearTimeout(demoRestart);
  await queue;
  // Engines first, so the driver doesn't see the demo devices going offline as removals.
  for (const engine of [...running.values()].reverse()) await engine.stop().catch(() => {});
  running.clear();
  await stopDemo(false);
  history.stop();
}
