import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, decodeRange, detectMust, must, mustFamily, mustDrivers } from '../src/devices/inverters/must/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';
import type { RegisterImage } from '../src/devices/inverters/growatt/registers.ts';

const s16 = (v: number) => v & 0xffff;
const ascii = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => (s.charCodeAt(i * 2) << 8) | s.charCodeAt(i * 2 + 1));

/** A PH1800 discharging the battery into a 1.2 kW load while PV makes 850 W, grid importing 50 W. */
function ph1800Map(): Map<number, number> {
  const m = new Map<number, number>();
  // Identity: "PH" 1800, serial 0x0012D687 (1234567), hw 1.02.03, sw 2.05.10
  m.set(20000, ascii('PH')[0]).set(20001, 1800).set(20002, 0x0012).set(20003, 0xd687).set(20004, 10203).set(20005, 20510);
  // Charger block.
  m.set(15201, 2).set(15202, 1).set(15203, 0).set(15205, 3215).set(15206, 512).set(15207, 160).set(15208, 850);
  m.set(15209, 38).set(15210, s16(-5)).set(15213, 0).set(15214, 0).set(15215, 48);
  // Inverter block.
  m.set(25201, 2).set(25203, 5000).set(25205, 513).set(25206, 2301).set(25207, 2297).set(25208, 3850);
  m.set(25213, 1180).set(25214, 50).set(25215, 1200).set(25216, 24).set(25219, 1320);
  m.set(25225, 5000).set(25226, 4998).set(25233, 41).set(25234, 47).set(25235, 39);
  m.set(25261, 0b1000).set(25262, 0).set(25273, 400).set(25274, 8);
  // Settings.
  m.set(10103, 540).set(10104, 564).set(10108, 600).set(10110, 2).set(10111, 200);
  m.set(20109, 1).set(20102, 2300).set(20103, 5000).set(20125, 300).set(20143, 2).set(20144, 1);
  return m;
}

const asImage = (m: Map<number, number>): RegisterImage => new Map(m);

test('PH1800: live decode with scaling and signs', () => {
  const r = decodeLive(mustFamily('ph1800'), asImage(ph1800Map()));
  assert.equal(r['Device mode'], 'Off-grid');
  assert.equal(r['PV voltage 1'], 321.5);
  assert.equal(r['PV power 1'], 850);
  assert.equal(r['PV power'], 850);
  assert.equal(r['PV current 1'], 2.6);
  assert.equal(r['Battery voltage'], 51.3);
  assert.equal(r['Battery power'], -400, 'raw + = discharging is negated');
  assert.equal(r['Battery current'], -7.8);
  assert.equal(r['Battery temperature'], -5);
  assert.equal(r['Grid voltage'], 229.7);
  assert.equal(r['Grid frequency'], 49.98);
  assert.equal(r['Grid power'], 50);
  assert.equal(r['Load power'], 1200);
  assert.equal(r['Load apparent power'], 1320);
  assert.equal(r['Load percentage'], 24);
  assert.equal(r['AC output voltage'], 230.1);
  assert.equal(r['AC output frequency'], 50);
  assert.equal(r['Bus voltage'], 385);
  assert.equal(r.Temperature, 47);
  assert.equal(r['Fault code'], 'Inverter fault 4');
  assert.equal(r['Battery state of charge'], undefined, 'PH1800 has no SOC register');
});

test('PH1800: grid export and charging signs; battery voltage falls back to the charger', () => {
  const m = ph1800Map();
  m.set(25214, s16(-750)).set(25273, s16(-1000)).delete(25205);
  const r = decodeLive(mustFamily('ph1800'), asImage(m));
  assert.equal(r['Grid power'], -750);
  assert.equal(r['Battery power'], 1000);
  assert.equal(r['Battery voltage'], 51.2);
  assert.equal(r['Battery current'], 19.5);
});

test('PV19 EXP: SOC and second MPPT', () => {
  const m = ph1800Map();
  m.set(113, 87).set(114, 99).set(16205, 2805).set(16207, 120).set(16208, 640);
  const r = decodeLive(mustFamily('pv1900'), asImage(m));
  assert.equal(r['Battery state of charge'], 87);
  assert.equal(r['PV voltage 2'], 280.5);
  assert.equal(r['PV power 2'], 640);
  assert.equal(r['PV power'], 1490);
});

