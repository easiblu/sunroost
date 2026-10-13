/** A simulated Modbus TCP device: coils, discrete inputs, holding and input registers. */
import { createServer } from 'node:net';
import modbusSerial from 'modbus-serial';

const { ServerTCP } = modbusSerial as unknown as { ServerTCP: new (vector: object, opts: object) => {
  close(cb: (err: Error | null) => void): void;
  socks: Map<import('node:net').Socket, 0>;
  on(ev: string, fn: (...a: unknown[]) => void): void;
} };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const illegal = () => Object.assign(new Error('Illegal data address'), { modbusErrorCode: 2 });

export class ModbusSim {
  coils = new Map<number, boolean>();
  discretes = new Map<number, boolean>();
  holding = new Map<number, number>();
  input = new Map<number, number>();
  /** Answer only this unit id (255 = any). */
  unitId: number;
  /** Refuse addresses not set (like many real devices). */
  strict = false;
  port = 0;
  writes: { table: string; address: number; value: number | boolean }[] = [];
  private server: ReturnType<typeof this.make> | null = null;

  constructor(unitId = 1) {
    this.unitId = unitId;
  }

  private make() {
    const get = <T>(m: Map<number, T>, d: T) => (addr: number) => {
      if (!m.has(addr) && this.strict) throw illegal();
      return m.get(addr) ?? d;
    };
    return new ServerTCP({
      getCoil: get(this.coils, false),
      getDiscreteInput: get(this.discretes, false),
      getHoldingRegister: get(this.holding, 0),
      getInputRegister: get(this.input, 0),
      setCoil: (addr: number, v: boolean) => {
        this.coils.set(addr, v);
        this.writes.push({ table: 'coil', address: addr, value: v });
      },
      setRegister: (addr: number, v: number) => {
        this.holding.set(addr, v);
        this.writes.push({ table: 'holding', address: addr, value: v });
      },
      setRegisterArray: (addr: number, vs: number[]) => {
        vs.forEach((v, i) => this.holding.set(addr + i, v));
        this.writes.push({ table: 'holding', address: addr, value: vs[0] });
      },
    }, { host: '127.0.0.1', port: this.port, unitID: this.unitId });
  }

  async start(): Promise<number> {
    if (!this.port) this.port = await freePort();
    const s = this.make();
    this.server = s;
    s.on('error', () => {});
    s.on('socketError', () => {});
    await new Promise<void>((resolve) => s.on('initialized', () => resolve()));
    return this.port;
  }

  /** Goes offline: drops connections and stops listening. */
  async stop() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of s.socks.keys()) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Writes a float32 (high word first unless `le`) into input or holding registers. */
  setFloat(table: 'input' | 'holding', address: number, value: number, le = false) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(value, 0);
    const [hi, lo] = [b.readUInt16BE(0), b.readUInt16BE(2)];
    const m = table === 'input' ? this.input : this.holding;
    m.set(address, le ? lo : hi);
    m.set(address + 1, le ? hi : lo);
  }
}
