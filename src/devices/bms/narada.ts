/**
 * "USB Narada RS485": the Narada-family ASCII protocol used by EG4 LifePower4 (models without
 * LCD), SunSynk SSLB, Shoto SDA10-48100L5, Vestwood VT48100e/A1, Narada NPFC and Storz Power.
 *
 * Framing is the Pylontech ASCII-hex family (see serial-ascii.ts: '~' VER ADR CID1 CID2
 * LENGTH INFO CHKSUM '\r') with the battery CID1 0x4A instead of 0x46. The well-known EG4
 * request "~20014A420000FDA2\r" is VER 0x20, address 1, CID1 0x4A, CID2 0x42, empty INFO.
 *
 * Much of the reply layout is not publicly documented, so decoding is defensive:
 *  - [verify] CID1 0x4A; 0x46 is tried as a fallback when 0x4A gets no answer.
 *  - [verify] analog INFO header: 0–2 leading bytes (INFOFLAG / address) before the cell
 *    count; the offset is found by checking that the cell voltages are plausible.
 *  - [verify] cells mV, temperatures 0.1 K (other units recognised by value range),
 *    current 10 mA signed, voltage 10 mV (cross-checked against the cell sum),
 *    remaining/full capacity 10 mAh, then cycles; a user-defined count byte P may precede
 *    the full capacity, and a design capacity (10 mAh) may follow the cycles.
 *  - [verify] request INFO is empty; if a pack rejects that (RTN 05/06), its address byte is sent.
 * Packs are addressed consecutively from the model's first address with no gaps
 * (EG4: dip address 2 upward; address 1 switches newer EG4 firmware to another protocol).
 */
import { logger } from '../../core/log.ts';
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import type { BmsDriver, BmsDriverDescriptor, DriverOption } from '../types.ts';
import { MultiPortBms, packMetrics, round, type PackReading, type PortReader } from './pack.ts';
import {
  AdaptiveLink,
  Cursor,
  RTN_TEXT,
  asciiFrameReader,
  buildFrame,
  h2,
  interpretCapacity,
  maxPackCount,
  parseFrame,
  plausibleVoltage,
  protocolSettings,
  temperaturesC,
  withInverterCurrent,
  type ProtocolOptions,
  type RawCapacity,
} from './serial-ascii.ts';
import { serialLinkFactory, type LinkFactory } from './serial.ts';

const log = logger('devices');

export const CID1_NARADA = 0x4a;
const CID1_CANDIDATES = [CID1_NARADA, 0x46];
export const CID2_ANALOG = 0x42;
const VERSION = 0x20;
const TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 600;

export interface NaradaModel extends DriverOption {
  /** Candidate addresses for the first pack, tried in order. */
  first: number[];
}

export const NARADA_MODELS: NaradaModel[] = [
  { id: 'eg4', name: 'EG4 LifePower4 (no LCD)', first: [2] },
  // [verify] SSLB / L5 address numbering.
  { id: 'sunsynk_sslb', name: 'SunSynk SSLB', first: [1, 2] },
  { id: 'shoto_l5', name: 'Shoto SDA10-48100L5', first: [1, 2] },
  { id: 'vestwood', name: 'Vestwood VT48100e', first: [2] },
  { id: 'generic', name: 'Generic', first: [1, 2, 0] },
];

export interface NaradaRaw extends RawCapacity {
  cells: number[];
  tempsRaw: number[];
  current: number;
  voltage: number;
  cycles?: number;
}

const plausibleCell = (mv: number) => mv >= 1500 && mv <= 5000;

/** Finds where the cell count sits: the first offset whose cells all look like cell voltages. */
export function cellOffset(info: Buffer): number {
  for (let o = 0; o <= 2; o++) {
    const n = info[o];
    if (!n || n > 32 || info.length < o + 1 + n * 2 + 1) continue;
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = plausibleCell(info.readUInt16BE(o + 1 + i * 2));
    if (ok) return o;
  }
  throw new Error('Narada: no cell block found');
}

/** Decodes a 0x42 analog reply INFO (layout per the module comment). */
export function decodeNarada(info: Buffer): NaradaRaw {
  const c = new Cursor(info, cellOffset(info));
  const n = c.u8();
  const cells = Array.from({ length: n }, () => c.u16() / 1000);
  const nTemps = c.u8();
  if (nTemps > 16) throw new Error('Narada: implausible temperature count');
  const tempsRaw = Array.from({ length: nTemps }, () => c.s16());
  const current = round(c.s16() * 0.01, 2);
  const voltage = round(plausibleVoltage(c.u16(), 0.01, cells), 3);
  const r: NaradaRaw = { cells, tempsRaw, current, voltage };
  if (c.left < 2) return r;
  r.remainingAh = c.u16() * 0.01;
  // The rest is 16-bit words, so an odd byte count means a Pylontech-style user-defined
  // item count P precedes the full capacity.
  if (c.left % 2 === 1) c.u8();
  if (c.left >= 2) r.fullAh = c.u16() * 0.01;
  if (c.left >= 2) r.cycles = c.u16();
  if (c.left >= 2) {
    const design = c.u16() * 0.01;
    if (design > 0) r.designAh = design;
  }
  return r;
}

