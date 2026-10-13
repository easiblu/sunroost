/**
 * JK BMS (JK-B "JK02" boards) over the RS485/UART adapter, 115200 baud.
 *
 * Frame: 4E 57 | LEN (2, BE: counts from LEN itself to the end) | terminal no (4) |
 *        command (1) | source (1) | type (1) | data… | record no (4) | 0x68 | checksum (4)
 * Checksum: 16-bit sum of every byte from 0x4E through 0x68, stored in the last two bytes
 * (the two before are zero). Total frame size = LEN + 2.
 *
 * Read-all (command 0x06) returns a flat list of (id, value) items starting at offset 11:
 * 0x79 cell voltages (length byte, then [cell no, mV]×n), 0x80 MOS temp, 0x81/0x82 battery
 * temps, 0x83 voltage (10 mV), 0x84 current (10 mA, bit 15 set = charging), 0x85 SOC, 0x87
 * cycles, 0x89 total cycle capacity, 0x8B warnings, 0x8C status, 0xAA nominal capacity,
 * 0xB4 device id, 0xB7 software version, 0xB9 actual capacity, 0xBA manufacturer id,
 * 0xC0 protocol version.
 *
 * Models ("USB JK RS485"):
 *  - rs485 (default): JK-B board with the JK RS485 module, JK02 read-all as above.
 *  - pb_master: JK-PB inverter BMS read through its left RS485 port with the BMS protocol set to
 *    "000 – 4G-GPS" in the JK software; it then speaks the same 0x4E57 protocol.
 *  - listen: JK-PB parallel bus (right-hand ports). Never transmits; decodes the frames the
 *    packs exchange with the master — see "JK-PB parallel bus" below.
 */
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import type { BmsDriverDescriptor } from '../types.ts';
import { MultiPortBms, bitNames, packMetrics, type PackReading, type PortReader } from './pack.ts';
import { lengthReader, serialLinkFactory, sum, type ByteLink, type LinkFactory } from './serial.ts';

export const CMD_READ_ALL = 0x06;
const TIMEOUT_MS = 1500;
const MAX_FRAME = 1024;

/** Builds a request frame (source 3 = PC, type 0 = request). */
export function buildRequest(command: number, info = 0x00, terminal = 0): Buffer {
  const b = Buffer.alloc(21);
  b[0] = 0x4e;
  b[1] = 0x57;
  b.writeUInt16BE(b.length - 2, 2);
  b.writeUInt32BE(terminal >>> 0, 4);
  b[8] = command;
  b[9] = 0x03;
  b[10] = 0x00;
  b[11] = info;
  // 12..15 record number = 0
  b[16] = 0x68;
  b.writeUInt16BE(sum(b, 0, 17) & 0xffff, 19);
  return b;
}

/** Validates a frame and returns its data section (offset 11 up to the record number). */
export function frameData(frame: Buffer): Buffer {
  if (frame.length < 20 || frame[0] !== 0x4e || frame[1] !== 0x57) throw new Error('JK: bad frame header');
  const total = frame.readUInt16BE(2) + 2;
  if (total !== frame.length) throw new Error('JK: length mismatch');
  if (frame[total - 5] !== 0x68) throw new Error('JK: missing end marker');
  const chk = frame.readUInt16BE(total - 2);
  if ((sum(frame, 0, total - 4) & 0xffff) !== chk) throw new Error('JK: checksum mismatch');
  return frame.subarray(11, total - 9);
}

/** Byte size of each fixed-length data item; 0x79 is variable. */
const SIZES: Record<number, number> = {
  0x80: 2, 0x81: 2, 0x82: 2, 0x83: 2, 0x84: 2, 0x85: 1, 0x86: 1, 0x87: 2, 0x89: 4, 0x8a: 2, 0x8b: 2,
  0x8c: 2, 0x8e: 2, 0x8f: 2, 0x90: 2, 0x91: 2, 0x92: 2, 0x93: 2, 0x94: 2, 0x95: 2, 0x96: 2, 0x97: 2,
  0x98: 2, 0x99: 2, 0x9a: 2, 0x9b: 2, 0x9c: 2, 0x9d: 1, 0x9e: 2, 0x9f: 2, 0xa0: 2, 0xa1: 2, 0xa2: 2,
  0xa3: 2, 0xa4: 2, 0xa5: 2, 0xa6: 2, 0xa7: 2, 0xa8: 2, 0xa9: 1, 0xaa: 4, 0xab: 1, 0xac: 1, 0xad: 2,
  0xae: 1, 0xaf: 1, 0xb0: 2, 0xb1: 1, 0xb2: 10, 0xb3: 1, 0xb4: 8, 0xb5: 4, 0xb6: 4, 0xb7: 15, 0xb8: 1,
  0xb9: 4, 0xba: 24, 0xc0: 1,
};

