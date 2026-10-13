/** The Solax Modbus driver (read-only) for the X1 / X3 hybrid G4 family and the X1 Lite LV. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  decodeTable, FIRMWARE_SPAN, IDENT_SPAN, image, INFO_MAP, LIVE_MAP, LIVE_SPAN, PHASE_SPAN, phaseMap,
  type RegDef, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPAN, SOLAX_SETTINGS } from './settings.ts';

export interface SolaxModel {
  id: string;
  name: string;
  phases: 1 | 3;
  /** Grid-tied hybrid (can export); false for the off-grid LV series. */
  hybrid: boolean;
}

export const MODELS: SolaxModel[] = [
  { id: 'x1_hybrid', name: 'X1-Hybrid G4 (single-phase hybrid)', phases: 1, hybrid: true },
  { id: 'x3_hybrid', name: 'X3-Hybrid G4 (three-phase hybrid)', phases: 3, hybrid: true },
  // UNVERIFIED: no public X1-Lite-LV map found; assumed to share the G4 input block.
  { id: 'x1_lite_lv', name: 'X1-Lite LV (single-phase off-grid, UNVERIFIED map)', phases: 1, hybrid: false },
];

/** Unknown ids fall back to the X1-Hybrid G4, the most common Solax unit. */
export function solaxModel(id: string): SolaxModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function liveMap(model: SolaxModel): RegDef[] {
  return model.phases === 3 ? [...LIVE_MAP, ...phaseMap()] : LIVE_MAP;
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

/** Raw table values → Sunroost metrics. */
export function derive(model: SolaxModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  const copy = [
    'Device mode', 'Temperature', 'PV voltage 1', 'PV current 1', 'PV power 1', 'PV voltage 2', 'PV current 2', 'PV power 2',
    'Battery voltage', 'Battery current', 'Battery power', 'Battery temperature', 'Battery state of charge', 'BMS connected',
  ];
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];
  out['PV power'] = num(raw, 'PV power 1') + num(raw, 'PV power 2');

  const eps = raw['Device mode'] === 'EPS' || raw['Device mode'] === 'EPS check';
  const feedIn = model.hybrid ? num(raw, 'Feed-in power') : 0;
  let inverter = num(raw, 'Inverter power');

  if (model.phases === 3) {
    inverter = 0;
    for (const p of [1, 2, 3]) {
      inverter += num(raw, `Inverter power ${p}`);
      for (const k of ['Grid voltage', 'Grid current']) if (has(raw, `${k} ${p}`)) out[`${k} ${p}`] = raw[`${k} ${p}`];
      if (has(raw, `Feed-in power ${p}`)) {
        out[`Grid power ${p}`] = -num(raw, `Feed-in power ${p}`);
        out[`Load power ${p}`] = Math.max(0, num(raw, `Inverter power ${p}`) - num(raw, `Feed-in power ${p}`));
      }
    }
    if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
    if (has(raw, 'Grid frequency 1')) out['Grid frequency'] = raw['Grid frequency 1'];
  } else {
    for (const k of ['Grid voltage', 'Grid current', 'Grid frequency']) if (raw[k] !== undefined) out[k] = raw[k];
  }
  out['Inverter power'] = inverter;

  // Meter feed-in is + export; Sunroost's grid power is + import.
  out['Grid power'] = eps ? 0 : -feedIn;
  // House load = what the inverter delivers minus what leaves through the meter; in EPS (off-grid)
  // mode the EPS port carries the whole load.
  out['Load power'] = eps ? num(raw, 'EPS power') : Math.max(0, round(inverter - feedIn, 0));
  if (has(raw, 'EPS power') && model.phases === 1) out['Load apparent power'] = eps ? num(raw, 'EPS power') : out['Load power'];

  const epsV = num(raw, 'EPS voltage');
  if (epsV > 50) {
    out['AC output voltage'] = epsV;
    if (has(raw, 'EPS frequency')) out['AC output frequency'] = raw['EPS frequency'];
  } else if (has(out, 'Grid voltage')) {
    out['AC output voltage'] = out['Grid voltage'];
    if (has(out, 'Grid frequency')) out['AC output frequency'] = out['Grid frequency'];
  }

  if (has(raw, 'Inverter fault bits') || has(raw, 'Manager fault bits')) {
    const inv = num(raw, 'Inverter fault bits');
    const mgr = num(raw, 'Manager fault bits');
    const parts: string[] = [];
    if (inv) parts.push(`Inverter 0x${inv.toString(16).toUpperCase().padStart(8, '0')}`);
    if (mgr) parts.push(`Manager 0x${mgr.toString(16).toUpperCase().padStart(4, '0')}`);
    out['Fault code'] = parts.length ? parts.join(', ') : 'None';
  }
  return out;
}

export function decodeLive(model: SolaxModel, regs: RegisterImage): Metrics {
  return derive(model, decodeTable(liveMap(model), regs));
}

/** Info registers → info metrics, with a fallback model name. */
export function decodeInfo(model: SolaxModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': `Solax ${model.name}` };
  const module = t['Module name'];
  if (typeof module === 'string' && /[A-Za-z0-9]{2}/.test(module)) out['Model name'] = `Solax ${module}`;
  if (typeof t['Serial number'] === 'string' && t['Serial number']) out['Serial number'] = t['Serial number'];
  for (const k of ['Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'number' && v > 0 && v < 655.35) out[k] = v.toFixed(2);
  }
  return out;
}

function readOnlyError(what: string) {
  return new Error(`Solax driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class SolaxDriver implements InverterDriver {
  readonly model: SolaxModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = solaxModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 19200, opts.address || 1));
    this.infoMetrics = { 'Model name': `Solax ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    for (const [start, count] of [IDENT_SPAN, FIRMWARE_SPAN]) {
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
    image(LIVE_SPAN[0], await this.conn.read(4, LIVE_SPAN[0], LIVE_SPAN[1]), regs);
    if (this.model.phases === 3) image(PHASE_SPAN[0], await this.conn.read(4, PHASE_SPAN[0], PHASE_SPAN[1]), regs);
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    return SOLAX_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    try {
      image(SETTING_SPAN[0], await this.conn.read(3, SETTING_SPAN[0], SETTING_SPAN[1]), regs);
    } catch {
      // Unsupported range on this firmware: leave the settings blank.
    }
    return decodeSettings(SOLAX_SETTINGS, regs);
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
