/**
 * Tuya local protocol (as implemented by tinytuya / localtuya): framing, encryption, payloads and the
 * 3.4/3.5 session-key exchange. Pure functions over Buffers, shared by the driver and the test simulator.
 *
 *   55AA frame (3.1–3.4)  prefix 000055AA · seq u32 · cmd u32 · len u32 · [retcode u32] · payload ·
 *                         CRC32 u32 (≤3.3) or HMAC-SHA256 32 bytes (3.4) · suffix 0000AA55
 *                         len = everything after the len field (retcode + payload + check + suffix)
 *   6699 frame (3.5)      prefix 00006699 · 0000 · seq u32 · cmd u32 · len u32 · iv 12 · AES-GCM ciphertext · tag 16 ·
 *                         suffix 00009966; AAD = the 14 header bytes after the prefix; len = iv + ciphertext + tag
 *
 * 3.3: payload AES-128-ECB (PKCS#7) with the local key; most commands carry a clear "3.3" + 12 zero byte header
 *      before the ciphertext. 3.4: the header goes inside the encryption, which uses the session key. 3.5: likewise,
 *      inside AES-GCM. Messages from the device start with a 4-byte return code (inside the encryption on 3.5).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const PREFIX_55AA = 0x000055aa;
export const SUFFIX_55AA = 0x0000aa55;
export const PREFIX_6699 = 0x00006699;
export const SUFFIX_6699 = 0x00009966;

export const CMD = {
  SESS_KEY_NEG_START: 0x03,
  SESS_KEY_NEG_RESP: 0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  CONTROL: 0x07,
  STATUS: 0x08,
  HEART_BEAT: 0x09,
  DP_QUERY: 0x0a,
  CONTROL_NEW: 0x0d,
  DP_QUERY_NEW: 0x10,
  UPDATEDPS: 0x12,
  UDP_NEW: 0x13,
  BROADCAST_LPV34: 0x23,
  LAN_EXT_STREAM: 0x40,
} as const;

/** Commands sent without the version header (tinytuya NO_PROTOCOL_HEADER_CMDS). */
export const NO_HEADER_CMDS = new Set<number>([
  CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.UPDATEDPS, CMD.HEART_BEAT,
  CMD.SESS_KEY_NEG_START, CMD.SESS_KEY_NEG_RESP, CMD.SESS_KEY_NEG_FINISH, CMD.LAN_EXT_STREAM,
]);

export type Version = '3.3' | '3.4' | '3.5';
export const VERSIONS: Version[] = ['3.3', '3.4', '3.5'];

/** Key of the encrypted UDP discovery broadcasts: md5("yGAdlopoPVldABfn"). */
export const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();

