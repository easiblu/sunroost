/**
 * One persistent connection to a Tuya device (TCP 6668). Negotiates the session key on 3.4/3.5, keeps the
 * link alive with heartbeats, emits `dps` for every status the device pushes, and `close` when the link goes.
 * Tuya devices accept only one local connection at a time.
 */
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  CMD, controlBody, decodeDevice, dpsOf, encodeClient, heartbeatBody, hmac, pack55aa, pack6699, queryBody, sessionKey,
  takeFrame, TuyaError, type Frame, type Version,
} from './protocol.ts';

export interface ConnOptions {
  host: string;
  port: number;
  deviceId: string;
  localKey: string;
  version: Version;
  timeoutMs?: number;
  heartbeatMs?: number;
}

interface Waiter {
  cmds: number[];
  resolve: (r: { frame: Frame; plain: Buffer }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class TuyaConnection extends EventEmitter<{ dps: [Record<string, unknown>]; close: [string] }> {
  private o: Required<ConnOptions>;
  private key: Buffer;
  private session: Buffer | null = null;
  private negotiating = false;
  private sock: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private seq = 1;
  private waiters: Waiter[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private closed = false;

  constructor(o: ConnOptions) {
    super();
    this.o = { timeoutMs: 5000, heartbeatMs: 10_000, ...o };
    this.key = Buffer.from(o.localKey, 'latin1');
  }

  get open() {
    return !!this.sock && !this.closed;
  }

  /** Connects (and negotiates the session key on 3.4/3.5). Rejects with TuyaError unreachable/auth/timeout. */
  async connect(): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      const s = connect({ host: this.o.host, port: this.o.port });
      this.sock = s;
      const timer = setTimeout(() => {
        s.destroy();
        reject(new TuyaError('unreachable', `Nothing answered at ${this.o.host}:${this.o.port}`));
      }, this.o.timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(new TuyaError('unreachable', `Can't connect to ${this.o.host}:${this.o.port} (${(err as NodeJS.ErrnoException).code ?? err.message})`));
      });
    });
    try {
      await opened;
    } catch (err) {
      // Never opened: no 'close' event will follow, so the caller handles the retry.
      this.closed = true;
      this.sock = null;
      throw err;
    }
    const s = this.sock!;
    s.on('error', () => {});
    s.on('data', (d) => this.onData(d));
    s.on('close', () => this.shutdown('The device closed the connection'));
    this.lastSeen = Date.now();
    if (this.o.version !== '3.3') {
      try {
        await this.negotiate();
      } catch (err) {
        this.close();
        throw err;
      }
    }
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > this.o.heartbeatMs * 3) return this.close('No answer to heartbeats');
      this.send(CMD.HEART_BEAT, heartbeatBody(this.o.deviceId));
    }, this.o.heartbeatMs);
  }

  close(reason = 'Closed') {
    this.sock?.destroy();
    this.shutdown(reason);
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new TuyaError(this.negotiating ? 'auth' : 'closed', this.negotiating ? 'The device dropped the connection during the key exchange (wrong local key or protocol version?)' : reason));
    }
    this.emit('close', reason);
  }

  /** The key the current frame/payload layer uses (local key until the session key exists). */
  private get cur() {
    return this.session ?? this.key;
  }

  private send(cmd: number, body: Buffer) {
    if (!this.sock || this.closed) throw new TuyaError('closed', 'Not connected');
    const v = this.o.version;
    const payload = encodeClient(v, this.cur, cmd, body);
    const frame = v === '3.5' ? pack6699(this.seq++, cmd, payload, this.cur) : pack55aa(this.seq++, cmd, payload, v === '3.4' ? this.cur : null);
    this.sock.write(frame);
  }

  private wait(cmds: number[]): Promise<{ frame: Frame; plain: Buffer }> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        cmds, resolve, reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new TuyaError(this.negotiating ? 'auth' : 'timeout', this.negotiating
            ? 'No answer to the key exchange (wrong local key or protocol version?)'
            : "The device didn't answer (wrong protocol version?)"));
        }, this.o.timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  private onData(d: Buffer) {
    this.lastSeen = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      let r;
      try {
        const v = this.o.version;
        r = takeFrame(this.buf, { hmacKey: v === '3.4' ? this.cur : null, gcmKey: v === '3.5' ? this.cur : null, fromDevice: true });
      } catch (err) {
        this.failAll(err as Error);
        return this.close((err as Error).message);
      }
      if (!r) return;
      this.buf = r.rest;
      this.onFrame(r.frame);
    }
  }

  private failAll(err: Error) {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private onFrame(frame: Frame) {
    let plain: Buffer;
    try {
      plain = decodeDevice(this.o.version, this.cur, frame.payload);
    } catch (err) {
      this.failAll(err as Error);
      return;
    }
    const text = plain.toString();
    if (/data unvalid|decrypt fail/i.test(text)) {
      this.failAll(new TuyaError('auth', `The device couldn't read Sunroost's message ("${text}"): wrong local key or protocol version`));
      return;
    }
    const i = this.waiters.findIndex((w) => w.cmds.includes(frame.cmd));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve({ frame, plain });
    }
    if (text.startsWith('{')) {
      try {
        const dps = dpsOf(JSON.parse(text));
        if (dps) this.emit('dps', dps);
      } catch {}
    }
  }

  private async negotiate() {
    this.negotiating = true;
    const localNonce = randomBytes(16);
    // Answers arrive on a later turn of the event loop, so waiting after sending can't miss them.
    this.send(CMD.SESS_KEY_NEG_START, localNonce);
    const { plain } = await this.wait([CMD.SESS_KEY_NEG_RESP]);
    if (plain.length < 48) throw new TuyaError('auth', 'Unexpected key-exchange answer (wrong local key or protocol version?)');
    const remoteNonce = plain.subarray(0, 16);
    if (!hmac(this.key, localNonce).equals(plain.subarray(16, 48))) {
      throw new TuyaError('auth', 'The device answered the key exchange with a different key: the local key is wrong');
    }
    this.send(CMD.SESS_KEY_NEG_FINISH, hmac(this.key, remoteNonce));
    this.session = sessionKey(this.o.version, this.key, localNonce, remoteNonce);
    this.negotiating = false;
  }

  /** Current data points. */
  async query(): Promise<Record<string, unknown>> {
    const { cmd, body } = queryBody(this.o.version, this.o.deviceId);
    this.send(cmd, body);
    const { plain } = await this.wait([CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.STATUS]);
    try {
      return dpsOf(JSON.parse(plain.toString())) ?? {};
    } catch {
      throw new TuyaError('protocol', 'The device sent an unreadable status');
    }
  }

  /** Sets data points; resolves on the device's acknowledgement (its status push follows). */
  async set(dps: Record<string, unknown>): Promise<void> {
    const { cmd, body } = controlBody(this.o.version, this.o.deviceId, dps);
    this.send(cmd, body);
    await this.wait([CMD.CONTROL, CMD.CONTROL_NEW, CMD.STATUS]);
  }
}
