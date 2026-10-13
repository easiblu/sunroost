/**
 * "USB Modbus RS232/485" batteries: one RS485 bus (or a Modbus TCP gateway) with stacked packs at
 * consecutive slave addresses. Each model is a register map; packs are discovered at connect by
 * probing from the model's start address and stopping at the first address that doesn't answer
 * (EG4: "start at 2, no gaps"), up to `bms.maximum_pack_count`. A disconnect/reconnect rescans.
 *
 * Models (Common, EG4, Ecomlight, Leoch, Polarium, Revov, Seplos, SunStone):
 *  - EG4 LL / LifePower4 with LCD: EG4 holding-register map, 9600, addresses from 2.
 *  - Seplos V3: Seplos V3 Modbus map (input registers 0x1000 PIA / 0x1100 PIB), 19200, from 1.
 *  - Common: the Pace-style Modbus map most Chinese rack BMSs (and Pylontech-alike batteries) use.
 *  - Ecomlight, Leoch, Polarium, Revov R9 Gen1, SunStone: no public map; they use the closest known
 *    map (Pace-style) and are marked "(experimental)".
 *
 * Every register address/scale below comes from public community knowledge, not vendor specs;
 * the ones we're least sure of are tagged [verify].
 */
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../modbus.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';
import { bitNames, packMetrics, type PackReading } from './pack.ts';

// ---- Bus abstraction -------------------------------------------------------------------------

/** A Modbus bus with several slaves: what the pack scanner needs (and what tests fake). */
export interface RegisterBus {
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  read(unit: number, fn: RegisterFunction, start: number, count: number): Promise<number[]>;
}

/** A RegisterBus over the shared ModbusConnection (serial RTU, or TCP for "host:port"). */
export function modbusBus(connection: string, baudRate: number, timeoutMs = 1000): RegisterBus {
  const conn = new ModbusConnection({ ...parseConnection(connection, baudRate, 1), timeoutMs });
  return {
    get isOpen() {
      return conn.isOpen;
    },
    open: () => conn.connect(),
    close: () => conn.close(),
    read: (unit, fn, start, count) => conn.read(fn, start, count, unit),
  };
}

/** Stand-in when no port is selected: the error surfaces on connect, like the other drivers. */
export function noConnectionBus(): RegisterBus {
  const fail = () => Promise.reject(new Error('No battery connection selected'));
  return { isOpen: false, open: fail, close: async () => {}, read: fail };
}

// ---- Register image ----------------------------------------------------------------------------

/** Registers read from one pack, by address. Accessors return undefined for unread registers. */
export class Regs {
  private m = new Map<number, number>();

  put(start: number, values: number[]) {
    values.forEach((v, i) => this.m.set(start + i, v & 0xffff));
    return this;
  }
  has(a: number) {
    return this.m.has(a);
  }
  u16(a: number) {
    return this.m.get(a);
  }
  s16(a: number) {
    const v = this.m.get(a);
    return v === undefined ? undefined : v > 0x7fff ? v - 0x10000 : v;
  }
  /** 32-bit, high word first. */
  u32(a: number) {
    const hi = this.m.get(a);
    const lo = this.m.get(a + 1);
    return hi === undefined || lo === undefined ? undefined : hi * 0x10000 + lo;
  }
  /** ASCII, two characters per register (high byte first); NULs/spaces trimmed. */
  str(a: number, regs: number) {
    const bytes: number[] = [];
    for (let i = 0; i < regs; i++) {
      const v = this.m.get(a + i);
      if (v === undefined) return undefined;
      bytes.push(v >> 8, v & 0xff);
    }
    const s = Buffer.from(bytes)
      .toString('latin1')
      .replace(/[^\x20-\x7e]/g, '')
      .trim();
    return s || undefined;
  }
  /** `n` consecutive registers through `f`, skipping unread ones. */
  list(a: number, n: number, f: (r: Regs, addr: number) => number | undefined) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = f(this, a + i);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}

export interface Block {
  fn: RegisterFunction;
  start: number;
  count: number;
  /** A failed optional block is ignored (older firmware, smaller models …). */
  optional?: boolean;
}

export interface RegisterMap {
  /** Read every poll. */
  blocks: Block[];
  /** Static identification, read once per pack at discovery (always optional). */
  infoBlocks?: Block[];
  decode(r: Regs): PackReading;
}

/** Throws when a decoded pack is implausible (usually: the wrong model/map is selected). */
export function checkPlausible(r: PackReading, label: string, maxVoltage = 1000) {
  const bad = (what: string) => new Error(`${label}: implausible ${what} — check the selected battery model`);
  if (r.voltage === undefined || !(r.voltage > 1 && r.voltage < maxVoltage)) throw bad(`voltage ${r.voltage ?? 'missing'}`);
  if (r.soc !== undefined && !(r.soc >= 0 && r.soc <= 100)) throw bad(`state of charge ${r.soc}`);
  if (r.cells?.some((v) => !(v > 0.5 && v < 5))) throw bad('cell voltages');
}

