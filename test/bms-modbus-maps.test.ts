import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import modbusSerial from 'modbus-serial';
import {
  MODBUS_BMS_MODELS,
  Regs,
  applyProtocolSoc,
  createModbusBms,
  modbusBmsDriver,
  type RegisterBus,
} from '../src/devices/bms/modbus-bms.ts';

type Image = { 3: Map<number, number>; 4: Map<number, number> };

/** In-memory bus: one register image per slave address; absent slaves time out. */
class FakeBus implements RegisterBus {
  isOpen = false;
  packs = new Map<number, Image>();
  reads: string[] = [];
  async open() {
    this.isOpen = true;
  }
  async close() {
    this.isOpen = false;
  }
  async read(unit: number, fn: 3 | 4, start: number, count: number) {
    this.reads.push(`${unit}:${fn}:${start}`);
    const p = this.packs.get(unit);
    if (!p) throw new Error('Timed out');
    return Array.from({ length: count }, (_, i) => p[fn].get(start + i) ?? 0);
  }
}

const image = (): Image => ({ 3: new Map(), 4: new Map() });
const s16 = (v: number) => (v < 0 ? v + 0x10000 : v);
const ascii = (m: Map<number, number>, at: number, text: string, regs: number) => {
  const b = Buffer.alloc(regs * 2);
  b.write(text, 'latin1');
  for (let i = 0; i < regs; i++) m.set(at + i, b.readUInt16BE(i * 2));
};

function eg4Pack(soc: number): Image {
  const img = image();
  const h = img[3];
  h.set(0, 5320);
  h.set(1, s16(-1050));
  for (let i = 0; i < 16; i++) h.set(2 + i, 3320 + (i % 2) * 10);
  h.set(18, 30);
  h.set(20, 25);
  h.set(21, 80);
  h.set(22, 50);
  h.set(23, 99);
  h.set(24, soc);
  h.set(26, 0b1);
  h.set(27, 0b100000);
  h.set(29, 0);
  h.set(30, 123);
  h.set(31, 0);
  h.set(32, 100);
  [24, 25, 26, 27].forEach((t, i) => h.set(33 + i, t));
  h.set(37, 16);
  ascii(h, 105, 'EG4-LL-48V100', 12);
  ascii(h, 117, 'V1.2', 3);
  ascii(h, 120, 'SN123456', 8);
  return img;
}

test('modbus: model list and descriptor label', () => {
  assert.equal(modbusBmsDriver.id, 'modbus');
  assert.equal(modbusBmsDriver.name, 'USB Modbus RS232/485');
  assert.equal(modbusBmsDriver.transport, 'serial');
  assert.deepEqual(
    MODBUS_BMS_MODELS.map((m) => m.id),
    ['common', 'eg4', 'ecomlight', 'leoch', 'polarium', 'revov', 'seplos', 'sunstone'],
  );
  assert.equal(MODBUS_BMS_MODELS.find((m) => m.id === 'leoch')!.name, 'Leoch (experimental)');
  assert.equal(MODBUS_BMS_MODELS.find((m) => m.id === 'seplos')!.baudRate, 19200);
});

test('modbus: Regs accessors', () => {
  const r = new Regs().put(10, [0xfffe, 0x0001, 0x0002, 0x4142, 0x4300]);
  assert.equal(r.s16(10), -2);
  assert.equal(r.u32(11), 0x10002);
  assert.equal(r.str(13, 2), 'ABC');
  assert.equal(r.u16(99), undefined);
  assert.equal(r.str(14, 3), undefined);
});

