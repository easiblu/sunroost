import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer, Socket, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  acquireServer,
  discoverEybond,
  encodeFrame,
  EybondClient,
  eybondConnection,
  EybondServer,
  FC_FORWARD,
  FC_HEARTBEAT,
  fakeDongle,
  heartbeatPayload,
  parseEybond,
  parsePn,
  parseRedirectReply,
  redirectCommand,
  redirectDongle,
  releaseServer,
  sharedServer,
  splitFrames,
} from '../src/devices/eybond.ts';
import { readRequest } from '../src/devices/rtu.ts';

const PN = 'W0012345678901';

async function startServer() {
  const server = new EybondServer({ heartbeatS: 60 });
  const port = await server.listen(0, '127.0.0.1');
  return { server, port };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('frames: header layout, length rule, split with partial data, bad length', () => {
  const rtu = readRequest(1, 3, 201, 34);
  const f = encodeFrame({ tid: 0x1234, devcode: 0x0994, devaddr: 1, fcode: FC_FORWARD, payload: rtu });
  assert.equal(f.length, 8 + rtu.length);
  assert.equal(f.readUInt16BE(0), 0x1234);
  assert.equal(f.readUInt16BE(2), 0x0994);
  assert.equal(f.readUInt16BE(4), rtu.length + 2); // counts devaddr + fcode + payload
  assert.equal(f[6], 1);
  assert.equal(f[7], 4);
  assert.deepEqual(f.subarray(8), rtu);

  const hb = encodeFrame({ tid: 7, devcode: 0, fcode: FC_HEARTBEAT, payload: heartbeatPayload(new Date(Date.UTC(2026, 9, 13, 8, 5, 9)), 60) });
  assert.equal(hb.toString('hex'), '00070000000a0101' + '1a0a0d080509003c');

  const { frames, rest, bad } = splitFrames(Buffer.concat([f, hb, f.subarray(0, 5)]));
  assert.equal(bad, false);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].tid, 0x1234);
  assert.deepEqual(frames[0].payload, rtu);
  assert.equal(frames[1].fcode, FC_HEARTBEAT);
  assert.equal(rest.length, 5);
  // A header with length 0 can't be a frame: the stream is out of step.
  assert.equal(splitFrames(Buffer.from('0001000100000101', 'hex')).bad, true);
  // An empty-payload frame (inverter didn't answer) is valid.
  assert.equal(splitFrames(encodeFrame({ tid: 1, fcode: 4 })).frames[0].payload.length, 0);
});

test('PN parsing, connection strings and redirect text', () => {
  assert.equal(parsePn(Buffer.from(PN)), PN);
  assert.equal(parsePn(Buffer.concat([Buffer.from('Q0029374823'), Buffer.alloc(3)])), 'Q0029374823');
  assert.equal(parsePn(heartbeatPayload()), null);
  assert.equal(parsePn(Buffer.alloc(14)), null);

  assert.deepEqual(parseEybond('eybond://'), { port: 8899 });
  assert.deepEqual(parseEybond('eybond://502'), { port: 502 });
  assert.deepEqual(parseEybond(`eybond://8899/${PN}`), { port: 8899, pn: PN });
  assert.deepEqual(parseEybond(`eybond:///${PN}`), { port: 8899, pn: PN });
  assert.equal(parseEybond('eybond://99999'), null);
  assert.equal(parseEybond('solarman://1.2.3.4/5'), null);
  assert.equal(eybondConnection(PN), `eybond://8899/${PN}`);
  assert.equal(eybondConnection(undefined, 502), 'eybond://502');
  assert.deepEqual(parseEybond(eybondConnection(PN, 502)), { port: 502, pn: PN });

  assert.equal(redirectCommand('192.168.1.10', 8899), 'set>server=192.168.1.10:8899;');
  assert.equal(parseRedirectReply('rsp>server=1;'), '1');
  assert.equal(parseRedirectReply('hello'), null);
});

