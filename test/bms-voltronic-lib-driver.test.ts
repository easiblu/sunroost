import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RegisterBus } from '../src/devices/bms/modbus-bms.ts';
import { LIB_BLOCKS, LIB_MODELS, createVoltronicLib, voltronicLibDriver } from '../src/devices/bms/voltronic-lib.ts';

class FakeBus implements RegisterBus {
  isOpen = false;
  packs = new Map<number, Map<number, number>>();
  reads: string[] = [];
  async open() {
    this.isOpen = true;
  }
  async close() {
    this.isOpen = false;
  }
  async read(unit: number, fn: 3 | 4, start: number, count: number) {
    this.reads.push(`${unit}:${start.toString(16)}`);
    const p = this.packs.get(unit);
    if (!p || fn !== 3) throw new Error('Timed out');
    return Array.from({ length: count }, (_, i) => p.get(start + i) ?? 0);
  }
}

function felicity(soc: number) {
  const m = new Map<number, number>();
  m.set(0x1303, 0);
  m.set(0x1304, 0b10); // cell under voltage warning
  m.set(0x1306, 5310);
  m.set(0x1307, 0x10000 - 125); // −12.5 A
  m.set(0x1308, 27);
  m.set(0x130a, soc);
  m.set(0x130b, 97);
  m.set(0x131e, 1000);
  m.set(0x131f, 1500);
  for (let c = 0; c < 16; c++) m.set(0x132a + c, 3310 + c);
  [22, 23, 24, 25].forEach((t, k) => m.set(0x133a + k, t));
  m.set(0x1340, 77);
  m.set(0x1341, 15000);
  m.set(0x1342, 20000);
  m.set(0x1343, 20000);
  return m;
}

test('voltronic lib: descriptor, models and detail levels', () => {
  assert.equal(voltronicLibDriver.id, 'voltronic_lib');
  assert.equal(voltronicLibDriver.name, 'USB Voltronic LIB RS485');
  assert.equal(voltronicLibDriver.transport, 'serial');
  assert.deepEqual(
    LIB_MODELS.map((m) => m.name).slice(0, 4),
    ['Default', 'Full', 'FullHD', 'Minimal'],
  );
  assert.ok(LIB_MODELS.some((m) => m.id === 'felicity') && LIB_MODELS.some((m) => m.id === 'giter'));
  assert.equal(LIB_BLOCKS.minimal.length, 1);
  assert.equal(LIB_BLOCKS.fullhd.length, 4);
});

test('voltronic lib: FullHD reads every block, packs at 1..n', async () => {
  const bus = new FakeBus();
  bus.packs.set(1, felicity(66));
  bus.packs.set(2, felicity(70));
  const bms = createVoltronicLib({ connection: 'x', baudRate: 9600, modelId: 'fullhd', bus });
  await bms.connect();
  assert.deepEqual(bms.addresses, [1, 2]);
  const [m, n] = await bms.read();
  assert.equal(m.Voltage, 53.1);
  assert.equal(m.Current, -12.5);
  assert.equal(m['Device mode'], 'Discharging');
  assert.equal(m['State of charge'], 66);
  assert.equal(m['State of health'], 97);
  assert.equal(m['Cell voltage - Highest'], 3.325);
  assert.equal(m.Temperature, 23.5);
  assert.equal(m['Max charge current'], 100);
  assert.equal(m['Max discharge current'], 150);
  assert.equal(m.Cycles, 77);
  assert.equal(m['Charge capacity'], 150);
  assert.equal(m.Capacity, 200);
  assert.equal(m.Alarms, 'Cell under voltage');
  assert.equal(n['State of charge'], 70);
});

test('voltronic lib: Minimal reads only the basic block', async () => {
  const bus = new FakeBus();
  bus.packs.set(1, felicity(50));
  const bms = createVoltronicLib({ connection: 'x', baudRate: 9600, modelId: 'minimal', bus });
  await bms.connect();
  bus.reads = [];
  const [m] = await bms.read();
  assert.deepEqual(bus.reads, ['1:1302']);
  assert.equal(m.Temperature, 27);
  assert.equal(m['Cell voltage 1'], undefined);
});

test('voltronic lib: Giter keeps scanning past gaps', async () => {
  const bus = new FakeBus();
  bus.packs.set(2, felicity(40));
  bus.packs.set(10, felicity(41));
  const bms = createVoltronicLib({ connection: 'x', baudRate: 9600, modelId: 'giter', maxPacks: 12, bus });
  await bms.connect();
  assert.deepEqual(bms.addresses, [2, 10]);
});

test('voltronic lib: invalid replies point at the serial inspect tool', async () => {
  const bus = new FakeBus();
  const junk = new Map<number, number>([[0x1306, 60000]]);
  bus.packs.set(1, junk);
  const bms = createVoltronicLib({ connection: 'x', baudRate: 9600, modelId: 'felicity', maxPacks: 4, bus });
  await assert.rejects(bms.connect(), (err: Error) => {
    assert.match(err.message, /no valid battery reply at addresses 1–4/);
    assert.match(err.message, /voltage 600/);
    assert.match(err.message, /Serial inspect/);
    return true;
  });
  const silent = createVoltronicLib({ connection: 'x', baudRate: 9600, modelId: 'default', bus: new FakeBus() });
  await assert.rejects(silent.connect(), /Timed out.*Serial inspect/);
});
