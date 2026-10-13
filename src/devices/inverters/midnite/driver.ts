/** The MidNite AIO Modbus driver (read-only). */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  BATTERY_MAP, BATTERY_SPAN, decodeTable, EPS_MAP, EPS_SPAN, GRID_MAP, GRID_SPAN, IDENT_SPAN, image, INFO_MAP,
  INVERTER_MAP, INVERTER_SPAN, PV_TOTAL_MAP, PV_TOTAL_SPAN, RAW_BATTERY_DISCHARGE_POSITIVE, VERSION_SPAN,
  type RegisterImage,
} from './registers.ts';
import { decodeSettings, MIDNITE_SETTINGS, SETTING_SPANS } from './settings.ts';

export interface MidniteModel {
  id: string;
  name: string;
}

export const MODELS: MidniteModel[] = [{ id: 'aio', name: 'MN15-12KW-AIO All-In-One (RS485)' }];

export function midniteModel(id: string): MidniteModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

const FALLBACK_MODEL_NAME = 'MidNite MN15-12KW-AIO';

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw table values (+ rated power, when known) → Sunroost metrics. Split phase: L1 and L2. */
export function derive(raw: Metrics, ratedPower = 0): Metrics {
  const out: Metrics = {};
  const copy = [
    'Battery state of charge', 'Battery voltage', 'Temperature', 'Device mode', 'Grid frequency', 'AC output frequency',
    'Load power non-essential',
  ];
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];
  for (const p of [1, 2]) {
    for (const k of ['Grid voltage', 'Grid current', 'Grid power', 'AC output voltage', 'Load power']) {
      if (raw[`${k} ${p}`] !== undefined) out[`${k} ${p}`] = raw[`${k} ${p}`];
    }
  }

  // PV: three MPPTs; the total register wins when it reads, else the sum.
  let pvSum = 0;
  for (const n of [1, 2, 3]) {
    for (const k of ['PV voltage', 'PV current', 'PV power']) if (raw[`${k} ${n}`] !== undefined) out[`${k} ${n}`] = raw[`${k} ${n}`];
    pvSum += num(raw, `PV power ${n}`);
  }
  out['PV power'] = round(has(raw, 'PV power total') ? num(raw, 'PV power total') : pvSum, 0);

  // Battery: + charging.
  const sign = RAW_BATTERY_DISCHARGE_POSITIVE ? -1 : 1;
  if (has(raw, 'Battery power raw')) out['Battery power'] = round(sign * num(raw, 'Battery power raw'), 0);
  if (has(raw, 'Battery current raw')) out['Battery current'] = round(sign * num(raw, 'Battery current raw'), 2);

  // Grid: + import; split-phase total is L1 + L2.
  out['Grid power'] = round(num(raw, 'Grid power 1') + num(raw, 'Grid power 2'), 0);
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'AC output voltage 1')) out['AC output voltage'] = raw['AC output voltage 1'];

  // Load: backup (EPS) outputs L1 + L2 are essential; the grid-side load is non-essential.
  const essential = num(raw, 'Load power 1') + num(raw, 'Load power 2');
  out['Load power essential'] = round(essential, 0);
  out['Load power'] = round(essential + num(raw, 'Load power non-essential'), 0);
  if (ratedPower > 0) out['Load percentage'] = round((Math.max(0, essential) / ratedPower) * 100, 0);

  if (has(raw, 'Fault word')) {
    const f = num(raw, 'Fault word');
    out['Fault code'] = f === 0 ? 'None' : `0x${f.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  return out;
}

export function decodeLive(regs: RegisterImage, ratedPower = 0): Metrics {
  return derive(decodeTable([...INVERTER_MAP, ...PV_TOTAL_MAP, ...GRID_MAP, ...EPS_MAP, ...BATTERY_MAP], regs), ratedPower);
}

/** Info registers → info metrics, with a fallback model name. */
export function decodeInfo(regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': FALLBACK_MODEL_NAME };
  for (const k of ['Model name', 'Serial number', 'Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  if (typeof t['Rated power'] === 'number' && t['Rated power'] > 0 && t['Rated power'] < 0xffff) out['Rated power'] = t['Rated power'];
  return out;
}

function readOnlyError(what: string) {
  return new Error(`MidNite driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class MidniteDriver implements InverterDriver {
  readonly model: MidniteModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = midniteModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': FALLBACK_MODEL_NAME };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    for (const [start, count] of [IDENT_SPAN, VERSION_SPAN]) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Older firmware may not implement every info register; not fatal.
      }
    }
    this.infoMetrics = decodeInfo(regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of [INVERTER_SPAN, GRID_SPAN, BATTERY_SPAN]) image(start, await this.conn.read(3, start, count), regs);
    for (const [start, count] of [PV_TOTAL_SPAN, EPS_SPAN]) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Optional blocks: PV falls back to the MPPT sum, load to the grid-side value.
      }
    }
    const rated = this.infoMetrics['Rated power'];
    return decodeLive(regs, typeof rated === 'number' ? rated : 0);
  }

  settingDefs(): SettingDef[] {
    return MIDNITE_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
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
    return decodeSettings(MIDNITE_SETTINGS, regs);
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
