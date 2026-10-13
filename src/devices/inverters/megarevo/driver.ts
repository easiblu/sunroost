/** The Megarevo-protocol Modbus driver shared by every model family. Read-only. */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeSettings, settingSpans } from '../deye/settings.ts';
import {
  decodeInfoRaw, decodeTable, image, infoPlan, planReads, planTable, type MegarevoFamily, type RegisterImage,
} from './family.ts';
import { invtXd } from './invt.ts';
import { hybrid, split, three } from './megarevo.ts';

export const FAMILIES: MegarevoFamily[] = [hybrid, split, three, invtXd];

/** Model id → family; unknown ids fall back to the single-phase hybrid. */
export function megarevoFamily(modelId: string): MegarevoFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? hybrid;
}

/** Decodes one poll's register image into Sunroost metrics. */
export function decodeLive(family: MegarevoFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.liveMap, regs));
}

/** Decodes the info registers into info metrics. */
export function decodeInfo(family: MegarevoFamily, regs: RegisterImage): Metrics {
  return family.decodeInfo(decodeInfoRaw(family, regs));
}

export const READ_ONLY_ERROR = 'Megarevo/INVT driver is read-only: settings are not written until the register map is verified on hardware';

export class MegarevoDriver implements InverterDriver {
  readonly family: MegarevoFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;
  private plan: [number, number][];

  constructor(opts: DriverOptions) {
    this.family = megarevoFamily(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, opts.address || 1));
    this.infoMetrics = this.family.decodeInfo({});
    this.plan = planTable(this.family.liveMap);
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    for (const [start, count] of infoPlan(this.family)) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Firmware without this block: leave those info fields out.
      }
    }
    this.infoMetrics = { ...this.infoMetrics, ...decodeInfo(this.family, regs) };
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
    return this.family.settings.map(({ reg: _r, codec: _c, verified: _v, note: _n, ...def }) => ({ ...def, readOnly: true }));
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

  async writeSetting(key: string, _value: Value): Promise<void> {
    throw new Error(`${READ_ONLY_ERROR} (refused '${key}')`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  async rawWrite(_start: number, _values: number[]): Promise<void> {
    throw new Error(READ_ONLY_ERROR);
  }
}
