/** The SRNE Modbus driver (read-only) shared by every SRNE model family. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  BATTERY_MAP, BATTERY_SPAN, decodeTable, image, INFO_MAP, INFO_SPAN, INVERTER_MAP, INVERTER_SPAN,
  phaseMap, PV2_MAP, SERIAL_SPAN, type RegDef, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPANS, SRNE_SETTINGS } from './settings.ts';

export interface SrneModel {
  id: string;
  name: string;
  /** 1 single-phase, 2 split-phase (L1/L2), 3 three-phase. */
  phases: 1 | 2 | 3;
  /** Hybrid: second MPPT and grid feed-in (grid power may go negative). */
  hybrid: boolean;
}

export const MODELS: SrneModel[] = [
  { id: 'offgrid', name: 'Off-grid single-phase (HF / ASP / ASF / ABP)', phases: 1, hybrid: false },
  { id: 'offgrid-split', name: 'Off-grid split-phase (ASP / ABP split-phase)', phases: 2, hybrid: false },
  { id: 'offgrid-three', name: 'Off-grid three-phase (ASP three-phase)', phases: 3, hybrid: false },
  { id: 'hybrid', name: 'Hybrid single-phase (HESP / HYP)', phases: 1, hybrid: true },
  { id: 'hybrid-split', name: 'Hybrid split-phase (HYP / ASP split-phase hybrid)', phases: 2, hybrid: true },
];

/** Unknown ids fall back to single-phase off-grid, the most common SRNE unit. */
export function srneModel(id: string): SrneModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function liveMap(model: SrneModel): RegDef[] {
  const out = [...BATTERY_MAP, ...INVERTER_MAP];
  if (model.hybrid) out.push(...PV2_MAP);
  if (model.phases >= 2) out.push(...phaseMap(2));
  if (model.phases === 3) out.push(...phaseMap(3));
  return out;
}

/** Inverter-block length for the model (phase blocks extend it to 0x0231 / 0x0239). */
export function inverterSpan(model: SrneModel): [number, number] {
  const end = model.phases === 3 ? 0x0239 : model.phases === 2 ? 0x0231 : INVERTER_SPAN[0] + INVERTER_SPAN[1] - 1;
  return [INVERTER_SPAN[0], end - INVERTER_SPAN[0] + 1];
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw table values → Sunroost metrics. */
export function derive(model: SrneModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  const copy = [
    'Device mode', 'Battery state of charge', 'Battery voltage', 'Battery current', 'Battery temperature',
    'PV voltage 1', 'PV current 1', 'PV voltage 2', 'PV current 2', 'Bus voltage', 'Grid frequency',
    'AC output frequency', 'Grid charge current', 'PV charge current', 'Charger state',
    'Temperature DC', 'Temperature AC',
  ];
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];

  const pv1 = num(raw, 'PV power 1');
  const pv2 = model.hybrid ? num(raw, 'PV power 2') : 0;
  out['PV power 1'] = pv1;
  if (model.hybrid && has(raw, 'PV power 2')) out['PV power 2'] = pv2;
  const pv = pv1 + pv2;
  out['PV power'] = pv;

  const battV = num(raw, 'Battery voltage');
  const battery = round(battV * num(raw, 'Battery current'), 0);
  out['Battery power'] = battery;

  // Per-phase values: single-phase units get the plain names, multi-phase units both.
  const phases = Array.from({ length: model.phases }, (_, i) => i + 1);
  let load = 0;
  let apparent = 0;
  const pct: number[] = [];
  for (const p of phases) {
    load += num(raw, `Load power ${p}`);
    apparent += num(raw, `Load apparent power ${p}`);
    if (has(raw, `Load percentage ${p}`)) pct.push(num(raw, `Load percentage ${p}`));
    if (model.phases > 1) {
      for (const k of ['Grid voltage', 'Grid current', 'AC output voltage', 'AC output current', 'Load power', 'Load apparent power']) {
        if (raw[`${k} ${p}`] !== undefined) out[`${k} ${p}`] = raw[`${k} ${p}`];
      }
    }
  }
  out['Load power'] = load;
  out['Load apparent power'] = apparent;
  if (pct.length) out['Load percentage'] = Math.max(...pct);
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'Grid current 1') && model.phases === 1) out['Grid current'] = raw['Grid current 1'];
  if (has(raw, 'AC output voltage 1')) out['AC output voltage'] = raw['AC output voltage 1'];

  // No grid power register is documented: derive it by energy balance (load + charging − PV),
  // ignoring conversion losses. Off-grid units can't export, so they never go negative.
  const gridUp = num(raw, 'Grid voltage 1') >= 50;
  let grid = gridUp ? load + battery - pv : 0;
  if (!model.hybrid) grid = Math.max(0, grid);
  out['Grid power'] = round(grid, 0);

  const temps = ['Temperature DC', 'Temperature AC', 'Temperature transformer'].filter((k) => has(raw, k)).map((k) => num(raw, k));
  if (temps.length) out.Temperature = Math.max(...temps);

  const faults = [1, 2, 3, 4].map((n) => num(raw, `Fault word ${n}`)).filter((c) => c !== 0);
  if ([1, 2, 3, 4].some((n) => has(raw, `Fault word ${n}`))) out['Fault code'] = faults.length ? faults.join(', ') : 'None';
  return out;
}

export function decodeLive(model: SrneModel, regs: RegisterImage): Metrics {
  return derive(model, decodeTable(liveMap(model), regs));
}

/** Info registers → info metrics, with a fallback model name. */
export function decodeInfo(model: SrneModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': `SRNE ${model.name}` };
  for (const k of ['Model name', 'Serial number', 'Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && v && v !== '0.00' && v !== '255.255') out[k] = v;
  }
  return out;
}

function readOnlyError(what: string) {
  return new Error(`SRNE driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class SrneDriver implements InverterDriver {
  readonly model: SrneModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = srneModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': `SRNE ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    for (const [start, count] of [INFO_SPAN, SERIAL_SPAN]) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Older firmware may not implement every info register; not fatal.
      }
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of [BATTERY_SPAN, inverterSpan(this.model)]) image(start, await this.conn.read(3, start, count), regs);
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    return SRNE_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(SRNE_SETTINGS, regs);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    throw readOnlyError(`setting '${key}'`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  async rawWrite(start: number, _values: number[]): Promise<void> {
    throw readOnlyError(`register 0x${start.toString(16).toUpperCase().padStart(4, '0')}`);
  }
}
