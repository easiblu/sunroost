/**
 * JBD / Xiaoxiang ("smart BMS" app) UART/RS485 protocol, 9600 baud.
 *
 * Read request: DD | A5 | register | 00 | checksum (2) | 77
 * Reply:        DD | register | status (0 = OK) | length | data… | checksum (2) | 77
 * Checksum = 0x10000 − (sum of the bytes from register/status through the data).
 *
 * Register 0x03 basic info, 0x04 cell voltages (mV each), 0x05 hardware version (ASCII).
 */
import type { Metrics } from '../../core/metrics.ts';
import type { BmsDriverDescriptor } from '../types.ts';
import { MultiPortBms, bitNames, packMetrics, type PackReading, type PortReader } from './pack.ts';
import { lengthReader, serialLinkFactory, sum, type ByteLink, type LinkFactory } from './serial.ts';

export const REG = { basic: 0x03, cells: 0x04, version: 0x05 } as const;
const TIMEOUT_MS = 1000;

const check16 = (bytes: Uint8Array, from: number, to: number) => (0x10000 - sum(bytes, from, to)) & 0xffff;

export function buildRead(register: number): Buffer {
  const b = Buffer.from([0xdd, 0xa5, register, 0x00, 0, 0, 0x77]);
  b.writeUInt16BE(check16(b, 2, 4), 4);
  return b;
}

/** Validates a reply for `register` and returns its data. */
export function replyData(frame: Buffer, register: number): Buffer {
  if (frame.length < 7 || frame[0] !== 0xdd || frame[frame.length - 1] !== 0x77) throw new Error('JBD: bad frame');
  const len = frame[3];
  if (frame.length !== len + 7) throw new Error('JBD: length mismatch');
  if (check16(frame, 2, 4 + len) !== frame.readUInt16BE(4 + len)) throw new Error('JBD: checksum mismatch');
  if (frame[1] !== register) throw new Error(`JBD: unexpected register 0x${frame[1].toString(16)}`);
  if (frame[2] !== 0) throw new Error(`JBD: error status 0x${frame[2].toString(16)}`);
  return frame.subarray(4, 4 + len);
}

const PROTECTION = [
  'Cell over voltage',
  'Cell under voltage',
  'Pack over voltage',
  'Pack under voltage',
  'Charge over temperature',
  'Charge under temperature',
  'Discharge over temperature',
  'Discharge under temperature',
  'Charge over current',
  'Discharge over current',
  'Short circuit',
  'Front-end IC error',
  'MOS software lock',
];

/**
 * 0x03: voltage 10 mV, current 10 mA (signed, + = charging), remaining 10 mAh, nominal
 * 10 mAh, cycles, production date, balance bits (4 bytes), protection bits, software
 * version, RSOC %, FET bits, cell count, NTC count, NTC temperatures (0.1 K each).
 */
export function parseBasic(d: Buffer) {
  if (d.length < 23) throw new Error('JBD: basic info too short');
  const nNtc = d[22];
  const temps: number[] = [];
  for (let i = 0; i < nNtc && 23 + i * 2 + 2 <= d.length; i++) temps.push((d.readUInt16BE(23 + i * 2) - 2731) / 10);
  const date = d.readUInt16BE(10);
  return {
    voltage: d.readUInt16BE(0) / 100,
    current: d.readInt16BE(2) / 100,
    remainingAh: d.readUInt16BE(4) / 100,
    nominalAh: d.readUInt16BE(6) / 100,
    cycles: d.readUInt16BE(8),
    productionDate: `${2000 + (date >> 9)}-${String((date >> 5) & 0xf).padStart(2, '0')}-${String(date & 0x1f).padStart(2, '0')}`,
    protection: d.readUInt16BE(16),
    firmware: `${d[18] >> 4}.${d[18] & 0xf}`,
    soc: d[19],
    chargeFet: Boolean(d[20] & 1),
    dischargeFet: Boolean(d[20] & 2),
    cellCount: d[21],
    temps,
  };
}

export function parseCells(d: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) out.push(d.readUInt16BE(i) / 1000);
  return out;
}

export function jbdReading(b: ReturnType<typeof parseBasic>, cells?: number[], model?: string): PackReading {
  const alarms = bitNames(b.protection, PROTECTION);
  return {
    soc: b.soc,
    voltage: b.voltage,
    current: b.current,
    temperatures: b.temps,
    cells,
    cycles: b.cycles,
    remainingAh: b.remainingAh,
    fullAh: b.nominalAh,
    designAh: b.nominalAh,
    alarms,
    model,
    firmware: b.firmware,
  };
}

export const frameReader = lengthReader([0xdd], 4, (h) => h[3] + 7);

export class JbdPort implements PortReader {
  private link: ByteLink;
  private model: string | undefined;
  constructor(link: ByteLink) {
    this.link = link;
  }

  private async query(register: number) {
    return replyData(await this.link.request(buildRead(register), frameReader, { timeoutMs: TIMEOUT_MS }), register);
  }

  async init() {
    try {
      this.model = (await this.query(REG.version)).toString('latin1').replace(/\0/g, '').trim() || undefined;
    } catch {}
  }

  async read(): Promise<(Metrics | undefined)[]> {
    const basic = parseBasic(await this.query(REG.basic));
    let cells: number[] | undefined;
    try {
      cells = parseCells(await this.query(REG.cells));
    } catch {}
    return [packMetrics(jbdReading(basic, cells, this.model))];
  }
}

export function createJbd(connections: string[], baudRate: number, factory: LinkFactory = serialLinkFactory) {
  return new MultiPortBms(connections, baudRate, factory, (link) => new JbdPort(link));
}

export const jbd: BmsDriverDescriptor = {
  id: 'jbd',
  name: 'USB JBD RS485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: true,
  create: ({ connections, baudRate }) => createJbd(connections, baudRate),
};
