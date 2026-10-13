/** The Solis (Ginlong) Modbus driver (read-only), shared by hybrid, three-phase hybrid and string. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  decodeSerial, decodeTable, image, INFO_MAP, INFO_SPAN, MAP_A, MAP_B, MAP_C, SERIAL_REG,
  SERIAL_WORDS, SPAN_A, SPAN_B, SPAN_C, STATUS, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPANS, SOLIS_SETTINGS } from './settings.ts';

export interface SolisModel {
  id: string;
  name: string;
  phases: 1 | 3;
  battery: boolean;
}

export const MODELS: SolisModel[] = [
  { id: 'hybrid', name: 'Hybrid single-phase (RHI / S5-EH1P / S6-EH1P, Dyness 1P-A)', phases: 1, battery: true },
  { id: 'hybrid3', name: 'Hybrid three-phase (RHI-3P / S6-EH3P / S6 K-H)', phases: 3, battery: true },
  { id: 'string', name: 'String (grid-tie, no battery)', phases: 1, battery: false },
  { id: 'string3', name: 'String three-phase (grid-tie, no battery)', phases: 3, battery: false },
];

/** Unknown ids fall back to the single-phase hybrid. */
export function solisModel(id: string): SolisModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}

function statusText(code: number): string {
  if (STATUS[code] !== undefined) return STATUS[code];
  return code >= 0x1000 ? 'Fault' : `Unknown (0x${code.toString(16).toUpperCase().padStart(4, '0')})`;
}

/** Raw table values → Sunroost metrics. */
export function derive(model: SolisModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  const copy = [
    'PV voltage 1', 'PV current 1', 'PV voltage 2', 'PV current 2', 'Bus voltage', 'Grid frequency', 'Temperature',
    'Inverter power', 'PV energy total', 'PV energy today', 'Import energy total', 'Import energy today',
    'Export energy total', 'Export energy today',
  ];
  if (model.battery) {
    copy.push(
      'Battery voltage', 'Battery state of charge', 'Battery state of health', 'Battery charge current limit',
      'Battery discharge current limit', 'Charge energy total', 'Charge energy today', 'Discharge energy total',
      'Discharge energy today', 'Load energy total', 'Load energy today',
    );
  }
  for (const k of copy) if (raw[k] !== undefined) out[k] = raw[k];

  // PV: per-string power = V × I; strings 3/4 only when they carry a voltage.
  let pvSum = 0;
  for (const n of [1, 2, 3, 4]) {
    const v = num(raw, `PV voltage ${n}`);
    const i = num(raw, `PV current ${n}`);
    if (n > 2 && v === 0) continue;
    if (n > 2) {
      out[`PV voltage ${n}`] = v;
      out[`PV current ${n}`] = i;
    }
    const p = round(v * i, 0);
    out[`PV power ${n}`] = p;
    pvSum += p;
  }
  out['PV power'] = has(raw, 'PV power total raw') ? num(raw, 'PV power total raw') : pvSum;

  // Grid: meter sign is + export on Solis (UNVERIFIED) → negate to Sunroost's + import.
  if (has(raw, 'Meter power raw')) out['Grid power'] = -num(raw, 'Meter power raw');
  else if (has(raw, 'Meter total power raw')) out['Grid power'] = -num(raw, 'Meter total power raw');

  if (model.phases === 3) {
    for (const p of [1, 2, 3]) {
      if (has(raw, `AC voltage ${p}`)) out[`Grid voltage ${p}`] = raw[`AC voltage ${p}`];
      if (has(raw, `AC current ${p}`)) out[`Grid current ${p}`] = raw[`AC current ${p}`];
      if (has(raw, `Meter power raw ${p}`)) out[`Grid power ${p}`] = -num(raw, `Meter power raw ${p}`);
    }
    if (has(raw, 'AC voltage 1')) out['Grid voltage'] = raw['AC voltage 1'];
  } else {
    if (has(raw, 'AC voltage 1')) out['Grid voltage'] = raw['AC voltage 1'];
    if (has(raw, 'AC current 1')) out['Grid current'] = raw['AC current 1'];
  }

  if (model.battery) {
    const dir = num(raw, 'Battery direction') === 1 ? -1 : 1; // 0 charge, 1 discharge
    out['Battery current'] = round(dir * num(raw, 'Battery current raw'), 1);
    const p = has(raw, 'Battery power raw')
      ? Math.abs(num(raw, 'Battery power raw'))
      : Math.abs(num(raw, 'Battery voltage') * num(raw, 'Battery current raw'));
    out['Battery power'] = round(dir * p, 0);
    // House load (grid side) + backup load = everything the inverter's loads draw (UNVERIFIED sum).
    out['Load power'] = num(raw, 'House load power') + num(raw, 'Backup load power');
    if (has(raw, 'Backup load power')) out['Backup load power'] = raw['Backup load power'];
    if (has(raw, 'Backup voltage')) out['AC output voltage'] = raw['Backup voltage'];
  } else if (has(out, 'Grid power')) {
    // String inverter with a meter: load = generation + import.
    out['Load power'] = Math.max(0, num(raw, 'Inverter power') + num(out, 'Grid power'));
  }

  if (has(raw, 'Status code')) {
    const code = num(raw, 'Status code');
    out['Device mode'] = statusText(code);
  }
  const faults = [1, 2, 3, 4, 5]
    .map((n) => num(raw, `Fault word ${n}`))
    .map((w, i) => (w ? `F${i + 1}:0x${w.toString(16).toUpperCase().padStart(4, '0')}` : ''))
    .filter(Boolean);
  if ([1, 2, 3, 4, 5].some((n) => has(raw, `Fault word ${n}`))) out['Fault code'] = faults.length ? faults.join(', ') : 'None';
  return out;
}

export function decodeLive(model: SolisModel, regs: RegisterImage): Metrics {
  return derive(model, decodeTable([...MAP_A, ...MAP_B, ...MAP_C], regs));
}

/** Info registers → info metrics, with a fallback model name. */
export function decodeInfo(model: SolisModel, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': `Solis ${model.name}` };
  const t = decodeTable(INFO_MAP, regs);
  for (const k of ['Firmware version', 'Secondary firmware version', 'Model code']) {
    const v = t[k];
    if (typeof v === 'string' && v !== '0000' && v !== 'FFFF') out[k] = v;
  }
  const words: number[] = [];
  for (let i = 0; i < SERIAL_WORDS; i++) {
    const w = regs.get(SERIAL_REG + i);
    if (w === undefined) break;
    words.push(w);
  }
  const serial = decodeSerial(words);
  if (serial) out['Serial number'] = serial;
  return out;
}

export const READ_ONLY_ERROR = 'Solis driver is read-only (not yet verified on hardware)';

function readOnlyError(what: string) {
  return new Error(`${READ_ONLY_ERROR}: can't write ${what}`);
}

export class SolisDriver implements InverterDriver {
  readonly model: SolisModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = solisModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': `Solis ${this.model.name}` };
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
      // Info is optional; live reads report a real failure.
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of [SPAN_A, SPAN_B]) image(start, await this.conn.read(4, start, count), regs);
    if (this.model.phases === 3) {
      try {
        image(SPAN_C[0], await this.conn.read(4, SPAN_C[0], SPAN_C[1]), regs);
      } catch {
        // No external meter block on this unit.
      }
    }
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    if (!this.model.battery) return [];
    return SOLIS_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    if (!this.model.battery) return {};
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(SOLIS_SETTINGS, regs);
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
