import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  crc16, CrcError, frame, hidChunks, HidTransport, parseReply, voltronicCrc, VoltronicLink, type HidHandle, type Transport,
} from '../src/devices/inverters/voltronic/protocol.ts';

/** A reply frame as an inverter would send it: "(" + payload + CRC + CR. */
function replyFrame(payload: string): Buffer {
  const body = Buffer.from('(' + payload, 'latin1');
  const crc = voltronicCrc(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}

test('CRC16/XMODEM known vectors', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
  assert.equal(voltronicCrc(Buffer.from('QPIGS')), 0xb7a9);
  assert.equal(voltronicCrc(Buffer.from('QPIRI')), 0xf854);
  assert.equal(voltronicCrc(Buffer.from('QMOD')), 0x49c1);
  assert.equal(voltronicCrc(Buffer.from('QPIWS')), 0xb4da);
});

test('frame: command + CRC + CR', () => {
  assert.deepEqual([...frame('QPIGS')], [0x51, 0x50, 0x49, 0x47, 0x53, 0xb7, 0xa9, 0x0d]);
});

test('CRC escaping: reserved bytes 0x28/0x0D/0x0A are bumped by one', () => {
  // Find inputs whose plain CRC has a reserved byte, and check the wire CRC avoids it.
  let seen = 0;
  for (let i = 0; i < 20000 && seen < 6; i++) {
    const data = Buffer.from(`PBCV${i}`);
    const plain = crc16(data);
    const hi = plain >> 8;
    const lo = plain & 0xff;
    if (![0x28, 0x0d, 0x0a].includes(hi) && ![0x28, 0x0d, 0x0a].includes(lo)) continue;
    seen++;
    const wire = voltronicCrc(data);
    const expHi = [0x28, 0x0d, 0x0a].includes(hi) ? hi + 1 : hi;
    const expLo = [0x28, 0x0d, 0x0a].includes(lo) ? lo + 1 : lo;
    assert.equal(wire, (expHi << 8) | expLo);
    assert.equal(frame(`PBCV${i}`).indexOf(0x0d), frame(`PBCV${i}`).length - 1, 'only the terminator is CR');
  }
  assert.ok(seen > 0);
});

test('parseReply strips "(" and CRC, verifies CRC', () => {
  assert.equal(parseReply(replyFrame('ACK')), 'ACK');
  assert.equal(parseReply(replyFrame('B')), 'B');
  const bad = replyFrame('230.0 50.0');
  bad[bad.length - 2] ^= 0xff;
  assert.throws(() => parseReply(bad, true), CrcError);
  // With verification off the bad CRC is tolerated and still stripped.
  assert.equal(parseReply(bad, false), '230.0 50.0');
  // No CRC at all (some firmware): kept intact when not verifying.
  assert.equal(parseReply(Buffer.from('(NAK\r'), false), 'NAK');
  assert.throws(() => parseReply(Buffer.from('garbage\r')));
});

test('HID: request split into zero-padded 8-byte reports', () => {
  const chunks = hidChunks(frame('QPIGS'));
  assert.equal(chunks.length, 1);
  assert.deepEqual([...chunks[0]], [0x51, 0x50, 0x49, 0x47, 0x53, 0xb7, 0xa9, 0x0d]);
  const long = hidChunks(frame('QPIGS2'));
  assert.equal(long.length, 2);
  assert.equal(long[1].length, 8);
  assert.deepEqual([...long[1]], [0x0d, 0, 0, 0, 0, 0, 0, 0]);
});

/** Fake hidraw fd: records writes, answers with canned 8-byte reports (EAGAIN when empty). */
class FakeHid implements HidHandle {
  writes: Buffer[] = [];
  reports: Buffer[] = [];
  respond: (request: Buffer) => Buffer;
  closed = false;
  constructor(respond: (request: Buffer) => Buffer) {
    this.respond = respond;
  }
  async write(buffer: Buffer) {
    this.writes.push(Buffer.from(buffer));
    const all = Buffer.concat(this.writes);
    const cr = all.indexOf(0x0d);
    if (cr >= 0) {
      const reply = this.respond(all.subarray(0, cr + 1));
      this.writes = [];
      for (const c of hidChunks(reply)) this.reports.push(c);
    }
    return { bytesWritten: buffer.length };
  }
  async read(buffer: Buffer, offset: number, length: number) {
    const r = this.reports.shift();
    if (!r) {
      const err = new Error('EAGAIN') as NodeJS.ErrnoException;
      err.code = 'EAGAIN';
      throw err;
    }
    r.copy(buffer, offset, 0, Math.min(length, r.length));
    return { bytesRead: Math.min(length, r.length) };
  }
  async close() {
    this.closed = true;
  }
}

test('HID transport: chunked write, report reads until CR', async () => {
  const sent: Buffer[] = [];
  const fake = new FakeHid((req) => {
    sent.push(Buffer.from(req));
    return replyFrame('230.0 49.9 230.0 50.0 0161 0119 003 460 57.50 012 100 0069');
  });
  const writes: number[] = [];
  const orig = fake.write.bind(fake);
  fake.write = async (b: Buffer) => {
    writes.push(b.length);
    return orig(b);
  };
  const t = new HidTransport('/dev/hidraw0', async () => fake, 1);
  await t.open();
  const link = new VoltronicLink(t);
  const reply = await link.query('QPIGS');
  assert.equal(reply, '230.0 49.9 230.0 50.0 0161 0119 003 460 57.50 012 100 0069');
  assert.deepEqual(writes, [8]);
  assert.deepEqual([...sent[0]], [...frame('QPIGS')]);
  await t.close();
  assert.ok(fake.closed);
});

test('link: one retry on timeout, NAK on set throws', async () => {
  let calls = 0;
  const t: Transport = {
    open: async () => {},
    close: async () => {},
    exchange: async (req) => {
      calls++;
      if (calls === 1) throw new Error('No response (timeout)');
      return req.toString('latin1').startsWith('PBCV') ? replyFrame('NAK') : replyFrame('ACK');
    },
  };
  const link = new VoltronicLink(t);
  assert.equal(await link.query('POP02'), 'ACK');
  assert.equal(calls, 2);
  await assert.rejects(link.set('PBCV46.0'), /Inverter replied NAK/);
  await link.set('POP00');

  let fails = 0;
  const dead = new VoltronicLink({ open: async () => {}, close: async () => {}, exchange: async () => { fails++; throw new Error('No response (timeout)'); } });
  await assert.rejects(dead.query('QPIGS'), /QPIGS: No response/);
  assert.equal(fails, 2);
});

test('link: commands are serialized', async () => {
  let active = 0;
  let maxActive = 0;
  const t: Transport = {
    open: async () => {},
    close: async () => {},
    exchange: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return replyFrame('ACK');
    },
  };
  const link = new VoltronicLink(t);
  await Promise.all([link.query('QPIGS'), link.query('QMOD'), link.query('QPIWS')]);
  assert.equal(maxActive, 1);
});
