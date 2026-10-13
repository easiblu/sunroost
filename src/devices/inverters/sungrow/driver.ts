/** The Sungrow Modbus driver (read-only) for SH hybrids and SG grid-tied string inverters. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  COMMON_MAP, COMMON_SPAN, decodeTable, FIRMWARE_MAP, FIRMWARE_SPAN, HYBRID_MAP, HYBRID_SPAN,
  image, INFO_MAP, PHASE23_MAP, PV3_MAP, RUN_BIT, SG_MAP, SG_METER_MAP, SG_METER_SPAN, TYPE_ADDR,
  typeFamily, type ModelId, type RegDef, type RegisterImage,
} from './registers.ts';
import { decodeSettings, settingSpans, settingsFor } from './settings.ts';

export interface SungrowModel {
  id: ModelId;
  name: string;
  phases: 1 | 3;
  battery: boolean;
}

export const MODELS: SungrowModel[] = [
  { id: 'hybrid3', name: 'SH-RT / SH-T three-phase hybrid', phases: 3, battery: true },
  { id: 'hybrid', name: 'SH-RS single-phase hybrid', phases: 1, battery: true },
  { id: 'grid', name: 'SG-RT three-phase grid-tied', phases: 3, battery: false },
];

/** Unknown ids fall back to the three-phase hybrid. */
export function sungrowModel(id: string): SungrowModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export const ENCRYPTED_HINT =
  'No plain Modbus TCP reply from the Sungrow WiNet-S/WiFi dongle. Newer WiNet-S firmware encrypts Modbus TCP; ' +
  'connect an RS485 cable instead (9600 8N1, address 1) or use a dongle firmware that allows plain Modbus TCP.';

/**
 * A failed read that isn't a Modbus exception reply (timeout, connection reset or garbage) on a
 * plain TCP connection is what an encrypting WiNet-S looks like: say so.
 */
export function explainError(conn: ModbusConnection, err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (conn.target.type !== 'tcp') return e;
  if ((e as { modbusCode?: number }).modbusCode !== undefined) return e;
  return new Error(`${ENCRYPTED_HINT} (${e.message})`);
}

export function liveMap(model: SungrowModel): RegDef[] {
  const out = [...COMMON_MAP];
  if (model.phases === 3) out.push(...PHASE23_MAP, ...PV3_MAP);
  if (model.battery) out.push(...HYBRID_MAP);
  else out.push(...SG_MAP, ...SG_METER_MAP);
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
export function derive(model: SungrowModel, raw: Metrics): Metrics {
  const out: Metrics = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/ raw$/.test(k) || k === 'Running state' || k === 'Export power' || k === 'Meter power' || k === 'Fault word') continue;
    out[k] = v;
  }
  // PV power per MPPT from V × I (the inverter only reports the total).
  for (const n of [1, 2, 3]) {
    if (has(raw, `PV voltage ${n}`) && has(raw, `PV current ${n}`)) out[`PV power ${n}`] = round(num(raw, `PV voltage ${n}`) * num(raw, `PV current ${n}`), 0);
  }
  if (model.phases === 3) {
    if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  } else {
    if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
    delete out['Grid voltage 1'];
    if (has(raw, 'Inverter current 1')) out['Inverter current'] = raw['Inverter current 1'];
    delete out['Inverter current 1'];
  }

  if (model.battery) {
    const state = num(raw, 'Running state');
    const discharging = (state & RUN_BIT.discharging) !== 0;
    const sign = discharging ? -1 : 1;
    const p = num(raw, 'Battery power raw');
    // Newer firmware reports a signed value; older ones a magnitude plus the running-state bits.
    out['Battery power'] = p > 0x7fff ? p - 0x10000 : sign * p;
    const iraw = num(raw, 'Battery current raw');
    out['Battery current'] = iraw > 0x7fff ? round((iraw - 0x10000) * 0.1, 1) : round(sign * iraw * 0.1, 1);
    out['Grid power'] = -num(raw, 'Export power');
  } else {
    // Grid-tied: grid and load only with a Sungrow meter (UNVERIFIED registers).
    const inverter = num(raw, 'Inverter power');
    const meter = num(raw, 'Meter power');
    out['Grid power'] = meter;
    out['Load power'] = has(raw, 'Load power raw') && num(raw, 'Load power raw') !== 0 ? num(raw, 'Load power raw') : Math.max(0, inverter + meter);
    if (has(raw, 'Fault word')) out['Fault code'] = num(raw, 'Fault word') === 0 ? 'None' : String(num(raw, 'Fault word'));
  }
  return out;
}

export function decodeLive(model: SungrowModel, regs: RegisterImage): Metrics {
  return derive(model, decodeTable(liveMap(model), regs));
}

/** Identity (and optional firmware) registers → info metrics. */
export function decodeInfo(model: SungrowModel, regs: RegisterImage): Metrics {
  const t = decodeTable([...INFO_MAP, ...FIRMWARE_MAP], regs);
  const out: Metrics = { 'Model name': `Sungrow ${model.name}` };
  const code = regs.get(TYPE_ADDR);
  const fam = code === undefined ? undefined : typeFamily(code);
  if (fam) out['Model name'] = `Sungrow ${fam.name}`;
  if (code !== undefined && code !== 0 && code !== 0xffff) out['Device type code'] = `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
  for (const k of ['Serial number', 'Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && /[A-Za-z0-9]{3}/.test(v)) out[k] = v;
  }
  if (typeof t['Rated power'] === 'number' && t['Rated power'] > 0 && t['Rated power'] < 0xffff * 100) out['Rated power'] = t['Rated power'];
  if (typeof t['Output type'] === 'string') out['Output type'] = t['Output type'];
  return out;
}

function readOnlyError(what: string) {
  return new Error(`Sungrow driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class SungrowDriver implements InverterDriver {
  readonly model: SungrowModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = sungrowModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, opts.address || 1));
    this.infoMetrics = { 'Model name': `Sungrow ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  private async read4(start: number, count: number) {
    try {
      return await this.conn.read(4, start, count);
    } catch (err) {
      throw explainError(this.conn, err);
    }
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    image(COMMON_SPAN[0], await this.read4(COMMON_SPAN[0], COMMON_SPAN[1]), regs);
    try {
      image(FIRMWARE_SPAN[0], await this.conn.read(4, FIRMWARE_SPAN[0], FIRMWARE_SPAN[1]), regs);
    } catch {
      // Older protocol revisions have no firmware strings; not fatal.
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    image(COMMON_SPAN[0], await this.read4(COMMON_SPAN[0], COMMON_SPAN[1]), regs);
    if (this.model.battery) {
      image(HYBRID_SPAN[0], await this.read4(HYBRID_SPAN[0], HYBRID_SPAN[1]), regs);
    } else {
      try {
        image(SG_METER_SPAN[0], await this.conn.read(4, SG_METER_SPAN[0], SG_METER_SPAN[1]), regs);
      } catch {
        // No meter block on this firmware.
      }
    }
    return decodeLive(this.model, regs);
  }

  settingDefs(): SettingDef[] {
    return settingsFor(this.model.id).map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of settingSpans(this.model.id)) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(settingsFor(this.model.id), regs);
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
