/**
 * Contracts every inverter and battery (BMS) driver implements.
 */
import type { Metrics, Value } from '../core/metrics.ts';
import type { ModbusConnection } from './modbus.ts';

/**
 * A writable inverter setting. `key` is the snake_case of the label, which is also the
 * MQTT topic segment (e.g. "Output source priority" → output_source_priority).
 */
export interface SettingDef {
  key: string;
  label: string;
  /** Card the setting appears in on the inverter settings page, e.g. "Battery", "Grid", "Work mode". */
  section: string;
  /**
   * select: one of `options`; number: min/max/step; checkbox: boolean; time: "HH:MM";
   * slot: a time window "HH:MM,HH:MM,true" (start,end,enabled) or with a priority "HH:MM,HH:MM,Battery first,true".
   */
  type: 'select' | 'number' | 'checkbox' | 'time' | 'slot';
  options?: string[];
  /** For `slot` settings that carry a priority, its options. */
  slotPriorities?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Short help text shown under the field. */
  help?: string;
  readOnly?: boolean;
}

export type SettingValues = Record<string, Value>;

/** Which setting the automation engine flips for "switch to grid" / "switch to battery". */
export interface SocControl {
  setting: string;
  gridValue: string;
  batteryValue: string;
}

export interface InverterDriver {
  /** Static information shown on the settings page (driver, model, serial …). */
  info(): Metrics;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** One poll: live readings. Info metrics may be included and are merged into state. */
  read(): Promise<Metrics>;
  settingDefs(): SettingDef[];
  readSettings(): Promise<SettingValues>;
  /** Writes one setting. `value` is already validated against its definition. */
  writeSetting(key: string, value: Value): Promise<void>;
  /** Raw Modbus access for the diagnostics console, when the driver speaks Modbus. */
  rawRead?(fn: number, start: number, count: number): Promise<number[]>;
  rawWrite?(start: number, values: number[]): Promise<void>;
  /** Raw text-protocol access (e.g. Voltronic "QPIGS") for the command console. Returns the reply payload. */
  rawCommand?(command: string): Promise<string>;
  /** Readings, if the inverter has a BMS link, for "read from inverter" battery mode. */
  batteryPacks?(): Promise<Metrics[]>;
}

export interface DriverOption {
  id: string;
  name: string;
}

export interface InverterDriverDescriptor {
  id: string;
  name: string;
  manufacturer: string;
  models?: DriverOption[];
  /** Readings only: settings are shown but can't be changed (protocol not verified on hardware). */
  readOnly?: boolean;
  /** Model ids that are read-only even though the driver isn't. */
  readOnlyModels?: string[];
  /** How the driver connects; drives the connection picker in the UI. */
  transport: 'serial' | 'tcp' | 'none';
  defaultBaudRate?: number;
  /** Baud rates auto-detect tries (default: just defaultBaudRate). */
  detectBaudRates?: number[];
  /** Modbus unit id used when the user hasn't set one (default 1). */
  defaultAddress?: number;
  /** Modbus function codes the console offers, e.g. [{ id: '4', name: 'Input register' }]. */
  consoleFunctions?: DriverOption[];
  /** The setting automations toggle for SOC control, per model. */
  socControl?(modelId: string): SocControl | null;
  /** Setting used for battery-protection shutdown, per model. */
  protectionSetting?(modelId: string): { setting: string; shutdownValue: Value } | null;
  create(opts: DriverOptions): InverterDriver;
  /**
   * Auto-detect probe for Modbus drivers: reads (never writes) a few identifying registers on an
   * open connection at `defaultBaudRate`. Returns what it found, or null if this isn't one.
   */
  detect?(conn: ModbusConnection): Promise<Detection | null>;
}

export interface Detection {
  /** Model id inside the driver, when the probe can tell. */
  modelId?: string;
  /** What was seen, for the user (e.g. "device type 3, serial 2106123456"). */
  evidence: string;
  /** The Modbus unit id that answered, when the probe tried more than one. */
  address?: number;
}

export interface DriverOptions {
  modelId: string;
  /** Serial device path, or host:port for TCP. */
  connection: string;
  baudRate: number;
  address: number;
  /** Position in the parallel stack, starting at 0. */
  index: number;
  /** Text protocols (Voltronic): reject replies with a bad CRC. */
  verifyCrc?: boolean;
}

export interface BmsDriver {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** One poll: a Metrics map per battery pack. */
  read(): Promise<Metrics[]>;
}

export interface BmsDriverDescriptor {
  id: string;
  name: string;
  transport: 'serial' | 'none';
  defaultBaudRate?: number;
  /** Protocol variants, e.g. JK "RS485 adapter" vs "inverter port". */
  models?: DriverOption[];
  /** Whether several connections (one per pack/port) may be selected. */
  multiConnection?: boolean;
  create(opts: { connections: string[]; baudRate: number; modelId: string }): BmsDriver;
}
