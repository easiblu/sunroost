/** The Livoltek Modbus driver (read-only) for the Hyper and HP3 series. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  decodeTable, ENERGY_MAP, ENERGY_SPAN, FIRMWARE_MAP, FIRMWARE_SPAN, image, INFO_MAP, INFO_SPAN, LIVE_MAP, LIVE_SPAN,
  type RegisterImage,
} from './registers.ts';
import { decodeSettings, LIVOLTEK_SETTINGS, SETTING_SPANS } from './settings.ts';

/** Livoltek's default Modbus unit id (community-verified on a Hyper-6000). */
export const LIVOLTEK_ADDRESS = 17;

export interface LivoltekModel {
  id: string;
  name: string;
}

export const MODELS: LivoltekModel[] = [
  { id: 'hyper', name: 'Hyper series (Hyper-2000…6000, single-phase hybrid)' },
  { id: 'hp3', name: 'HP3 series (HP3-5KD2…12KL2, HP3-xxKS1LV)' },
];

export function livoltekModel(id: string): LivoltekModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/** Model text from holding 570–574 → model id, when it names a series. */
export function modelFromName(name: string): string | undefined {
  if (/HP3/i.test(name)) return 'hp3';
  if (/HYPER/i.test(name)) return 'hyper';
  return undefined;
}

function num(m: Metrics, k: string) {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}

/** Raw table values → Sunroost metrics. */
export function derive(raw: Metrics): Metrics {
  const out: Metrics = { ...raw };
  // Total PV: the 32-bit total when present, else the sum of the strings.
  const strings = num(raw, 'PV power 1') + num(raw, 'PV power 2');
  if (typeof raw['PV power'] !== 'number' || (raw['PV power'] === 0 && strings > 0)) out['PV power'] = strings;
  // Battery power falls back to V × I when the power register reads 0 but current flows.
  if (num(raw, 'Battery power') === 0 && num(raw, 'Battery current') !== 0) {
    out['Battery power'] = round(num(raw, 'Battery voltage') * num(raw, 'Battery current'), 0);
  }
  if (typeof raw['Grid power'] === 'number') out['Grid power'] = round(num(raw, 'Grid power'), 0);
  return out;
}

export function decodeLive(regs: RegisterImage): Metrics {
  return derive({ ...decodeTable(LIVE_MAP, regs), ...decodeTable(ENERGY_MAP, regs) });
}

export function decodeInfo(model: LivoltekModel, regs: RegisterImage): Metrics {
  const t = { ...decodeTable(INFO_MAP, regs), ...decodeTable(FIRMWARE_MAP, regs) };
  const out: Metrics = { 'Model name': `Livoltek ${model.name}` };
  for (const k of ['Model name', 'Serial number', 'Hardware version']) {
    const v = t[k];
    if (typeof v === 'string' && v) out[k] = k === 'Model name' && !/livoltek/i.test(v) ? `Livoltek ${v}` : v;
  }
  const fw = ['MDSP version', 'SDSP version', 'ARM version']
    .map((k) => t[k])
    .filter((v): v is number => typeof v === 'number' && v !== 0 && v !== 0xffff);
  if (fw.length) out['Firmware version'] = fw.join(' / ');
  return out;
}

function readOnlyError(what: string) {
  return new Error(`Livoltek driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class LivoltekDriver implements InverterDriver {
  readonly model: LivoltekModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = livoltekModel(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, opts.address || LIVOLTEK_ADDRESS));
    this.infoMetrics = { 'Model name': `Livoltek ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    for (const [start, count] of [INFO_SPAN, FIRMWARE_SPAN]) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Not every firmware answers every info range; not fatal.
      }
    }
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    image(LIVE_SPAN[0], await this.conn.read(3, LIVE_SPAN[0], LIVE_SPAN[1]), regs);
    try {
      image(ENERGY_SPAN[0], await this.conn.read(3, ENERGY_SPAN[0], ENERGY_SPAN[1]), regs);
    } catch {
      // Energy/grid block missing: live values still useful.
    }
    return decodeLive(regs);
  }

  settingDefs(): SettingDef[] {
    return LIVOLTEK_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range: leave those settings blank.
      }
    }
    return decodeSettings(LIVOLTEK_SETTINGS, regs);
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
