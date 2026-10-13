/**
 * "USB Victron VE.Direct": Victron BMV-7xx battery monitors, SmartShunt and MPPT chargers via
 * the VE.Direct USB cable. Text protocol, 19200 8N1, sent unsolicited about once a second:
 *
 *   \r\n<label>\t<value> … \r\nChecksum\t<byte>
 *
 * A block is valid when the sum of all its bytes (from the \r\n before the first field up to
 * and including the checksum byte) is 0 mod 256. BMVs split their output in two blocks (live
 * values, then the H1…H18 history), each with its own checksum. Asynchronous hex-protocol
 * messages (":…\n") may be interleaved; they are skipped and not counted in the checksum.
 *
 * Units on the wire: V/VS/VM mV, I mA, P W, CE mAh, SOC ‰, DM ‰, TTG minutes (-1 = infinite),
 * T °C, H1–H3/H6 mAh, H7/H8/H15/H16 mV, H9 seconds, H17/H18 0.01 kWh.
 */
import type { Metrics } from '../../core/metrics.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';
import { serialRawPort, type RawPort, type RawPortFactory } from './can/sources.ts';
import { bitNames, packMetrics, round } from './pack.ts';

export type VeFields = Record<string, string>;

const S = { IDLE: 0, BEGIN: 1, NAME: 2, VALUE: 3, CHECKSUM: 4, HEX: 5 } as const;
type St = (typeof S)[keyof typeof S];
const MAX_TEXT = 64;

/** Byte-level VE.Direct text-protocol framer (after Victron's reference frame handler). */
export class VeDirectParser {
  private state: St = S.IDLE;
  private prev: St = S.IDLE;
  private checksum = 0;
  private name = '';
  private value = '';
  private fields: VeFields = {};
  /** Blocks dropped for a bad checksum (the first, partial block always is). */
  bad = 0;

  /** Feeds bytes; returns the fields of every block that completed with a valid checksum. */
  push(chunk: Uint8Array): VeFields[] {
    const out: VeFields[] = [];
    for (const byte of chunk) {
      if (byte === 0x3a && this.state !== S.CHECKSUM && this.state !== S.HEX) {
        this.prev = this.state;
        this.state = S.HEX;
      }
      if (this.state !== S.HEX) this.checksum = (this.checksum + byte) & 0xff;
      const ch = String.fromCharCode(byte);
      switch (this.state) {
        case S.IDLE:
          if (byte === 0x0a) this.state = S.BEGIN;
          break;
        case S.BEGIN:
          this.name = ch;
          this.state = S.NAME;
          break;
        case S.NAME:
          if (byte === 0x09) {
            if (this.name.toLowerCase() === 'checksum') this.state = S.CHECKSUM;
            else {
              this.value = '';
              this.state = S.VALUE;
            }
          } else if (this.name.length >= MAX_TEXT || byte === 0x0a) this.reset();
          else this.name += ch;
          break;
        case S.VALUE:
          if (byte === 0x0a) {
            this.fields[this.name] = this.value;
            this.state = S.BEGIN;
          } else if (byte !== 0x0d) {
            if (this.value.length >= MAX_TEXT) this.reset();
            else this.value += ch;
          }
          break;
        case S.CHECKSUM:
          if (this.checksum === 0 && Object.keys(this.fields).length) out.push(this.fields);
          else this.bad++;
          this.reset();
          break;
        case S.HEX:
          if (byte === 0x0a) this.state = this.prev;
          break;
      }
    }
    return out;
  }

  private reset() {
    this.state = S.IDLE;
    this.checksum = 0;
    this.fields = {};
  }
}

/** Builds a valid text block from fields (tests and simulators). */
export function encodeVeBlock(fields: [string, string][]): Buffer {
  const body = Buffer.from(fields.map(([k, v]) => `\r\n${k}\t${v}`).join('') + '\r\nChecksum\t', 'latin1');
  let s = 0;
  for (const b of body) s += b;
  return Buffer.concat([body, Buffer.from([(256 - (s & 0xff)) & 0xff])]);
}

