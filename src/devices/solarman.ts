/**
 * Solarman V5: the TCP protocol of the "Solarman" WiFi/LAN data loggers sold with Deye, SunSynk,
 * Sol-Ark, Megarevo, Solis, Afore and many other inverters. The logger listens on TCP 8899 and
 * relays Modbus RTU frames to the inverter's RS485 port, wrapped in a V5 envelope:
 *
 *   A5 | length u16le | control u16le | sequence u16le | logger serial u32le | payload | checksum | 15
 *
 * Request payload:  02 | sensor u16 | 3 × u32 time fields (zero) | Modbus RTU frame
 * Response payload: 02 | status u8  | 3 × u32 time fields       | Modbus RTU frame
 *
 * The checksum is the low byte of the sum of every byte between the start and checksum bytes.
 * The logger only answers requests that carry its own serial number (printed on its label and
 * returned by discovery). Loggers also push unsolicited frames (heartbeats, cloud data); those are
 * skipped by control code and sequence.
 *
 * Discovery: a UDP broadcast of "WIFIKIT-214028-READ" to port 48899; each logger answers
 * "ip,mac,serial".
 */
import { createSocket } from 'node:dgram';
import { createServer, Socket, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parseReply, readRequest, serveRequest, writeRequest } from './rtu.ts';

export const SOLARMAN_PORT = 8899;
export const DISCOVERY_PORT = 48899;
const CONTROL_REQUEST = 0x4510;
const CONTROL_RESPONSE = 0x1510;
const HEADER = 11;
const REQUEST_PREFIX = 15;
const RESPONSE_PREFIX = 14;

function checksum(frame: Uint8Array, from: number, to: number) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += frame[i];
  return sum & 0xff;
}

/** Wraps a Modbus RTU frame for logger `serial`. Exported for tests. */
export function encodeRequest(serial: number, sequence: number, modbus: Uint8Array): Buffer {
  const payload = Buffer.alloc(REQUEST_PREFIX);
  payload[0] = 0x02;
  const frame = Buffer.alloc(HEADER + payload.length + modbus.length + 2);
  frame[0] = 0xa5;
  frame.writeUInt16LE(payload.length + modbus.length, 1);
  frame.writeUInt16LE(CONTROL_REQUEST, 3);
  frame.writeUInt16LE(sequence & 0xffff, 5);
  frame.writeUInt32LE(serial >>> 0, 7);
  payload.copy(frame, HEADER);
  Buffer.from(modbus).copy(frame, HEADER + payload.length);
  frame[frame.length - 2] = checksum(frame, 1, frame.length - 2);
  frame[frame.length - 1] = 0x15;
  return frame;
}

export interface V5Frame {
  control: number;
  sequence: number;
  serial: number;
  payload: Buffer;
}

/**
 * Splits complete V5 frames off the front of `buf`. Returns the frames and the unconsumed rest.
 * Garbage before a start byte is dropped; frames with a bad checksum are dropped.
 */
export function splitFrames(buf: Buffer): { frames: V5Frame[]; rest: Buffer } {
  const frames: V5Frame[] = [];
  let i = 0;
  for (;;) {
    while (i < buf.length && buf[i] !== 0xa5) i++;
    if (buf.length - i < HEADER + 2) break;
    const len = buf.readUInt16LE(i + 1);
    const total = HEADER + len + 2;
    if (buf.length - i < total) break;
    const end = i + total;
    if (buf[end - 1] === 0x15 && checksum(buf, i + 1, end - 2) === buf[end - 2]) {
      frames.push({
        control: buf.readUInt16LE(i + 3),
        sequence: buf.readUInt16LE(i + 5),
        serial: buf.readUInt32LE(i + 7),
        payload: Buffer.from(buf.subarray(i + HEADER, end - 2)),
      });
      i = end;
    } else {
      i++;
    }
  }
  return { frames, rest: Buffer.from(buf.subarray(i)) };
}

/** The Modbus frame inside a logger's response payload, or an error if the inverter didn't answer. */
export function modbusFromResponse(payload: Buffer): Buffer {
  if (payload.length <= RESPONSE_PREFIX + 4) {
    throw new Error('Logger answered without inverter data (check the RS485 link between logger and inverter)');
  }
  return payload.subarray(RESPONSE_PREFIX);
}

/** "solarman://host[:port]/serial" → target parts. Returns null for other strings. */
export function parseSolarman(connection: string): { host: string; port: number; serial: number } | null {
  const m = /^solarman:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/(\d{1,10})$/i.exec(connection.trim());
  if (!m) return null;
  const serial = Number(m[3]);
  if (serial > 0xffffffff) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : SOLARMAN_PORT, serial };
}

export const solarmanConnection = (host: string, serial: number | string, port = SOLARMAN_PORT) =>
  `solarman://${host}${port === SOLARMAN_PORT ? '' : `:${port}`}/${serial}`;