test('heartbeats: the server asks on connect, learns the PN, answers unsolicited heartbeats once', async () => {
  const { server, port } = await startServer();
  try {
    const sock = new Socket();
    await new Promise<void>((r) => sock.connect(port, '127.0.0.1', () => r()));
    const got: ReturnType<typeof splitFrames>['frames'] = [];
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (d) => {
      const r = splitFrames(Buffer.concat([buf, d]));
      buf = r.rest;
      got.push(...r.frames);
    });
    // The server's first frame is a heartbeat request with the 8-byte date payload.
    while (!got.length) await once(sock, 'data');
    const req = got[0];
    assert.equal(req.fcode, FC_HEARTBEAT);
    assert.equal(req.payload.length, 8);
    assert.equal(req.payload.readUInt16BE(6), 60);

    const identified = once(server, 'dongle');
    sock.write(encodeFrame({ tid: req.tid, devcode: 0, devaddr: 1, fcode: FC_HEARTBEAT, payload: Buffer.from(PN) }));
    const [session] = await identified;
    assert.equal(session.pn, PN);
    assert.deepEqual(server.dongles().map((d) => d.pn), [PN]);
    // Answering the server's request must not trigger another answer.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.length, 1);

    // An unsolicited heartbeat (fresh tid) is answered with the same tid.
    sock.write(encodeFrame({ tid: 0x4242, devcode: 0x0994, devaddr: 0xff, fcode: FC_HEARTBEAT, payload: Buffer.from(PN) }));
    while (got.length < 2) await once(sock, 'data');
    assert.equal(got[1].tid, 0x4242);
    assert.equal(got[1].fcode, FC_HEARTBEAT);
    assert.equal(got[1].payload.length, 8);
    sock.destroy();
    await once(server, 'gone');
    assert.deepEqual(server.dongles(), []);
  } finally {
    await server.close();
  }
});

test('read/write round trip through a fake dongle, plus collector queries', async () => {
  const { server, port } = await startServer();
  const holding = new Map<number, number>([[201, 3], [202, 2301], [215, 0xfff6]]);
  const dongle = fakeDongle({ port, pn: PN, holding, params: new Map([[5, '1.2.3']]), unsolicitedHeartbeat: true });
  const client = new EybondClient({ server, pn: PN, connectTimeoutMs: 2000, timeoutMs: 1000 });
  try {
    await client.connect();
    assert.equal(client.isOpen, true);
    assert.deepEqual(await client.read(1, 3, 201, 2), [3, 2301]);
    assert.deepEqual(await client.read(1, 3, 215, 1), [0xfff6]);
    await client.write(1, 300, [5], false);
    await client.write(1, 310, [7, 8], true);
    assert.equal(holding.get(300), 5);
    assert.deepEqual([holding.get(310), holding.get(311)], [7, 8]);
    assert.deepEqual(await client.queryParam(5), { status: 0, param: 5, value: '1.2.3' });
    assert.equal(dongle.forwarded, 4);
  } finally {
    await client.close();
    dongle.close();
    await server.close();
  }
});

