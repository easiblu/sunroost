/**
 * Daly smart BMS, UART/RS485 "PC" protocol at 9600 baud.
 *
 * Request: A5 | 40 (host address) | cmd | 08 | 8 data bytes (zero) | checksum
 * Reply:   A5 | 01 (BMS address)  | cmd | 08 | 8 data bytes        | checksum
 * Checksum = low byte of the sum of the 12 preceding bytes.
 *
 * 0x90 voltage (0.1 V) / current (0.1 A, offset 30000) / SOC (0.1 %)
 * 0x91 highest/lowest cell (mV + cell no)      0x92 highest/lowest temperature (+40 offset)
 * 0x93 state, charge/discharge MOS, life, remaining capacity (mAh)
 * 0x94 cell count, sensor count, charger/load state, DIO, cycles
 * 0x95 cell voltages: one 13-byte frame per 3 cells (frame no, 3 × mV)
 * 0x96 temperatures: one frame per 7 sensors (frame no, 7 × °C+40)
 * 0x98 alarm bit flags (7 bytes) + fault code
 * 0x50 rated capacity (mAh) + nominal cell voltage (mV)
 */
import type { Metrics } from '../../core/metrics.ts';
import type { BmsDriverDescriptor } from '../types.ts';
import { MultiPortBms, bitNames, packMetrics, type PackReading, type PortReader } from './pack.ts';
import { lengthReader, serialLinkFactory, sum, type ByteLink, type LinkFactory } from './serial.ts';

export const FRAME = 13;
const HOST = 0x40;
const TIMEOUT_MS = 600;

export function buildRequest(cmd: number): Buffer {
  const b = Buffer.alloc(FRAME);
  b[0] = 0xa5;
  b[1] = HOST;
  b[2] = cmd;
  b[3] = 0x08;
  b[12] = sum(b, 0, 12) & 0xff;
  return b;
}

/** Validates one reply frame for `cmd` and returns its 8 data bytes. */
export function frameData(frame: Buffer, cmd?: number): Buffer {
  if (frame.length !== FRAME || frame[0] !== 0xa5 || frame[3] !== 0x08) throw new Error('Daly: bad frame');
  if ((sum(frame, 0, 12) & 0xff) !== frame[12]) throw new Error('Daly: checksum mismatch');
  if (cmd !== undefined && frame[2] !== cmd) throw new Error(`Daly: unexpected command 0x${frame[2].toString(16)}`);
  return frame.subarray(4, 12);
}

/** Splits a multi-frame reply into valid frames' data, keyed by the frame number (byte 0). */
export function splitFrames(buf: Buffer, cmd: number): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (let i = 0; i + FRAME <= buf.length; ) {
    if (buf[i] !== 0xa5) {
      i++;
      continue;
    }
    try {
      const d = frameData(buf.subarray(i, i + FRAME), cmd);
      out.set(d[0], d);
      i += FRAME;
    } catch {
      i++;
    }
  }
  return out;
}

/** 0x95: three cells (mV) per frame, frames numbered from 1. Missing frames leave gaps. */
export function parseCells(frames: Map<number, Buffer>, count: number): number[] {
  const cells: number[] = [];
  for (let n = 0; n < count; n++) {
    const d = frames.get(Math.floor(n / 3) + 1);
    if (!d) continue;
    const mv = d.readUInt16BE(1 + (n % 3) * 2);
    if (mv > 0 && mv < 6000) cells[n] = mv / 1000;
  }
  return cells;
}

/** 0x96: seven temperatures (°C + 40) per frame, frames numbered from 1. */
export function parseTemps(frames: Map<number, Buffer>, count: number): number[] {
  const temps: number[] = [];
  for (let n = 0; n < count; n++) {
    const d = frames.get(Math.floor(n / 7) + 1);
    if (d) temps[n] = d[1 + (n % 7)] - 40;
  }
  return temps;
}

export function parseBasic(d: Buffer) {
  return {
    voltage: d.readUInt16BE(0) / 10,
    current: (d.readUInt16BE(4) - 30000) / 10,
    soc: d.readUInt16BE(6) / 10,
  };
}

export function parseMos(d: Buffer) {
  return {
    state: (['Idle', 'Charging', 'Discharging'] as const)[d[0]] ?? 'Idle',
    chargeMos: d[1] === 1,
    dischargeMos: d[2] === 1,
    life: d[3],
    remainingAh: d.readUInt32BE(4) / 1000,
  };
}

export function parseStatus(d: Buffer) {
  return { cells: d[0], temps: d[1], charger: d[2] === 1, load: d[3] === 1, cycles: d.readUInt16BE(5) };
}

