/**
 * Raw serial ports for the diagnostic tools. Every port a diagnostic engine opens is registered
 * here so (a) two tools never open the same device, (b) ports owned by the running device manager
 * are refused, and (c) `closeAllPorts()` releases everything on shutdown.
 *
 * Tests swap the factory for in-memory ports with `setPortFactory()`.
 */
import { EventEmitter } from 'node:events';
import { settings } from '../core/settings.ts';
import { devices } from '../devices/manager.ts';
import { isSerialPathOpen } from '../devices/modbus.ts';

/** A byte port: emits 'data' (Buffer), 'error' (Error) and 'close'. */
export interface DiagPort extends EventEmitter {
  readonly path: string;
  readonly isOpen: boolean;
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export type PortFactory = (path: string, baudRate: number) => Promise<DiagPort>;

class SerialDiagPort extends EventEmitter implements DiagPort {
  readonly path: string;
  private port: import('serialport').SerialPort;

  constructor(path: string, port: import('serialport').SerialPort) {
    super();
    this.path = path;
    this.port = port;
    port.on('data', (chunk: Buffer) => this.emit('data', chunk));
    port.on('error', (err: Error) => this.emit('error', err));
    port.on('close', () => this.emit('close'));
  }

  get isOpen() {
    return this.port.isOpen;
  }

  write(data: Buffer) {
    return new Promise<void>((resolve, reject) => {
      if (!this.port.isOpen) return reject(new Error(`${this.path}: port not open`));
      this.port.write(data, (err) => (err ? reject(err) : this.port.drain((e) => (e ? reject(e) : resolve()))));
    });
  }

  close() {
    return new Promise<void>((resolve) => {
      if (!this.port.isOpen) return resolve();
      const t = setTimeout(resolve, 1000);
      t.unref();
      this.port.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

const serialFactory: PortFactory = async (path, baudRate) => {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  return new SerialDiagPort(path, port);
};

let factory: PortFactory = serialFactory;

/** Replaces the port factory (tests). Pass nothing to restore the real one. */
export function setPortFactory(f?: PortFactory) {
  factory = f ?? serialFactory;
}

/** path → owning tool name */
const owners = new Map<string, { owner: string; port: DiagPort }>();

/** Serial paths owned by the running device manager (or any Modbus connection). */
export function managedPaths(): string[] {
  if (!devices.started) return [];
  return [...settings.get('inverter.connection_ids'), ...settings.get('bms.connection_ids')].filter(Boolean);
}

/** Why `path` can't be opened by a diagnostic tool, or null when it is free. */
export function busyReason(path: string): string | null {
  if (managedPaths().includes(path) || isSerialPathOpen(path)) return 'in use by the device connection';
  const o = owners.get(path);
  if (o) return `in use by ${o.owner}`;
  return null;
}

export function isOwned(path: string) {
  return owners.has(path);
}

/** Opens `path` for `owner`, refusing ports owned by the device manager or another tool. */
export async function openPort(path: string, baudRate: number, owner: string): Promise<DiagPort> {
  if (!path) throw new Error('Choose a device');
  if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4_000_000) throw new Error('Invalid baud rate');
  const busy = busyReason(path);
  if (busy) throw new Error(`${path} is ${busy}`);
  owners.set(path, { owner, port: null as unknown as DiagPort }); // reserve while opening
  try {
    const port = await factory(path, baudRate);
    port.on('error', () => {}); // callers subscribe as needed; never crash on an unhandled 'error'
    owners.set(path, { owner, port });
    port.once('close', () => {
      if (owners.get(path)?.port === port) owners.delete(path);
    });
    return port;
  } catch (err) {
    owners.delete(path);
    throw err;
  }
}

export async function releasePort(port: DiagPort | null | undefined) {
  if (!port) return;
  if (owners.get(port.path)?.port === port) owners.delete(port.path);
  port.removeAllListeners('data');
  await port.close().catch(() => {});
}

/** Closes every port any diagnostic tool still holds. */
export async function closeAllPorts() {
  const ports = [...owners.values()].map((o) => o.port).filter(Boolean);
  owners.clear();
  await Promise.all(ports.map((p) => p.close().catch(() => {})));
}

/** Serial devices on this machine (USB adapters, UARTs). */
export async function listSerialPaths(): Promise<{ path: string; label: string }[]> {
  try {
    const { SerialPort } = await import('serialport');
    return (await SerialPort.list()).map((p) => ({ path: p.path, label: [p.path, p.manufacturer].filter(Boolean).join(' · ') }));
  } catch {
    return [];
  }
}

// ---- In-memory ports (tests, TRACE pseudo-device plumbing) ----------------------------

/** An in-memory port; `peer` receives what this port writes. */
export class MemoryPort extends EventEmitter implements DiagPort {
  readonly path: string;
  isOpen = true;
  peer: MemoryPort | null = null;
  /** Everything written to this port. */
  written: Buffer[] = [];

  constructor(path: string) {
    super();
    this.path = path;
  }

  async write(data: Buffer) {
    if (!this.isOpen) throw new Error(`${this.path}: port not open`);
    this.written.push(Buffer.from(data));
    const peer = this.peer;
    if (peer?.isOpen) queueMicrotask(() => peer.emit('data', Buffer.from(data)));
  }

  /** Simulates bytes arriving from the wire. */
  receive(data: Buffer | string) {
    this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'));
  }

  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.emit('close');
  }
}

/** Two connected in-memory ports (a null-modem cable). */
export function memoryPair(a: string, b: string): [MemoryPort, MemoryPort] {
  const pa = new MemoryPort(a);
  const pb = new MemoryPort(b);
  pa.peer = pb;
  pb.peer = pa;
  return [pa, pb];
}
