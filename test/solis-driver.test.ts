import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, decodeSerial, solis, solisModel } from '../src/devices/inverters/solis/index.ts';
import { image, type RegisterImage } from '../src/devices/inverters/solis/registers.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;
const s16 = (v: number) => v & 0xffff;
const u32 = (v: number) => [(v >>> 16) & 0xffff, v & 0xffff];
const s32 = (v: number) => u32(v >>> 0);
const ascii = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => (s.charCodeAt(i * 2) << 8) | (s.charCodeAt(i * 2 + 1) || 0));
const put = (m: Map<number, number>, at: number, words: number[]) => words.forEach((w, i) => m.set(at + i, w));

/** A single-phase S6 hybrid: PV 4.2 kW, charging 1.5 kW, exporting 900 W. */
function hybridInput() {
  const i = new Map<number, number>();
  put(i, 33000, [0x3105, 0x0042, 0x0033, 0x0101]);
  put(i, 33004, Array.from('1031110215040123', (c) => c.charCodeAt(0))); // one char per register
  put(i, 33029, u32(12345));
  i.set(33035, 182);
  put(i, 33049, [3800, 60, 3500, 55, 0, 0, 0, 0]);
  put(i, 33057, u32(4205));
  i.set(33071, 3950);
  put(i, 33073, [2312, 0, 0, 78, 0, 0]);
  put(i, 33079, s32(1800));
  put(i, 33083, s32(1850));
  i.set(33093, 452);
  i.set(33094, 5001);
  i.set(33095, 3);
  put(i, 33130, s32(900)); // meter + export
  put(i, 33133, [528, 284, 0, 0, 2301, 0, 76, 98, 5280, 284, 1000, 1000]);
  i.set(33147, 1300);
  i.set(33148, 200);
  put(i, 33149, s32(1500));
  put(i, 33161, u32(800)); i.set(33163, 55);
  put(i, 33165, u32(700)); i.set(33167, 41);
  put(i, 33169, u32(2500)); i.set(33171, 12);
  put(i, 33173, u32(3100)); i.set(33175, 98);
  return i;
}

