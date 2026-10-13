/**
 * The "energy" engine: Sunroost's own readings as read-only entities, so rules and the UI treat
 * battery charge, PV power, grid availability and the forecast exactly like device states.
 *
 *   system totals ("Battery state of charge") → sensor.battery_state_of_charge
 *   today's energy                            → sensor.pv_energy_today, sensor.grid_import_energy_today …
 *   grid provider metrics ("Price")           → sensor.grid_price
 *   grid availability                         → binary_sensor.grid_available
 *   weather                                   → sensor.solar_radiation_today / _tomorrow, sensor.outdoor_temperature
 */
import * as alerts from '../alerts/index.ts';
import { outlookMetrics } from '../energy/index.ts';
import { meta, snake, type Metrics, type Value } from '../core/metrics.ts';
import { state, type EnergyToday, type Snapshot } from '../core/state.ts';
import * as weather from '../weather/index.ts';
import { newContext } from './bus.ts';
import { UNAVAILABLE, UNKNOWN, type Context, type DeviceEngine, type EngineHost, type EntityInput, type ServiceResult } from './types.ts';

const ENERGY_TODAY: [keyof EnergyToday, string][] = [
  ['pv', 'PV energy today'],
  ['load', 'Load energy today'],
  ['gridImport', 'Grid import energy today'],
  ['gridExport', 'Grid export energy today'],
  ['batteryCharge', 'Battery charge energy today'],
  ['batteryDischarge', 'Battery discharge energy today'],
];

