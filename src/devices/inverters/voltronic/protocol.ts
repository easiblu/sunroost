/**
 * Voltronic ASCII protocol (PI30 family): framing, CRC and the two transports.
 *
 * Request:  <ASCII command><CRC hi><CRC lo>\r
 * Reply:    (<payload><CRC hi><CRC lo>\r      e.g. "(ACK" / "(NAK" for set commands
 *
 * The CRC is CRC16/XMODEM (poly 0x1021, init 0). Voltronic avoids '(' 0x28, CR 0x0D and LF 0x0A in
 * either CRC byte by incrementing such a byte by one, so a CR inside the frame always ends it.
 *
 * Transports: USB-serial / RS232 (2400 8N1, via `serialport`) and USB HID (/dev/hidraw*), where the
 * request goes out in 8-byte reports padded with 0x00 and the reply comes back in reports until a CR.
 */
import { constants, promises as fsp } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 3000;

export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const RESERVED = new Set([0x28, 0x0d, 0x0a]);

/** The CRC as sent on the wire: reserved byte values bumped by one. */
export function voltronicCrc(data: Uint8Array): number {
  const crc = crc16(data);
  let hi = crc >> 8;
  let lo = crc & 0xff;
  if (RESERVED.has(hi)) hi++;
  if (RESERVED.has(lo)) lo++;
  return (hi << 8) | lo;
}

