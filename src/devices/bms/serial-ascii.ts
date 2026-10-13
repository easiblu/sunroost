/**
 * "USB Serial RS232/485": the Pylontech-family RS232/RS485 "ASCII hex" protocol spoken by
 * Pylontech (RS485 port), Dyness/Mecer, Seplos V1/V2 (Shoto, LBSA), Pace BMSs (SOK, Revov,
 * Trophy, SunSynk SUN-BATT), Vestwood and many more.
 *
 * Frame: SOI '~' | VER | ADR | CID1 | CID2 (request) or RTN (reply) | LENGTH | INFO | CHKSUM | EOI '\r'
 * Every field after SOI is ASCII hex (two chars per byte). LENGTH is 4 hex chars: the top
 * nibble is LCHKSUM, the lower 12 bits LENID = number of ASCII chars in INFO.
 *   LCHKSUM = (-(sum of LENID's three nibbles)) mod 16
 *   CHKSUM  = (-(sum of the ASCII codes of every char between SOI and CHKSUM)) mod 65536
 * Battery commands use CID1 0x46: 0x42 analog values, 0x44 alarm info, 0x47 system
 * parameters, 0x51 manufacturer info, 0x92 charge/discharge management, 0x93 serial number.
 *
 * The 0x42 analog block has the same skeleton everywhere (cells, temperatures, current,
 * voltage, remaining capacity, "user defined" item count P, …) but units and the tail differ:
 *   pylon  (P = 2 or 4): current 0.1 A, voltage mV, capacities mAh (24-bit when P = 4), cycles
 *   pace   (P = 3, VER 0x25): current 10 mA, voltage mV, capacities 10 mAh, cycles, design capacity
 *   seplos (P ≥ 10): current 10 mA, voltage 10 mV, capacities 10 mAh, SOC 0.1 %, design, cycles,
 *                    SOH 0.1 %, port voltage
 * The layout is recognised from P, and the voltage scale is cross-checked against the sum of
 * the cell voltages, so a mis-guessed variant still decodes sensibly.
 *
 * The module also holds what the other ASCII drivers (Narada, Pylontech console) share:
 * the "Protocol state of charge / capacity / temperature" interpretation, the
 * "Read current from: Inverter" option, and a link that can change baud rate while probing.
 */
import { logger } from '../../core/log.ts';
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import { state } from '../../core/state.ts';
import type { BmsDriver, BmsDriverDescriptor, DriverOption } from '../types.ts';
import { MultiPortBms, bitNames, deviceMode, packMetrics, round, type PackReading, type PortReader } from './pack.ts';
import { serialLinkFactory, terminatedReader, type ByteLink, type FrameReader, type LinkFactory, type RequestOptions } from './serial.ts';

const log = logger('devices');

// ---- Frames -------------------------------------------------------------------------------

export const CID1_BATTERY = 0x46;
export const CMD = {
  analog: 0x42,
  alarm: 0x44,
  systemParams: 0x47,
  manufacturer: 0x51,
  management: 0x92,
  serial: 0x93,
} as const;

export const RTN_TEXT: Record<number, string> = {
  0x01: 'version error',
  0x02: 'checksum error',
  0x03: 'length checksum error',
  0x04: 'invalid CID2',
  0x05: 'command format error',
  0x06: 'invalid data',
  0x90: 'address error',
  0x91: 'communication error',
};

export const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** LENGTH field (LCHKSUM nibble + 12-bit LENID) for an INFO of `lenid` ASCII chars. */
export function lengthField(lenid: number) {
  const s = (lenid & 0xf) + ((lenid >> 4) & 0xf) + ((lenid >> 8) & 0xf);
  const lchk = -s & 0xf;
  return ((lchk << 12) | (lenid & 0xfff)) >>> 0;
}

/** CHKSUM of the ASCII text between SOI and CHKSUM. */
export function checksum(body: string) {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += body.charCodeAt(i);
  return -s & 0xffff;
}

/** Builds a complete frame. `info` is raw bytes (hex-encoded into INFO). */
export function buildFrame(ver: number, adr: number, cid1: number, cid2: number, info: Uint8Array = new Uint8Array()) {
  const infoHex = Buffer.from(info).toString('hex').toUpperCase();
  const body = h2(ver) + h2(adr) + h2(cid1) + h2(cid2) + h4(lengthField(infoHex.length)) + infoHex;
  return Buffer.from(`~${body}${h4(checksum(body))}\r`, 'ascii');
}

export interface PylonFrame {
  ver: number;
  adr: number;
  cid1: number;
  /** CID2 in a request, RTN (0 = OK) in a reply. */
  cid2: number;
  info: Buffer;
}

