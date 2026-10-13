import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as daly from '../src/devices/bms/daly.ts';
import * as jbd from '../src/devices/bms/jbd.ts';
import * as jk from '../src/devices/bms/jk.ts';
import { MultiPortBms, packMetrics } from '../src/devices/bms/pack.ts';
import * as pylon from '../src/devices/bms/serial-ascii.ts';
import { BaseLink, lengthReader, terminatedReader, type ByteLink } from '../src/devices/bms/serial.ts';
import { invertPacks, serialBmsDrivers } from '../src/devices/bms/index.ts';

/** A link that answers each request via `respond` (null = silence), delivered in two chunks with noise. */
class ScriptedLink extends BaseLink {
  open_ = false;
  requests: Buffer[] = [];
  private respond: (req: Buffer) => Buffer | null;
  constructor(name: string, respond: (req: Buffer) => Buffer | null) {
    super(name);
    this.respond = respond;
  }
  get isOpen() {
    return this.open_;
  }
  async open() {
    this.open_ = true;
  }
  async close() {
    this.open_ = false;
  }
  protected async write(data: Buffer) {
    this.requests.push(data);
    const reply = this.respond(data);
    if (!reply) return;
    const mid = Math.floor(reply.length / 2);
    setImmediate(() => {
      this.feed(Buffer.from([0x00])); // line noise before the frame
      this.feed(reply.subarray(0, mid));
      setImmediate(() => this.feed(reply.subarray(mid)));
    });
  }
}

const bytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const sum8 = (b: Buffer) => b.reduce((a, x) => a + x, 0);

// ---- serial helper -----------------------------------------------------------------------

test('serial: frame readers resync and the link times out', async () => {
  const term = terminatedReader(0x7e, 0x0d);
  assert.equal(term(Buffer.from('xx~AB')), -2);
  assert.equal(term(Buffer.from('~AB')), 0);
  assert.equal(term(Buffer.from('~AB\rzz')), 4);
  const len = lengthReader([0xdd], 4, (h) => h[3] + 7);
  assert.equal(len(bytes('00 DD')), -1);
  assert.equal(len(bytes('DD 03 00 02 AA')), 0);
  assert.equal(len(bytes('DD 03 00 00 FF FD 77 01')), 7);

  const silent = new ScriptedLink('silent', () => null);
  await silent.open();
  await assert.rejects(silent.request(bytes('01'), term, { timeoutMs: 30 }), /no response/);
  const echo = new ScriptedLink('echo', (r) => r);
  await echo.open();
  // Concurrent requests are serialised by the mutex: each gets its own reply.
  const [a, b] = await Promise.all([
    echo.request(Buffer.from('~A\r'), term, { timeoutMs: 200 }),
    echo.request(Buffer.from('~B\r'), term, { timeoutMs: 200 }),
  ]);
  assert.equal(a.toString(), '~A\r');
  assert.equal(b.toString(), '~B\r');
});

// ---- Pylontech -----------------------------------------------------------------------------

test('pylontech: frame builder matches known request frames', () => {
  assert.equal(pylon.buildFrame(0x20, 0x01, 0x4a, 0x42).toString(), '~20014A420000FDA2\r');
  assert.equal(pylon.buildFrame(0x20, 0x02, 0x46, 0x42, Uint8Array.of(2)).toString(), '~20024642E00202FD33\r');
  assert.equal(pylon.lengthField(2), 0xe002);
  assert.equal(pylon.lengthField(0), 0x0000);
  assert.equal(pylon.lengthField(0x12), 0xd012);
  const f = pylon.parseFrame('~20024642E00202FD33\r');
  assert.deepEqual([f.ver, f.adr, f.cid1, f.cid2, [...f.info]], [0x20, 2, 0x46, 0x42, [2]]);
  assert.throws(() => pylon.parseFrame('~20024642E00202FD34\r'), /checksum/);
  assert.throws(() => pylon.parseFrame('~20024642F00202FD32\r'), /checksum/);
});

