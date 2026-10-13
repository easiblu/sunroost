/**
 * GoodWe driver: Modbus RTU (RS485 9600 8N1, unit 247), Modbus TCP / Solarman through
 * ModbusConnection, or the GoodWe WiFi/LAN dongle (goodwe://host[:8899]) through GoodweUdpClient —
 * Modbus-over-UDP for the ET family, AA55 for the legacy ES family.
 * Read-only until checked on hardware: settings are decoded and shown, never written.
 */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  BMS_SPAN, decodeBytes, decodeEsInfo, decodeEtInfo, decodeTable, deriveEs, deriveEt, ES_RUNNING, ET_BMS, ET_INFO, ET_LIVE, ET_METER,
  image, INFO_SPAN, LIVE_SPAN, METER_SPAN, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPANS, SETTINGS } from './settings.ts';
import { AA55_DEVICE_INFO, AA55_RUNNING_INFO, GOODWE_UNIT, GoodweUdpClient, parseGoodweConnection } from './udp.ts';

export interface GoodweModel {
  id: string;
  name: string;
  /** 'modbus' = ET register map; 'aa55' = legacy ES protocol (dongle only). */
  protocol: 'modbus' | 'aa55';
  phases: 1 | 2 | 3;
}

export const MODELS: GoodweModel[] = [
  { id: 'et', name: 'ET / BT / ET G2 three-phase hybrid', protocol: 'modbus', phases: 3 },
  { id: 'eh', name: 'EH / BH / ES G2 / ES Uniq / EHB single-phase hybrid', protocol: 'modbus', phases: 1 },
  { id: 'et-split', name: 'GW-ES split-phase hybrid (ET register map)', protocol: 'modbus', phases: 2 },
  { id: 'es', name: 'ES / EM / BP legacy single-phase hybrid (AA55, WiFi dongle)', protocol: 'aa55', phases: 1 },
];

export function goodweModel(id: string): GoodweModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export const READ_ONLY_ERROR = 'The GoodWe driver is read-only until it has been verified on hardware';

/** What the driver needs from a transport. */
interface Bus {
  connect(): Promise<void>;
  close(): Promise<void>;
  read(fn: 3 | 4, start: number, count: number): Promise<number[]>;
  aa55?(ctrl: number, func: number): Promise<Buffer>;
}

function makeBus(opts: DriverOptions): Bus {
  const unit = opts.address || GOODWE_UNIT;
  const udp = parseGoodweConnection(opts.connection);
  if (udp) {
    const client = new GoodweUdpClient(udp);
    return {
      connect: () => client.connect(),
      close: () => client.close(),
      read: (fn, start, count) => client.read(fn, start, count, unit),
      aa55: (ctrl, func) => client.aa55(ctrl, func),
    };
  }
  const conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || 9600, unit));
  return { connect: () => conn.connect(), close: () => conn.close(), read: (fn, start, count) => conn.read(fn, start, count) };
}

/** Console helper: decodes a raw holding range with the ET tables. */
export function decodeRange(fn: number, start: number, registers: number[]): Record<string, number | string> {
  if (fn !== 3) return {};
  const regs = image(start, registers);
  const out = decodeTable([...ET_INFO, ...ET_LIVE, ...ET_METER, ...ET_BMS], regs) as Record<string, number | string>;
  const values = decodeSettings(SETTINGS, regs);
  for (const def of SETTINGS) if (def.key in values) out[def.label] = String(values[def.key]);
  return out;
}

export class GoodweDriver implements InverterDriver {
  readonly model: GoodweModel;
  private bus: Bus;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.model = goodweModel(opts.modelId);
    this.bus = makeBus(opts);
    this.infoMetrics = { 'Model name': `GoodWe ${this.model.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  private requireAa55() {
    if (!this.bus.aa55) throw new Error('GoodWe ES/EM/BP (AA55) needs the WiFi/LAN dongle: use a goodwe://ip connection');
    return this.bus.aa55;
  }

  async connect() {
    if (this.model.protocol === 'aa55') this.requireAa55();
    await this.bus.connect();
    let info: Metrics = {};
    try {
      if (this.model.protocol === 'aa55') {
        info = decodeEsInfo(await this.requireAa55()(...AA55_DEVICE_INFO));
      } else {
        info = decodeEtInfo(image(INFO_SPAN[0], await this.bus.read(3, ...INFO_SPAN)));
      }
    } catch {
      // Info is optional; live reads decide whether the connection works.
    }
    this.infoMetrics = { 'Model name': `GoodWe ${this.model.name}`, ...info };
  }

  async close() {
    await this.bus.close();
  }

  async read(): Promise<Metrics> {
    if (this.model.protocol === 'aa55') {
      const payload = await this.requireAa55()(...AA55_RUNNING_INFO);
      return deriveEs(decodeBytes(ES_RUNNING, payload));
    }
    const regs: RegisterImage = new Map();
    image(LIVE_SPAN[0], await this.bus.read(3, ...LIVE_SPAN), regs);
    for (const span of [METER_SPAN, BMS_SPAN]) {
      try {
        image(span[0], await this.bus.read(3, ...span), regs);
      } catch {
        // No meter / no BMS link.
      }
    }
    const raw = decodeTable([...ET_LIVE, ...ET_METER, ...ET_BMS], regs);
    return deriveEt(raw, { phases: this.model.phases });
  }

  settingDefs(): SettingDef[] {
    if (this.model.protocol === 'aa55') return [];
    return SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    if (this.model.protocol === 'aa55') return {};
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
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
