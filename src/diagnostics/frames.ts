/**
 * Byte-string helpers for the diagnostic consoles: Modbus RTU CRC, frame type detection
 * (Modbus RTU / Voltronic / plain string), hex <-> bytes, and a silence-based frame splitter.
 */
import { voltronicCrc, crc16 as xmodem } from '../devices/inverters/voltronic/protocol.ts';

/** CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF). */
export function crcModbus(data: Uint8Array, end = data.length): number {
  let crc = 0xffff;
  for (let i = 0; i < end; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

/** Appends the little-endian Modbus CRC. */
export function withModbusCrc(body: Uint8Array): Buffer {
  const crc = crcModbus(body);
  return Buffer.concat([Buffer.from(body), Buffer.from([crc & 0xff, crc >> 8])]);
}

export function modbusCrcOk(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const crc = crcModbus(frame, frame.length - 2);
  return frame[frame.length - 2] === (crc & 0xff) && frame[frame.length - 1] === crc >> 8;
}

export interface ModbusInfo {
  type: 'modbus';
  address: number;
  fn: number;
  /** Request: first register; null for replies. */
  register: number | null;
  /** Request: register count (limit); reply: byte count for reads. */
  count: number | null;
  /** 'request' | 'response' | 'exception' (best guess from the shape). */
  kind: 'request' | 'response' | 'exception';
  /** Read replies: the register values. */
  values?: number[];
  /** Exception code for exception replies. */
  exception?: number;
}
export interface VoltronicInfo {
  type: 'voltronic';
  /** Text without "(" / CRC / CR. */
  text: string;
  reply: boolean;
}
export interface StringInfo {
  type: 'string';
  text: string;
}
export type FrameInfo = ModbusInfo | VoltronicInfo | StringInfo;

/** Decodes a Modbus RTU frame with a valid CRC; null otherwise. */
export function decodeModbus(f: Uint8Array): ModbusInfo | null {
  if (!modbusCrcOk(f)) return null;
  const address = f[0];
  const fn = f[1];
  const n = f.length;
  const u16 = (i: number) => (f[i] << 8) | f[i + 1];
  if (fn & 0x80) {
    if (n === 5) return { type: 'modbus', address, fn: fn & 0x7f, register: null, count: null, kind: 'exception', exception: f[2] };
    return null;
  }
  // Read request: addr fn reg(2) count(2) crc(2) = 8 bytes
  if ((fn === 3 || fn === 4 || fn === 1 || fn === 2) && n === 8) {
    return { type: 'modbus', address, fn, register: u16(2), count: u16(4), kind: 'request' };
  }
  // Read reply: addr fn bytecount data crc
  if ((fn === 3 || fn === 4) && n === f[2] + 5 && f[2] % 2 === 0) {
    const values = [];
    for (let i = 0; i < f[2] / 2; i++) values.push(u16(3 + i * 2));
    return { type: 'modbus', address, fn, register: null, count: values.length, kind: 'response', values };
  }
  // Write single register (request and echo reply are identical)
  if ((fn === 6 || fn === 5) && n === 8) return { type: 'modbus', address, fn, register: u16(2), count: 1, kind: 'request', values: [u16(4)] };
  // Write multiple: request addr fn reg cnt bytes data crc; reply addr fn reg cnt crc
  if (fn === 16 && n === 8) return { type: 'modbus', address, fn, register: u16(2), count: u16(4), kind: 'response' };
  if (fn === 16 && n >= 9 && n === f[6] + 9) {
    const values = [];
    for (let i = 0; i < f[6] / 2; i++) values.push(u16(7 + i * 2));
    return { type: 'modbus', address, fn, register: u16(2), count: u16(4), kind: 'request', values };
  }
  return { type: 'modbus', address, fn, register: n >= 6 ? u16(2) : null, count: n >= 8 ? u16(4) : null, kind: 'request' };
}

/** Voltronic frame: CR-terminated with a valid CRC before the CR (request or "(" reply). */
export function decodeVoltronic(f: Uint8Array): VoltronicInfo | null {
  if (f.length < 4 || f[f.length - 1] !== 0x0d) return null;
  const body = f.subarray(0, f.length - 3);
  const got = (f[f.length - 3] << 8) | f[f.length - 2];
  if (voltronicCrc(body) !== got && xmodem(body) !== got) return null;
  const reply = body[0] === 0x28;
  return { type: 'voltronic', text: Buffer.from(reply ? body.subarray(1) : body).toString('latin1'), reply };
}

export function detect(f: Uint8Array): FrameInfo {
  return decodeVoltronic(f) ?? decodeModbus(f) ?? { type: 'string', text: printable(f) };
}

/** Bytes as text with non-printables escaped (\r, \n, \xNN). */
export function printable(f: Uint8Array): string {
  let s = '';
  for (const b of f) {
    if (b === 0x0d) s += '\\r';
    else if (b === 0x0a) s += '\\n';
    else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
    else s += '\\x' + b.toString(16).padStart(2, '0');
  }
  return s;
}

/** One-line human summary of a frame, e.g. "MODBUS 3 0 10" or "VOLTRONIC QPIGS". */
export function describe(f: Uint8Array): string {
  const info = detect(f);
  if (info.type === 'voltronic') return `VOLTRONIC ${info.reply ? '(' : ''}${info.text}`;
  if (info.type === 'modbus') {
    if (info.kind === 'exception') return `MODBUS ${info.fn} exception ${info.exception}`;
    if (info.kind === 'response' && info.values && info.register === null) return `MODBUS ${info.fn} reply ${info.values.join(' ')}`;
    return `MODBUS ${info.fn} ${info.register ?? ''} ${info.count ?? ''}`.trim();
  }
  return info.text;
}

export const toHex = (f: Uint8Array) => Buffer.from(f).toString('hex').toUpperCase();

/** Parses "01 03 00 00", "0x01,0x03" or "010300" into bytes. Throws on odd/invalid input. */
export function parseHex(text: string): Buffer {
  const clean = text.replace(/0x/gi, '').replace(/[\s,:;-]+/g, '');
  if (!clean || clean.length % 2 || !/^[0-9a-fA-F]+$/.test(clean)) throw new Error('Invalid hex data');
  return Buffer.from(clean, 'hex');
}

/** Text with escapes \r \n \t \xNN. */
export function parseText(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === 'r') { out.push(13); i++; continue; }
      if (n === 'n') { out.push(10); i++; continue; }
      if (n === 't') { out.push(9); i++; continue; }
      if (n === '\\') { out.push(92); i++; continue; }
      if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
        out.push(parseInt(text.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
    }
    out.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/**
 * Groups incoming chunks into frames: a frame ends after `ms` of silence. `flush()` emits what's
 * pending immediately. The timer is unref'd so it never keeps the process alive.
 */
export class Splitter {
  ms: number;
  private buf: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly onFrame: (frame: Buffer) => void;

  constructor(ms: number, onFrame: (frame: Buffer) => void) {
    this.ms = ms;
    this.onFrame = onFrame;
  }

  push(chunk: Buffer) {
    this.buf.push(chunk);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(1, this.ms));
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf.length) return;
    const frame = Buffer.concat(this.buf);
    this.buf = [];
    if (frame.length) this.onFrame(frame);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buf = [];
  }
}
