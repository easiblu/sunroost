import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { afore, aforeModel, decodeLive } from '../src/devices/inverters/afore/index.ts';
import { image, type RegisterImage } from '../src/devices/inverters/afore/registers.ts';
import { AFORE_SETTINGS, decodeSettings } from '../src/devices/inverters/afore/settings.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2798765432;

function ascii(start: number, s: string, into: Map<number, number>, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
const s16 = (v: number) => v & 0xffff;
/** 32-bit value → [high, low] words. */
const w32 = (v: number) => [(v >>> 16) & 0xffff, v & 0xffff];
function put(m: Map<number, number>, at: number, words: number[]) {
  words.forEach((w, i) => m.set(at + i, w));
}

function info(input: Map<number, number>, type: number, rated: number, serial: string) {
  ascii(0, 'AF6K-SL', input, 6);
  input.set(6, type);
  put(input, 7, w32(rated));
  input.set(20, 101); // 1.01
  input.set(25, 12345); // 123.45
  input.set(30, 20007);
  input.set(35, 300);
  ascii(41, serial, input, 8);
  put(input, 52, w32(0b001_000_001));
}

/** AF6K-SL: PV 4.2 kW, charging 1.5 kW, exporting 1.2 kW, load 1.4 kW. */
function slMaps() {
  const input = new Map<number, number>();
  info(input, 206, 6000, 'AF6KSL2306001234');
  input.set(500, 3912);
  input.set(507, 2318);
  input.set(510, s16(-125));
  input.set(513, 4998);
  put(input, 522, w32(2650));
  put(input, 529, w32(1200));
  put(input, 535, w32(1200));
  put(input, 547, w32(1400));
  put(input, 553, w32(4200));
  put(input, 555, [3805, 702, 2671, 2950, 519, 1531, 0, 0, 0, 0, 0, 0]);
  put(input, 1002, [52, 31, 98]);
  put(input, 1006, w32(213));
  put(input, 1018, w32(123456));
  put(input, 1020, w32(65540));
  put(input, 1022, w32(7000));
  put(input, 1026, w32(98765));
  // Battery: charging, raw current/power reported negative (sign follows the state word).
  put(input, 2000, [4, 255, 67, 98, 524, s16(-2864), 0, 0, s16(-1500), 41, 12]);
  put(input, 2011, [...w32(70000), ...w32(65000)]);
  input.set(2500, 3);
  input.set(2514, 452);
  input.set(2515, s16(-31));
  for (let a = 3000; a < 3028; a++) input.set(a, 0);
  put(input, 3008, w32(4));

  const holding = new Map<number, number>();
  holding.set(204, 11);
  holding.set(205, 0);
  put(holding, 206, [0, 0b10001]);
  holding.set(210, 1200);
  holding.set(211, 1);
  holding.set(1502, 1000);
  put(holding, 1503, w32(6000));
  holding.set(2038, 60);
  put(holding, 2039, w32(500));
  holding.set(2500, 6);
  holding.set(2501, 0xaa);
  holding.set(2504, 500);
  holding.set(2505, 900);
  holding.set(2509, 0x0200);
  holding.set(2510, 0x051e);
  holding.set(3000, 1);
  return { input, holding };
}

async function withLogger<T>(maps: { input?: Map<number, number>; holding?: Map<number, number> }, fn: (connection: string) => Promise<T>): Promise<T> {
  const server = fakeLogger({ serial: LOGGER, ...maps });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/${LOGGER}`);
  } finally {
    server.close();
  }
}

async function probe(maps: { input?: Map<number, number>; holding?: Map<number, number> }) {
  return withLogger(maps, async (c) => {
    const conn = new ModbusConnection(parseConnection(c, 9600, 1));
    await conn.connect();
    try {
      return await afore.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: read-only, afore id, settings read-only', () => {
  assert.equal(afore.id, 'afore');
  assert.equal(afore.readOnly, true);
  assert.equal(afore.transport, 'serial');
  assert.equal(afore.defaultBaudRate, 9600);
  assert.deepEqual(afore.models?.map((m) => m.id), ['hybrid', 'hybrid3']);
  assert.equal(afore.socControl?.('hybrid'), null);
  assert.equal(afore.protectionSetting?.('hybrid'), null);
  const d = afore.create({ modelId: 'hybrid', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length > 10);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('single-phase hybrid over a logger: info, live decode, settings, writes refused', async () => {
  await withLogger(slMaps(), async (connection) => {
    const d = afore.create({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const i = d.info();
      assert.equal(i['Model name'], 'AF6K-SL');
      assert.equal(i['Serial number'], 'AF6KSL2306001234');
      assert.equal(i['Firmware version'], '123.45');
      assert.equal(i['Secondary firmware version'], '200.07');
      assert.equal(i['Protocol version'], '1.01');
      assert.equal(i['Max AC output power'], 6000);

      const r = await d.read();
      assert.equal(r['PV power'], 4200);
      assert.equal(r['PV voltage 1'], 380.5);
      assert.equal(r['PV current 1'], 7.02);
      assert.equal(r['PV power 1'], 2671);
      assert.equal(r['PV power 2'], 1531);
      assert.equal(r['PV voltage 3'], undefined, 'idle trackers 3/4 hidden');
      assert.equal(r['Battery state of charge'], 67);
      assert.equal(r['Battery state of health'], 98);
      assert.equal(r['Battery voltage'], 52.4);
      assert.equal(r['Battery current'], 28.64, 'charging → positive');
      assert.equal(r['Battery power'], 1500);
      assert.equal(r['Battery temperature'], 25.5);
      assert.equal(r['Grid power'], -1200, 'exporting → negative');
      assert.equal(r['Grid voltage'], 231.8);
      assert.equal(r['Grid frequency'], 49.98);
      assert.equal(r['Load power'], 1400);
      assert.equal(r['Inverter power'], 2650);
      assert.equal(r['Bus voltage'], 391.2);
      assert.equal(r['Device mode'], 'Grid');
      assert.equal(r.Temperature, 45.2);
      assert.equal(r['Temperature transformer'], -3.1);
      assert.equal(r['Fault code'], 'Grid error 0x00000004');
      assert.equal(r['Export energy today'], 5.2);
      assert.equal(r['PV energy today'], 21.3);
      assert.equal(r['Export energy total'], 12345.6);
      assert.equal(r['Import energy total'], 6554, '32-bit across the word boundary');
      assert.equal(r['PV energy total'], 9876.5);
      assert.equal(r['Charge energy total'], 7000);
      assert.equal(r['Discharge energy today'], 1.2);

      const s = await d.readSettings();
      assert.equal(s.grid_code, 'UK G99');
      assert.equal(s.meter_type, 'CT');
      assert.equal(s.inverter_enabled, true);
      assert.equal(s.time_of_use, true);
      assert.equal(s.pv_start_up_voltage, 120);
      assert.equal(s.active_power_limit, 100);
      assert.equal(s.max_active_output_power, 6000);
      assert.equal(s.grid_feed_in_limit, 50);
      assert.equal(s.fault_reconnection_time, 60);
      assert.equal(s.energy_management_mode, 'Time of use');
      assert.equal(s.battery_charge_and_discharge, true);
      assert.equal(s.timed_charge_power, 50);
      assert.equal(s.timed_charge_max_soc, 90);
      assert.equal(s.timed_charge_1_start, '02:00');
      assert.equal(s.timed_charge_1_end, '05:30');
      assert.equal(s.battery_type, 'Lithium');
      assert.equal(s.pv_input_mode, 'Independent');

      await assert.rejects(d.writeSetting('grid_code', 'UK G98'), /read-only/);
      await assert.rejects(d.rawWrite!(204, [10]), /read-only/);
      assert.deepEqual(await d.rawRead!(4, 2002, 3), [67, 98, 524]);
      assert.deepEqual(await d.rawRead!(3, 211, 1), [1]);
    } finally {
      await d.close();
    }
  });
});

test('three-phase: per-phase grid and load, discharging, importing', () => {
  const regs: RegisterImage = new Map();
  image(500, new Array(67).fill(0), regs);
  image(2000, new Array(15).fill(0), regs);
  put(regs, 507, [2301, 2312, 2295]);
  put(regs, 529, [...w32(-800 >>> 0), ...w32(-700 >>> 0), ...w32(-900 >>> 0), ...w32(-2400 >>> 0)]);
  put(regs, 541, [...w32(1100), ...w32(1000), ...w32(1300), ...w32(3400)]);
  put(regs, 2000, [5, 300, 40, 100, 2012, 4100, 0, 0, 825]);
  const r = decodeLive(aforeModel('hybrid3'), regs);
  assert.equal(r['Grid power'], 2400);
  assert.equal(r['Grid power 2'], 700);
  assert.equal(r['Grid voltage 3'], 229.5);
  assert.equal(r['Grid voltage'], 230.1);
  assert.equal(r['Load power'], 3400);
  assert.equal(r['Load power 3'], 1300);
  assert.equal(r['Battery current'], -41, 'discharging → negative');
  assert.equal(r['Battery power'], -825);
  assert.equal(r['PV power'], 0);
  assert.equal(r['Fault code'], undefined, 'no fault block read');
});

test('settings decode skips missing and out-of-range values', () => {
  const regs: RegisterImage = new Map([[2509, 0xffff], [204, 200], [2501, 0]]);
  const s = decodeSettings(AFORE_SETTINGS, regs);
  assert.equal(s.timed_charge_1_start, undefined);
  assert.equal(s.grid_code, 'Unknown (200)');
  assert.equal(s.battery_charge_and_discharge, undefined);
  assert.equal(s.max_active_output_power, undefined);
});

test('detect: accepts AF-SL and AF-TH, picks the model from the type code', async () => {
  const sl = await probe(slMaps());
  assert.equal(sl?.modelId, 'hybrid');
  assert.match(sl!.evidence, /type 206.*6000 W.*AF6KSL2306001234/);
  const th = new Map<number, number>();
  info(th, 302, 10000, 'AF10KTH230700001');
  assert.equal((await probe({ input: th }))?.modelId, 'hybrid3');
});

test('detect: rejects blank, 0xFFFF, on-grid, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe({}), null, 'blank');
  const ff = new Map<number, number>();
  for (let a = 0; a < 54; a++) ff.set(a, 0xffff);
  assert.equal(await probe({ input: ff, holding: ff }), null, '0xFFFF');
  const ongrid = new Map<number, number>();
  info(ongrid, 105, 10000, 'BNT010KTL2207001');
  assert.equal(await probe({ input: ongrid }), null, 'on-grid type code');
  const noSerial = new Map<number, number>();
  info(noSerial, 206, 6000, '');
  assert.equal(await probe({ input: noSerial }), null, 'no serial');

  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(3, '2106123456', deye, 5);
  assert.equal(await probe({ holding: deye, input: deye }), null, 'Deye-like');

  const growatt = new Map<number, number>();
  ascii(9, 'RA1.0 ', growatt, 3);
  ascii(23, 'XYZ0123456', growatt, 5);
  assert.equal(await probe({ holding: growatt, input: growatt }), null, 'Growatt-like');
});
