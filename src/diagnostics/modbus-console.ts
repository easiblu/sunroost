/**
 * Standalone Modbus console connection ("Modbus connection" card): one persistent RTU or TCP link
 * the user connects and disconnects explicitly, then queries with any address/function/start/limit.
 *
 * RTU builds the frame with its CRC, writes it and reads until the reply is complete (computed
 * length) or the line has been silent; TCP wraps the PDU in an MBAP header. Every exchange is
 * logged as "Send:" / "Receive:".
 */
import { Socket } from 'node:net';
import { RingLog } from './bus.ts';
import { decodeModbus, describe, toHex, withModbusCrc } from './frames.ts';
import { openPort, releasePort, type DiagPort } from './port.ts';

export interface ConsoleTarget {
  type: 'rtu' | 'tcp';
  path?: string;
  baud?: number;
  host?: string;
  port?: number;
}

export interface QueryResult {
  registers: number[];
  raw: string;
}

/** Builds a read request PDU (fn, start, count). */
export function readPdu(fn: number, start: number, count: number): Buffer {
  const pdu = Buffer.alloc(5);
  pdu[0] = fn;
  pdu.writeUInt16BE(start, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** Parses a read reply PDU (fn, bytecount, data…) into registers; throws on exceptions. */
export function parseReadPdu(fn: number, pdu: Buffer): number[] {
  if (pdu.length >= 2 && pdu[0] === (fn | 0x80)) throw new Error(`Modbus exception ${pdu[1]}`);
  if (pdu[0] !== fn || pdu.length < 2 || pdu.length < 2 + pdu[1]) throw new Error('Read error: malformed reply');
  const out: number[] = [];
  for (let i = 0; i < pdu[1] / 2; i++) out.push(pdu.readUInt16BE(2 + i * 2));
  return out;
}

export class ModbusConsole {
  target: ConsoleTarget | null = null;
  private serial: DiagPort | null = null;
  private socket: Socket | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private onRx: (() => void) | null = null;
  private tid = 0;
  private busy: Promise<unknown> = Promise.resolve();
  timeoutMs = 2000;
  readonly log: RingLog;

  constructor() {
    this.log = new RingLog(200, () => {});
  }

  get connected() {
    return Boolean(this.serial?.isOpen || (this.socket && !this.socket.destroyed && this.socket.readyState === 'open'));
  }

  state() {
    return { connected: this.connected, target: this.target, log: this.log.entries.slice(-50) };
  }

  private feed = (chunk: Buffer) => {
    this.rx = Buffer.concat([this.rx, chunk]).subarray(-4096);
    this.onRx?.();
  };

  async connect(t: ConsoleTarget) {
    await this.disconnect();
    if (t.type === 'tcp') {
      const host = String(t.host ?? '').trim();
      if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('Enter an IP address or host name');
      const port = t.port ?? 502;
      const sock = new Socket();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error(`Could not connect to ${host}:${port}`));
        }, 5000);
        sock.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        sock.connect(port, host, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      sock.on('error', () => {});
      sock.on('data', this.feed);
      this.socket = sock;
      this.target = { type: 'tcp', host, port };
    } else {
      const port = await openPort(String(t.path ?? ''), t.baud ?? 9600, 'Modbus console');
      port.on('data', this.feed);
      this.serial = port;
      this.target = { type: 'rtu', path: port.path, baud: t.baud ?? 9600 };
    }
    this.log.add({ side: 'console', dir: 'info', hex: '', text: `Connected ${this.describeTarget()}` });
  }

  /** Attaches an in-memory port as an RTU link (tests). */
  attach(port: DiagPort) {
    this.serial = port;
    port.on('data', this.feed);
    this.target = { type: 'rtu', path: port.path, baud: 9600 };
  }

  describeTarget() {
    const t = this.target;
    if (!t) return '';
    return t.type === 'tcp' ? `${t.host}:${t.port}` : `${t.path} @ ${t.baud}`;
  }

  async disconnect() {
    const s = this.serial;
    const sock = this.socket;
    this.serial = null;
    this.socket = null;
    if (s) await releasePort(s);
    if (sock) sock.destroy();
    if (s || sock) this.log.add({ side: 'console', dir: 'info', hex: '', text: 'Disconnected' });
  }

  /** Reads `count` registers. Serialised: one exchange at a time. */
  query(address: number, fn: number, start: number, count: number): Promise<QueryResult> {
    const run = this.busy.then(() => this.exchange(address, fn, start, count));
    this.busy = run.catch(() => {});
    return run;
  }

  private async exchange(address: number, fn: number, start: number, count: number): Promise<QueryResult> {
    if (!this.connected) throw new Error('Not connected');
    const pdu = readPdu(fn, start, count);
    this.rx = Buffer.alloc(0);
    let request: Buffer;
    if (this.socket) {
      const tid = (this.tid = (this.tid + 1) & 0xffff);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(tid, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = address;
      request = Buffer.concat([head, pdu]);
    } else {
      request = withModbusCrc(Buffer.concat([Buffer.from([address]), pdu]));
    }
    this.log.add({ side: 'console', dir: 'tx', hex: toHex(request), text: `Send: ${toHex(request)}` });
    try {
      if (this.socket) await new Promise<void>((res, rej) => this.socket!.write(request, (e) => (e ? rej(e) : res())));
      else await this.serial!.write(request);
    } catch (err) {
      throw new Error(`Write error: ${(err as Error).message}`);
    }
    const reply = await this.awaitReply(fn, Boolean(this.socket));
    this.log.add({ side: 'console', dir: 'rx', hex: toHex(reply), text: `Receive: ${toHex(reply)}` });
    let replyPdu: Buffer;
    if (this.socket) replyPdu = reply.subarray(7);
    else {
      const info = decodeModbus(reply);
      if (!info) throw new Error(`Read error: bad CRC or frame (${describe(reply)})`);
      replyPdu = reply.subarray(1, reply.length - 2);
    }
    return { registers: parseReadPdu(fn, replyPdu), raw: toHex(reply) };
  }

  /** Waits for a complete reply (length known from the header), else for silence after data. */
  private awaitReply(fn: number, tcp: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let idle: NodeJS.Timeout | null = null;
      const done = (err: Error | null, v?: Buffer) => {
        clearTimeout(timeout);
        if (idle) clearTimeout(idle);
        this.onRx = null;
        if (err) reject(err);
        else resolve(v!);
      };
      const timeout = setTimeout(() => (this.rx.length ? done(null, this.rx) : done(new Error('No response'))), this.timeoutMs);
      const check = () => {
        const b = this.rx;
        let need = 0;
        if (tcp) need = b.length >= 6 ? 6 + b.readUInt16BE(4) : 0;
        else if (b.length >= 2 && b[1] & 0x80) need = 5;
        else if (b.length >= 3 && b[1] === fn) need = 5 + b[2];
        if (need && b.length >= need) return done(null, b.subarray(0, need));
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => this.rx.length && done(null, this.rx), 100);
      };
      this.onRx = check;
    });
  }
}

export const modbusConsole = new ModbusConsole();
