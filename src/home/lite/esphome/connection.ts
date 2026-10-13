/**
 * One connection to an ESPHome device's native API (TCP 6053).
 *
 * Plaintext frames: 0x00, varint(length), varint(type), protobuf.
 * Encrypted frames: 0x01, uint16 BE length, payload. The client first sends an empty "hello" frame
 * and a handshake frame (0x00 + Noise message 1); the device answers with a server-hello frame
 * (0x01 + node name \0 [+ mac \0]) and a handshake frame (0x00 + Noise message 2, or non-zero +
 * an error such as "Handshake MAC failure"). After that each frame is encrypted
 * uint16 BE type + uint16 BE length + protobuf.
 */
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { NoiseError, NoiseHandshake, parsePsk, type CipherState } from './noise.ts';
import { Fields, MSG, readVarint, Writer, encodeVarint } from './proto.ts';

/** First API minor version (1.x) without password login (ESPHome 2026.1). */
export const LOGIN_REMOVED_MINOR = 14;

export type EspErrorCode = 'cannot_connect' | 'invalid_key' | 'requires_encryption' | 'no_encryption' | 'invalid_password' | 'timeout' | 'protocol';

export class EspError extends Error {
  code: EspErrorCode;
  constructor(code: EspErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface EspOptions {
  host: string;
  port?: number;
  /** base64 API encryption key; empty = plaintext. */
  key?: string;
  /** Legacy API password. */
  password?: string;
  timeoutMs?: number;
}

export interface DeviceInfo {
  name: string;
  friendlyName: string;
  mac: string;
  esphomeVersion: string;
  model: string;
  manufacturer: string;
  usesPassword: boolean;
}

export interface Hello {
  name: string;
  serverInfo: string;
  apiMajor: number;
  apiMinor: number;
}

export class EspConnection extends EventEmitter<{ message: [number, Fields]; close: [string] }> {
  readonly opts: Required<Pick<EspOptions, 'host' | 'port' | 'timeoutMs'>> & EspOptions;
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private encrypted: boolean;
  private send_: CipherState | null = null;
  private recv: CipherState | null = null;
  private handshake: NoiseHandshake | null = null;
  /** Handshake progress: waiting for server hello, then for the handshake answer. */
  private hsStage: 'hello' | 'handshake' | 'done' = 'done';
  private waiters: { type: number; resolve: (f: Fields) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private hsWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private closed = false;
  serverName = '';

  constructor(opts: EspOptions) {
    super();
    this.opts = { port: 6053, timeoutMs: 10_000, ...opts };
    this.encrypted = !!opts.key?.trim();
  }

  get connected() {
    return !!this.sock && !this.closed;
  }

  /** TCP + (encryption handshake) + hello + login. Throws EspError. */
  async open(clientInfo = 'Sunroost'): Promise<Hello> {
    let psk: Buffer | null = null;
    if (this.encrypted) {
      try {
        psk = parsePsk(this.opts.key!);
      } catch (err) {
        throw new EspError('invalid_key', (err as Error).message);
      }
    }
    await new Promise<void>((resolve, reject) => {
      const s = connect({ host: this.opts.host, port: this.opts.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new EspError('cannot_connect', `No answer from ${this.opts.host}:${this.opts.port}`));
      }, this.opts.timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        this.sock = s;
        resolve();
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(new EspError('cannot_connect', `Can't connect to ${this.opts.host}:${this.opts.port} (${err.message})`));
      });
    });
    const s = this.sock!;
    s.on('data', (d) => this.onData(d));
    s.on('close', () => this.onClose('Connection closed'));
    s.on('error', () => {});

    if (psk) {
      this.handshake = new NoiseHandshake(psk, true);
      this.hsStage = 'hello';
      const msg1 = Buffer.concat([Buffer.from([0]), this.handshake.writeMessage1()]);
      const header = Buffer.from([0x01, (msg1.length >> 8) & 0xff, msg1.length & 0xff]);
      s.write(Buffer.concat([Buffer.from([0x01, 0x00, 0x00]), header, msg1]));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new EspError('timeout', 'The device did not finish the encryption handshake')), this.opts.timeoutMs);
        this.hsWaiter = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
      }).catch((err) => {
        this.close();
        throw err;
      });
    }

    try {
      const hello = await this.request(
        MSG.HelloRequest,
        new Writer().str(1, clientInfo).varint(2, 1).varint(3, 10).bytes(),
        MSG.HelloResponse,
      );
      const apiMajor = hello.uint(1);
      const apiMinor = hello.uint(2);
      // ESPHome 2026.1 (API 1.14+) removed password login and authenticates after hello; older
      // firmware needs the (possibly empty) password message first.
      if (this.opts.password || apiMajor < 1 || (apiMajor === 1 && apiMinor < LOGIN_REMOVED_MINOR)) {
        const login = await this.request(MSG.ConnectRequest, new Writer().str(1, this.opts.password ?? '').bytes(), MSG.ConnectResponse);
        if (login.bool(1)) throw new EspError('invalid_password', 'Wrong API password');
      }
      return { apiMajor, apiMinor, serverInfo: hello.str(3), name: hello.str(4) || this.serverName };
    } catch (err) {
      this.close();
      throw err;
    }
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const f = await this.request(MSG.DeviceInfoRequest, Buffer.alloc(0), MSG.DeviceInfoResponse);
    return {
      usesPassword: f.bool(1),
      name: f.str(2),
      mac: f.str(3).toLowerCase().replace(/[^0-9a-f]/g, ''),
      esphomeVersion: f.str(4),
      model: f.str(6),
      manufacturer: f.str(12) || 'Espressif',
      friendlyName: f.str(13),
    };
  }

  /** All ListEntities* responses up to Done. */
  listEntities(): Promise<{ type: number; f: Fields }[]> {
    return new Promise((resolve, reject) => {
      const out: { type: number; f: Fields }[] = [];
      const timer = setTimeout(() => {
        this.off('message', on);
        reject(new EspError('timeout', 'The device did not list its entities'));
      }, this.opts.timeoutMs);
      const on = (type: number, f: Fields) => {
        if (type === MSG.ListEntitiesDoneResponse) {
          clearTimeout(timer);
          this.off('message', on);
          resolve(out);
        } else if (type >= 12 && type <= 18 || [46, 49, 52, 61].includes(type)) out.push({ type, f });
      };
      this.on('message', on);
      this.send(MSG.ListEntitiesRequest, Buffer.alloc(0));
    });
  }

  /** Sends a request and waits for the given response type. */
  request(type: number, payload: Buffer, expect: number): Promise<Fields> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new EspError('timeout', 'The device did not answer'));
      }, this.opts.timeoutMs);
      this.waiters.push({ type: expect, resolve, reject, timer });
      this.send(type, payload);
    });
  }

  send(type: number, payload: Buffer) {
    if (!this.sock || this.closed) return;
    if (this.encrypted) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(type, 0);
      head.writeUInt16BE(payload.length, 2);
      const ct = this.send_!.encrypt(Buffer.concat([head, payload]));
      this.sock.write(Buffer.concat([Buffer.from([0x01, (ct.length >> 8) & 0xff, ct.length & 0xff]), ct]));
    } else {
      this.sock.write(Buffer.concat([Buffer.from([0x00]), encodeVarint(payload.length), encodeVarint(type), payload]));
    }
  }

  close() {
    if (this.closed) return;
    if (this.sock && this.hsStage === 'done') {
      try {
        this.send(MSG.DisconnectRequest, Buffer.alloc(0));
      } catch {}
    }
    this.sock?.end();
    this.sock?.destroy();
    this.onClose('Closed by Sunroost');
  }

  private onClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const err = new EspError(
      this.hsStage !== 'done' && this.encrypted ? 'no_encryption' : 'cannot_connect',
      this.hsStage !== 'done' && this.encrypted
        ? 'The device closed the connection during the encryption handshake (it may not use encryption: leave the key empty)'
        : reason,
    );
    this.hsWaiter?.reject(err);
    this.hsWaiter = null;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
    this.emit('close', reason);
  }

  private fail(err: EspError) {
    this.hsWaiter?.reject(err);
    this.hsWaiter = null;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
    this.close();
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    try {
      for (;;) {
        if (!this.buf.length) return;
        if (this.encrypted ? !this.readEncrypted() : !this.readPlain()) return;
      }
    } catch (err) {
      this.fail(err instanceof EspError ? err : new EspError('protocol', (err as Error).message));
    }
  }

  /** Returns false when a complete frame isn't buffered yet. */
  private readPlain(): boolean {
    if (this.buf[0] === 0x01) throw new EspError('requires_encryption', 'This device uses encryption: enter its API encryption key');
    if (this.buf[0] !== 0x00) throw new EspError('protocol', 'Unexpected data from the device');
    let len: { value: bigint; next: number };
    let type: { value: bigint; next: number };
    try {
      len = readVarint(this.buf, 1);
      type = readVarint(this.buf, len.next);
    } catch {
      return false;
    }
    const end = type.next + Number(len.value);
    if (this.buf.length < end) return false;
    const payload = this.buf.subarray(type.next, end);
    this.buf = this.buf.subarray(end);
    this.dispatch(Number(type.value), payload);
    return true;
  }

  private readEncrypted(): boolean {
    if (this.buf[0] !== 0x01) throw new EspError('no_encryption', "This device doesn't use encryption: leave the key empty");
    if (this.buf.length < 3) return false;
    const len = this.buf.readUInt16BE(1);
    if (this.buf.length < 3 + len) return false;
    const frame = this.buf.subarray(3, 3 + len);
    this.buf = this.buf.subarray(3 + len);
    if (this.hsStage === 'hello') {
      if (frame[0] !== 0x01) throw new EspError('protocol', 'The device offered an unknown encryption protocol');
      this.serverName = frame.subarray(1).toString('utf8').split('\0')[0];
      this.hsStage = 'handshake';
      return true;
    }
    if (this.hsStage === 'handshake') {
      if (frame[0] !== 0x00) {
        const msg = frame.subarray(1).toString('utf8');
        throw new EspError(/MAC failure/i.test(msg) ? 'invalid_key' : 'protocol', /MAC failure/i.test(msg) ? 'Wrong encryption key' : `Handshake failed: ${msg}`);
      }
      try {
        this.handshake!.readMessage2(frame.subarray(1));
      } catch (err) {
        throw new EspError(err instanceof NoiseError ? 'invalid_key' : 'protocol', 'Wrong encryption key');
      }
      [this.send_, this.recv] = this.handshake!.split();
      this.handshake = null;
      this.hsStage = 'done';
      this.hsWaiter?.resolve();
      this.hsWaiter = null;
      return true;
    }
    const plain = this.recv!.decrypt(frame);
    const type = plain.readUInt16BE(0);
    const n = plain.readUInt16BE(2);
    this.dispatch(type, plain.subarray(4, 4 + n));
    return true;
  }

  private dispatch(type: number, payload: Buffer) {
    const f = Fields.decode(payload);
    // Keep the connection alive and answer housekeeping requests.
    if (type === MSG.PingRequest) this.send(MSG.PingResponse, Buffer.alloc(0));
    else if (type === MSG.DisconnectRequest) {
      this.send(MSG.DisconnectResponse, Buffer.alloc(0));
      this.close();
      return;
    } else if (type === MSG.GetTimeRequest) this.send(MSG.GetTimeResponse, new Writer().fixed32(1, Math.floor(Date.now() / 1000)).bytes());
    const i = this.waiters.findIndex((w) => w.type === type);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(f);
    }
    this.emit('message', type, f);
  }
}
