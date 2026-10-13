/**
 * Eybond ("EyeBond") WiFi dongles: the "WiFi Plug Pro", "WIFI-VM" and similar collectors shipped with
 * Sumry/Anenji/Easun SMG/PowMr/Vevor, some SRNE and many Voltronic-like inverters, configured with
 * the SmartESS / WatchPower / SmartValue apps.
 *
 * Unlike a Solarman logger the dongle is a TCP *client*: it dials out to its cloud server
 * (ess.eybond.com, TCP 502) and the server drives it. To use one locally Sunroost becomes that server:
 * EybondServer listens, the dongle connects in, and requests flow server → dongle → RS485/RS232.
 *
 * Framing (every frame, both directions), big-endian:
 *
 *   tid u16 | devcode u16 | length u16 | devaddr u8 | fcode u8 | payload
 *
 * `length` counts the bytes after itself (devaddr + fcode + payload = payload + 2), like a Modbus
 * TCP MBAP header. There is no start byte and no checksum on the envelope. Function codes:
 *   1  heartbeat. Server → dongle: 6 date bytes (year-2000, month, day, hour, minute, second, UTC)
 *      + reporting interval u16 (s). Dongle → server: its PN (14 ASCII characters, e.g. "W0012345678901").
 *      Some firmware also sends a heartbeat on its own; we answer that with the date payload.
 *   2  query collector parameter (payload: parameter numbers; reply: status, parameter, ASCII value)
 *   3  set collector parameter   (payload: parameter, ASCII value; reply: status, parameter)
 *   4  forward to device: payload is a raw Modbus RTU frame (with CRC) for the inverter's serial port;
 *      the reply payload is the inverter's raw RTU reply (empty if the inverter didn't answer).
 *
 * Redirection: the dongle listens on UDP 58899. The text "set>server=<ip>:<port>;" makes it open an
 * extra TCP session to <ip>:<port> (the SmartESS app uses this for its local mode); it answers
 * "rsp>server=…;". Community tools report this callback is NOT persistent: after a dongle reboot (or
 * when the session drops) it only dials its configured cloud server again. A persistent change is
 * collector parameter 21 (server host, port fixed at 502) via function 3, or DNS redirection of
 * ess.eybond.com to the Sunroost board (then listen on 502).
 *
 * Sources (facts only, no code copied): the reverse-engineering notes and READMEs of
 * github.com/alexeyden/openess, github.com/ubombi/ha-smartess-local, github.com/groove-max/ha-eybond-local
 * and github.com/jablonowskit/smartess. Confidence: header layout, length rule, FC 1/4, the 14-byte PN
 * and "set>server=…;" are confirmed by several independent projects with working hardware
 * (confident). Devcode for forwarded frames (projects use 1 or 0x0994; the dongle seems to ignore
 * it), FC 2/3 parameter numbers and the redirect's persistence are UNVERIFIED here.
 *
 * Some newer collectors speak an "AT" text dialect instead of this binary framing; not supported.
 */
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer, Socket, type AddressInfo, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parseReply, readRequest, serveRequest, writeRequest } from './rtu.ts';

/** Default listen port. 8899 is unprivileged and what community tools announce with set>server. */
export const EYBOND_PORT = 8899;
/** The cloud's port; a DNS-redirected or parameter-21-redirected dongle always dials this. */
export const EYBOND_CLOUD_PORT = 502;
/** UDP port the dongle listens on for "set>server=…;". */
export const EYBOND_UDP_PORT = 58899;

export const FC_HEARTBEAT = 1;
export const FC_QUERY_COLLECTOR = 2;
export const FC_SET_COLLECTOR = 3;
export const FC_FORWARD = 4;

/** Collector parameter numbers for FC 2/3 (UNVERIFIED, from community notes). */
export const COLLECTOR_PARAM = {
  pn: 2,
  firmware: 5,
  hardware: 6,
  protocol: 14,
  localIp: 16,
  /** Cloud server host. Writing it makes a redirect persistent (UNVERIFIED; port is fixed at 502). */
  server: 21,
  /** Apply / restart trigger. */
  restart: 29,
} as const;

