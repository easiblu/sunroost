/**
 * Points (what to read and write on a Modbus device), the built-in profiles, the compact syntax
 * for custom points, value decoding/encoding, and read batching. Pure functions.
 *
 * Custom points, one per line:   name; kind; table; address[; type][; key=value …]
 *   kind     switch | sensor | binary_sensor | number | select
 *   table    coil | discrete | holding | input
 *   address  decimal or 0x hex, the protocol address (0-based; register 40001 is holding 0)
 *   type     bool | u16 | s16 | u32 | s32 | float32   (default: bool for coil/discrete, u16 for registers)
 *   options  scale=0.1  unit=W  order=le (32-bit: low word first; default be)  on=1 off=0 (holding switches)
 *            min=6 max=32 step=1 (number)  options=0:Off|1:Auto|2:On (select)
 * Lines starting with # are comments.
 */
import type { Table } from './client.ts';
import { MAX_BITS, MAX_REGISTERS } from './client.ts';

export type Kind = 'switch' | 'sensor' | 'binary_sensor' | 'number' | 'select';
export type DataType = 'bool' | 'u16' | 's16' | 'u32' | 's32' | 'float32';

export interface Point {
  /** Stable within an entry; part of the entity's uniqueId. */
  key: string;
  name: string;
  kind: Kind;
  table: Table;
  address: number;
  type: DataType;
  /** Word order of 32-bit values: be = high word first. */
  order: 'be' | 'le';
  scale: number;
  unit: string | null;
  deviceClass: string | null;
  /** Holding-register switch values. */
  on?: number;
  off?: number;
  min?: number;
  max?: number;
  step?: number;
  /** select: raw value → label. */
  options?: { value: number; label: string }[];
}

export const MAX_POINTS = 16;
const KINDS: Kind[] = ['switch', 'sensor', 'binary_sensor', 'number', 'select'];
const TABLES: Table[] = ['coil', 'discrete', 'holding', 'input'];
const TYPES: DataType[] = ['bool', 'u16', 's16', 'u32', 's32', 'float32'];
const isBitTable = (t: Table) => t === 'coil' || t === 'discrete';

export const width = (t: DataType) => (t === 'u32' || t === 's32' || t === 'float32' ? 2 : 1);

const DEVICE_CLASS: Record<string, string> = {
  W: 'power', kW: 'power', V: 'voltage', A: 'current', kWh: 'energy', Wh: 'energy', Hz: 'frequency', '°C': 'temperature', '%': 'battery',
};

function point(p: Omit<Point, 'key' | 'order' | 'scale' | 'unit' | 'deviceClass'> & Partial<Point>): Point {
  const unit = p.unit ?? null;
  return {
    key: `${p.table}${p.address}`,
    order: 'be',
    scale: 1,
    deviceClass: unit ? DEVICE_CLASS[unit] ?? null : null,
    ...p,
    unit,
  };
}

// ---------- Profiles ----------

export type ProfileId = 'relay' | 'sdm120' | 'sdm630' | 'custom';

export const PROFILES: { value: ProfileId; label: string }[] = [
  { value: 'relay', label: 'Relay board (coils)' },
  { value: 'sdm120', label: 'Eastron SDM120 energy meter (single phase)' },
  { value: 'sdm630', label: 'Eastron SDM630 energy meter (three phase)' },
  { value: 'custom', label: 'Custom: define the registers yourself' },
];

const sdm = (name: string, address: number, unit: string) =>
  point({ name, kind: 'sensor', table: 'input', address, type: 'float32', unit });

/** Eastron SDM120 input registers (IEEE 754 float, high word first). */
export function sdm120(): Point[] {
  return [
    sdm('Voltage', 0x0000, 'V'),
    sdm('Current', 0x0006, 'A'),
    sdm('Power', 0x000c, 'W'),
    sdm('Frequency', 0x0046, 'Hz'),
    sdm('Import energy', 0x0048, 'kWh'),
    sdm('Export energy', 0x004a, 'kWh'),
    sdm('Total energy', 0x0156, 'kWh'),
  ];
}

/** Eastron SDM630 input registers (IEEE 754 float, high word first). */
export function sdm630(): Point[] {
  return [
    sdm('Voltage L1', 0x0000, 'V'),
    sdm('Voltage L2', 0x0002, 'V'),
    sdm('Voltage L3', 0x0004, 'V'),
    sdm('Current L1', 0x0006, 'A'),
    sdm('Current L2', 0x0008, 'A'),
    sdm('Current L3', 0x000a, 'A'),
    sdm('Power L1', 0x000c, 'W'),
    sdm('Power L2', 0x000e, 'W'),
    sdm('Power L3', 0x0010, 'W'),
    sdm('Total power', 0x0034, 'W'),
    sdm('Frequency', 0x0046, 'Hz'),
    sdm('Import energy', 0x0048, 'kWh'),
    sdm('Export energy', 0x004a, 'kWh'),
    sdm('Total energy', 0x0156, 'kWh'),
  ];
}