export interface JkItems {
  cells: number[];
  items: Map<number, Buffer>;
}

/** Splits the data section into items. Stops at an unknown id (the rest can't be sized). */
export function parseItems(data: Buffer): JkItems {
  const items = new Map<number, Buffer>();
  const cells: number[] = [];
  let i = 0;
  while (i < data.length) {
    const id = data[i++];
    if (id === 0x79) {
      const len = data[i++];
      const end = Math.min(data.length, i + len);
      for (let j = i; j + 3 <= end; j += 3) {
        if (data[j] >= 1) cells[data[j] - 1] = data.readUInt16BE(j + 1) / 1000;
      }
      i = end;
      continue;
    }
    const size = SIZES[id];
    if (!size || i + size > data.length) break;
    items.set(id, data.subarray(i, i + size));
    i += size;
  }
  return { cells: cells.filter((v) => v !== undefined), items };
}

/** 0–100 = °C; 101–140 = −1…−40 °C. */
export const jkTemp = (raw: number) => (raw > 100 ? -(raw - 100) : raw);

/**
 * Current: protocol version 1 (0xC0 = 1, most boards) uses bit 15 as the direction flag
 * (set = charging) and the low 15 bits as 10 mA; version 0 encodes (10000 − raw) × 10 mA.
 */
