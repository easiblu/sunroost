/** The Huawei SUN2000 Modbus driver (read-only). */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import {
  ALARM_MAP, ALARM_SPAN, BATTERY_STATUS, decodeTable, ENERGY_MAP, ENERGY_SPAN, IDENT_SPAN, image, INFO_MAP,
  MAIN_MAP, MAIN_SPAN, METER_MAP, METER_SPAN, PV_BASE, pvMap, RATING_SPAN, SYSTEM_MAP, SYSTEM_SPAN, UNIT1_MAP,
  UNIT1_SPAN, VERSION_SPAN, type RegisterImage,
} from './registers.ts';
import { decodeSettings, HUAWEI_SETTINGS, SETTING_SPANS } from './settings.ts';

export interface HuaweiModel {
  id: string;
  name: string;
  phases: 1 | 3;
  /** PV strings assumed until 30071 has been read. */
  strings: number;
}

export const MODELS: HuaweiModel[] = [
  { id: 'hybrid', name: 'SUN2000 KTL-L1 single-phase hybrid', phases: 1, strings: 2 },
  { id: 'three', name: 'SUN2000 KTL-M0/M1/M2/M3 three-phase', phases: 3, strings: 2 },
];

export function huaweiModel(id: string): HuaweiModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/**
 * Timing knobs. Huawei (SDongleA and the inverter's own Modbus TCP) drops requests sent right
 * after the TCP connect, so the driver waits before its first request. Tests set this to 0.
 */
export const timing = { connectDelayMs: 1000 };

/** Optional blocks that are re-tried this many polls after a read error. */
const RETRY_POLLS = 30;