/** One TCP session with a logger. Callers serialise requests (ModbusConnection does). */
export class SolarmanClient {
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private sequence = Math.floor(Math.random() * 0xff);
  private pending: { seq: number; resolve: (p: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  readonly host: string;
  readonly port: number;
  readonly serial: number;
  timeoutMs: number;

  constructor(opts: { host: string; port?: number; serial: number; timeoutMs?: number }) {
    this.host = opts.host;
    this.port = opts.port ?? SOLARMAN_PORT;
    this.serial = opts.serial;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  get isOpen() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new Socket();
      const fail = (err: Error) => {
        s.destroy();
        reject(err);
      };
      s.setTimeout(this.timeoutMs, () => fail(new Error(`Timed out connecting to logger ${this.host}:${this.port}`)));
      s.once('error', fail);
      s.connect(this.port, this.host, () => {
        s.setTimeout(0);
        s.off('error', fail);
        s.setKeepAlive(true, 30_000);
        s.on('error', (err) => this.failPending(err));
        s.on('close', () => this.failPending(new Error('Logger closed the connection')));
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
    const { frames, rest } = splitFrames(Buffer.concat([this.buf, d]));
    this.buf = rest.length > 4096 ? Buffer.alloc(0) : rest;
    for (const f of frames) {
      const p = this.pending;
      if (!p || f.control !== CONTROL_RESPONSE || (f.sequence & 0xff) !== (p.seq & 0xff)) continue;
      this.pending = null;
      clearTimeout(p.timer);
      try {
        p.resolve(modbusFromResponse(f.payload));
      } catch (err) {
        p.reject(err as Error);
      }
    }
  }

  /** Sends one Modbus RTU frame and returns the inverter's RTU reply. */
  exchange(modbus: Uint8Array): Promise<Buffer> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Logger connection is not open'));
    if (this.pending) return Promise.reject(new Error('Request already in flight'));
    this.sequence = (this.sequence + 1) & 0xff;
    const seq = this.sequence;
    const frame = encodeRequest(this.serial, seq, modbus);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.seq === seq) this.pending = null;
        reject(new Error(`No reply from logger ${this.host} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending = { seq, resolve, reject, timer };
      this.socket!.write(frame);
    });
  }

  async read(unit: number, fn: 3 | 4, start: number, count: number): Promise<number[]> {
    const req = readRequest(unit, fn, start, count);
    return parseReply(req, await this.exchange(req));
  }

  async write(unit: number, start: number, values: number[], multiple: boolean): Promise<void> {
    const req = writeRequest(unit, start, values, multiple);
    parseReply(req, await this.exchange(req));
  }
}

export interface FoundLogger {
  ip: string;
  mac: string;
  serial: string;
  connection: string;
}

/** Parses a discovery answer "ip,mac,serial". Exported for tests. */
export function parseDiscoveryReply(text: string): FoundLogger | null {
  const [ip, mac, serial] = text.trim().split(',');
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !serial || !/^\d{1,10}$/.test(serial)) return null;
  return { ip, mac: mac ?? '', serial, connection: solarmanConnection(ip, serial) };
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const a of Object.values(networkInterfaces()).flat()) {
    if (!a || a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number);
    const mask = a.netmask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mask[i] & 0xff)) & 0xff).join('.'));
  }
  return [...out];
}

/** Broadcasts a discovery request and collects answers for `waitMs`. */
export function discoverLoggers(waitMs = 2000, targets = broadcastAddresses(), port = DISCOVERY_PORT): Promise<FoundLogger[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundLogger>();
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        s.close();
      } catch {}
      resolve([...found.values()]);
    };
    s.on('error', done);
    s.on('message', (msg) => {
      const f = parseDiscoveryReply(msg.toString());
      if (f) found.set(f.serial, f);
    });
    s.bind(0, () => {
      try {
        s.setBroadcast(true);
      } catch {}
      for (const t of targets) s.send('WIFIKIT-214028-READ', port, t, () => {});
      setTimeout(done, waitMs).unref();
    });
  });
}

/**
 * A fake logger for tests and the simulator: answers V5-wrapped Modbus from register maps, and
 * optionally pushes a heartbeat before each reply (as real loggers sometimes do).
 */
export function fakeLogger(opts: {
  serial: number;
  input?: Map<number, number>;
  holding?: Map<number, number>;
  heartbeat?: boolean;
}): Server {
  const maps = { input: opts.input ?? new Map(), holding: opts.holding ?? new Map() };
  return createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      const { frames, rest } = splitFrames(Buffer.concat([buf, d]));
      buf = rest;
      for (const f of frames) {
        if (f.control !== CONTROL_REQUEST || f.serial !== opts.serial) continue;
        const reply = serveRequest(f.payload.subarray(REQUEST_PREFIX), maps);
        if (opts.heartbeat) sock.write(responseFrame(0x4710, 0, opts.serial, Buffer.from([0])));
        const payload = Buffer.concat([Buffer.from([0x02, 0x01]), Buffer.alloc(12), reply]);
        sock.write(responseFrame(CONTROL_RESPONSE, f.sequence, opts.serial, payload));
      }
    });
  });
}

function responseFrame(control: number, sequence: number, serial: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(HEADER + payload.length + 2);
  frame[0] = 0xa5;
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(control, 3);
  frame.writeUInt16LE(sequence, 5);
  frame.writeUInt32LE(serial >>> 0, 7);
  payload.copy(frame, HEADER);
  frame[frame.length - 2] = checksum(frame, 1, frame.length - 2);
  frame[frame.length - 1] = 0x15;
  return frame;
}
