import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { frame } from '../src/devices/inverters/voltronic/protocol.ts';
import { parseFrame, parseAnalog } from '../src/devices/bms/serial-ascii.ts';
import { analogRequest, BmsConsole, hexByte, replyBytes, simulatedReply } from '../src/diagnostics/bms-console.ts';
import { withModbusCrc } from '../src/diagnostics/frames.ts';
import { stopAll } from '../src/diagnostics/index.ts';
import { Inspector } from '../src/diagnostics/inspect.ts';
import { ModbusConsole } from '../src/diagnostics/modbus-console.ts';
import { busyReason, closeAllPorts, MemoryPort, memoryPair, openPort, setPortFactory } from '../src/diagnostics/port.ts';
import { judge, randomPrintable, SerialTest } from '../src/diagnostics/serial-test.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Installs a factory that hands out the given ports by path. */
function usePorts(ports: Record<string, MemoryPort>) {
  setPortFactory(async (path) => {
    const p = ports[path];
    if (!p) throw new Error(`No such device ${path}`);
    p.isOpen = true;
    return p;
  });
}

after(async () => {
  await stopAll();
  setPortFactory();
});

test('port registry: one owner per path, released on close', async () => {
  const a = new MemoryPort('/dev/ttyA');
  usePorts({ '/dev/ttyA': a });
  const p = await openPort('/dev/ttyA', 9600, 'Tool 1');
  assert.equal(busyReason('/dev/ttyA'), 'in use by Tool 1');
  await assert.rejects(openPort('/dev/ttyA', 9600, 'Tool 2'), /in use by Tool 1/);
  await p.close();
  assert.equal(busyReason('/dev/ttyA'), null);
  await closeAllPorts();
});

test('serial test: loopback passes, dead port fails, cross-wired pair passes', async () => {
  const loop = new MemoryPort('/dev/loop');
  loop.peer = loop; // TX wired to RX
  const dead = new MemoryPort('/dev/dead');
  const [x, y] = memoryPair('/dev/x', '/dev/y');
  usePorts({ '/dev/loop': loop, '/dev/dead': dead, '/dev/x': x, '/dev/y': y });
  const t = new SerialTest();
  t.periodMs = 30;
  await t.start(['/dev/loop', '/dev/dead', '/dev/x', '/dev/y']);
  await sleep(100);
  const s = t.state();
  const by = Object.fromEntries(s.ports.map((p) => [p.path, p]));
  assert.equal(by['/dev/loop'].ok, true);
  assert.equal(by['/dev/dead'].ok, false);
  assert.equal(by['/dev/x'].ok, true);
  assert.equal(by['/dev/y'].ok, true);
  assert.ok(by['/dev/loop'].rounds >= 1);
  assert.match(by['/dev/loop'].transmit, /^[0-z]{16}$/);
  await t.stop();
  assert.equal(t.running, false);
  assert.equal(loop.isOpen, false, 'ports closed on stop');
  assert.equal(busyReason('/dev/loop'), null);
});

test('serial test helpers', () => {
  const s = randomPrintable(200);
  assert.ok([...s].every((c) => c.charCodeAt(0) >= 48 && c.charCodeAt(0) <= 122));
  assert.equal(judge('abc', ''), false);
  assert.equal(judge('abc', 'xxabcxx'), true);
  assert.equal(judge('abc', 'def', ['def']), true);
});

test('inspect: pipe relays both ways and logs decoded frames side by side', async () => {
  const [inverterSide, dev1Wire] = memoryPair('/inv', '/dev/ttyUSB0'); // inverter ↔ dev1
  const [bmsSide, dev2Wire] = memoryPair('/bms', '/dev/ttyUSB1'); // bms ↔ dev2
  usePorts({ '/dev/ttyUSB0': dev1Wire, '/dev/ttyUSB1': dev2Wire });
  const ins = new Inspector();
  ins.splitMs = 15;
  await ins.connect('dev1', '/dev/ttyUSB0', 9600);
  await ins.connect('dev2', '/dev/ttyUSB1', 9600);
  ins.setSplit(15);
  ins.setPipe('dev1', true);
  ins.setPipe('dev2', true);
  const req = withModbusCrc(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]));
  const rep = withModbusCrc(Buffer.from([0x01, 0x03, 0x02, 0x00, 0x2a]));
  const bmsGot: Buffer[] = [];
  bmsSide.on('data', (d: Buffer) => {
    bmsGot.push(d);
    bmsSide.write(rep);
  });
  const invGot: Buffer[] = [];
  inverterSide.on('data', (d: Buffer) => invGot.push(d));
  await inverterSide.write(req);
  await sleep(60);
  assert.ok(Buffer.concat(bmsGot).equals(req), 'request reached dev2 side');
  assert.ok(Buffer.concat(invGot).equals(rep), 'reply reached dev1 side');
  const rx = ins.state().log.filter((e) => e.dir === 'rx');
  assert.deepEqual(rx.map((e) => [e.side, e.text]), [['dev1', 'MODBUS 3 0 1'], ['dev2', 'MODBUS 3 reply 42']]);
  // The pair was recorded into the trace.
  assert.equal(ins.trace.rows.length, 1);
  await ins.stop();
  assert.equal(dev1Wire.isOpen, false);
  assert.equal(dev2Wire.isOpen, false);
});

