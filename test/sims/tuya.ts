/**
 * A simulated Tuya device (protocol 3.3, 3.4 or 3.5) on a TCP port, answering like the firmware as
 * implemented by tinytuya: session key exchange, DP queries, control with an ack and a status push,
 * heartbeats, and the 3.3 "json obj data unvalid" answer when it can't decrypt a message.
 * It shares src/home/lite/tuya/protocol.ts, so it can't catch a mistake made in both places.
 */
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  CMD, decodeClient, encodeDevice, encodeDiscovery, hmac, pack55aa, pack6699, sessionKey, takeFrame, type Version,
} from '../../src/home/lite/tuya/protocol.ts';

interface Conn {
  sock: Socket;
  buf: Buffer;
  session: Buffer | null;
  localNonce: Buffer | null;
  remoteNonce: Buffer | null;
  seq: number;
}

export class TuyaSim {
  server: Server;
  port = 0;
  version: Version;
  key: Buffer;
  deviceId: string;
  dps: Record<string, unknown>;
  conns = new Set<Conn>();
  /** Every control message received (for assertions). */
  controls: Record<string, unknown>[] = [];

  constructor(o: { version: Version; localKey: string; deviceId: string; dps: Record<string, unknown> }) {
    this.version = o.version;
    this.key = Buffer.from(o.localKey, 'latin1');
    this.deviceId = o.deviceId;
    this.dps = { ...o.dps };
    this.server = createServer((sock) => this.accept(sock));
  }

  async start(port = 0): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop() {
    this.kill();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drops every connection (Wi-Fi blip). */
  kill() {
    for (const c of this.conns) c.sock.destroy();
    this.conns.clear();
  }

  /** Sends a discovery broadcast to 127.0.0.1:port (encrypted like port 6667, or clear like 6666). */
  broadcast(port: number, clear = false) {
    const s = createSocket('udp4');
    const msg = encodeDiscovery({ ip: '127.0.0.1', gwId: this.deviceId, active: 2, ability: 0, mode: 0, encrypt: !clear, productKey: 'keyjup78v54myhan', version: this.version }, clear);
    s.send(msg, port, '127.0.0.1', () => s.close());
  }

  /** The device changes by itself (button press): push a status to every connection. */
  change(dps: Record<string, unknown>) {
    Object.assign(this.dps, dps);
    for (const c of this.conns) this.status(c, dps);
  }

  private accept(sock: Socket) {
    const c: Conn = { sock, buf: Buffer.alloc(0), session: null, localNonce: null, remoteNonce: null, seq: 1 };
    this.conns.add(c);
    sock.on('close', () => this.conns.delete(c));
    sock.on('error', () => {});
    sock.on('data', (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      for (;;) {
        let r;
        const k = c.session ?? this.key;
        try {
          r = takeFrame(c.buf, { hmacKey: this.version === '3.4' ? k : null, gcmKey: this.version === '3.5' ? k : null, fromDevice: false });
        } catch {
          sock.destroy(); // can't verify the client's frame: a wrong key
          return;
        }
        if (!r) return;
        c.buf = r.rest;
        this.onFrame(c, r.frame.cmd, r.frame.payload);
      }
    });
  }

  private reply(c: Conn, cmd: number, body: Buffer, retcode = 0) {
    const v = this.version;
    const k = c.session ?? this.key;
    if (v === '3.5') return c.sock.write(pack6699(c.seq++, cmd, encodeDevice(v, k, cmd, body, retcode), k));
    c.sock.write(pack55aa(c.seq++, cmd, encodeDevice(v, k, cmd, body), v === '3.4' ? k : null, retcode));
  }

  private status(c: Conn, dps: Record<string, unknown>) {
    const t = Math.floor(Date.now() / 1000);
    const body = this.version === '3.3' ? { devId: this.deviceId, dps, t } : { protocol: 4, t, data: { dps } };
    this.reply(c, CMD.STATUS, Buffer.from(JSON.stringify(body)));
  }

  private onFrame(c: Conn, cmd: number, payload: Buffer) {
    const v = this.version;
    let plain: Buffer;
    try {
      plain = decodeClient(v, c.session ?? this.key, payload);
    } catch {
      if (v === '3.3') {
        // Real 3.3 devices answer in clear that they couldn't read the message.
        c.sock.write(pack55aa(c.seq++, cmd, Buffer.from('json obj data unvalid'), null, 1));
      } else c.sock.destroy();
      return;
    }
    switch (cmd) {
      case CMD.SESS_KEY_NEG_START: {
        c.localNonce = plain.subarray(0, 16);
        c.remoteNonce = randomBytes(16);
        this.reply(c, CMD.SESS_KEY_NEG_RESP, Buffer.concat([c.remoteNonce, hmac(this.key, c.localNonce)]));
        return;
      }
      case CMD.SESS_KEY_NEG_FINISH: {
        if (!c.remoteNonce || !c.localNonce || !plain.subarray(0, 32).equals(hmac(this.key, c.remoteNonce))) return void c.sock.destroy();
        c.session = sessionKey(v, this.key, c.localNonce, c.remoteNonce);
        return;
      }
      case CMD.DP_QUERY:
      case CMD.DP_QUERY_NEW: {
        let ok = true;
        try {
          JSON.parse(plain.toString());
        } catch {
          ok = false;
        }
        if (!ok) return void c.sock.write(pack55aa(c.seq++, cmd, Buffer.from('json obj data unvalid'), null, 1));
        const body = v === '3.3' ? { devId: this.deviceId, dps: this.dps, t: Math.floor(Date.now() / 1000) } : { dps: this.dps };
        this.reply(c, cmd, Buffer.from(JSON.stringify(body)));
        return;
      }
      case CMD.CONTROL:
      case CMD.CONTROL_NEW: {
        const j = JSON.parse(plain.toString()) as { dps?: Record<string, unknown>; data?: { dps?: Record<string, unknown> } };
        const dps = j.dps ?? j.data?.dps ?? {};
        this.controls.push(dps);
        Object.assign(this.dps, dps);
        this.reply(c, cmd, Buffer.alloc(0));
        setTimeout(() => this.status(c, dps), 20);
        return;
      }
      case CMD.HEART_BEAT:
        this.reply(c, CMD.HEART_BEAT, Buffer.alloc(0));
        return;
    }
  }
}
