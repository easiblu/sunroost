/**
 * Home Assistant client: its WebSocket API (auth, commands, subscriptions) and REST API, using
 * Node's built-in WebSocket and fetch. One instance per connection; the engine reconnects.
 */
import { EventEmitter } from 'node:events';

const COMMAND_TIMEOUT_MS = 15_000;

export class HaError extends Error {
  code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.code = code;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class HaClient extends EventEmitter<{ close: [string] }> {
  readonly baseUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<number, (event: unknown) => void>();
  haVersion = '';

  constructor(baseUrl: string, token: string) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** Opens the WebSocket and authenticates. Rejects with HaError('invalid_auth') on a bad token. */
  connect(timeoutMs = 10_000): Promise<void> {
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/websocket';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let authed = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new HaError(`No answer from Home Assistant at ${this.baseUrl}`, 'timeout'));
      }, timeoutMs);
      ws.onerror = () => {
        if (authed) return;
        clearTimeout(timer);
        reject(new HaError(`Can't reach Home Assistant at ${this.baseUrl}`, 'unreachable'));
      };
      ws.onclose = () => {
        this.ws = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new HaError('Connection to Home Assistant closed', 'closed'));
        }
        this.pending.clear();
        this.subs.clear();
        if (authed) this.emit('close', 'Connection to Home Assistant closed');
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (msg.type === 'auth_ok') {
          authed = true;
          this.haVersion = msg.ha_version ?? '';
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'auth_invalid') {
          clearTimeout(timer);
          ws.close();
          reject(new HaError(msg.message || 'Home Assistant rejected the access token', 'invalid_auth'));
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new HaError(msg.error?.message ?? 'Home Assistant reported an error', msg.error?.code ?? 'error'));
        } else if (msg.type === 'event') {
          this.subs.get(msg.id)?.(msg.event);
        }
      };
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.ws?.close();
  }

  /** Sends one command and resolves with its result. */
  command<T = unknown>(msg: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (!this.connected) return Promise.reject(new HaError('Not connected to Home Assistant', 'closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaError(`Home Assistant did not answer ${String(msg.type)}`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** Starts a subscription; `onEvent` gets each event. Resolves once Home Assistant accepted it. */
  async subscribe(msg: Record<string, unknown>, onEvent: (event: any) => void): Promise<void> {
    if (!this.connected) throw new HaError('Not connected to Home Assistant', 'closed');
    const id = this.nextId;
    this.subs.set(id, onEvent);
    try {
      await this.command(msg);
    } catch (err) {
      this.subs.delete(id);
      throw err;
    }
  }

  /** REST call with the token. Rejects with HaError on non-2xx (message from Home Assistant when it gives one). */
  async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      // Errors come as {message} or, for flow input, {errors: {field: reason}}.
      const detail = typeof data === 'object' && data
        ? data.message ?? (data.errors ? Object.entries(data.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') : null)
        : null;
      throw new HaError(detail || `Home Assistant answered HTTP ${res.status}`, String(res.status));
    }
    return data as T;
  }
}