const PRODUCTS: Record<number, string> = {
  0x0203: 'BMV-700', 0x0204: 'BMV-702', 0x0205: 'BMV-700H',
  0xa381: 'BMV-712 Smart', 0xa382: 'BMV-710H Smart', 0xa383: 'BMV-712 Smart Rev2',
  0xa389: 'SmartShunt 500A/50mV', 0xa38a: 'SmartShunt 1000A/50mV', 0xa38b: 'SmartShunt 2000A/50mV',
  0xa3a4: 'Smart Battery Sense', 0xa3a5: 'Smart Battery Sense',
  0x0300: 'BlueSolar MPPT 70|15', 0xa040: 'BlueSolar MPPT 75|50', 0xa041: 'BlueSolar MPPT 150|35',
  0xa042: 'BlueSolar MPPT 75|15', 0xa043: 'BlueSolar MPPT 100|15', 0xa044: 'BlueSolar MPPT 100|30',
  0xa045: 'BlueSolar MPPT 100|50', 0xa046: 'BlueSolar MPPT 150|70', 0xa047: 'BlueSolar MPPT 150|100',
  0xa049: 'BlueSolar MPPT 100|50 rev2', 0xa04a: 'BlueSolar MPPT 100|30 rev2', 0xa04b: 'BlueSolar MPPT 150|35 rev2',
  0xa04c: 'BlueSolar MPPT 75|10', 0xa04d: 'BlueSolar MPPT 150|45', 0xa04e: 'BlueSolar MPPT 150|60',
  0xa04f: 'BlueSolar MPPT 150|85', 0xa050: 'SmartSolar MPPT 250|100', 0xa051: 'SmartSolar MPPT 150|100',
  0xa052: 'SmartSolar MPPT 150|85', 0xa053: 'SmartSolar MPPT 75|15', 0xa054: 'SmartSolar MPPT 75|10',
  0xa055: 'SmartSolar MPPT 100|15', 0xa056: 'SmartSolar MPPT 100|30', 0xa057: 'SmartSolar MPPT 100|50',
  0xa058: 'SmartSolar MPPT 150|35', 0xa059: 'SmartSolar MPPT 150|100 rev2', 0xa05a: 'SmartSolar MPPT 150|85 rev2',
  0xa05b: 'SmartSolar MPPT 250|70', 0xa05c: 'SmartSolar MPPT 250|85', 0xa05d: 'SmartSolar MPPT 250|60',
  0xa05e: 'SmartSolar MPPT 250|45', 0xa05f: 'SmartSolar MPPT 100|20', 0xa060: 'SmartSolar MPPT 100|20 48V',
  0xa061: 'SmartSolar MPPT 150|45', 0xa062: 'SmartSolar MPPT 150|60', 0xa063: 'SmartSolar MPPT 150|70',
  0xa064: 'SmartSolar MPPT 250|85 rev2', 0xa065: 'SmartSolar MPPT 250|100 rev2',
  0xa3f0: 'Smart BuckBoost 12V/12V-50A',
};

