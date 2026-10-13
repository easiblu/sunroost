/** The Deye / Sunsynk Modbus driver shared by every model family. */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeInfo, INFO_MAP, INFO_SPAN, livePlan, type DeyeFamily } from './family.ts';
import { decodeTable, image, planReads, type RegisterImage } from './registers.ts';
import { decodeSettings, encodeSetting, settingSpans } from './settings.ts';
import { hybrid, stringInverter } from './single.ts';
import { hybrid3, hybrid3hv } from './three.ts';

export const FAMILIES: DeyeFamily[] = [hybrid, hybrid3, hybrid3hv, stringInverter];

/** Model id → family; unknown ids fall back to the single-phase hybrid. */
export function deyeFamily(modelId: string): DeyeFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? hybrid;
}

/** Decodes one poll's register image into Sunroost metrics. */
export function decodeLive(family: DeyeFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.liveMap, regs));
}

/** Console helper: raw table values plus info and any settings inside the range. */
export function decodeRange(family: DeyeFamily, fn: number, start: number, registers: number[]): Record<string, number | string> {
  if (fn !== 3) return {};
  const regs = image(start, registers);
  const out = { ...decodeTable(INFO_MAP, regs), ...decodeTable(family.liveMap, regs) } as Record<string, number | string>;
  const values = decodeSettings(family.settings, regs);
  for (const def of family.settings) {
    if (def.key in values) out[`${def.label}${def.verified ? '' : ' (unverified)'}`] = String(values[def.key]);
  }
  return out;
}

export class DeyeDriver implements InverterDriver {
  readonly family: DeyeFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;
  private plan: [number, number][];

  constructor(opts: DriverOptions) {
    this.family = deyeFamily(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, opts.address || 1));
    this.infoMetrics = { 'Model name': `Deye ${this.family.name}` };
    this.plan = livePlan(this.family);
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    this.infoMetrics = { ...this.infoMetrics, ...(await this.readInfo()) };
  }

  private async readInfo(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    try {
      image(INFO_SPAN[0], await this.conn.read(3, INFO_SPAN[0], INFO_SPAN[1]), regs);
    } catch {
      // Some firmware rejects parts of the block; fall back to the serial number alone.
      try {
        image(3, await this.conn.read(3, 3, 5), regs);
      } catch {}
    }
    return decodeInfo(this.family, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.plan) image(start, await this.conn.read(3, start, count), regs);
    return decodeLive(this.family, regs);
  }

  settingDefs(): SettingDef[] {
    return this.family.settings.map(({ reg: _r, codec: _c, verified: _v, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of planReads(settingSpans(this.family.settings), 30)) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(this.family.settings, regs);
  }

  async writeSetting(key: string, value: Value) {
    const def = this.family.settings.find((d) => d.key === key);
    if (!def) throw new Error(`Unknown setting: ${key}`);
    if (def.reg === undefined || def.readOnly) throw new Error(`'${def.label}' is read-only on this model`);
    // Bit settings share a register (TOU enable + weekdays, grid/gen charge flags): read-modify-write.
    const current = def.codec.kind === 'bit' ? (await this.conn.read(3, def.reg, 1))[0] : 0;
    await this.conn.write(def.reg, [encodeSetting(def, value, current)], { multiple: true });
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  rawWrite(start: number, values: number[]): Promise<void> {
    return this.conn.write(start, values, { multiple: true });
  }
}