const HEADER = 8;
const MAX_PAYLOAD = 1024;
const DEFAULT_DEVCODE = 1;

export interface EybondFrame {
  tid: number;
  devcode: number;
  devaddr: number;
  fcode: number;
  payload: Buffer;
}

export function encodeFrame(f: { tid: number; devcode?: number; devaddr?: number; fcode: number; payload?: Uint8Array }): Buffer {
  const payload = Buffer.from(f.payload ?? []);
  const b = Buffer.alloc(HEADER + payload.length);
  b.writeUInt16BE(f.tid & 0xffff, 0);
  b.writeUInt16BE((f.devcode ?? DEFAULT_DEVCODE) & 0xffff, 2);
  b.writeUInt16BE(payload.length + 2, 4);
  b.writeUInt8((f.devaddr ?? 1) & 0xff, 6);
  b.writeUInt8(f.fcode & 0xff, 7);
  payload.copy(b, HEADER);
  return b;
}

/**
 * Splits complete frames off the front of `buf`. The envelope has no sync byte or checksum, so a
 * nonsensical length (under 2 or over 1 KiB) means the stream is out of step: `bad` is set and the
 * caller should drop the connection.
 */
export function splitFrames(buf: Buffer): { frames: EybondFrame[]; rest: Buffer; bad: boolean } {
  const frames: EybondFrame[] = [];
  let i = 0;
  while (buf.length - i >= HEADER) {
    const len = buf.readUInt16BE(i + 4);
    if (len < 2 || len - 2 > MAX_PAYLOAD) return { frames, rest: Buffer.alloc(0), bad: true };
    const total = 6 + len;
    if (buf.length - i < total) break;
    frames.push({
      tid: buf.readUInt16BE(i),
      devcode: buf.readUInt16BE(i + 2),
      devaddr: buf[i + 6],
      fcode: buf[i + 7],
      payload: Buffer.from(buf.subarray(i + HEADER, i + total)),
    });
    i += total;
  }
  return { frames, rest: Buffer.from(buf.subarray(i)), bad: false };
}

/** Heartbeat payload sent by the server: UTC date/time and the reporting interval in seconds. */
export function heartbeatPayload(now = new Date(), intervalS = 60): Buffer {
  const b = Buffer.alloc(8);
  b[0] = (now.getUTCFullYear() - 2000) & 0xff;
  b[1] = now.getUTCMonth() + 1;
  b[2] = now.getUTCDate();
  b[3] = now.getUTCHours();
  b[4] = now.getUTCMinutes();
  b[5] = now.getUTCSeconds();
  b.writeUInt16BE(intervalS & 0xffff, 6);
  return b;
}

const PN_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** The dongle's PN from a heartbeat payload (ASCII, NUL-padded), or null if it isn't one. */
export function parsePn(payload: Uint8Array): string | null {
  const b = Buffer.from(payload);
  const nul = b.indexOf(0);
  const text = b.subarray(0, nul < 0 ? b.length : nul).toString('latin1').trim();
  return PN_RE.test(text) ? text : null;
}

/** "eybond://[port][/PN]" → listen port and optional dongle PN. Returns null for other strings. */
export function parseEybond(connection: string): { port: number; pn?: string } | null {
  const m = /^eybond:\/\/(\d{1,5})?(?:\/([A-Za-z0-9_-]{4,32}))?\/?$/i.exec(connection.trim());
  if (!m) return null;
  const port = m[1] ? Number(m[1]) : EYBOND_PORT;
  if (port < 1 || port > 65535) return null;
  return m[2] ? { port, pn: m[2] } : { port };
}

export const eybondConnection = (pn?: string, port = EYBOND_PORT) => `eybond://${port}${pn ? `/${pn}` : ''}`;

