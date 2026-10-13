/**
 * Luxpower / EG4 WiFi dongle ("datalogger") transport on TCP port 8000.
 *
 * Written from the publicly documented framing (UNVERIFIED on hardware). Every packet:
 *
 *   offset  size  field
 *   0       2     prefix A1 1A
 *   2       2     protocol version, u16 LE (we send 2)
 *   4       2     frame length, u16 LE = total length − 6
 *   6       1     address (1)
 *   7       1     TCP function: C1 heartbeat, C2 translated data
 *   8       10    dongle serial, ASCII
 *   18      2     data length, u16 LE           (translated data only)
 *   20      n     data                          (translated data only)
 *
 * Translated data is a Modbus-like frame, register values little-endian:
 *
 *   request:  00 | fn | inverter serial (10) | register u16 LE | count u16 LE (fn 3/4)
 *                                                              | value u16 LE (fn 6)
 *                                                              | count u16 LE, bytes u8, values (fn 16)
 *             | CRC-16/Modbus u16 LE over everything before it
 *   reply:    01 | fn | inverter serial (10) | register u16 LE | bytes u8 | values u16 LE … (fn 3/4)
 *             (fn 6 / 16 echo register and value / count) | CRC
 *
 * The dongle also pushes heartbeats (echoed back to keep the session) and unsolicited data packets
 * when the cloud polls; replies are matched by function and register.
 *
 * Connection string: luxpower://host[:port]/DONGLESERIAL[/INVERTERSERIAL]. Without an inverter
 * serial we send ten '0' characters (UNVERIFIED: some dongles accept that, others need the real
 * serial) and learn the real one from the first reply.
 */
import { createServer, Socket, type Server } from 'node:net';
import { modbusCrc } from '../../rtu.ts';

export const DONGLE_PORT = 8000;
const PREFIX0 = 0xa1;
const PREFIX1 = 0x1a;
const HEADER = 20;
const TCP_HEARTBEAT = 0xc1;
const TCP_DATA = 0xc2;
export const BLANK_SERIAL = '0000000000';

export interface LuxTarget {
  host: string;
  port: number;
  dongleSerial: string;
  /** Empty when not given. */
  inverterSerial: string;
}

const SERIAL_RE = '[A-Za-z0-9]{10}';

/** "luxpower://host[:port]/dongle[/inverter]" → parts, or null for other strings. */
export function parseLuxConnection(connection: string): LuxTarget | null {
  const m = new RegExp(`^luxpower://([A-Za-z0-9.-]+)(?::(\\d{1,5}))?/(${SERIAL_RE})(?:/(${SERIAL_RE}))?/?$`, 'i').exec(connection.trim());
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : DONGLE_PORT, dongleSerial: m[3], inverterSerial: m[4] ?? '' };
}

export const luxConnection = (host: string, dongle: string, inverter = '', port = DONGLE_PORT) =>
  `luxpower://${host}${port === DONGLE_PORT ? '' : `:${port}`}/${dongle}${inverter ? `/${inverter}` : ''}`;

function ascii10(text: string): Buffer {
  const b = Buffer.alloc(10, 0x30);
  b.write(text.slice(0, 10), 'latin1');
  return b;
}

function withCrc(body: Buffer): Buffer {
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(modbusCrc(body));
  return Buffer.concat([body, crc]);
}

/** Wraps a data frame (or none, for heartbeats) in the dongle header. */
export function encodePacket(tcpFn: number, dongleSerial: string, data: Buffer | null, protocol = 2): Buffer {
  const body = data ? Buffer.concat([Buffer.from([data.length & 0xff, data.length >> 8]), data]) : Buffer.from([0]);
  const out = Buffer.alloc(8 + 10 + body.length);
  out[0] = PREFIX0;
  out[1] = PREFIX1;
  out.writeUInt16LE(protocol, 2);
  out.writeUInt16LE(out.length - 6, 4);
  out[6] = 1;
  out[7] = tcpFn;
  ascii10(dongleSerial).copy(out, 8);
  body.copy(out, 18);
  return out;
}

/** Translated-data request: read (fn 3/4), write single (6) or write multiple (16). */
export function encodeRequest(fn: 3 | 4 | 6 | 16, inverterSerial: string, register: number, arg: number | number[]): Buffer {
  const head = Buffer.alloc(14);
  head[0] = 0;
  head[1] = fn;
  ascii10(inverterSerial || BLANK_SERIAL).copy(head, 2);
  head.writeUInt16LE(register, 12);
  let tail: Buffer;
  if (fn === 16) {
    const values = arg as number[];
    tail = Buffer.alloc(3 + values.length * 2);
    tail.writeUInt16LE(values.length, 0);
    tail[2] = values.length * 2;
    values.forEach((v, i) => tail.writeUInt16LE(v, 3 + i * 2));
  } else {
    tail = Buffer.alloc(2);
    tail.writeUInt16LE(arg as number, 0);
  }
  return withCrc(Buffer.concat([head, tail]));
}

