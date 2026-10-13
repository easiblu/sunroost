/**
 * GoodWe WiFi/LAN dongle transport: UDP port 8899. Written from GoodWe's public protocol notes and
 * the behaviour documented by open-source GoodWe tools (UNVERIFIED on hardware). Two framings:
 *
 * 1. Modbus RTU over UDP (ET / EH / BT / BH and newer, incl. ES G2 / ES Uniq / EHB):
 *      request:  plain RTU frame   F7 03 <start BE> <count BE> <CRC-16/Modbus LE>
 *      reply:    AA 55 + RTU reply F7 03 <bytes> <data …> <CRC LE>   (CRC over the part after AA 55)
 *      exception AA 55 F7 83 <code> <CRC>
 *
 * 2. "AA55" protocol (older ES / EM / BP):
 *      request:  AA 55 C0 7F <ctrl> <func> <len> <payload …> <sum16 BE>
 *      reply:    AA 55 7F C0 <ctrl> <func|0x80> <len> <payload …> <sum16 BE>
 *    sum16 = 16-bit sum of every byte before it. 0x01/0x06 = running info, 0x01/0x02 = device info.
 *
 * UDP is lossy, so each request is retried; a reply may arrive split over several datagrams and
 * is accumulated until its length (from its own header) is complete. Stray or stale replies that
 * don't match the outstanding request are dropped.
 *
 * Connection string: goodwe://host[:port] (port defaults to 8899).
 */
import { createSocket, type Socket } from 'node:dgram';
import { modbusCrc, parseReply, readRequest, serveRequest } from '../../rtu.ts';

export const GOODWE_PORT = 8899;
/** GoodWe's default Modbus unit id ("communication address") on RS485 and the dongle. */
export const GOODWE_UNIT = 0xf7;

export interface GoodweTarget {
  host: string;
  port: number;
}

/** "goodwe://host[:port]" → parts, or null for other strings. */
export function parseGoodweConnection(connection: string): GoodweTarget | null {
  const m = /^goodwe:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(connection.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : GOODWE_PORT;
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

export const isGoodweConnection = (connection: string) => /^goodwe:\/\//i.test(connection.trim());

export const goodweConnection = (host: string, port = GOODWE_PORT) => `goodwe://${host}${port === GOODWE_PORT ? '' : `:${port}`}`;

/** 16-bit sum of bytes (AA55 checksum). */
export function sum16(data: Uint8Array, from = 0, to = data.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + data[i]) & 0xffff;
  return s;
}

/** AA55 frame from `src` to `dst`. Requests go C0 → 7F, replies 7F → C0. */
export function encodeAa55(ctrl: number, func: number, payload: Uint8Array = new Uint8Array(0), src = 0xc0, dst = 0x7f): Buffer {
  if (payload.length > 255) throw new Error('AA55 payload too long');
  const b = Buffer.alloc(7 + payload.length + 2);
  b[0] = 0xaa;
  b[1] = 0x55;
  b[2] = src;
  b[3] = dst;
  b[4] = ctrl;
  b[5] = func;
  b[6] = payload.length;
  Buffer.from(payload).copy(b, 7);
  b.writeUInt16BE(sum16(b, 0, b.length - 2), b.length - 2);
  return b;
}

/** Total length of the frame at the start of `buf`, or 0 while the header is incomplete. */
function frameLength(kind: 'modbus' | 'aa55', buf: Buffer): number {
  if (kind === 'aa55') return buf.length >= 7 ? 7 + buf[6] + 2 : 0;
  if (buf.length < 5) return 0;
  if (buf[3] & 0x80) return 2 + 5;
  return 2 + 3 + buf[4] + 2;
}

/**
 * Parses an AA55 reply to (ctrl, func). Returns the payload. Throws on a bad checksum or header.
 */
export function parseAa55(reply: Uint8Array, ctrl: number, func: number): Buffer {
  const b = Buffer.from(reply);
  if (b.length < 9 || b[0] !== 0xaa || b[1] !== 0x55) throw new Error('Not an AA55 frame');
  const len = 7 + b[6] + 2;
  if (b.length < len) throw new Error('AA55 reply truncated');
  if (sum16(b, 0, len - 2) !== b.readUInt16BE(len - 2)) throw new Error('AA55 reply checksum error');
  if (b[4] !== ctrl || b[5] !== (func | 0x80)) throw new Error(`AA55 reply ${b[4].toString(16)}/${b[5].toString(16)}, expected ${ctrl.toString(16)}/${(func | 0x80).toString(16)}`);
  return Buffer.from(b.subarray(7, 7 + b[6]));
}

interface Pending {
  kind: 'modbus' | 'aa55';
  /** Returns true when the frame is the awaited reply (it then resolves), false to drop it. */
  accept: (frame: Buffer) => boolean;
  reject: (e: Error) => void;
}

/** One UDP "session" with a GoodWe dongle; requests are serialised internally. */
export class GoodweUdpClient {
  readonly target: GoodweTarget;
  timeoutMs: number;
  retries: number;
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(target: GoodweTarget, opts: { timeoutMs?: number; retries?: number } = {}) {
    this.target = target;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 2;
  }

  get isOpen() {
    return this.socket !== null;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  connect(): Promise<void> {
    return this.exclusive(async () => {
      this.closeSocket();
      const s = createSocket('udp4');
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.connect(this.target.port, this.target.host, () => {
          s.off('error', reject);
          resolve();
        });
      });
      s.on('error', (err) => this.failPending(err));
      s.on('message', (msg) => this.onMessage(msg));
      this.socket = s;
      this.buf = Buffer.alloc(0);
    });
  }

  close(): Promise<void> {
    return this.exclusive(async () => this.closeSocket());
  }

  private closeSocket() {
    const s = this.socket;
    this.socket = null;
    this.failPending(new Error('Connection closed'));
    if (s) {
      try {
        s.close();
      } catch {}
    }
  }

  private failPending(err: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.reject(err);
  }

  private onMessage(msg: Buffer) {
    const p = this.pending;
    if (!p) return;
    // A datagram that starts a new frame replaces any partial one.
    this.buf = msg[0] === 0xaa && msg[1] === 0x55 ? Buffer.from(msg) : Buffer.concat([this.buf, msg]);
    if (this.buf[0] !== 0xaa || this.buf[1] !== 0x55) {
      this.buf = Buffer.alloc(0);
      return;
    }
    const len = frameLength(p.kind, this.buf);
    if (!len || this.buf.length < len) return;
    const frame = this.buf.subarray(0, len);
    this.buf = Buffer.alloc(0);
    if (p.accept(Buffer.from(frame))) this.pending = null;
  }

  /** Sends `request` and waits for a frame `accept` takes; retried on timeout. */
  private exchange<T>(kind: 'modbus' | 'aa55', request: Buffer, parse: (frame: Buffer) => T | undefined): Promise<T> {
    return this.exclusive(async () => {
      let lastErr: Error = new Error('No reply');
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await new Promise<T>((resolve, reject) => {
            const s = this.socket;
            if (!s) return reject(new Error('GoodWe UDP connection is not open'));
            const timer = setTimeout(() => {
              this.pending = null;
              reject(new Error(`No reply from GoodWe dongle ${this.target.host}:${this.target.port} within ${this.timeoutMs} ms`));
            }, this.timeoutMs);
            this.buf = Buffer.alloc(0);
            this.pending = {
              kind,
              accept: (frame) => {
                let value: T | undefined;
                try {
                  value = parse(frame);
                } catch (err) {
                  clearTimeout(timer);
                  reject(err as Error);
                  return true;
                }
                if (value === undefined) return false;
                clearTimeout(timer);
                resolve(value);
                return true;
              },
              reject: (e) => {
                clearTimeout(timer);
                reject(e);
              },
            };
            s.send(request, (err) => {
              if (err) this.failPending(err);
            });
          });
        } catch (err) {
          lastErr = err as Error;
          // Only timeouts are retried; a definite answer (exception, bad data) is final.
          if (!/^No reply/.test(lastErr.message)) throw lastErr;
        }
      }
      throw lastErr;
    });
  }

  /** Modbus read (fn 3 or 4) over UDP. Replies for another unit/function are ignored. */
  read(fn: 3 | 4, start: number, count: number, unit = GOODWE_UNIT): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 125) return Promise.reject(new Error('Register count must be 1–125'));
    const req = readRequest(unit, fn, start, count);
    return this.exchange('modbus', req, (frame) => {
      const rtu = frame.subarray(2);
      if (rtu[0] !== unit || (rtu[1] & 0x7f) !== fn) return undefined;
      if (!(rtu[1] & 0x80) && rtu[2] !== count * 2) return undefined; // stale reply to another read
      return parseReply(req, rtu);
    });
  }

  /** AA55 request; resolves with the reply payload. */
  aa55(ctrl: number, func: number, payload: Uint8Array = new Uint8Array(0)): Promise<Buffer> {
    const req = encodeAa55(ctrl, func, payload);
    return this.exchange('aa55', req, (frame) => {
      if (frame[4] !== ctrl || frame[5] !== (func | 0x80)) return undefined;
      return parseAa55(frame, ctrl, func);
    });
  }
}

