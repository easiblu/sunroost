/**
 * Modbus client for the generic Modbus driver: TCP or RTU (with parity), all four tables (coils,
 * discrete inputs, holding and input registers) and the write functions. One request at a time per
 * connection (a promise mutex), like src/devices/modbus.ts, which only covers registers.
 */
import modbusSerial from 'modbus-serial';

const ModbusRTU = modbusSerial.default;
type Client = InstanceType<typeof ModbusRTU>;

export type Table = 'coil' | 'discrete' | 'holding' | 'input';
export const MAX_REGISTERS = 125;
export const MAX_BITS = 2000;

export interface Connection {
  transport: 'tcp' | 'rtu';
  host?: string;
  port?: number;
  path?: string;
  baud?: number;
  parity?: 'none' | 'even' | 'odd';
  unit: number;
  timeoutMs?: number;
}

/** A Modbus exception response: the device answered, but refused the request. */
export const isException = (err: unknown) => typeof (err as { modbusCode?: unknown })?.modbusCode === 'number';

const EXCEPTIONS: Record<number, string> = {
  1: 'illegal function', 2: 'illegal data address', 3: 'illegal data value', 4: 'device failure', 6: 'device busy',
};

/** A short, readable reason for a failed request. */
export function reason(err: unknown): string {
  const e = err as { modbusCode?: number; message?: string; errno?: string; code?: string };
  if (typeof e?.modbusCode === 'number') return `device answered with an error (${EXCEPTIONS[e.modbusCode] ?? `code ${e.modbusCode}`})`;
  if (e?.errno === 'ETIMEDOUT' || /timed out/i.test(e?.message ?? '')) return 'no answer (timed out)';
  if (e?.code === 'ECONNREFUSED' || e?.errno === 'ECONNREFUSED') return 'connection refused';
  if (e?.code === 'EHOSTUNREACH') return 'host unreachable';
  return e?.message ?? String(err);
}

export function describe(c: Connection) {
  return c.transport === 'tcp' ? `${c.host}:${c.port ?? 502} unit ${c.unit}` : `${c.path} (${c.baud ?? 9600} baud) unit ${c.unit}`;
}

export class ModbusClient {
  readonly conn: Connection;
  private client: Client | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(conn: Connection) {
    this.conn = conn;
  }

  get isOpen() {
    return Boolean(this.client?.isOpen);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Opens the connection if it isn't open. */
  ensureOpen(): Promise<void> {
    return this.exclusive(async () => {
      if (this.client?.isOpen) return;
      await this.closeClient();
      const client = new ModbusRTU();
      const c = this.conn;
      if (c.transport === 'tcp') {
        if (!c.host) throw new Error('No host given');
        await client.connectTCP(c.host, { port: c.port ?? 502 });
      } else {
        if (!c.path) throw new Error('No serial port given');
        await client.connectRTUBuffered(c.path, { baudRate: c.baud ?? 9600, dataBits: 8, parity: c.parity ?? 'none', stopBits: 1 });
      }
      client.setID(c.unit);
      client.setTimeout(c.timeoutMs ?? 1500);
      this.client = client;
    });
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeClient());
  }

  private async closeClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => {
      try {
        client.close(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 1000).unref();
    });
  }

  private open(): Client {
    if (!this.client?.isOpen) throw new Error('Modbus connection is not open');
    return this.client;
  }

  readBits(table: 'coil' | 'discrete', start: number, count: number): Promise<boolean[]> {
    return this.exclusive(async () => {
      const c = this.open();
      const res = table === 'coil' ? await c.readCoils(start, count) : await c.readDiscreteInputs(start, count);
      return Array.from(res.data).slice(0, count);
    });
  }

  readRegisters(table: 'holding' | 'input', start: number, count: number): Promise<number[]> {
    return this.exclusive(async () => {
      const c = this.open();
      const res = table === 'holding' ? await c.readHoldingRegisters(start, count) : await c.readInputRegisters(start, count);
      return Array.from(res.data);
    });
  }

  writeCoil(address: number, on: boolean): Promise<void> {
    return this.exclusive(async () => {
      await this.open().writeCoil(address, on);
    });
  }

  /** Function 6 for one register, 16 for several (32-bit values). */
  writeRegisters(address: number, values: number[]): Promise<void> {
    return this.exclusive(async () => {
      const c = this.open();
      if (values.length === 1) await c.writeRegister(address, values[0]);
      else await c.writeRegisters(address, values);
    });
  }
}
