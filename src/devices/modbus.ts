/**
 * Shared Modbus RTU/TCP connection used by Modbus inverter drivers and the diagnostics console.
 *
 * All bus access on one connection goes through a promise mutex, so a poll, a settings read and a
 * console query never interleave frames on the wire. Open serial paths are tracked process-wide so
 * the console can refuse to open a port the device manager is already using.
 */
import modbusSerial from 'modbus-serial';
import { EybondClient, parseEybond } from './eybond.ts';
import { parseSolarman, SolarmanClient } from './solarman.ts';

// CJS interop: `.default` is the client class both at runtime and in the typings.
const ModbusRTU = modbusSerial.default;
type Client = InstanceType<typeof ModbusRTU>;

export type RegisterFunction = 3 | 4;

/** Largest register count a single Modbus read may request. */
export const MAX_READ = 125;
/** Largest register count a single write-multiple (fn 16) may carry. */
export const MAX_WRITE = 123;

export interface ModbusTarget {
  type: 'rtu' | 'tcp' | 'solarman' | 'eybond';
  /** Serial device path (RTU). */
  path?: string;
  /** Host name or IP (TCP). */
  host?: string;
  /** TCP port, default 502. */
  port?: number;
  baudRate?: number;
  /** Eybond dongle PN; without one, the first dongle that connects. */
  donglePn?: string;
  /** Eybond: how long connect() waits for the dongle to dial in. */
  connectTimeoutMs?: number;
  /** Solarman logger serial number (the logger ignores requests without it). */
  loggerSerial?: number;
  /** Modbus unit id / slave address. */
  address: number;
  timeoutMs?: number;
}

/** Serial paths currently held open by any ModbusConnection in this process. */
const openPaths = new Set<string>();

export function isSerialPathOpen(path: string) {
  return openPaths.has(path);
}

/**
 * Turns a driver connection string into a target. "tcp://host:port" or "host:port" means Modbus TCP;
 * "solarman://host[:port]/serial" a Solarman WiFi logger; "eybond://[port][/PN]" an Eybond/SmartESS
 * dongle that dials in to us; anything else is a serial device path.
 */
