/**
 * Modbus RTU frames as bytes, for transports that carry them inside another envelope (Solarman V5
 * WiFi loggers) where modbus-serial can't be used. Pure functions: build requests, parse replies.
 *
 * Supported functions: 3 (read holding), 4 (read input), 6 (write single), 16 (write multiple).
 */

/** Modbus CRC-16 (poly 0xA001, init 0xFFFF); goes on the wire low byte first. */
export function modbusCrc(data: Uint8Array, from = 0, to = data.length): number {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function withCrc(body: Buffer): Buffer {
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(modbusCrc(body));
  return Buffer.concat([body, crc]);
}

export function readRequest(unit: number, fn: 3 | 4, start: number, count: number): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(unit, 0);
  b.writeUInt8(fn, 1);
  b.writeUInt16BE(start, 2);
  b.writeUInt16BE(count, 4);
  return withCrc(b);
}

export function writeRequest(unit: number, start: number, values: number[], multiple: boolean): Buffer {
  if (values.length === 1 && !multiple) {
    const b = Buffer.alloc(6);
    b.writeUInt8(unit, 0);
    b.writeUInt8(6, 1);
    b.writeUInt16BE(start, 2);
    b.writeUInt16BE(values[0], 4);
    return withCrc(b);
  }
  const b = Buffer.alloc(7 + values.length * 2);
  b.writeUInt8(unit, 0);
  b.writeUInt8(16, 1);
  b.writeUInt16BE(start, 2);
  b.writeUInt16BE(values.length, 4);
  b.writeUInt8(values.length * 2, 6);
  values.forEach((v, i) => b.writeUInt16BE(v, 7 + i * 2));
  return withCrc(b);
}

const EXCEPTIONS: Record<number, string> = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'slave device failure',
  6: 'slave device busy',
};

/**
 * Parses a reply to `request`. The reply's length is taken from its own header, so trailing bytes
 * (some loggers pad frames) are ignored. Throws on a bad CRC, a Modbus exception or a mismatch.
 * Returns the registers for reads, [] for writes.
 */
export function parseReply(request: Uint8Array, reply: Uint8Array): number[] {
  const buf = Buffer.from(reply);
  const unit = request[0];
  const fn = request[1];
  if (buf.length < 5) throw new Error('Modbus reply too short');
  if (buf[0] !== unit) throw new Error(`Modbus reply from unit ${buf[0]}, expected ${unit}`);
  if (buf[1] === (fn | 0x80)) {
    if (modbusCrc(buf, 0, 3) !== buf.readUInt16LE(3)) throw new Error('Modbus reply CRC error');
    throw new Error(`Modbus exception: ${EXCEPTIONS[buf[2]] ?? `code ${buf[2]}`}`);
  }
  if (buf[1] !== fn) throw new Error(`Modbus reply function ${buf[1]}, expected ${fn}`);
  const len = fn === 3 || fn === 4 ? 3 + buf[2] : 6;
  if (buf.length < len + 2) throw new Error('Modbus reply truncated');
  if (modbusCrc(buf, 0, len) !== buf.readUInt16LE(len)) throw new Error('Modbus reply CRC error');
  if (fn === 3 || fn === 4) {
    const want = Buffer.from(request).readUInt16BE(4);
    if (buf[2] !== want * 2) throw new Error(`Modbus reply has ${buf[2] / 2} registers, expected ${want}`);
    const out: number[] = [];
    for (let i = 0; i < want; i++) out.push(buf.readUInt16BE(3 + i * 2));
    return out;
  }
  return [];
}

/**
 * Answers one request from a register map (for tests and simulators). Unknown registers read 0;
 * `holding` is updated by writes.
 */
export function serveRequest(req: Uint8Array, maps: { input: Map<number, number>; holding: Map<number, number> }): Buffer {
  const b = Buffer.from(req);
  const unit = b[0];
  const fn = b[1];
  const start = b.readUInt16BE(2);
  if (fn === 3 || fn === 4) {
    const count = b.readUInt16BE(4);
    const m = fn === 3 ? maps.holding : maps.input;
    const out = Buffer.alloc(3 + count * 2);
    out[0] = unit;
    out[1] = fn;
    out[2] = count * 2;
    for (let i = 0; i < count; i++) out.writeUInt16BE(m.get(start + i) ?? 0, 3 + i * 2);
    return withCrc(out);
  }
  if (fn === 6) {
    maps.holding.set(start, b.readUInt16BE(4));
    return withCrc(b.subarray(0, 6));
  }
  if (fn === 16) {
    const count = b.readUInt16BE(4);
    for (let i = 0; i < count; i++) maps.holding.set(start + i, b.readUInt16BE(7 + i * 2));
    return withCrc(b.subarray(0, 6));
  }
  return withCrc(Buffer.from([unit, fn | 0x80, 1]));
}