/** "Protocol state of charge" advanced option. '' = trust the reported SOC. */
export function applyProtocolSoc(r: PackReading, mode: string): PackReading {
  if (r.remainingAh === undefined) return r;
  const of = mode === 'charge/design' ? r.designAh : mode === 'charge/full' ? r.fullAh : undefined;
  return of ? { ...r, soc: Math.min(100, (r.remainingAh / of) * 100) } : r;
}

// ---- Shared alarm names ---------------------------------------------------------------------

/** Typical warning/protection bit layout of Pace/EG4-style BMSs [verify per brand]. */
const ALARM_BITS = [
  'Cell over voltage',
  'Cell under voltage',
  'Pack over voltage',
  'Pack under voltage',
  'Charge over current',
  'Discharge over current',
  'Short circuit',
  'Charge over temperature',
  'Discharge over temperature',
  'Charge under temperature',
  'Discharge under temperature',
  'MOS over temperature',
  'Environment over temperature',
  'Environment under temperature',
  'Low capacity',
  'Cell voltage difference',
];

const alarms = (...words: (number | undefined)[]) => words.flatMap((w) => (w ? bitNames(w, ALARM_BITS) : []));
const tempC = (v: number | undefined) => (v === undefined || v < -40 || v > 150 ? undefined : v);

// ---- Register maps ----------------------------------------------------------------------------

/** EG4 capacities are Ah on most firmware but mAh on some [verify]. */
const eg4Ah = (raw: number | undefined) => (raw === undefined || raw === 0 ? undefined : raw > 5000 ? raw / 1000 : raw);

/**
 * EG4 LL / LifePower4 (with LCD), function 3, registers 0–37 [verify all]:
 * 0 pack V (10 mV) · 1 current (10 mA, signed, + = charging) · 2–17 cells (mV) · 18 MOS/PCB temp ·
 * 19 average temp · 20 environment temp (°C, signed) · 21 remaining Ah · 22 max charge current (A) ·
 * 23 SOH (%) · 24 SOC (%) · 25 status · 26 warning · 27 protection · 28 error code ·
 * 29–30 cycles (u32) · 31–32 full capacity (u32) · 33–36 cell temperatures (°C) · 37 cell count.
 * Info: 105–116 model (24 chars), 117–119 firmware, 120–127 serial [verify].
 */
export const EG4_MAP: RegisterMap = {
  blocks: [{ fn: 3, start: 0, count: 38 }],
  infoBlocks: [{ fn: 3, start: 105, count: 23 }],
  decode(r) {
    const n = r.u16(37);
    const cellCount = n && n <= 16 ? n : 16;
    const cellTemps = r.list(33, 4, (x, a) => tempC(x.s16(a)));
    return {
      voltage: (r.u16(0) ?? NaN) / 100,
      current: (r.s16(1) ?? NaN) / 100,
      cells: r.list(2, cellCount, (x, a) => (x.u16(a) ? x.u16(a)! / 1000 : undefined)),
      temperatureMos: tempC(r.s16(18)),
      temperatureEnv: tempC(r.s16(20)),
      temperatures: cellTemps,
      remainingAh: eg4Ah(r.u16(21)),
      maxChargeCurrent: r.u16(22) || undefined,
      soh: r.u16(23),
      soc: r.u16(24),
      alarms: alarms(r.u16(26), r.u16(27)),
      cycles: r.u32(29),
      fullAh: eg4Ah(r.u32(31)),
      model: r.str(105, 12),
      firmware: r.str(117, 3),
      serial: r.str(120, 8),
    };
  },
};

/**
 * Pace-style map ("Common"), function 3 [verify]: 0 current (10 mA, signed) · 1 pack V (10 mV) ·
 * 2 SOC % · 3 SOH % · 4 remaining (10 mAh) · 5 full (10 mAh) · 6 design (10 mAh) · 7 cycles ·
 * 9 warning · 10 protection · 11 status/fault · 12 balancing · 15–30 cells (mV) ·
 * 31–34 cell temps (0.1 °C) · 35 MOS temp · 36 environment temp.
 * Info: 150–159 firmware, 160–169 model, 170–179 pack serial (ASCII) [verify].
 */
