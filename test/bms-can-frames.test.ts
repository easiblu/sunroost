import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adapterConfigFrame,
  encodeSeeed,
  encodeWaveshare,
  parseCandumpLine,
  SerialCanDecoder,
  type CanFrame,
} from '../src/devices/bms/can/frames.ts';

const f = (id: number, hex: string, ext = false): CanFrame => ({ id, ext, rtr: false, data: Buffer.from(hex, 'hex') });

test('candump -L lines', () => {
  assert.deepEqual(parseCandumpLine('(1436509052.249713) can0 351#1E02E803E8030302'), f(0x351, '1e02e803e8030302'));
  assert.deepEqual(parseCandumpLine('(1.5) can0 1ABCDEF0#0102'), f(0x1abcdef0, '0102', true));
  assert.deepEqual(parseCandumpLine('(1.5) can0 305#'), f(0x305, ''));
  assert.deepEqual(parseCandumpLine('(1.5) can0 123#R'), { id: 0x123, ext: false, rtr: true, data: Buffer.alloc(0) });
  assert.equal(parseCandumpLine('(1.5) can0 123##1AABB')?.data.toString('hex'), 'aabb'); // CAN FD
  assert.equal(parseCandumpLine('garbage'), null);
  assert.equal(parseCandumpLine('(1.5) can0 351#123'), null); // odd nibble count
  assert.equal(parseCandumpLine('(1.5) can0 FFF#00'), null); // > 11 bits with 3 digits
});

test('Waveshare variable-length frames, split across chunks, with resync on garbage', () => {
  const a = f(0x356, '4e13faff1201');
  const b = f(0x35e, '50594c4f4e202020');
  const ext = f(0x18ff50e5, 'aa55', true);
  const stream = Buffer.concat([
    Buffer.from([0x13, 0xaa, 0x00, 0xaa, 0xc8]), // junk incl. a false start (AA C8 … without 55 end)
    encodeWaveshare(a),
    Buffer.from([0xaa]), // stray header byte
    encodeWaveshare(b),
    encodeWaveshare(ext),
  ]);
  const d = new SerialCanDecoder('waveshare');
  const out: CanFrame[] = [];
  for (let i = 0; i < stream.length; i += 3) out.push(...d.push(stream.subarray(i, i + 3)));
  assert.deepEqual(out, [a, b, ext]);
  assert.deepEqual([...encodeWaveshare(f(0x351, '0102'))], [0xaa, 0xc2, 0x51, 0x03, 0x01, 0x02, 0x55]);
});

test('Seeed fixed 20-byte frames: checksum checked, resync on garbage', () => {
  const a = f(0x355, '63006400');
  const raw = encodeSeeed(a);
  assert.equal(raw.length, 20);
  const corrupt = Buffer.from(raw);
  corrupt[12] ^= 0xff; // bad checksum → dropped
  const d = new SerialCanDecoder('seeed');
  const out = d.push(Buffer.concat([Buffer.from('noise\xaa', 'latin1'), corrupt, Buffer.from([0x00, 0xaa, 0x55]), raw]));
  assert.deepEqual(out, [a]);
});

test("'any' framing accepts both adapters' frames in one stream", () => {
  const a = f(0x351, '1002e803e803e001');
  const b = f(0x359, '0000000002504e');
  const d = new SerialCanDecoder('any');
  assert.deepEqual(d.push(Buffer.concat([encodeSeeed(a), Buffer.from([1, 2, 3]), encodeWaveshare(b)])), [a, b]);
});

test('adapter settings command: 500k, listen-only, variable vs fixed framing', () => {
  const v = adapterConfigFrame({ variable: true, bitrate: 500_000, listenOnly: true });
  assert.equal(v.length, 20);
  assert.deepEqual([...v.subarray(0, 5)], [0xaa, 0x55, 0x12, 0x03, 0x01]);
  assert.equal(v[13], 0x02); // silent
  let s = 0;
  for (let i = 2; i < 19; i++) s += v[i];
  assert.equal(v[19], s & 0xff);
  const fixed = adapterConfigFrame({ variable: false, bitrate: 250_000, listenOnly: true });
  assert.equal(fixed[2], 0x02);
  assert.equal(fixed[3], 0x05);
  assert.equal(adapterConfigFrame({ variable: true, bitrate: 1_000_000, listenOnly: false })[3], 0x01);
  assert.throws(() => adapterConfigFrame({ variable: true, bitrate: 2_000_000, listenOnly: true }));
});
