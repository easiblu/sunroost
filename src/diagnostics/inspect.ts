/**
 * Serial inspection console: two endpoints (dev1, dev2), each a serial device or the TRACE
 * pseudo-device. Each side can pipe what it receives to the other side (both on = a transparent
 * man-in-the-middle relay). Everything received is split into frames after `splitMs` of silence,
 * decoded (Modbus RTU / Voltronic / string) and logged side by side.
 *
 * While sniffing two real devices, dev1 frames followed by a dev2 frame are recorded as
 * request/response rows of the current trace, which can be saved as CSV and later replayed by
 * connecting dev2 to TRACE.
 */
import { diagBus, RingLog } from './bus.ts';
import { detect, describe, Splitter, toHex } from './frames.ts';
import { openPort, releasePort, type DiagPort } from './port.ts';
import { listTraces, loadTrace, safeTraceName, saveTrace, TracePort, type TraceRow } from './trace.ts';

export type Dev = 'dev1' | 'dev2';
export const TRACE = 'TRACE';
const other = (d: Dev): Dev => (d === 'dev1' ? 'dev2' : 'dev1');

interface Endpoint {
  path: string;
  baud: number;
  pipe: boolean;
  port: DiagPort | null;
  splitter: Splitter;
  error: string | null;
}

export class Inspector {
  splitMs = 50;
  readonly log: RingLog;
  private ends: Record<Dev, Endpoint>;
  trace = { name: 'new.csv', rows: [] as TraceRow[], loaded: false };
  misses: string[] = [];
  private pendingRequest: Buffer | null = null;
  /** Where trace files live; set by the API from the data directory. */
  traceDir = 'traces';

  constructor() {
    this.log = new RingLog(1000, (e) => diagBus.publish('inspect', 'log', e));
    const mk = (path: string, baud: number, dev: Dev): Endpoint => ({
      path, baud, pipe: false, port: null, error: null, splitter: new Splitter(this.splitMs, (f) => this.onFrame(dev, f)),
    });
    this.ends = { dev1: mk('', 9600, 'dev1'), dev2: mk(TRACE, 115200, 'dev2') };
  }

  state() {
    const side = (d: Dev) => {
      const e = this.ends[d];
      return { path: e.path, baud: e.baud, connected: Boolean(e.port?.isOpen), pipe: e.pipe, error: e.error };
    };
    return {
      splitMs: this.splitMs,
      dev1: side('dev1'),
      dev2: side('dev2'),
      trace: { name: this.trace.name, loaded: this.trace.loaded, rows: this.trace.rows.length },
      misses: this.misses.slice(-100),
      log: this.log.entries.slice(-300),
    };
  }

  private publish() {
    const { log: _log, ...rest } = this.state();
    diagBus.publish('inspect', 'state', rest);
  }

  setSplit(ms: number) {
    if (!Number.isFinite(ms) || ms < 1 || ms > 10_000) throw new Error('Split must be 1–10000 ms');
    this.splitMs = Math.round(ms);
    for (const e of Object.values(this.ends)) {
      e.splitter.ms = this.splitMs;
      if (e.port instanceof TracePort) e.port.splitMs = this.splitMs;
    }
    this.publish();
  }

  async connect(dev: Dev, path: string, baud: number) {
    const e = this.ends[dev];
    if (e.port) await this.disconnect(dev);
    e.path = path;
    e.baud = baud;
    e.error = null;
    try {
      let port: DiagPort;
      if (path === TRACE) {
        if (this.ends[other(dev)].path === TRACE && this.ends[other(dev)].port) throw new Error('TRACE is already connected on the other side');
        const tp = new TracePort(() => this.trace.rows, this.splitMs);
        tp.on('miss', (frame: Buffer) => {
          const line = `MISS: ${toHex(frame)}`;
          this.misses.push(line);
          if (this.misses.length > 500) this.misses.shift();
          this.log.add({ side: dev, dir: 'miss', hex: toHex(frame), text: `MISS: ${describe(frame)}` });
          this.publish();
        });
        port = tp;
      } else {
        port = await openPort(path, baud, 'Serial inspect');
      }
      port.on('data', (chunk: Buffer) => this.onData(dev, chunk));
      port.on('error', (err: Error) => {
        e.error = err.message;
        this.log.add({ side: dev, dir: 'error', hex: '', text: err.message });
      });
      port.once('close', () => {
        if (e.port === port) {
          e.port = null;
          e.pipe = false;
          this.publish();
        }
      });
      e.port = port;
      this.log.add({ side: dev, dir: 'info', hex: '', text: `Connected ${path}${path === TRACE ? '' : ` @ ${baud}`}` });
    } catch (err) {
      e.error = (err as Error).message;
      this.publish();
      throw err;
    }
    this.publish();
  }