test('modbus: EG4 packs start at address 2 and stop at the first gap', async () => {
  const bus = new FakeBus();
  bus.packs.set(2, eg4Pack(78));
  bus.packs.set(3, eg4Pack(80));
  bus.packs.set(5, eg4Pack(90)); // beyond the gap at 4: not scanned
  const bms = createModbusBms({ connection: 'x', baudRate: 9600, modelId: 'eg4', maxPacks: 8, bus });
  await bms.connect();
  assert.deepEqual(bms.addresses, [2, 3]);
  const packs = await bms.read();
  assert.equal(packs.length, 2);
  const m = packs[0];
  assert.equal(m.Voltage, 53.2);
  assert.equal(m.Current, -10.5);
  assert.equal(m.Power, -559);
  assert.equal(m['Device mode'], 'Discharging');
  assert.equal(m['State of charge'], 78);
  assert.equal(m['State of health'], 99);
  assert.equal(m['Cell voltage 16'], 3.33);
  assert.equal(m['Cell voltage - Average'], 3.325);
  assert.equal(m['Cell voltage - Difference'], 0.01);
  assert.equal(m['Temperature MOS'], 30);
  assert.equal(m['Temperature ENV'], 25);
  assert.equal(m.Temperature, 25.5);
  assert.equal(m['Temperature 4'], 27);
  assert.equal(m.Cycles, 123);
  assert.equal(m.Capacity, 100);
  assert.equal(m['Charge capacity'], 80);
  assert.equal(m['Max charge current'], 50);
  assert.equal(m.Alarms, 'Cell over voltage, Discharge over current');
  assert.equal(m['Model name'], 'EG4-LL-48V100');
  assert.equal(m['Firmware version'], 'V1.2');
  assert.equal(m['Serial number'], 'SN123456');
  assert.equal(packs[1]['State of charge'], 80);

  // A pack that drops out leaves a hole; the other keeps its position.
  bus.packs.delete(2);
  const again = await bms.read();
  assert.equal(again[0], undefined);
  assert.equal(again[1]['State of charge'], 80);
  bus.packs.delete(3);
  await assert.rejects(bms.read(), /Timed out/);
});

test('modbus: maximum pack count caps the scan; no packs gives a clear error', async () => {
  const bus = new FakeBus();
  for (let a = 2; a < 10; a++) bus.packs.set(a, eg4Pack(50));
  const bms = createModbusBms({ connection: 'x', baudRate: 9600, modelId: 'eg4', maxPacks: 3, bus });
  await bms.connect();
  assert.deepEqual(bms.addresses, [2, 3, 4]);

  const empty = createModbusBms({ connection: 'x', baudRate: 9600, modelId: 'eg4', bus: new FakeBus() });
  await assert.rejects(empty.connect(), /no battery pack answered at address 2/);
});

test('modbus: wrong model is reported as implausible data', async () => {
  const bus = new FakeBus();
  bus.packs.set(1, eg4Pack(50)); // EG4 data read as Seplos V3 (input registers all zero)
  const bms = createModbusBms({ connection: 'x', baudRate: 19200, modelId: 'seplos', bus });
  await assert.rejects(bms.connect(), /implausible voltage.*check the selected battery model/);
});

test('modbus: Seplos V3 input-register map', async () => {
  const bus = new FakeBus();
  const img = image();
  const i = img[4];
  i.set(0x1000, 5300);
  i.set(0x1001, 2000);
  i.set(0x1002, 15000);
  i.set(0x1003, 28000);
  i.set(0x1005, 536);
  i.set(0x1006, 1000);
  i.set(0x1007, 12);
  i.set(0x100f, 150);
  i.set(0x1010, 100);
  for (let c = 0; c < 16; c++) i.set(0x1100 + c, 3300 + c);
  [2981, 2991, 3001, 3011].forEach((t, k) => i.set(0x1110 + k, t));
  i.set(0x1118, 2931);
  i.set(0x1119, 3031);
  bus.packs.set(1, img);
  bus.packs.set(2, img);
  const bms = createModbusBms({ connection: 'x', baudRate: 19200, modelId: 'seplos', bus });
  await bms.connect();
  const [m] = await bms.read();
  assert.equal(bms.addresses.length, 2);
  assert.equal(m.Voltage, 53);
  assert.equal(m.Current, 20);
  assert.equal(m['Device mode'], 'Charging');
  assert.equal(m['State of charge'], 53.6);
  assert.equal(m['State of health'], 100);
  assert.equal(m['Charge capacity'], 150);
  assert.equal(m.Capacity, 280);
  assert.equal(m.Cycles, 12);
  assert.equal(m['Cell voltage - Highest'], 3.315);
  assert.equal(m['Temperature 1'], 25);
  assert.equal(m.Temperature, 26.5);
  assert.equal(m['Temperature ENV'], 20);
  assert.equal(m['Temperature MOS'], 30);
  assert.equal(m['Max discharge current'], 150);
  assert.ok(bus.reads.every((r) => r.split(':')[1] === '4'));
});

