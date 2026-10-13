/** The read-only Sumry (SMG-II Modbus) driver shared by both register maps. */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeTable, image, planReads, type RegisterImage } from '../growatt/registers.ts';
import { decodeSettings, settingSpans } from '../growatt/settings.ts';
import { smgExt } from './ext.ts';
import { decodeInfo, type SumryFamily } from './family.ts';
import { smg } from './smg.ts';

export const FAMILIES: SumryFamily[] = [smg, smgExt];

export const READ_ONLY_MESSAGE = 'Sumry driver is read-only: the register map has not been verified on hardware';

/** Model id → family; unknown ids fall back to the classic SMG-II map. */
export function sumryFamily(modelId: string): SumryFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? smg;
}

/** Decodes one poll's register image into Sunroost metrics. */
export function decodeLive(family: SumryFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.liveMap, regs));
}

/** Console helper: raw table values plus info and any settings inside a holding range. */
export function decodeRange(family: SumryFamily, fn: number, start: number, registers: number[]): Record<string, number | string> {
  if (fn !== 3) return {};
  const regs = image(start, registers);
  const out = { ...decodeTable(family.infoMap, regs), ...decodeTable(family.liveMap, regs) } as Record<string, number | string>;
  const values = decodeSettings(family.settings, regs);
  for (const def of family.settings) {
    if (def.key in values) out[`${def.label} (unverified)`] = String(values[def.key]);
  }
  return out;
}

export class SumryDriver implements InverterDriver {
  readonly family: SumryFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.family = sumryFamily(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, opts.address || 1));
    this.infoMetrics = { 'Model name': this.family.name };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    this.infoMetrics = { ...this.infoMetrics, ...(await this.readInfo()) };
  }

  /** Info registers; a rejected range is not fatal. */
  private async readInfo(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.family.infoBlocks) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {}
    }
    const out = decodeInfo(this.family, regs);
    for (const [k, v] of Object.entries(decodeTable(this.family.infoMap, regs))) {
      if (k !== 'Serial number' && typeof v === 'number' && v > 0 && v !== 0xffff) out[k] = v;
    }
    return out;
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.family.liveBlocks) image(start, await this.conn.read(3, start, count), regs);
    return decodeLive(this.family, regs);
  }

  settingDefs(): SettingDef[] {
    return this.family.settings.map(({ reg: _r, codec: _c, verified: _v, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of planReads(settingSpans(this.family.settings))) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Range not supported on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(this.family.settings, regs);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    const def = this.family.settings.find((d) => d.key === key);
    if (!def) throw new Error(`Unknown setting: ${key}`);
    throw new Error(`'${def.label}' is read-only. ${READ_ONLY_MESSAGE}.`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  async rawWrite(_start: number, _values: number[]): Promise<void> {
    throw new Error(`Raw writes refused. ${READ_ONLY_MESSAGE}.`);
  }
}
