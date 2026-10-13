/**
 * Protocol broker: a device emulator / proxy between a master (e.g. an inverter polling its BMS,
 * or monitoring software polling an inverter) on the "From" port and an optional real
 * device on the "To" port.
 *
 * - Modbus: answers read requests (fn 3/4) from per-address register grids. Grid cells left empty
 *   pass through: the request is forwarded to the To device and only the cells you set are
 *   rewritten in its reply. Addresses without a grid are forwarded (or stay silent when To is not
 *   connected, like an absent device on an RS485 bus). Writes (fn 6/16) update the grid and are
 *   forwarded only when "Allow write" is on; otherwise the master gets a local acknowledgement.
 * - Voltronic / Narada: a table of request text → response text. Unknown requests are forwarded to
 *   To and the reply is learned into the table.
 *
 * Saved brokers live in SQLite (table diag_brokers).
 */
import { db } from '../core/db.ts';
import { voltronicCrc } from '../devices/inverters/voltronic/protocol.ts';
import { diagBus, RingLog } from './bus.ts';
import { decodeModbus, decodeVoltronic, describe, detect, modbusCrcOk, printable, toHex, withModbusCrc } from './frames.ts';
import { openPort, releasePort, type DiagPort } from './port.ts';

export type BrokerType = 'modbus' | 'voltronic' | 'narada';
export const BROKER_TYPES: BrokerType[] = ['modbus', 'voltronic', 'narada'];

export interface ModbusTable {
  /** Modbus unit address the grid answers for. */
  address: number;
  /** 4 = input registers, 3 = holding registers. */
  fn: 3 | 4;
  start: number;
  /** Register values; null = not set (pass through / 0). */
  values: (number | null)[];
  /** Reply with this address instead of the request's (some devices answer under another id). */
  respondAddress?: number | null;
}

export interface ResponseRow {
  request: string;
  response: string;
}

export interface BrokerConfig {
  id?: number;
  name: string;
  type: BrokerType;
  from: { path: string; baud: number };
  to: { path: string; baud: number };
  allowWrite: boolean;
  tables: ModbusTable[];
  responses: ResponseRow[];
}

export function defaultConfig(type: BrokerType): BrokerConfig {
  return {
    name: '',
    type,
    from: { path: '', baud: 9600 },
    to: { path: '', baud: 115200 },
    allowWrite: false,
    tables: type === 'modbus' ? [{ address: 1, fn: 4, start: 0, values: Array(20).fill(null) }] : [],
    responses: [],
  };
}

const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

/** Validates and normalises a config coming from the browser. */
export function normalizeConfig(raw: Partial<BrokerConfig>): BrokerConfig {
  const type = BROKER_TYPES.includes(raw.type as BrokerType) ? (raw.type as BrokerType) : 'modbus';
  const port = (p: unknown, baud: number) => {
    const o = (p ?? {}) as { path?: unknown; baud?: unknown };
    return { path: String(o.path ?? '').slice(0, 200), baud: int(o.baud, 50, 4_000_000, baud) };
  };
  const tables = (Array.isArray(raw.tables) ? raw.tables : []).slice(0, 64).map((t) => {
    const start = int(t.start, 0, 65535, 0);
    const values = (Array.isArray(t.values) ? t.values : []).slice(0, Math.min(1000, 65536 - start)).map((v) => {
      if (v === null || v === undefined || (v as unknown) === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < -32768 || n > 100000) throw new Error(`Register value out of range: ${v}`);
      return n;
    });
    const respond = t.respondAddress === null || t.respondAddress === undefined || (t.respondAddress as unknown) === '' ? null : int(t.respondAddress, 0, 255, 0);
    return { address: int(t.address, 0, 255, 1), fn: (Number(t.fn) === 3 ? 3 : 4) as 3 | 4, start, values, respondAddress: respond };
  });
  const responses = (Array.isArray(raw.responses) ? raw.responses : []).slice(0, 2000).map((r) => ({
    request: String(r.request ?? '').slice(0, 1000),
    response: String(r.response ?? '').slice(0, 4000),
  }));
  return {
    id: raw.id === undefined || raw.id === null ? undefined : int(raw.id, 1, Number.MAX_SAFE_INTEGER, 0) || undefined,
    name: String(raw.name ?? '').trim().slice(0, 80),
    type,
    from: port(raw.from, 9600),
    to: port(raw.to, 115200),
    allowWrite: raw.allowWrite === true,
    tables,
    responses,
  };
}