/** Builds a request frame: command + CRC + CR. */
export function frame(command: string): Buffer {
  const body = Buffer.from(command, 'latin1');
  const crc = voltronicCrc(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}

export class CrcError extends Error {}
export class NakError extends Error {
  constructor(command: string) {
    super(`Inverter replied NAK to ${command}`);
  }
}

const printable = (b: number) => b >= 0x20 && b <= 0x7e;

/**
 * Turns a raw reply (up to and including the CR) into its payload: no '(' and no CRC.
 * With `verifyCrc` a missing or wrong CRC throws; without it, two trailing non-printable bytes are
 * taken to be a CRC and dropped, and printable endings are kept (some firmware sends no CRC at all).
 */
export function parseReply(raw: Buffer, verifyCrc = true): string {
  let end = raw.indexOf(0x0d);
  if (end < 0) end = raw.length;
  const body = raw.subarray(0, end);
  if (body.length === 0 || body[0] !== 0x28) throw new Error(`Invalid reply: ${JSON.stringify(body.toString('latin1'))}`);
  let payloadEnd = body.length;
  if (body.length >= 3) {
    const data = body.subarray(0, body.length - 2);
    const got = (body[body.length - 2] << 8) | body[body.length - 1];
    const ok = voltronicCrc(data) === got || crc16(data) === got;
    if (ok) payloadEnd = body.length - 2;
    else if (verifyCrc) throw new CrcError('CRC mismatch in reply');
    else if (!printable(body[body.length - 1]) || !printable(body[body.length - 2])) payloadEnd = body.length - 2;
  } else if (verifyCrc) {
    throw new CrcError('Reply too short');
  }
  return body.subarray(1, payloadEnd).toString('latin1');
}

/** A byte link that can send a request and collect bytes until a CR. */
export interface Transport {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Sends `request` and resolves with the reply bytes up to and including the first CR. */
  exchange(request: Buffer, timeoutMs: number): Promise<Buffer>;
}

/** The subset of fs.promises.FileHandle the HID transport uses (lets tests inject a fake device). */
export interface HidHandle {
  write(buffer: Buffer, offset?: number, length?: number): Promise<{ bytesWritten: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits a frame into 8-byte HID reports, the last padded with 0x00. */
export function hidChunks(request: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < request.length; i += 8) {
    const chunk = Buffer.alloc(8);
    request.copy(chunk, 0, i, Math.min(i + 8, request.length));
    out.push(chunk);
  }
  return out;
}

/**
 * /dev/hidraw* access. The device is opened non-blocking so a silent inverter cannot pin a libuv
 * thread: an empty read (EAGAIN) just waits a little and polls again until the timeout.
 */
export class HidTransport implements Transport {
  private path: string;
  private handle: HidHandle | null = null;
  private opener: (path: string) => Promise<HidHandle>;
  private pollMs: number;

  constructor(path: string, opener?: (path: string) => Promise<HidHandle>, pollMs = 15) {
    this.path = path;
    this.opener = opener ?? ((p) => fsp.open(p, constants.O_RDWR | constants.O_NONBLOCK) as Promise<HidHandle>);
    this.pollMs = pollMs;
  }

  async open() {
    await this.close();
    this.handle = await this.opener(this.path);
  }

  async close() {
    const h = this.handle;
    this.handle = null;
    await h?.close().catch(() => {});
  }

  async exchange(request: Buffer, timeoutMs: number): Promise<Buffer> {
    const h = this.handle;
    if (!h) throw new Error('HID device not open');
    await this.drain(h);
    for (const chunk of hidChunks(request)) await h.write(chunk, 0, chunk.length);
    const deadline = Date.now() + timeoutMs;
    const parts: Buffer[] = [];
    const report = Buffer.alloc(8);
    while (Date.now() < deadline) {
      let n = 0;
      try {
        n = (await h.read(report, 0, report.length, null)).bytesRead;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
      }
      if (n === 0) {
        await sleep(this.pollMs);
        continue;
      }
      const data = Buffer.from(report.subarray(0, n));
      const cr = data.indexOf(0x0d);
      if (cr >= 0) {
        parts.push(data.subarray(0, cr + 1));
        return Buffer.concat(parts);
      }
      parts.push(data);
    }
    throw new Error('No response (timeout)');
  }

  /** Discards stale reports left over from an earlier timed-out request. */
  private async drain(h: HidHandle) {
    const buf = Buffer.alloc(8);
    for (let i = 0; i < 64; i++) {
      try {
        if ((await h.read(buf, 0, 8, null)).bytesRead === 0) return;
      } catch {
        return;
      }
    }
  }
}

interface SerialPortLike {
  open(cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
  write(data: Buffer, cb: (err: Error | null | undefined) => void): boolean;
  drain(cb: (err: Error | null) => void): void;
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  isOpen: boolean;
}

/** USB-serial / RS232 at 2400 8N1 (serialport is loaded lazily so tests never touch native bindings). */
export class SerialTransport implements Transport {
  private path: string;
  private baudRate: number;
  private port: SerialPortLike | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;

  constructor(path: string, baudRate = 2400) {
    this.path = path;
    this.baudRate = baudRate;
  }

  async open() {
    await this.close();
    const mod = (await import('serialport')) as unknown as { SerialPort?: unknown; default?: { SerialPort: unknown } };
    const Ctor = (mod.SerialPort ?? mod.default?.SerialPort) as new (o: object) => SerialPortLike;
    const port = new Ctor({ path: this.path, baudRate: this.baudRate, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
    await new Promise<void>((res, rej) => port.open((err) => (err ? rej(err) : res())));
    port.on('data', (chunk: Buffer) => {
      this.rx = Buffer.concat([this.rx, chunk]);
      if (this.rx.length > 4096) this.rx = this.rx.subarray(-4096);
      this.waiter?.();
    });
    port.on('error', () => {});
    this.port = port;
  }

  async close() {
    const p = this.port;
    this.port = null;
    if (p?.isOpen) await new Promise<void>((res) => p.close(() => res()));
  }

  async exchange(request: Buffer, timeoutMs: number): Promise<Buffer> {
    const port = this.port;
    if (!port) throw new Error('Serial port not open');
    this.rx = Buffer.alloc(0);
    await new Promise<void>((res, rej) => port.write(request, (err) => (err ? rej(err) : res())));
    await new Promise<void>((res) => port.drain(() => res()));
    return new Promise<Buffer>((resolve, reject) => {
      const check = () => {
        const cr = this.rx.indexOf(0x0d);
        if (cr < 0) return;
        const out = this.rx.subarray(0, cr + 1);
        this.rx = this.rx.subarray(cr + 1);
        done();
        resolve(Buffer.from(out));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('No response (timeout)'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiter = null;
      };
      this.waiter = check;
      check();
    });
  }
}

/** Chooses the transport from the connection path: anything with "hidraw" in it is USB HID. */
export function transportFor(connection: string, baudRate: number): Transport {
  return /hidraw/i.test(connection) ? new HidTransport(connection) : new SerialTransport(connection, baudRate || 2400);
}

/**
 * One inverter link: serialized commands (promise mutex), a timeout and one retry on timeouts and
 * CRC errors. NAK is never retried (the inverter understood and refused).
 */
export class VoltronicLink {
  readonly transport: Transport;
  verifyCrc: boolean;
  timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(transport: Transport, opts: { verifyCrc?: boolean; timeoutMs?: number } = {}) {
    this.transport = transport;
    this.verifyCrc = opts.verifyCrc ?? true;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  open() {
    return this.exclusive(() => this.transport.open());
  }

  close() {
    return this.exclusive(() => this.transport.close());
  }

  /** Sends one command and returns the payload (no '(' and no CRC). "NAK" is returned as-is. */
  query(command: string): Promise<string> {
    return this.exclusive(async () => {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await this.transport.exchange(frame(command), this.timeoutMs);
          return parseReply(raw, this.verifyCrc);
        } catch (err) {
          lastErr = err as Error;
        }
      }
      throw new Error(`${command}: ${lastErr?.message ?? 'failed'}`);
    });
  }

  /** Like query, but a NAK reply throws. */
  async ask(command: string): Promise<string> {
    const reply = await this.query(command);
    if (/^NAK/.test(reply)) throw new NakError(command);
    return reply;
  }

  /** For set commands: anything but ACK throws "Inverter replied NAK". */
  async set(command: string): Promise<void> {
    const reply = await this.query(command);
    if (!/^ACK/.test(reply)) throw new Error('Inverter replied NAK');
  }
}