const CELLS15 = '0CE4 0CEE' + ' 0CE9'.repeat(13);
const TEMPS5 = '05 0BA5 0B9B 0B9B 0BA0 0BA0';
// INFOFLAG 00, address 02, 15 cells, 5 temps, -10.0 A, 49.000 V, 40 Ah left, P=2, 50 Ah, 16 cycles
const ANALOG_INFO = `00 02 0F ${CELLS15} ${TEMPS5} FF9C BF68 9C40 02 C350 0010`;

test('pylontech: analog values decode', () => {
  const [p] = pylon.parseAnalog(bytes(ANALOG_INFO));
  assert.equal(p.cells.length, 15);
  assert.equal(p.cells[0], 3.3);
  assert.equal(p.cells[1], 3.31);
  assert.deepEqual(p.temperatures, [25, 24, 24, 24.5, 24.5]);
  assert.equal(p.current, -10);
  assert.equal(p.voltage, 49);
  assert.equal(p.remainingAh, 40);
  assert.equal(p.totalAh, 50);
  assert.equal(p.cycles, 16);
  const m = packMetrics(pylon.pylonReading(p));
  assert.equal(m['State of charge'], 80);
  assert.equal(m.Power, -490);
  assert.equal(m['Device mode'], 'Discharging');
  assert.equal(m.Temperature, 25);
  assert.equal(m['Cell voltage - Highest'], 3.31);
  assert.equal(m['Cell voltage - Lowest'], 3.3);
  assert.equal(m['Cell voltage - Difference'], 0.01);
  assert.equal(m['Cell temperature - Highest'], 24.5);
});

test('pylontech: several pack blocks in one reply (incl. 24-bit capacities)', () => {
  const block2 = `10 ${'0D05 '.repeat(16)} 06 0BA5 0BA5 0BA5 0BA5 0BA5 0BB9 0064 C80A FFFF 04 FFFF 0123 01ADB0 01D4C0`;
  const packs = pylon.parseAnalog(bytes(`00 02 0F ${CELLS15} ${TEMPS5} FF9C BF68 9C40 02 C350 0010 ${block2}`));
  assert.equal(packs.length, 2);
  assert.equal(packs[1].cells.length, 16);
  assert.equal(packs[1].current, 10);
  assert.equal(packs[1].voltage, 51.21);
  assert.equal(packs[1].remainingAh, 110);
  assert.equal(packs[1].totalAh, 120);
  assert.equal(packs[1].cycles, 0x123);
  const m = packMetrics(pylon.pylonReading(packs[1]));
  assert.equal(m['Temperature MOS'], 27);
  assert.equal(m['Device mode'], 'Charging');
});

test('pylontech: alarms, management and identity', () => {
  const info = bytes(`00 02 0F 00 00 01 ${'00 '.repeat(12)} 05 00 00 02 00 00 00 00 00 04 00 00`);
  assert.deepEqual(pylon.parseAlarms(info), ['Cell 3 voltage low', 'Temperature 2 high', 'Charge over current']);
  assert.deepEqual(pylon.parseManagement(bytes('02 D002 AFC8 0250 FDA8 C0')), { maxChargeCurrent: 59.2, maxDischargeCurrent: 60 });
  const man = Buffer.concat([Buffer.from('US2000C\0\0\0'), bytes('0207'), Buffer.from('PYLON'.padEnd(20, '\0'))]);
  assert.deepEqual(pylon.parseManufacturer(man), { model: 'US2000C', firmware: '2.7', manufacturer: 'PYLON' });
  assert.equal(pylon.parseSerial(Buffer.concat([bytes('02'), Buffer.from('PPTAH0123456789X')])), 'PPTAH0123456789X');
});

function pylonBus(alive: number[], broken = new Set<number>()) {
  return (req: Buffer) => {
    const f = pylon.parseFrame(req);
    if (!alive.includes(f.adr)) return null;
    if (broken.has(f.adr)) return Buffer.from('~2003460000000000\r'); // bad checksum
    if (f.cid2 === pylon.CMD.analog) {
      const info = bytes(ANALOG_INFO);
      info[1] = f.adr;
      return pylon.buildFrame(0x20, f.adr, 0x46, 0x00, info);
    }
    if (f.cid2 === pylon.CMD.alarm) return pylon.buildFrame(0x20, f.adr, 0x46, 0x00, bytes(`00 ${f.adr.toString(16).padStart(2, '0')} 00 00 00 00 00 00 00`));
    return pylon.buildFrame(0x20, f.adr, 0x46, 0x04); // invalid CID2
  };
}

