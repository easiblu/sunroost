/**
 * Noise_NNpsk0_25519_ChaChaPoly_SHA256, as ESPHome's encrypted native API uses it, with Node's
 * crypto (X25519, ChaCha20-Poly1305, HMAC-SHA256). Both roles, so the test simulator can be the device.
 *
 *   -> psk, e        initiator (Sunroost): 32-byte ephemeral key + 16-byte tag of an empty payload
 *   <- e, ee         responder (device): 32-byte ephemeral key + 16-byte tag
 *
 * Prologue "NoiseAPIInit\0\0"; the PSK is the device's 32-byte API encryption key (base64 in YAML).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto';

export const PROLOGUE = Buffer.from('NoiseAPIInit\x00\x00', 'binary');
const PROTOCOL = Buffer.from('Noise_NNpsk0_25519_ChaChaPoly_SHA256');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const TAG = 16;

export class NoiseError extends Error {}

const sha256 = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const hmac = (key: Buffer, ...b: Buffer[]) => createHmac('sha256', key).update(Buffer.concat(b)).digest();

function hkdf(ck: Buffer, ikm: Buffer, n: 2 | 3): Buffer[] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, o1, Buffer.from([2]));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmac(temp, o2, Buffer.from([3]))];
}

function nonce(n: bigint): Buffer {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(n, 4);
  return b;
}

/** One direction's cipher after the handshake. */
export class CipherState {
  private key: Buffer;
  private n = 0n;
  constructor(key: Buffer) {
    this.key = key;
  }
  encrypt(plain: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    const c = createCipheriv('chacha20-poly1305', this.key, nonce(this.n++), { authTagLength: TAG });
    c.setAAD(ad, { plaintextLength: plain.length });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  decrypt(data: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    if (data.length < TAG) throw new NoiseError('Ciphertext too short');
    const d = createDecipheriv('chacha20-poly1305', this.key, nonce(this.n++), { authTagLength: TAG });
    d.setAAD(ad, { plaintextLength: data.length - TAG });
    d.setAuthTag(data.subarray(data.length - TAG));
    try {
      return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]);
    } catch {
      throw new NoiseError('Decryption failed');
    }
  }
}

const rawPublic = (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
const publicFromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

/** Handshake state for one side. */
export class NoiseHandshake {
  private h: Buffer;
  private ck: Buffer;
  private k: CipherState | null = null;
  private e: { priv: KeyObject; pub: Buffer };
  private re: Buffer | null = null;
  private psk: Buffer;
  private initiator: boolean;

  /** `ephemeralPrivate` (32 raw bytes) only for deterministic tests. */
  constructor(psk: Buffer, initiator: boolean, ephemeralPrivate?: Buffer) {
    if (psk.length !== 32) throw new NoiseError('The encryption key must be 32 bytes (base64 of 44 characters)');
    this.psk = psk;
    this.initiator = initiator;
    this.h = PROTOCOL.length <= 32 ? Buffer.concat([PROTOCOL, Buffer.alloc(32 - PROTOCOL.length)]) : sha256(PROTOCOL);
    this.ck = this.h;
    this.mixHash(PROLOGUE);
    const priv = ephemeralPrivate
      ? createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, ephemeralPrivate]), format: 'der', type: 'pkcs8' })
      : generateKeyPairSync('x25519').privateKey;
    this.e = { priv, pub: rawPublic(createPublicKey(priv)) };
  }

  private mixHash(data: Buffer) {
    this.h = sha256(this.h, data);
  }

  private mixKey(ikm: Buffer) {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.k = new CipherState(k);
  }

  private mixKeyAndHash(ikm: Buffer) {
    const [ck, th, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(th);
    this.k = new CipherState(k);
  }

  private encryptAndHash(plain: Buffer): Buffer {
    const c = this.k!.encrypt(plain, this.h);
    this.mixHash(c);
    return c;
  }

  private decryptAndHash(data: Buffer): Buffer {
    const p = this.k!.decrypt(data, this.h);
    this.mixHash(data);
    return p;
  }

  /** Initiator's first message: psk, e (+ empty payload). */
  writeMessage1(): Buffer {
    this.mixKeyAndHash(this.psk);
    this.mixHash(this.e.pub);
    this.mixKey(this.e.pub);
    return Buffer.concat([this.e.pub, this.encryptAndHash(Buffer.alloc(0))]);
  }

  /** Responder reads it; throws NoiseError on a wrong key. */
  readMessage1(msg: Buffer) {
    if (msg.length < 32 + TAG) throw new NoiseError('Handshake message too short');
    this.mixKeyAndHash(this.psk);
    this.re = msg.subarray(0, 32);
    this.mixHash(this.re);
    this.mixKey(this.re);
    this.decryptAndHash(msg.subarray(32));
  }

  /** Responder's answer: e, ee (+ empty payload). */
  writeMessage2(): Buffer {
    this.mixHash(this.e.pub);
    this.mixKey(this.e.pub);
    this.mixKey(diffieHellman({ privateKey: this.e.priv, publicKey: publicFromRaw(this.re!) }));
    return Buffer.concat([this.e.pub, this.encryptAndHash(Buffer.alloc(0))]);
  }

  /** Initiator reads the answer; throws NoiseError on a wrong key. */
  readMessage2(msg: Buffer) {
    if (msg.length < 32 + TAG) throw new NoiseError('Handshake message too short');
    this.re = msg.subarray(0, 32);
    this.mixHash(this.re);
    this.mixKey(this.re);
    this.mixKey(diffieHellman({ privateKey: this.e.priv, publicKey: publicFromRaw(this.re) }));
    this.decryptAndHash(msg.subarray(32));
  }

  /** Transport ciphers: [send, receive] for this side. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2);
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    return this.initiator ? [c1, c2] : [c2, c1];
  }
}

/** Decodes the YAML key; throws NoiseError when it isn't a valid 32-byte key. */
export function parsePsk(b64: string): Buffer {
  const k = Buffer.from(b64.trim(), 'base64');
  if (k.length !== 32) throw new NoiseError('The encryption key must be the 44-character base64 key from the device YAML');
  return k;
}
