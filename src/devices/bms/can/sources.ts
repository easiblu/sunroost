/**
 * Where CAN frames come from. Every source only listens: SocketCAN interfaces are brought up
 * with `listen-only on`, and the serial analysers are put in silent mode, so we never ACK or
 * transmit on the inverter↔battery link.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { exec, execPriv } from '../../../system/exec.ts';
import { ADAPTER_SERIAL_BAUD, adapterConfigFrame, parseCandumpLine, SerialCanDecoder, type CanFrame } from './frames.ts';

export interface CanSource {
  readonly name: string;
  open(onFrame: (f: CanFrame) => void): Promise<void>;
  close(): Promise<void>;
  /** Set when the source died after opening (candump exited, port unplugged …). */
  failure: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- SocketCAN (gs_usb / candleLight cable, Waveshare in gs_usb mode, slcan via slcand) ----

export const bringUpCommand = (iface: string, bitrate: number) =>
  `sudo ip link set ${iface} up type can bitrate ${bitrate} listen-only on`;

export class SocketCanSource implements CanSource {
  readonly name: string;
  private bitrate: number;
  private proc: ChildProcess | null = null;
  failure: string | null = null;

  constructor(iface: string, bitrate: number) {
    this.name = iface;
    this.bitrate = bitrate;
  }

  /** Brings the interface up in listen-only mode when it is down (needs root). */
  private async bringUp() {
    const iface = this.name;
    const show = await exec('ip', ['-details', 'link', 'show', iface], { timeout: 3000 });
    if (!show.ok) {
      if (/does not exist|cannot find device/i.test(show.message)) {
        throw new Error(`CAN interface ${iface} not found: plug in the USB CAN adapter or check the interface name`);
      }
      return; // no iproute2 (not Linux): let candump report the problem
    }
    const flags = /<([^>]*)>/.exec(show.stdout)?.[1].split(',') ?? [];
    if (flags.includes('UP')) return; // already configured (perhaps by the user); leave it alone
    const args = ['link', 'set', iface, 'up', 'type', 'can', 'bitrate', String(this.bitrate), 'listen-only', 'on'];
    const r = await execPriv('ip', args, { timeout: 5000 });
    if (!r.ok) {
      throw new Error(`Could not bring up ${iface} (${r.message || 'failed'}). Run: ${bringUpCommand(iface, this.bitrate)}`);
    }
  }

  async open(onFrame: (f: CanFrame) => void) {
    this.failure = null;
    await this.bringUp();
    const proc = spawn('candump', ['-L', this.name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-500)));
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      const f = parseCandumpLine(line);
      if (f) onFrame(f);
    });
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', (err: NodeJS.ErrnoException) =>
        reject(new Error(err.code === 'ENOENT' ? 'candump not found: install can-utils (sudo apt-get install can-utils)' : err.message)),
      );
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.failure = `candump exited (${code ?? 'signal'}): ${stderr.trim() || 'no output'}`;
    });
    this.proc = proc;
  }

  async close() {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) p.kill();
  }
}

// ---- USB-serial analysers (Waveshare USB-CAN-A, Seeed USB-CAN Analyzer) ---------------

export interface RawPort {
  open(onData: (chunk: Buffer) => void, onClose: (why: string) => void): Promise<void>;
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export type RawPortFactory = (path: string, baudRate: number) => RawPort;

export const serialRawPort: RawPortFactory = (path, baudRate) => {
  let port: import('serialport').SerialPort | null = null;
  return {
    async open(onData, onClose) {
      const { SerialPort } = await import('serialport');
      const p = new SerialPort({ path, baudRate, autoOpen: false });
      await new Promise<void>((resolve, reject) => p.open((err) => (err ? reject(err) : resolve())));
      p.on('data', onData);
      p.on('error', () => {});
      p.on('close', () => onClose(`${path} closed`));
      port = p;
    },
    write(data) {
      const p = port;
      if (!p) return Promise.reject(new Error(`${path}: port not open`));
      return new Promise((resolve, reject) => p.write(data, (err) => (err ? reject(err) : p.drain((e) => (e ? reject(e) : resolve())))));
    },
    async close() {
      const p = port;
      port = null;
      if (p?.isOpen) await new Promise<void>((resolve) => p.close(() => resolve()));
    },
  };
};

export type SerialAdapter = 'waveshare' | 'seeed' | 'auto';

export class SerialCanSource implements CanSource {
  readonly name: string;
  private adapter: SerialAdapter;
  private bitrate: number;
  private port: RawPort;
  private frames = 0;
  private closing = false;
  /** How long auto-detect waits for frames after configuring as Waveshare before trying Seeed. */
  detectMs: number;
  failure: string | null = null;

  constructor(path: string, adapter: SerialAdapter, bitrate: number, factory: RawPortFactory = serialRawPort, detectMs = 2500) {
    this.name = path;
    this.adapter = adapter;
    this.bitrate = bitrate;
    this.port = factory(path, ADAPTER_SERIAL_BAUD);
    this.detectMs = detectMs;
  }

  async open(onFrame: (f: CanFrame) => void) {
    this.failure = null;
    this.closing = false;
    this.frames = 0;
    // Accept both framings whatever we configured: harmless and helps if the adapter keeps an old mode.
    const decoder = new SerialCanDecoder('any');
    await this.port.open(
      (chunk) => {
        for (const f of decoder.push(chunk)) {
          this.frames++;
          onFrame(f);
        }
      },
      (why) => {
        if (!this.closing) this.failure = why;
      },
    );
    const configure = (variable: boolean) => this.port.write(adapterConfigFrame({ variable, bitrate: this.bitrate, listenOnly: true }));
    if (this.adapter === 'seeed') return configure(false);
    await configure(true);
    if (this.adapter === 'waveshare') return;
    // Auto: Waveshare variable framing first; nothing decodable → Seeed fixed framing.
    for (let t = 0; t < this.detectMs && !this.frames; t += 100) await sleep(100);
    if (!this.frames) await configure(false);
  }

  async close() {
    this.closing = true;
    await this.port.close();
  }
}
