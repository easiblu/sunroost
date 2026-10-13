/** The Victron GX Modbus TCP driver (read-only). */
import type { Metrics, Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  decodeLive, decodeSerial, image, SYSTEM_AC_SPAN, SYSTEM_BATTERY_SPAN, SYSTEM_DC_SPAN, SYSTEM_DCPV_SPAN,
  SYSTEM_SERIAL_SPAN, SYSTEM_UNIT, VEBUS_SPAN, VEBUS_TEMP_SPAN, VEBUS_UNITS, type RegisterImage,
} from './registers.ts';
import { decodeSettings, SETTING_SPANS, VICTRON_SETTINGS } from './settings.ts';

export const MODEL_NAME = 'Victron GX (MultiPlus-II, EasySolar-II, Quattro)';
export const MODELS = [{ id: 'gx', name: MODEL_NAME }];

/** Polls between retries of the VE.Bus unit search when none answered. */
const REDISCOVER_EVERY = 20;

function readOnlyError(what: string) {
  return new Error(`Victron driver is read-only (not yet verified on hardware): can't write ${what}`);
}

export class VictronDriver implements InverterDriver {
  private conn: ModbusConnection;
  private systemUnit: number;
  /** VE.Bus unit id that answered, or null (system-only). */
  vebusUnit: number | null = null;
  private pollsSinceSearch = 0;
  private infoMetrics: Metrics = { 'Model name': MODEL_NAME };

  constructor(opts: DriverOptions) {
    this.systemUnit = opts.address || SYSTEM_UNIT;
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, this.systemUnit));
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    try {
      const sys = image(SYSTEM_SERIAL_SPAN[0], await this.conn.read(3, SYSTEM_SERIAL_SPAN[0], SYSTEM_SERIAL_SPAN[1], this.systemUnit));
      const serial = decodeSerial(sys);
      if (serial) this.infoMetrics['Serial number'] = serial;
    } catch {
      // Serial is informational only.
    }
    await this.findVebus();
  }

  /** Tries each candidate VE.Bus unit (reading its state register) and keeps the first that answers. */
  private async findVebus() {
    this.pollsSinceSearch = 0;
    for (const unit of VEBUS_UNITS) {
      try {
        await this.conn.read(3, 31, 1, unit);
        this.vebusUnit = unit;
        this.infoMetrics['VE.Bus unit id'] = unit;
        return;
      } catch {
        // Not on this unit id.
      }
    }
    this.vebusUnit = null;
    delete this.infoMetrics['VE.Bus unit id'];
  }

  async close() {
    await this.conn.close();
  }

  private async readSystem(): Promise<RegisterImage> {
    const sys: RegisterImage = new Map();
    for (const [start, count] of [SYSTEM_AC_SPAN, SYSTEM_BATTERY_SPAN, SYSTEM_DCPV_SPAN]) {
      image(start, await this.conn.read(3, start, count, this.systemUnit), sys);
    }
    try {
      image(SYSTEM_DC_SPAN[0], await this.conn.read(3, SYSTEM_DC_SPAN[0], SYSTEM_DC_SPAN[1], this.systemUnit), sys);
    } catch {
      // DC system power is missing on older firmware.
    }
    return sys;
  }

  private async readVebus(): Promise<RegisterImage | null> {
    if (this.vebusUnit === null) {
      if (++this.pollsSinceSearch < REDISCOVER_EVERY) return null;
      await this.findVebus();
      if (this.vebusUnit === null) return null;
    }
    const unit = this.vebusUnit;
    let vb: RegisterImage;
    try {
      vb = image(VEBUS_SPAN[0], await this.conn.read(3, VEBUS_SPAN[0], VEBUS_SPAN[1], unit));
    } catch {
      // Inverter gone (switched off, VE.Bus cable): keep system data, search again later.
      this.vebusUnit = null;
      this.pollsSinceSearch = 0;
      return null;
    }
    try {
      image(VEBUS_TEMP_SPAN[0], await this.conn.read(3, VEBUS_TEMP_SPAN[0], VEBUS_TEMP_SPAN[1], unit), vb);
    } catch {
      // Battery temperature is optional.
    }
    return vb;
  }

  async read(): Promise<Metrics> {
    const sys = await this.readSystem();
    const vb = await this.readVebus();
    return decodeLive(sys, vb);
  }

  settingDefs(): SettingDef[] {
    return VICTRON_SETTINGS.map(({ unitKind: _u, reg: _r, decode: _d, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const sys: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
      try {
        image(start, await this.conn.read(3, start, count, this.systemUnit), sys);
      } catch {
        // Not available on this firmware: leave blank.
      }
    }
    let vb: RegisterImage | null = null;
    if (this.vebusUnit !== null) {
      try {
        vb = image(VEBUS_SPAN[0], await this.conn.read(3, VEBUS_SPAN[0], VEBUS_SPAN[1], this.vebusUnit));
      } catch {
        vb = null;
      }
    }
    return decodeSettings(sys, vb);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    throw readOnlyError(`setting '${key}'`);
  }

  /** Console reads go to the configured unit id (default 100, the system service). */
  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count, this.systemUnit);
  }

  async rawWrite(start: number, _values: number[]): Promise<void> {
    throw readOnlyError(`register ${start}`);
  }
}