export function productName(pid: string | undefined) {
  if (!pid) return undefined;
  const n = parseInt(pid, 16);
  if (!Number.isFinite(n)) return undefined;
  return PRODUCTS[n] ?? `Victron 0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** AR / alarm-reason bits. */
const ALARM_REASONS = [
  'Low voltage', 'High voltage', 'Low SOC', 'Low starter voltage', 'High starter voltage', 'Low temperature',
  'High temperature', 'Mid voltage', 'Overload', 'DC ripple', 'Low V AC out', 'High V AC out', 'Short circuit',
  'BMS lockout',
];

const CHARGE_STATES: Record<number, string> = {
  0: 'Off', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 7: 'Equalize', 245: 'Starting up',
  247: 'Auto equalize', 252: 'External control',
};

/** Numeric field, or undefined for missing / "---" values. */
const num = (f: VeFields, k: string) => {
  const s = f[k];
  if (s === undefined || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const div = (v: number | undefined, d: number) => (v === undefined ? undefined : v / d);

const HISTORY: [string, string, number, number][] = [
  // field, metric, divisor, rounding digits
  ['H1', 'Deepest discharge', 1000, 1], ['H2', 'Last discharge', 1000, 1], ['H3', 'Average discharge', 1000, 1],
  ['H5', 'Full discharges', 1, 0], ['H6', 'Cumulative Ah drawn', 1000, 1], ['H7', 'Minimum voltage', 1000, 2],
  ['H8', 'Maximum voltage', 1000, 2], ['H9', 'Seconds since full charge', 1, 0], ['H10', 'Automatic synchronisations', 1, 0],
  ['H11', 'Low voltage alarms', 1, 0], ['H12', 'High voltage alarms', 1, 0], ['H13', 'Low starter voltage alarms', 1, 0],
  ['H14', 'High starter voltage alarms', 1, 0], ['H15', 'Minimum starter voltage', 1000, 2],
  ['H16', 'Maximum starter voltage', 1000, 2], ['H17', 'Discharged energy', 100, 2], ['H18', 'Charged energy', 100, 2],
];

/** Maps accumulated VE.Direct fields to pack metrics. */
export function veDirectMetrics(f: VeFields): Metrics {
  const soc = div(num(f, 'SOC'), 10);
  const consumedAh = div(num(f, 'CE'), 1000);
  const alarms: string[] = [];
  const ar = num(f, 'AR');
  if (ar) alarms.push(...bitNames(ar, ALARM_REASONS));
  else if (f.Alarm?.toUpperCase() === 'ON') alarms.push('Alarm');
  const m = packMetrics({
    voltage: div(num(f, 'V'), 1000),
    current: div(num(f, 'I'), 1000),
    soc,
    temperature: num(f, 'T'),
    cycles: num(f, 'H4'),
    alarms: 'AR' in f || 'Alarm' in f ? alarms : undefined,
    model: productName(f.PID),
    serial: f['SER#']?.trim() || undefined,
    firmware: f.FW?.trim() || undefined,
  });
  const p = num(f, 'P');
  if (p !== undefined) m.Power = p;
  if (consumedAh !== undefined) {
    m['Consumed Ah'] = round(consumedAh, 2);
    // The BMV doesn't report its capacity; estimate it from SOC and consumed Ah.
    if (soc !== undefined && soc < 99 && consumedAh < 0) {
      const fullAh = -consumedAh / (1 - soc / 100);
      m['Charge capacity'] = round(fullAh + consumedAh, 1);
    }
  }
  const ttg = num(f, 'TTG');
  if (ttg !== undefined && ttg >= 0) m['Time to go'] = ttg;
  const vs = num(f, 'VS');
  if (vs !== undefined) m['Starter voltage'] = round(vs / 1000, 2);
  const vm = num(f, 'VM');
  if (vm !== undefined) m['Mid voltage'] = round(vm / 1000, 2);
  const dm = num(f, 'DM');
  if (dm !== undefined) m['Mid voltage deviation'] = round(dm / 10, 1);
  const vpv = num(f, 'VPV');
  if (vpv !== undefined) m['PV voltage'] = round(vpv / 1000, 2);
  const ppv = num(f, 'PPV');
  if (ppv !== undefined) m['PV power'] = ppv;
  const cs = num(f, 'CS');
  if (cs !== undefined) m['Charge state'] = CHARGE_STATES[cs] ?? `State ${cs}`;
  for (const [key, name, d, digits] of HISTORY) {
    const v = num(f, key);
    if (v !== undefined) m[name] = round(v / d, digits);
  }
  return m;
}

export const STALE_MS = 10_000;

export class VeDirectBms implements BmsDriver {
  private port: RawPort;
  private readonly name: string;
  private parser = new VeDirectParser();
  private fields: VeFields = {};
  private last: number | null = null;
  private failure: string | null = null;
  private closing = false;
  private now: () => number;
  firstBlockWaitMs = 3000;

  constructor(path: string, factory: RawPortFactory = serialRawPort, now: () => number = Date.now) {
    this.name = path;
    this.port = factory(path, 19200);
    this.now = now;
  }

  /** Feeds received bytes (exposed for tests). */
  feed(chunk: Buffer) {
    for (const block of this.parser.push(chunk)) {
      Object.assign(this.fields, block);
      this.last = this.now();
    }
  }

  async connect() {
    this.parser = new VeDirectParser();
    this.fields = {};
    this.last = null;
    this.failure = null;
    this.closing = false;
    await this.port.open(
      (c) => this.feed(c),
      (why) => {
        if (!this.closing) this.failure = why;
      },
    );
    for (let t = 0; t < this.firstBlockWaitMs && this.last === null; t += 100) await new Promise((r) => setTimeout(r, 100));
  }

  async close() {
    this.closing = true;
    await this.port.close();
  }

  async read(): Promise<Metrics[]> {
    if (this.failure) throw new Error(this.failure);
    if (this.last === null) throw new Error(`No VE.Direct data on ${this.name}`);
    if (this.now() - this.last > STALE_MS) throw new Error(`No VE.Direct data for ${Math.round((this.now() - this.last) / 1000)} s`);
    return [veDirectMetrics(this.fields)];
  }
}

export const veDirectDriver: BmsDriverDescriptor = {
  id: 've_direct',
  name: 'USB Victron VE.Direct',
  transport: 'serial',
  defaultBaudRate: 19200,
  multiConnection: false,
  create: ({ connections }) => {
    const path = connections[0];
    if (!path) {
      const fail = async (): Promise<never> => {
        throw new Error('No battery connection selected');
      };
      return { connect: fail, read: fail, close: async () => {} };
    }
    return new VeDirectBms(path);
  },
};