/** AA55 request codes. */
export const AA55_RUNNING_INFO: [number, number] = [0x01, 0x06];
export const AA55_DEVICE_INFO: [number, number] = [0x01, 0x02];

/**
 * A fake GoodWe dongle for tests: answers Modbus-over-UDP reads from register maps (any of
 * `units`) and AA55 running/device-info requests from fixed payloads. `drop` swallows that many
 * requests first (to exercise retries).
 */
export function fakeGoodwe(opts: {
  holding?: Map<number, number>;
  input?: Map<number, number>;
  units?: number[];
  running?: Buffer;
  deviceInfo?: Buffer;
  drop?: number;
  /** Split each reply over two datagrams. */
  split?: boolean;
}): Socket {
  const maps = { holding: opts.holding ?? new Map<number, number>(), input: opts.input ?? new Map<number, number>() };
  const units = opts.units ?? [GOODWE_UNIT];
  let drop = opts.drop ?? 0;
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (drop > 0) {
      drop--;
      return;
    }
    let reply: Buffer | null = null;
    if (msg[0] === 0xaa && msg[1] === 0x55) {
      if (msg.length < 9 || sum16(msg, 0, msg.length - 2) !== msg.readUInt16BE(msg.length - 2)) return;
      const payload = msg[4] === 0x01 && msg[5] === 0x06 ? opts.running : msg[4] === 0x01 && msg[5] === 0x02 ? opts.deviceInfo : undefined;
      if (!payload) return;
      reply = encodeAa55(msg[4], msg[5] | 0x80, payload, 0x7f, 0xc0);
    } else {
      if (msg.length < 8 || modbusCrc(msg, 0, msg.length - 2) !== msg.readUInt16LE(msg.length - 2)) return;
      if (!units.includes(msg[0])) return;
      if (msg[1] !== 3 && msg[1] !== 4) return;
      reply = Buffer.concat([Buffer.from([0xaa, 0x55]), serveRequest(msg, maps)]);
    }
    if (opts.split && reply.length > 6) {
      sock.send(reply.subarray(0, 6), rinfo.port, rinfo.address);
      sock.send(reply.subarray(6), rinfo.port, rinfo.address);
    } else {
      sock.send(reply, rinfo.port, rinfo.address);
    }
  });
  return sock;
}