test('inspect: trace save/load and replay as a fake device with MISS reporting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-trace-'));
  const ins = new Inspector();
  ins.traceDir = dir;
  ins.splitMs = 10;
  const q = frame('QPIGS');
  const a = Buffer.from('(230.0 50.0\r');
  ins.trace.rows = [{ request: q, response: a, notes: 'status' }];
  await ins.saveTrace('run1');
  assert.match(readFileSync(join(dir, 'run1.csv'), 'utf8'), /^Request,Response,Notes\n/);
  ins.closeTrace();
  assert.equal(ins.trace.rows.length, 0);
  await ins.loadTrace('run1.csv');
  assert.equal(ins.trace.rows.length, 1);
  assert.deepEqual(await ins.listTraces(), ['run1.csv']);

  const [master, wire] = memoryPair('/master', '/dev/ttyUSB0');
  usePorts({ '/dev/ttyUSB0': wire });
  await ins.connect('dev1', '/dev/ttyUSB0', 2400);
  await ins.connect('dev2', 'TRACE', 115200);
  ins.setSplit(10);
  ins.setPipe('dev1', true);
  ins.setPipe('dev2', true);
  const got: Buffer[] = [];
  master.on('data', (d: Buffer) => got.push(d));
  await master.write(q);
  await sleep(50);
  assert.equal(Buffer.concat(got).toString(), a.toString(), 'trace answered the known request');
  await master.write(frame('QMOD'));
  await sleep(50);
  assert.equal(ins.misses.length, 1);
  assert.match(ins.misses[0], /^MISS: 514D4F44/);
  assert.ok(ins.state().log.some((e) => e.dir === 'miss' && e.text.includes('QMOD')));
  // Manual send logs a tx entry
  await ins.send('dev1', Buffer.from('hi'));
  assert.equal(ins.state().log.at(-1)!.dir, 'tx');
  await ins.stop();
  // A hand-written CSV with text cells also loads
  writeFileSync(join(dir, 'hand.csv'), 'Request,Response,Notes\nQPI\\r,(PI30\\r,\n');
  await ins.loadTrace('hand');
  assert.equal(ins.trace.rows[0].response.toString(), '(PI30\r');
});

test('inspect: pipe requires both sides connected', async () => {
  const ins = new Inspector();
  assert.throws(() => ins.setPipe('dev1', true), /Connect dev1 first/);
  assert.throws(() => ins.setSplit(0));
});

test('bms console: analogue request, simulated reply decodes, bytes start at VER', async () => {
  assert.equal(analogRequest(0x20, 0x02, 0xff).toString(), '~20024642E002FFFD09\r');
  assert.equal(hexByte('ff', 'x'), 255);
  assert.throws(() => hexByte('123', 'Unit'));
  const sim = simulatedReply(0x20, 2);
  const f = parseFrame(sim);
  const [pack] = parseAnalog(f.info);
  assert.equal(pack.cells.length, 15);
  assert.equal(pack.current, -10);
  const { bytes, checksumOk } = replyBytes(sim.toString('latin1'));
  assert.equal(checksumOk, true);
  assert.deepEqual(bytes.slice(0, 4), [0x20, 0x02, 0x46, 0x00]);
  assert.equal(bytes[8], 15, 'cell count at index 8');
  assert.equal(bytes[39], 5, 'temperature count at index 39');
  assert.equal((bytes[50] << 8) | bytes[51], 0xff9c, 'current at index 50');

  // Over a wire: the console waits for "~…\r"
  const [bms, wire] = memoryPair('/bms', '/dev/ttyBMS');
  bms.on('data', () => {
    bms.write(Buffer.concat([Buffer.from('noise'), sim]));
  });
  const c = new BmsConsole();
  c.attach(wire);
  const res = await c.submit(0x20, 2, 0xff);
  assert.equal(res.response, sim.toString('latin1'));
  assert.equal(res.checksumOk, true);
  await c.disconnect();
  await assert.rejects(c.submit(0x20, 2, 0xff), /Not connected/);
  const s = await c.submit(0x20, 2, 0xff, true);
  assert.equal(s.checksumOk, true);
});

test('modbus console: RTU query, exception and no response', async () => {
  const [slave, wire] = memoryPair('/slave', '/dev/ttyRTU');
  slave.on('data', (req: Buffer) => {
    if (req[0] === 9) return; // address 9: silent
    if (req[1] === 3) return void slave.write(withModbusCrc(Buffer.from([req[0], 0x83, 0x02])));
    // split the reply in two chunks to exercise reassembly
    const rep = withModbusCrc(Buffer.from([req[0], 4, 4, 0x01, 0x02, 0x03, 0x04]));
    slave.write(rep.subarray(0, 3)).then(() => slave.write(rep.subarray(3)));
  });
  const mc = new ModbusConsole();
  mc.timeoutMs = 100;
  mc.attach(wire);
  const res = await mc.query(1, 4, 0, 2);
  assert.deepEqual(res.registers, [0x0102, 0x0304]);
  await assert.rejects(mc.query(1, 3, 0, 2), /exception 2/);
  await assert.rejects(mc.query(9, 4, 0, 2), /No response/);
  assert.ok(mc.log.entries.some((e) => e.text.startsWith('Send: 010400000002')));
  await mc.disconnect();
  await assert.rejects(mc.query(1, 4, 0, 2), /Not connected/);
});