// ---- Persistence ----------------------------------------------------------------------

let tableReady = false;
function table() {
  if (!tableReady) {
    db().exec(`CREATE TABLE IF NOT EXISTS diag_brokers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    tableReady = true;
  }
  return db();
}

export function listBrokers(): { id: number; name: string; type: BrokerType }[] {
  return table().prepare('SELECT id, name, type FROM diag_brokers ORDER BY name COLLATE NOCASE, id').all() as never;
}

export function getBroker(id: number): BrokerConfig | null {
  const row = table().prepare('SELECT id, config FROM diag_brokers WHERE id = ?').get(id) as { id: number; config: string } | undefined;
  if (!row) return null;
  return { ...normalizeConfig(JSON.parse(row.config)), id: row.id };
}

export function saveBroker(cfg: BrokerConfig): BrokerConfig {
  const c = normalizeConfig(cfg);
  if (!c.name) throw new Error('Enter a name');
  const { id, ...body } = c;
  const json = JSON.stringify(body);
  if (id && getBroker(id)) {
    table().prepare('UPDATE diag_brokers SET name = ?, type = ?, config = ?, updated_at = ? WHERE id = ?').run(c.name, c.type, json, Date.now(), id);
    return { ...c, id };
  }
  const res = table().prepare('INSERT INTO diag_brokers (name, type, config, updated_at) VALUES (?, ?, ?, ?)').run(c.name, c.type, json, Date.now());
  return { ...c, id: Number(res.lastInsertRowid) };
}

export function deleteBroker(id: number) {
  table().prepare('DELETE FROM diag_brokers WHERE id = ?').run(id);
}

// ---- Framing ----------------------------------------------------------------------------

/** Length of the Modbus request at the start of buf: 0 = need more bytes, -1 = not a supported request. */
export function modbusRequestLength(buf: Buffer): number {
  if (buf.length < 2) return 0;
  const fn = buf[1];
  if (fn >= 1 && fn <= 6) return 8;
  if (fn === 15 || fn === 16) return buf.length >= 7 ? 9 + buf[6] : 0;
  return -1;
}

/** Expected reply length for a forwarded Modbus request (0 = unknown, wait for silence). */
export function modbusReplyLength(req: Buffer, buf: Buffer): number {
  if (buf.length >= 2 && buf[1] & 0x80) return 5;
  const fn = req[1];
  if (fn === 3 || fn === 4) return buf.length >= 3 ? 5 + buf[2] : 0;
  if (fn === 1 || fn === 2) return buf.length >= 3 ? 5 + buf[2] : 0;
  if (fn === 5 || fn === 6 || fn === 15 || fn === 16) return 8;
  return 0;
}

/**
 * Collects master requests from a byte stream. Modbus frames are cut by their computed length and
 * CRC (resyncing byte-by-byte on garbage); text protocols at CR. Leftovers are dropped after
 * `idleMs` of silence.
 */
export class RequestAssembler {
  private buf = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private readonly type: BrokerType;
  private readonly onFrame: (f: Buffer) => void;
  idleMs: number;

  constructor(type: BrokerType, onFrame: (f: Buffer) => void, idleMs = 200) {
    this.type = type;
    this.onFrame = onFrame;
    this.idleMs = idleMs;
  }

  push(chunk: Buffer) {
    this.buf = this.buf.length > 4096 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (!this.buf.length) break;
      if (this.type === 'modbus') {
        const len = modbusRequestLength(this.buf);
        if (len < 0) {
          this.buf = this.buf.subarray(1); // resync
          continue;
        }
        if (!len || this.buf.length < len) break;
        const f = this.buf.subarray(0, len);
        if (modbusCrcOk(f)) {
          this.buf = this.buf.subarray(len);
          this.onFrame(Buffer.from(f));
        } else this.buf = this.buf.subarray(1);
      } else {
        const end = this.buf.indexOf(0x0d);
        if (end < 0) break;
        const f = Buffer.from(this.buf.subarray(0, end + 1));
        this.buf = this.buf.subarray(end + 1);
        if (f.length > 1) this.onFrame(f);
      }
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.buf.length) {
      this.timer = setTimeout(() => (this.buf = Buffer.alloc(0)), this.idleMs);
      this.timer.unref();
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Voltronic reply frame: "(" + text + CRC + CR. */
export function voltronicReply(text: string): Buffer {
  const body = Buffer.from('(' + text, 'latin1');
  const crc = voltronicCrc(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}

/** Request key for the text tables: Voltronic command without CRC/CR; Narada frame text without CR. */
export function textKey(type: BrokerType, frame: Buffer): string {
  if (type === 'voltronic') {
    const v = decodeVoltronic(frame);
    if (v) return v.text;
  }
  let end = frame.length;
  while (end > 0 && (frame[end - 1] === 0x0d || frame[end - 1] === 0x0a)) end--;
  return frame.subarray(0, end).toString('latin1');
}

const reg16 = (v: number | null) => (v === null ? 0 : v < 0 ? (v + 0x10000) & 0xffff : v & 0xffff);

// ---- Runtime --------------------------------------------------------------------------

type Side = 'from' | 'to';

export class Broker {
  config: BrokerConfig | null = null;
  running = false;
  readonly master: RingLog;
  readonly slave: RingLog;
  private ports: Record<Side, DiagPort | null> = { from: null, to: null };
  private errors: Record<Side, string | null> = { from: null, to: null };
  private assembler: RequestAssembler | null = null;
  /** Serialises master requests so forwarded exchanges never overlap on the To port. */
  private queue: Promise<unknown> = Promise.resolve();
  private slaveWaiter: ((chunk: Buffer) => void) | null = null;
  forwardTimeoutMs = 1500;
  stats = { requests: 0, answered: 0, forwarded: 0, misses: 0 };

  constructor() {
    this.master = new RingLog(500, (e) => diagBus.publish('broker', 'log', e));
    this.slave = new RingLog(500, (e) => diagBus.publish('broker', 'log', e));
  }

  state() {
    const side = (s: Side) => ({ connected: Boolean(this.ports[s]?.isOpen), error: this.errors[s] });
    return {
      running: this.running,
      config: this.config,
      from: side('from'),
      to: side('to'),
      stats: this.stats,
      master: this.master.entries.slice(-200),
      slave: this.slave.entries.slice(-200),
    };
  }

  private publish() {
    const { master: _m, slave: _s, ...rest } = this.state();
    diagBus.publish('broker', 'state', rest);
  }

  /** Starts a broker session (editor + emulator) for a config. */
  async start(cfg: BrokerConfig) {
    if (this.running) await this.stop();
    this.config = normalizeConfig(cfg);
    this.running = true;
    this.stats = { requests: 0, answered: 0, forwarded: 0, misses: 0 };
    this.master.clear();
    this.slave.clear();
    this.master.add({ side: 'master', dir: 'info', hex: '', text: `Broker started (${this.config.type})` });
    this.publish();
  }

  async stop() {
    await this.disconnect('from');
    await this.disconnect('to');
    this.running = false;
    this.publish();
  }

  /** Replaces the editable data (grids / responses / allow write / name) of the running broker. */
  update(partial: Partial<BrokerConfig>) {
    if (!this.config) throw new Error('No broker running');
    this.config = normalizeConfig({ ...this.config, ...partial, type: this.config.type });
    this.publish();
  }

  setAllowWrite(on: boolean) {
    if (!this.config) throw new Error('No broker running');
    this.config.allowWrite = on;
    this.master.add({ side: 'master', dir: 'info', hex: '', text: on ? 'Writes pass through' : 'Writes blocked' });
    this.publish();
  }

  async connect(side: Side, path: string, baud: number) {
    if (!this.config || !this.running) throw new Error('Start the broker first');
    await this.disconnect(side);
    this.errors[side] = null;
    this.config[side] = { path, baud };
    const log = side === 'from' ? this.master : this.slave;
    try {
      const port = await openPort(path, baud, 'Broker');
      this.attach(side, port);
      log.add({ side: side === 'from' ? 'master' : 'slave', dir: 'info', hex: '', text: `Connected ${path} @ ${baud}` });
    } catch (err) {
      this.errors[side] = (err as Error).message;
      this.publish();
      throw err;
    }
    this.publish();
  }

  /** Attaches an already-open port (tests use in-memory ports). */
  attach(side: Side, port: DiagPort) {
    this.ports[side] = port;
    port.on('error', (err: Error) => {
      this.errors[side] = err.message;
      this.publish();
    });
    port.once('close', () => {
      if (this.ports[side] === port) {
        this.ports[side] = null;
        this.publish();
      }
    });
    if (side === 'from') {
      this.assembler?.dispose();
      this.assembler = new RequestAssembler(this.config!.type, (f) => this.enqueue(f));
      port.on('data', (chunk: Buffer) => this.assembler?.push(chunk));
    } else {
      port.on('data', (chunk: Buffer) => this.slaveWaiter?.(chunk));
    }
  }

  async disconnect(side: Side) {
    const port = this.ports[side];
    this.ports[side] = null;
    if (side === 'from') {
      this.assembler?.dispose();
      this.assembler = null;
    }
    if (port) {
      await releasePort(port);
      (side === 'from' ? this.master : this.slave).add({ side: side === 'from' ? 'master' : 'slave', dir: 'info', hex: '', text: `Disconnected ${port.path}` });
    }
    this.publish();
  }

  private enqueue(frame: Buffer) {
    const run = this.queue.then(() => this.handle(frame));
    this.queue = run.catch((err) => this.master.add({ side: 'master', dir: 'error', hex: '', text: (err as Error).message }));
  }

  private logFrame(log: RingLog, side: string, dir: 'rx' | 'tx', f: Buffer) {
    const info = detect(f);
    log.add({ side, dir, hex: toHex(f), text: info.type === 'string' ? printable(f) : describe(f), type: info.type });
  }

  /** Handles one master request; exposed for tests. */
  async handle(frame: Buffer): Promise<Buffer | null> {
    if (!this.config) return null;
    this.stats.requests++;
    this.logFrame(this.master, 'master', 'rx', frame);
    const reply = this.config.type === 'modbus' ? await this.handleModbus(frame) : await this.handleText(frame);
    if (reply) {
      this.stats.answered++;
      this.logFrame(this.master, 'master', 'tx', reply);
      await this.ports.from?.write(reply).catch((err) => this.master.add({ side: 'master', dir: 'error', hex: '', text: (err as Error).message }));
    }
    return reply;
  }

  /** Sends a request on the To port and waits for its reply. Null on timeout / not connected. */
  async forward(req: Buffer): Promise<Buffer | null> {
    const port = this.ports.to;
    if (!port?.isOpen || !this.config) return null;
    const type = this.config.type;
    this.stats.forwarded++;
    this.logFrame(this.slave, 'slave', 'tx', req);
    const reply = await new Promise<Buffer | null>((resolve) => {
      let buf = Buffer.alloc(0);
      let idle: NodeJS.Timeout | null = null;
      const finish = (v: Buffer | null) => {
        clearTimeout(timeout);
        if (idle) clearTimeout(idle);
        this.slaveWaiter = null;
        resolve(v);
      };
      const timeout = setTimeout(() => finish(buf.length ? buf : null), this.forwardTimeoutMs);
      this.slaveWaiter = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (type === 'modbus') {
          const len = modbusReplyLength(req, buf);
          if (len && buf.length >= len) return finish(buf.subarray(0, len));
          if (!len) {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => finish(buf), 50);
          }
        } else if (buf.includes(0x0d)) finish(buf.subarray(0, buf.indexOf(0x0d) + 1));
      };
      port.write(req).catch(() => finish(null));
    });
    if (reply) this.logFrame(this.slave, 'slave', 'rx', reply);
    else this.slave.add({ side: 'slave', dir: 'error', hex: '', text: 'No response' });
    return reply;
  }

  private gridsFor(address: number, fn: number) {
    return this.config!.tables.filter((t) => t.address === address && t.fn === fn);
  }

  /** Value of a register from the grids: number, null (cell empty) or undefined (no cell). */
  private cell(address: number, fn: number, reg: number): number | null | undefined {
    for (const t of this.gridsFor(address, fn)) {
      const i = reg - t.start;
      if (i >= 0 && i < t.values.length) return t.values[i];
    }
    return undefined;
  }

  private async handleModbus(req: Buffer): Promise<Buffer | null> {
    const info = decodeModbus(req);
    if (!info) return null;
    const { address, fn } = info;
    const respondAs = (t?: ModbusTable) => (t?.respondAddress ?? null) !== null ? (t!.respondAddress as number) : address;

    if ((fn === 3 || fn === 4) && info.register !== null && info.count !== null) {
      const grids = this.gridsFor(address, fn);
      if (!grids.length) {
        const fwd = await this.forward(req);
        if (!fwd) this.stats.misses++;
        return fwd;
      }
      const regs = Array.from({ length: info.count }, (_, i) => info.register! + i);
      const cells = regs.map((r) => this.cell(address, fn, r));
      let values: number[];
      const needsDevice = cells.some((c) => c === null || c === undefined);
      const fwd = needsDevice ? await this.forward(req) : null;
      const fwdInfo = fwd ? decodeModbus(fwd) : null;
      if (fwdInfo?.kind === 'response' && fwdInfo.values?.length === info.count) {
        values = fwdInfo.values.map((v, i) => (cells[i] === null || cells[i] === undefined ? v : reg16(cells[i] as number)));
      } else {
        values = cells.map((c) => reg16(c ?? null));
      }
      const body = Buffer.alloc(3 + values.length * 2);
      body[0] = respondAs(grids[0]);
      body[1] = fn;
      body[2] = values.length * 2;
      values.forEach((v, i) => body.writeUInt16BE(v, 3 + i * 2));
      return withModbusCrc(body);
    }

    if ((fn === 6 || fn === 16) && info.register !== null && info.values) {
      // Update the matching holding-register grid cells.
      info.values.forEach((v, i) => {
        for (const t of this.gridsFor(address, 3)) {
          const idx = info.register! + i - t.start;
          if (idx >= 0 && idx < t.values.length) t.values[idx] = v;
        }
      });
      if (this.config!.allowWrite) {
        const fwd = await this.forward(req);
        if (fwd) {
          this.publish();
          return fwd;
        }
      } else {
        this.master.add({ side: 'master', dir: 'info', hex: '', text: `Write to ${info.register} not passed through (write disabled)` });
      }
      this.publish();
      // fn 6 echoes the request; fn 16 replies addr, fn, register, count. Both are the first 6 bytes.
      const ack = Buffer.from(req.subarray(0, 6));
      ack[0] = respondAs(this.gridsFor(address, 3)[0]);
      return withModbusCrc(ack);
    }

    const fwd = await this.forward(req);
    if (!fwd) this.stats.misses++;
    return fwd;
  }

  private async handleText(req: Buffer): Promise<Buffer | null> {
    const cfg = this.config!;
    const key = textKey(cfg.type, req);
    const row = cfg.responses.find((r) => r.request === key);
    const isWrite = cfg.type === 'voltronic' && !/^Q/i.test(key);
    if (row && !(isWrite && cfg.allowWrite && this.ports.to?.isOpen)) {
      return cfg.type === 'voltronic' ? voltronicReply(row.response) : Buffer.from(row.response.replace(/\r?$/, '\r'), 'latin1');
    }
    if (isWrite && !cfg.allowWrite) {
      this.master.add({ side: 'master', dir: 'info', hex: '', text: `${key} not passed through (write disabled)` });
      return voltronicReply('ACK');
    }
    const fwd = await this.forward(req);
    if (!fwd) {
      this.stats.misses++;
      this.master.add({ side: 'master', dir: 'miss', hex: toHex(req), text: `MISS: ${key}` });
      return cfg.type === 'voltronic' ? voltronicReply('NAK') : null;
    }
    // Learn the reply so the broker can answer it alone next time.
    if (!isWrite && !row) {
      const v = cfg.type === 'voltronic' ? decodeVoltronic(fwd) : null;
      const text = v ? v.text : textKey(cfg.type, fwd);
      cfg.responses.push({ request: key, response: text });
      this.publish();
    }
    return fwd;
  }
}

export const broker = new Broker();
