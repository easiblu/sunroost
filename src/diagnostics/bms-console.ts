/**
 * Serial BMS console (Pylontech-style ASCII-hex protocol): sends the "get analogue values"
 * command (CID1 0x46, CID2 0x42) with a chosen protocol version, address and INFO unit byte, and
 * returns the request, the raw reply and the reply body as bytes for the page's data decoder.
 */
import { buildFrame, checksum, CID1_BATTERY, CMD } from '../devices/bms/serial-ascii.ts';
import { openPort, releasePort, type DiagPort } from './port.ts';

/** Two hex digits (one byte), e.g. "20", "02", "FF". */
export function hexByte(v: unknown, name: string): number {
  const s = String(v ?? '').trim();
  if (!/^[0-9a-fA-F]{1,2}$/.test(s)) throw new Error(`${name} must be one hex byte (00–FF)`);
  return parseInt(s, 16);
}

export function analogRequest(protocol: number, address: number, unit: number): Buffer {
  return buildFrame(protocol, address, CID1_BATTERY, CMD.analog, Uint8Array.of(unit));
}

/**
 * Converts a reply frame "~<hex…><chk>\r" to the bytes of everything between SOI and CHKSUM
 * (VER, ADR, CID1, RTN, LENGTH×2, INFO…). Also reports whether the checksum matched.
 */
export function replyBytes(reply: string): { bytes: number[]; checksumOk: boolean | null } {
  const text = reply.replace(/[\r\n]+$/, '');
  if (!text.startsWith('~') || text.length < 6) return { bytes: [], checksumOk: null };
  const body = text.slice(1, -4);
  const clean = body.length % 2 ? body.slice(0, -1) : body;
  if (!/^[0-9A-Fa-f]*$/.test(clean)) return { bytes: [], checksumOk: null };
  const bytes = [...Buffer.from(clean, 'hex')];
  const chk = parseInt(text.slice(-4), 16);
  return { bytes, checksumOk: Number.isNaN(chk) ? null : checksum(body) === chk };
}

/** A plausible single-pack reply (15 cells, 5 temperatures) for the "Simulation" option. */
export function simulatedReply(protocol: number, address: number): Buffer {
  const cells = Array.from({ length: 15 }, (_, i) => 3300 + ((i * 7) % 20));
  const temps = [2981, 2971, 2976, 2976, 2986];
  const parts: number[] = [0x00, address, 15];
  for (const c of cells) parts.push(c >> 8, c & 0xff);
  parts.push(temps.length);
  for (const t of temps) parts.push(t >> 8, t & 0xff);
  const u16 = (v: number) => parts.push((v >> 8) & 0xff, v & 0xff);
  u16(0xff9c); // -10.0 A
  u16(49650); // 49.650 V
  u16(40000); // 40 Ah remaining
  parts.push(2); // user-defined items
  u16(50000); // 50 Ah total
  u16(16); // cycles
  return buildFrame(protocol, address, CID1_BATTERY, 0x00, Uint8Array.from(parts));
}

class BmsConsole {
  private port: DiagPort | null = null;
  private rx = '';
  private waiter: (() => void) | null = null;
  path = '';
  baud = 9600;
  timeoutMs = 2000;

  get connected() {
    return Boolean(this.port?.isOpen);
  }

  state() {
    return { connected: this.connected, path: this.path, baud: this.baud };
  }

  async connect(path: string, baud: number) {
    await this.disconnect();
    const port = await openPort(path, baud, 'BMS console');
    port.on('data', (chunk: Buffer) => {
      this.rx = (this.rx + chunk.toString('latin1')).slice(-8192);
      this.waiter?.();
    });
    this.port = port;
    this.path = path;
    this.baud = baud;
  }

  attach(port: DiagPort) {
    this.port = port;
    port.on('data', (chunk: Buffer) => {
      this.rx = (this.rx + chunk.toString('latin1')).slice(-8192);
      this.waiter?.();
    });
  }

  async disconnect() {
    const p = this.port;
    this.port = null;
    await releasePort(p);
  }

  /** Sends the analogue command and returns the reply text (up to and including CR). */
  async submit(protocol: number, address: number, unit: number, simulate = false) {
    const request = analogRequest(protocol, address, unit);
    let reply: string;
    if (simulate) reply = simulatedReply(protocol, address).toString('latin1');
    else {
      if (!this.port?.isOpen) throw new Error('Not connected');
      this.rx = '';
      const got = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve(this.rx);
        }, this.timeoutMs);
        this.waiter = () => {
          const start = this.rx.indexOf('~');
          const end = start >= 0 ? this.rx.indexOf('\r', start) : -1;
          if (end > start && start >= 0) {
            clearTimeout(timer);
            this.waiter = null;
            resolve(this.rx.slice(start, end + 1));
          }
        };
      });
      await this.port.write(request);
      reply = await got;
    }
    return { request: request.toString('latin1'), response: reply, ...replyBytes(reply) };
  }
}

export const bmsConsole = new BmsConsole();
export { BmsConsole };
