/** The Afore hybrid Modbus driver (read-only), single-phase AF-SL and three-phase AF-TH. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  BATTERY_MAP, BATTERY_SPAN, decodeTable, ENERGY_MAP, ENERGY_SPAN, FAULT_SPAN, FAULT_WORDS, GRID_MAP, GRID_SPAN,
  image, INFO_MAP, INFO_SPAN, SYSTEM_MAP, SYSTEM_SPAN, type RegisterImage,
} from './registers.ts';
import { AFORE_SETTINGS, decodeSettings, SETTING_SPANS } from './settings.ts';

export interface AforeModel {
  id: string;
  name: string;
  phases: 1 | 3;
}

export const MODELS: AforeModel[] = [
  { id: 'hybrid', name: 'AF-SL single-phase hybrid (AF3.6K-SL … AF6K-SL)', phases: 1 },
  { id: 'hybrid3', name: 'AF-TH three-phase hybrid (AF3K-TH … AF10K-TH)', phases: 3 },
];

export function aforeModel(id: string): AforeModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/** Inverter type code (input 6) → model id: 200–299 single/split-phase hybrid, 300–399 three-phase hybrid. */
export function modelFromType(type: number): string | undefined {
  if (type >= 200 && type <= 299) return 'hybrid';
  if (type >= 300 && type <= 399) return 'hybrid3';
  return undefined;
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw table values → Sunroost metrics. */
export function derive(model: AforeModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  const copy = [
    'Device mode', 'Bus voltage', 'Grid frequency', 'Inverter power', 'PV power', 'Temperature', 'Temperature transformer',
    'Battery state', 'Battery state of charge', 'Battery state of health', 'Battery voltage', 'Battery temperature',
    'PV energy today', 'PV energy total', 'Export energy today', 'Export energy total', 'Import energy today',
    'Import energy total', 'Load energy today', 'Load energy total', 'Charge energy today', 'Charge energy total',
    'Discharge energy today', 'Discharge energy total',
  ];
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];

  for (const p of [1, 2, 3, 4]) {
    // Trackers 3/4 only exist on bigger units; show them when they carry a voltage.
    if (p > 2 && !num(raw, `PV voltage ${p}`)) continue;
    for (const k of ['PV voltage', 'PV current', 'PV power']) if (has(raw, `${k} ${p}`)) out[`${k} ${p}`] = raw[`${k} ${p}`];
  }
  if (!has(raw, 'PV power')) out['PV power'] = [1, 2, 3, 4].reduce((s, p) => s + num(out, `PV power ${p}`), 0);

  // Battery: the sign convention of current/power isn't documented, so the state word (charging /
  // discharging) decides it when present. Sunroost: + = charging.
  const state = raw['Battery state'];
  const signed = (v: number) => (state === 'Charging' ? Math.abs(v) : state === 'Discharging' ? -Math.abs(v) : v);
  if (has(raw, 'Battery current')) out['Battery current'] = signed(num(raw, 'Battery current'));
  if (has(raw, 'Battery power')) out['Battery power'] = signed(num(raw, 'Battery power'));
  else if (has(raw, 'Battery voltage') && has(raw, 'Battery current')) {
    out['Battery power'] = round(num(out, 'Battery voltage') * num(out, 'Battery current'), 0);
  }

  // Grid: Afore reports + = export; Sunroost uses + = import.
  if (has(raw, 'Meter power')) out['Grid power'] = -num(raw, 'Meter power');
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  if (has(raw, 'Load power total')) out['Load power'] = raw['Load power total'];
  if (model.phases === 3) {
    for (const p of [1, 2, 3]) {
      if (has(raw, `Grid voltage ${p}`)) out[`Grid voltage ${p}`] = raw[`Grid voltage ${p}`];
      if (has(raw, `Meter power ${p}`)) out[`Grid power ${p}`] = -num(raw, `Meter power ${p}`);
      if (has(raw, `Load power ${p}`)) out[`Load power ${p}`] = raw[`Load power ${p}`];
      if (has(raw, `Inverter power ${p}`)) out[`Inverter power ${p}`] = raw[`Inverter power ${p}`];
    }
  }
  return out;
}

/** Fault words → "Grid error 0x00000004, …" or "None". */
export function decodeFaults(regs: RegisterImage): string | undefined {
  const active: string[] = [];
  let seen = false;
  for (const { addr, name } of FAULT_WORDS) {
    const hi = regs.get(addr);
    const lo = regs.get(addr + 1);
    if (hi === undefined || lo === undefined) continue;
    seen = true;
    const word = hi * 0x10000 + lo;
    if (word) active.push(`${name} 0x${word.toString(16).toUpperCase().padStart(8, '0')}`);
  }
  if (!seen) return undefined;
  return active.length ? active.join(', ') : 'None';
}

export function decodeLive(model: AforeModel, regs: RegisterImage): Metrics {
  const out = derive(model, decodeTable([...GRID_MAP, ...ENERGY_MAP, ...BATTERY_MAP, ...SYSTEM_MAP], regs));
  const faults = decodeFaults(regs);
  if (faults !== undefined) out['Fault code'] = faults;
  return out;
}

/** Info registers → info metrics; falls back to a name built from the rated power. */
export function decodeInfo(model: AforeModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = {};
  const rated = num(t, 'Max AC output power');
  const suffix = model.phases === 3 ? 'TH' : 'SL';
  const fallback = rated > 0 && rated < 1e6 ? `Afore AF${Number((rated / 1000).toFixed(1))}K-${suffix}` : `Afore ${model.name}`;
  const name = t['Model name'];
  out['Model name'] = typeof name === 'string' && /[A-Za-z0-9]{2}/.test(name) ? name : fallback;
  if (rated > 0 && rated < 1e6) out['Max AC output power'] = rated;
  for (const k of ['Serial number', 'Firmware version', 'Secondary firmware version', 'HMI firmware version', 'Protocol version']) {
    const v = t[k];
    if (typeof v === 'string' && v && v !== '0.00' && v !== '655.35') out[k] = v;
  }
  return out;
}

function readOnlyError(what: string) {
  return new Error(`Afore driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class AforeDriver implements InverterDriver {
  readonly model: AforeModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = aforeModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': `Afore ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    try {
      image(INFO_SPAN[0], await this.conn.read(4, INFO_SPAN[0], INFO_SPAN[1]), regs);
    } catch {
      // Info is nice to have; live polling still works without it.
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    // The PV/grid block is mandatory; the others are optional (on-grid firmware lacks the battery block).
    image(GRID_SPAN[0], await this.conn.read(4, GRID_SPAN[0], GRID_SPAN[1]), regs);
    for (const [start, count] of [ENERGY_SPAN, BATTERY_SPAN, SYSTEM_SPAN, FAULT_SPAN]) {
      try {
        image(start, await this.conn.read(4, start, count), regs);
      } catch {
        // Leave those readings out.
      }
    }
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    return AFORE_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
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
    return decodeSettings(AFORE_SETTINGS, regs);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    throw readOnlyError(`setting '${key}'`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  async rawWrite(start: number, _values: number[]): Promise<void> {
    throw readOnlyError(`register ${start}`);
  }
}
