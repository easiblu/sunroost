/**
 * Luxpower / EG4 driver: Modbus RTU (RS485 19200 8N1) or Modbus TCP / Solarman through
 * ModbusConnection, or the Luxpower WiFi dongle (luxpower://…) through LuxDongleClient.
 * Read-only until checked on hardware: settings are decoded and shown, never written.
 */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { LuxDongleClient, parseLuxConnection } from './dongle.ts';
import {
  decodeInfo, decodeTable, deriveLive, HOLDING_INFO, image, INPUT, INPUT_BLOCKS, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_BLOCKS, SETTINGS } from './settings.ts';

/** What the driver needs from a transport; ModbusConnection and LuxDongleClient both fit. */
export interface RegisterBus {
  connect(): Promise<void>;
  close(): Promise<void>;
  read(fn: 3 | 4, start: number, count: number): Promise<number[]>;
}

export interface LuxModel {
  id: string;
  name: string;
  pv: boolean;
}

export const MODELS: LuxModel[] = [
  { id: 'hybrid', name: 'Hybrid (LXP-LB, SNA, EG4 18kPV / 12kPV / 6000XP / FlexBOSS)', pv: true },
  { id: 'ac', name: 'LXP AC-coupled (no PV)', pv: false },
];

export function luxModel(id: string): LuxModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export const READ_ONLY_ERROR = 'The Luxpower driver is read-only until it has been verified on hardware';

/** Console helper: decodes a raw range with the tables. */
export function decodeRange(fn: number, start: number, registers: number[]): Record<string, number | string> {
  const regs = image(start, registers);
  if (fn === 4) return decodeTable(INPUT, regs) as Record<string, number | string>;
  if (fn !== 3) return {};
  const out = decodeTable(HOLDING_INFO, regs) as Record<string, number | string>;
  const values = decodeSettings(SETTINGS, regs);
  for (const def of SETTINGS) if (def.key in values) out[def.label] = String(values[def.key]);
  return out;
}

export class LuxpowerDriver implements InverterDriver {
  readonly model: LuxModel;
  readonly bus: RegisterBus;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = luxModel(opts.modelId);
    const lux = parseLuxConnection(opts.connection);
    this.bus = lux
      ? new LuxDongleClient(lux)
      : new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 19200, opts.address || 1));
    this.infoMetrics = { 'Model name': this.modelName() };
  }

  private modelName() {
    return this.model.pv ? 'Luxpower hybrid' : 'Luxpower AC-coupled';
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.bus.connect();
    this.infoMetrics = { 'Model name': this.modelName(), ...(await this.readInfo()) };
  }

  /** Info registers; each span is optional (firmware differs in what it answers). */
  private async readInfo(): Promise<Metrics> {
    const holding: RegisterImage = new Map();
    const input: RegisterImage = new Map();
    for (const [fn, start, count, into] of [[3, 0, 16, holding], [3, 115, 5, holding], [4, 115, 5, input]] as const) {
      try {
        image(start, await this.bus.read(fn, start, count), into);
      } catch {}
    }
    const out = decodeInfo(holding, input);
    if (!out['Serial number'] && this.bus instanceof LuxDongleClient && this.bus.inverterSerial) {
      out['Serial number'] = this.bus.inverterSerial;
    }
    return out;
  }

  async close() {
    await this.bus.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const [i, [start, count]] of INPUT_BLOCKS.entries()) {
      try {
        image(start, await this.bus.read(4, start, count), regs);
      } catch (err) {
        if (i === 0) throw err; // the live block is required
      }
    }
    return deriveLive(decodeTable(INPUT, regs), { pv: this.model.pv });
  }

  settingDefs(): SettingDef[] {
    return SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_BLOCKS) {
      try {
        image(start, await this.bus.read(3, start, count), regs);
      } catch {}
    }
    return decodeSettings(SETTINGS, regs);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    const def = SETTINGS.find((d) => d.key === key);
    throw new Error(def ? `'${def.label}': ${READ_ONLY_ERROR}` : `Unknown setting: ${key}`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.bus.read(fn, start, count);
  }

  rawWrite(_start: number, _values: number[]): Promise<void> {
    return Promise.reject(new Error(READ_ONLY_ERROR));
  }
}