test('pylontech: stacked packs are discovered and a failing pack keeps its slot', async () => {
  const broken = new Set<number>();
  const links: ScriptedLink[] = [];
  const bms = pylon.createSerial(['/dev/a'], { modelId: 'pylontech', maxPacks: () => 16 }, (path) => {
    const l = new ScriptedLink(path, pylonBus([2, 3, 4], broken));
    links.push(l);
    return l;
  });
  await bms.connect();
  let packs = await bms.read();
  assert.equal(packs.length, 3);
  assert.equal(packs[2]['State of charge'], 80);
  assert.equal(packs[0].Alarms, '');
  broken.add(3);
  packs = await bms.read();
  assert.equal(packs.length, 3);
  assert.ok(!(1 in packs), 'pack 2 left as a hole');
  assert.ok(packs[0] && packs[2]);
  broken.add(2).add(4);
  await assert.rejects(bms.read());
});

// ---- JK ------------------------------------------------------------------------------------

test('jk: read-all request matches the documented frame', () => {
  assert.equal(jk.buildRequest(0x06).toString('hex').toUpperCase(), '4E57001300000000060300000000000068000001' + '29');
});

test('jk: current sign bit and temperature encoding', () => {
  assert.equal(jk.jkCurrent(0x83e8), 10);
  assert.equal(jk.jkCurrent(0x03e8), -10);
  assert.equal(jk.jkCurrent(0x8000), 0);
  assert.equal(jk.jkCurrent(9000, 0), 10);
  assert.equal(jk.jkCurrent(11000, 0), -10);
  assert.equal(jk.jkTemp(25), 25);
  assert.equal(jk.jkTemp(105), -5);
});

function jkFrame(data: Buffer) {
  const head = Buffer.concat([bytes('4E57 0000 00000000 06 00 01'), data, bytes('00000000 68 0000 0000')]);
  head.writeUInt16BE(head.length - 2, 2);
  head.writeUInt16BE(sum8(head.subarray(0, head.length - 4)) & 0xffff, head.length - 2);
  return head;
}

const pad = (s: string, n: number) => Buffer.from(s.padEnd(n, '\0'), 'latin1').toString('hex');
const JK_DATA = bytes(
  '79 0C 01 0CE4 02 0CEE 03 0CE9 04 0CE9' +
    ' 80 001E 81 0019 82 0069 83 0532 84 83E8 85 4B 86 02 87 002A 89 00001000 8A 0004 8B 0081 8C 0003' +
    ` 9D 01 AA 00000064 B4 ${pad('68ABCDEF', 8)} B7 ${pad('11.26', 15)} B9 0000005F BA ${pad('JK_B2A24S15P', 24)} C0 01`,
);

test('jk: read-all reply decodes into pack metrics', () => {
  const frame = jkFrame(JK_DATA);
  assert.equal(jk.frameReader(frame), frame.length);
  const items = jk.parseItems(jk.frameData(frame));
  assert.deepEqual(items.cells, [3.3, 3.31, 3.305, 3.305]);
  const m = packMetrics(jk.jkReading(items));
  assert.equal(m.Voltage, 13.3);
  assert.equal(m.Current, 10);
  assert.equal(m.Power, 133);
  assert.equal(m['Device mode'], 'Charging');
  assert.equal(m['State of charge'], 75);
  assert.equal(m.Cycles, 42);
  assert.equal(m['Temperature MOS'], 30);
  assert.equal(m['Temperature 1'], 25);
  assert.equal(m['Temperature 2'], -5);
  assert.equal(m.Temperature, 10);
  assert.equal(m.Capacity, 95);
  assert.equal(m['Design capacity'], 100);
  assert.equal(m['State of health'], 95);
  assert.equal(m['Charge capacity'], 71.3);
  assert.equal(m.Alarms, 'Low capacity, Cell voltage difference');
  assert.equal(m['Model name'], 'JK_B2A24S15P');
  assert.equal(m['Serial number'], '68ABCDEF');
  assert.equal(m['Firmware version'], '11.26');
  const bad = Buffer.from(frame);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => jk.frameData(bad), /checksum/);
});