export interface LuxPacket {
  protocol: number;
  tcpFn: number;
  dongleSerial: string;
  /** Translated data (without the length prefix); empty for heartbeats. */
  data: Buffer;
  /** The whole packet as received. */
  raw: Buffer;
}

/** Splits complete packets off the front of `buf`; garbage before a prefix is dropped. */
export function splitPackets(buf: Buffer): { packets: LuxPacket[]; rest: Buffer } {
  const packets: LuxPacket[] = [];
  let i = 0;
  for (;;) {
    while (i < buf.length - 1 && !(buf[i] === PREFIX0 && buf[i + 1] === PREFIX1)) i++;
    if (buf.length - i < 18) break;
    const total = buf.readUInt16LE(i + 4) + 6;
    if (total < 18 || total > 2048) {
      i++;
      continue;
    }
    if (buf.length - i < total) break;
    const raw = Buffer.from(buf.subarray(i, i + total));
    const tcpFn = raw[7];
    let data = Buffer.alloc(0);
    if (tcpFn === TCP_DATA && raw.length >= HEADER) {
      const len = raw.readUInt16LE(18);
      data = raw.subarray(HEADER, Math.min(raw.length, HEADER + len));
    }
    packets.push({ protocol: raw.readUInt16LE(2), tcpFn, dongleSerial: raw.subarray(8, 18).toString('latin1'), data, raw });
    i += total;
  }
  return { packets, rest: Buffer.from(buf.subarray(i)) };
}

export interface LuxReply {
  fn: number;
  inverterSerial: string;
  register: number;
  /** Registers for reads; the echoed value/count for writes. */
  values: number[];
}

/** Parses a translated-data reply. Throws on a bad CRC or an exception reply. */
export function parseReplyData(data: Buffer): LuxReply {
  if (data.length < 16) throw new Error('Dongle reply too short');
  const body = data.subarray(0, data.length - 2);
  if (modbusCrc(body) !== data.readUInt16LE(data.length - 2)) throw new Error('Dongle reply CRC error');
  const fn = data[1];
  const inverterSerial = data.subarray(2, 12).toString('latin1');
  const register = data.readUInt16LE(12);
  if (fn & 0x80) throw new Error(`Inverter exception ${data[14]} for function ${fn & 0x7f} at register ${register}`);
  if (fn === 3 || fn === 4) {
    const bytes = data[14];
    if (body.length < 15 + bytes) throw new Error('Dongle reply truncated');
    const values: number[] = [];
    for (let k = 0; k < bytes / 2; k++) values.push(data.readUInt16LE(15 + k * 2));
    return { fn, inverterSerial, register, values };
  }
  return { fn, inverterSerial, register, values: [data.readUInt16LE(14)] };
}