export const PACE_MAP: RegisterMap = {
  blocks: [{ fn: 3, start: 0, count: 37 }],
  infoBlocks: [{ fn: 3, start: 150, count: 30 }],
  decode(r) {
    const t = (a: number) => {
      const v = r.s16(a);
      return v === undefined ? undefined : tempC(v / 10);
    };
    const ah = (a: number) => {
      const v = r.u16(a);
      return v ? v / 100 : undefined;
    };
    return {
      current: (r.s16(0) ?? NaN) / 100,
      voltage: (r.u16(1) ?? NaN) / 100,
      soc: r.u16(2),
      soh: r.u16(3) || undefined,
      remainingAh: ah(4),
      fullAh: ah(5),
      designAh: ah(6),
      cycles: r.u16(7),
      alarms: alarms(r.u16(9), r.u16(10)),
      cells: r.list(15, 16, (x, a) => (x.u16(a) ? x.u16(a)! / 1000 : undefined)),
      temperatures: r.list(31, 4, (_x, a) => (r.u16(a) ? t(a) : undefined)),
      temperatureMos: t(35),
      temperatureEnv: t(36),
      firmware: r.str(150, 10),
      model: r.str(160, 10),
      serial: r.str(170, 10),
    };
  },
};

const kelvin = (raw: number | undefined) => (raw ? tempC((raw - 2731) / 10) : undefined);

/**
 * Seplos V3 (published "Seplos BMS V3 Modbus" map), function 4:
 * PIA 0x1000–0x1011: pack V (10 mV), current (10 mA, signed), remaining (10 mAh), total (10 mAh),
 *   discharged (10 Ah), SOC (0.1 %), SOH (0.1 %), cycles, avg/max/min cell V, avg/max/min cell temp
 *   (0.1 K), max discharge current and max charge current (1 A) [verify units of the last two].
 * PIB 0x1100–0x1119: cells 1–16 (mV), cell temps 1–4 (0.1 K) at 0x1110, environment 0x1118,
 *   power/MOS 0x1119 (0.1 K).
 * Alarms (PIC, 0x1200) are coil bits (function 1), which the shared Modbus connection doesn't
 * read, so Seplos V3 reports no alarm text.
 */
export const SEPLOS_V3_MAP: RegisterMap = {
  blocks: [
    { fn: 4, start: 0x1000, count: 0x12 },
    { fn: 4, start: 0x1100, count: 0x1a },
  ],
  decode(r) {
    const tenth = (a: number) => {
      const v = r.u16(a);
      return v === undefined ? undefined : v / 10;
    };
    const ah = (a: number) => {
      const v = r.u16(a);
      return v ? v / 100 : undefined;
    };
    return {
      voltage: (r.u16(0x1000) ?? NaN) / 100,
      current: (r.s16(0x1001) ?? NaN) / 100,
      remainingAh: ah(0x1002),
      fullAh: ah(0x1003),
      soc: tenth(0x1005),
      soh: tenth(0x1006),
      cycles: r.u16(0x1007),
      maxDischargeCurrent: r.u16(0x100f) || undefined,
      maxChargeCurrent: r.u16(0x1010) || undefined,
      cells: r.list(0x1100, 16, (x, a) => (x.u16(a) ? x.u16(a)! / 1000 : undefined)),
      temperatures: r.list(0x1110, 4, (x, a) => kelvin(x.u16(a))),
      temperatureEnv: kelvin(r.u16(0x1118)),
      temperatureMos: kelvin(r.u16(0x1119)),
    };
  },
};

// ---- Models ---------------------------------------------------------------------------------

export interface ModbusBmsModel {
  id: string;
  name: string;
  map: RegisterMap;
  startAddress: number;
  baudRate: number;
}