/** One connected dongle. Requests on it are serialised: one frame in flight at a time. */
export class EybondSession {
  readonly socket: Socket;
  readonly remoteAddress: string;
  pn: string | null = null;
  /** Devcode the dongle used in its own frames (informational). */
  dongleDevcode: number | null = null;
  lastSeen = Date.now();
  private tid = Math.floor(Math.random() * 0xffff);
  private heartbeatTids = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { tid: number; fcode: number; resolve: (f: EybondFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.remoteAddress = socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
  }

  get isOpen() {
    return !this.socket.destroyed;
  }

  nextTid() {
    this.tid = (this.tid + 1) & 0xffff;
    return this.tid;
  }

  sendHeartbeat(intervalS: number) {
    const tid = this.nextTid();
    this.heartbeatTids.add(tid);
    if (this.heartbeatTids.size > 16) this.heartbeatTids.delete(this.heartbeatTids.values().next().value!);
    this.socket.write(encodeFrame({ tid, devcode: 0, devaddr: 1, fcode: FC_HEARTBEAT, payload: heartbeatPayload(new Date(), intervalS) }));
  }

  /** Handles one incoming frame. Returns a PN when this frame identified the dongle. */
  onFrame(f: EybondFrame, intervalS: number): string | null {
    this.lastSeen = Date.now();
    if (f.devcode) this.dongleDevcode = f.devcode;
    const p = this.pending;
    if (p && f.tid === p.tid && f.fcode === p.fcode) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(f);
      return null;
    }
    if (f.fcode !== FC_HEARTBEAT) return null;
    const pn = parsePn(f.payload);
    const answer = !this.heartbeatTids.delete(f.tid);
    // A heartbeat the dongle started on its own gets the same date/interval answer as ours carries.
    if (answer) {
      this.socket.write(encodeFrame({ tid: f.tid, devcode: f.devcode, devaddr: f.devaddr, fcode: FC_HEARTBEAT, payload: heartbeatPayload(new Date(), intervalS) }));
    }
    if (pn && pn !== this.pn) {
      this.pn = pn;
      return pn;
    }
    return null;
  }

