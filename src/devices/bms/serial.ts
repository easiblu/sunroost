/**
 * Shared byte-link plumbing for the serial BMS drivers: a request/response exchange with a
 * mutex (one transaction on the wire at a time), a per-request timeout, stale-input discard
 * before each request, and pluggable frame readers that decide when a reply is complete.
 *
 * `BaseLink` holds the transport-independent logic so tests can drive it with a scripted
 * link; `SerialLink` is the real thing on top of the `serialport` package.
 */

/**
 * Decides whether `buf` (bytes received so far, oldest first) holds a complete frame.
 * Returns the frame length (> 0) when complete, 0 when more bytes are needed, or -n to
 * discard n leading bytes (noise before the start-of-frame marker).
 */
export type FrameReader = (buf: Buffer) => number;

export interface RequestOptions {
  timeoutMs?: number;
  /** On timeout, resolve with whatever arrived (if anything) instead of rejecting. */
  partial?: boolean;
}

export interface ByteLink {
  readonly name: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Writes `data`, then resolves with the first complete frame accepted by `reader`. */
  request(data: Buffer, reader: FrameReader, opts?: RequestOptions): Promise<Buffer>;
}

export type LinkFactory = (path: string, baudRate: number) => ByteLink;

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what}: no response`);
    this.name = 'TimeoutError';
  }
}

/** Serialises async work: each `run` waits for the previous one to settle. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

interface Pending {
  reader: FrameReader;
  resolve: (frame: Buffer) => void;
}

/** Transport-independent request/response engine. Subclasses call `feed()` with received bytes. */
export abstract class BaseLink implements ByteLink {
  readonly name: string;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private mutex = new Mutex();

  constructor(name: string) {
    this.name = name;
  }

  abstract get isOpen(): boolean;
  abstract open(): Promise<void>;
  abstract close(): Promise<void>;
  protected abstract write(data: Buffer): Promise<void>;

  request(data: Buffer, reader: FrameReader, opts: RequestOptions = {}): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? 1000;
    return this.mutex.run(async () => {
      if (!this.isOpen) throw new Error(`${this.name}: port not open`);
      this.buf = Buffer.alloc(0); // drop stale bytes (late replies, extra frames)
      let timer: NodeJS.Timeout | undefined;
      const done = new Promise<Buffer>((resolve, reject) => {
        this.pending = { reader, resolve };
        timer = setTimeout(() => {
          this.pending = null;
          if (opts.partial && this.buf.length) resolve(this.take(this.buf.length));
          else reject(new TimeoutError(this.name));
        }, timeoutMs);
      });
      try {
        await this.write(data);
        this.check();
        return await done;
      } finally {
        clearTimeout(timer);
        this.pending = null;
      }
    });
  }

  /** Feeds received bytes into the frame assembler. */
  protected feed(chunk: Buffer) {
    // Bound memory if a device streams junk while nothing is pending.
    this.buf = this.buf.length > 8192 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    this.check();
  }

  private check() {
    const p = this.pending;
    if (!p) return;
    for (;;) {
      if (!this.buf.length) return;
      const n = p.reader(this.buf);
      if (n === 0) return;
      if (n < 0) {
        this.buf = this.buf.subarray(Math.min(-n, this.buf.length));
        continue;
      }
      if (n > this.buf.length) return;
      this.pending = null;
      p.resolve(this.take(n));
      return;
    }
  }

  private take(n: number) {
    const frame = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return frame;
  }
}

/** A serial port (USB-RS485/UART adapter) via the `serialport` package, 8N1. */
export class SerialLink extends BaseLink {
  private port: import('serialport').SerialPort | null = null;
  private readonly baudRate: number;

  constructor(path: string, baudRate: number) {
    super(path);
    this.baudRate = baudRate;
  }

  get isOpen() {
    return Boolean(this.port?.isOpen);
  }

  async open() {
    if (this.isOpen) return;
    const { SerialPort } = await import('serialport');
    const port = new SerialPort({ path: this.name, baudRate: this.baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    port.on('data', (chunk: Buffer) => this.feed(chunk));
    port.on('error', () => {}); // surfaced as request timeouts / write errors
    this.port = port;
  }

  async close() {
    const port = this.port;
    this.port = null;
    if (!port?.isOpen) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  protected write(data: Buffer) {
    const port = this.port;
    if (!port) return Promise.reject(new Error(`${this.name}: port not open`));
    return new Promise<void>((resolve, reject) => {
      port.write(data, (err) => {
        if (err) return reject(err);
        port.drain((e) => (e ? reject(e) : resolve()));
      });
    });
  }
}

export const serialLinkFactory: LinkFactory = (path, baud) => new SerialLink(path, baud);

// ---- Frame readers --------------------------------------------------------------------

/** Frames that start with `sync` and end with the byte `term` (e.g. Pylontech "~…\r"). */
export function terminatedReader(sync: number, term: number, maxLength = 4096): FrameReader {
  return (buf) => {
    if (buf[0] !== sync) {
      const at = buf.indexOf(sync);
      return at < 0 ? -buf.length : -at;
    }
    const end = buf.indexOf(term, 1);
    if (end < 0) return buf.length > maxLength ? -1 : 0;
    return end + 1;
  };
}

/**
 * Frames that start with `sync` (one or more bytes) and whose total length can be computed
 * from the first `headerLength` bytes. `lengthOf` returns null for an implausible header,
 * which drops one byte and resynchronises.
 */
export function lengthReader(sync: number[], headerLength: number, lengthOf: (header: Buffer) => number | null): FrameReader {
  return (buf) => {
    const head = Math.min(sync.length, buf.length);
    for (let i = 0; i < head; i++) {
      if (buf[i] !== sync[i]) {
        const at = buf.indexOf(sync[0], 1);
        return at < 0 ? -buf.length : -at;
      }
    }
    if (buf.length < headerLength) return 0;
    const len = lengthOf(buf);
    if (len === null || len < headerLength) return -1;
    return buf.length >= len ? len : 0;
  };
}

// ---- Small byte helpers ----------------------------------------------------------------

export const sum = (bytes: Uint8Array, from = 0, to = bytes.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += bytes[i];
  return s;
};

export const hex = (buf: Uint8Array) => Buffer.from(buf).toString('hex').toUpperCase();