export function relayBoard(count: number, first: number): Point[] {
  return Array.from({ length: count }, (_, i) => point({ name: `Relay ${i + 1}`, kind: 'switch', table: 'coil', address: first + i, type: 'bool' }));
}

// ---------- Custom syntax ----------

export class PointError extends Error {}

function num(raw: string, what: string, line: number): number {
  const t = raw.trim();
  const n = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : Number(t);
  if (t === '' || !Number.isFinite(n)) throw new PointError(`Line ${line}: ${what} "${raw}" is not a number.`);
  return n;
}

/** Parses the custom-points text. Throws PointError naming the line. */
export function parsePoints(text: string): Point[] {
  const out: Point[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    const parts = t.split(';').map((x) => x.trim());
    if (parts.length < 4) throw new PointError(`Line ${line}: expected "name; kind; table; address", got "${t}".`);
    const [name, kindRaw, tableRaw, addrRaw, ...rest] = parts;
    if (!name || name.length > 60) throw new PointError(`Line ${line}: give the point a name (up to 60 characters).`);
    const kind = kindRaw.toLowerCase() as Kind;
    if (!KINDS.includes(kind)) throw new PointError(`Line ${line}: kind must be one of ${KINDS.join(', ')}.`);
    const table = tableRaw.toLowerCase() as Table;
    if (!TABLES.includes(table)) throw new PointError(`Line ${line}: table must be one of ${TABLES.join(', ')}.`);
    const address = num(addrRaw, 'address', line);
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new PointError(`Line ${line}: address must be 0–65535.`);
    let type: DataType = isBitTable(table) ? 'bool' : 'u16';
    const opts: Record<string, string> = {};
    for (const r of rest) {
      if (!r) continue;
      const eq = r.indexOf('=');
      if (eq < 0) {
        const ty = r.toLowerCase() as DataType;
        if (!TYPES.includes(ty)) throw new PointError(`Line ${line}: unknown type "${r}" (use ${TYPES.join(', ')}).`);
        type = ty;
      } else {
        opts[r.slice(0, eq).trim().toLowerCase()] = r.slice(eq + 1).trim();
      }
    }
    if (isBitTable(table) && type !== 'bool') throw new PointError(`Line ${line}: ${table}s hold single bits; use type bool.`);
    if (!isBitTable(table) && type === 'bool') throw new PointError(`Line ${line}: registers need a number type (u16, s16, u32, s32, float32).`);
    if (address + width(type) - 1 > 0xffff) throw new PointError(`Line ${line}: the value runs past address 65535.`);
    // Which kinds fit which tables.
    if (kind === 'switch' && table !== 'coil' && table !== 'holding') throw new PointError(`Line ${line}: a switch needs a coil or a holding register.`);
    if ((kind === 'number' || kind === 'select') && table !== 'holding') throw new PointError(`Line ${line}: a ${kind} needs a holding register.`);
    if (kind === 'sensor' && isBitTable(table)) throw new PointError(`Line ${line}: for a coil or discrete input use binary_sensor.`);

    const known = ['scale', 'unit', 'order', 'on', 'off', 'min', 'max', 'step', 'options'];
    for (const k of Object.keys(opts)) if (!known.includes(k)) throw new PointError(`Line ${line}: unknown option "${k}".`);
    const p = point({ name, kind, table, address, type, unit: opts.unit ? opts.unit.slice(0, 12) : null });
    if (opts.scale !== undefined) {
      p.scale = num(opts.scale, 'scale', line);
      if (p.scale === 0) throw new PointError(`Line ${line}: scale can't be 0.`);
    }
    if (opts.order !== undefined) {
      if (opts.order !== 'be' && opts.order !== 'le') throw new PointError(`Line ${line}: order must be be or le.`);
      p.order = opts.order;
    }
    if (kind === 'switch' && table === 'holding') {
      p.on = opts.on !== undefined ? num(opts.on, 'on', line) : 1;
      p.off = opts.off !== undefined ? num(opts.off, 'off', line) : 0;
      if (p.on === p.off) throw new PointError(`Line ${line}: on and off must differ.`);
    }
    if (kind === 'binary_sensor' && !isBitTable(table) && opts.on !== undefined) p.on = num(opts.on, 'on', line);
    if (kind === 'number') {
      p.min = opts.min !== undefined ? num(opts.min, 'min', line) : 0;
      p.max = opts.max !== undefined ? num(opts.max, 'max', line) : 65535 * p.scale;
      p.step = opts.step !== undefined ? num(opts.step, 'step', line) : p.scale;
      if (p.min >= p.max) throw new PointError(`Line ${line}: min must be below max.`);
    }
    if (kind === 'select') {
      if (!opts.options) throw new PointError(`Line ${line}: a select needs options=value:Label|value:Label.`);
      p.options = opts.options.split('|').map((o) => {
        const c = o.indexOf(':');
        if (c < 0) throw new PointError(`Line ${line}: option "${o}" needs value:Label.`);
        return { value: num(o.slice(0, c), 'option value', line), label: o.slice(c + 1).trim() };
      });
      if (p.options.some((o) => !o.label)) throw new PointError(`Line ${line}: every option needs a label.`);
    }
    // Same address twice (e.g. a register read two ways): keep keys unique.
    const base = p.key;
    const same = out.filter((x) => x.key === base || x.key.startsWith(`${base}_`)).length;
    if (same) p.key = `${base}_${same + 1}`;
    out.push(p);
  });
  if (!out.length) throw new PointError('Define at least one point.');
  if (out.length > MAX_POINTS) throw new PointError(`At most ${MAX_POINTS} points per device (got ${out.length}).`);
  return out;
}