  /** Sends one frame and resolves with the dongle's reply (same tid and function). Serialised. */
  request(fcode: number, payload: Uint8Array, opts: { devaddr?: number; devcode?: number; timeoutMs?: number } = {}): Promise<EybondFrame> {
    const run = () =>
      new Promise<EybondFrame>((resolve, reject) => {
        if (!this.isOpen) return reject(new Error(`Dongle ${this.pn ?? this.remoteAddress} is not connected`));
        const tid = this.nextTid();
        const timeoutMs = opts.timeoutMs ?? 5000;
        const timer = setTimeout(() => {
          if (this.pending?.tid === tid) this.pending = null;
          reject(new Error(`No reply from dongle ${this.pn ?? this.remoteAddress} within ${timeoutMs} ms`));
        }, timeoutMs);
        this.pending = { tid, fcode, resolve, reject, timer };
        this.socket.write(encodeFrame({ tid, devcode: opts.devcode ?? DEFAULT_DEVCODE, devaddr: opts.devaddr ?? 1, fcode, payload }));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  failPending(err: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  /** Forwards one Modbus RTU frame to the inverter and returns its RTU reply. */
  async forward(rtu: Uint8Array, opts: { devcode?: number; timeoutMs?: number } = {}): Promise<Buffer> {
    const reply = await this.request(FC_FORWARD, rtu, { ...opts, devaddr: rtu[0] });
    if (reply.payload.length < 5) throw new Error('Dongle answered without inverter data (check the cable between dongle and inverter)');
    return reply.payload;
  }

  /** Reads one collector parameter (FC 2). Read-only. Parameter numbers are UNVERIFIED. */
  async queryParam(param: number, timeoutMs = 5000): Promise<{ status: number; param: number; value: string }> {
    const r = await this.request(FC_QUERY_COLLECTOR, Buffer.from([param & 0xff]), { timeoutMs });
    if (r.payload.length < 2) throw new Error('Collector query reply too short');
    return { status: r.payload[0], param: r.payload[1], value: r.payload.subarray(2).toString('latin1').replace(/\0+$/, '').trim() };
  }

  /**
   * Sets one collector parameter (FC 3). UNVERIFIED and changes the dongle's own configuration, so
   * only call it from an explicit user action (e.g. "make redirect permanent", parameter 21).
   */
  async setParam(param: number, value: string, timeoutMs = 5000): Promise<{ status: number; param: number }> {
    if (!/^[\x20-\x7e]*$/.test(value)) throw new Error('Collector parameter value must be printable ASCII');
    const r = await this.request(FC_SET_COLLECTOR, Buffer.concat([Buffer.from([param & 0xff]), Buffer.from(value, 'latin1')]), { timeoutMs });
    if (r.payload.length < 2) throw new Error('Collector set reply too short');
    return { status: r.payload[0], param: r.payload[1] };
  }

  close() {
    this.failPending(new Error('Dongle connection closed'));
    this.socket.destroy();
  }
}

export interface DongleInfo {
  pn: string;
  ip: string;
  connectedAt: number;
  lastSeen: number;
}

/**
 * TCP listener the dongles connect to. Keeps PN → session (learned from heartbeats), answers and
 * sends heartbeats. Emits 'dongle' (session) when a PN is learned and 'gone' (session) on close.
 */
export class EybondServer extends EventEmitter {
  readonly server: Server;
  readonly heartbeatS: number;
  private readonly all = new Set<EybondSession>();
  private readonly byPn = new Map<string, EybondSession>();
  private readonly connectedAt = new WeakMap<EybondSession, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { heartbeatS?: number } = {}) {
    super();
    this.heartbeatS = opts.heartbeatS ?? 60;
    this.server = createServer((sock) => this.accept(sock));
    this.server.on('error', (err) => this.emit('error', err));
  }

  listen(port = EYBOND_PORT, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => reject(err);
      this.server.once('error', fail);
      this.server.listen(port, host, () => {
        this.server.off('error', fail);
        this.timer = setInterval(() => {
          for (const s of this.all) if (s.isOpen) s.sendHeartbeat(this.heartbeatS);
        }, this.heartbeatS * 1000);
        this.timer.unref();
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  get port(): number | null {
    const a = this.server.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.all) s.close();
    this.all.clear();
    this.byPn.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(sock: Socket) {
    const s = new EybondSession(sock);
    this.all.add(s);
    this.connectedAt.set(s, Date.now());
    sock.setKeepAlive(true, 30_000);
    sock.setNoDelay(true);
    let buf: Buffer = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      const { frames, rest, bad } = splitFrames(Buffer.concat([buf, d]));
      buf = rest;
      for (const f of frames) {
        const pn = s.onFrame(f, this.heartbeatS);
        if (pn) this.register(s, pn);
      }
      if (bad) sock.destroy();
    });
    sock.on('close', () => {
      s.failPending(new Error(`Dongle ${s.pn ?? s.remoteAddress} disconnected`));
      this.all.delete(s);
      if (s.pn && this.byPn.get(s.pn) === s) this.byPn.delete(s.pn);
      this.emit('gone', s);
    });
    // Ask who it is straight away; the reply carries the PN.
    s.sendHeartbeat(this.heartbeatS);
  }

  private register(s: EybondSession, pn: string) {
    const old = this.byPn.get(pn);
    if (old && old !== s) old.close(); // the dongle reconnected; the old socket is stale
    this.byPn.set(pn, s);
    this.emit('dongle', s);
  }

  /** The live session for `pn`, or (no pn) the most recently identified one. */
  session(pn?: string): EybondSession | null {
    if (pn) {
      const s = this.byPn.get(pn);
      return s?.isOpen ? s : null;
    }
    let last: EybondSession | null = null;
    for (const s of this.byPn.values()) if (s.isOpen) last = s;
    return last;
  }

  /** Identified dongles currently connected. */
  dongles(): DongleInfo[] {
    return [...this.byPn.values()]
      .filter((s) => s.isOpen)
      .map((s) => ({ pn: s.pn!, ip: s.remoteAddress, connectedAt: this.connectedAt.get(s) ?? 0, lastSeen: s.lastSeen }));
  }

  /** Waits until the dongle with `pn` (or any dongle) has connected and identified itself. */
  waitForDongle(pn: string | undefined, timeoutMs: number): Promise<EybondSession> {
    const now = this.session(pn);
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const on = (s: EybondSession) => {
        if (pn && s.pn !== pn) return;
        clearTimeout(timer);
        this.off('dongle', on);
        resolve(s);
      };
      const timer = setTimeout(() => {
        this.off('dongle', on);
        reject(new Error(pn
          ? `Eybond dongle ${pn} has not connected to port ${this.port} within ${Math.round(timeoutMs / 1000)} s (point the dongle at this board first)`
          : `No Eybond dongle has connected to port ${this.port} within ${Math.round(timeoutMs / 1000)} s (point the dongle at this board first)`));
      }, timeoutMs);
      this.on('dongle', on);
    });
  }
}

// ---- one listener per port per process, shared by every client ----

const shared = new Map<number, { server: EybondServer; refs: number; ready: Promise<number> }>();

/** Returns the process-wide server for `port`, starting it on first use. Pair with releaseServer. */
export async function acquireServer(port = EYBOND_PORT): Promise<EybondServer> {
  let e = shared.get(port);
  if (!e) {
    const server = new EybondServer();
    server.on('error', () => {});
    e = { server, refs: 0, ready: server.listen(port) };
    shared.set(port, e);
    e.ready.catch(() => {
      if (shared.get(port) === e) shared.delete(port);
    });
  }
  e.refs++;
  try {
    await e.ready;
  } catch (err) {
    e.refs--;
    throw new Error(`Cannot listen for Eybond dongles on port ${port}: ${(err as Error).message}`);
  }
  return e.server;
}

export async function releaseServer(server: EybondServer): Promise<void> {
  for (const [port, e] of shared) {
    if (e.server !== server) continue;
    if (--e.refs > 0) return;
    shared.delete(port);
    await server.close();
    return;
  }
}

/** The running shared server on `port`, if any (for a UI listing connected dongles). */
export const sharedServer = (port = EYBOND_PORT): EybondServer | null => shared.get(port)?.server ?? null;

/**
 * A Modbus client for one dongle, shaped like SolarmanClient. connect() starts (or joins) the shared
 * listener and waits for the dongle. If the dongle drops and reconnects, later requests use the new
 * session automatically. Requests are serialised per dongle by the session.
 */
export class EybondClient {
  readonly port: number;
  /** The PN this client talks to; learned from the first dongle when none was given. */
  pn: string | undefined;
  timeoutMs: number;
  connectTimeoutMs: number;
  devcode: number | undefined;
  private server: EybondServer | null = null;
  private readonly ownServer: EybondServer | undefined;

  constructor(opts: { port?: number; pn?: string; timeoutMs?: number; connectTimeoutMs?: number; devcode?: number; server?: EybondServer }) {
    this.port = opts.port ?? EYBOND_PORT;
    this.pn = opts.pn;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 90_000;
    this.devcode = opts.devcode;
    this.ownServer = opts.server;
  }

  get isOpen() {
    return Boolean(this.server?.session(this.pn));
  }

  async connect(): Promise<void> {
    if (!this.server) this.server = this.ownServer ?? (await acquireServer(this.port));
    try {
      const s = await this.server.waitForDongle(this.pn, this.connectTimeoutMs);
      this.pn ??= s.pn ?? undefined;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s && !this.ownServer) await releaseServer(s);
  }

  private live(): EybondSession {
    const s = this.server?.session(this.pn);
    if (!s) throw new Error(`Eybond dongle${this.pn ? ` ${this.pn}` : ''} is not connected`);
    return s;
  }

  exchange(rtu: Uint8Array): Promise<Buffer> {
    try {
      return this.live().forward(rtu, { devcode: this.devcode, timeoutMs: this.timeoutMs });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async read(unit: number, fn: 3 | 4, start: number, count: number): Promise<number[]> {
    const req = readRequest(unit, fn, start, count);
    return parseReply(req, await this.exchange(req));
  }

  async write(unit: number, start: number, values: number[], multiple: boolean): Promise<void> {
    const req = writeRequest(unit, start, values, multiple);
    parseReply(req, await this.exchange(req));
  }

  /** Collector parameter query (FC 2), e.g. COLLECTOR_PARAM.firmware. */
  queryParam(param: number) {
    return this.live().queryParam(param, this.timeoutMs);
  }
}

// ---- redirection (user action only) ----

export const redirectCommand = (serverIp: string, serverPort: number) => `set>server=${serverIp}:${serverPort};`;

/** "rsp>server=1;" style answers → the value after '=', or null when it isn't one. */
export function parseRedirectReply(text: string): string | null {
  const m = /^\s*rsp>server=([^;]*);?\s*$/.exec(text);
  return m ? m[1] : null;
}

/** This board's IPv4 address on the route toward `ip` (no packet is sent). */
export function localIpToward(ip: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    s.on('error', (err) => {
      s.close();
      reject(err);
    });
    s.connect(9, ip, () => {
      const addr = s.address().address;
      s.close();
      resolve(addr);
    });
  });
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const a of Object.values(networkInterfaces()).flat()) {
    if (!a || a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number);
    const mask = a.netmask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mask[i] & 0xff)) & 0xff).join('.'));
  }
  return [...out];
}

