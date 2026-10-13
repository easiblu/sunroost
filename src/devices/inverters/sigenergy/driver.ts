/** The Sigenergy Modbus TCP driver (read-only): plant totals on unit 247, inverter details on unit 1. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  AC_MAP, AC_SPAN, decodeTable, image, INFO_MAP, INFO_SPAN, INVERTER_MAP, INVERTER_SPAN, INVERTER_UNIT,
  PLANT_MAP, PLANT_PHASE_MAP, PLANT_SPAN, PLANT_UNIT, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPAN, SIGEN_SETTINGS } from './settings.ts';

export interface SigenModel {
  id: string;
  name: string;
  phases: 1 | 3;
}

export const MODELS: SigenModel[] = [
  { id: 'hybrid', name: 'SigenStor EC single-phase hybrid (SP)', phases: 1 },
  { id: 'hybrid3', name: 'SigenStor EC three-phase hybrid (TP)', phases: 3 },
];

/** Unknown ids fall back to single-phase. */
export function sigenModel(id: string): SigenModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/** Model type string → model id: "… SP" single-phase, "… TP" three-phase. */
export function modelFromName(name: string): string | undefined {
  if (/\bTP\b|three[- ]?phase/i.test(name)) return 'hybrid3';
  if (/\bSP\b|single[- ]?phase/i.test(name)) return 'hybrid';
  return undefined;
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/**
 * Plant + inverter images → Sunroost metrics. `plant` holds unit-247 input registers,
 * `inverter` unit-1 input registers (either may be partial).
 */
export function decodeLive(model: SigenModel, plant: RegisterImage, inverter: RegisterImage): Metrics {
  const p = decodeTable(model.phases === 3 ? [...PLANT_MAP, ...PLANT_PHASE_MAP] : PLANT_MAP, plant);
  const inv = decodeTable([...INVERTER_MAP, ...AC_MAP], inverter);
  const out: Metrics = {};

  // Plant totals first; inverter values fill gaps.
  out['PV power'] = has(p, 'PV power') ? p['PV power'] : num(inv, 'Inverter PV power');
  out['Battery power'] = has(p, 'Battery power') ? p['Battery power'] : num(inv, 'Inverter battery power');
  if (has(p, 'Battery state of charge')) out['Battery state of charge'] = p['Battery state of charge'];
  else if (has(inv, 'Inverter battery SOC')) out['Battery state of charge'] = inv['Inverter battery SOC'];
  const grid = num(p, 'Grid power');
  out['Grid power'] = grid;
  const ac = has(p, 'Plant active power') ? num(p, 'Plant active power') : num(inv, 'Inverter power');
  out['Inverter power'] = ac;
  // No load register in the V1/V2 maps: load = inverter AC output + grid import (UNVERIFIED balance).
  out['Load power'] = Math.max(0, round(ac + grid, 0));

  for (const k of ['EMS work mode', 'Grid status', 'Grid sensor status']) if (p[k] !== undefined) out[k] = p[k];
  for (const k of [
    'Battery state of health', 'Battery temperature', 'Battery cell voltage average', 'Battery temperature max',
    'Battery temperature min', 'Battery cell voltage max', 'Battery cell voltage min', 'Grid frequency',
    'Temperature', 'Power factor', 'Inverter state',
  ]) if (inv[k] !== undefined) out[k] = inv[k];

  // Device mode: plant running state, refined to "Off-grid" when running islanded.
  const state = p['Plant running state'] ?? inv['Inverter state'];
  if (typeof state === 'string') {
    const offGrid = typeof p['Grid status'] === 'string' && p['Grid status'] !== 'On-grid';
    out['Device mode'] = state === 'Running' && offGrid ? 'Off-grid' : state;
  }

  // PV strings: power per string from V × I.
  const strings = Math.min(4, Math.max(1, num(inv, 'PV string count') || 2));
  for (let n = 1; n <= strings; n++) {
    if (!has(inv, `PV voltage ${n}`)) continue;
    const v = num(inv, `PV voltage ${n}`);
    const i = num(inv, `PV current ${n}`);
    out[`PV voltage ${n}`] = v;
    out[`PV current ${n}`] = i;
    out[`PV power ${n}`] = round(v * i, 0);
  }

  // AC side. Three-phase: numbered values plus the L1 voltage as the headline value.
  if (model.phases === 3) {
    for (const ph of [1, 2, 3]) {
      for (const k of ['Grid voltage', 'AC output current', 'Grid power']) {
        const src = k === 'Grid power' ? p : inv;
        if (src[`${k} ${ph}`] !== undefined) out[`${k} ${ph}`] = src[`${k} ${ph}`];
      }
    }
  } else if (has(inv, 'AC output current 1')) {
    out['AC output current'] = inv['AC output current 1'];
  }
  if (has(inv, 'Grid voltage 1')) {
    out['Grid voltage'] = inv['Grid voltage 1'];
    out['AC output voltage'] = inv['Grid voltage 1'];
  }
  if (has(inv, 'Grid frequency')) out['AC output frequency'] = inv['Grid frequency'];

  const alarms = [1, 2, 3, 4].filter((n) => has(p, `Alarm word ${n}`));
  if (alarms.length) {
    const set = alarms.map((n) => num(p, `Alarm word ${n}`)).map((v, i) => (v ? `A${alarms[i]}:0x${v.toString(16).toUpperCase().padStart(4, '0')}` : '')).filter(Boolean);
    out['Fault code'] = set.length ? set.join(', ') : 'None';
  }
  return out;
}

/** Info registers (unit 1) → info metrics, with a fallback model name. */
export function decodeInfo(model: SigenModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': `Sigenergy ${model.name}` };
  for (const k of ['Model name', 'Serial number', 'Firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  for (const k of ['Max AC output power', 'Battery capacity']) {
    const v = t[k];
    if (typeof v === 'number' && v > 0 && v < 1e6) out[k] = v;
  }
  return out;
}

export const READ_ONLY_ERROR = 'Sigenergy driver is read-only (not yet verified on hardware)';

function readOnlyError(what: string) {
  return new Error(`${READ_ONLY_ERROR}: can't write ${what}`);
}

export class SigenergyDriver implements InverterDriver {
  readonly model: SigenModel;
  readonly plantUnit: number;
  readonly inverterUnit = INVERTER_UNIT;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = sigenModel(opts.modelId);
    this.plantUnit = opts.address || PLANT_UNIT;
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, this.plantUnit));
    this.infoMetrics = { 'Model name': `Sigenergy ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    try {
      const regs = image(INFO_SPAN[0], await this.conn.read(4, INFO_SPAN[0], INFO_SPAN[1], this.inverterUnit));
      this.infoMetrics = decodeInfo(this.model, regs);
    } catch {
      // Inverter unit not answering: keep the fallback model name.
    }
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const plant = image(PLANT_SPAN[0], await this.conn.read(4, PLANT_SPAN[0], PLANT_SPAN[1], this.plantUnit));
    const inverter: RegisterImage = new Map();
    for (const [start, count] of [INVERTER_SPAN, AC_SPAN]) {
      try {
        image(start, await this.conn.read(4, start, count, this.inverterUnit), inverter);
      } catch {
        // Inverter details are optional; plant totals still make a useful poll.
      }
    }
    return decodeLive(this.model, plant, inverter);
  }

  settingDefs(): SettingDef[] {
    return SIGEN_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    try {
      const regs = image(SETTING_SPAN[0], await this.conn.read(3, SETTING_SPAN[0], SETTING_SPAN[1], this.plantUnit));
      return decodeSettings(SIGEN_SETTINGS, regs);
    } catch {
      return {};
    }
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    throw readOnlyError(`setting '${key}'`);
  }

  /** Console reads go to the plant unit (247); inverter registers (30500+) go to unit 1. */
  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    const unit = start >= 30500 && start < 40000 ? this.inverterUnit : this.plantUnit;
    return this.conn.read(fn as RegisterFunction, start, count, unit);
  }

  async rawWrite(start: number, _values: number[]): Promise<void> {
    throw readOnlyError(`register ${start}`);
  }
}