const stateText = (v: Value) => (v === null || v === undefined ? UNKNOWN : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/** Grid availability from the outage alert and the grid voltage; null when there's no reading. */
export function gridAvailable(totals: Metrics, outageAlert: boolean): boolean | null {
  if (outageAlert) return false;
  const v = totals['Grid voltage'];
  return typeof v === 'number' ? v >= 100 : null;
}

export class EnergyEngine implements DeviceEngine {
  id = 'energy' as const;
  name = 'Sunroost energy data';
  private host: EngineHost | null = null;
  /** uniqueId → entityId for everything registered in this run. */
  private known = new Map<string, string>();
  /** uniqueIds re-registered since start, so engine-side changes (unit, name) reach the registry once per run. */
  private registered = new Set<string>();
  private deviceIds: Record<'system' | 'grid' | 'weather', string> = { system: '', grid: '', weather: '' };
  private onRefresh = (snap: Snapshot) => this.update(snap);

  async start(host: EngineHost) {
    this.host = host;
    for (const e of host.entities()) this.known.set(e.uniqueId, e.entityId);
    this.deviceIds.system = host.registerDevice({ uniqueId: 'system', name: 'Sunroost system', manufacturer: 'Sunroost' }).id;
    this.deviceIds.grid = host.registerDevice({ uniqueId: 'grid', name: 'Grid', manufacturer: 'Sunroost' }).id;
    this.deviceIds.weather = host.registerDevice({ uniqueId: 'weather', name: 'Weather forecast', manufacturer: 'Open-Meteo' }).id;
    state.on('refresh', this.onRefresh);
    this.update(state.snapshot());
  }

  async stop() {
    state.off('refresh', this.onRefresh);
    this.host = null;
  }

  async callService(): Promise<ServiceResult> {
    return { ok: false, message: 'Energy readings are read-only' };
  }

  private entity(input: Omit<EntityInput, 'readOnly'>): string {
    const known = this.known.get(input.uniqueId);
    if (known && this.registered.has(input.uniqueId)) return known;
    const e = this.host!.registerEntity({ ...input, readOnly: true });
    this.known.set(input.uniqueId, e.entityId);
    this.registered.add(input.uniqueId);
    return e.entityId;
  }

  private set(entityId: string, value: string, ctx: Context, attributes: Record<string, unknown> = {}) {
    this.host!.setState(entityId, value, attributes, ctx);
  }

  /** Exposed for tests: maps one snapshot (plus alerts and weather) onto entity states. */
  update(snap: Snapshot) {
    if (!this.host) return;
    const ctx = newContext('device');
    const connected = snap.status.inverter.name === 'connected' || snap.status.battery.name === 'connected';
    const seen = new Set<string>();

    // System totals
    for (const [name, value] of Object.entries(snap.totals)) {
      const m = meta(name);
      if (m.info) continue;
      const uniqueId = `total:${name}`;
      const id = this.entity({
        uniqueId, domain: 'sensor', name, objectId: snake(name), deviceId: this.deviceIds.system,
        unit: m.unit ?? null, deviceClass: m.deviceClass ?? null,
      });
      seen.add(uniqueId);
      this.set(id, connected ? stateText(value) : UNAVAILABLE, ctx);
    }

    // Today's energy (kWh)
    for (const [key, name] of ENERGY_TODAY) {
      const uniqueId = `energy:${key}`;
      const id = this.entity({
        uniqueId, domain: 'sensor', name, objectId: snake(name), deviceId: this.deviceIds.system, unit: 'kWh', deviceClass: 'energy',
      });
      seen.add(uniqueId);
      this.set(id, snap.energy ? String(snap.energy[key]) : UNKNOWN, ctx);
    }

    // Grid provider metrics and availability
    for (const [name, value] of Object.entries(snap.grid)) {
      const uniqueId = `grid:${name}`;
      const objectId = /^grid\b/i.test(name) ? snake(name) : `grid_${snake(name)}`;
      const id = this.entity({ uniqueId, domain: 'sensor', name: /^grid\b/i.test(name) ? name : `Grid ${name.toLowerCase()}`, objectId, deviceId: this.deviceIds.grid });
      seen.add(uniqueId);
      this.set(id, stateText(value), ctx);
    }
    const avail = gridAvailable(snap.totals, alerts.list().active.some((a) => a.id === 'grid-outage'));
    const gridId = this.entity({
      uniqueId: 'grid:available', domain: 'binary_sensor', name: 'Grid available', objectId: 'grid_available',
      deviceId: this.deviceIds.grid, deviceClass: 'power',
    });
    seen.add('grid:available');
    this.set(gridId, !connected ? UNAVAILABLE : avail === null ? UNKNOWN : avail ? 'on' : 'off', ctx);

    // Weather and solar forecast
    const w = weather.current().weather;
    const day = (i: number) => w?.daily[i];
    const forecast: [string, string, number | null | undefined, string | null, string | null, Record<string, unknown>][] = [
      ['weather:radiation_today', 'Solar radiation today', day(0)?.radiationMj, 'MJ/m²', null, { date: day(0)?.date }],
      ['weather:radiation_tomorrow', 'Solar radiation tomorrow', day(1)?.radiationMj, 'MJ/m²', null, { date: day(1)?.date }],
      ['weather:temperature', 'Outdoor temperature', w?.current.temperature, '°C', 'temperature', { condition: w?.current.text }],
    ];
    for (const [uniqueId, name, value, unit, deviceClass, attributes] of forecast) {
      const id = this.entity({ uniqueId, domain: 'sensor', name, objectId: snake(name), deviceId: this.deviceIds.weather, unit, deviceClass });
      seen.add(uniqueId);
      this.set(id, value === null || value === undefined ? UNKNOWN : String(value), ctx, w ? attributes : {});
    }

    // Solar surplus and expected solar (src/energy).
    for (const [name, value] of Object.entries(outlookMetrics(snap.totals))) {
      const m = meta(name);
      const uniqueId = `outlook:${name}`;
      const id = this.entity({ uniqueId, domain: 'sensor', name, objectId: snake(name), deviceId: this.deviceIds.system, unit: m.unit ?? null, deviceClass: m.deviceClass ?? null });
      seen.add(uniqueId);
      this.set(id, value === null ? UNKNOWN : String(value), ctx);
    }

    // Metrics that disappeared (inverter swapped, provider changed) become unavailable, not deleted.
    for (const [uniqueId, entityId] of this.known) {
      if (!seen.has(uniqueId)) this.set(entityId, UNAVAILABLE, ctx);
    }
  }
}
