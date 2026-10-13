/** A simulated WiZ bulb (or plug) on a UDP port, answering like the real firmware. */
import { createSocket, type Socket } from 'node:dgram';

export class WizSim {
  sock: Socket = createSocket('udp4');
  port = 0;
  state = { state: false, dimming: 100, temp: 2700 };
  mac: string;
  model: string;
  /** Stop answering (device offline). */
  silent = false;

  constructor(mac = 'a8bb50aabbcc', model = 'ESP01_SHDW1C_31') {
    this.mac = mac;
    this.model = model;
  }

  async start(): Promise<number> {
    this.sock.on('message', (buf, r) => {
      if (this.silent) return;
      const m = JSON.parse(buf.toString());
      const reply = (result: unknown) => this.sock.send(JSON.stringify({ method: m.method, env: 'pro', result }), r.port, r.address);
      if (m.method === 'registration') reply({ mac: this.mac, success: true });
      else if (m.method === 'getSystemConfig') reply({ mac: this.mac, homeId: 1, roomId: 1, moduleName: this.model, fwVersion: '1.26.0' });
      else if (m.method === 'getPilot') reply({ mac: this.mac, rssi: -55, ...this.state, sceneId: 0 });
      else if (m.method === 'setPilot') {
        Object.assign(this.state, m.params);
        reply({ success: true });
      }
    });
    await new Promise<void>((resolve) => this.sock.bind(0, '127.0.0.1', () => resolve()));
    this.port = (this.sock.address() as { port: number }).port;
    return this.port;
  }

  stop() {
    this.sock.close();
  }
}