interface Pending {
  fn: number;
  register: number;
  count: number;
  resolve: (r: LuxReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One TCP session with a dongle; requests are serialised internally. */
export class LuxDongleClient {
  readonly target: LuxTarget;
  timeoutMs: number;
  /** Learned from replies when the connection string had none. */
  inverterSerial: string;
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(target: LuxTarget, timeoutMs = 5000) {
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.inverterSerial = target.inverterSerial;
  }

  get isOpen() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  connect(): Promise<void> {
    const { host, port } = this.target;
    return new Promise((resolve, reject) => {
      const s = new Socket();
      const fail = (err: Error) => {
        s.destroy();
        reject(err);
      };
      s.setTimeout(this.timeoutMs, () => fail(new Error(`Timed out connecting to dongle ${host}:${port}`)));
      s.once('error', fail);
      s.connect(port, host, () => {
        s.setTimeout(0);
        s.off('error', fail);
        s.setKeepAlive(true, 30_000);
        s.on('error', (err) => this.failPending(err));
        s.on('close', () => this.failPending(new Error('Dongle closed the connection')));
        s.on('data', (d) => this.onData(d));
        this.socket = s;
        this.buf = Buffer.alloc(0);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    this.failPending(new Error('Connection closed'));
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.end(() => resolve());
      s.destroy();
      setTimeout(resolve, 200).unref();
    });
  }

  private failPending(err: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private onData(d: Buffer) {
    const { packets, rest } = splitPackets(Buffer.concat([this.buf, d]));
    this.buf = rest.length > 4096 ? Buffer.alloc(0) : rest;
    for (const pk of packets) {
      if (pk.tcpFn === TCP_HEARTBEAT) {
        // Echo heartbeats so the dongle keeps the session open.
        this.socket?.write(pk.raw);
        continue;
      }
      const p = this.pending;
      if (pk.tcpFn !== TCP_DATA || !p || pk.data.length < 16) continue;
      const fn = pk.data[1];
      if ((fn & 0x7f) !== p.fn || pk.data.readUInt16LE(12) !== p.register) continue;
      const serial = pk.data.subarray(2, 12).toString('latin1');
      if (this.target.inverterSerial && serial !== this.target.inverterSerial) continue;
      let reply: LuxReply;
      try {
        reply = parseReplyData(pk.data);
      } catch (err) {
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(err as Error);
        continue;
      }
      if ((p.fn === 3 || p.fn === 4) && reply.values.length !== p.count) continue;
      this.pending = null;
      clearTimeout(p.timer);
      if (!this.inverterSerial && /^[A-Za-z0-9]{10}$/.test(reply.inverterSerial)) this.inverterSerial = reply.inverterSerial;
      p.resolve(reply);
    }
  }

  private exchange(fn: 3 | 4 | 6 | 16, register: number, arg: number | number[], count: number): Promise<LuxReply> {
    return this.exclusive(
      () =>
        new Promise<LuxReply>((resolve, reject) => {
          if (!this.socket || this.socket.destroyed) return reject(new Error('Dongle connection is not open'));
          const data = encodeRequest(fn, this.inverterSerial, register, arg);
          const timer = setTimeout(() => {
            this.pending = null;
            reject(new Error(`No reply from dongle ${this.target.host} within ${this.timeoutMs} ms`));
          }, this.timeoutMs);
          this.pending = { fn, register, count, resolve, reject, timer };
          this.socket.write(encodePacket(TCP_DATA, this.target.dongleSerial, data));
        }),
    );
  }

  async read(fn: 3 | 4, start: number, count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 125) throw new Error('Register count must be 1–125');
    return (await this.exchange(fn, start, count, count)).values;
  }

  async write(start: number, values: number[]): Promise<void> {
    if (values.length === 1) await this.exchange(6, start, values[0], 1);
    else await this.exchange(16, start, values, values.length);
  }
}

/**
 * A fake dongle for tests: answers translated-data reads/writes from register maps. Optionally
 * sends a heartbeat and an unrelated unsolicited data packet before each reply.
 */
export function fakeDongle(opts: {
  dongleSerial: string;
  inverterSerial: string;
  input?: Map<number, number>;
  holding?: Map<number, number>;
  noise?: boolean;
}): Server {
  const input = opts.input ?? new Map<number, number>();
  const holding = opts.holding ?? new Map<number, number>();
  const reply = (fn: number, register: number, payload: Buffer) => {
    const head = Buffer.alloc(14);
    head[0] = 1;
    head[1] = fn;
    ascii10(opts.inverterSerial).copy(head, 2);
    head.writeUInt16LE(register, 12);
    return encodePacket(TCP_DATA, opts.dongleSerial, withCrc(Buffer.concat([head, payload])));
  };
  const regsPayload = (m: Map<number, number>, start: number, count: number) => {
    const b = Buffer.alloc(1 + count * 2);
    b[0] = count * 2;
    for (let k = 0; k < count; k++) b.writeUInt16LE(m.get(start + k) ?? 0, 1 + k * 2);
    return b;
  };
  return createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      const { packets, rest } = splitPackets(Buffer.concat([buf, d]));
      buf = rest;
      for (const pk of packets) {
        if (pk.tcpFn !== TCP_DATA || pk.dongleSerial !== opts.dongleSerial || pk.data.length < 18) continue;
        const data = pk.data;
        if (modbusCrc(data.subarray(0, data.length - 2)) !== data.readUInt16LE(data.length - 2)) continue;
        const fn = data[1];
        const register = data.readUInt16LE(12);
        if (opts.noise) {
          sock.write(encodePacket(TCP_HEARTBEAT, opts.dongleSerial, null));
          sock.write(reply(4, 200, regsPayload(input, 200, 2)));
        }
        if (fn === 3 || fn === 4) {
          const count = data.readUInt16LE(14);
          sock.write(reply(fn, register, regsPayload(fn === 3 ? holding : input, register, count)));
        } else if (fn === 6) {
          holding.set(register, data.readUInt16LE(14));
          sock.write(reply(fn, register, data.subarray(14, 16)));
        } else if (fn === 16) {
          const count = data.readUInt16LE(14);
          for (let k = 0; k < count; k++) holding.set(register + k, data.readUInt16LE(17 + k * 2));
          sock.write(reply(fn, register, data.subarray(14, 16)));
        } else {
          sock.write(reply(fn | 0x80, register, Buffer.from([1, 0])));
        }
      }
    });
  });
}