function num(m: Metrics, k: string): number {
  const v = m[k];
  return typeof v === 'number' ? v : 0;
}
function has(m: Metrics, k: string) {
  return typeof m[k] === 'number';
}
function hex(v: number) {
  return `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Raw table values → Sunroost metrics. */
export function derive(model: HuaweiModel, raw: Metrics, strings: number): Metrics {
  const out: Metrics = {};
  for (const k of [
    'Device mode', 'Temperature', 'Inverter power', 'Input power', 'Reactive power', 'Power factor', 'Efficiency',
    'Insulation resistance', 'Peak power today', 'Inverter energy total', 'Inverter energy today',
  ]) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }

  // PV: per-string V × I; total falls back to the inverter's input power when no string reads.
  let pv = 0;
  let anyString = false;
  for (let n = 1; n <= strings; n++) {
    if (!has(raw, `PV voltage ${n}`)) continue;
    anyString = true;
    const v = num(raw, `PV voltage ${n}`);
    const i = num(raw, `PV current ${n}`);
    const p = Math.max(0, round(v * i, 0));
    out[`PV voltage ${n}`] = v;
    out[`PV current ${n}`] = i;
    out[`PV power ${n}`] = p;
    pv += p;
  }
  out['PV power'] = anyString ? pv : Math.max(0, num(raw, 'Input power'));

  // Inverter AC side.
  const freq = has(raw, 'Inverter frequency') ? num(raw, 'Inverter frequency') : undefined;
  if (has(raw, 'Inverter voltage 1')) out['AC output voltage'] = raw['Inverter voltage 1'];
  if (freq !== undefined) out['AC output frequency'] = freq;
  if (model.phases === 3) {
    for (const p of [1, 2, 3]) {
      if (has(raw, `Inverter voltage ${p}`)) out[`AC output voltage ${p}`] = raw[`Inverter voltage ${p}`];
      if (has(raw, `Inverter current ${p}`)) out[`AC output current ${p}`] = raw[`Inverter current ${p}`];
    }
  } else if (has(raw, 'Inverter current 1')) {
    out['AC output current'] = raw['Inverter current 1'];
  }

  // Grid: from the meter when it is online, else the inverter's own AC measurements.
  const meter = num(raw, 'Meter status') === 1;
  const phases = model.phases === 3 ? [1, 2, 3] : [1];
  if (meter) {
    out['Grid voltage'] = num(raw, 'Meter voltage 1');
    if (model.phases === 1) out['Grid current'] = num(raw, 'Meter current 1');
    out['Grid frequency'] = has(raw, 'Meter frequency') && num(raw, 'Meter frequency') > 0 ? num(raw, 'Meter frequency') : (freq ?? 0);
    // Huawei: + = feed-in. Sunroost: + = import.
    const grid = -num(raw, 'Meter power');
    out['Grid power'] = grid;
    if (model.phases === 3) {
      for (const p of phases) {
        out[`Grid voltage ${p}`] = num(raw, `Meter voltage ${p}`);
        out[`Grid current ${p}`] = num(raw, `Meter current ${p}`);
        if (has(raw, `Meter power ${p}`)) out[`Grid power ${p}`] = -num(raw, `Meter power ${p}`);
      }
    }
    // Load = what the inverter delivers + what comes from the grid.
    out['Load power'] = Math.max(0, num(raw, 'Inverter power') + grid);
    for (const k of ['Import energy total', 'Export energy total']) if (raw[k] !== undefined) out[k] = raw[k];
  } else {
    if (has(raw, 'Inverter voltage 1')) out['Grid voltage'] = raw['Inverter voltage 1'];
    if (freq !== undefined) out['Grid frequency'] = freq;
    if (model.phases === 3) for (const p of phases) if (has(raw, `Inverter voltage ${p}`)) out[`Grid voltage ${p}`] = raw[`Inverter voltage ${p}`];
  }

  // Battery: whole-system registers first, storage unit 1 as fallback.
  const sysUp = has(raw, 'System status raw') && (num(raw, 'System status raw') !== 0 || num(raw, 'Rated capacity raw') > 0);
  const unitUp = has(raw, 'Unit 1 status raw') && num(raw, 'Unit 1 status raw') !== 0;
  if (sysUp || unitUp) {
    const pick = (sys: string, unit: string) => (sysUp && has(raw, sys) ? num(raw, sys) : num(raw, unit));
    out['Battery state of charge'] = pick('System state of charge', 'Unit 1 state of charge');
    out['Battery voltage'] = pick('System voltage', 'Unit 1 voltage');
    out['Battery current'] = pick('System current', 'Unit 1 current');
    out['Battery power'] = pick('System power', 'Unit 1 power');
    out['Battery status'] = BATTERY_STATUS[sysUp ? num(raw, 'System status raw') : num(raw, 'Unit 1 status raw')] ?? 'Unknown';
    if (has(raw, 'Battery temperature')) out['Battery temperature'] = raw['Battery temperature'];
    if (num(raw, 'Rated capacity raw') > 0) out['Battery capacity'] = round(num(raw, 'Rated capacity raw') / 1000, 2);
    for (const k of ['Charge energy total', 'Discharge energy total', 'Charge energy today', 'Discharge energy today']) {
      if (raw[k] !== undefined) out[k] = raw[k];
    }
    if (out['Charge energy today'] === undefined && has(raw, 'Unit 1 charge energy today')) out['Charge energy today'] = raw['Unit 1 charge energy today'];
    if (out['Discharge energy today'] === undefined && has(raw, 'Unit 1 discharge energy today')) out['Discharge energy today'] = raw['Unit 1 discharge energy today'];
  }

  // Fault code: fault word plus any alarm bits.
  if (has(raw, 'Fault word') || has(raw, 'Alarm word 1')) {
    const parts: string[] = [];
    if (num(raw, 'Fault word')) parts.push(`fault ${num(raw, 'Fault word')}`);
    for (const n of [1, 2, 3]) if (num(raw, `Alarm word ${n}`)) parts.push(`alarm ${n} ${hex(num(raw, `Alarm word ${n}`))}`);
    out['Fault code'] = parts.length ? parts.join(', ') : 'None';
  }
  return out;
}

/** Live table for a model with `strings` PV strings. */
export function liveMap(strings: number) {
  return [...ALARM_MAP, ...pvMap(strings), ...MAIN_MAP, ...ENERGY_MAP, ...METER_MAP, ...UNIT1_MAP, ...SYSTEM_MAP];
}

export function decodeLive(model: HuaweiModel, regs: RegisterImage, strings = model.strings): Metrics {
  return derive(model, decodeTable(liveMap(strings), regs), strings);
}

/** Identity registers → info metrics. */
export function decodeInfo(model: HuaweiModel, regs: RegisterImage): Metrics {
  const t = decodeTable(INFO_MAP, regs);
  const out: Metrics = { 'Model name': `Huawei ${model.name}` };
  for (const k of ['Model name', 'Serial number', 'Firmware version', 'Secondary firmware version']) {
    const v = t[k];
    if (typeof v === 'string' && /[A-Za-z0-9]{3}/.test(v)) out[k] = v;
  }
  const pn = num(t, 'Max AC output power');
  if (pn > 0 && pn < 1_000_000) out['Max AC output power'] = pn;
  return out;
}

/** PV string count from 30071, clamped to Huawei's 1–24 range. */
export function stringCount(regs: RegisterImage, fallback: number) {
  const n = regs.get(30071);
  return n !== undefined && n >= 1 && n <= 24 ? n : fallback;
}

export function readOnlyError(what: string) {
  return new Error(`Huawei driver is read-only (not yet verified on hardware): can't write ${what}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Block {
  span: () => [number, number];
  optional: boolean;
  /** Poll count before which an optional block that failed is skipped. */
  skipUntil: number;
}