test('modbus: protocol state of charge option', () => {
  const r = { soc: 50, remainingAh: 40, fullAh: 80, designAh: 100 };
  assert.equal(applyProtocolSoc(r, '').soc, 50);
  assert.equal(applyProtocolSoc(r, 'charge/full').soc, 50);
  assert.equal(applyProtocolSoc(r, 'charge/design').soc, 40);
});

// ---- End to end over Modbus TCP (modbus-serial ServerTCP answering several unit ids) --------------

const PORT = 16000 + Math.floor(Math.random() * 1000);
let server: InstanceType<typeof modbusSerial.ServerTCP>;

/** Pace-style ("Common") holding registers per unit. */
function paceRegs(unit: number) {
  const m = new Map<number, number>();
  m.set(0, s16(unit === 1 ? 1234 : -500)); // 12.34 A / −5 A
  m.set(1, 5250);
  m.set(2, 64);
  m.set(3, 98);
  m.set(4, 6400);
  m.set(5, 10000);
  m.set(6, 10000);
  m.set(7, 321);
  m.set(10, 1 << 6);
  for (let c = 0; c < 16; c++) m.set(15 + c, 3280 + c * 2);
  [215, 225, 235, 245].forEach((t, k) => m.set(31 + k, t));
  m.set(35, 300);
  m.set(36, 210);
  ascii(m, 150, 'P16S100A-V2.1', 10);
  ascii(m, 160, 'PACE-16S', 10);
  ascii(m, 170, `PACK000${unit}`, 10);
  return m;
}

before(async () => {
  const units = new Map([
    [1, paceRegs(1)],
    [2, paceRegs(2)],
  ]);
  server = new modbusSerial.ServerTCP(
    {
      getMultipleHoldingRegisters: (addr: number, length: number, unitID: number) => {
        const regs = units.get(unitID);
        if (!regs) throw Object.assign(new Error('no such unit'), { modbusErrorCode: 0x0b });
        return Array.from({ length }, (_, i) => regs.get(addr + i) ?? 0);
      },
      getHoldingRegister: (addr: number, unitID: number) => units.get(unitID)?.get(addr) ?? 0,
      getInputRegister: () => 0,
      setRegister: () => {},
    },
    { host: '127.0.0.1', port: PORT, unitID: 255 },
  );
  await once(server, 'initialized');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('modbus: Common model end to end over Modbus TCP, two packs', async () => {
  const bms = createModbusBms({ connection: `127.0.0.1:${PORT}`, baudRate: 9600, modelId: 'common', maxPacks: 4 });
  try {
    await bms.connect();
    assert.deepEqual(bms.addresses, [1, 2]);
    const packs = await bms.read();
    assert.equal(packs.length, 2);
    const [a, b] = packs;
    assert.equal(a.Voltage, 52.5);
    assert.equal(a.Current, 12.34);
    assert.equal(a['Device mode'], 'Charging');
    assert.equal(a['State of charge'], 64);
    assert.equal(a['State of health'], 98);
    assert.equal(a['Charge capacity'], 64);
    assert.equal(a.Capacity, 100);
    assert.equal(a['Design capacity'], 100);
    assert.equal(a.Cycles, 321);
    assert.equal(a['Cell voltage - Lowest'], 3.28);
    assert.equal(a['Cell voltage - Highest'], 3.31);
    assert.equal(a['Temperature 1'], 21.5);
    assert.equal(a['Temperature MOS'], 30);
    assert.equal(a['Temperature ENV'], 21);
    assert.equal(a.Alarms, 'Short circuit');
    assert.equal(a['Model name'], 'PACE-16S');
    assert.equal(a['Firmware version'], 'P16S100A-V2.1');
    assert.equal(a['Serial number'], 'PACK0001');
    assert.equal(b.Current, -5);
    assert.equal(b['Serial number'], 'PACK0002');
  } finally {
    await bms.close();
  }
});