/** Parses and validates a frame (both checksums). Throws on any inconsistency. */
export function parseFrame(raw: Buffer | string): PylonFrame {
  const text = (typeof raw === 'string' ? raw : raw.toString('ascii')).trim();
  if (!text.startsWith('~')) throw new Error('Pylontech: missing SOI');
  const body = text.slice(1, -4);
  if (body.length < 12 || !/^[0-9A-Fa-f]+$/.test(text.slice(1))) throw new Error('Pylontech: malformed frame');
  const chk = parseInt(text.slice(-4), 16);
  if (checksum(body) !== chk) throw new Error('Pylontech: checksum mismatch');
  const length = parseInt(body.slice(8, 12), 16);
  const lenid = length & 0xfff;
  if (lengthField(lenid) !== length) throw new Error('Pylontech: length checksum mismatch');
  const infoHex = body.slice(12);
  if (infoHex.length !== lenid) throw new Error('Pylontech: length mismatch');
  return {
    ver: parseInt(body.slice(0, 2), 16),
    adr: parseInt(body.slice(2, 4), 16),
    cid1: parseInt(body.slice(4, 6), 16),
    cid2: parseInt(body.slice(6, 8), 16),
    info: Buffer.from(infoHex, 'hex'),
  };
}

export const asciiFrameReader = terminatedReader(0x7e, 0x0d);

/** Bounds-checked big-endian cursor; reading past the end throws. */
export class Cursor {
  pos: number;
  readonly buf: Buffer;
  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  get left() {
    return this.buf.length - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error('truncated data');
  }
  peek() {
    this.need(1);
    return this.buf[this.pos];
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  s16() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u24() {
    this.need(3);
    const v = this.buf.readUIntBE(this.pos, 3);
    this.pos += 3;
    return v;
  }
  skip(n: number) {
    this.pos = Math.min(this.buf.length, this.pos + n);
  }
}

// ---- Protocol interpretation (Advanced › Battery "Protocol …" settings) -------------------

/** '' = auto, 'soc', 'charge/design', 'charge/full'. */
export type SocMode = '' | 'soc' | 'charge/design' | 'charge/full';
/** '' = auto, 'full,design', 'full', '10xfull', 'design'. */
export type CapacityMode = '' | 'full,design' | 'full' | '10xfull' | 'design';
/** '' = auto, '0.1K', '1K', '0.1°C', '1°C', '1°C-10'. */
export type TemperatureMode = '' | '0.1K' | '1K' | '0.1°C' | '1°C' | '1°C-10';

export interface ProtocolOptions {
  soc: SocMode;
  capacity: CapacityMode;
  temperature: TemperatureMode;
}

export function protocolSettings(): ProtocolOptions {
  return {
    soc: settings.get('bms.protocol_soc') as SocMode,
    capacity: settings.get('bms.protocol_capacity') as CapacityMode,
    temperature: settings.get('bms.protocol_temperature') as TemperatureMode,
  };
}

/** One raw temperature reading converted to °C. */
export function convertTemperature(raw: number, mode: Exclude<TemperatureMode, ''>): number {
  switch (mode) {
    case '0.1K':
      return (raw - 2731) / 10;
    case '1K':
      return raw - 273.15;
    case '0.1°C':
      return raw / 10;
    case '1°C':
      return raw;
    case '1°C-10':
      return raw - 10;
  }
}

/**
 * Guess for "Auto detect" when the layout doesn't pin the unit: 0.1 K values sit around
 * 2500–3300; 100–2000 reads as 0.1 °C (1 K, 250–330, is ambiguous with it and loses);
 * anything smaller as whole °C.
 */
export function guessTemperatureMode(raws: number[]): Exclude<TemperatureMode, ''> {
  const xs = raws.filter((r) => Number.isFinite(r) && r !== 0);
  if (!xs.length) return '0.1K';
  const mid = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  if (mid >= 2000 && mid <= 4000) return '0.1K';
  if (mid >= 100 && mid < 2000) return '0.1°C';
  return '1°C';
}

export function temperaturesC(raws: number[], mode: TemperatureMode, fallback: TemperatureMode = ''): number[] {
  const m = mode || fallback || guessTemperatureMode(raws);
  return raws.map((r) => round(convertTemperature(r, m), 1));
}

/** Capacity figures as decoded from the wire (Ah, %); undefined = not reported. */
export interface RawCapacity {
  remainingAh?: number;
  fullAh?: number;
  designAh?: number;
  /** State of charge as reported by the battery, %. */
  soc?: number;
}

const ratio = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined && b > 0 ? (a / b) * 100 : undefined);

/**
 * Applies "Protocol state of charge" and "Protocol capacity". `defaults` are the variant's
 * auto choices. Capacity: full,design = Capacity from full, Design capacity shown; full =
 * design hidden; 10xfull = full × 10, design hidden; design = Capacity from design.
 * SOC: soc = reported value; charge/design = remaining ÷ design; charge/full = remaining ÷
 * (effective) full capacity. A missing input falls back to the next best figure.
 */