export class HuaweiDriver implements InverterDriver {
  readonly model: HuaweiModel;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;
  private strings: number;
  private polls = 0;
  private blocks: Block[];

  constructor(opts: DriverOptions) {
    this.model = huaweiModel(opts.modelId);
    // Unit 0 is valid on Huawei (inverter's own Modbus TCP), so don't treat 0 as "unset".
    const address = Number.isInteger(opts.address) && opts.address >= 0 && opts.address <= 247 ? opts.address : 1;
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate, address));
    this.infoMetrics = { 'Model name': `Huawei ${this.model.name}` };
    this.strings = this.model.strings;
    const block = (span: () => [number, number], optional: boolean): Block => ({ span, optional, skipUntil: 0 });
    this.blocks = [
      block(() => MAIN_SPAN, false),
      block(() => [PV_BASE, this.strings * 2], false),
      block(() => ALARM_SPAN, true),
      block(() => ENERGY_SPAN, true),
      block(() => METER_SPAN, true),
      block(() => SYSTEM_SPAN, true),
      block(() => UNIT1_SPAN, true),
    ];
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    if (timing.connectDelayMs > 0) await sleep(timing.connectDelayMs);
    const regs: RegisterImage = new Map();
    for (const [start, count] of [IDENT_SPAN, VERSION_SPAN, RATING_SPAN]) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Older firmware may lack a block; not fatal.
      }
    }
    this.strings = stringCount(regs, this.model.strings);
    this.infoMetrics = decodeInfo(this.model, regs);
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    this.polls++;
    const regs: RegisterImage = new Map();
    for (const b of this.blocks) {
      if (b.optional && this.polls < b.skipUntil) continue;
      const [start, count] = b.span();
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch (err) {
        if (!b.optional) throw err;
        // No battery / meter (or unsupported on this firmware): skip it for a while.
        b.skipUntil = this.polls + RETRY_POLLS;
      }
    }
    return decodeLive(this.model, regs, this.strings);
  }

  settingDefs(): SettingDef[] {
    return HUAWEI_SETTINGS.map(({ reg: _r, codec: _c, note: _n, ...def }) => def);
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of SETTING_SPANS) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Not present (e.g. no battery): leave those settings blank.
      }
    }
    return decodeSettings(HUAWEI_SETTINGS, regs);
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
