import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DeyeDriver } from '../src/devices/inverters/deye/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { modbusCrc, parseReply, readRequest, serveRequest, writeRequest } from '../src/devices/rtu.ts';
import {
  discoverLoggers,
  encodeRequest,
  fakeLogger,
  modbusFromResponse,
  parseDiscoveryReply,
  parseSolarman,
  splitFrames,
} from '../src/devices/solarman.ts';

test('Modbus CRC matches the standard check value', () => {
  // "123456789" → 0x4B37 (CRC-16/MODBUS check value).
  assert.equal(modbusCrc(Buffer.from('123456789')), 0x4b37);
  // Read holding 0x0000 ×1 from unit 1 is the well-known frame 01 03 00 00 00 01 84 0A.
  assert.equal(readRequest(1, 3, 0, 1).toString('hex'), '010300000001840a');
});

test('RTU replies: registers, exceptions, CRC and padding', () => {
  const maps = { input: new Map([[10, 0x1234]]), holding: new Map([[5, 7]]) };
  const req = readRequest(1, 4, 10, 2);
  const reply = serveRequest(req, maps);
  assert.deepEqual(parseReply(req, reply), [0x1234, 0]);
  // Trailing bytes after the frame (some loggers pad) are ignored.
  assert.deepEqual(parseReply(req, Buffer.concat([reply, Buffer.from([0, 0])])), [0x1234, 0]);
  const bad = Buffer.from(reply);
  bad[4] ^= 0xff;
  assert.throws(() => parseReply(req, bad), /CRC/);
  const w = writeRequest(1, 5, [9, 10], true);
  assert.deepEqual(parseReply(w, serveRequest(w, maps)), []);
  assert.equal(maps.holding.get(6), 10);
  const exc = Buffer.from([1, 0x83, 2, 0, 0]);
  exc.writeUInt16LE(modbusCrc(exc, 0, 3), 3);
  assert.throws(() => parseReply(readRequest(1, 3, 0, 1), exc), /illegal data address/);
});

test('V5 frames: encode, checksum, split with garbage and partial data', () => {
  const modbus = readRequest(1, 3, 0x0003, 5);
  const f = encodeRequest(2712345678, 0x42, modbus);
  assert.equal(f[0], 0xa5);
  assert.equal(f.at(-1), 0x15);
  assert.equal(f.readUInt16LE(1), 15 + modbus.length);
  assert.equal(f.readUInt16LE(3), 0x4510);
  assert.equal(f.readUInt32LE(7), 2712345678);
  const { frames, rest } = splitFrames(Buffer.concat([Buffer.from([1, 2, 3]), f, f.subarray(0, 6)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].serial, 2712345678);
  assert.equal(frames[0].sequence, 0x42);
  assert.deepEqual(frames[0].payload.subarray(15), modbus);
  assert.equal(rest.length, 6);
  const corrupt = Buffer.from(f);
  corrupt[12] ^= 1;
  assert.equal(splitFrames(corrupt).frames.length, 0);
  assert.throws(() => modbusFromResponse(Buffer.alloc(14)), /without inverter data/);
});

test('connection strings and discovery replies', () => {
  assert.deepEqual(parseSolarman('solarman://192.168.1.20/2712345678'), { host: '192.168.1.20', port: 8899, serial: 2712345678 });
  assert.deepEqual(parseSolarman('solarman://logger.lan:9000/17'), { host: 'logger.lan', port: 9000, serial: 17 });
  assert.equal(parseSolarman('solarman://x/99999999999'), null);
  assert.equal(parseSolarman('192.168.1.20:8899'), null);
  assert.deepEqual(parseConnection('solarman://10.0.0.5/123', 9600, 1), {
    type: 'solarman', host: '10.0.0.5', port: 8899, loggerSerial: 123, address: 1,
  });
  assert.deepEqual(parseDiscoveryReply('192.168.1.20,98D863A1B2C3,2712345678'), {
    ip: '192.168.1.20', mac: '98D863A1B2C3', serial: '2712345678', connection: 'solarman://192.168.1.20/2712345678',
  });
  assert.equal(parseDiscoveryReply('hello'), null);
});

test('ModbusConnection over a fake logger (with heartbeats), and a Deye driver poll', async () => {
  const holding = new Map<number, number>([[0, 3], [3, 0x4142], [4, 0x4344], [5, 0x3031], [6, 0x3233], [7, 0x3435], [16, 50000], [17, 0]]);
  const server = fakeLogger({ serial: 1234567890, holding, heartbeat: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    const conn = new ModbusConnection(parseConnection(`solarman://127.0.0.1:${port}/1234567890`, 9600, 1));
    await conn.connect();
    assert.equal(conn.isOpen, true);
    const [a, b] = await Promise.all([conn.read(3, 0, 1), conn.read(3, 3, 5)]);
    assert.deepEqual(a, [3]);
    assert.deepEqual(b, [0x4142, 0x4344, 0x3031, 0x3233, 0x3435]);
    await conn.write(200, [77], { multiple: true });
    assert.equal(holding.get(200), 77);
    await conn.close();
    assert.equal(conn.isOpen, false);

    const deye = new DeyeDriver({ modelId: 'hybrid', connection: `solarman://127.0.0.1:${port}/1234567890`, baudRate: 9600, address: 1, index: 0 });
    await deye.connect();
    assert.equal(deye.info()['Serial number'], 'ABCD012345');
    const live = await deye.read();
    assert.ok(Object.keys(live).length > 5);
    await deye.close();

    // A wrong serial gets no answer: the request times out instead of hanging.
    const wrong = new ModbusConnection({ type: 'solarman', host: '127.0.0.1', port, loggerSerial: 1, address: 1, timeoutMs: 300 });
    await wrong.connect();
    await assert.rejects(wrong.read(3, 0, 1), /No reply from logger/);
    await wrong.close();
  } finally {
    server.close();
  }
});

test('discovery collects logger answers', async () => {
  const responder = createSocket('udp4');
  responder.on('message', (msg, rinfo) => {
    if (msg.toString() === 'WIFIKIT-214028-READ') responder.send('127.0.0.1,AABBCCDDEEFF,2712345678', rinfo.port, rinfo.address);
  });
  responder.bind(0, '127.0.0.1');
  await once(responder, 'listening');
  try {
    const found = await discoverLoggers(300, ['127.0.0.1'], responder.address().port);
    assert.deepEqual(found, [{ ip: '127.0.0.1', mac: 'AABBCCDDEEFF', serial: '2712345678', connection: 'solarman://127.0.0.1/2712345678' }]);
  } finally {
    responder.close();
  }
});
