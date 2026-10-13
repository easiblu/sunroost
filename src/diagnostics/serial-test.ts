/**
 * Serial link test: opens every free serial port at 115200, repeatedly writes a random printable
 * string and collects what comes back. A loopback plug (TX↔RX) or two cross-wired adapters echo the
 * string, so Receive matches Transmit; a broken cable or adapter shows a mismatch or nothing.
 */
import { diagBus } from './bus.ts';
import { busyReason, listSerialPaths, openPort, releasePort, type DiagPort } from './port.ts';

export const TEST_BAUD = 115200;
const PERIOD_MS = 1000;
const LENGTH = 16;

export interface PortResult {
  path: string;
  transmit: string;
  receive: string;
  /** null until the first round finishes. */
  ok: boolean | null;
  /** Why the port is not tested (busy, open failed). */
  error?: string;
  rounds: number;
  passed: number;
}

/** Random printable characters in ASCII 48..122 ('0'..'z'). */
export function randomPrintable(n = LENGTH, rand = Math.random): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(48 + Math.floor(rand() * 75));
  return s;
}

/**
 * Receive matches when every transmitted string appears in what arrived. With two cross-wired
 * adapters a port receives its partner's string, so a port also passes when it received any
 * complete string some other port transmitted this round.
 */
export function judge(transmit: string, receive: string, others: string[] = []) {
  if (!receive) return false;
  return receive.includes(transmit) || others.some((o) => o && receive.includes(o));
}

interface Slot {
  result: PortResult;
  port: DiagPort | null;
  rx: string;
}

export class SerialTest {
  private slots = new Map<string, Slot>();
  private timer: NodeJS.Timeout | null = null;
  running = false;
  /** Overridable for tests. */
  periodMs = PERIOD_MS;

  state() {
    return { running: this.running, ports: [...this.slots.values()].map((s) => s.result) };
  }

  private publish() {
    diagBus.publish('test', 'state', this.state());
  }

  /** Lists ports for the idle page (busy ones flagged). */
  async preview(paths?: string[]) {
    if (this.running) return this.state();
    const list = paths ?? (await listSerialPaths()).map((p) => p.path);
    return {
      running: false,
      ports: list.map((path) => ({ path, transmit: '', receive: '', ok: null, rounds: 0, passed: 0, error: busyReason(path) ?? undefined })),
    };
  }

  async start(paths?: string[]) {
    if (this.running) return this.state();
    const list = paths ?? (await listSerialPaths()).map((p) => p.path);
    this.running = true;
    this.slots.clear();
    for (const path of list) {
      const slot: Slot = { result: { path, transmit: '', receive: '', ok: null, rounds: 0, passed: 0 }, port: null, rx: '' };
      this.slots.set(path, slot);
      const busy = busyReason(path);
      if (busy) {
        slot.result.error = `Skipped: ${busy}`;
        continue;
      }
      try {
        const port = await openPort(path, TEST_BAUD, 'Serial test');
        slot.port = port;
        port.on('data', (chunk: Buffer) => {
          slot.rx = (slot.rx + chunk.toString('latin1')).slice(-256);
          slot.result.receive = slot.rx;
        });
        port.on('error', (err: Error) => (slot.result.error = err.message));
      } catch (err) {
        slot.result.error = (err as Error).message;
      }
    }
    if (!this.running) return this.state(); // stopped while opening
    this.round();
    return this.state();
  }

  /** Judges the previous round, then transmits a new one. */
  private round() {
    const active = [...this.slots.values()].filter((s) => s.port);
    const sent = active.map((s) => s.result.transmit);
    for (const s of active) {
      if (!s.result.transmit) continue;
      s.result.rounds++;
      s.result.receive = s.rx;
      s.result.ok = judge(s.result.transmit, s.rx, sent.filter((t) => t !== s.result.transmit));
      if (s.result.ok) s.result.passed++;
    }
    this.publish();
    for (const s of active) {
      s.rx = '';
      s.result.transmit = randomPrintable();
      s.port!.write(Buffer.from(s.result.transmit, 'latin1')).catch((err) => (s.result.error = (err as Error).message));
    }
    this.timer = setTimeout(() => this.running && this.round(), this.periodMs);
    this.timer.unref();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([...this.slots.values()].map((s) => releasePort(s.port)));
    for (const s of this.slots.values()) s.port = null;
    this.publish();
    return this.state();
  }
}

export const serialTest = new SerialTest();
