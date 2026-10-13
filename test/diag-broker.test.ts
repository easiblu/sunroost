import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import { frame } from '../src/devices/inverters/voltronic/protocol.ts';
import {
  Broker, defaultConfig, deleteBroker, getBroker, listBrokers, normalizeConfig, RequestAssembler, saveBroker, textKey, voltronicReply,
  type BrokerConfig,
} from '../src/diagnostics/broker.ts';
import { decodeModbus, decodeVoltronic, withModbusCrc } from '../src/diagnostics/frames.ts';
import { memoryPair } from '../src/diagnostics/port.ts';

openDb(':memory:');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (addr: number, fn: number, start: number, count: number) =>
  withModbusCrc(Buffer.from([addr, fn, start >> 8, start & 0xff, count >> 8, count & 0xff]));

function modbusCfg(extra: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    ...defaultConfig('modbus'),
    name: 'Test',
    tables: [
      { address: 1, fn: 4, start: 0, values: [100, 200, -1, null] },
      { address: 1, fn: 3, start: 10, values: [7, 8] },
      { address: 2, fn: 4, start: 0, values: [5], respondAddress: 0 },
    ],
    ...extra,
  };
}

test('modbus emulation answers reads from the grid (signed, empty = 0, respond address)', async () => {
  const b = new Broker();
  await b.start(modbusCfg());
  const r = decodeModbus((await b.handle(read(1, 4, 0, 4)))!)!;
  assert.equal(r.kind, 'response');
  assert.deepEqual(r.values, [100, 200, 0xffff, 0]);
  const h = (await b.handle(read(1, 3, 10, 2)))!;
  assert.deepEqual(decodeModbus(h)!.values, [7, 8]);
  const other = (await b.handle(read(2, 4, 0, 1)))!;
  assert.equal(other[0], 0, 'answers under respondAddress');
  assert.equal(await b.handle(read(5, 4, 0, 1)), null, 'unknown address stays silent without a To device');
  assert.equal(b.stats.misses, 1);
  assert.ok(b.master.entries.some((e) => e.dir === 'rx' && e.text === 'MODBUS 4 0 4'));
  await b.stop();
});

test('modbus proxy: empty cells pass through, set cells are rewritten; writes honour Allow write', async () => {
  const [master, from] = memoryPair('/master', '/from');
  const [to, device] = memoryPair('/to', '/device');
  const deviceGot: Buffer[] = [];
  device.on('data', (req: Buffer) => {
    deviceGot.push(req);
    if (req[1] === 4) device.write(withModbusCrc(Buffer.from([req[0], 4, 8, 0, 1, 0, 2, 0, 3, 0, 4])));
    else if (req[1] === 6) device.write(req);
  });
  const b = new Broker();
  b.forwardTimeoutMs = 200;
  await b.start(modbusCfg());
  b.attach('from', from);
  b.attach('to', to);
  const replies: Buffer[] = [];
  master.on('data', (d: Buffer) => replies.push(d));

  // Through the wire: request bytes split across chunks, reassembled by length + CRC.
  const req = read(1, 4, 0, 4);
  await master.write(req.subarray(0, 3));
  await master.write(req.subarray(3));
  await sleep(40);
  assert.equal(deviceGot.length, 1, 'forwarded because a cell is empty');
  assert.deepEqual(decodeModbus(Buffer.concat(replies))!.values, [100, 200, 0xffff, 4], 'only the empty cell came from the device');

  // Write blocked: local ack, grid updated, not forwarded.
  const w = withModbusCrc(Buffer.from([1, 6, 0, 10, 0, 99]));
  const ack = (await b.handle(w))!;
  assert.ok(ack.equals(w), 'fn 6 ack echoes the request');
  assert.equal(deviceGot.length, 1);
  assert.equal(b.config!.tables[1].values[0], 99);

  // Write allowed: forwarded to the device.
  b.setAllowWrite(true);
  await b.handle(withModbusCrc(Buffer.from([1, 6, 0, 11, 0, 5])));
  assert.equal(deviceGot.length, 2);
  assert.equal(b.config!.tables[1].values[1], 5);

  // fn 16 local ack is addr fn reg count + CRC.
  b.setAllowWrite(false);
  const w16 = withModbusCrc(Buffer.from([1, 16, 0, 10, 0, 1, 2, 0, 1]));
  assert.deepEqual([...(await b.handle(w16))!.subarray(0, 6)], [1, 16, 0, 10, 0, 1]);
  assert.ok(b.slave.entries.some((e) => e.dir === 'tx'));
  await b.stop();
  assert.equal(from.isOpen, false);
  assert.equal(to.isOpen, false);
});