// ---------- Values ----------

/** Registers → raw number (before scale). */
export function decode(regs: number[], type: DataType, order: 'be' | 'le'): number {
  if (type === 'u16') return regs[0];
  if (type === 's16') return regs[0] > 0x7fff ? regs[0] - 0x10000 : regs[0];
  const [hi, lo] = order === 'be' ? [regs[0], regs[1]] : [regs[1], regs[0]];
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi, 0);
  buf.writeUInt16BE(lo, 2);
  if (type === 'u32') return buf.readUInt32BE(0);
  if (type === 's32') return buf.readInt32BE(0);
  return buf.readFloatBE(0);
}

/** Raw number → registers. Throws when it doesn't fit the type. */
export function encode(value: number, type: DataType, order: 'be' | 'le'): number[] {
  const buf = Buffer.alloc(4);
  const int = Math.round(value);
  switch (type) {
    case 'u16':
      if (int < 0 || int > 0xffff) throw new Error(`${value} doesn't fit a u16 register`);
      return [int];
    case 's16':
      if (int < -0x8000 || int > 0x7fff) throw new Error(`${value} doesn't fit an s16 register`);
      return [int & 0xffff];
    case 'u32':
      if (int < 0 || int > 0xffffffff) throw new Error(`${value} doesn't fit a u32 value`);
      buf.writeUInt32BE(int, 0);
      break;
    case 's32':
      if (int < -0x80000000 || int > 0x7fffffff) throw new Error(`${value} doesn't fit an s32 value`);
      buf.writeInt32BE(int, 0);
      break;
    case 'float32':
      buf.writeFloatBE(value, 0);
      break;
    default:
      throw new Error('bool values are written to coils');
  }
  const hi = buf.readUInt16BE(0);
  const lo = buf.readUInt16BE(2);
  return order === 'be' ? [hi, lo] : [lo, hi];
}

/** Rounds away float noise from scaling (0.1 × 2305 = 230.50000000000003). */
export const tidy = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6);

// ---------- Batching ----------

export interface Batch {
  table: Table;
  start: number;
  count: number;
  points: Point[];
}

/**
 * Groups points into reads: per table, addresses that touch or overlap share one request (up to
 * 125 registers / 2000 bits). Gaps are never read across: many devices reject unmapped addresses.
 */
export function batches(points: Point[]): Batch[] {
  const out: Batch[] = [];
  for (const table of TABLES) {
    const list = points.filter((p) => p.table === table).sort((a, b) => a.address - b.address);
    const max = isBitTable(table) ? MAX_BITS : MAX_REGISTERS;
    let cur: Batch | null = null;
    for (const p of list) {
      const end = p.address + width(p.type);
      if (cur && p.address <= cur.start + cur.count && end - cur.start <= max) {
        cur.count = Math.max(cur.count, end - cur.start);
        cur.points.push(p);
      } else {
        cur = { table, start: p.address, count: width(p.type), points: [p] };
        out.push(cur);
      }
    }
  }
  return out;
}