test('connect waits for the right PN (any dongle when none is given) and times out', async () => {
  const { server, port } = await startServer();
  const other = 'W0099999999999';
  const dongles = [] as ReturnType<typeof fakeDongle>[];
  try {
    const want = new EybondClient({ server, pn: PN, connectTimeoutMs: 2000 });
    const waiting = want.connect();
    let done = false;
    void waiting.then(() => (done = true));
    dongles.push(fakeDongle({ port, pn: other }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(done, false, 'another dongle must not satisfy a PN-specific connect');
    dongles.push(fakeDongle({ port, pn: PN, holding: new Map([[1, 42]]) }));
    await waiting;
    assert.deepEqual(await want.read(1, 3, 1, 1), [42]);

    const any = new EybondClient({ server, connectTimeoutMs: 1000 });
    await any.connect();
    assert.ok(any.pn === PN || any.pn === other);

    const missing = new EybondClient({ server, pn: 'W0000000000000', connectTimeoutMs: 150 });
    await assert.rejects(missing.connect(), /has not connected/);
    assert.equal(missing.isOpen, false);
  } finally {
    for (const d of dongles) d.close();
    await server.close();
  }
});

test('request timeout, dongle drop and reconnect', async () => {
  const { server, port } = await startServer();
  const mute = fakeDongle({ port, pn: PN, mute: true });
  const client = new EybondClient({ server, pn: PN, connectTimeoutMs: 2000, timeoutMs: 150 });
  try {
    await client.connect();
    await assert.rejects(client.read(1, 3, 0, 1), /No reply from dongle/);
    mute.close();
    await once(server, 'gone');
    assert.equal(client.isOpen, false);
    await assert.rejects(client.read(1, 3, 0, 1), /not connected/);
    // The dongle comes back: the same client picks up the new session.
    const back = fakeDongle({ port, pn: PN, holding: new Map([[0, 9]]) });
    await server.waitForDongle(PN, 2000);
    assert.equal(client.isOpen, true);
    assert.deepEqual(await client.read(1, 3, 0, 1), [9]);
    back.close();
  } finally {
    await client.close();
    await server.close();
  }
});

test('concurrent requests are serialised per dongle (one in flight)', async () => {
  const { server, port } = await startServer();
  const holding = new Map<number, number>(Array.from({ length: 10 }, (_, i) => [i, i * 11] as [number, number]));
  const dongle = fakeDongle({ port, pn: PN, holding, replyDelayMs: 20 });
  // Two clients on the same dongle (e.g. the poller and the console) share the session queue.
  const a = new EybondClient({ server, pn: PN, connectTimeoutMs: 2000 });
  const b = new EybondClient({ server, pn: PN, connectTimeoutMs: 2000 });
  try {
    await a.connect();
    await b.connect();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).read(1, 3, i, 1)));
    assert.deepEqual(results, Array.from({ length: 10 }, (_, i) => [i * 11]));
    assert.equal(dongle.forwarded, 10);
    assert.equal(dongle.maxInFlight, 1);
  } finally {
    dongle.close();
    await server.close();
  }
});

test('shared listener: one per port, closed when the last client leaves', async () => {
  const port = await freePort();
  const s1 = await acquireServer(port);
  const s2 = await acquireServer(port);
  assert.equal(s1, s2);
  assert.equal(sharedServer(port), s1);
  const dongle = fakeDongle({ port, pn: PN, holding: new Map([[5, 55]]) });
  const client = new EybondClient({ port, pn: PN, connectTimeoutMs: 2000 });
  await client.connect();
  assert.deepEqual(await client.read(1, 3, 5, 1), [55]);
  await client.close();
  await releaseServer(s1);
  assert.equal(sharedServer(port), s2);
  await releaseServer(s2);
  assert.equal(sharedServer(port), null);
  dongle.close();
});

test('redirect and discovery send set>server over UDP and read the reply', async () => {
  // A fake dongle UDP endpoint on loopback.
  const udp = createSocket('udp4');
  const seen: string[] = [];
  udp.on('message', (msg, rinfo) => {
    seen.push(msg.toString());
    udp.send('rsp>server=1;', rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  const udpPort = udp.address().port;
  try {
    const r = await redirectDongle('127.0.0.1', '10.0.0.2', 8899, { udpPort, waitMs: 1000 });
    assert.deepEqual(r, { command: 'set>server=10.0.0.2:8899;', reply: '1' });
    const found = await discoverEybond('10.0.0.2', 502, { targets: ['127.0.0.1'], udpPort, waitMs: 200 });
    assert.deepEqual(found, [{ ip: '127.0.0.1', reply: '1' }]);
    assert.deepEqual(seen, ['set>server=10.0.0.2:8899;', 'set>server=10.0.0.2:502;']);
  } finally {
    udp.close();
  }
});
