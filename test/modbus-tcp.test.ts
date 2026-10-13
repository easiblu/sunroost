import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import modbusSerial from 'modbus-serial';
import { growatt } from '../src/devices/inverters/growatt/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';

const PORT = 15000 + Math.floor(Math.random() * 1000);

/** A fake SPH: input and holding registers held in maps, default 0. */
const input = new Map<number, number>();
const holding = new Map<number, number>();
let server: InstanceType<typeof modbusSerial.ServerTCP>;

function setU32(m: Map<number, number>, addr: number, v: number) {
  m.set(addr, v >>> 16);
  m.set(addr + 1, v & 0xffff);
}

before(async () => {
  input.set(1014, 77);
  input.set(1013, 530);
  setU32(input, 1, 25000);
  setU32(input, 1011, 10000);
  holding.set(1044, 1);
  holding.set(1100, 0x0100);
  holding.set(1101, 0x0500);
  holding.set(1102, 1);
  const serial = 'XYZ0123456';
  for (let i = 0; i < 5; i++) holding.set(23 + i, (serial.charCodeAt(i * 2) << 8) | serial.charCodeAt(i * 2 + 1));
  server = new modbusSerial.ServerTCP(
    {
      getInputRegister: (addr: number) => input.get(addr) ?? 0,
      getHoldingRegister: (addr: number) => holding.get(addr) ?? 0,
      setRegister: (addr: number, value: number) => {
        holding.set(addr, value);
      },
    },
    { host: '127.0.0.1', port: PORT, unitID: 1 },
  );
  await once(server, 'initialized');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('parseConnection picks TCP for host:port and RTU for device paths', () => {
  assert.deepEqual(parseConnection('192.168.1.9:502', 9600, 1), { type: 'tcp', host: '192.168.1.9', port: 502, address: 1 });
  assert.deepEqual(parseConnection('tcp://inverter.lan:8899', 9600, 2), { type: 'tcp', host: 'inverter.lan', port: 8899, address: 2 });
  assert.deepEqual(parseConnection('/dev/ttyUSB0', 9600, 1), { type: 'rtu', path: '/dev/ttyUSB0', baudRate: 9600, address: 1 });
});

test('connection serialises concurrent reads and validates ranges', async () => {
  const conn = new ModbusConnection({ type: 'tcp', host: '127.0.0.1', port: PORT, address: 1 });
  await conn.connect();
  try {
    const [a, b, c] = await Promise.all([conn.read(4, 1013, 2), conn.read(3, 1044, 1), conn.read(4, 1, 2)]);
    assert.deepEqual(a, [530, 77]);
    assert.deepEqual(b, [1]);
    assert.deepEqual(c, [0, 25000]);
    assert.throws(() => conn.read(4, 0, 126));
    assert.throws(() => conn.write(10, [70000]));
  } finally {
    await conn.close();
  }
});

test('Growatt SPH driver end to end over Modbus TCP', async () => {
  const driver = growatt.create({ modelId: 'sph', connection: `127.0.0.1:${PORT}`, baudRate: 9600, address: 1, index: 0 });
  await driver.connect();
  try {
    assert.equal(driver.info()['Serial number'], 'XYZ0123456');
    const m = await driver.read();
    assert.equal(m['Battery state of charge'], 77);
    assert.equal(m['Battery voltage'], 53);
    assert.equal(m['Battery power'], 1000);
    assert.equal(m['PV power'], 2500);

    const values = await driver.readSettings();
    assert.equal(values.work_mode_priority, 'Battery first');
    assert.equal(values.battery_first_slot_1, '01:00,05:00,true');
    assert.equal(values.grid_first_slot_1, '00:00,00:00,false');

    await driver.writeSetting('work_mode_priority', 'Grid first');
    assert.equal(holding.get(1044), 2);
    await driver.writeSetting('grid_first_slot_2', '16:30,19:00,true');
    assert.deepEqual([holding.get(1083), holding.get(1084), holding.get(1085)], [(16 << 8) | 30, 19 << 8, 1]);
    await assert.rejects(driver.writeSetting('battery_type', 'Lithium'), /read-only/);

    assert.deepEqual(await driver.rawRead!(3, 1083, 3), [(16 << 8) | 30, 19 << 8, 1]);
    await driver.rawWrite!(1090, [80]);
    assert.equal(holding.get(1090), 80);
  } finally {
    await driver.close();
  }
});
