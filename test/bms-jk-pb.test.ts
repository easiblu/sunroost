import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JK_MODELS,
  JkPbListenBms,
  JkPbListener,
  JkPbSplitter,
  PB_FRAME,
  crc16,
  jk,
  pbCellReading,
  type ByteStream,
} from '../src/devices/bms/jk.ts';
import { packMetrics } from '../src/devices/bms/pack.ts';

const sum8 = (b: Buffer, n: number) => b.subarray(0, n).reduce((a, x) => a + x, 0) & 0xff;

function withCrc(bytes: number[]) {
  const b = Buffer.from([...bytes, 0, 0]);
  b.writeUInt16LE(crc16(b, 0, b.length - 2), b.length - 2);
  return b;
}
const request = (adr: number, reg = 0x20) => withCrc([adr, 0x10, 0x16, reg, 0x00, 0x01, 0x02, 0x00, 0x00]);
const ack = (adr: number, reg = 0x20) => withCrc([adr, 0x10, 0x16, reg, 0x00, 0x01]);

function pbFrame(type: number, fill: (f: Buffer) => void) {
  const f = Buffer.alloc(PB_FRAME);
  Buffer.from([0x55, 0xaa, 0xeb, 0x90, type, 0x01]).copy(f);
  fill(f);
  f[PB_FRAME - 1] = sum8(f, PB_FRAME - 1);
  return f;
}

function cellFrame(soc: number, currentMa: number) {
  return pbFrame(0x02, (f) => {
    for (let i = 0; i < 16; i++) f.writeUInt16LE(3300 + i, 6 + i * 2);
    f.writeUInt32LE(0xffff, 70);
    f.writeInt16LE(312, 144);
    f.writeUInt32LE(52920, 150);
    f.writeInt32LE(currentMa, 158);
    f.writeInt16LE(251, 162);
    f.writeInt16LE(-15, 164);
    f.writeUInt16BE(0b10000, 166); // cell over voltage
    f[171] = soc;
    f.writeUInt32LE(200000, 172);
    f.writeUInt32LE(280000, 176);
    f.writeUInt32LE(17, 180);
    f[188] = 96;
  });
}

const infoFrame = () =>
  pbFrame(0x03, (f) => {
    f.write('BK_BLE_PB_2A16S', 6, 'latin1');
    f.write('V15.38', 30, 'latin1');
    f.write('4062541234', 86, 'latin1');
  });

test('jk-pb: crc16 matches the Modbus reference', () => {
  // 01 03 00 00 00 01 → CRC 0x0A84 (wire order 84 0A)
  assert.equal(crc16(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x01])), 0x0a84);
});

test('jk-pb: cell frame decodes to pack metrics', () => {
  const m = packMetrics(pbCellReading(cellFrame(71, -8500)));
  assert.equal(m.Voltage, 52.92);
  assert.equal(m.Current, -8.5);
  assert.equal(m['Device mode'], 'Discharging');
  assert.equal(m['State of charge'], 71);
  assert.equal(m['State of health'], 96);
  assert.equal(m['Cell voltage 16'], 3.315);
  assert.equal(m['Cell voltage 17'], undefined);
  assert.equal(m['Temperature MOS'], 31.2);
  assert.equal(m['Temperature 1'], 25.1);
  assert.equal(m['Temperature 2'], -1.5);
  assert.equal(m['Charge capacity'], 200);
  assert.equal(m.Capacity, 280);
  assert.equal(m.Cycles, 17);
  assert.equal(m.Alarms, 'Cell over voltage');
});

test('jk-pb: splitter tags frames by ack or preceding request, resyncs past noise', () => {
  const traffic = Buffer.concat([
    Buffer.from([0x00, 0x55, 0xaa, 0x13]), // noise incl. a partial header
    request(1),
    cellFrame(50, 1000),
    ack(1),
    request(2),
    cellFrame(60, 2000), // no ack: address from the request
    request(3, 0x1c),
    infoFrame(),
    ack(3, 0x1c),
  ]);
  const s = new JkPbSplitter();
  const frames = [];
  for (let i = 0; i < traffic.length; i += 37) frames.push(...s.push(traffic.subarray(i, i + 37)));
  frames.push(...s.flush());
  assert.deepEqual(
    frames.map((f) => [f.address, f.type]),
    [
      [1, 2],
      [2, 2],
      [3, 3],
    ],
  );
  // Corrupt checksum: dropped.
  const bad = cellFrame(50, 0);
  bad[100] ^= 0xff;
  const s2 = new JkPbSplitter();
  assert.deepEqual(s2.push(Buffer.concat([request(4), bad, ack(4)])), []);
});

/** A stream fed by the test. */
class FakeStream implements ByteStream {
  isOpen = false;
  private onData: ((b: Buffer) => void) | null = null;
  async open(onData: (b: Buffer) => void) {
    this.isOpen = true;
    this.onData = onData;
  }
  async close() {
    this.isOpen = false;
  }
  emit(b: Buffer) {
    this.onData?.(b);
  }
}

test('jk-pb: listener keeps stable pack positions and merges device info', async () => {
  let now = 1000;
  const stream = new FakeStream();
  const l = new JkPbListener(stream, 16, () => now);
  await l.open();
  await assert.rejects(l.read(10), /no pack data heard/);
  stream.emit(Buffer.concat([request(2), cellFrame(80, 0), ack(2), request(1, 0x1c), infoFrame(), ack(1, 0x1c), request(1), cellFrame(55, 3000), ack(1)]));
  const packs = await l.read(0);
  assert.equal(packs.length, 2);
  assert.equal(packs[0]!['State of charge'], 55);
  assert.equal(packs[0]!['Model name'], 'BK_BLE_PB_2A16S');
  assert.equal(packs[0]!['Firmware version'], 'V15.38');
  assert.equal(packs[0]!['Serial number'], '4062541234');
  assert.equal(packs[1]!['State of charge'], 80);
  // Pack 1 goes quiet for over a minute: its slot empties, pack 2 stays second.
  now += 61_000;
  stream.emit(Buffer.concat([request(2), cellFrame(81, 0), ack(2)]));
  const later = await l.read(0);
  assert.equal(later[0], undefined);
  assert.equal(later[1]!['State of charge'], 81);
});

test('jk-pb: first read waits for traffic', async () => {
  const stream = new FakeStream();
  const bms = new JkPbListenBms(['/dev/x'], 115200, 16, () => stream);
  await bms.connect();
  setTimeout(() => stream.emit(Buffer.concat([request(1), cellFrame(42, 0), ack(1)])), 20);
  const packs = await bms.read();
  assert.equal(packs[0]['State of charge'], 42);
});

test('jk: descriptor label and models', () => {
  assert.equal(jk.name, 'USB JK RS485');
  assert.deepEqual(
    JK_MODELS.map((m) => m.id),
    ['rs485', 'pb_master', 'listen'],
  );
  assert.equal(jk.multiConnection, true);
});
