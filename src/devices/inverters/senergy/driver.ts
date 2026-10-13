/** The Senergy Modbus driver (read-only), shared by Senergy, Duracell Dura-i and Salvare units. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  addresses, BATTERY_MAP, BATTERY_SPAN, decodeTable, image, INFO_MAP, INFO_SPAN, INVERTER_MAP, INVERTER_SPAN,
  METER_SPAN, meterMap, phaseMap, PV3_MAP, type RegDef, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SENERGY_SETTINGS, SETTING_SPANS } from './settings.ts';

export interface SenergyModel {
  id: string;
  name: string;
  /** 1 single-phase, 2 split-phase (L1/L2), 3 three-phase. */
  phases: 1 | 2 | 3;
  /** MPPT inputs decoded. */
  mppts: 2 | 3;
}

export const MODELS: SenergyModel[] = [
  { id: 'hybrid', name: 'Single-phase hybrid (Duracell Dura-i G1 / G3)', phases: 1, mppts: 2 },
  { id: 'split', name: 'Split-phase hybrid (Senergy SE KTL-G2P)', phases: 2, mppts: 2 },
  { id: 'hybrid3', name: 'Three-phase HV hybrid (Salvare 10 PRO)', phases: 3, mppts: 3 },
];

/** Unknown ids fall back to the single-phase hybrid. */
export function senergyModel(id: string): SenergyModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function liveMap(model: SenergyModel): RegDef[] {
  const out = [...INVERTER_MAP, ...meterMap(model.phases), ...BATTERY_MAP];
  if (model.mppts === 3) out.push(...PV3_MAP);
  if (model.phases >= 2) out.push(...phaseMap(2));
  if (model.phases === 3) out.push(...phaseMap(3));
  return out;
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw table values → Sunroost metrics. */
export function derive(model: SenergyModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  const copy = [
    'Device mode', 'Temperature', 'Grid frequency', 'Battery state of charge', 'Battery voltage', 'Battery temperature',
    'PV energy total', 'PV energy today', 'Import energy total', 'Export energy total', 'Discharge energy total',
    'Inverter power',
  ];
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];

  // PV: the total register when present, else the sum of the trackers.
  let pvSum = 0;
  for (let n = 1; n <= model.mppts; n++) {
    for (const k of ['PV voltage', 'PV current', 'PV power']) if (raw[`${k} ${n}`] !== undefined) out[`${k} ${n}`] = raw[`${k} ${n}`];
    pvSum += num(raw, `PV power ${n}`);
  }
  out['PV power'] = round(has(raw, 'PV power') ? num(raw, 'PV power') : pvSum, 0);

  // Battery: Senergy reports + discharging; Sunroost uses + charging. The current's sign is
  // taken from the power, so a current register with the opposite convention can't flip it.
  const battery = has(raw, 'Battery power raw') ? -num(raw, 'Battery power raw') : 0;
  out['Battery power'] = round(battery, 0);
  if (has(raw, 'Battery current raw')) {
    const amps = Math.abs(num(raw, 'Battery current raw'));
    const sign = battery !== 0 ? Math.sign(battery) : -Math.sign(num(raw, 'Battery current raw'));
    out['Battery current'] = round(sign * amps, 2);
  }

  // Grid: CT meter, + import. Per-phase values on split- and three-phase units.
  let grid = 0;
  for (let p = 1; p <= model.phases; p++) {
    grid += num(raw, `Grid power ${p}`);
    if (model.phases > 1) {
      for (const k of ['Grid power', 'Grid voltage', 'Grid current', 'Inverter power']) {
        if (raw[`${k} ${p}`] !== undefined) out[`${k} ${p}`] = raw[`${k} ${p}`];
      }
    }
  }
  out['Grid power'] = round(grid, 0);
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (model.phases === 1 && has(raw, 'Grid CT current 1')) out['Grid current'] = raw['Grid CT current 1'];

  // Load: the meter block's house-load register, else the energy balance.
  out['Load power'] = round(has(raw, 'Load power') ? num(raw, 'Load power') : Math.max(0, out['PV power'] as number + grid - battery), 0);

  if (has(raw, 'Fault word')) {
    const f = num(raw, 'Fault word');
    out['Fault code'] = f === 0 ? 'None' : `0x${f.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  return out;
}

export function decodeLive(model: SenergyModel, regs: RegisterImage): Metrics {
  return derive(model, decodeTable(liveMap(model), regs));
}

/** Info registers → info metrics, with a fallback model name. */
export function decodeInfo(model: SenergyModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': `Senergy ${model.name}` };
  for (const k of ['Model name', 'Serial number', 'Firmware version', 'Protocol version']) {
    const v = t[k];
    if (typeof v === 'string' && /[A-Za-z0-9]/.test(v) && v !== '0.00' && v !== '255.255') out[k] = v;
  }
  const rated = t['Max AC output power'];
  if (typeof rated === 'number' && rated > 0 && rated < 0xffff) out['Max AC output power'] = rated;
  return out;
}

function readOnlyError(what: string) {
  return new Error(`Senergy driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class SenergyDriver implements InverterDriver {
  readonly model: SenergyModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = senergyModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': `Senergy ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    try {
      image(INFO_SPAN[0], await this.conn.read(3, INFO_SPAN[0], INFO_SPAN[1]), regs);
    } catch {
      // Some firmware may not answer the whole info block: try model + serial alone.
      try {
        image(INFO_SPAN[0], await this.conn.read(3, INFO_SPAN[0], 0x18), regs);
      } catch {}
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  /**
   * Reads one block; if the firmware rejects the whole span, falls back to the individual registers
   * the tables use. Throws only when nothing at all could be read and `required` is set.
   */
  private async readSpan([start, count]: [number, number], defs: RegDef[], regs: RegisterImage, required: boolean) {
    try {
      image(start, await this.conn.read(3, start, count), regs);
      return;
    } catch (err) {
      const want = addresses(defs).filter((a) => a >= start && a < start + count);
      let ok = 0;
      for (const a of want) {
        try {
          image(a, await this.conn.read(3, a, 1), regs);
          ok++;
        } catch {}
      }
      if (required && ok === 0) throw err;
    }
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    const defs = liveMap(this.model);
    await this.readSpan(INVERTER_SPAN, defs, regs, true);
    await this.readSpan(METER_SPAN, defs, regs, false);
    await this.readSpan(BATTERY_SPAN, defs, regs, false);
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    return SENERGY_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
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
    return decodeSettings(SENERGY_SETTINGS, regs);
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
