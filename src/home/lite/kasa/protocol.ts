/**
 * TP-Link Kasa protocols, as python-kasa implements them.
 *
 * Legacy ("IOT") protocol, TCP and UDP port 9999: JSON encrypted with the "autokey" XOR cipher
 * (initial key 171, each ciphertext byte becomes the next key). TCP frames carry a 4-byte big-endian
 * length prefix; UDP discovery packets don't.
 *
 * KLAP v2 (newer Kasa firmware and Tapo), HTTP on port 80:
 *   auth      = SHA-256( SHA-1(username) || SHA-1(password) )
 *   handshake1: POST /app/handshake1  body local_seed(16)   → remote_seed(16) || SHA-256(local||remote||auth)
 *   handshake2: POST /app/handshake2  body SHA-256(remote||local||auth)
 *   key  = SHA-256("lsk"||local||remote||auth)[0:16]
 *   iv   = SHA-256("iv" ||local||remote||auth): first 12 bytes; last 4 = starting sequence (signed int32)
 *   sig  = SHA-256("ldk"||local||remote||auth)[0:28]
 *   request: seq += 1; AES-128-CBC(key, iv||seq) PKCS#7; body = SHA-256(sig||seq||ct) || ct; POST /app/request?seq=N
 *   response: AES-128-CBC decrypt of body[32:] with the same iv||seq.
 * The session cookie (TP_SESSIONID) from handshake1 is sent with every later request.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

const sha256 = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest();

// ---------- Legacy XOR protocol ----------

export function xorEncrypt(text: string): Buffer {
  const plain = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(plain.length);
  let key = 171;
  for (let i = 0; i < plain.length; i++) {
    key ^= plain[i];
    out[i] = key;
  }
  return out;
}

export function xorDecrypt(buf: Buffer): string {
  const out = Buffer.alloc(buf.length);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    out[i] = key ^ buf[i];
    key = buf[i];
  }
  return out.toString('utf8');
}

export function frame(obj: unknown): Buffer {
  const payload = xorEncrypt(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

/** One request over TCP; rejects on timeout, refusal or a malformed answer. */
export function legacyRequest(host: string, port: number, obj: unknown, timeoutMs = 3000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, value?: Record<string, any>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('The device did not answer')), timeoutMs);
    sock.on('error', (err) => finish(err));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      try {
        finish(null, JSON.parse(xorDecrypt(buf.subarray(4, 4 + len))));
      } catch {
        finish(new Error('Malformed answer'));
      }
    });
    sock.on('close', () => finish(new Error('Connection closed')));
    sock.connect(port, host, () => sock.write(frame(obj)));
  });
}

// ---------- KLAP v2 ----------

export function klapAuthHash(username: string, password: string): Buffer {
  return sha256(sha1(Buffer.from(username, 'utf8')), sha1(Buffer.from(password, 'utf8')));
}

export interface KlapKeys {
  key: Buffer;
  iv: Buffer;
  seq: number;
  sig: Buffer;
}

export function klapKeys(local: Buffer, remote: Buffer, auth: Buffer): KlapKeys {
  const ivFull = sha256(Buffer.from('iv'), local, remote, auth);
  return {
    key: sha256(Buffer.from('lsk'), local, remote, auth).subarray(0, 16),
    iv: ivFull.subarray(0, 12),
    seq: ivFull.readInt32BE(28),
    sig: sha256(Buffer.from('ldk'), local, remote, auth).subarray(0, 28),
  };
}

const seqBytes = (seq: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(seq, 0);
  return b;
};

export function klapEncrypt(k: KlapKeys, seq: number, plain: string): Buffer {
  const c = createCipheriv('aes-128-cbc', k.key, Buffer.concat([k.iv, seqBytes(seq)]));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([sha256(k.sig, seqBytes(seq), ct), ct]);
}

export function klapDecrypt(k: KlapKeys, seq: number, body: Buffer): string {
  const d = createDecipheriv('aes-128-cbc', k.key, Buffer.concat([k.iv, seqBytes(seq)]));
  return Buffer.concat([d.update(body.subarray(32)), d.final()]).toString('utf8');
}

export class KlapError extends Error {
  code: 'auth' | 'unreachable' | 'protocol';
  constructor(message: string, code: KlapError['code']) {
    super(message);
    this.code = code;
  }
}

/** A KLAP v2 session with one device; re-handshakes when the session expires. */
export class KlapClient {
  private base: string;
  private auth: Buffer;
  private timeoutMs: number;
  private keys: KlapKeys | null = null;
  private seq = 0;
  private cookie = '';

  constructor(host: string, port: number, username: string, password: string, timeoutMs = 4000) {
    this.base = `http://${host}:${port}/app`;
    this.auth = klapAuthHash(username, password);
    this.timeoutMs = timeoutMs;
  }

  private async post(path: string, body: Buffer): Promise<{ status: number; body: Buffer; cookie: string | null }> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': 'application/octet-stream', ...(this.cookie ? { cookie: this.cookie } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new KlapError('The device did not answer', 'unreachable');
    }
    const set = res.headers.get('set-cookie');
    const cookie = set ? (/TP_SESSIONID=[^;]+/.exec(set)?.[0] ?? null) : null;
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), cookie };
  }

  /** True when something at this address speaks KLAP (handshake1 answers with 48 bytes). */
  static async probe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await fetch(`http://${host}:${port}/app/handshake1`, { method: 'POST', body: new Uint8Array(randomBytes(16)), signal: AbortSignal.timeout(timeoutMs) });
      const b = Buffer.from(await res.arrayBuffer());
      return res.status === 200 && b.length === 48;
    } catch {
      return false;
    }
  }

  async handshake(): Promise<void> {
    this.cookie = '';
    this.keys = null;
    const local = randomBytes(16);
    const h1 = await this.post('/handshake1', local);
    if (h1.status !== 200 || h1.body.length !== 48) throw new KlapError(`Handshake failed (HTTP ${h1.status})`, 'protocol');
    const remote = h1.body.subarray(0, 16);
    const serverHash = h1.body.subarray(16, 48);
    if (!sha256(local, remote, this.auth).equals(serverHash)) throw new KlapError('Wrong TP-Link email or password', 'auth');
    if (h1.cookie) this.cookie = h1.cookie;
    const h2 = await this.post('/handshake2', sha256(remote, local, this.auth));
    if (h2.status !== 200) throw new KlapError(`Handshake failed (HTTP ${h2.status})`, 'protocol');
    this.keys = klapKeys(local, remote, this.auth);
    this.seq = this.keys.seq;
  }

  /** Sends one smart-protocol request ({method, params}); returns its `result`. */
  async request(method: string, params: Record<string, unknown> | null = null, retry = true): Promise<Record<string, any>> {
    if (!this.keys) await this.handshake();
    const k = this.keys!;
    this.seq = (this.seq + 1) | 0;
    const seq = this.seq;
    const body = klapEncrypt(k, seq, JSON.stringify({ method, params, request_time_milis: Date.now() }));
    const res = await this.post(`/request?seq=${seq}`, body);
    if (res.status !== 200) {
      this.keys = null;
      if (retry) return this.request(method, params, false);
      throw new KlapError(`Request failed (HTTP ${res.status})`, 'protocol');
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(klapDecrypt(k, seq, res.body));
    } catch {
      throw new KlapError('Malformed answer', 'protocol');
    }
    if (msg.error_code !== 0) throw new KlapError(`Device error ${msg.error_code}`, 'protocol');
    return msg.result ?? {};
  }
}