export function parseConnection(connection: string, baudRate: number, address: number): ModbusTarget {
  const text = connection.trim();
  if (/^luxpower:\/\//i.test(text)) throw new Error('luxpower:// connections are handled by the Luxpower driver');
  if (/^goodwe:\/\//i.test(text)) throw new Error('goodwe:// connections are handled by the GoodWe driver');
  const eb = parseEybond(text);
  if (eb) return { type: 'eybond', port: eb.port, donglePn: eb.pn, address };
  const sm = parseSolarman(text);
  if (sm) return { type: 'solarman', host: sm.host, port: sm.port, loggerSerial: sm.serial, address };
  const tcp = /^(?:tcp:\/\/)?([A-Za-z0-9.-]+):(\d{1,5})$/.exec(text);
  if (tcp && !text.startsWith('/')) return { type: 'tcp', host: tcp[1], port: Number(tcp[2]), address };
  if (text.startsWith('tcp://')) return { type: 'tcp', host: text.slice(6), port: 502, address };
  return { type: 'rtu', path: text, baudRate, address };
}

export function describeTarget(t: ModbusTarget) {
  if (t.type === 'eybond') return `Eybond dongle ${t.donglePn ?? '(any)'} on port ${t.port ?? 8899}`;
  if (t.type === 'solarman') return `Solarman logger ${t.loggerSerial} at ${t.host}:${t.port ?? 8899}`;
  return t.type === 'tcp' ? `${t.host}:${t.port ?? 502}` : `${t.path} @ ${t.baudRate ?? 9600}`;
}

export class ModbusConnection {
  readonly target: ModbusTarget;
  private client: Client | null = null;
  private logger: SolarmanClient | EybondClient | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(target: ModbusTarget) {
    this.target = target;
  }

  get isOpen() {
    return Boolean(this.client?.isOpen || this.logger?.isOpen);
  }

  /** Runs fn with exclusive access to the bus. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  connect(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeClient();
      const t = this.target;
      if (t.type === 'eybond') {
        const client = new EybondClient({ port: t.port, pn: t.donglePn, timeoutMs: t.timeoutMs ?? 5000, connectTimeoutMs: t.connectTimeoutMs });
        await client.connect();
        this.logger = client;
        return;
      }
      if (t.type === 'solarman') {
        if (!t.host || t.loggerSerial === undefined) throw new Error('Solarman connection needs a host and logger serial');
        const logger = new SolarmanClient({ host: t.host, port: t.port, serial: t.loggerSerial, timeoutMs: t.timeoutMs ?? 5000 });
        await logger.connect();
        this.logger = logger;
        return;
      }
      const client = new ModbusRTU();
      if (t.type === 'tcp') {
        if (!t.host) throw new Error('No host given');
        await client.connectTCP(t.host, { port: t.port ?? 502 });
      } else {
        if (!t.path) throw new Error('No serial device given');
        await client.connectRTUBuffered(t.path, { baudRate: t.baudRate ?? 9600, dataBits: 8, parity: 'none', stopBits: 1 });
        openPaths.add(t.path);
      }
      client.setID(t.address);
      client.setTimeout(t.timeoutMs ?? 1500);
      this.client = client;
    });
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeClient());
  }

  private async closeClient() {
    const logger = this.logger;
    this.logger = null;
    await logger?.close();
    const client = this.client;
    this.client = null;
    if (this.target.type === 'rtu' && this.target.path) openPaths.delete(this.target.path);
    if (!client) return;
    await new Promise<void>((resolve) => {
      try {
        client.close(() => resolve());
      } catch {
        resolve();
      }
      // Some port states never call back; don't hang the caller.
      setTimeout(resolve, 1000).unref();
    });
  }

  private requireLogger(): SolarmanClient | EybondClient {
    if (!this.logger?.isOpen) throw new Error('WiFi logger connection is not open');
    return this.logger;
  }

  private requireClient(): Client {
    if (!this.client?.isOpen) throw new Error('Modbus connection is not open');
    return this.client;
  }

  /**
   * Reads `count` registers (≤125) with function 3 (holding) or 4 (input). `unit` addresses another
   * slave on the same bus (e.g. stacked battery packs); it defaults to the target's address.
   */
  read(fn: RegisterFunction, start: number, count: number, unit?: number): Promise<number[]> {
    checkRange(start, count, MAX_READ);
    return this.exclusive(async () => {
      if (this.target.type === 'solarman' || this.target.type === 'eybond') return this.requireLogger().read(unit ?? this.target.address, fn, start, count);
      const client = this.requireClient();
      client.setID(unit ?? this.target.address);
      const res = fn === 3 ? await client.readHoldingRegisters(start, count) : await client.readInputRegisters(start, count);
      return Array.from(res.data);
    });
  }

  /**
   * Writes registers: function 6 for a single register, function 16 for several.
   * `multiple: true` always uses function 16 (some inverters, e.g. Deye, reject function 6).
   */
  write(start: number, values: number[], opts: { multiple?: boolean } = {}): Promise<void> {
    checkRange(start, values.length, MAX_WRITE);
    for (const v of values) {
      if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`Register value out of range: ${v}`);
    }
    return this.exclusive(async () => {
      if (this.target.type === 'solarman' || this.target.type === 'eybond') return this.requireLogger().write(this.target.address, start, values, Boolean(opts.multiple));
      const client = this.requireClient();
      client.setID(this.target.address);
      if (values.length === 1 && !opts.multiple) await client.writeRegister(start, values[0]);
      else await client.writeRegisters(start, values);
    });
  }
}

function checkRange(start: number, count: number, max: number) {
  if (!Number.isInteger(start) || start < 0 || start > 0xffff) throw new Error(`Invalid start register: ${start}`);
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(`Register count must be 1–${max}`);
  if (start + count - 1 > 0xffff) throw new Error('Register range exceeds 65535');
}

/** Opens a temporary connection, runs fn, and always closes it. */
export async function withConnection<T>(target: ModbusTarget, fn: (c: ModbusConnection) => Promise<T>): Promise<T> {
  const conn = new ModbusConnection(target);
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
  }
}