function sendUdp(targets: string[], text: string, port: number, waitMs: number, onReply: (from: string, msg: string) => boolean | void): Promise<void> {
  return new Promise((resolve) => {
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      try {
        s.close();
      } catch {}
      resolve();
    };
    s.on('error', done);
    s.on('message', (msg, rinfo) => {
      if (onReply(rinfo.address, msg.toString('latin1')) === true) done();
    });
    s.bind(0, () => {
      try {
        s.setBroadcast(true);
      } catch {}
      for (const t of targets) s.send(text, port, t, () => {});
      timer = setTimeout(done, waitMs);
    });
  });
}

/**
 * UNVERIFIED. Tells the dongle at `dongleIp` to open a session to `serverIp:serverPort` by sending
 * "set>server=<ip>:<port>;" to UDP 58899. Reported as temporary: the dongle returns to its cloud
 * server after a reboot. Changes the dongle's behaviour, so ONLY call it from an explicit user action
 * (a button), never automatically. `serverIp` defaults to this board's address toward the dongle.
 * Resolves with the dongle's "rsp>server=…" value, or null if it didn't answer (it may still connect).
 */
export async function redirectDongle(
  dongleIp: string,
  serverIp?: string,
  serverPort = EYBOND_PORT,
  opts: { udpPort?: number; waitMs?: number } = {},
): Promise<{ command: string; reply: string | null }> {
  const ip = serverIp ?? (await localIpToward(dongleIp));
  const command = redirectCommand(ip, serverPort);
  let reply: string | null = null;
  await sendUdp([dongleIp], command, opts.udpPort ?? EYBOND_UDP_PORT, opts.waitMs ?? 3000, (from, msg) => {
    if (from !== dongleIp) return;
    reply = parseRedirectReply(msg) ?? msg.trim();
    return true;
  });
  return { command, reply };
}

