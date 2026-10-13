/**
 * Live system state: the latest metrics per inverter and battery pack, grid-provider data,
 * and derived "total" metrics for the whole system. Every subsystem reads from here and
 * the web UI receives a snapshot on each 'refresh'.
 */
import { EventEmitter } from 'node:events';
import { meta, type Metrics, type Value } from './metrics.ts';

export type DeviceStatusName = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface DeviceStatus {
  name: DeviceStatusName;
  message: string;
}

/** Energy totals for the current period, in kWh, maintained by the stats module. */
export interface EnergyToday {
  day: string;
  pv: number;
  load: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
}

export interface Snapshot {
  ts: number;
  inverters: Metrics[];
  batteries: Metrics[];
  grid: Metrics;
  totals: Metrics;
  energy: EnergyToday | null;
  status: { inverter: DeviceStatus; battery: DeviceStatus };
}

/** Prefer the BMS for these when one is connected. */
const BANK_FROM_BMS: [string, string, 'sum' | 'avg'][] = [
  ['State of charge', 'Battery state of charge', 'avg'],
  ['State of health', 'Battery state of health', 'avg'],
  ['Power', 'Battery power', 'sum'],
  ['Current', 'Battery current', 'sum'],
  ['Voltage', 'Battery voltage', 'avg'],
  ['Temperature', 'Battery temperature', 'avg'],
];

const MIN_REFRESH_MS = 500;

class State extends EventEmitter {
  inverters: Metrics[] = [];
  batteries: Metrics[] = [];
  grid: Metrics = {};
  totals: Metrics = {};
  energy: EnergyToday | null = null;
  status = {
    inverter: { name: 'disconnected', message: 'Not connected' } as DeviceStatus,
    battery: { name: 'disconnected', message: 'Not connected' } as DeviceStatus,
  };
  lastUpdate = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefresh = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  updateInverter(index: number, metrics: Metrics) {
    this.inverters[index] = { ...this.inverters[index], ...metrics };
    this.changed();
  }

  updateBattery(index: number, metrics: Metrics) {
    this.batteries[index] = { ...this.batteries[index], ...metrics };
    this.changed();
  }

  updateGrid(metrics: Metrics) {
    this.grid = { ...this.grid, ...metrics };
    this.changed();
  }

  setEnergy(energy: EnergyToday) {
    this.energy = energy;
  }

  setStatus(device: 'inverter' | 'battery', name: DeviceStatusName, message: string) {
    this.status[device] = { name, message };
    this.emit('status', device, this.status[device]);
    this.changed();
  }

  clear(device: 'inverter' | 'battery') {
    if (device === 'inverter') this.inverters = [];
    else this.batteries = [];
    this.changed();
  }

  /** Value of a total metric, e.g. state.total('Battery state of charge'). */
  total(name: string): Value {
    return this.totals[name] ?? null;
  }

  snapshot(): Snapshot {
    return {
      ts: this.lastUpdate,
      inverters: this.inverters,
      batteries: this.batteries,
      grid: this.grid,
      totals: this.totals,
      energy: this.energy,
      status: this.status,
    };
  }

  private changed() {
    this.lastUpdate = Date.now();
    this.totals = this.deriveTotals();
    // Coalesce bursts (several inverters/packs updating in the same tick) into one refresh.
    if (this.refreshTimer) return;
    const wait = Math.max(0, MIN_REFRESH_MS - (Date.now() - this.lastRefresh));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.lastRefresh = Date.now();
      this.emit('refresh', this.snapshot());
    }, wait);
  }

  private deriveTotals(): Metrics {
    const totals: Metrics = {};
    const numeric: Record<string, number[]> = {};
    for (const inv of this.inverters) {
      if (!inv) continue;
      for (const [name, value] of Object.entries(inv)) {
        if (typeof value === 'number') (numeric[name] ??= []).push(value);
        else if (!(name in totals)) totals[name] = value;
      }
    }
    for (const [name, values] of Object.entries(numeric)) {
      totals[name] = combine(values, meta(name).agg ?? 'avg');
    }
    const packs = this.batteries.filter(Boolean);
    if (packs.length) {
      for (const [packName, totalName, agg] of BANK_FROM_BMS) {
        const values = packs.map((p) => p[packName]).filter((v): v is number => typeof v === 'number');
        if (values.length) totals[totalName] = combine(values, agg);
      }
    }
    return totals;
  }
}

function combine(values: number[], agg: 'sum' | 'avg') {
  const sum = values.reduce((a, b) => a + b, 0);
  const v = agg === 'sum' ? sum : sum / values.length;
  return Math.round(v * 100) / 100;
}

export const state = new State();
