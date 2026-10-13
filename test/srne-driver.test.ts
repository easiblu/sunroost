import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, srne, srneModel } from '../src/devices/inverters/srne/index.ts';
import { image, type RegisterImage } from '../src/devices/inverters/srne/registers.ts';
import { decodeSettings, SRNE_SETTINGS } from '../src/devices/inverters/srne/settings.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;

function ascii(start: number, s: string, into: Map<number, number>, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}

const s16 = (v: number) => v & 0xffff;

/** A single-phase HESP hybrid: exporting while charging. */
function hespMap() {
  const h = new Map<number, number>();
  h.set(0x000a, 0x3064);
  h.set(0x000b, 3);
  ascii(0x000c, 'HESP4850S100-H', h, 8);
  h.set(0x0014, 0x0105); // 1.05
  h.set(0x0015, 0x0203); // 2.03
  ascii(0x0035, 'SR2304123456789', h, 20);
  Object.entries({
    0x0100: 76, 0x0101: 528, 0x0102: 250, 0x0103: 0x0019, 0x0107: 3800, 0x0108: 85, 0x0109: 3230,
    0x010b: 1, 0x010f: 3650, 0x0110: 40, 0x0111: 1460,
    0x0200: 0, 0x0201: 0, 0x0202: 0, 0x0203: 0, 0x0210: 4, 0x0212: 3950, 0x0213: 2312, 0x0214: 52,
    0x0215: 5001, 0x0216: 2300, 0x0217: 70, 0x0218: 5000, 0x0219: 75, 0x021b: 1600, 0x021c: 1750,
    0x021f: 32, 0x0220: 452, 0x0221: s16(-55), 0x0222: 380,
    0xe002: 200, 0xe003: 48, 0xe004: 4, 0xe008: 144, 0xe009: 568, 0xe00d: 440, 0xe204: 2, 0xe205: 300,
    0xe208: 2300, 0xe209: 5000, 0xe20a: 1000, 0xe20f: 3, 0xe210: 1,
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
      return await srne.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor is read-only with srne id', () => {
  assert.equal(srne.id, 'srne');
  assert.equal(srne.readOnly, true);
  assert.equal(srne.defaultBaudRate, 9600);
  assert.equal(srne.socControl?.('hybrid'), null);
  const d = srne.create({ modelId: 'hybrid', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  assert.ok(d.settingDefs().length > 5);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('hybrid over a logger: info, live decode and settings', async () => {
  await withLogger(hespMap(), async (connection) => {
    const d = srne.create({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Model name'], 'HESP4850S100-H');
      assert.equal(info['Serial number'], 'SR2304123456789');
      assert.equal(info['Firmware version'], '1.05');
      assert.equal(info['Secondary firmware version'], '2.03');

      const r = await d.read();
      assert.equal(r['Battery state of charge'], 76);
      assert.equal(r['Battery voltage'], 52.8);
      assert.equal(r['Battery current'], 25);
      assert.equal(r['Battery power'], 1320);
      assert.equal(r['Battery temperature'], 25);
      assert.equal(r['PV voltage 1'], 380);
      assert.equal(r['PV current 1'], 8.5);
      assert.equal(r['PV power 1'], 3230);
      assert.equal(r['PV power 2'], 1460);
      assert.equal(r['PV power'], 4690);
      assert.equal(r['Device mode'], 'Grid');
      assert.equal(r['Grid voltage'], 231.2);
      assert.equal(r['Grid frequency'], 50.01);
      assert.equal(r['AC output voltage'], 230);
      assert.equal(r['AC output frequency'], 50);
      assert.equal(r['Load power'], 1600);
      assert.equal(r['Load apparent power'], 1750);
      assert.equal(r['Load percentage'], 32);
      assert.equal(r['Grid power'], 1600 + 1320 - 4690, 'hybrid exports: negative grid power');
      assert.equal(r['Temperature AC'], -5.5, 'signed temperature');
      assert.equal(r.Temperature, 45.2);
      assert.equal(r['Fault code'], 'None');
      assert.equal(r['Bus voltage'], 395);

      const s = await d.readSettings();
      assert.equal(s.output_source_priority, 'Solar/Battery/Utility');
      assert.equal(s.charger_source_priority, 'Solar only');
      assert.equal(s.battery_type, 'Lithium (LFP)');
      assert.equal(s.battery_capacity, 200);
      assert.equal(s.battery_absorption_charge_voltage, 57.6, '12 V basis scaled to 48 V');
      assert.equal(s.battery_float_charge_voltage, 56.8);
      assert.equal(s.shutdown_battery_voltage, 44);
      assert.equal(s.max_grid_charge_current, 30);
      assert.equal(s.max_charge_current, 100);
      assert.equal(s.ac_output_voltage, 230);
      assert.equal(s.ac_output_frequency, 50);
      assert.equal(s.buzzer, true);

      await assert.rejects(d.writeSetting('output_source_priority', 'Solar first'), /read-only/);
      await assert.rejects(d.rawWrite!(0xe204, [0]), /read-only/);
      assert.deepEqual(await d.rawRead!(3, 0x0100, 2), [76, 528]);
    } finally {
      await d.close();
    }
  });
});

test('off-grid: discharging on battery, grid down, faults, never negative grid', () => {
  const regs: RegisterImage = new Map();
  image(0x0100, new Array(0x12).fill(0), regs);
  image(0x0200, new Array(0x25).fill(0), regs);
  for (const [a, v] of Object.entries({
    0x0100: 55, 0x0101: 255, 0x0102: s16(-420), 0x0107: 0, 0x0109: 0, 0x0200: 0, 0x0201: 23,
    0x0210: 5, 0x0213: 0, 0x0216: 2201, 0x0218: 6000, 0x021b: 1050, 0x021c: 1200, 0x021f: 35,
    0x0220: 400, 0x0221: 410,
  })) regs.set(Number(a), v);
  const r = decodeLive(srneModel('offgrid'), regs);
  assert.equal(r['Battery voltage'], 25.5);
  assert.equal(r['Battery current'], -42);
  assert.equal(r['Battery power'], -1071);
  assert.equal(r['Device mode'], 'Inverter');
  assert.equal(r['Grid power'], 0);
  assert.equal(r['PV power'], 0);
  assert.equal(r['PV power 2'], undefined, 'single MPPT off-grid has no PV2');
  assert.equal(r['AC output frequency'], 60);
  assert.equal(r['Fault code'], '23');
  assert.equal(r.Temperature, 41);
});

test('off-grid in bypass: grid carries load and charging', () => {
  const regs: RegisterImage = new Map();
  image(0x0100, new Array(0x12).fill(0), regs);
  image(0x0200, new Array(0x25).fill(0), regs);
  for (const [a, v] of Object.entries({ 0x0101: 520, 0x0102: 200, 0x0210: 4, 0x0213: 2290, 0x021b: 800, 0x0109: 300 })) {
    regs.set(Number(a), v);
  }
  const r = decodeLive(srneModel('offgrid'), regs);
  assert.equal(r['Battery power'], 1040);
  assert.equal(r['Grid power'], 800 + 1040 - 300);
});

test('split-phase: per-phase metrics and totals', () => {
  const regs: RegisterImage = new Map();
  image(0x0100, new Array(0x12).fill(0), regs);
  image(0x0200, new Array(0x32).fill(0), regs);
  for (const [a, v] of Object.entries({
    0x0101: 520, 0x0213: 1201, 0x0216: 1200, 0x021b: 900, 0x021c: 1000, 0x021f: 20,
    0x022a: 1199, 0x022c: 1202, 0x022f: 700, 0x0230: 760, 0x0231: 25,
  })) regs.set(Number(a), v);
  const r = decodeLive(srneModel('hybrid-split'), regs);
  assert.equal(r['Grid voltage 1'], 120.1);
  assert.equal(r['Grid voltage 2'], 119.9);
  assert.equal(r['AC output voltage 2'], 120.2);
  assert.equal(r['Load power 1'], 900);
  assert.equal(r['Load power 2'], 700);
  assert.equal(r['Load power'], 1600);
  assert.equal(r['Load apparent power'], 1760);
  assert.equal(r['Load percentage'], 25);
  assert.equal(r['Grid voltage'], 120.1);
});

test('settings: 0.1 V values already on a 48 V basis are not scaled', () => {
  const regs: RegisterImage = new Map([[0xe003, 48], [0xe009, 552], [0xe004, 9]]);
  const s = decodeSettings(SRNE_SETTINGS, regs);
  assert.equal(s.battery_float_charge_voltage, 55.2);
  assert.equal(s.battery_type, 'Unknown (9)');
});

test('detect accepts an SRNE hybrid and names the model', async () => {
  const r = await probe(hespMap());
  assert.ok(r);
  assert.equal(r.modelId, 'hybrid');
  assert.match(r.evidence, /HESP4850S100-H/);
  assert.match(r.evidence, /SR2304123456789/);
});

test('detect: off-grid model name maps to offgrid', async () => {
  const h = hespMap();
  ascii(0x000c, 'ASP48100U200-H', h, 8);
  const r = await probe(h);
  assert.equal(r?.modelId, 'offgrid');
});

test('detect rejects a blank map and a 0xFFFF-filled map', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 0; a < 0x60; a++) ff.set(a, 0xffff);
  for (let a = 0x100; a < 0x103; a++) ff.set(a, 0xffff);
  assert.equal(await probe(ff), null);
});

test('detect rejects a Deye-like and a Growatt-like map', async () => {
  const deye = new Map<number, number>([[0, 3], [0x100, 0]]);
  ascii(3, 'AB12345678', deye, 5);
  assert.equal(await probe(deye), null);

  const growatt = new Map<number, number>([[0, 1], [1, 0]]);
  ascii(9, 'RAAA', growatt, 3);
  ascii(12, 'ZBAA01', growatt, 3);
  ascii(23, 'JPC1234567', growatt, 5);
  assert.equal(await probe(growatt), null);
});