export interface FoundDongle {
  ip: string;
  reply: string;
}

/**
 * UNVERIFIED. Dongles have no separate discovery request; the only known probe is the same
 * "set>server=…;" broadcast, which every dongle that hears it answers AND acts on (it dials
 * serverIp:serverPort). So this is a redirect of every dongle on the LAN: user action only. The PNs
 * arrive when the dongles connect to the server (see EybondServer.dongles()).
 */
export async function discoverEybond(
  serverIp: string,
  serverPort = EYBOND_PORT,
  opts: { waitMs?: number; targets?: string[]; udpPort?: number } = {},
): Promise<FoundDongle[]> {
  const found = new Map<string, FoundDongle>();
  await sendUdp(opts.targets ?? broadcastAddresses(), redirectCommand(serverIp, serverPort), opts.udpPort ?? EYBOND_UDP_PORT, opts.waitMs ?? 3000, (from, msg) => {
    const v = parseRedirectReply(msg);
    if (v !== null) found.set(from, { ip: from, reply: v });
  });
  return [...found.values()];
}

// ---- test helper ----

export interface FakeDongle {
  socket: Socket;
  /** Resolves once the TCP connection is up. */
  connected: Promise<void>;
  /** Forward requests received so far. */
  forwarded: number;
  /** Most forward requests that were ever outstanding at once (1 when the server serialises). */
  maxInFlight: number;
  close(): void;
}

