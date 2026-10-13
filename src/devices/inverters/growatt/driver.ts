/** The Growatt Modbus driver shared by every model family. */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeInfo, INFO_SPAN, type GrowattFamily } from './family.ts';
import { decodeTable, image, planReads, type RegisterImage } from './registers.ts';
import { decodeSettings, encodeSetting, settingSpans } from './settings.ts';
import { spf } from './spf.ts';
import { sph, sph3 } from './sph.ts';
import { tlx, tlxh } from './tl.ts';
import { wit } from './wit.ts';

export const FAMILIES: GrowattFamily[] = [spf, sph, sph3, tlxh, tlx, wit];

/** Families whose protocol is unverified on hardware: settings and raw writes are refused. */
export const READ_ONLY_FAMILIES = ['wit'];

/** Model id → family; unknown ids fall back to SPF (the most common unit on these systems). */
export function growattFamily(modelId: string): GrowattFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? spf;
}

/** Decodes one poll's worth of input registers into Sunroost metrics. */
export function decodeInputs(family: GrowattFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.inputMap, regs));
}

/**
 * Console helper: decodes a raw register range with the family's tables. Input registers give the
 * raw table values (before derivation, so each maps to a register); holding registers give the info
 * table plus any settings fully inside the range, keyed by setting label.
 */
export function decodeRange(family: GrowattFamily, fn: number, start: number, registers: number[]): Record<string, number | string> {
  const regs = image(start, registers);
  if (fn === 4) return decodeTable(family.inputMap, regs) as Record<string, number | string>;
  if (fn !== 3) return {};
  const out = decodeTable(family.holdingMap, regs) as Record<string, number | string>;
  const values = decodeSettings(family.settings, regs);
  for (const def of family.settings) {
    if (def.key in values) out[`${def.label}${def.verified ? '' : ' (unverified)'}`] = String(values[def.key]);
  }
  return out;
}

export class GrowattDriver implements InverterDriver {
  readonly family: GrowattFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.family = growattFamily(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, opts.address || 1));
    this.infoMetrics = { 'Model name': `Growatt ${this.family.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    this.infoMetrics = { ...this.infoMetrics, ...(await this.readInfo()) };
  }

  /** Info registers; missing ones are not fatal (some firmware rejects parts of the range). */
  private async readInfo(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    try {
      image(INFO_SPAN[0], await this.conn.read(3, INFO_SPAN[0], INFO_SPAN[1]), regs);
    } catch {
      for (const [start, count] of [[9, 6], [23, 5]] as const) {
        try {
          image(start, await this.conn.read(3, start, count), regs);
        } catch {}
      }
    }
    return decodeInfo(this.family, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.family.inputBlocks) image(start, await this.conn.read(4, start, count), regs);
    return decodeInputs(this.family, regs);
  }

  settingDefs(): SettingDef[] {
    // Strip the register bookkeeping; callers only need the SettingDef contract.
    return this.family.settings.map(({ reg: _r, codec: _c, verified: _v, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of planReads(settingSpans(this.family.settings))) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // An unsupported range on this firmware: leave those settings blank rather than failing all.
      }
    }
    return decodeSettings(this.family.settings, regs);
  }

  async writeSetting(key: string, value: Value) {
    const def = this.family.settings.find((d) => d.key === key);
    if (!def) throw new Error(`Unknown setting: ${key}`);
    if (READ_ONLY_FAMILIES.includes(this.family.id)) throw new Error(`Growatt ${this.family.name} is read-only`);
    if (def.reg === undefined || def.readOnly) throw new Error(`'${def.label}' is read-only on this model`);
    await this.conn.write(def.reg, encodeSetting(def, value));
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  rawWrite(start: number, values: number[]): Promise<void> {
    if (READ_ONLY_FAMILIES.includes(this.family.id)) return Promise.reject(new Error(`Growatt ${this.family.name} is read-only`));
    return this.conn.write(start, values);
  }
}
