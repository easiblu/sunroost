/**
 * CAN frame sources' wire formats: candump log lines (SocketCAN) and the two USB-serial
 * analyser framings (CH340 at 2,000,000 baud).
 *
 * Waveshare USB-CAN-A, variable-length protocol:
 *   AA | type | id (2 bytes LE, or 4 for extended) | data (DLC bytes) | 55
 *   type = 0b11 << 6 | extended << 5 | remote << 4 | DLC
 *
 * Seeed Studio USB-CAN Analyzer, fixed 20-byte protocol [verify byte layout on hardware]:
 *   AA 55 | 01 | 01 std / 02 ext | 01 data / 02 remote | id (4 bytes LE) | DLC | 8 data bytes | 00 | checksum
 *   checksum = low byte of the sum of bytes 2..18
 *
 * Both adapters accept the same 20-byte settings command (AA 55 12|02 …), which sets the CAN
 * bitrate, the framing (0x12 variable, 0x02 fixed) and the CAN mode (2 = silent/listen-only).
 * Sending it only talks to the adapter over USB; nothing is transmitted on the CAN bus.
 */

export interface CanFrame {
  id: number;
  ext: boolean;
  rtr: boolean;
  data: Buffer;
}

// ---- candump -L --------------------------------------------------------------------------

/**
 * One `candump -L` log line: "(1436509052.249713) can0 351#1E02E803E8030302".
 * Extended IDs have 8 hex digits, remote frames "123#R", CAN FD "123##<flags><data>".
 */
export function parseCandumpLine(line: string): CanFrame | null {
  const m = /^\s*\(\d+(?:\.\d+)?\)\s+\S+\s+([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})#(#[0-9A-Fa-f])?(R\d*|[0-9A-Fa-f.]*)\s*$/.exec(line);
  if (!m) return null;
  const ext = m[1].length === 8;
  const id = parseInt(m[1], 16);
  if (!ext && id > 0x7ff) return null;
  const payload = m[3];
  if (payload.startsWith('R')) return { id, ext, rtr: true, data: Buffer.alloc(0) };
  const hexData = payload.replace(/\./g, '');
  if (hexData.length % 2) return null;
  return { id, ext, rtr: false, data: Buffer.from(hexData, 'hex') };
}

// ---- USB-serial analysers ----------------------------------------------------------------

export type SerialFraming = 'waveshare' | 'seeed' | 'any';

export const ADAPTER_SERIAL_BAUD = 2_000_000;

/** CAN bitrate → the adapters' speed code. */
const SPEED_CODES: Record<number, number> = {
  1_000_000: 0x01, 800_000: 0x02, 500_000: 0x03, 400_000: 0x04, 250_000: 0x05, 200_000: 0x06,
  125_000: 0x07, 100_000: 0x08, 50_000: 0x09, 20_000: 0x0a, 10_000: 0x0b, 5_000: 0x0c,
};

export const isCanBitrate = (n: number) => n in SPEED_CODES;

const sumBytes = (b: Uint8Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i];
  return s & 0xff;
};

/**
 * The 20-byte adapter settings command. `variable` selects Waveshare's variable-length
 * framing (0x12) rather than the fixed 20-byte one (0x02). Accepts all standard IDs
 * (filter/mask 0) and, with `listenOnly`, puts the controller in silent mode so it never
 * drives the bus (not even ACKs).
 */
export function adapterConfigFrame(opts: { variable: boolean; bitrate: number; listenOnly: boolean }): Buffer {
  const speed = SPEED_CODES[opts.bitrate];
  if (speed === undefined) throw new Error(`Unsupported CAN bitrate ${opts.bitrate}`);
  const b = Buffer.alloc(20);
  b[0] = 0xaa;
  b[1] = 0x55;
  b[2] = opts.variable ? 0x12 : 0x02;
  b[3] = speed;
  b[4] = 0x01; // standard (11-bit) frames
  // 5..8 filter id, 9..12 mask id: zero = accept everything
  b[13] = opts.listenOnly ? 0x02 : 0x00; // 0 normal, 1 loopback, 2 silent, 3 loopback+silent
  b[14] = 0x01; // [verify] "auto retransmit"; irrelevant in silent mode
  b[19] = sumBytes(b, 2, 19);
  return b;
}

/** Result of looking at the head of the buffer: a frame, bytes to skip, or "need more". */
type Step = { frame: CanFrame; used: number } | { skip: number } | null;

