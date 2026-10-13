import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import modbusSerial from 'modbus-serial';
import { sunsynk } from '../src/devices/inverters/deye/index.ts';

const PORT = 16100 + Math.floor(Math.random() * 800);
const holding = new Map<number, number>();
let server: InstanceType<typeof modbusSerial.ServerTCP>;

before(async () => {
  holding.set(0, 3);
  const sn = 'AB12345678';
  for (let i = 0; i < 5; i++) holding.set(3 + i, (sn.charCodeAt(i * 2) << 8) | sn.charCodeAt(i * 2 + 1));
  holding.set(16, 80000 & 0xffff);
  holding.set(17, 80000 >>> 16); // 8000.0 W, low word first
  holding.set(59, 2);
  holding.set(184, 64);
  holding.set(183, 5120);
  holding.set(182, 1250);
  holding.set(190, 0x10000 - 800); // charging 800 W
  holding.set(186, 1200);
  holding.set(169, 0x10000 - 300); // exporting 300 W
  holding.set(178, 700);
  holding.set(244, 1);
  holding.set(248, 0b10000011); // enabled, Monday, Sunday
  holding.set(250, 2230);
  holding.set(274, 2); // gen charge only
  holding.set(210, 100);
  server = new modbusSerial.ServerTCP(
    {
      getHoldingRegister: (addr: number) => holding.get(addr) ?? 0,
      getInputRegister: () => 0,
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

test('Deye single-phase hybrid end to end over Modbus TCP', async () => {
  const driver = sunsynk.create({ modelId: 'hybrid', connection: `127.0.0.1:${PORT}`, baudRate: 9600, address: 1, index: 0 });
  await driver.connect();
  try {
    const info = driver.info();
    assert.equal(info['Serial number'], 'AB12345678');
    assert.equal(info['Max AC output power'], 8000);
    assert.equal(info['Model name'], 'Deye 8 kW single-phase hybrid');

    const m = await driver.read();
    assert.equal(m['Battery state of charge'], 64);
    assert.equal(m['Battery voltage'], 51.2);
    assert.equal(m['Battery temperature'], 25);
    assert.equal(m['Battery power'], 800);
    assert.equal(m['Grid power'], -300);
    assert.equal(m['PV power'], 1200);
    assert.equal(m['Load power'], 700);
    assert.equal(m['Device mode'], 'Normal');

    const v = await driver.readSettings();
    assert.equal(v.system_work_mode, 'Zero export to load');
    assert.equal(v.use_timer, true);
    assert.equal(v.time_of_use_monday, true);
    assert.equal(v.time_of_use_tuesday, false);
    assert.equal(v.time_point_1, '22:30');
    assert.equal(v.grid_charge_point_1, false);
    assert.equal(v.gen_charge_point_1, true);
    assert.equal(v.max_charge_current, 100);

    await driver.writeSetting('time_point_2', '06:15');
    assert.equal(holding.get(251), 615);
    await driver.writeSetting('grid_charge_point_1', true);
    assert.equal(holding.get(274), 3, 'gen bit kept');
    await driver.writeSetting('use_timer', false);
    assert.equal(holding.get(248), 0b10000010, 'weekday bits kept');
    await driver.writeSetting('system_work_mode', 'Selling first');
    assert.equal(holding.get(244), 0);
    await assert.rejects(driver.writeSetting('solar_export', true), /read-only/);

    await driver.rawWrite!(300, [7, 8]);
    assert.deepEqual(await driver.rawRead!(3, 300, 2), [7, 8]);
  } finally {
    await driver.close();
  }
});