export function jkCurrent(raw: number, protocolVersion = 1) {
  if (protocolVersion === 0) return round2((10000 - raw) * 0.01);
  const amps = (raw & 0x7fff) * 0.01;
  return round2(raw & 0x8000 ? amps : -amps);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const WARNINGS = [
  'Low capacity',
  'MOS over temperature',
  'Charge over voltage',
  'Discharge under voltage',
  'Battery over temperature',
  'Charge over current',
  'Discharge over current',
  'Cell voltage difference',
  'Battery box over temperature',
  'Battery low temperature',
  'Cell over voltage',
  'Cell under voltage',
  '309_A protection',
  '309_B protection',
];

const ascii = (b?: Buffer) => (b ? b.toString('latin1').replace(/\0/g, '').trim() : undefined);

export function jkReading({ cells, items }: JkItems): PackReading {
  const u = (id: number) => {
    const b = items.get(id);
    return b ? b.readUIntBE(0, b.length) : undefined;
  };
  const protocol = u(0xc0) ?? 1;
  const raw84 = u(0x84);
  const temp = (id: number) => {
    const v = u(id);
    return v === undefined ? undefined : jkTemp(v);
  };
  const t1 = temp(0x81);
  const t2 = temp(0x82);
  const temps = [t1, t2].filter((t): t is number => t !== undefined);
  const nominal = u(0xaa);
  const actual = u(0xb9);
  const full = actual || nominal;
  const soc = u(0x85);
  const v83 = u(0x83);
  return {
    soc,
    soh: actual && nominal ? Math.min(100, (actual / nominal) * 100) : undefined,
    voltage: v83 === undefined ? undefined : v83 / 100,
    current: raw84 === undefined ? undefined : jkCurrent(raw84, protocol),
    temperatureMos: temp(0x80),
    temperatures: temps,
    cellTemperatures: temps,
    cells,
    cycles: u(0x87),
    fullAh: full,
    designAh: nominal,
    remainingAh: full && soc !== undefined ? (full * soc) / 100 : undefined,
    alarms: bitNames(u(0x8b) ?? 0, WARNINGS),
    model: ascii(items.get(0xba)),
    serial: ascii(items.get(0xb4)),
    firmware: ascii(items.get(0xb7)),
  };
}

export const frameReader = lengthReader([0x4e, 0x57], 4, (h) => {
  const total = h.readUInt16BE(2) + 2;
  return total >= 20 && total <= MAX_FRAME ? total : null;
});

export class JkPort implements PortReader {
  private link: ByteLink;
  constructor(link: ByteLink) {
    this.link = link;
  }
  async init() {}
  async read(): Promise<(Metrics | undefined)[]> {
    const reply = await this.link.request(buildRequest(CMD_READ_ALL), frameReader, { timeoutMs: TIMEOUT_MS });
    return [packMetrics(jkReading(parseItems(frameData(reply))))];
  }
}

export function createJk(connections: string[], baudRate: number, factory: LinkFactory = serialLinkFactory) {
  return new MultiPortBms(connections, baudRate, factory, (link) => new JkPort(link));
}

// ---- JK-PB parallel bus (listen mode) ----------------------------------------------------------
//
// JK-PB packs share an RS485 bus at 115200 8N1 (Modbus RTU). The master (dip address 0) polls each
// slave with a write-multiple request, e.g. `<adr> 10 16 20 00 01 02 00 00 <crc>` (0x1620: cell
// data, 0x161E: settings, 0x161C: device info). The slave answers with a 300-byte JK02 frame
// `55 AA EB 90 <type> <counter> <data…> <sum8>` (type 0x01 settings, 0x02 cell data, 0x03 device
// info) followed by the Modbus write ack `<adr> 10 16 20 00 01 <crc>`. The pack address comes from
// that ack, or else from the request just before the frame. Source: esphome-jk-bms
// (jk_rs485_sniffer / JK02_32S frame layout) [verify against a real bus].
//
// Cell-data frame (type 0x02, 32-cell layout), little-endian [verify]:
//   6 cells 1–32 (u16 mV) · 70 enabled-cell mask (u32) · 80 cell resistances · 144 MOS temp
//   (s16, 0.1 °C) · 150 pack V (u32 mV) · 154 power (u32 mW) · 158 current (s32 mA, + = charging) ·
//   162/164 temp sensors 1/2 (s16, 0.1 °C) · 166 alarm bits (u16 BE) · 171 SOC (u8) ·
//   172 remaining (u32 mAh) · 176 nominal (u32 mAh) · 180 cycles (u32) · 188 SOH (u8)
// Device-info frame (type 0x03) [verify]: 6 model (16 chars) · 22 hardware version (8) ·
//   30 software version (8) · 46 device name (16) · 86 serial number (11).

export const PB_FRAME = 300;
const PB_HEADER = Buffer.from([0x55, 0xaa, 0xeb, 0x90]);
const PB_ACK = 8;
const PB_REQUEST = 11;

/** Modbus CRC-16 (poly 0xA001, init 0xFFFF); stored little-endian on the wire. */
export function crc16(b: Uint8Array, from = 0, to = b.length) {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= b[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const crcOk = (b: Buffer, at: number, len: number) => at + len <= b.length && crc16(b, at, at + len - 2) === b.readUInt16LE(at + len - 2);

/** `<adr> 10 16 xx 00 01 02 00 00 <crc>`: master asks pack `adr` for a frame. */
const isPbRequest = (b: Buffer, at: number) =>
  b[at + 1] === 0x10 && b[at + 2] === 0x16 && b[at + 4] === 0x00 && b[at + 5] === 0x01 && b[at + 6] === 0x02 && crcOk(b, at, PB_REQUEST);

/** `<adr> 10 16 xx 00 01 <crc>`: the ack a pack sends after its frame. */
const isPbAck = (b: Buffer, at: number) => b[at + 1] === 0x10 && b[at + 2] === 0x16 && b[at + 4] === 0x00 && b[at + 5] === 0x01 && crcOk(b, at, PB_ACK);

export interface PbFrame {
  /** Pack (dip) address, when known. */
  address: number | undefined;
  type: number;
  frame: Buffer;
}

/** Splits the raw parallel-bus byte stream into checked JK02 frames tagged with the pack address. */
export class JkPbSplitter {
  private buf = Buffer.alloc(0);
  private lastRequest: number | undefined;

  push(chunk: Buffer): PbFrame[] {
    this.buf = this.buf.length > 4096 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    return this.drain(false);
  }

  /** Emits a complete frame still waiting for its ack (call when the bus goes quiet). */
  flush(): PbFrame[] {
    return this.drain(true);
  }

  private drain(force: boolean): PbFrame[] {
    const out: PbFrame[] = [];
    for (;;) {
      const at = this.buf.indexOf(PB_HEADER);
      // Requests before the next frame tell us whom the master is polling.
      const scanTo = at < 0 ? this.buf.length : at;
      for (let i = 0; i + PB_REQUEST <= scanTo; i++) if (isPbRequest(this.buf, i)) this.lastRequest = this.buf[i];
      if (at < 0) {
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - (PB_REQUEST - 1)));
        return out;
      }
      this.buf = this.buf.subarray(at);
      if (this.buf.length < PB_FRAME) return out;
      if ((sum(this.buf, 0, PB_FRAME - 1) & 0xff) !== this.buf[PB_FRAME - 1]) {
        this.buf = this.buf.subarray(1); // false header: resync
        continue;
      }
      let address = this.lastRequest;
      let used = PB_FRAME;
      if (this.buf.length >= PB_FRAME + PB_ACK) {
        if (isPbAck(this.buf, PB_FRAME)) {
          address = this.buf[PB_FRAME];
          used += PB_ACK;
        }
      } else if (!force) {
        return out; // wait for the ack
      }
      out.push({ address, type: this.buf[4], frame: Buffer.from(this.buf.subarray(0, PB_FRAME)) });
      this.buf = this.buf.subarray(used);
      this.lastRequest = undefined;
    }
  }
}

const PB_ALARMS = [
  'Balance wire resistance',
  'MOS over temperature',
  'Cell quantity mismatch',
  'Current sensor error',
  'Cell over voltage',
  'Battery over voltage',
  'Charge over current',
  'Charge short circuit',
  'Charge over temperature',
  'Charge under temperature',
  'Internal communication error',
  'Cell under voltage',
  'Battery under voltage',
  'Discharge over current',
  'Discharge short circuit',
  'Discharge over temperature',
];

const latin = (b: Buffer, at: number, len: number) => b.toString('latin1', at, at + len).replace(/[^\x20-\x7e]/g, '').trim() || undefined;

/** Decodes a type 0x02 (cell data) JK-PB frame. */
export function pbCellReading(f: Buffer): PackReading {
  const mask = f.readUInt32LE(70);
  const cells: number[] = [];
  for (let i = 0; i < 32; i++) {
    const mv = f.readUInt16LE(6 + i * 2);
    if ((mask ? mask & (2 ** i) : mv) && mv > 0) cells.push(mv / 1000);
  }
  const t = (at: number) => {
    const v = f.readInt16LE(at) / 10;
    return v > -40 && v < 150 ? v : undefined;
  };
  const temps = [t(162), t(164)].filter((v): v is number => v !== undefined);
  const nominal = f.readUInt32LE(176) / 1000;
  const remaining = f.readUInt32LE(172) / 1000;
  return {
    cells,
    temperatureMos: t(144),
    voltage: f.readUInt32LE(150) / 1000,
    current: f.readInt32LE(158) / 1000,
    temperatures: temps,
    cellTemperatures: temps,
    alarms: bitNames(f.readUInt16BE(166), PB_ALARMS),
    soc: f[171],
    remainingAh: remaining || undefined,
    designAh: nominal || undefined,
    fullAh: nominal || undefined,
    cycles: f.readUInt32LE(180),
    soh: f[188] || undefined,
  };
}

/** Decodes a type 0x03 (device info) JK-PB frame. */
export function pbInfo(f: Buffer): Pick<PackReading, 'model' | 'firmware' | 'serial'> {
  return { model: latin(f, 6, 16), firmware: latin(f, 30, 8), serial: latin(f, 86, 11) };
}

/** Receive-only byte stream (the listener never writes to the parallel bus). */
export interface ByteStream {
  readonly isOpen: boolean;
  open(onData: (chunk: Buffer) => void): Promise<void>;
  close(): Promise<void>;
}

export type StreamFactory = (path: string, baudRate: number) => ByteStream;

export const serialStreamFactory: StreamFactory = (path, baudRate) => {
  let port: import('serialport').SerialPort | null = null;
  return {
    get isOpen() {
      return Boolean(port?.isOpen);
    },
    async open(onData) {
      if (port?.isOpen) return;
      const { SerialPort } = await import('serialport');
      const p = new SerialPort({ path, baudRate, autoOpen: false });
      await new Promise<void>((resolve, reject) => p.open((err) => (err ? reject(err) : resolve())));
      p.on('data', onData);
      p.on('error', () => {});
      port = p;
    },
    async close() {
      const p = port;
      port = null;
      if (p?.isOpen) await new Promise<void>((resolve) => p.close(() => resolve()));
    },
  };
};

/** Packs not heard from for this long are dropped from the readings. */
const PB_STALE_MS = 60_000;
/** How long the first read waits for traffic after connecting. */
const PB_FIRST_WAIT_MS = 5000;

interface PbPack {
  reading?: PackReading;
  info?: Pick<PackReading, 'model' | 'firmware' | 'serial'>;
  at: number;
}

/** Listens to one parallel bus and keeps the latest frame of every pack. */
export class JkPbListener {
  private stream: ByteStream;
  private splitter = new JkPbSplitter();
  private packs = new Map<number, PbPack>();
  /** Addresses in order of first appearance → stable pack positions. */
  private order: number[] = [];
  private waiters: (() => void)[] = [];
  private maxPacks: number;
  private now: () => number;

  constructor(stream: ByteStream, maxPacks = 16, now: () => number = Date.now) {
    this.stream = stream;
    this.maxPacks = maxPacks;
    this.now = now;
  }

  get isOpen() {
    return this.stream.isOpen;
  }

  async open() {
    await this.stream.open((chunk) => this.ingest(this.splitter.push(chunk)));
  }

  async close() {
    await this.stream.close();
  }

  ingest(frames: PbFrame[]) {
    for (const { address, type, frame } of frames) {
      if (address === undefined) continue;
      let p = this.packs.get(address);
      if (!p) {
        if (this.packs.size >= this.maxPacks) continue;
        p = { at: 0 };
        this.packs.set(address, p);
        this.order.push(address);
        this.order.sort((a, b) => a - b);
      }
      if (type === 0x02) {
        p.reading = pbCellReading(frame);
        p.at = this.now();
        for (const w of this.waiters.splice(0)) w();
      } else if (type === 0x03) {
        p.info = pbInfo(frame);
      }
    }
  }

  private fresh() {
    return this.order.some((a) => {
      const p = this.packs.get(a)!;
      return p.reading && this.now() - p.at < PB_STALE_MS;
    });
  }

  async read(waitMs = PB_FIRST_WAIT_MS): Promise<(Metrics | undefined)[]> {
    this.ingest(this.splitter.flush());
    if (!this.fresh() && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const out = this.order.map((a) => {
      const p = this.packs.get(a)!;
      return p.reading && this.now() - p.at < PB_STALE_MS ? packMetrics({ ...p.reading, ...p.info }) : undefined;
    });
    if (!out.some(Boolean)) {
      throw new Error('JK listen: no pack data heard on the parallel bus — use a right-hand parallel RS485 port (pin 1 = B, pin 2 = A) at 115200');
    }
    return out;
  }
}

/** Listen mode over one or more parallel buses; packs are concatenated in connection order. */
export class JkPbListenBms {
  private listeners: JkPbListener[];
  private slots: number[];

  constructor(connections: string[], baudRate: number, maxPacks = 16, factory: StreamFactory = serialStreamFactory) {
    if (!connections.length) throw new Error('No battery connection selected');
    this.listeners = connections.map((c) => new JkPbListener(factory(c, baudRate), maxPacks));
    this.slots = connections.map(() => 1);
  }

  async connect() {
    const results = await Promise.allSettled(this.listeners.map((l) => (l.isOpen ? undefined : l.open())));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length === results.length) throw failed[0].reason;
  }

  async close() {
    await Promise.allSettled(this.listeners.map((l) => l.close()));
  }

  async read(): Promise<Metrics[]> {
    const results = await Promise.allSettled(this.listeners.map((l) => (l.isOpen ? l.read() : l.open().then(() => l.read()))));
    const out: Metrics[] = [];
    let offset = 0;
    let firstError: unknown = null;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        this.slots[i] = Math.max(1, r.value.length);
        r.value.forEach((m, j) => {
          if (m) out[offset + j] = m;
        });
      } else firstError ??= r.reason;
      offset += this.slots[i];
    });
    if (!out.some(Boolean)) throw firstError ?? new Error('JK listen: no data');
    return out;
  }
}

export const JK_MODELS = [
  { id: 'rs485', name: 'RS485 adapter (JK02 protocol)' },
  { id: 'pb_master', name: 'JK inverter BMS (left port, protocol 000 – 4G-GPS)' },
  { id: 'listen', name: 'JK inverter BMS (listen to parallel bus)' },
];

export const jk: BmsDriverDescriptor = {
  id: 'jk',
  name: 'USB JK RS485',
  transport: 'serial',
  defaultBaudRate: 115200,
  multiConnection: true,
  models: JK_MODELS,
  create: ({ connections, baudRate, modelId }) =>
    modelId === 'listen'
      ? new JkPbListenBms(connections, baudRate, settings.get('bms.maximum_pack_count'))
      : createJk(connections, baudRate), // rs485 and pb_master: JK02 "4G-GPS" protocol
};
