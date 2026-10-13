/**
 * Pack-level metric building shared by every BMS driver, plus the multi-port container
 * that polls several serial ports (one BMS or one Pylontech stack per port) and keeps pack
 * positions stable when a pack or port fails.
 *
 * Metric names match `BANK_FROM_BMS` in core/state.ts
 * (State of charge, State of health, Power, Current, Voltage, Temperature feed the bank totals).
 * Sign convention: Current and Power are positive while charging.
 */
import type { Metrics } from '../../core/metrics.ts';
import type { BmsDriver } from '../types.ts';
import type { ByteLink, LinkFactory } from './serial.ts';

/** Decoded readings of one pack, in SI-ish units (V, A, Ah, °C, %). Everything optional. */
export interface PackReading {
  soc?: number;
  soh?: number;
  voltage?: number;
  current?: number;
  /** Main pack temperature; defaults to the average of `temperatures`. */
  temperature?: number;
  temperatureMos?: number;
  temperatureEnv?: number;
  /** Numbered sensors → "Temperature 1", "Temperature 2", … */
  temperatures?: number[];
  /** Cell temperatures for the Highest/Average/Lowest aggregate (defaults to `temperatures`). */
  cellTemperatures?: number[];
  cells?: number[];
  cycles?: number;
  /** Ah remaining. */
  remainingAh?: number;
  /** Ah full-charge capacity. */
  fullAh?: number;
  /** Ah nominal/design capacity. */
  designAh?: number;
  maxChargeCurrent?: number;
  maxDischargeCurrent?: number;
  alarms?: string[];
  model?: string;
  serial?: string;
  firmware?: string;
}

/** Below this current the pack counts as idle. */
const IDLE_CURRENT_A = 0.2;

