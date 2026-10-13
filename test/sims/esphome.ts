/**
 * A simulated ESPHome device serving the native API (plaintext or Noise-encrypted), with a switch, a
 * power sensor, a dimmable light, a climate entity, a number, a select and a button. Field numbers
 * as in ESPHome 2026.9's api.proto. `apiMinor` < 14 plus `password` emulates old firmware with login.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { NoiseError, NoiseHandshake, parsePsk, type CipherState } from '../../src/home/lite/esphome/noise.ts';
import { encodeVarint, Fields, MSG, readVarint, Writer } from '../../src/home/lite/esphome/proto.ts';

export interface EsphomeSimOptions {
  key?: string;
  password?: string;
  apiMinor?: number;
  mac?: string;
  name?: string;
}

const KEY = { relay: 1, power: 2, lamp: 3, ac: 4, current: 5, mode: 6, reboot: 7 };

export class EsphomeSim {
  server: Server;
  port = 0;
  opts: EsphomeSimOptions;
  sockets = new Set<Socket>();
  state = { relay: false, lamp: false, brightness: 1, acMode: 0, acTarget: 24, current: 16, mode: 'eco', presses: 0 };
  received: number[] = [];

  constructor(opts: EsphomeSimOptions = {}) {
    this.opts = { apiMinor: 16, mac: 'AA:BB:CC:11:22:33', name: 'heat-pump', ...opts };
    this.server = createServer((s) => this.serve(s));
  }

  async start(port = 0): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  /** Drops every connection (device rebooting / Wi-Fi lost). */
  dropAll() {
    for (const s of this.sockets) s.destroy();
  }

  async stop() {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(sock: Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    const encrypted = !!this.opts.key;
    let buf = Buffer.alloc(0);
    let stage: 'hello' | 'handshake' | 'done' = encrypted ? 'hello' : 'done';
    let hs: NoiseHandshake | null = encrypted ? new NoiseHandshake(parsePsk(this.opts.key!), false) : null;
    let send: CipherState | null = null;
    let recv: CipherState | null = null;
    let authed = false;
    let subscribed = false;

    const frame = (payload: Buffer) => Buffer.concat([Buffer.from([0x01, payload.length >> 8, payload.length & 0xff]), payload]);
    const out = (type: number, payload: Buffer) => {
      if (sock.destroyed) return;
      if (encrypted) {
        const head = Buffer.alloc(4);
        head.writeUInt16BE(type, 0);
        head.writeUInt16BE(payload.length, 2);
        sock.write(frame(send!.encrypt(Buffer.concat([head, payload]))));
      } else {
        sock.write(Buffer.concat([Buffer.from([0]), encodeVarint(payload.length), encodeVarint(type), payload]));
      }
    };
    const states = () => {
      const s = this.state;
      out(MSG.SwitchStateResponse, new Writer().fixed32(1, KEY.relay).bool(2, s.relay).bytes());
      out(MSG.SensorStateResponse, new Writer().fixed32(1, KEY.power).float(2, s.relay ? 1234.56 : 0).bytes());
      out(MSG.LightStateResponse, new Writer().fixed32(1, KEY.lamp).bool(2, s.lamp).float(3, s.brightness).varint(11, 3).bytes());
      out(MSG.ClimateStateResponse, new Writer().fixed32(1, KEY.ac).varint(2, s.acMode).float(3, 27.5).float(4, s.acTarget).varint(8, s.acMode ? 2 : 0).bytes());
      out(MSG.NumberStateResponse, new Writer().fixed32(1, KEY.current).float(2, s.current).bytes());
      out(MSG.SelectStateResponse, new Writer().fixed32(1, KEY.mode).str(2, s.mode).bytes());
    };

    const handle = (type: number, f: Fields) => {
      this.received.push(type);
      const needAuth = (this.opts.apiMinor ?? 16) < 14 || !!this.opts.password;
      switch (type) {
        case MSG.HelloRequest:
          out(MSG.HelloResponse, new Writer().varint(1, 1).varint(2, this.opts.apiMinor).str(3, '2024.6.0').str(4, this.opts.name).bytes());
          if (!needAuth) authed = true;
          return;
        case MSG.ConnectRequest: {
          const bad = (this.opts.password ?? '') !== f.str(1);
          out(MSG.ConnectResponse, new Writer().bool(1, bad).bytes());
          if (bad) sock.end();
          else authed = true;
          return;
        }
        case MSG.PingRequest:
          return out(MSG.PingResponse, Buffer.alloc(0));
        case MSG.DisconnectRequest:
          out(MSG.DisconnectResponse, Buffer.alloc(0));
          return void sock.end();
      }
      if (!authed) return void sock.destroy();
      switch (type) {
        case MSG.DeviceInfoRequest:
          return out(MSG.DeviceInfoResponse, new Writer().bool(1, !!this.opts.password).str(2, this.opts.name).str(3, this.opts.mac).str(4, '2024.6.0')
            .str(6, 'esp32dev').str(12, 'Espressif').str(13, 'Heat pump').bytes());
        case MSG.ListEntitiesRequest: {
          out(MSG.ListEntitiesSwitchResponse, new Writer().str(1, 'relay').fixed32(2, KEY.relay).str(3, 'Relay').bytes());
          out(MSG.ListEntitiesSensorResponse, new Writer().str(1, 'power').fixed32(2, KEY.power).str(3, 'Power').str(6, 'W').varint(7, 1).str(9, 'power').bytes());
          out(MSG.ListEntitiesSensorResponse, new Writer().str(1, 'wifi_signal').fixed32(2, 99).str(3, 'WiFi signal').str(6, 'dBm').varint(13, 2).bytes());
          out(MSG.ListEntitiesLightResponse, new Writer().str(1, 'lamp').fixed32(2, KEY.lamp).str(3, 'Lamp').varint(12, 3).bytes());
          out(MSG.ListEntitiesClimateResponse, new Writer().str(1, 'ac').fixed32(2, KEY.ac).str(3, '').varint(7, 0).varint(7, 2).varint(7, 3)
            .float(8, 16).float(9, 30).float(10, 0.5).varint(27, 1).bytes());
          out(MSG.ListEntitiesNumberResponse, new Writer().str(1, 'current').fixed32(2, KEY.current).str(3, 'Current').float(6, 6).float(7, 32).float(8, 1).str(11, 'A').bytes());
          out(MSG.ListEntitiesSelectResponse, new Writer().str(1, 'mode').fixed32(2, KEY.mode).str(3, 'Mode').str(6, 'eco').str(6, 'boost').bytes());
          out(MSG.ListEntitiesButtonResponse, new Writer().str(1, 'reboot').fixed32(2, KEY.reboot).str(3, 'Reboot').bytes());
          return out(MSG.ListEntitiesDoneResponse, Buffer.alloc(0));
        }
        case MSG.SubscribeStatesRequest:
          subscribed = true;
          return states();
        case MSG.SwitchCommandRequest:
          if (f.fixed32(1) === KEY.relay) this.state.relay = f.bool(2);
          break;
        case MSG.LightCommandRequest:
          if (f.bool(2)) this.state.lamp = f.bool(3);
          if (f.bool(4)) this.state.brightness = f.float(5);
          break;
        case MSG.ClimateCommandRequest:
          if (f.bool(2)) this.state.acMode = f.int(3);
          if (f.bool(4)) this.state.acTarget = f.float(5);
          break;
        case MSG.NumberCommandRequest:
          this.state.current = f.float(2);
          break;
        case MSG.SelectCommandRequest:
          this.state.mode = f.str(2);
          break;
        case MSG.ButtonCommandRequest:
          this.state.presses++;
          return;
        default:
          return;
      }
      if (subscribed) states();
    };

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!buf.length) return;
        if (!encrypted) {
          if (buf[0] !== 0) {
            sock.destroy(); // Plaintext device: "Invalid preamble" and close.
            return;
          }
          let len: { value: bigint; next: number };
          let type: { value: bigint; next: number };
          try {
            len = readVarint(buf, 1);
            type = readVarint(buf, len.next);
          } catch {
            return;
          }
          const end = type.next + Number(len.value);
          if (buf.length < end) return;
          const payload = buf.subarray(type.next, end);
          buf = buf.subarray(end);
          handle(Number(type.value), Fields.decode(payload));
          continue;
        }
        if (buf[0] !== 0x01) {
          // A plaintext client talking to an encrypted device: answer in the encrypted framing, then close.
          sock.write(frame(Buffer.concat([Buffer.from([0x01]), Buffer.from('Bad indicator byte')])));
          sock.end();
          return;
        }
        if (buf.length < 3) return;
        const len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) return;
        const body = buf.subarray(3, 3 + len);
        buf = buf.subarray(3 + len);
        if (stage === 'hello') {
          stage = 'handshake'; // the empty client hello
          continue;
        }
        if (stage === 'handshake') {
          sock.write(frame(Buffer.concat([Buffer.from([0x01]), Buffer.from(`${this.opts.name}\0${this.opts.mac}\0`)])));
          try {
            hs!.readMessage1(body.subarray(1));
          } catch (err) {
            if (!(err instanceof NoiseError)) throw err;
            sock.write(frame(Buffer.concat([Buffer.from([0x01]), Buffer.from('Handshake MAC failure')])));
            sock.end();
            return;
          }
          sock.write(frame(Buffer.concat([Buffer.from([0x00]), hs!.writeMessage2()])));
          [send, recv] = hs!.split();
          hs = null;
          stage = 'done';
          continue;
        }
        const plain = recv!.decrypt(body);
        handle(plain.readUInt16BE(0), Fields.decode(plain.subarray(4, 4 + plain.readUInt16BE(2))));
      }
    });
  }
}