function hybridHolding() {
  const h = new Map<number, number>();
  h.set(43011, 20);
  h.set(43018, 10);
  h.set(43024, 30);
  h.set(43110, 0b100011); // self-use + time-of-use + grid charge
  h.set(43117, 1000);
  h.set(43118, 1200);
  h.set(43141, 500);
  h.set(43142, 600);
  put(h, 43143, [2, 0, 5, 30, 17, 0, 21, 0]);
  return h;
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
      return await solis.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor is read-only with solis id', () => {
  assert.equal(solis.id, 'solis');
  assert.equal(solis.readOnly, true);
  assert.equal(solis.transport, 'serial');
  assert.equal(solis.defaultBaudRate, 9600);
  assert.equal(solis.defaultAddress, 1);
  assert.equal(solis.socControl?.('hybrid'), null);
  assert.equal(solis.protectionSetting?.('hybrid'), null);
  assert.deepEqual(solis.models?.map((m) => m.id), ['hybrid', 'hybrid3', 'string', 'string3']);
  const d = solis.create({ modelId: 'hybrid', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length > 5);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('serial decodings', () => {
  assert.equal(decodeSerial(Array.from('1031110215040123', (c) => c.charCodeAt(0))), '1031110215040123');
  assert.equal(decodeSerial([...ascii('110F31221090012'), 0, 0, 0, 0, 0, 0, 0, 0]), '110F31221090012');
  assert.equal(decodeSerial([0x1031, 0x1102, 0x1504, 0x0123, ...new Array(12).fill(0)]), '1031110215040123');
  assert.equal(decodeSerial(new Array(16).fill(0)), '');
  assert.equal(decodeSerial(new Array(16).fill(0xffff)), '');
});

test('hybrid over a logger: info, live decode, settings, writes refused', async () => {
  await withLogger({ input: hybridInput(), holding: hybridHolding() }, async (connection) => {
    const d = solis.create({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], '1031110215040123');
      assert.equal(info['Firmware version'], '0042');
      assert.equal(info['Secondary firmware version'], '0033');
      assert.equal(info['Model code'], '3105');
      assert.match(String(info['Model name']), /^Solis Hybrid single-phase/);

      const r = await d.read();
      assert.equal(r['PV voltage 1'], 380);
      assert.equal(r['PV current 1'], 6);
      assert.equal(r['PV power 1'], 2280);
      assert.equal(r['PV power 2'], 1925);
      assert.equal(r['PV power 3'], undefined, 'unused string skipped');
      assert.equal(r['PV power'], 4205);
      assert.equal(r['PV energy total'], 12345, 'u32');
      assert.equal(r['PV energy today'], 18.2);
      assert.equal(r['Grid voltage'], 231.2);
      assert.equal(r['Grid current'], 7.8);
      assert.equal(r['Grid frequency'], 50.01);
      assert.equal(r['Grid power'], -900, 'exporting: negative grid power');
      assert.equal(r['Inverter power'], 1800);
      assert.equal(r['Battery voltage'], 52.8);
      assert.equal(r['Battery current'], 28.4);
      assert.equal(r['Battery power'], 1500, '+ = charging');
      assert.equal(r['Battery state of charge'], 76);
      assert.equal(r['Battery state of health'], 98);
      assert.equal(r['AC output voltage'], 230.1);
      assert.equal(r['Load power'], 1500);
      assert.equal(r['Temperature'], 45.2);
      assert.equal(r['Device mode'], 'Generating');
      assert.equal(r['Fault code'], 'None');
      assert.equal(r['Charge energy today'], 5.5);
      assert.equal(r['Export energy total'], 3100);
      assert.equal(r['Import energy today'], 1.2);

      const s = await d.readSettings();
      assert.equal(s.energy_storage_mode, 'Self-use');
      assert.equal(s.time_of_use, true);
      assert.equal(s.grid_charging, true);
      assert.equal(s.overdischarge_soc, 20);
      assert.equal(s.force_charge_soc, 10);
      assert.equal(s.backup_soc, 30);
      assert.equal(s.max_charge_current, 100);
      assert.equal(s.max_discharge_current, 120);
      assert.equal(s.time_charge_current, 50);
      assert.equal(s.charge_slot_1, '02:00,05:30,true');
      assert.equal(s.discharge_slot_1, '17:00,21:00,true');

      await assert.rejects(d.writeSetting('energy_storage_mode', 'Feed-in priority'), /read-only/);
      await assert.rejects(d.rawWrite!(43110, [1]), /read-only/);
      assert.deepEqual(await d.rawRead!(4, 33133, 2), [528, 284]);
      await assert.rejects(d.rawRead!(1, 0, 1), /Unsupported/);
    } finally {
      await d.close();
    }
  });
});

test('three-phase hybrid: discharging, faults, per-phase meter, signed values', () => {
  const regs: RegisterImage = new Map();
  image(33022, new Array(74).fill(0), regs);
  image(33116, new Array(65).fill(0), regs);
  image(33250, new Array(33).fill(0), regs);
  put(regs, 33073, [2301, 2295, 2310, 105, 98, 110]);
  put(regs, 33079, s32(-500));
  regs.set(33093, s16(-55));
  regs.set(33095, 0x1015);
  regs.set(33116, 0x0004);
  put(regs, 33130, s32(-2400)); // importing
  put(regs, 33133, [4200, 120, 1]); // HV battery 420 V, 12 A discharging
  regs.set(33139, 55);
  regs.set(33147, 7000);
  put(regs, 33149, s32(5040));
  put(regs, 33257, [...s32(-800), ...s32(-900), ...s32(-700)]);
  const r = decodeLive(solisModel('hybrid3'), regs);
  assert.equal(r['Grid voltage 1'], 230.1);
  assert.equal(r['Grid voltage 2'], 229.5);
  assert.equal(r['Grid voltage 3'], 231);
  assert.equal(r['Grid current 3'], 11);
  assert.equal(r['Grid power 1'], 800);
  assert.equal(r['Grid power 2'], 900);
  assert.equal(r['Grid power'], 2400);
  assert.equal(r['Inverter power'], -500, 's32 negative');
  assert.equal(r['Temperature'], -5.5, 's16 negative');
  assert.equal(r['Battery voltage'], 420);
  assert.equal(r['Battery current'], -12);
  assert.equal(r['Battery power'], -5040);
  assert.equal(r['Device mode'], 'Fault');
  assert.equal(r['Fault code'], 'F1:0x0004');
  assert.equal(r['PV power'], 0);
});

test('string inverter: no battery metrics or settings', async () => {
  const input = hybridInput();
  for (let a = 33133; a <= 33180; a++) input.delete(a);
  await withLogger({ input }, async (connection) => {
    const d = solis.create({ modelId: 'string', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const r = await d.read();
      assert.equal(r['Battery voltage'], undefined);
      assert.equal(r['Battery power'], undefined);
      assert.equal(r['PV power'], 4205);
      assert.equal(r['Grid power'], -900);
      assert.equal(r['Load power'], 900, 'generation 1800 − export 900');
      assert.deepEqual(d.settingDefs(), []);
      assert.deepEqual(await d.readSettings(), {});
    } finally {
      await d.close();
    }
  });
});

test('detect: accepts a Solis hybrid and picks the model', async () => {
  const r = await probe({ input: hybridInput() });
  assert.ok(r);
  assert.equal(r.modelId, 'hybrid');
  assert.match(r.evidence, /serial 1031110215040123/);
  assert.match(r.evidence, /model code 0x3105/);

  const three = hybridInput();
  put(three, 33074, [2300, 2305]);
  assert.equal((await probe({ input: three }))?.modelId, 'hybrid3');

  const str = hybridInput();
  for (let a = 33133; a <= 33140; a++) str.delete(a);
  assert.equal((await probe({ input: str }))?.modelId, 'string');
});

test('detect: minimal identity image (model code + serial only)', async () => {
  const input = new Map<number, number>();
  input.set(33000, 0x3105);
  put(input, 33004, ascii('1031110215040123'));
  const r = await probe({ input });
  assert.ok(r);
  assert.equal(r.modelId, undefined);
});

test('detect: rejects blank, 0xFFFF, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe({}), null, 'blank');
  const ff = new Map<number, number>();
  for (let a = 33000; a < 33200; a++) ff.set(a, 0xffff);
  assert.equal(await probe({ input: ff, holding: ff }), null, '0xFFFF');
  const noModel = hybridInput();
  noModel.set(33000, 0);
  assert.equal(await probe({ input: noModel }), null, 'zero model code');
  const noSerial = hybridInput();
  for (let a = 33004; a < 33020; a++) noSerial.set(a, 0);
  assert.equal(await probe({ input: noSerial }), null, 'no serial');

  const deye = new Map<number, number>();
  deye.set(0, 3);
  put(deye, 3, ascii('2106123456'));
  assert.equal(await probe({ holding: deye }), null, 'Deye');

  const growatt = new Map<number, number>();
  put(growatt, 9, ascii('RA1.0 '));
  put(growatt, 23, ascii('XYZ0123456'));
  assert.equal(await probe({ holding: growatt, input: new Map(growatt) }), null, 'Growatt');

  const badVolts = hybridInput();
  badVolts.set(33073, 0x7fff);
  assert.equal(await probe({ input: badVolts }), null, 'implausible voltage');
});