/**
 * A fake dongle for tests and the simulator: connects to host:port as a client, optionally sends an
 * unsolicited heartbeat with its PN, answers heartbeat requests with its PN, forwarded Modbus from
 * register maps (after `replyDelayMs`; not at all when `mute`), and FC 2 queries from `params`.
 */
export function fakeDongle(opts: {
  port: number;
  host?: string;
  pn: string;
  input?: Map<number, number>;
  holding?: Map<number, number>;
  params?: Map<number, string>;
  unsolicitedHeartbeat?: boolean;
  replyDelayMs?: number;
  mute?: boolean;
}): FakeDongle {
  const maps = { input: opts.input ?? new Map<number, number>(), holding: opts.holding ?? new Map<number, number>() };
  const params = opts.params ?? new Map<number, string>();
  const socket = new Socket();
  let inFlight = 0;
  const pnPayload = () => {
    const b = Buffer.alloc(Math.max(14, opts.pn.length));
    b.write(opts.pn, 'latin1');
    return b;
  };
  const fake: FakeDongle = {
    socket,
    connected: new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(opts.port, opts.host ?? '127.0.0.1', () => {
        socket.off('error', reject);
        socket.on('error', () => {});
        if (opts.unsolicitedHeartbeat) socket.write(encodeFrame({ tid: 0x7000, devcode: 0x0994, devaddr: 0xff, fcode: FC_HEARTBEAT, payload: pnPayload() }));
        resolve();
      });
    }),
    forwarded: 0,
    maxInFlight: 0,
    close: () => socket.destroy(),
  };
  let buf: Buffer = Buffer.alloc(0);
  socket.on('data', (d) => {
    const { frames, rest } = splitFrames(Buffer.concat([buf, d]));
    buf = rest;
    for (const f of frames) {
      const reply = (payload: Uint8Array) => {
        if (!socket.destroyed) socket.write(encodeFrame({ tid: f.tid, devcode: f.devcode, devaddr: f.devaddr, fcode: f.fcode, payload }));
      };
      if (f.fcode === FC_HEARTBEAT) {
        // A request from the server carries the 8-byte date; answer with our PN. Ignore answers
        // to our own unsolicited heartbeat.
        if (f.tid !== 0x7000) reply(pnPayload());
      } else if (f.fcode === FC_FORWARD) {
        fake.forwarded++;
        if (opts.mute) continue;
        inFlight++;
        fake.maxInFlight = Math.max(fake.maxInFlight, inFlight);
        const answer = serveRequest(f.payload, maps);
        setTimeout(() => {
          inFlight--;
          reply(answer);
        }, opts.replyDelayMs ?? 0);
      } else if (f.fcode === FC_QUERY_COLLECTOR) {
        const p = f.payload[0] ?? 0;
        const v = params.get(p);
        reply(Buffer.concat([Buffer.from([v === undefined ? 1 : 0, p]), Buffer.from(v ?? '', 'latin1')]));
      } else if (f.fcode === FC_SET_COLLECTOR) {
        const p = f.payload[0] ?? 0;
        params.set(p, f.payload.subarray(1).toString('latin1'));
        reply(Buffer.from([0, p]));
      }
    }
  });
  return fake;
}