export function interpretCapacity(
  raw: RawCapacity,
  opts: Pick<ProtocolOptions, 'soc' | 'capacity'>,
  defaults: { soc?: SocMode; capacity?: CapacityMode } = {},
): Pick<PackReading, 'soc' | 'remainingAh' | 'fullAh' | 'designAh'> {
  const capMode = opts.capacity || defaults.capacity || 'full,design';
  let fullAh: number | undefined;
  let designAh: number | undefined;
  switch (capMode) {
    case 'full,design':
      fullAh = raw.fullAh ?? raw.designAh;
      designAh = raw.designAh;
      break;
    case 'full':
      fullAh = raw.fullAh ?? raw.designAh;
      break;
    case '10xfull':
      fullAh = raw.fullAh !== undefined ? raw.fullAh * 10 : raw.designAh;
      break;
    case 'design':
      fullAh = raw.designAh ?? raw.fullAh;
      break;
  }
  const socMode = opts.soc || defaults.soc || (raw.soc !== undefined ? 'soc' : 'charge/full');
  let soc: number | undefined;
  switch (socMode) {
    case 'soc':
      soc = raw.soc ?? ratio(raw.remainingAh, fullAh);
      break;
    case 'charge/design':
      soc = ratio(raw.remainingAh, raw.designAh ?? fullAh);
      break;
    case 'charge/full':
      soc = ratio(raw.remainingAh, fullAh) ?? raw.soc;
      break;
  }
  return { soc, remainingAh: raw.remainingAh, fullAh, designAh };
}

// ---- Read current from inverter ------------------------------------------------------------