test('PH11 three-phase: per-phase values and 0.1-scaled battery block', () => {
  const m: RegisterImage = new Map();
  m.set(15104, 532).set(15105, s16(-215)).set(15106, s16(-1144)).set(15107, 412).set(15111, 236).set(15115, 64);
  m.set(25225, 4120).set(25226, 75).set(25227, 3090).set(25228, 3980).set(25229, 52).set(25230, 2070);
  m.set(25237, 2301).set(25238, 2312).set(25239, 2323).set(25243, 5001).set(25244, s16(-300));
  m.set(25247, 2300).set(25248, 2301).set(25249, 2302).set(25253, 5000).set(25263, 3700).set(25265, 3900);
  const r = decodeLive(mustFamily('ph10'), m);
  assert.equal(r['PV power'], 5160);
  assert.equal(r['PV voltage 1'], 412);
  assert.equal(r['PV current 2'], 5.2);
  assert.equal(r['Battery voltage'], 53.2);
  assert.equal(r['Battery power'], 1144);
  assert.equal(r['Battery current'], 21.5);
  assert.equal(r['Battery state of charge'], 64);
  assert.equal(r['Battery temperature'], 23.6);
  assert.equal(r['Grid voltage 2'], 231.2);
  assert.equal(r['Grid voltage'], 230.1);
  assert.equal(r['Grid power'], -300);
  assert.equal(r['AC output voltage 3'], 230.2);
  assert.equal(r['Load power'], 3700);
  assert.equal(r.Temperature, 41.2);
});

test('console decodeRange shows identity and settings', () => {
  const m = ph1800Map();
  const out = decodeRange(mustFamily('ph1800'), 3, 20101, Array.from({ length: 44 }, (_, i) => m.get(20101 + i) ?? 0));
  assert.equal(out['Output source priority (unverified)'], 'SBU priority');
  assert.deepEqual(decodeRange(mustFamily('ph1800'), 4, 0, [1]), {});
});

async function withLogger(holding: Map<number, number>, fn: (connection: string) => Promise<void>) {
  const server = fakeLogger({ serial: 77, holding });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/77`);
  } finally {
    server.close();
  }
}

async function probe(holding: Map<number, number>) {
  let result: Awaited<ReturnType<typeof detectMust>> = null;
  await withLogger(holding, async (connection) => {
    const conn = new ModbusConnection({ ...parseConnection(connection, 19200, 1), timeoutMs: 500 });
    await conn.connect();
    try {
      result = await must.detect!(conn);
    } finally {
      await conn.close();
    }
  });
  return result as Awaited<ReturnType<typeof detectMust>>;
}

test('driver end to end: info, live read, settings, writes refused', async () => {
  await withLogger(ph1800Map(), async (connection) => {
    const driver = must.create({ modelId: 'ph1800', connection, baudRate: 19200, address: 4, index: 0 });
    await driver.connect();
    try {
      const info = driver.info();
      assert.equal(info['Serial number'], '1234567');
      assert.equal(info['Model name'], 'MUST PH1800');
      assert.equal(info['Firmware version'], '2.05.10');
      const m = await driver.read();
      assert.equal(m['Load power'], 1200);
      assert.equal(m['Battery voltage'], 51.3);

      const defs = driver.settingDefs();
      assert.ok(defs.length > 10);
      assert.ok(defs.every((d) => d.readOnly === true));
      const v = await driver.readSettings();
      assert.equal(v.battery_type, 'Lithium');
      assert.equal(v.battery_capacity, 200);
      assert.equal(v.float_charge_voltage, 54);
      assert.equal(v.max_charge_current, 60);
      assert.equal(v.output_source_priority, 'SBU priority');
      assert.equal(v.charger_source_priority, 'Solar and utility simultaneously');
      assert.equal(v.ac_output_frequency, 50);
      assert.equal(v.pv_power_balance, true);

      await assert.rejects(driver.writeSetting('output_source_priority', 'Utility first'), /read-only/);
      await assert.rejects(driver.rawWrite!(20109, [3]), /read-only/);
      assert.deepEqual(await driver.rawRead!(3, 20001, 1), [1800]);
      // Nothing was written.
      assert.equal((await driver.readSettings()).output_source_priority, 'SBU priority');
    } finally {
      await driver.close();
    }
  });
});

test('descriptor: read-only, 19200 baud, no SOC control', () => {
  assert.equal(mustDrivers[0], must);
  assert.equal(must.id, 'must');
  assert.equal(must.readOnly, true);
  assert.equal(must.defaultBaudRate, 19200);
  assert.equal(must.socControl!('ph1800'), null);
  assert.deepEqual(must.models!.map((x) => x.id), ['ph1800', 'pv1900', 'pv3300', 'ph10']);
});

test('detect: accepts a PH1800', async () => {
  const r = await probe(ph1800Map());
  assert.ok(r);
  assert.equal(r.modelId, 'ph1800');
  assert.match(r.evidence, /machine type 1800/);
  assert.match(r.evidence, /serial 1234567/);
});

test('detect: rejects blank, 0xFFFF, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 20000; a < 20006; a++) ff.set(a, 0xffff);
  ff.set(25201, 2);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>([[0, 3]]);
  ascii('2106123456').forEach((v, i) => deye.set(3 + i, v));
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  ascii('RA1.0 ').forEach((v, i) => growatt.set(9 + i, v));
  ascii('XYZ0123456').forEach((v, i) => growatt.set(23 + i, v));
  assert.equal(await probe(growatt), null);
  // Known machine type but an impossible work state.
  const odd = ph1800Map().set(25201, 99);
  assert.equal(await probe(odd), null);
});