export const MODBUS_BMS_MODELS: ModbusBmsModel[] = [
  { id: 'common', name: 'Common', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
  { id: 'eg4', name: 'EG4 LL / LifePower4 (with LCD)', map: EG4_MAP, startAddress: 2, baudRate: 9600 },
  { id: 'ecomlight', name: 'Ecomlight (experimental)', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
  { id: 'leoch', name: 'Leoch (experimental)', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
  { id: 'polarium', name: 'Polarium (experimental)', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
  { id: 'revov', name: 'Revov R9 Gen1 (experimental)', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
  { id: 'seplos', name: 'Seplos V3', map: SEPLOS_V3_MAP, startAddress: 1, baudRate: 19200 },
  { id: 'sunstone', name: 'SunStone (experimental)', map: PACE_MAP, startAddress: 1, baudRate: 9600 },
];

export const modbusBmsModel = (id: string) => MODBUS_BMS_MODELS.find((m) => m.id === id) ?? MODBUS_BMS_MODELS[0];

// ---- Pack scanner -------------------------------------------------------------------------------

export interface ScannerOptions {
  label: string;
  map: RegisterMap;
  startAddress: number;
  maxPacks: number;
  /** Stop discovery at the first silent address (default true). */
  stopAtGap?: boolean;
  /** Extra plausibility check per pack (default: checkPlausible). */
  validate?: (r: PackReading, address: number) => void;
  /** Error to throw when no pack answers at all. */
  noPacks?: (lastError: unknown) => Error;
  /** Post-processing of each decoded pack (protocol SOC …). */
  adjust?: (r: PackReading) => PackReading;
}

/** Discovers packs at consecutive addresses on a RegisterBus and polls each one. */
export class ModbusPackScanner implements BmsDriver {
  readonly bus: RegisterBus;
  private opts: ScannerOptions;
  private packs: { address: number; info: Regs }[] = [];

  constructor(bus: RegisterBus, opts: ScannerOptions) {
    this.bus = bus;
    this.opts = opts;
  }

  /** Addresses found by the last scan. */
  get addresses() {
    return this.packs.map((p) => p.address);
  }

  async connect() {
    if (!this.bus.isOpen) await this.bus.open();
    await this.scan();
  }

  async close() {
    this.packs = [];
    await this.bus.close();
  }

  async scan() {
    const { startAddress, maxPacks, stopAtGap = true } = this.opts;
    this.packs = [];
    let lastError: unknown = null;
    for (let a = startAddress; a < startAddress + Math.max(1, maxPacks); a++) {
      try {
        await this.readPack(a, new Regs());
      } catch (err) {
        lastError = err;
        if (stopAtGap) break;
        continue;
      }
      const info = new Regs();
      for (const b of this.opts.map.infoBlocks ?? []) {
        try {
          info.put(b.start, await this.bus.read(a, b.fn, b.start, b.count));
        } catch {
          // identification is optional
        }
      }
      this.packs.push({ address: a, info });
    }
    if (!this.packs.length) {
      throw this.opts.noPacks?.(lastError) ?? new Error(`${this.opts.label}: no battery pack answered at address ${startAddress}${lastError ? ` (${(lastError as Error).message})` : ''}`);
    }
  }

  async read(): Promise<Metrics[]> {
    if (!this.bus.isOpen || !this.packs.length) await this.connect();
    const out: Metrics[] = [];
    let firstError: unknown = null;
    for (const [i, p] of this.packs.entries()) {
      try {
        out[i] = packMetrics(await this.readPack(p.address, p.info));
      } catch (err) {
        firstError ??= err; // keep the slot empty so other packs don't shift
      }
    }
    if (!out.some(Boolean)) throw firstError ?? new Error(`${this.opts.label}: no data`);
    return out;
  }

  /** Raw register access for a console (e.g. the Voltronic LIB console, addresses 0–16). */
  rawRead(unit: number, fn: RegisterFunction, start: number, count: number) {
    return this.bus.read(unit, fn, start, count);
  }

  private async readPack(address: number, info: Regs): Promise<PackReading> {
    const regs = new Regs();
    // Copy identification registers so decode() sees them alongside live data.
    for (const b of this.opts.map.infoBlocks ?? []) {
      for (let i = 0; i < b.count; i++) if (info.has(b.start + i)) regs.put(b.start + i, [info.u16(b.start + i)!]);
    }
    for (const b of this.opts.map.blocks) {
      try {
        regs.put(b.start, await this.bus.read(address, b.fn, b.start, b.count));
      } catch (err) {
        if (!b.optional) throw err;
      }
    }
    let r = this.opts.map.decode(regs);
    const label = `${this.opts.label} pack ${address}`;
    if (this.opts.validate) this.opts.validate(r, address);
    else checkPlausible(r, label);
    if (this.opts.adjust) r = this.opts.adjust(r);
    return r;
  }
}

export function createModbusBms(opts: {
  connection: string;
  baudRate: number;
  modelId: string;
  maxPacks?: number;
  protocolSoc?: string;
  bus?: RegisterBus;
}): ModbusPackScanner {
  const model = modbusBmsModel(opts.modelId);
  const bus = opts.bus ?? (opts.connection ? modbusBus(opts.connection, opts.baudRate) : noConnectionBus());
  const soc = opts.protocolSoc ?? '';
  return new ModbusPackScanner(bus, {
    label: `Modbus BMS (${model.name})`,
    map: model.map,
    startAddress: model.startAddress,
    maxPacks: opts.maxPacks ?? 16,
    adjust: soc && soc !== 'soc' ? (r) => applyProtocolSoc(r, soc) : undefined,
  });
}

export const modbusBmsDriver: BmsDriverDescriptor = {
  id: 'modbus',
  name: 'USB Modbus RS232/485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: false,
  models: MODBUS_BMS_MODELS.map(({ id, name }) => ({ id, name })),
  create: ({ connections, baudRate, modelId }) => {
    const model = modbusBmsModel(modelId);
    return createModbusBms({
      connection: connections[0] ?? '',
      // No explicit baud rate set: use the model's (Seplos V3 talks 19200).
      baudRate: settings.get('bms.baud_rate') ? baudRate : model.baudRate,
      modelId: model.id,
      maxPacks: settings.get('bms.maximum_pack_count'),
      protocolSoc: settings.get('bms.protocol_soc'),
    });
  },
};
