/**
 * Where messages go: an embedded aedes broker (the default: a local
 * mosquitto on port 1883) or a client connection to an external broker.
 * Both expose the same small interface to the publisher.
 */
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import type { AuthenticateError } from 'aedes';
import { connect, type MqttClient } from 'mqtt';
import { logger } from '../core/log.ts';
import { safeUrl } from './topics.ts';

const log = logger('mqtt');

// aedes is CommonJS and its module export is the factory itself.
const createBroker = createRequire(import.meta.url)('aedes') as typeof import('aedes').createBroker;
type Broker = ReturnType<typeof createBroker>;

export interface Transport {
  readonly kind: 'builtin' | 'external';
  /** True while messages can be delivered (built-in: listening; external: connected). */
  readonly connected: boolean;
  /** Clients connected to the built-in broker (0 for external). */
  readonly clients: number;
  readonly lastError: string | null;
  /** Called on every (re)connect, after which the publisher republishes everything. */
  onConnect: (() => void) | null;
  publish(topic: string, payload: string, retain: boolean): void;
  /** Subscribes to a topic filter; handler gets (topic, payload). */
  subscribe(filter: string, handler: (topic: string, payload: string) => void): void;
  /** Resolves when everything already published has been flushed. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface Credentials {
  username: string;
  password: string;
}

// ---------- Built-in broker ----------

export class BuiltinBroker implements Transport {
  readonly kind = 'builtin';
  connected = false;
  lastError: string | null = null;
  onConnect: (() => void) | null = null;
  private broker: Broker;
  private server: Server;
  private sockets = new Set<Socket>();
  private port: number;
  private host: string;

  constructor(port: number, host: string, creds: Credentials) {
    this.port = port;
    this.host = host;
    this.broker = createBroker({
      // With a username set, every client must present matching credentials.
      authenticate: (client, username, password, done) => {
        if (!creds.username) return done(null, true);
        const ok = username === creds.username && (password?.toString() ?? '') === creds.password;
        if (ok) return done(null, true);
        log.warn(`Rejected client ${client.id}: bad username or password.`);
        const err = new Error('Bad username or password') as AuthenticateError;
        err.returnCode = 4;
        done(err, null);
      },
    });
    this.broker.on('client', (c) => log.info(`Client connected: ${c.id}${remote(c.conn as Socket)}.`));
    this.broker.on('clientDisconnect', (c) => log.info(`Client disconnected: ${c.id}.`));
    // aedes reports each failed write separately; log the first real error per client only.
    const errored = new WeakSet<object>();
    this.broker.on('clientError', (c, err) => {
      if (errored.has(c) || /connection closed|username or password/i.test(err.message)) return;
      errored.add(c);
      log.warn(`Client ${c.id}: ${err.message}`);
    });
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      this.broker.handle(socket);
    });
  }

  get clients() {
    return this.broker.connectedClients;
  }

  /** Starts listening; resolves false (and records lastError) when the port is unavailable. */
  listen(): Promise<boolean> {
    return new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.lastError = err.code === 'EADDRINUSE' ? `Port ${this.port} is already in use` : err.message;
        log.error(`Built-in broker failed to start: ${this.lastError}`);
        resolve(false);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        this.server.on('error', (err) => log.error(`Built-in broker: ${err.message}`));
        this.connected = true;
        this.lastError = null;
        log.info(`Built-in broker listening on port ${this.boundPort}.`);
        this.onConnect?.();
        resolve(true);
      });
    });
  }

  /** The actual port (differs from the configured one when 0 was requested, as in tests). */
  get boundPort() {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  publish(topic: string, payload: string, retain: boolean) {
    if (!this.connected) return;
    this.broker.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain, dup: false }, () => {});
  }

  subscribe(filter: string, handler: (topic: string, payload: string) => void) {
    this.broker.subscribe(
      filter,
      (packet, cb) => {
        handler(packet.topic, packet.payload.toString());
        cb();
      },
      () => {},
    );
  }

  flush() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  close() {
    this.connected = false;
    return new Promise<void>((resolve) => {
      this.broker.close(() => {
        for (const s of this.sockets) s.destroy();
        this.server.close(() => resolve());
        if (!this.server.listening) resolve();
      });
    });
  }
}

function remote(sock: Socket | undefined) {
  return sock?.remoteAddress ? ` from ${sock.remoteAddress.replace(/^::ffff:/, '')}` : '';
}

// ---------- External broker ----------

export class ExternalBroker implements Transport {
  readonly kind = 'external';
  readonly clients = 0;
  lastError: string | null = null;
  onConnect: (() => void) | null = null;
  private client: MqttClient;
  private wasConnected = false;
  private closing = false;
  private subs: [string, (topic: string, payload: string) => void][] = [];

  constructor(url: string, creds: Credentials, will: { topic: string; payload: string }, clientId: string) {
    log.info(`Connecting to ${safeUrl(url)}.`);
    this.client = connect(url, {
      clientId,
      username: creds.username || undefined,
      password: creds.password || undefined,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      // While disconnected, drop publishes; the publisher republishes everything on reconnect.
      queueQoSZero: false,
      will: { topic: will.topic, payload: Buffer.from(will.payload), qos: 0, retain: true },
    });
    this.client.on('connect', () => {
      this.wasConnected = true;
      this.lastError = null;
      log.info(`Connected to ${safeUrl(url)}.`);
      this.onConnect?.();
    });
    this.client.on('close', () => {
      if (this.wasConnected) (this.closing ? log.info : log.warn)(`Disconnected from ${safeUrl(url)}.`);
      this.wasConnected = false;
    });
    this.client.on('error', (err) => {
      // Log each distinct error once rather than on every reconnect attempt.
      if (err.message !== this.lastError) log.error(`Broker error: ${err.message}`);
      this.lastError = err.message;
    });
    this.client.on('message', (topic, payload) => {
      for (const [filter, handler] of this.subs) if (matches(filter, topic)) handler(topic, payload.toString());
    });
  }

  get connected() {
    return this.client.connected;
  }

  publish(topic: string, payload: string, retain: boolean) {
    if (!this.client.connected) return;
    this.client.publish(topic, payload, { qos: 0, retain });
  }

  subscribe(filter: string, handler: (topic: string, payload: string) => void) {
    this.subs.push([filter, handler]);
    this.client.subscribe(filter, { qos: 0 });
  }

  flush() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  close() {
    this.closing = true;
    return new Promise<void>((resolve) => {
      this.client.end(false, {}, () => resolve());
      setTimeout(resolve, 2000).unref();
    });
  }
}

/** MQTT topic filter match with + and # wildcards. */
export function matches(filter: string, topic: string) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}
