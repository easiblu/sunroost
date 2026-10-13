/**
 * Event hub for live diagnostic updates. Engines publish (topic, event) pairs; the web API relays
 * them to the browser as Server-Sent Events. Topics: 'test', 'inspect', 'broker', 'bms'.
 */
import { EventEmitter } from 'node:events';

export type Topic = 'test' | 'inspect' | 'broker' | 'bms';

class DiagBus extends EventEmitter {
  publish(topic: Topic, type: string, data: unknown) {
    this.emit('event', { topic, type, data });
  }
}

export const diagBus = new DiagBus();
diagBus.setMaxListeners(100);

/** A bounded, sequence-numbered log shared by the console engines. */
export interface LogEntry {
  seq: number;
  ts: number;
  /** Which side/device the bytes belong to, e.g. 'dev1', 'master', 'slave'. */
  side: string;
  /** 'rx' received from the device, 'tx' written to it, 'info' / 'error' / 'miss' for notes. */
  dir: 'rx' | 'tx' | 'info' | 'error' | 'miss';
  hex: string;
  /** Decoded summary ("MODBUS 3 0 10", text …). */
  text: string;
  type?: 'modbus' | 'voltronic' | 'string';
  crc?: boolean;
}

export class RingLog {
  private seq = 0;
  readonly entries: LogEntry[] = [];
  private readonly max: number;
  private readonly onAdd: (e: LogEntry) => void;

  constructor(max: number, onAdd: (e: LogEntry) => void) {
    this.max = max;
    this.onAdd = onAdd;
  }

  add(e: Omit<LogEntry, 'seq' | 'ts'>) {
    const entry = { seq: ++this.seq, ts: Date.now(), ...e };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.onAdd(entry);
    return entry;
  }

  clear() {
    this.entries.length = 0;
  }
}