test('jk: driver reads over a link', async () => {
  const bms = jk.createJk(['/dev/x', '/dev/y'], 115200, (p) => new ScriptedLink(p, () => (p === '/dev/x' ? jkFrame(JK_DATA) : null)));
  await bms.connect();
  const packs = await bms.read(); // /dev/y times out (1.5 s) but /dev/x still reports
  assert.equal(packs.length, 1);
  assert.equal(packs[0]['State of charge'], 75);
});

// ---- Daly ----------------------------------------------------------------------------------

function dalyReply(cmd: number, data: string) {
  const b = Buffer.concat([bytes(`A5 01 ${cmd.toString(16)} 08`), bytes(data), Buffer.alloc(1)]);
  b[12] = sum8(b.subarray(0, 12)) & 0xff;
  return b;
}

test('daly: request and checksum', () => {
  assert.equal(daly.buildRequest(0x90).toString('hex').toUpperCase(), 'A54090080000000000000000' + '7D');
  const r = bytes('A5 01 90 08 0210 0000 758A 02EE 3F');
  assert.deepEqual(daly.parseBasic(daly.frameData(r, 0x90)), { voltage: 52.8, current: 9, soc: 75 });
  assert.equal(daly.parseBasic(daly.frameData(dalyReply(0x90, '0210 0000 74CC 02EE'), 0x90)).current, -10);
  assert.throws(() => daly.frameData(bytes('A5 01 90 08 0210 0000 758A 02EE 40')), /checksum/);
});

test('daly: multi-frame cell voltages, skipping a corrupt frame', () => {
  const frames = [1, 2, 3, 4, 5, 6].map((n) => dalyReply(0x95, `0${n} ${[0, 1, 2].map((k) => (3300 + (n - 1) * 3 + k).toString(16).padStart(4, '0')).join('')} 00`));
  const all = daly.parseCells(daly.splitFrames(Buffer.concat(frames), 0x95), 16);
  assert.equal(all.length, 16);
  assert.equal(all[0], 3.3);
  assert.equal(all[15], 3.315);
  frames[2][12] ^= 0xff; // corrupt frame 3 (cells 7-9)
  const some = daly.parseCells(daly.splitFrames(Buffer.concat(frames), 0x95), 16);
  assert.equal(some[6], undefined);
  assert.equal(some[9], 3.309);
});

test('daly: full poll over a link', async () => {
  const cells = [1, 2, 3, 4, 5, 6].map((n) => dalyReply(0x95, `0${n} 0CE4 0CE5 0CE6 00`));
  const replies: Record<number, Buffer> = {
    0x50: dalyReply(0x50, '000186A0 0CE4 0000'),
    0x90: dalyReply(0x90, '0210 0000 74CC 02EE'),
    0x92: dalyReply(0x92, '41 01 3F 02 0000 0000'),
    0x93: dalyReply(0x93, '02 01 01 21 00011170'),
    0x94: dalyReply(0x94, '10 02 00 01 00 0021 00'),
    0x95: Buffer.concat(cells),
    0x96: dalyReply(0x96, '01 41 3F 00 00 00 00 00'),
    0x98: dalyReply(0x98, '04 00 00 00 00 00 00 00'),
  };
  const bms = daly.createDaly(['/dev/d'], 9600, (p) => new ScriptedLink(p, (req) => replies[req[2]] ?? null));
  await bms.connect();
  const [m] = await bms.read();
  assert.equal(m.Voltage, 52.8);
  assert.equal(m.Current, -10);
  assert.equal(m['State of charge'], 75);
  assert.equal(m.Cycles, 0x21);
  assert.equal(m['Charge capacity'], 70);
  assert.equal(m.Capacity, 100);
  assert.equal(m['Cell voltage 16'], 3.3);
  assert.equal(m['Cell voltage - Highest'], 3.302);
  assert.equal(m['Temperature 1'], 25);
  assert.equal(m['Temperature 2'], 23);
  assert.equal(m.Temperature, 24);
  assert.equal(m.Alarms, 'Cell voltage low');
});

