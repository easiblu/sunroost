import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import modbusSerial from 'modbus-serial';
import { decodeLive, huawei, huaweiModel, modelFromName, timing } from '../src/devices/inverters/huawei/index.ts';
import { image } from '../src/devices/inverters/huawei/registers.ts';
import { decodeSettings, HUAWEI_SETTINGS } from '../src/devices/inverters/huawei/settings.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

timing.connectDelayMs = 0;

const LOGGER = 2712345678;

function ascii(m: Map<number, number>, start: number, s: string, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) m.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
const set16 = (m: Map<number, number>, a: number, v: number) => m.set(a, v & 0xffff);
function set32(m: Map<number, number>, a: number, v: number) {
  m.set(a, (v >>> 16) & 0xffff);
  m.set(a + 1, v & 0xffff);
}

/** SUN2000-5KTL-L1 with a LUNA2000 (charging) and a DTSU666-H (importing 450 W). */
function l1Map() {
  const h = new Map<number, number>();
  ascii(h, 30000, 'SUN2000-5KTL-L1', 15);
  ascii(h, 30015, 'HV2050012345', 10);
  ascii(h, 30025, '01074531-005', 10);
  ascii(h, 30050, 'V100R001C00SPC138', 15);
  h.set(30070, 345);
  h.set(30071, 2);
  h.set(30072, 2);
  set32(h, 30073, 5000);
  // Alarms: alarm 2 bit 2.
  h.set(32008, 0);
  h.set(32009, 0x0004);
  h.set(32010, 0);
  // PV strings.
  h.set(32016, 3502); // 350.2 V
  h.set(32017, 612); // 6.12 A → 2143 W
  h.set(32018, 3300); // 330.0 V
  h.set(32019, 455); // 4.55 A → 1502 W
  set32(h, 32064, 3600);
  h.set(32069, 2312);
  set32(h, 32072, 12345);
  set32(h, 32078, 4100);
  set32(h, 32080, 2800);
  set32(h, 32082, -150);
  set16(h, 32084, -995);
  h.set(32085, 5001);
  h.set(32086, 9750);
  set16(h, 32087, 452);
  h.set(32088, 3000);
  h.set(32089, 0x0200);
  h.set(32090, 0);
  set32(h, 32106, 1234567);
  set32(h, 32114, 1850);
  // Meter.
  h.set(37100, 1);
  set32(h, 37101, 2305);
  set32(h, 37107, -512);
  set32(h, 37113, -450);
  h.set(37118, 5000);
  set32(h, 37119, 100000);
  set32(h, 37121, 250050);
  h.set(37125, 0);
  // Battery unit 1 + system.
  h.set(37000, 2);
  set32(h, 37001, 700);
  h.set(37003, 4521);
  h.set(37004, 655);
  set16(h, 37021, 15);
  set16(h, 37022, 254);
  set32(h, 37758, 10000);
  h.set(37760, 655);
  h.set(37762, 2);
  h.set(37763, 4521);
  set16(h, 37764, 15);
  set32(h, 37765, 700);
  set32(h, 37780, 98765);
  set32(h, 37782, 87654);
  set32(h, 37784, 520);
  set32(h, 37786, 310);
  // Settings.
  h.set(47000, 2);
  set32(h, 47075, 5000);
  set32(h, 47077, 4500);
  h.set(47081, 1000);
  h.set(47082, 50);
  h.set(47086, 2);
  h.set(47087, 1);
  h.set(47088, 500);
  h.set(47102, 150);
  set32(h, 47242, 2500);
  h.set(47415, 6);
  set32(h, 47416, 3000);
  h.set(47418, 1000);
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
      return await huawei.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: read-only, huawei id, defaults', () => {
  assert.equal(huawei.id, 'huawei');
  assert.equal(huawei.readOnly, true);
  assert.equal(huawei.transport, 'serial');
  assert.equal(huawei.defaultBaudRate, 9600);
  assert.equal(huawei.defaultAddress, 1);
  assert.deepEqual(huawei.models?.map((m) => m.id), ['hybrid', 'three']);
  assert.equal(huawei.socControl?.('hybrid'), null);
  assert.equal(huawei.protectionSetting?.('hybrid'), null);
  assert.deepEqual(huawei.consoleFunctions, [{ id: '3', name: 'Holding register' }]);
  const d = huawei.create({ modelId: 'hybrid', connection: '127.0.0.1:502', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length >= 10);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('model from name', () => {
  assert.equal(modelFromName('SUN2000-5KTL-L1'), 'hybrid');
  assert.equal(modelFromName('SUN2000-10KTL-M1'), 'three');
  assert.equal(modelFromName('SUN2000-8KTL-M0'), 'three');
  assert.equal(modelFromName('SUN2000-12K-MB0'), undefined);
});

test('L1 hybrid over a logger: info, live decode and settings', async () => {
  await withLogger(l1Map(), async (connection) => {
    const d = huawei.create({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Model name'], 'SUN2000-5KTL-L1');
      assert.equal(info['Serial number'], 'HV2050012345');
      assert.equal(info['Firmware version'], 'V100R001C00SPC138');
      assert.equal(info['Max AC output power'], 5000);

      const m = await d.read();
      assert.equal(m['PV voltage 1'], 350.2);
      assert.equal(m['PV current 1'], 6.12);
      assert.equal(m['PV power 1'], 2143);
      assert.equal(m['PV power 2'], 1502);
      assert.equal(m['PV power'], 3645);
      assert.equal(m['Input power'], 3600);
      assert.equal(m['Inverter power'], 2800);
      assert.equal(m['Reactive power'], -150);
      assert.equal(m['Power factor'], -0.995);
      assert.equal(m['AC output voltage'], 231.2);
      assert.equal(m['AC output current'], 12.345);
      assert.equal(m['AC output frequency'], 50.01);
      assert.equal(m.Temperature, 45.2);
      assert.equal(m['Device mode'], 'On-grid');
      assert.equal(m['Fault code'], 'alarm 2 0x0004');
      assert.equal(m['Inverter energy total'], 12345.67);
      assert.equal(m['Inverter energy today'], 18.5);
      // Meter: −450 W at the meter (Huawei: − = import) → +450 W grid import.
      assert.equal(m['Grid power'], 450);
      assert.equal(m['Grid voltage'], 230.5);
      assert.equal(m['Grid current'], -5.12);
      assert.equal(m['Grid frequency'], 50);
      assert.equal(m['Load power'], 3250);
      assert.equal(m['Export energy total'], 1000);
      assert.equal(m['Import energy total'], 2500.5);
      // Battery.
      assert.equal(m['Battery state of charge'], 65.5);
      assert.equal(m['Battery voltage'], 452.1);
      assert.equal(m['Battery current'], 1.5);
      assert.equal(m['Battery power'], 700);
      assert.equal(m['Battery temperature'], 25.4);
      assert.equal(m['Battery status'], 'Running');
      assert.equal(m['Battery capacity'], 10);
      assert.equal(m['Charge energy total'], 987.65);
      assert.equal(m['Discharge energy today'], 3.1);

      const s = await d.readSettings();
      assert.equal(s.battery_product_model, 'Huawei LUNA2000');
      assert.equal(s.storage_working_mode, 'Maximise self consumption');
      assert.equal(s.max_charge_power, 5000);
      assert.equal(s.max_discharge_power, 4500);
      assert.equal(s.charge_cutoff_state_of_charge, 100);
      assert.equal(s.discharge_cutoff_state_of_charge, 5);
      assert.equal(s.charge_from_grid, true);
      assert.equal(s.grid_charge_cutoff_state_of_charge, 50);
      assert.equal(s.backup_power_state_of_charge, 15);
      assert.equal(s.max_grid_charge_power, 2500);
      assert.equal(s.active_power_control_mode, 'Limited feed-in (W)');
      assert.equal(s.max_grid_feed_in_power, 3000);
      assert.equal(s.max_grid_feed_in_power_percentage, 100);

      assert.deepEqual(await d.rawRead!(3, 30070, 2), [345, 2]);
    } finally {
      await d.close();
    }
  });
});

test('three-phase decode: per-phase grid from the meter, export, discharging battery, fault', () => {
  const h = new Map<number, number>();
  for (let n = 0; n < 4; n++) {
    h.set(32016 + n * 2, 6000);
    h.set(32017 + n * 2, 500);
  }
  [2301, 2302, 2303].forEach((v, i) => h.set(32069 + i, v));
  [4000, 4100, 4200].forEach((v, i) => set32(h, 32072 + i * 2, v));
  set32(h, 32080, 9000);
  h.set(32085, 4998);
  set16(h, 32087, -52);
  h.set(32089, 0x0300);
  h.set(32090, 2062);
  h.set(37100, 1);
  [2310, 2320, 2330].forEach((v, i) => set32(h, 37101 + i * 2, v));
  [800, 810, 820].forEach((v, i) => set32(h, 37107 + i * 2, v));
  set32(h, 37113, 5400);
  h.set(37118, 4999);
  [1800, 1800, 1800].forEach((v, i) => set32(h, 37132 + i * 2, v));
  h.set(37762, 2);
  h.set(37760, 400);
  set32(h, 37765, -2500);
  const m = decodeLive(huaweiModel('three'), h, 4);
  assert.equal(m['PV power'], 4 * 3000);
  assert.equal(m['PV power 4'], 3000);
  assert.equal(m['AC output voltage 3'], 230.3);
  assert.equal(m['AC output current 2'], 4.1);
  assert.equal(m['Grid power'], -5400);
  assert.equal(m['Grid power 2'], -1800);
  assert.equal(m['Grid voltage 3'], 233);
  assert.equal(m['Grid current 1'], 8);
  assert.equal(m['Grid frequency'], 49.99);
  assert.equal(m['Load power'], 3600);
  assert.equal(m['Battery power'], -2500);
  assert.equal(m['Battery state of charge'], 40);
  assert.equal(m.Temperature, -5.2);
  assert.equal(m['Device mode'], 'Shutdown: fault');
  assert.equal(m['Fault code'], 'fault 2062');
});

test('no meter, no battery: grid from inverter, no grid/load/battery power', () => {
  const h = image(32064, Array(32).fill(0));
  h.set(32069, 2300);
  h.set(32085, 5000);
  set32(h, 32080, 1000);
  h.set(32016, 3000);
  h.set(32017, 350);
  const m = decodeLive(huaweiModel('hybrid'), h, 1);
  assert.equal(m['Grid voltage'], 230);
  assert.equal(m['Grid frequency'], 50);
  assert.equal(m['PV power'], 1050);
  assert.equal(m['Grid power'], undefined);
  assert.equal(m['Load power'], undefined);
  assert.equal(m['Battery power'], undefined);
  assert.equal(m['Fault code'], 'None');
});

test('settings decode skips missing registers', () => {
  const s = decodeSettings(HUAWEI_SETTINGS, image(47086, [5]));
  assert.deepEqual(s, { storage_working_mode: 'Time of use (LUNA2000)' });
});

test('writes are refused', async () => {
  const d = huawei.create({ modelId: 'three', connection: '127.0.0.1:502', baudRate: 9600, address: 1, index: 0 });
  await assert.rejects(d.writeSetting('storage_working_mode', 'Adaptive'), /read-only/);
  await assert.rejects(d.rawWrite!(47086, [2]), /read-only/);
});

test('detect accepts a SUN2000 at unit 1', async () => {
  const r = await probe(l1Map());
  assert.ok(r);
  assert.equal(r.modelId, 'hybrid');
  assert.equal(r.address, 1);
  assert.match(r.evidence, /SUN2000-5KTL-L1/);
  assert.match(r.evidence, /HV2050012345/);
  const h = new Map<number, number>();
  ascii(h, 30000, 'SUN2000-10KTL-M1', 15);
  assert.equal((await probe(h))?.modelId, 'three');
});

test('detect rejects blank, 0xFFFF, Deye-like, Growatt-like and non-SUN2000 maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 30000; a < 30025; a++) ff.set(a, 0xffff);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(deye, 3, '2106123456', 5);
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  ascii(growatt, 9, 'RA1.0 ', 3);
  ascii(growatt, 23, 'XYZ0123456', 5);
  assert.equal(await probe(growatt), null);
  const other = new Map<number, number>();
  ascii(other, 30000, 'SG10RT', 15);
  assert.equal(await probe(other), null);
});

/** Modbus TCP server that answers only unit 0 (like the inverter's own port 6607), with no battery. */
async function unit0Server(holding: Map<number, number>) {
  const port = 16000 + Math.floor(Math.random() * 1000);
  const reads: number[] = [];
  const check = (addr: number, unit: number) => {
    if (unit !== 0) throw Object.assign(new Error('gateway target failed'), { modbusErrorCode: 0x0b });
    if ((addr >= 37000 && addr < 37100) || (addr >= 37700 && addr < 37800)) throw Object.assign(new Error('illegal address'), { modbusErrorCode: 0x02 });
  };
  const server = new modbusSerial.ServerTCP(
    {
      getHoldingRegister: (addr: number, unit: number) => {
        check(addr, unit);
        reads.push(addr);
        return holding.get(addr) ?? 0;
      },
      getMultipleHoldingRegisters: (addr: number, length: number, unit: number) => {
        check(addr, unit);
        reads.push(addr);
        return Array.from({ length }, (_, i) => holding.get(addr + i) ?? 0);
      },
      getInputRegister: () => 0,
      setRegister: () => {
        throw new Error('no writes');
      },
    },
    { host: '127.0.0.1', port, unitID: 255 },
  );
  await once(server, 'initialized');
  return { server, port, reads };
}

test('Modbus TCP unit 0: detect falls back to unit 0; absent battery blocks are skipped', async () => {
  const h = l1Map();
  const { server, port, reads } = await unit0Server(h);
  try {
    const conn = new ModbusConnection(parseConnection(`127.0.0.1:${port}`, 9600, 1));
    await conn.connect();
    try {
      const r = await huawei.detect!(conn);
      assert.ok(r);
      assert.equal(r.address, 0);
      assert.match(r.evidence, /unit 0/);
    } finally {
      await conn.close();
    }

    const d = huawei.create({ modelId: 'hybrid', connection: `127.0.0.1:${port}`, baudRate: 9600, address: 0, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Serial number'], 'HV2050012345');
      const m = await d.read();
      assert.equal(m['PV power'], 3645);
      assert.equal(m['Grid power'], 450);
      assert.equal(m['Battery power'], undefined);
      reads.length = 0;
      await d.read();
      assert.ok(!reads.some((a) => a === 37000 || a === 37758), 'battery blocks not re-read straight away');
      assert.ok(reads.includes(37100), 'meter still read');
    } finally {
      await d.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
