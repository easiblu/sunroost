import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, modelFromName, senergy, senergyDrivers, senergyModel } from '../src/devices/inverters/senergy/index.ts';
import { decodeSettings, SENERGY_SETTINGS } from '../src/devices/inverters/senergy/settings.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;

function ascii(start: number, s: string, into: Map<number, number>, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
const s16 = (v: number) => v & 0xffff;
/** 32-bit value → [high, low] words. */
const w32 = (v: number) => {
  const u = v < 0 ? v + 0x100000000 : v;
  return [Math.floor(u / 0x10000), u & 0xffff];
};
function set(h: Map<number, number>, at: number, words: number[]) {
  words.forEach((w, i) => h.set(at + i, w));
}

/** A Dura-i single-phase hybrid: PV 3.2 kW, charging the battery 1.5 kW, exporting 0.9 kW. */
function duraMap() {
  const h = new Map<number, number>();
  ascii(0x1a00, 'PD-DH1P-6K-G3', h, 8);
  ascii(0x1a10, 'DH6G3230400123', h, 8);
  h.set(0x1a18, 0x0115);
  ascii(0x1a19, 'V1.05.02', h, 4);
  h.set(0x1a46, 6000);
  // Inverter / PV block.
  h.set(0x1001, 2318);
  h.set(0x1002, 352);
  set(h, 0x1003, w32(-7400));
  h.set(0x1005, 5002);
  h.set(0x1010, 3805);
  h.set(0x1011, 512);
  set(h, 0x1012, w32(19480));
  h.set(0x1014, 3620);
  h.set(0x1015, 340);
  set(h, 0x1016, w32(12310));
  h.set(0x101c, s16(-3));
  h.set(0x101d, 2);
  set(h, 0x101e, [0, 0]);
  set(h, 0x1021, w32(81234));
  set(h, 0x1027, w32(14560));
  set(h, 0x1037, w32(7400));
  set(h, 0x1048, w32(31790));
  // Meter block: exporting 912.3 W.
  set(h, 0x1300, w32(-9123));
  set(h, 0x1306, w32(1234567));
  set(h, 0x1308, w32(2345678));
  set(h, 0x130a, w32(7800));
  set(h, 0x131d, w32(-395));
  // Battery: 52.4 V, charging 28.6 A / 1500 W (Senergy reports charging as negative).
  h.set(0x2000, 64);
  h.set(0x2006, 524);
  set(h, 0x2007, w32(-2860));
  set(h, 0x2009, w32(-15000));
  set(h, 0x2011, w32(98765));
  h.set(0x201b, 23);
  // Settings.
  Object.entries({
    0x2100: 0, 0x2101: 1, 0x2102: 0x0200, 0x2103: 0x051e, 0x2116: 3000, 0x2118: 5000, 0x2119: 100,
    0x211a: 5000, 0x211b: 15, 0x2125: 6000, 0x2144: 10, 0x2145: 30, 0x214a: 20, 0x214c: 1, 0x2150: 4000,
  }).forEach(([a, v]) => h.set(Number(a), v));
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
      return await senergy.detect!(conn);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor is read-only with senergy id', () => {
  assert.equal(senergy.id, 'senergy');
  assert.deepEqual(senergyDrivers, [senergy]);
  assert.equal(senergy.readOnly, true);
  assert.equal(senergy.transport, 'serial');
  assert.equal(senergy.defaultBaudRate, 9600);
  assert.equal(senergy.defaultAddress, 1);
  assert.equal(senergy.socControl?.('hybrid'), null);
  assert.equal(senergy.protectionSetting?.('hybrid'), null);
  assert.deepEqual(senergy.models?.map((m) => m.id), ['hybrid', 'split', 'hybrid3']);
  const d = senergy.create({ modelId: 'hybrid', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length > 5);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('Dura-i over a logger: info, live decode and settings', async () => {
  await withLogger(duraMap(), async (connection) => {
    const d = senergy.create({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Model name'], 'PD-DH1P-6K-G3');
      assert.equal(info['Serial number'], 'DH6G3230400123');
      assert.equal(info['Firmware version'], 'V1.05.02');
      assert.equal(info['Protocol version'], '1.21');
      assert.equal(info['Max AC output power'], 6000);

      const m = await d.read();
      assert.equal(m['PV power'], 3179);
      assert.equal(m['PV voltage 1'], 380.5);
      assert.equal(m['PV current 1'], 5.12);
      assert.equal(m['PV power 1'], 1948);
      assert.equal(m['PV power 2'], 1231);
      assert.equal(m['Grid voltage'], 231.8);
      assert.equal(m['Grid frequency'], 50.02);
      assert.equal(m['Grid power'], -912);
      assert.equal(m['Grid current'], -3.95);
      assert.equal(m['Load power'], 780);
      assert.equal(m['Inverter power'], 740);
      assert.equal(m['Battery state of charge'], 64);
      assert.equal(m['Battery voltage'], 52.4);
      assert.equal(m['Battery power'], 1500);
      assert.equal(m['Battery current'], 28.6);
      assert.equal(m['Battery temperature'], 23);
      assert.equal(m.Temperature, -3);
      assert.equal(m['Device mode'], 'Grid-tied');
      assert.equal(m['Fault code'], 'None');
      assert.equal(m['PV energy total'], 81234);
      assert.equal(m['PV energy today'], 14.56);
      assert.equal(m['Import energy total'], 12345.67);
      assert.equal(m['Export energy total'], 23456.78);
      assert.equal(m['Discharge energy total'], 987.65);
      assert.equal(m['Grid power 1'], undefined, 'single-phase units only get the totals');

      const s = await d.readSettings();
      assert.equal(s.work_mode, 'Self use');
      assert.equal(s.time_of_use, true);
      assert.equal(s.time_of_use_repeat, 'Every day');
      assert.equal(s.charge_start_time_1, '02:00');
      assert.equal(s.charge_end_time_1, '05:30');
      assert.equal(s.max_charge_power, 5000);
      assert.equal(s.discharge_end_soc, 15);
      assert.equal(s.force_charge_stop_soc, 30);

      await assert.rejects(d.writeSetting('work_mode', 'Back-up'), /read-only/);
      await assert.rejects(d.rawWrite!(0x2100, [3]), /read-only/);
      assert.deepEqual(await d.rawRead!(3, 0x2000, 1), [64]);
    } finally {
      await d.close();
    }
  });
});

test('three-phase decode: per-phase grid, PV3, discharging battery and a fault', () => {
  const h = duraMap();
  h.set(0x1006, 2301);
  h.set(0x100b, 2299);
  set(h, 0x1302, w32(12000));
  set(h, 0x1304, w32(8000));
  set(h, 0x1300, w32(10000));
  h.set(0x1018, 4100);
  h.set(0x1019, 210);
  set(h, 0x101a, w32(8610));
  set(h, 0x101e, [0x0001, 0x0004]);
  h.set(0x101d, 7);
  set(h, 0x2007, w32(1500)); // + discharging
  set(h, 0x2009, w32(7860));
  const m = decodeLive(senergyModel('hybrid3'), h);
  assert.equal(m['Grid power'], 3000);
  assert.equal(m['Grid power 1'], 1000);
  assert.equal(m['Grid power 2'], 1200);
  assert.equal(m['Grid power 3'], 800);
  assert.equal(m['Grid voltage 2'], 230.1);
  assert.equal(m['Grid voltage 3'], 229.9);
  assert.equal(m['PV power 3'], 861);
  assert.equal(m['PV voltage 3'], 410);
  assert.equal(m['Battery power'], -786);
  assert.equal(m['Battery current'], -15);
  assert.equal(m['Fault code'], '0x00010004');
  assert.equal(m['Device mode'], 'Unknown (7)');
  // Split-phase: L1/L2 only.
  const sp = decodeLive(senergyModel('split'), h);
  assert.equal(sp['Grid power'], 2200);
  assert.equal(sp['Grid power 3'], undefined);
});

test('load falls back to the energy balance without the meter block', () => {
  const h = duraMap();
  for (let a = 0x1300; a < 0x1323; a++) h.delete(a);
  const m = decodeLive(senergyModel('hybrid'), h);
  assert.equal(m['Grid power'], 0);
  assert.equal(m['Load power'], 1679); // 3179 PV − 1500 charging
});

test('settings decode handles unknown codes and bad times', () => {
  const regs = new Map<number, number>([[0x2100, 9], [0x2102, 0xffff], [0x2103, 0x1700]]);
  const s = decodeSettings(SENERGY_SETTINGS, regs);
  assert.equal(s.work_mode, 'Unknown (9)');
  assert.equal(s.charge_start_time_1, undefined);
  assert.equal(s.charge_end_time_1, '23:00');
});

test('model names map to model ids', () => {
  assert.equal(modelFromName('PD-DH1P-3.6K-G1'), 'hybrid');
  assert.equal(modelFromName('SE 15KTL-G2P'), 'split');
  assert.equal(modelFromName('SE 10KHB-210-T/EU'), 'hybrid3');
  assert.equal(modelFromName('XYZ'), undefined);
});

test('detect accepts a Dura-i and reads the model', async () => {
  const r = await probe(duraMap());
  assert.ok(r);
  assert.equal(r.modelId, 'hybrid');
  assert.match(r.evidence, /DH6G3230400123/);
});

test('detect accepts a minimal identity image (serial only, grid down)', async () => {
  const h = new Map<number, number>();
  ascii(0x1a10, 'SE2304123456', h, 8);
  h.set(0x2000, 55);
  const r = await probe(h);
  assert.ok(r);
  assert.equal(r.modelId, undefined);
});

test('detect rejects blank, 0xFFFF, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);

  const ff = new Map<number, number>();
  for (let a = 0x1000; a < 0x1050; a++) ff.set(a, 0xffff);
  for (let a = 0x1a00; a < 0x1a48; a++) ff.set(a, 0xffff);
  ff.set(0x2000, 0xffff);
  assert.equal(await probe(ff), null);

  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(3, '2106123456', deye, 5);
  assert.equal(await probe(deye), null);

  const growatt = new Map<number, number>();
  ascii(9, 'RA1.0 ', growatt, 3);
  ascii(23, 'XYZ0123456', growatt, 5);
  assert.equal(await probe(growatt), null);

  // A serial but implausible SOC / grid readings.
  const bad = new Map<number, number>();
  ascii(0x1a10, 'SE2304123456', bad, 8);
  bad.set(0x2000, 250);
  assert.equal(await probe(bad), null);
  bad.set(0x2000, 50);
  bad.set(0x1001, 50);
  assert.equal(await probe(bad), null);
});