export class TuyaError extends Error {
  code: 'unreachable' | 'auth' | 'timeout' | 'protocol' | 'closed';
  constructor(code: TuyaError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ---------- Crypto ----------

export function ecbEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const c = createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

export function ecbDecrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const d = createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(pad);
  return Buffer.concat([d.update(data), d.final()]);
}

export function gcmEncrypt(key: Buffer, iv: Buffer, plain: Buffer, aad?: Buffer): { ct: Buffer; tag: Buffer } {
  const c = createCipheriv('aes-128-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

export function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad?: Buffer): Buffer {
  const d = createDecipheriv('aes-128-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export const versionHeader = (v: Version) => Buffer.concat([Buffer.from(v), Buffer.alloc(12)]);

// ---------- Frames ----------

export interface Frame {
  seq: number;
  cmd: number;
  /** Return code (messages from the device), or null. */
  retcode: number | null;
  /** 55AA: the payload as sent (still encrypted). 6699: the decrypted plaintext. */
  payload: Buffer;
}

/** A 55AA frame. `retcode` is included by the device side only. `hmacKey` selects 3.4 framing. */
export function pack55aa(seq: number, cmd: number, payload: Buffer, hmacKey: Buffer | null, retcode: number | null = null): Buffer {
  const body = Buffer.concat([retcode === null ? Buffer.alloc(0) : u32(retcode), payload]);
  const header = Buffer.concat([u32(PREFIX_55AA), u32(seq), u32(cmd), u32(body.length + (hmacKey ? 36 : 8))]);
  const signed = Buffer.concat([header, body]);
  const check = hmacKey ? hmac(hmacKey, signed) : u32(crc32(signed));
  return Buffer.concat([signed, check, u32(SUFFIX_55AA)]);
}

/** A 6699 (3.5) frame: `plain` is encrypted with AES-GCM. The device side puts the return code inside `plain`. */
export function pack6699(seq: number, cmd: number, plain: Buffer, key: Buffer, iv: Buffer = randomBytes(12)): Buffer {
  const header = Buffer.alloc(18);
  header.writeUInt32BE(PREFIX_6699, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt32BE(seq, 6);
  header.writeUInt32BE(cmd, 10);
  header.writeUInt32BE(plain.length + 12 + 16, 14);
  const { ct, tag } = gcmEncrypt(key, iv, plain, header.subarray(4));
  return Buffer.concat([header, iv, ct, tag, u32(SUFFIX_6699)]);
}

export interface TakeOptions {
  /** 3.4: HMAC key; null = CRC32 framing. */
  hmacKey: Buffer | null;
  /** 3.5: AES-GCM key. */
  gcmKey: Buffer | null;
  /** Whether the frame comes from a device (has a return code). */
  fromDevice: boolean;
}

/** Return codes are small integers; an encrypted payload or a "3.x" header practically never starts with 3 zero bytes. */
function splitRetcode(payload: Buffer, fromDevice: boolean): { retcode: number | null; payload: Buffer } {
  if (fromDevice && payload.length >= 4 && payload.readUInt32BE(0) < 256) return { retcode: payload.readUInt32BE(0), payload: payload.subarray(4) };
  return { retcode: null, payload };
}

/**
 * Takes one complete frame off the front of `buf`. Returns null when more bytes are needed.
 * Leading garbage is skipped. Throws TuyaError('auth') when the CRC/HMAC/GCM check fails (wrong key).
 */
export function takeFrame(buf: Buffer, o: TakeOptions): { frame: Frame; rest: Buffer } | null {
  let start = 0;
  while (start + 4 <= buf.length) {
    const p = buf.readUInt32BE(start);
    if (p === PREFIX_55AA || p === PREFIX_6699) break;
    start++;
  }
  const b = buf.subarray(start);
  if (b.length < 4) return null;
  if (b.readUInt32BE(0) === PREFIX_55AA) {
    if (b.length < 16) return null;
    const len = b.readUInt32BE(12);
    const total = 16 + len;
    if (b.length < total) return null;
    const checkLen = o.hmacKey ? 32 : 4;
    if (len < checkLen + 4) throw new TuyaError('protocol', 'Frame too short');
    const signedEnd = total - 4 - checkLen;
    const signed = b.subarray(0, signedEnd);
    const check = b.subarray(signedEnd, total - 4);
    const ok = o.hmacKey ? hmac(o.hmacKey, signed).equals(check) : check.readUInt32BE(0) === crc32(signed) >>> 0;
    if (!ok) throw new TuyaError('auth', o.hmacKey ? 'Frame HMAC mismatch (wrong local key?)' : 'Frame CRC mismatch');
    const { retcode, payload } = splitRetcode(b.subarray(16, signedEnd), o.fromDevice);
    return { frame: { seq: b.readUInt32BE(4), cmd: b.readUInt32BE(8), retcode, payload }, rest: b.subarray(total) };
  }
  if (b.length < 18) return null;
  const len = b.readUInt32BE(14);
  const total = 18 + len + 4;
  if (b.length < total) return null;
  if (!o.gcmKey) throw new TuyaError('protocol', '3.5 frame without a key');
  if (len < 28) throw new TuyaError('protocol', 'Frame too short');
  const iv = b.subarray(18, 30);
  const ct = b.subarray(30, 18 + len - 16);
  const tag = b.subarray(18 + len - 16, 18 + len);
  let plain: Buffer;
  try {
    plain = gcmDecrypt(o.gcmKey, iv, ct, tag, b.subarray(4, 18));
  } catch {
    throw new TuyaError('auth', 'Frame failed to decrypt (wrong local key?)');
  }
  const { retcode, payload } = splitRetcode(plain, o.fromDevice);
  return { frame: { seq: b.readUInt32BE(6), cmd: b.readUInt32BE(10), retcode, payload }, rest: b.subarray(total) };
}

// ---------- Payloads ----------

/**
 * Client side: the payload for a command (to frame with pack55aa / pack6699).
 * `key` is the local key on 3.3, the session key (local key while negotiating) on 3.4/3.5.
 */
export function encodeClient(v: Version, key: Buffer, cmd: number, body: Buffer): Buffer {
  const header = NO_HEADER_CMDS.has(cmd) ? Buffer.alloc(0) : versionHeader(v);
  if (v === '3.3') return Buffer.concat([header, ecbEncrypt(key, body)]);
  if (v === '3.4') return ecbEncrypt(key, Buffer.concat([header, body]));
  return Buffer.concat([header, body]);
}

/** Client side: the plaintext of a device message's payload (may be empty for acks). Throws TuyaError('auth'). */
export function decodeDevice(v: Version, key: Buffer, payload: Buffer): Buffer {
  if (!payload.length) return payload;
  const strip = (b: Buffer) => (b.subarray(0, 3).toString() === v ? b.subarray(15) : b);
  if (v === '3.5') return strip(payload);
  const enc = v === '3.3' ? strip(payload) : payload;
  if (!enc.length) return enc;
  try {
    const plain = ecbDecrypt(key, enc);
    return v === '3.4' ? strip(plain) : plain;
  } catch {
    // Errors come back in clear, e.g. "json obj data unvalid" when the device can't read our message.
    if (/^[\x20-\x7e]+$/.test(enc.toString('latin1'))) return enc;
    throw new TuyaError('auth', "Can't decrypt the device's answer (wrong local key or protocol version)");
  }
}

/** Device side (simulator): the payload of a message to the client. 3.5 returns the GCM plaintext (incl. return code). */
export function encodeDevice(v: Version, key: Buffer, cmd: number, body: Buffer, retcode = 0): Buffer {
  const header = body.length && !NO_HEADER_CMDS.has(cmd) && cmd !== CMD.CONTROL && cmd !== CMD.CONTROL_NEW ? versionHeader(v) : Buffer.alloc(0);
  if (v === '3.3') return body.length ? Buffer.concat([header, ecbEncrypt(key, body)]) : body;
  if (v === '3.4') return body.length ? ecbEncrypt(key, Buffer.concat([header, body])) : body;
  return Buffer.concat([u32(retcode), header, body]);
}

/** Device side (simulator): the plaintext of a client command. */
export function decodeClient(v: Version, key: Buffer, payload: Buffer): Buffer {
  const strip = (b: Buffer) => (b.subarray(0, 3).toString() === v ? b.subarray(15) : b);
  if (v === '3.5') return strip(payload);
  if (v === '3.3') return ecbDecrypt(key, strip(payload));
  return strip(ecbDecrypt(key, payload));
}

// ---------- Session key (3.4 / 3.5) ----------

export function sessionKey(v: Version, localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
  const x = Buffer.from(localNonce.map((b, i) => b ^ remoteNonce[i]));
  if (v === '3.4') return ecbEncrypt(localKey, x, false);
  return gcmEncrypt(localKey, localNonce.subarray(0, 12), x).ct;
}

// ---------- JSON bodies ----------

const ts = () => String(Math.floor(Date.now() / 1000));

export function queryBody(v: Version, id: string): { cmd: number; body: Buffer } {
  if (v === '3.3') return { cmd: CMD.DP_QUERY, body: Buffer.from(JSON.stringify({ gwId: id, devId: id, uid: id, t: ts() })) };
  return { cmd: CMD.DP_QUERY_NEW, body: Buffer.from('{}') };
}

export function controlBody(v: Version, id: string, dps: Record<string, unknown>): { cmd: number; body: Buffer } {
  if (v === '3.3') return { cmd: CMD.CONTROL, body: Buffer.from(JSON.stringify({ devId: id, uid: id, t: ts(), dps })) };
  return { cmd: CMD.CONTROL_NEW, body: Buffer.from(JSON.stringify({ protocol: 5, t: Number(ts()), data: { dps } })) };
}

export const heartbeatBody = (id: string) => Buffer.from(JSON.stringify({ gwId: id, devId: id }));

/** The data points in a device message ({dps} on 3.3, {data:{dps}} on 3.4+). */
export function dpsOf(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as { dps?: unknown; data?: { dps?: unknown } };
  const dps = o.dps ?? o.data?.dps;
  return dps && typeof dps === 'object' ? (dps as Record<string, unknown>) : null;
}

// ---------- Discovery ----------

export interface Announcement {
  ip: string;
  gwId: string;
  version: string | null;
  productKey: string | null;
}

/** Decodes a UDP discovery broadcast (port 6666 clear, 6667 ECB with UDP_KEY, 7000 GCM with UDP_KEY on 3.5). */
export function decodeDiscovery(msg: Buffer): Announcement | null {
  if (msg.length < 24) return null;
  let text: string;
  try {
    const prefix = msg.readUInt32BE(0);
    if (prefix === PREFIX_55AA) {
      // tinytuya decrypt_udp: header (16) + return code (4) … CRC + suffix (8)
      const payload = msg.subarray(20, msg.length - 8);
      text = payload[0] === 0x7b ? payload.toString() : ecbDecrypt(UDP_KEY, payload).toString();
    } else if (prefix === PREFIX_6699) {
      const r = takeFrame(msg, { hmacKey: null, gcmKey: UDP_KEY, fromDevice: false });
      if (!r) return null;
      const s = r.frame.payload.toString();
      text = s.slice(s.indexOf('{'));
    } else return null;
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.gwId !== 'string' || typeof j.ip !== 'string') return null;
    return { ip: j.ip, gwId: j.gwId, version: typeof j.version === 'string' ? j.version : null, productKey: typeof j.productKey === 'string' ? j.productKey : null };
  } catch {
    return null;
  }
}

/** Simulator side: a discovery broadcast as a 3.3/3.4 device sends it on 6667 (or 6666 when `clear`). */
export function encodeDiscovery(a: Record<string, unknown>, clear = false): Buffer {
  const body = Buffer.from(JSON.stringify(a));
  return pack55aa(0, CMD.UDP_NEW, clear ? body : ecbEncrypt(UDP_KEY, body), null, 0);
}
