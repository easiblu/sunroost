import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frame } from '../src/devices/inverters/voltronic/protocol.ts';
import {
  crcModbus, decodeModbus, describe, detect, modbusCrcOk, parseHex, parseText, printable, Splitter, withModbusCrc,
} from '../src/diagnostics/frames.ts';
import { lookup, parseCsv, safeTraceName, traceFromCsv, traceToCsv } from '../src/diagnostics/trace.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Modbus CRC: known vector and append/verify', () => {
  // 01 03 00 00 00 0A → CRC C5 CD
  const req = withModbusCrc(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]));
  assert.equal(req.toString('hex'), '01030000000ac5cd');
  assert.equal(crcModbus(Buffer.from('123456789')), 0x4b37);
  assert.ok(modbusCrcOk(req));
  const bad = Buffer.from(req);
  bad[7] ^= 1;
  assert.ok(!modbusCrcOk(bad));
});

test('detect: Modbus request, reply, exception and writes', () => {
  const req = withModbusCrc(Buffer.from([0x01, 0x04, 0x00, 0x10, 0x00, 0x02]));
  assert.deepEqual(decodeModbus(req), { type: 'modbus', address: 1, fn: 4, register: 16, count: 2, kind: 'request' });
  assert.equal(describe(req), 'MODBUS 4 16 2');
  const reply = withModbusCrc(Buffer.from([0x01, 0x04, 0x04, 0x00, 0x64, 0xff, 0xff]));
  const r = decodeModbus(reply)!;
  assert.equal(r.kind, 'response');
  assert.deepEqual(r.values, [100, 65535]);
  const ex = withModbusCrc(Buffer.from([0x01, 0x83, 0x02]));
  assert.equal(decodeModbus(ex)!.kind, 'exception');
  const w16 = withModbusCrc(Buffer.from([0x01, 0x10, 0x00, 0x05, 0x00, 0x02, 0x04, 0x00, 0x01, 0x00, 0x02]));
  assert.deepEqual(decodeModbus(w16)!.values, [1, 2]);
  // Bad CRC is not Modbus
  const bad = Buffer.from(req);
  bad[2] ^= 0xff;
  assert.equal(detect(bad).type, 'string');
});

test('detect: Voltronic request and reply with CRC; plain strings', () => {
  const q = detect(frame('QPIGS'));
  assert.deepEqual(q, { type: 'voltronic', text: 'QPIGS', reply: false });
  assert.equal(describe(frame('QMOD')), 'VOLTRONIC QMOD');
  const s = detect(Buffer.from('hello\r'));
  assert.equal(s.type, 'string');
  assert.equal(printable(Buffer.from([0x41, 0x0d, 0x00])), 'A\\r\\x00');
});

test('parseHex / parseText', () => {
  assert.deepEqual([...parseHex('01 03 0x00,0A')], [1, 3, 0, 10]);
  assert.throws(() => parseHex('0'));
  assert.throws(() => parseHex('zz'));
  assert.deepEqual([...parseText('Q\\r\\x01')], [0x51, 0x0d, 0x01]);
});

test('Splitter: frames end after the silence gap', async () => {
  const frames: string[] = [];
  const s = new Splitter(20, (f) => frames.push(f.toString()));
  s.push(Buffer.from('AB'));
  await sleep(5);
  s.push(Buffer.from('CD'));
  await sleep(50);
  s.push(Buffer.from('EF'));
  await sleep(50);
  assert.deepEqual(frames, ['ABCD', 'EF']);
  s.push(Buffer.from('X'));
  s.flush();
  assert.deepEqual(frames, ['ABCD', 'EF', 'X']);
  s.dispose();
});

test('trace CSV: round trip, quoting, header, text cells', () => {
  const rows = [
    { request: Buffer.from([1, 3, 0, 0]), response: Buffer.from([1, 3, 2, 0, 5]), notes: 'note, with "quotes"' },
  ];
  const csv = traceToCsv(rows);
  assert.match(csv, /^Request,Response,Notes\n01030000,0103020005,"note, with ""quotes"""\n$/);
  const back = traceFromCsv(csv);
  assert.ok(back[0].request.equals(rows[0].request));
  assert.equal(back[0].notes, rows[0].notes);
  assert.deepEqual(parseCsv('a,b\r\n"x\ny",z\n'), [['a', 'b'], ['x\ny', 'z']]);
  const text = traceFromCsv('QPIGS\\r,(230.0 50.0\\r,');
  assert.equal(text[0].request.toString(), 'QPIGS\r');
  assert.ok(lookup(text, Buffer.from('QPIGS\r')));
  assert.ok(lookup(text, Buffer.from('QPIGS')), 'whitespace-insensitive fallback');
});

test('trace names are confined to the traces directory', () => {
  assert.equal(safeTraceName('new'), 'new.csv');
  assert.equal(safeTraceName('../../etc/passwd'), 'passwd.csv');
  assert.throws(() => safeTraceName('.hidden'));
  assert.throws(() => safeTraceName('a b.csv'));
});