export const round = (v: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const fin = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function deviceMode(current: number | undefined) {
  if (!fin(current)) return 'Idle';
  if (current > IDLE_CURRENT_A) return 'Charging';
  if (current < -IDLE_CURRENT_A) return 'Discharging';
  return 'Idle';
}

export function packMetrics(r: PackReading): Metrics {
  const m: Metrics = {};
  if (r.model) m['Model name'] = r.model;
  if (r.serial) m['Serial number'] = r.serial;
  if (r.firmware) m['Firmware version'] = r.firmware;
  m['Device mode'] = deviceMode(r.current);
  if (fin(r.soc)) m['State of charge'] = round(Math.min(100, Math.max(0, r.soc)), 1);
  if (fin(r.soh)) m['State of health'] = round(Math.min(100, Math.max(0, r.soh)), 1);
  if (fin(r.voltage)) m.Voltage = round(r.voltage, 2);
  if (fin(r.current)) m.Current = round(r.current, 2);
  if (fin(r.voltage) && fin(r.current)) m.Power = Math.round(r.voltage * r.current);

  const temps = (r.temperatures ?? []).filter(fin);
  const temperature = fin(r.temperature) ? r.temperature : temps.length ? avg(temps) : undefined;
  if (fin(temperature)) m.Temperature = round(temperature, 1);
  if (fin(r.temperatureMos)) m['Temperature MOS'] = round(r.temperatureMos, 1);
  if (fin(r.temperatureEnv)) m['Temperature ENV'] = round(r.temperatureEnv, 1);
  temps.forEach((t, i) => (m[`Temperature ${i + 1}`] = round(t, 1)));

  if (fin(r.cycles)) m.Cycles = r.cycles;
  if (fin(r.remainingAh)) m['Charge capacity'] = round(r.remainingAh, 1);
  if (fin(r.fullAh)) m.Capacity = round(r.fullAh, 1);
  if (fin(r.designAh)) m['Design capacity'] = round(r.designAh, 1);
  if (fin(r.maxChargeCurrent)) m['Max charge current'] = round(r.maxChargeCurrent, 1);
  if (fin(r.maxDischargeCurrent)) m['Max discharge current'] = round(r.maxDischargeCurrent, 1);

  const cells = (r.cells ?? []).filter(fin);
  if (cells.length) {
    cells.forEach((v, i) => (m[`Cell voltage ${i + 1}`] = round(v, 3)));
    const hi = Math.max(...cells);
    const lo = Math.min(...cells);
    m['Cell voltage - Highest'] = round(hi, 3);
    m['Cell voltage - Average'] = round(avg(cells), 3);
    m['Cell voltage - Lowest'] = round(lo, 3);
    m['Cell voltage - Difference'] = round(hi - lo, 3);
  }
  const cellTemps = (r.cellTemperatures ?? temps).filter(fin);
  if (cellTemps.length) {
    m['Cell temperature - Highest'] = round(Math.max(...cellTemps), 1);
    m['Cell temperature - Average'] = round(avg(cellTemps), 1);
    m['Cell temperature - Lowest'] = round(Math.min(...cellTemps), 1);
  }
  if (r.alarms) m.Alarms = [...new Set(r.alarms)].join(', ');
  return m;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Names for set bits: `names[i]` is bit i; empty names are ignored. */
export function bitNames(value: number, names: string[]) {
  const out: string[] = [];
  names.forEach((n, i) => {
    if (n && value & (1 << i)) out.push(n);
  });
  return out;
}

// ---- Multi-port container --------------------------------------------------------------

/**
 * One serial port's worth of BMS: reads all packs behind it. A hole/undefined entry means
 * that pack failed this poll (its slot is kept so the other packs don't shift).
 */
export interface PortReader {
  /** Called once after the link opens (identify, discover stacked packs …). */
  init(): Promise<void>;
  read(): Promise<(Metrics | undefined)[]>;
}

const REOPEN_AFTER_FAILURES = 3;

export class MultiPortBms implements BmsDriver {
  private ports: { link: ByteLink; reader: PortReader; ready: boolean; slots: number; failures: number }[];

  constructor(connections: string[], baudRate: number, factory: LinkFactory, makeReader: (link: ByteLink) => PortReader) {
    if (!connections.length) throw new Error('No battery connection selected');
    this.ports = connections.map((c) => {
      const link = factory(c, baudRate);
      return { link, reader: makeReader(link), ready: false, slots: 1, failures: 0 };
    });
  }

  async connect() {
    const results = await Promise.allSettled(this.ports.map((p) => this.ensure(p)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length === this.ports.length) throw failed[0].reason;
  }

  async close() {
    await Promise.allSettled(this.ports.map((p) => p.link.close()));
    for (const p of this.ports) p.ready = false;
  }

  /**
   * Ports are independent, so they're polled in parallel. Returns a (possibly sparse) array:
   * failed packs leave a hole at their usual position. Throws only when nothing was read.
   */
  async read() {
    const results = await Promise.allSettled(
      this.ports.map(async (p) => {
        await this.ensure(p);
        return p.reader.read();
      }),
    );
    const out: Metrics[] = [];
    let offset = 0;
    let got = 0;
    let firstError: unknown = null;
    results.forEach((r, i) => {
      const port = this.ports[i];
      if (r.status === 'fulfilled') {
        port.slots = Math.max(1, r.value.length);
        port.failures = 0;
        r.value.forEach((m, j) => {
          if (m) {
            out[offset + j] = m;
            got++;
          }
        });
      } else {
        firstError ??= r.reason;
        // A port that keeps failing is reopened (and re-initialised) on a later poll.
        if (++port.failures >= REOPEN_AFTER_FAILURES) {
          port.failures = 0;
          port.ready = false;
          void port.link.close().catch(() => {});
        }
      }
      offset += port.slots;
    });
    if (!got) throw firstError ?? new Error('No battery data');
    return out;
  }

  private async ensure(p: MultiPortBms['ports'][number]) {
    if (p.ready && p.link.isOpen) return;
    await p.link.open();
    await p.reader.init();
    p.ready = true;
  }
}
