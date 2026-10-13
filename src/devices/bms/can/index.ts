/**
 * "USB CAN bus": passive monitoring of the inverter↔battery CAN link (Pylontech/Sunsynk CAN
 * protocol). The adapter is tapped in parallel and only listens; the bank shows as one pack.
 *
 * Models are the adapters:
 *   auto       /dev/tty… connection → serial analyser (Waveshare framing, then Seeed);
 *              anything else (e.g. "can0", typed into the connection field) → SocketCAN
 *   socketcan  gs_usb/candleLight USB-CAN cables, Waveshare in gs_usb/slcan mode: reads
 *              `candump -L <iface>` (can-utils). The interface is the connection when it isn't
 *              a /dev path, else the bms.can_interface setting (default can0).
 *   waveshare  Waveshare USB-CAN-A (CH340, 2 Mbaud serial, variable-length framing)
 *   seeed      Seeed Studio USB-CAN Analyzer (CH340, 2 Mbaud serial, fixed 20-byte frames)
 *
 * Baud rate (bms.baud_rate) is the CAN bitrate: 250000, 500000 (default) or 1000000. Any
 * other value (e.g. "2 Mbps", which is the analysers' USB-serial speed) keeps
 * 500 kbit/s.
 */
import type { Metrics } from '../../../core/metrics.ts';
import { settings } from '../../../core/settings.ts';
import type { BmsDriver, BmsDriverDescriptor, DriverOption } from '../../types.ts';
import { CanBank } from './decode.ts';
import { isCanBitrate, type CanFrame } from './frames.ts';
import { SerialCanSource, SocketCanSource, type CanSource, type SerialAdapter } from './sources.ts';

export const CAN_ADAPTERS: DriverOption[] = [
  { id: 'auto', name: 'Auto detect' },
  { id: 'socketcan', name: 'SocketCAN interface' },
  { id: 'waveshare', name: 'Waveshare USB-CAN-A' },
  { id: 'seeed', name: 'Seeed USB-CAN Analyzer' },
];

export const DEFAULT_CAN_BITRATE = 500_000;
/** No recognised BMS frame for this long → the reading is stale. */
export const STALE_MS = 10_000;

export type CanSetup =
  | { kind: 'socketcan'; iface: string; bitrate: number }
  | { kind: 'serial'; path: string; adapter: SerialAdapter; bitrate: number };

const isSerialPath = (c: string) => c.startsWith('/dev/') || /^COM\d+$/i.test(c);

export function canBitrate(baudRate: number) {
  return baudRate > 0 && baudRate <= 1_000_000 && isCanBitrate(baudRate) ? baudRate : DEFAULT_CAN_BITRATE;
}

/** Picks the adapter and its endpoint from the connection, the model (adapter) and settings. */
export function resolveCanSetup(o: { connection?: string; adapter?: string; iface?: string; baudRate: number }): CanSetup {
  const conn = (o.connection ?? '').trim();
  const adapter = o.adapter || 'auto';
  const bitrate = canBitrate(o.baudRate);
  const iface = conn && !isSerialPath(conn) ? conn : o.iface || 'can0';
  if (adapter === 'socketcan') return { kind: 'socketcan', iface, bitrate };
  if (adapter === 'waveshare' || adapter === 'seeed') {
    if (!isSerialPath(conn)) throw new Error(`Select the USB port of the ${adapter === 'seeed' ? 'Seeed' : 'Waveshare'} CAN adapter`);
    return { kind: 'serial', path: conn, adapter, bitrate };
  }
  if (isSerialPath(conn)) return { kind: 'serial', path: conn, adapter: 'auto', bitrate };
  return { kind: 'socketcan', iface, bitrate };
}

export class CanBms implements BmsDriver {
  private source: CanSource;
  private bank = new CanBank();
  private last: number | null = null;
  private now: () => number;
  /** How long connect() waits for the first BMS frame (no error if none arrives). */
  firstFrameWaitMs = 3000;

  constructor(source: CanSource, now: () => number = Date.now) {
    this.source = source;
    this.now = now;
  }

  async connect() {
    this.bank = new CanBank();
    this.last = null;
    await this.source.open((f: CanFrame) => {
      if (this.bank.apply(f)) this.last = this.now();
    });
    for (let t = 0; t < this.firstFrameWaitMs && this.last === null; t += 100) await new Promise((r) => setTimeout(r, 100));
  }

  async close() {
    await this.source.close();
  }

  async read(): Promise<Metrics[]> {
    if (this.source.failure) throw new Error(this.source.failure);
    if (this.last === null) throw new Error(`No battery data on ${this.source.name}: check the CAN wiring and that the battery uses the Pylontech/Sunsynk CAN protocol`);
    if (this.now() - this.last > STALE_MS) throw new Error(`No CAN frames from the battery for ${Math.round((this.now() - this.last) / 1000)} s`);
    return [this.bank.metrics()];
  }
}

export function createCanBms(setup: CanSetup): CanBms {
  const source =
    setup.kind === 'socketcan'
      ? new SocketCanSource(setup.iface, setup.bitrate)
      : new SerialCanSource(setup.path, setup.adapter, setup.bitrate);
  return new CanBms(source);
}

export const canBmsDriver: BmsDriverDescriptor = {
  id: 'can',
  name: 'USB CAN bus',
  transport: 'serial',
  defaultBaudRate: DEFAULT_CAN_BITRATE,
  models: CAN_ADAPTERS,
  multiConnection: false,
  create: ({ connections, baudRate, modelId }) => {
    let setup: CanSetup;
    try {
      setup = resolveCanSetup({
        connection: connections[0],
        adapter: modelId || settings.get('bms.can_adapter'),
        iface: settings.get('bms.can_interface'),
        baudRate,
      });
    } catch (err) {
      // Report configuration problems through connect(), like any other connection error.
      const fail = async (): Promise<never> => {
        throw err;
      };
      return { connect: fail, read: fail, close: async () => {} };
    }
    return createCanBms(setup);
  },
};