export function naradaReading(raw: NaradaRaw, opts: ProtocolOptions): PackReading {
  const temps = temperaturesC(raw.tempsRaw, opts.temperature);
  const cap = interpretCapacity(raw, opts, { soc: 'charge/full', capacity: 'full' });
  return {
    voltage: raw.voltage,
    current: raw.current,
    cells: raw.cells,
    cycles: raw.cycles,
    temperatures: temps,
    cellTemperatures: temps,
    ...cap,
  };
}

export class NaradaPort implements PortReader {
  private link: AdaptiveLink;
  private first: number[];
  private maxPacks: () => number;
  private protocol: () => ProtocolOptions;
  private cid1 = CID1_NARADA;
  /** Whether requests carry the address as INFO (some packs reject an empty INFO). */
  private withAddress = false;
  addresses: number[] = [];

  constructor(link: AdaptiveLink, first: number[], maxPacks: () => number, protocol: () => ProtocolOptions) {
    this.link = link;
    this.first = first;
    this.maxPacks = maxPacks;
    this.protocol = protocol;
  }

  private async request(adr: number, timeoutMs: number): Promise<Buffer> {
    const info = this.withAddress ? Uint8Array.of(adr) : undefined;
    const reply = await this.link.request(buildFrame(VERSION, adr, this.cid1, CID2_ANALOG, info), asciiFrameReader, { timeoutMs });
    const f = parseFrame(reply);
    if (f.adr !== adr) throw new Error(`Narada: reply from address ${f.adr}, expected ${adr}`);
    if (f.cid2 === 0x05 || f.cid2 === 0x06) {
      if (!this.withAddress) {
        this.withAddress = true;
        return this.request(adr, timeoutMs);
      }
    }
    if (f.cid2 !== 0) throw new Error(`Narada pack ${adr}: ${RTN_TEXT[f.cid2] ?? `error ${h2(f.cid2)}`}`);
    return f.info;
  }

  async analog(adr: number, timeoutMs = TIMEOUT_MS) {
    return decodeNarada(await this.request(adr, timeoutMs));
  }

  async init() {
    this.addresses = [];
    search: for (const cid1 of CID1_CANDIDATES) {
      this.cid1 = cid1;
      for (const adr of this.first) {
        try {
          await this.analog(adr, PROBE_TIMEOUT_MS);
          this.addresses.push(adr);
          break search;
        } catch {}
      }
    }
    if (!this.addresses.length) throw new Error(`${this.link.name}: no Narada battery at address ${this.first.join(' or ')}`);
    const max = this.maxPacks();
    for (let adr = this.addresses[0] + 1; this.addresses.length < max && adr <= 0xfe; adr++) {
      try {
        await this.analog(adr, PROBE_TIMEOUT_MS);
        this.addresses.push(adr);
      } catch {
        break; // no gaps: stop at the first missing address
      }
    }
    log.info(`Narada BMS ${this.link.name}: CID1 0x${h2(this.cid1)}, ${this.addresses.length} pack(s) at address ${this.addresses.join(', ')}`);
  }

  async read(): Promise<(Metrics | undefined)[]> {
    const opts = this.protocol();
    const out: (Metrics | undefined)[] = [];
    for (const [i, adr] of this.addresses.entries()) {
      try {
        out[i] = packMetrics(naradaReading(await this.analog(adr), opts));
      } catch {
        out[i] = undefined;
      }
    }
    if (out.every((m) => !m)) throw new Error(`${this.link.name}: no reply from any Narada pack`);
    return out;
  }
}

export interface NaradaConfig {
  modelId: string;
  baudRate: number;
  maxPacks?: () => number;
  protocol?: () => ProtocolOptions;
  readCurrentFromInverter?: () => boolean;
}

export function createNarada(connections: string[], cfg: NaradaConfig, factory: LinkFactory = serialLinkFactory): BmsDriver {
  const model = NARADA_MODELS.find((m) => m.id === cfg.modelId) ?? NARADA_MODELS[0];
  const bms = new MultiPortBms(
    connections,
    cfg.baudRate,
    (path, baud) => new AdaptiveLink(path, baud, factory),
    (link) => new NaradaPort(link as AdaptiveLink, model.first, cfg.maxPacks ?? maxPackCount, cfg.protocol ?? protocolSettings),
  );
  return withInverterCurrent(bms, cfg.readCurrentFromInverter);
}

export const naradaDriver: BmsDriverDescriptor = {
  id: 'narada',
  name: 'USB Narada RS485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: true,
  models: NARADA_MODELS.map(({ id, name }) => ({ id, name })),
  create: ({ connections, modelId }) => createNarada(connections, { modelId, baudRate: Number(settings.get('bms.baud_rate')) || 9600 }),
};