function waveshareStep(buf: Buffer): Step {
  if (buf.length < 2) return null;
  const type = buf[1];
  if ((type & 0xc0) !== 0xc0) return { skip: 1 };
  const dlc = type & 0x0f;
  if (dlc > 8) return { skip: 1 };
  const ext = Boolean(type & 0x20);
  const idLen = ext ? 4 : 2;
  const len = 2 + idLen + dlc + 1;
  if (buf.length < len) return null;
  if (buf[len - 1] !== 0x55) return { skip: 1 };
  const id = ext ? buf.readUInt32LE(2) & 0x1fffffff : buf.readUInt16LE(2);
  if (!ext && id > 0x7ff) return { skip: 1 };
  const rtr = Boolean(type & 0x10);
  return { frame: { id, ext, rtr, data: Buffer.from(buf.subarray(2 + idLen, 2 + idLen + dlc)) }, used: len };
}

function seeedStep(buf: Buffer): Step {
  if (buf.length < 2) return null;
  if (buf[1] !== 0x55) return { skip: 1 };
  if (buf.length < 3) return null;
  if (buf[2] !== 0x01) return { skip: 1 };
  if (buf.length < 20) return null;
  const kind = buf[3];
  const format = buf[4];
  const dlc = buf[9];
  if ((kind !== 1 && kind !== 2) || (format !== 1 && format !== 2) || dlc > 8) return { skip: 1 };
  if (sumBytes(buf, 2, 19) !== buf[19]) return { skip: 1 };
  const ext = kind === 2;
  const id = buf.readUInt32LE(5) & (ext ? 0x1fffffff : 0x7ff);
  return { frame: { id, ext, rtr: format === 2, data: Buffer.from(buf.subarray(10, 10 + dlc)) }, used: 20 };
}

/**
 * Incremental decoder for the serial analysers' byte stream. Resynchronises on garbage by
 * dropping one byte at a time until a frame validates (end byte / checksum). With 'any'
 * both framings are accepted; they can't be confused because a Waveshare type byte always
 * has its two top bits set, so it is never 0x55.
 */
export class SerialCanDecoder {
  private buf = Buffer.alloc(0);
  framing: SerialFraming;

  constructor(framing: SerialFraming = 'any') {
    this.framing = framing;
  }

  push(chunk: Buffer): CanFrame[] {
    this.buf = this.buf.length > 4096 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const out: CanFrame[] = [];
    for (;;) {
      const at = this.buf.indexOf(0xaa);
      if (at < 0) {
        this.buf = Buffer.alloc(0);
        break;
      }
      if (at > 0) this.buf = this.buf.subarray(at);
      const step = this.step();
      if (!step) break;
      if ('skip' in step) {
        this.buf = this.buf.subarray(step.skip);
        continue;
      }
      out.push(step.frame);
      this.buf = this.buf.subarray(step.used);
    }
    return out;
  }

  private step(): Step {
    const b = this.buf;
    if (this.framing === 'waveshare') return waveshareStep(b);
    if (this.framing === 'seeed') return seeedStep(b);
    if (b.length < 2) return null;
    return b[1] === 0x55 ? seeedStep(b) : waveshareStep(b);
  }
}

/** Encodes a frame in Waveshare variable-length framing (tests and loopback tools). */
export function encodeWaveshare(f: CanFrame): Buffer {
  const idLen = f.ext ? 4 : 2;
  const b = Buffer.alloc(2 + idLen + f.data.length + 1);
  b[0] = 0xaa;
  b[1] = 0xc0 | (f.ext ? 0x20 : 0) | (f.rtr ? 0x10 : 0) | f.data.length;
  if (f.ext) b.writeUInt32LE(f.id, 2);
  else b.writeUInt16LE(f.id, 2);
  f.data.copy(b, 2 + idLen);
  b[b.length - 1] = 0x55;
  return b;
}

/** Encodes a frame in Seeed fixed 20-byte framing (tests and loopback tools). */
export function encodeSeeed(f: CanFrame): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0xaa;
  b[1] = 0x55;
  b[2] = 0x01;
  b[3] = f.ext ? 2 : 1;
  b[4] = f.rtr ? 2 : 1;
  b.writeUInt32LE(f.id, 5);
  b[9] = f.data.length;
  f.data.copy(b, 10);
  b[19] = sumBytes(b, 2, 19);
  return b;
}