// ---- JBD -----------------------------------------------------------------------------------

function jbdReply(reg: number, data: Buffer) {
  const b = Buffer.concat([Buffer.from([0xdd, reg, 0x00, data.length]), data, Buffer.alloc(3)]);
  b.writeUInt16BE((0x10000 - sum8(b.subarray(2, 4 + data.length))) & 0xffff, 4 + data.length);
  b[b.length - 1] = 0x77;
  return b;
}

const JBD_BASIC = bytes('14D2 FC18 1F40 2710 0005 2A61 0000 0000 0002 10 50 03 04 02 0BA5 0BAF');

test('jbd: requests and basic info', () => {
  assert.equal(jbd.buildRead(0x03).toString('hex').toUpperCase(), 'DDA50300FFFD77');
  assert.equal(jbd.buildRead(0x04).toString('hex').toUpperCase(), 'DDA50400FFFC77');
  const frame = jbdReply(0x03, JBD_BASIC);
  const b = jbd.parseBasic(jbd.replyData(frame, 0x03));
  assert.equal(b.productionDate, '2021-03-01');
  const m = packMetrics(jbd.jbdReading(b, jbd.parseCells(bytes('0CE4 0CEE 0CE9 0CE9'))));
  assert.equal(m.Voltage, 53.3);
  assert.equal(m.Current, -10);
  assert.equal(m['State of charge'], 80);
  assert.equal(m['Charge capacity'], 80);
  assert.equal(m.Capacity, 100);
  assert.equal(m.Cycles, 5);
  assert.equal(m['Temperature 2'], 26);
  assert.equal(m.Alarms, 'Cell under voltage');
  assert.equal(m['Firmware version'], '1.0');
  assert.equal(m['Cell voltage - Average'], 3.305);
  const bad = Buffer.from(frame);
  bad[5] ^= 1;
  assert.throws(() => jbd.replyData(bad, 0x03), /checksum/);
});

test('jbd: driver reads over a link', async () => {
  const replies: Record<number, Buffer> = {
    3: jbdReply(3, JBD_BASIC),
    4: jbdReply(4, bytes('0CE4 0CEE 0CE9 0CE9')),
    5: jbdReply(5, Buffer.from('SP04S034')),
  };
  const bms = jbd.createJbd(['/dev/j'], 9600, (p) => new ScriptedLink(p, (r) => replies[r[2]]));
  await bms.connect();
  const [m] = await bms.read();
  assert.equal(m['Model name'], 'SP04S034');
  assert.equal(m['Cell voltage 4'], 3.305);
});

// ---- shared --------------------------------------------------------------------------------

test('multi-port: throws only when every port fails', async () => {
  const bms = new MultiPortBms(['a', 'b'], 9600, (p) => new ScriptedLink(p, () => null), (link: ByteLink) => ({
    init: async () => {},
    read: async () => {
      if (link.name === 'a') throw new Error('a down');
      return [{ Voltage: 50 }];
    },
  }));
  await bms.connect();
  const packs = await bms.read();
  assert.ok(!(0 in packs));
  assert.equal(packs[1].Voltage, 50);
});

test('index: descriptors and invert current', () => {
  // Dropdown order, plus the simulated bank.
  assert.deepEqual(serialBmsDrivers.map((d) => d.id), [
    'daly', 'jbd', 'jk', 'modbus', 'narada', 'pylontech', 'serial', 'voltronic_lib', 've_direct', 'can', 'simulated',
  ]);
  // One BMS per USB port, several ports allowed (single-link protocols excluded).
  for (const id of ['daly', 'jbd', 'jk']) assert.equal(serialBmsDrivers.find((d) => d.id === id)?.multiConnection, true);
  const out = invertPacks([{ Current: 5, Power: 260, 'Device mode': 'Charging' }]);
  assert.deepEqual(out[0], { Current: -5, Power: -260, 'Device mode': 'Discharging' });
});
