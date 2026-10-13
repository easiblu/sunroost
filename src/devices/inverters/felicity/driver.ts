/** The Felicity Modbus driver shared by every register family. Read-only. */
import type { Metrics } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeInfo, INFO_COUNT, INFO_COUNT_MIN, INFO_START, type FelicityFamily } from './family.ts';
import { hv3 } from './hv3.ts';
import { ivem } from './ivem.ts';
import { decodeTable, image, type RegisterImage } from './registers.ts';
import { decodeSettings, publicDef, settingReads } from './settings.ts';
import { trex } from './trex.ts';

export const FAMILIES: FelicityFamily[] = [ivem, trex, hv3];

/** Model id → family; unknown ids fall back to IVEM (the most common Felicity unit). */
export function felicityFamily(modelId: string): FelicityFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? ivem;
}

export function decodeLive(family: FelicityFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.live, regs));
}

/**
 * Console helper: raw table values (before derivation) plus settings for a holding range, and the
 * info block decoded when the range covers it.
 */
export function decodeRange(family: FelicityFamily, start: number, registers: number[]): Record<string, string | number> {
  const regs = image(start, registers);
  const out = decodeTable(family.live, regs) as Record<string, string | number>;
  const values = decodeSettings(family.settings, regs);
  for (const s of family.settings) if (s.key in values) out[s.label] = String(values[s.key]);
  if (regs.has(0xf804)) Object.assign(out, decodeInfo(family, regs));
  return out;
}

export const READ_ONLY_MESSAGE = 'The Felicity driver is read-only until its registers have been verified on hardware';

export class FelicityDriver implements InverterDriver {
  readonly family: FelicityFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.family = felicityFamily(opts.modelId);
    // Felicity's RS232/RS485 port defaults to 2400 baud; the slow link needs a longer timeout.
    const target = parseConnection(opts.connection, opts.baudRate || 2400, opts.address || 1);
    this.conn = new ModbusConnection({ ...target, timeoutMs: (opts.baudRate || 2400) <= 4800 ? 3000 : 1500 });
    this.infoMetrics = { 'Model name': `Felicity ${this.family.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    this.infoMetrics = { ...this.infoMetrics, ...(await this.readInfo()) };
  }

  /** Info block; a unit that rejects it just keeps the fallback model name. */
  private async readInfo(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const count of [INFO_COUNT, INFO_COUNT_MIN]) {
      try {
        image(INFO_START, await this.conn.read(3, INFO_START, count), regs);
        break;
      } catch {}
    }
    return decodeInfo(this.family, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.family.blocks) image(start, await this.conn.read(3, start, count), regs);
    return decodeLive(this.family, regs);
  }

  settingDefs(): SettingDef[] {
    return this.family.settings.map(publicDef);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of settingReads(this.family.settings)) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Range not supported on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(this.family.settings, regs);
  }

  async writeSetting(key: string): Promise<void> {
    const def = this.family.settings.find((d) => d.key === key);
    throw new Error(`${def ? `'${def.label}' is read-only: ` : `Unknown setting ${key}: `}${READ_ONLY_MESSAGE}`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3) return Promise.reject(new Error('Felicity inverters only answer function 3 (holding registers)'));
    return this.conn.read(3, start, count);
  }

  async rawWrite(): Promise<void> {
    throw new Error(READ_ONLY_MESSAGE);
  }
}