const ALARMS: string[][] = [
  ['Cell voltage high', 'Cell voltage high (level 2)', 'Cell voltage low', 'Cell voltage low (level 2)',
    'Pack voltage high', 'Pack voltage high (level 2)', 'Pack voltage low', 'Pack voltage low (level 2)'],
  ['Charge temperature high', 'Charge temperature high (level 2)', 'Charge temperature low',
    'Charge temperature low (level 2)', 'Discharge temperature high', 'Discharge temperature high (level 2)',
    'Discharge temperature low', 'Discharge temperature low (level 2)'],
  ['Charge over current', 'Charge over current (level 2)', 'Discharge over current',
    'Discharge over current (level 2)', 'SOC high', 'SOC high (level 2)', 'SOC low', 'SOC low (level 2)'],
  ['Cell voltage difference', 'Cell voltage difference (level 2)', 'Temperature difference',
    'Temperature difference (level 2)'],
  ['Charge MOS over temperature', 'Discharge MOS over temperature', 'Charge MOS temperature sensor error',
    'Discharge MOS temperature sensor error', 'Charge MOS adhesion', 'Discharge MOS adhesion',
    'Charge MOS open circuit', 'Discharge MOS open circuit'],
  ['AFE chip error', 'Cell voltage sensor disconnected', 'Cell temperature sensor error', 'EEPROM error',
    'RTC error', 'Precharge failure', 'Communication failure', 'Internal communication failure'],
  ['Current module fault', 'Pack voltage sensor fault', 'Short circuit protection', 'Low voltage, charging forbidden'],
];

/** 0x98: 7 bytes of flags (byte i, bit j → ALARMS[i][j]) + a fault code byte. */
export function parseAlarms(d: Buffer): string[] {
  const out: string[] = [];
  ALARMS.forEach((names, i) => out.push(...bitNames(d[i], names)));
  if (d[7]) out.push(`Fault code ${d[7]}`);
  return out;
}

const single = lengthReader([0xa5], 4, () => FRAME);
const multi = (frames: number) => lengthReader([0xa5], 4, () => FRAME * frames);

export class DalyPort implements PortReader {
  private link: ByteLink;
  private ratedAh: number | undefined;
  constructor(link: ByteLink) {
    this.link = link;
  }

  private async query(cmd: number) {
    return frameData(await this.link.request(buildRequest(cmd), single, { timeoutMs: TIMEOUT_MS }), cmd);
  }

  private async queryFrames(cmd: number, frames: number) {
    const buf = await this.link.request(buildRequest(cmd), multi(frames), { timeoutMs: TIMEOUT_MS + frames * 50, partial: true });
    return splitFrames(buf, cmd);
  }

  async init() {
    try {
      const d = await this.query(0x50);
      const mah = d.readUInt32BE(0);
      if (mah > 0) this.ratedAh = mah / 1000;
    } catch {
      // older firmware: no rated-capacity command
    }
  }

  async read(): Promise<(Metrics | undefined)[]> {
    const basic = parseBasic(await this.query(0x90));
    const r: PackReading = { ...basic, designAh: this.ratedAh, fullAh: this.ratedAh };
    // Everything after 0x90 is optional: keep whatever answers.
    const opt = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    };
    let status: ReturnType<typeof parseStatus> | undefined;
    await opt(async () => {
      status = parseStatus(await this.query(0x94));
      r.cycles = status.cycles;
    });
    await opt(async () => {
      const mos = parseMos(await this.query(0x93));
      r.remainingAh = mos.remainingAh;
    });
    await opt(async () => {
      const d = await this.query(0x92);
      r.temperature = (d[0] - 40 + (d[2] - 40)) / 2;
    });
    if (status?.cells) {
      const n = status.cells;
      await opt(async () => {
        r.cells = parseCells(await this.queryFrames(0x95, Math.ceil(n / 3)), n);
      });
    }
    if (status?.temps) {
      const n = status.temps;
      await opt(async () => {
        const temps = parseTemps(await this.queryFrames(0x96, Math.ceil(n / 7)), n).filter((t) => t !== undefined);
        if (temps.length) {
          r.temperatures = temps;
          r.temperature = undefined; // average of the sensors instead of (max+min)/2
        }
      });
    }
    await opt(async () => {
      r.alarms = parseAlarms(await this.query(0x98));
    });
    return [packMetrics(r)];
  }
}

export function createDaly(connections: string[], baudRate: number, factory: LinkFactory = serialLinkFactory) {
  return new MultiPortBms(connections, baudRate, factory, (link) => new DalyPort(link));
}

export const daly: BmsDriverDescriptor = {
  id: 'daly',
  name: 'USB Daly UART/RS485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: true,
  create: ({ connections, baudRate }) => createDaly(connections, baudRate),
};
