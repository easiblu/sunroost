import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { derive, midnite } from '../src/devices/inverters/midnite/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345679;

function ascii(start: number, s: string, into: Map<number, number>, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
const u32 = (at: number, v: number, into: Map<number, number>) => {
  const raw = v < 0 ? v + 0x100000000 : v;
  into.set(at, Math.floor(raw / 0x10000));
  into.set(at + 1, raw & 0xffff);
};

/** An AIO at midday: 4.89 kW PV, charging 1.25 kW, exporting 1.24 kW, 2.4 kW of load. */
function aioMap() {
  const h = new Map<number, number>();
  ascii(0x1a00, 'MN15-12KW-AIO', h, 8);
  ascii(0x1a10, 'MN2406A01234', h, 8);
  h.set(0x1a18, 0x0115);
  ascii(0x1a1c, 'V10025', h, 3);
  ascii(0x1a26, 'V20003', h, 3);
  h.set(0x1a46, 11400);
  Object.entries({
    0x1001: 1203, 0x1005: 6000, 0x1006: 1201,
    0x1010: 3800, 0x1011: 850, 0x1014: 3650, 0x1015: 400, 0x1018: 2000, 0x1019: 100,
    0x101c: 41, 0x101d: 3, 0x131a: 1205, 0x131b: 1198, 0x1338: 6001,
    0x1350: 1201, 0x1356: 1199, 0x2000: 76, 0x2006: 532,
    // settings
    0x2100: 3, 0x2102: 0x0100, 0x2103: 0x0530, 0x2104: 0, 0x2105: 0, 0x2112: 400, 0x2115: 1, 0x2116: 3000,
    0x2117: 90, 0x2118: 6000, 0x2119: 100, 0x211a: 8000, 0x211b: 20, 0x211c: 1, 0x214c: 1, 0x30ba: 5000,
  }).forEach(([a, v]) => h.set(Number(a), v));
  u32(0x1012, 32300, h); // 3230.0 W
  u32(0x1016, 14600, h); // 1460.0 W
  u32(0x101a, 2000, h); // 200.0 W
  u32(0x101e, 0, h);
  u32(0x1048, 48900, h); // 4890.0 W total
  u32(0x1300, -7000, h); // L1 exporting 700.0 W
  u32(0x1302, -5400, h); // L2 exporting 540.0 W
  u32(0x130a, 3000, h); // 300.0 W grid-side load
  u32(0x131d, -581, h); // −5.81 A
  u32(0x1353, 12000, h); // EPS L1 1200.0 W
  u32(0x1359, 9000, h); // EPS L2 900.0 W
  u32(0x2007, -2350, h); // −23.50 A raw (charging)
  u32(0x2009, -12500, h); // −1250.0 W raw (charging)
  return h;
}

async function withLogger<T>(holding: Map<number, number>, fn: (connection: string) => Promise<T>): Promise<T> {
  const server = fakeLogger({ serial: LOGGER, holding });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/${LOGGER}`);
  } finally {
    server.close();
  }
}

async function probe(holding: Map<number, number>) {
  return withLogger(holding, async (c) => {
    const conn = new ModbusConnection(parseConnection(c, 9600, 1));
    await conn.connect();
    try {
      return await midnite.detect!(conn);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: read-only, id midnite, 9600 baud, address 1', () => {
  assert.equal(midnite.id, 'midnite');
  assert.equal(midnite.readOnly, true);
  assert.equal(midnite.transport, 'serial');
  assert.equal(midnite.defaultBaudRate, 9600);
  assert.equal(midnite.defaultAddress, 1);
  assert.deepEqual(midnite.models?.map((m) => m.id), ['aio']);
  assert.equal(midnite.socControl?.('aio'), null);
  assert.equal(midnite.protectionSetting?.('aio'), null);
  const d = midnite.create({ modelId: 'aio', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length >= 10);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('AIO over a logger: info, live decode and settings', async () => {
  await withLogger(aioMap(), async (connection) => {
    const d = midnite.create({ modelId: 'aio', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Model name'], 'MN15-12KW-AIO');
      assert.equal(info['Serial number'], 'MN2406A01234');
      assert.equal(info['Firmware version'], 'V10025');
      assert.equal(info['Secondary firmware version'], 'V20003');

      const m = await d.read();
      assert.equal(m['PV voltage 1'], 380);
      assert.equal(m['PV current 1'], 8.5);
      assert.equal(m['PV power 1'], 3230);
      assert.equal(m['PV power 2'], 1460);
      assert.equal(m['PV power 3'], 200);
      assert.equal(m['PV power'], 4890);
      assert.equal(m['Battery state of charge'], 76);
      assert.equal(m['Battery voltage'], 53.2);
      assert.equal(m['Battery current'], 23.5);
      assert.equal(m['Battery power'], 1250);
      assert.equal(m['Grid power 1'], -700);
      assert.equal(m['Grid power 2'], -540);
      assert.equal(m['Grid power'], -1240);
      assert.equal(m['Grid voltage'], 120.5);
      assert.equal(m['Grid voltage 2'], 119.8);
      assert.equal(m['Grid current 1'], -5.81);
      assert.equal(m['Grid frequency'], 60.01);
      assert.equal(m['AC output voltage'], 120.1);
      assert.equal(m['AC output voltage 2'], 119.9);
      assert.equal(m['AC output frequency'], 60);
      assert.equal(m['Load power 1'], 1200);
      assert.equal(m['Load power 2'], 900);
      assert.equal(m['Load power essential'], 2100);
      assert.equal(m['Load power non-essential'], 300);
      assert.equal(m['Load power'], 2400);
      assert.equal(m['Load percentage'], 18);
      assert.equal(m.Temperature, 41);
      assert.equal(m['Device mode'], 'On-grid');
      assert.equal(m['Fault code'], 'None');
      // Energy balance: PV = load + charging + export.
      assert.equal(m['PV power'], (m['Load power'] as number) + (m['Battery power'] as number) - (m['Grid power'] as number));

      const s = await d.readSettings();
      assert.equal(s.work_mode, 'Backup');
      assert.equal(s.time_based_control, true);
      assert.equal(s.charge_slot_1, '01:00,05:48,true');
      assert.equal(s.discharge_slot_1, '00:00,00:00,false');
      assert.equal(s.battery_capacity, 400);
      assert.equal(s.grid_charge, true);
      assert.equal(s.grid_charge_power, 3000);
      assert.equal(s.grid_charge_stop_capacity, 90);
      assert.equal(s.max_charge_power, 6000);
      assert.equal(s.charge_stop_capacity, 100);
      assert.equal(s.max_discharge_power, 8000);
      assert.equal(s.discharge_stop_capacity, 20);
      assert.equal(s.max_feed_in_power, 5000);
      assert.equal(s.eps_output, true);

      // Raw console read.
      assert.deepEqual(await d.rawRead!(3, 0x2000, 1), [76]);
    } finally {
      await d.close();
    }
  });
});

test('derive: discharging at night, PV total missing falls back to the MPPT sum, faults shown in hex', () => {
  const m = derive({
    'PV power 1': 0, 'PV power 2': 12.5, 'Battery power raw': 1830.4, 'Battery current raw': 34.2,
    'Grid power 1': 150.2, 'Grid power 2': 99.9, 'Load power 1': 1100, 'Load power 2': 950, 'Fault word': 0x10004,
    'Device mode': 'Off-grid',
  });
  assert.equal(m['PV power'], 13);
  assert.equal(m['Battery power'], -1830);
  assert.equal(m['Battery current'], -34.2);
  assert.equal(m['Grid power'], 250);
  assert.equal(m['Load power'], 2050);
  assert.equal(m['Load percentage'], undefined);
  assert.equal(m['Fault code'], '0x00010004');
  assert.equal(m['Device mode'], 'Off-grid');
});

test('writes are refused', async () => {
  const d = midnite.create({ modelId: 'aio', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  await assert.rejects(d.writeSetting('work_mode', 'Self use'), /read-only/);
  await assert.rejects(d.rawWrite!(0x2100, [0]), /read-only/);
});

test('detect accepts an AIO', async () => {
  const r = await probe(aioMap());
  assert.ok(r);
  assert.equal(r.modelId, 'aio');
  assert.match(r.evidence, /MN15-12KW-AIO/);
  assert.match(r.evidence, /MN2406A01234/);
  assert.match(r.evidence, /53\.2 V 76%/);
});

test('detect accepts the minimal identity image', async () => {
  const h = new Map<number, number>();
  ascii(0x1a00, 'MN15-12KW-AIO', h, 8);
  ascii(0x1a10, 'MN2406A01234', h, 8);
  h.set(0x2006, 532);
  assert.ok(await probe(h));
});

test('detect rejects blank, 0xFFFF, Deye-like, Growatt-like and Senergy-branded maps', async () => {
  assert.equal(await probe(new Map()), null);

  const ff = new Map<number, number>();
  for (let a = 0x1a00; a < 0x1a19; a++) ff.set(a, 0xffff);
  for (let a = 0x2000; a < 0x2007; a++) ff.set(a, 0xffff);
  assert.equal(await probe(ff), null);

  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(3, '2106123456', deye, 5);
  assert.equal(await probe(deye), null);

  const growatt = new Map<number, number>();
  ascii(9, 'RA1.0 ', growatt, 3);
  ascii(23, 'XYZ0123456', growatt, 5);
  assert.equal(await probe(growatt), null);

  // Same map, Senergy model string: the Senergy driver's job.
  const senergy = aioMap();
  ascii(0x1a00, 'SE11.4KHB-UL', senergy, 8);
  assert.equal(await probe(senergy), null);

  // MidNite model but no serial, or an impossible battery.
  const noSerial = aioMap();
  for (let a = 0x1a10; a < 0x1a18; a++) noSerial.set(a, 0);
  assert.equal(await probe(noSerial), null);
  const badBatt = aioMap();
  badBatt.set(0x2006, 0);
  assert.equal(await probe(badBatt), null);
});