/** Sum of the inverters' "Battery current" (A, + charging), or null when none reports it. */
export function inverterBatteryCurrent(): number | null {
  const values = state.inverters.filter(Boolean).map((m) => m['Battery current']).filter((v): v is number => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/** Splits `current` evenly over the packs that were read and recomputes Power/Device mode. */
export function applyInverterCurrent(packs: Metrics[], current: number): Metrics[] {
  const present = packs.filter(Boolean).length;
  if (!present) return packs;
  const share = current / present;
  const out: Metrics[] = [];
  packs.forEach((p, i) => {
    const m = { ...p };
    m.Current = round(share, 2);
    if (typeof m.Voltage === 'number') m.Power = Math.round(m.Voltage * share);
    m['Device mode'] = deviceMode(share);
    out[i] = m;
  });
  return out;
}

/** Wraps a driver so "Read current from: Inverter" replaces pack currents with the inverter's. */
export function withInverterCurrent(inner: BmsDriver, enabled: () => boolean = () => settings.get('bms.read_current_from_inverter')): BmsDriver {
  return {
    connect: () => inner.connect(),
    close: () => inner.close(),
    read: async () => {
      const packs = await inner.read();
      if (!enabled()) return packs;
      const current = inverterBatteryCurrent();
      return current === null ? packs : applyInverterCurrent(packs, current);
    },
  };
}

export function maxPackCount() {
  return Math.min(32, Math.max(1, Math.round(Number(settings.get('bms.maximum_pack_count')) || 16)));
}

// ---- Baud-switchable link ------------------------------------------------------------------

/** A ByteLink whose baud rate can be changed (close + reopen) while probing. */
export class AdaptiveLink implements ByteLink {
  private inner: ByteLink;
  private readonly path: string;
  private readonly factory: LinkFactory;
  baudRate: number;

  constructor(path: string, baudRate: number, factory: LinkFactory) {
    this.path = path;
    this.baudRate = baudRate;
    this.factory = factory;
    this.inner = factory(path, baudRate);
  }
  get name() {
    return this.inner.name;
  }
  get isOpen() {
    return this.inner.isOpen;
  }
  open() {
    return this.inner.open();
  }
  close() {
    return this.inner.close();
  }
  request(data: Buffer, reader: FrameReader, opts?: RequestOptions) {
    return this.inner.request(data, reader, opts);
  }
  async setBaud(baudRate: number) {
    if (baudRate === this.baudRate && this.inner.isOpen) return;
    await this.inner.close().catch(() => {});
    this.baudRate = baudRate;
    this.inner = this.factory(this.path, baudRate);
    await this.inner.open();
  }
}

// ---- Analog values ------------------------------------------------------------------------

export type Layout = 'pylon' | 'pace' | 'seplos';

/** One decoded analog block, before the protocol interpretation settings are applied. */
export interface RawPack {
  layout: Layout;
  cells: number[];
  /** Temperatures exactly as sent (signed), unit decided later. */
  tempsRaw: number[];
  current: number;
  voltage: number;
  remainingAh?: number;
  fullAh?: number;
  designAh?: number;
  soc?: number;
  soh?: number;
  cycles?: number;
}

const UNITS: Record<Layout, { current: number; voltage: number; capacity: number }> = {
  pylon: { current: 0.1, voltage: 0.001, capacity: 0.001 },
  pace: { current: 0.01, voltage: 0.001, capacity: 0.01 },
  seplos: { current: 0.01, voltage: 0.01, capacity: 0.01 },
};

export function layoutFor(userItems: number): Layout {
  return userItems >= 0x0a ? 'seplos' : userItems === 3 ? 'pace' : 'pylon';
}

/**
 * Picks the voltage scale that agrees with the sum of the cells (within 15 %), preferring
 * the layout's own unit. Guards against a mis-detected variant reporting 10× voltages.
 */
export function plausibleVoltage(raw: number, preferred: number, cells: number[]) {
  const sumCells = cells.reduce((a, b) => a + b, 0);
  const v = raw * preferred;
  if (!sumCells || Math.abs(v - sumCells) <= sumCells * 0.15) return v;
  for (const scale of [0.001, 0.01, 0.1]) {
    const alt = raw * scale;
    if (Math.abs(alt - sumCells) <= sumCells * 0.15) return alt;
  }
  return v;
}

/**
 * Decodes a 0x42 analog reply INFO: INFOFLAG, pack address, then one or more pack blocks
 * (several when a master answers for the whole stack). `layout` 'auto' picks it per block
 * from the user-defined item count P.
 */
export function decodeAnalog(info: Buffer, layout: Layout | 'auto' = 'auto'): RawPack[] {
  const c = new Cursor(info, 2);
  const packs: RawPack[] = [];
  while (c.left > 0) {
    const nCells = c.u8();
    if (!nCells || nCells > 32) break;
    const cellsMv = Array.from({ length: nCells }, () => c.u16());
    const cells = cellsMv.map((mv) => mv / 1000);
    const nTemps = c.u8();
    if (nTemps > 16) throw new Error('implausible temperature count');
    const tempsRaw = Array.from({ length: nTemps }, () => c.s16());
    const currentRaw = c.s16();
    const voltageRaw = c.u16();
    let remainingRaw = c.u16();
    const userItems = c.u8();
    const lay = layout === 'auto' ? layoutFor(userItems) : layout;
    const u = UNITS[lay];
    const p: RawPack = { layout: lay, cells, tempsRaw, current: round(currentRaw * u.current, 3), voltage: 0 };
    p.voltage = round(plausibleVoltage(voltageRaw, u.voltage, cells), 3);
    if (lay === 'seplos') {
      // full, SOC 0.1 %, design, cycles, SOH 0.1 %, port voltage, then reserved words
      p.fullAh = c.u16() * u.capacity;
      p.soc = c.u16() / 10;
      p.designAh = c.u16() * u.capacity;
      p.cycles = c.u16();
      if (c.left >= 2) p.soh = c.u16() / 10;
      if (c.left >= 2) c.u16(); // port voltage
      p.remainingAh = remainingRaw * u.capacity;
      c.skip(Math.max(0, userItems - 6) * 2);
      packs.push(p);
      break; // Seplos answers for one pack per request
    }
    let fullRaw = c.u16();
    p.cycles = c.u16();
    if (lay === 'pace') {
      if (userItems >= 3 && c.left >= 2) p.designAh = c.u16() * u.capacity;
      c.skip(Math.max(0, userItems - 3) * 2);
    } else if (userItems >= 4) {
      remainingRaw = c.u24();
      fullRaw = c.u24();
    }
    p.remainingAh = remainingRaw * u.capacity;
    p.fullAh = fullRaw * u.capacity;
    packs.push(p);
    // Unknown extra user-defined items in a Pylontech block: the block size can't be known.
    if (lay === 'pylon' && userItems !== 2 && userItems !== 4) break;
  }
  if (!packs.length) throw new Error('no pack data');
  return packs;
}

export interface PylonAnalog {
  cells: number[];
  /** All temperature sensors in protocol order (first = BMS board), °C. */
  temperatures: number[];
  current: number;
  voltage: number;
  remainingAh: number;
  totalAh: number;
  cycles: number;
}

/** Pylontech-layout analog decode with temperatures in °C (kept for the diagnostics console). */
export function parseAnalog(info: Buffer): PylonAnalog[] {
  return decodeAnalog(info, 'pylon').map((p) => ({
    cells: p.cells,
    temperatures: p.tempsRaw.map((r) => convertTemperature(r, '0.1K')),
    current: p.current,
    voltage: p.voltage,
    remainingAh: p.remainingAh ?? 0,
    totalAh: p.fullAh ?? 0,
    cycles: p.cycles ?? 0,
  }));
}

/** Turns one Pylontech-layout analog block (+ optional extras) into a pack reading (0.1 K, SOC from charge/full). */
export function pylonReading(a: PylonAnalog, extra: Partial<PackReading> = {}): PackReading {
  const [board, ...rest] = a.temperatures;
  const cellTemps = rest.slice(0, 4);
  return {
    soc: a.totalAh > 0 ? (a.remainingAh / a.totalAh) * 100 : undefined,
    voltage: a.voltage,
    current: a.current,
    temperature: board,
    temperatures: cellTemps,
    cellTemperatures: cellTemps,
    temperatureMos: rest.length >= 5 ? rest[4] : undefined,
    cells: a.cells,
    cycles: a.cycles,
    remainingAh: a.remainingAh,
    fullAh: a.totalAh,
    ...extra,
  };
}

/** Variant defaults for "Auto detect" in the three Protocol settings. */
const LAYOUT_DEFAULTS: Record<Layout, { soc: SocMode; capacity: CapacityMode; temperature: TemperatureMode }> = {
  pylon: { soc: 'charge/full', capacity: 'full', temperature: '0.1K' },
  pace: { soc: 'charge/full', capacity: 'full,design', temperature: '0.1K' },
  seplos: { soc: 'soc', capacity: 'full,design', temperature: '0.1K' },
};

/**
 * Applies the Protocol settings and maps temperature sensors per layout:
 *   pylon: board, 4 cell groups, (6th) MOSFET    pace: 4 cells, MOSFET, environment
 *   seplos: 4 cells, environment, power (MOSFET) other counts: all sensors are cell sensors
 */
export function rawReading(p: RawPack, opts: ProtocolOptions, extra: Partial<PackReading> = {}): PackReading {
  const d = LAYOUT_DEFAULTS[p.layout];
  const t = temperaturesC(p.tempsRaw, opts.temperature, d.temperature);
  const cap = interpretCapacity(p, opts, d);
  const r: PackReading = { voltage: p.voltage, current: p.current, cells: p.cells, cycles: p.cycles, soh: p.soh, ...cap };
  if (p.layout === 'pylon' && t.length >= 2) {
    r.temperature = t[0];
    r.temperatures = r.cellTemperatures = t.slice(1, 5);
    if (t.length >= 6) r.temperatureMos = t[5];
  } else if ((p.layout === 'pace' || p.layout === 'seplos') && t.length === 6) {
    r.temperatures = r.cellTemperatures = t.slice(0, 4);
    if (p.layout === 'pace') {
      r.temperatureMos = t[4];
      r.temperatureEnv = t[5];
    } else {
      r.temperatureEnv = t[4];
      r.temperatureMos = t[5];
    }
  } else {
    r.temperatures = r.cellTemperatures = t;
  }
  return { ...r, ...extra };
}

// ---- Alarms, limits, identity (Pylontech layouts) -----------------------------------------

const STATUS1 = [
  'Module over voltage',
  'Cell under voltage',
  'Charge over current',
  '',
  'Discharge over current',
  'Discharge over temperature',
  'Charge over temperature',
  'Module under voltage',
];

const level = (v: number, what: string): string | null =>
  v === 0x01 ? `${what} low` : v === 0x02 ? `${what} high` : v === 0xf0 ? `${what} error` : null;

/**
 * Decodes a 0x44 alarm reply INFO: INFOFLAG, address, cell count + one status per cell,
 * temp count + one status per sensor, charge current, module voltage, discharge current,
 * then status bytes 1..5 (status 1 = protection flags). Status values: 0 normal,
 * 1 below lower limit, 2 above upper limit, 0xF0 other error.
 */
export function parseAlarms(info: Buffer): string[] {
  const c = new Cursor(info, 2);
  const out: string[] = [];
  const nCells = c.u8();
  for (let i = 0; i < nCells; i++) {
    const t = level(c.u8(), `Cell ${i + 1} voltage`);
    if (t) out.push(t);
  }
  const nTemps = c.u8();
  for (let i = 0; i < nTemps; i++) {
    const t = level(c.u8(), i === 0 ? 'BMS temperature' : `Temperature ${i}`);
    if (t) out.push(t);
  }
  for (const name of ['Charge current', 'Pack voltage', 'Discharge current']) {
    if (!c.left) break;
    const t = level(c.u8(), name);
    if (t) out.push(t);
  }
  if (c.left) out.push(...bitNames(c.u8(), STATUS1));
  return [...new Set(out)];
}

export interface PylonLimits {
  maxChargeCurrent: number;
  maxDischargeCurrent: number;
}

/**
 * 0x92 charge/discharge management reply INFO: address, charge voltage limit (mV),
 * discharge voltage limit (mV), charge current limit (0.1 A), discharge current limit
 * (0.1 A, may be signed negative), status.
 */
export function parseManagement(info: Buffer): PylonLimits {
  const c = new Cursor(info, 1);
  c.u16();
  c.u16();
  const charge = c.s16() / 10;
  const discharge = c.s16() / 10;
  return { maxChargeCurrent: charge, maxDischargeCurrent: Math.abs(discharge) };
}

/**
 * 0x47 system parameter reply INFO: INFOFLAG, cell high/low/under voltage (mV),
 * charge high/low temperature (0.1 K), charge current limit, module high/low/under
 * voltage (mV), discharge high/low temperature (0.1 K), discharge current limit.
 * [verify] current unit (python-pylontech divides by 100, i.e. 10 mA).
 */
export function parseSystemParams(info: Buffer): PylonLimits & { cellHigh: number; cellLow: number } {
  const c = new Cursor(info, 1);
  const cellHigh = c.u16() / 1000;
  const cellLow = c.u16() / 1000;
  c.s16();
  c.s16();
  c.s16();
  const charge = c.s16() / 100;
  c.u16();
  c.u16();
  c.u16();
  c.s16();
  c.s16();
  const discharge = c.s16() / 100;
  return { cellHigh, cellLow, maxChargeCurrent: charge, maxDischargeCurrent: Math.abs(discharge) };
}

const printable = (b: Buffer) => {
  const s = b.toString('latin1').replace(/\0/g, '').trim();
  return /^[\x20-\x7e]*$/.test(s) ? s : '';
};

/** 0x51 manufacturer info INFO: device name (10 ASCII), software version (2 bytes), manufacturer (20 ASCII). */
export function parseManufacturer(info: Buffer) {
  return {
    model: printable(info.subarray(0, 10)),
    firmware: info.length >= 12 ? `${info[10]}.${info[11]}` : '',
    manufacturer: printable(info.subarray(12, 32)),
  };
}

/** 0x93 serial number INFO: address, 16 ASCII chars. */
export function parseSerial(info: Buffer) {
  return printable(info.subarray(1, 17));
}

// ---- Variants, brand presets and auto detection --------------------------------------------

/** The Advanced setting's values plus 'pace', which brand presets select. */
export type Variant = 'auto' | 'pylon' | 'dyness' | 'seplos' | 'generic' | 'pace';

/** One way of talking to the battery tried while connecting. */
export interface Attempt {
  variant: Exclude<Variant, 'auto'>;
  baud: number;
  /** Candidate addresses of the first pack, tried in order. Further packs follow consecutively. */
  first: number[];
  versions: number[];
  layout: Layout | 'auto';
}

const VARIANT_ATTEMPT: Record<Exclude<Variant, 'auto'>, Attempt> = {
  pylon: { variant: 'pylon', baud: 9600, first: [2, 1], versions: [0x20, 0x35], layout: 'auto' },
  // [verify] Dyness BX/B3 masters: Pylontech v3.5 frames, packs from address 1.
  dyness: { variant: 'dyness', baud: 9600, first: [1, 2], versions: [0x20], layout: 'auto' },
  seplos: { variant: 'seplos', baud: 19200, first: [0, 1], versions: [0x20], layout: 'seplos' },
  pace: { variant: 'pace', baud: 9600, first: [1, 0], versions: [0x25], layout: 'pace' },
  generic: { variant: 'generic', baud: 9600, first: [1, 2, 0], versions: [0x20, 0x25, 0x21, 0x35], layout: 'auto' },
};

/** Order tried by "Auto detect": the common 9600-baud batteries first, then Seplos at 19200. */
export const AUTO_ATTEMPTS: Attempt[] = [
  { ...VARIANT_ATTEMPT.pylon, first: [2] },
  { ...VARIANT_ATTEMPT.dyness, first: [1] },
  VARIANT_ATTEMPT.pace,
  VARIANT_ATTEMPT.seplos,
  { ...VARIANT_ATTEMPT.seplos, baud: 9600 },
  { ...VARIANT_ATTEMPT.generic, baud: 19200 },
];

export interface SerialModel extends DriverOption {
  attempts: Attempt[];
}

export const SERIAL_MODELS: SerialModel[] = [
  { id: 'auto', name: 'Auto detect', attempts: AUTO_ATTEMPTS },
  { id: 'pylontech', name: 'Pylontech (RS485)', attempts: [VARIANT_ATTEMPT.pylon] },
  { id: 'dyness', name: 'Dyness / Mecer', attempts: [VARIANT_ATTEMPT.dyness] },
  { id: 'seplos', name: 'Seplos V2 / Shoto / LBSA', attempts: [VARIANT_ATTEMPT.seplos] },
  // SOK: Pace BMS over RS232 on the master pack.
  { id: 'sok', name: 'SOK (RS232)', attempts: [VARIANT_ATTEMPT.pace] },
  { id: 'revov', name: 'Revov R100/B100/R9', attempts: [VARIANT_ATTEMPT.pace] },
  // [verify] Trophy ships with Pace (RS232, 9600) or Seplos (RS485, 19200) BMSs.
  { id: 'trophy', name: 'Trophy', attempts: [VARIANT_ATTEMPT.pace, VARIANT_ATTEMPT.seplos] },
  // [verify] SUN-BATT/BYD: Pylontech-style at 9600; address 1 or 2, VER 0x20 or Pace 0x25.
  { id: 'sunsynk', name: 'SunSynk SUN-BATT / BYD', attempts: [{ ...VARIANT_ATTEMPT.pylon, first: [1, 2] }, VARIANT_ATTEMPT.pace] },
  { id: 'vestwood', name: 'Vestwood', attempts: [{ ...VARIANT_ATTEMPT.pylon, first: [2] }] },
  { id: 'generic', name: 'Generic', attempts: [VARIANT_ATTEMPT.generic] },
];

/**
 * What to try while connecting: the Advanced "Protocol variant" overrides the model preset
 * unless it's Auto detect; a non-zero "Baud rate" replaces every attempt's baud.
 */
export function resolveAttempts(modelId: string, variant: string, baudOverride: number): Attempt[] {
  const model = SERIAL_MODELS.find((m) => m.id === modelId) ?? SERIAL_MODELS[0];
  const v = variant as Variant;
  let attempts = v && v !== 'auto' && v in VARIANT_ATTEMPT ? [VARIANT_ATTEMPT[v as Exclude<Variant, 'auto'>]] : model.attempts;
  if (baudOverride > 0) {
    const seen = new Set<string>();
    attempts = attempts
      .map((a) => ({ ...a, baud: baudOverride }))
      .filter((a) => {
        const key = `${a.variant}|${a.first.join()}|${a.versions.join()}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
  }
  return attempts;
}

// ---- Port reader ---------------------------------------------------------------------------

const TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 600;

export interface SerialAsciiOptions {
  attempts: Attempt[];
  maxPacks: () => number;
  protocol: () => ProtocolOptions;
}

/** One RS232/RS485 port with one or more packs. */
export class SerialAsciiPort implements PortReader {
  private link: AdaptiveLink;
  private opts: SerialAsciiOptions;
  private attempt: Attempt | null = null;
  private version = 0x20;
  private addresses: number[] = [];
  /** The first address answers for the whole stack (several blocks in one reply). */
  private stacked = false;
  private identity = new Map<number, Partial<PackReading>>();
  private limits = new Map<number, PylonLimits>();

  constructor(link: AdaptiveLink, opts: SerialAsciiOptions) {
    this.link = link;
    this.opts = opts;
  }

  get detected() {
    return this.attempt ? { variant: this.attempt.variant, baud: this.attempt.baud, version: this.version, addresses: [...this.addresses] } : null;
  }

  async command(adr: number, cid2: number, info?: Uint8Array, timeoutMs = TIMEOUT_MS) {
    const reply = await this.link.request(buildFrame(this.version, adr, CID1_BATTERY, cid2, info), asciiFrameReader, { timeoutMs });
    const f = parseFrame(reply);
    if (f.cid2 !== 0) throw new Error(`pack ${adr}: ${RTN_TEXT[f.cid2] ?? `error ${h2(f.cid2)}`}`);
    if (f.adr !== adr) throw new Error(`reply from address ${f.adr}, expected ${adr}`);
    return f.info;
  }

  private analog(adr: number, timeoutMs = TIMEOUT_MS) {
    return this.command(adr, CMD.analog, Uint8Array.of(adr), timeoutMs).then((info) => decodeAnalog(info, this.attempt?.layout ?? 'auto'));
  }

  async init() {
    this.addresses = [];
    this.stacked = false;
    const previous = this.attempt;
    // Re-detection (after repeated failures) tries the last working combination first.
    const attempts = previous ? [previous, ...this.opts.attempts.filter((a) => a !== previous)] : this.opts.attempts;
    let first: RawPack[] | null = null;
    search: for (const a of attempts) {
      await this.link.setBaud(a.baud);
      this.attempt = a;
      for (const ver of a.versions) {
        this.version = ver;
        for (const adr of a.first) {
          try {
            first = await this.analog(adr, PROBE_TIMEOUT_MS);
            this.addresses.push(adr);
            break search;
          } catch {
            // next address / version / attempt
          }
        }
      }
    }
    if (!first) {
      this.attempt = null;
      throw new Error(`${this.link.name}: no battery found (tried ${attempts.map((a) => `${a.variant} ${a.baud}`).join(', ')})`);
    }
    const a = this.attempt!;
    const maxPacks = this.opts.maxPacks();
    if (first.length > 1) {
      this.stacked = true;
    } else {
      for (let adr = this.addresses[0] + 1; this.addresses.length < maxPacks && adr <= 0xfe; adr++) {
        try {
          await this.analog(adr, PROBE_TIMEOUT_MS);
          this.addresses.push(adr);
        } catch {
          break; // packs are numbered without gaps
        }
      }
    }
    const count = this.stacked ? Math.min(first.length, maxPacks) : this.addresses.length;
    log.info(
      `Serial BMS ${this.link.name}: ${a.variant} protocol (VER 0x${h2(this.version)}, ${first[0].layout} layout) at ${a.baud} baud, ` +
        `${count} pack${count === 1 ? '' : 's'} ${this.stacked ? `via master address ${this.addresses[0]}` : `at address ${this.addresses.join(', ')}`}`,
    );
    if (first[0].layout === 'pylon') for (const adr of this.addresses) await this.identify(adr);
  }

  /** Model/firmware/serial/limits: best effort, once per connect (Pylontech layout only). */
  private async identify(adr: number) {
    const id: Partial<PackReading> = {};
    try {
      const m = parseManufacturer(await this.command(adr, CMD.manufacturer));
      if (m.model) id.model = m.model;
      if (m.firmware) id.firmware = m.firmware;
    } catch {}
    try {
      const s = parseSerial(await this.command(adr, CMD.serial, Uint8Array.of(adr)));
      if (s) id.serial = s;
    } catch {}
    try {
      this.limits.set(adr, parseSystemParams(await this.command(adr, CMD.systemParams, Uint8Array.of(adr))));
    } catch {}
    this.identity.set(adr, id);
  }

  async read(): Promise<(Metrics | undefined)[]> {
    const protocol = this.opts.protocol();
    if (this.stacked) {
      const packs = (await this.analog(this.addresses[0])).slice(0, this.opts.maxPacks());
      return packs.map((p) => packMetrics(rawReading(p, protocol)));
    }
    const out: (Metrics | undefined)[] = [];
    for (const [i, adr] of this.addresses.entries()) {
      try {
        out[i] = await this.readPack(adr, protocol);
      } catch {
        out[i] = undefined;
      }
    }
    if (out.every((m) => !m)) throw new Error(`${this.link.name}: no reply from any battery pack`);
    return out;
  }

  private async readPack(adr: number, protocol: ProtocolOptions) {
    const [p] = await this.analog(adr);
    const extra: Partial<PackReading> = { ...this.identity.get(adr) };
    if (p.layout === 'pylon') {
      try {
        extra.alarms = parseAlarms(await this.command(adr, CMD.alarm, Uint8Array.of(adr)));
      } catch {}
      try {
        this.limits.set(adr, parseManagement(await this.command(adr, CMD.management, Uint8Array.of(adr))));
      } catch {}
    }
    const limits = this.limits.get(adr);
    if (limits) {
      extra.maxChargeCurrent = limits.maxChargeCurrent;
      extra.maxDischargeCurrent = limits.maxDischargeCurrent;
    }
    return packMetrics(rawReading(p, protocol, extra));
  }
}

export interface SerialConfig {
  modelId: string;
  /** Advanced › Protocol variant ('auto' = use the model preset). */
  variant?: string;
  /** 0 = preset / auto. */
  baudRate?: number;
  maxPacks?: () => number;
  protocol?: () => ProtocolOptions;
  readCurrentFromInverter?: () => boolean;
}

export function createSerial(connections: string[], cfg: SerialConfig, factory: LinkFactory = serialLinkFactory): BmsDriver {
  const attempts = resolveAttempts(cfg.modelId, cfg.variant ?? 'auto', cfg.baudRate ?? 0);
  const opts: SerialAsciiOptions = { attempts, maxPacks: cfg.maxPacks ?? maxPackCount, protocol: cfg.protocol ?? protocolSettings };
  const bms = new MultiPortBms(
    connections,
    attempts[0].baud,
    (path, baud) => new AdaptiveLink(path, baud, factory),
    (link) => new SerialAsciiPort(link as AdaptiveLink, opts),
  );
  return withInverterCurrent(bms, cfg.readCurrentFromInverter);
}

export const serialDriver: BmsDriverDescriptor = {
  id: 'serial',
  name: 'USB Serial RS232/485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: true,
  models: SERIAL_MODELS.map(({ id, name }) => ({ id, name })),
  // The manager passes "bms.baud_rate || default"; the setting itself tells whether the user chose one.
  create: ({ connections, modelId }) =>
    createSerial(connections, {
      modelId,
      variant: settings.get('bms.serial_protocol_variant'),
      baudRate: Number(settings.get('bms.baud_rate')) || 0,
    }),
};