test('voltronic emulation: table answers, unknown forwarded and learned, NAK when no device, writes blocked', async () => {
  const b = new Broker();
  b.forwardTimeoutMs = 100;
  await b.start({ ...defaultConfig('voltronic'), name: 'V', responses: [{ request: 'QPIGS', response: '230.0 50.0' }] });
  const r = (await b.handle(frame('QPIGS')))!;
  assert.deepEqual(decodeVoltronic(r), { type: 'voltronic', text: '230.0 50.0', reply: true });
  assert.equal(decodeVoltronic((await b.handle(frame('QMOD')))!)!.text, 'NAK');
  assert.ok(b.master.entries.some((e) => e.dir === 'miss'));
  assert.equal(decodeVoltronic((await b.handle(frame('POP02')))!)!.text, 'ACK', 'write acknowledged locally');

  const [to, inverter] = memoryPair('/to', '/inv');
  inverter.on('data', () => inverter.write(voltronicReply('B')));
  b.attach('to', to);
  assert.equal(decodeVoltronic((await b.handle(frame('QMOD')))!)!.text, 'B');
  assert.deepEqual(b.config!.responses.at(-1), { request: 'QMOD', response: 'B' }, 'learned');
  await b.stop();
});

test('narada emulation: raw text table', async () => {
  const b = new Broker();
  await b.start({ ...defaultConfig('narada'), name: 'N', responses: [{ request: '~22014A42E00201FD15', response: '~22014A00ABCD' }] });
  const r = (await b.handle(Buffer.from('~22014A42E00201FD15\r')))!;
  assert.equal(r.toString(), '~22014A00ABCD\r');
  assert.equal(textKey('narada', Buffer.from('~X\r\n')), '~X');
  await b.stop();
});

test('request assembler: modbus resync on garbage; text frames at CR', () => {
  const got: string[] = [];
  const a = new RequestAssembler('modbus', (f) => got.push(f.toString('hex')));
  a.push(Buffer.concat([Buffer.from([0xff, 0x00]), read(1, 3, 0, 1)]));
  assert.deepEqual(got, [read(1, 3, 0, 1).toString('hex')]);
  a.dispose();
  const t: string[] = [];
  const v = new RequestAssembler('voltronic', (f) => t.push(f.toString('latin1')));
  v.push(Buffer.from('QPI'));
  v.push(Buffer.from('\rQMOD\r'));
  assert.deepEqual(t, ['QPI\r', 'QMOD\r']);
  v.dispose();
});

test('saved brokers: create, update, list, delete; validation', () => {
  const saved = saveBroker(modbusCfg({ name: 'BMS emu' }));
  assert.ok(saved.id);
  assert.deepEqual(getBroker(saved.id!)!.tables[0].values, [100, 200, -1, null]);
  saveBroker({ ...saved, name: 'Renamed' });
  assert.deepEqual(listBrokers().map((b) => b.name), ['Renamed']);
  deleteBroker(saved.id!);
  assert.equal(listBrokers().length, 0);
  assert.throws(() => saveBroker({ ...defaultConfig('modbus'), name: '' }), /name/);
  assert.throws(() => normalizeConfig({ type: 'modbus', tables: [{ address: 1, fn: 4, start: 0, values: [200000] }] }), /out of range/);
  assert.equal(normalizeConfig({ type: 'bogus' as never }).type, 'modbus');
});