  async disconnect(dev: Dev) {
    const e = this.ends[dev];
    const port = e.port;
    e.port = null;
    e.pipe = false;
    e.splitter.flush();
    if (port) {
      if (port instanceof TracePort) await port.close();
      else await releasePort(port);
      this.log.add({ side: dev, dir: 'info', hex: '', text: `Disconnected ${port.path}` });
    }
    this.publish();
  }

  setPipe(dev: Dev, on: boolean) {
    const e = this.ends[dev];
    if (on && !e.port) throw new Error(`Connect ${dev} first`);
    if (on && !this.ends[other(dev)].port) throw new Error(`Connect ${other(dev)} first`);
    e.pipe = on;
    this.publish();
  }

  private onData(dev: Dev, chunk: Buffer) {
    const e = this.ends[dev];
    e.splitter.push(chunk);
    if (e.pipe) {
      const target = this.ends[other(dev)].port;
      target?.write(chunk).catch((err) => this.log.add({ side: other(dev), dir: 'error', hex: '', text: (err as Error).message }));
    }
  }

  private onFrame(dev: Dev, frame: Buffer) {
    const info = detect(frame);
    this.log.add({
      side: dev, dir: 'rx', hex: toHex(frame), text: describe(frame), type: info.type,
      crc: info.type !== 'string' ? true : undefined,
    });
    // Record request/response pairs while sniffing two real devices.
    const tracing = this.ends.dev1.path === TRACE || this.ends.dev2.path === TRACE;
    if (tracing) return;
    if (dev === 'dev1') this.pendingRequest = frame;
    else if (this.pendingRequest) {
      const req = this.pendingRequest;
      this.pendingRequest = null;
      const existing = this.trace.rows.find((r) => r.request.equals(req));
      if (existing) existing.response = frame;
      else this.trace.rows.push({ request: req, response: frame, notes: '' });
      if (this.trace.rows.length > 5000) this.trace.rows.shift();
    }
  }

  /** Manual send: writes bytes to one side. */
  async send(dev: Dev, data: Buffer) {
    const port = this.ends[dev].port;
    if (!port) throw new Error(`${dev} is not connected`);
    if (!data.length) throw new Error('Nothing to send');
    await port.write(data);
    this.log.add({ side: dev, dir: 'tx', hex: toHex(data), text: describe(data), type: detect(data).type });
  }

  async loadTrace(name: string) {
    const n = safeTraceName(name);
    this.trace = { name: n, rows: await loadTrace(this.traceDir, n), loaded: true };
    this.misses = [];
    this.log.add({ side: 'dev2', dir: 'info', hex: '', text: `Loaded trace ${n} (${this.trace.rows.length} rows)` });
    this.publish();
  }

  async saveTrace(name: string) {
    const n = safeTraceName(name);
    await saveTrace(this.traceDir, n, this.trace.rows);
    this.trace.name = n;
    this.trace.loaded = true;
    this.log.add({ side: 'dev1', dir: 'info', hex: '', text: `Saved trace ${n} (${this.trace.rows.length} rows)` });
    this.publish();
  }

  closeTrace() {
    this.trace = { name: this.trace.name, rows: [], loaded: false };
    this.misses = [];
    this.publish();
  }

  listTraces() {
    return listTraces(this.traceDir);
  }

  clearLog() {
    this.log.clear();
    this.misses = [];
    this.publish();
  }

  async stop() {
    await this.disconnect('dev1');
    await this.disconnect('dev2');
  }
}

export const inspector = new Inspector();
