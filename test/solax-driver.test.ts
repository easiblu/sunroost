import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { sunsynk } from '../src/devices/inverters/deye/index.ts';
import { decodeInfo, decodeLive, SolaxDriver, solax, solaxModel } from '../src/devices/inverters/solax/index.ts';
import type { RegisterImage } from '../src/devices/inverters/solax/registers.ts';
import { decodeSettings, SOLAX_SETTINGS } from '../src/devices/inverters/solax/settings.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;
const s16 = (v: number) => v & 0xffff;
/** s32 low word first. */
const s32 = (v: number) => {
  const u = v < 0 ? v + 0x100000000 : v;
  return [u & 0xffff, Math.floor(u / 0x10000) & 0xffff];
};
const ascii = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => (s.charCodeAt(i * 2) << 8) | (s.charCodeAt(i * 2 + 1) || 0));
const put = (m: Map<number, number>, at: number, words: number[]) => words.forEach((w, i) => m.set(at + i, w));

function identity(h: Map<number, number>, serial = 'H450A2I1234567', factory = 'SolaX', module = 'X1-Hybrid-G4') {
  put(h, 0, ascii(serial.padEnd(14, '\0')));
  put(h, 7, ascii(factory.padEnd(14, '\0')));
  put(h, 14, ascii(module.padEnd(14, '\0')));
}

/** X1-Hybrid G4: PV 3.2 kW, charging 1.2 kW, exporting 600 W. */
function x1() {
  const holding = new Map<number, number>();
  const input = new Map<number, number>();
  identity(holding);
  holding.set(0x7d, 120);
  holding.set(0x83, 145);
  put(holding, 0x1f, [0, 1]);
  put(holding, 0x24, [250, 300]);
  holding.set(0x42, 4000);
  holding.set(0x61, 20);
  holding.set(0x65, 30);
  put(input, 0x00, [2398, 85, 2000, 3800, 3500, 52, 35, 5002, 41, 2, 1976, 1225]);
  put(input, 0x14, [s16(532), s16(225), s16(1200), 1, 22, 0, 0, 0, 78]);
  put(input, 0x40, [0, 0, 0, 0]);
  put(input, 0x46, s32(600));
  put(input, 0x4c, [2300, 10, 230, 5000]);
  return { holding, input };
}

async function withLogger<T>(maps: { holding: Map<number, number>; input?: Map<number, number> }, fn: (c: string) => Promise<T>) {
  const server = fakeLogger({ serial: LOGGER, holding: maps.holding, input: maps.input });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/${LOGGER}`);
  } finally {
    server.close();
  }
}

async function probe(holding: Map<number, number>, input = new Map<number, number>(), d = solax) {
  return withLogger({ holding, input }, async (c) => {
    const conn = new ModbusConnection({ ...parseConnection(c, 19200, 1), timeoutMs: 500 });
    await conn.connect();
    try {
      return await d.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('decodes an X1-Hybrid G4 live block (scaling, signed, 32-bit low word first)', () => {
  const { input } = x1();
  const m = decodeLive(solaxModel('x1_hybrid'), input as RegisterImage);
  assert.equal(m['Grid voltage'], 239.8);
  assert.equal(m['Grid frequency'], 50.02);
  assert.equal(m['PV voltage 1'], 380);
  assert.equal(m['PV current 1'], 5.2);
  assert.equal(m['PV current 2'], 3.5);
  assert.equal(m['PV power'], 3201);
  assert.equal(m['Battery voltage'], 53.2);
  assert.equal(m['Battery current'], 22.5);
  assert.equal(m['Battery power'], 1200);
  assert.equal(m['Battery state of charge'], 78);
  assert.equal(m['Battery temperature'], 22);
  assert.equal(m['Temperature'], 41);
  assert.equal(m['Device mode'], 'Normal');
  assert.equal(m['Grid power'], -600);
  assert.equal(m['Load power'], 1400);
  assert.equal(m['AC output voltage'], 230);
  assert.equal(m['Fault code'], 'None');
});

test('negative battery power, grid import and fault bits', () => {
  const { input } = x1();
  put(input, 0x14, [s16(510), s16(-300), s16(-1530)]);
  put(input, 0x46, s32(-2500));
  put(input, 0x40, [0x0004, 0x0001]);
  const m = decodeLive(solaxModel('x1_hybrid'), input as RegisterImage);
  assert.equal(m['Battery current'], -30);
  assert.equal(m['Battery power'], -1530);
  assert.equal(m['Grid power'], 2500);
  assert.equal(m['Load power'], 4500);
  assert.equal(m['Fault code'], 'Inverter 0x00010004');
});

test('X3 per-phase values', () => {
  const { input } = x1();
  for (const p of [0, 1, 2]) put(input, 0x6a + p * 4, [2300 + p, s16(30), s16(1000 + p * 100), 5000]);
  put(input, 0x82, [...s32(200), ...s32(-100), ...s32(0)]);
  put(input, 0x46, s32(100));
  const m = decodeLive(solaxModel('x3_hybrid'), input as RegisterImage);
  assert.equal(m['Grid voltage 2'], 230.1);
  assert.equal(m['Grid voltage'], 230);
  assert.equal(m['Inverter power'], 3300);
  assert.equal(m['Grid power'], -100);
  assert.equal(m['Load power'], 3200);
  assert.equal(m['Load power 1'], 800);
  assert.equal(m['Grid power 2'], 100);
});

test('info: serial, module name, firmware', () => {
  const { holding } = x1();
  const i = decodeInfo(solaxModel('x1_hybrid'), holding);
  assert.equal(i['Serial number'], 'H450A2I1234567');
  assert.equal(i['Model name'], 'Solax X1-Hybrid-G4');
  assert.equal(i['Firmware version'], '1.20');
  assert.equal(i['Secondary firmware version'], '1.45');
});

test('settings decode, all read-only', () => {
  const { holding } = x1();
  const v = decodeSettings(SOLAX_SETTINGS, holding);
  assert.equal(v.work_mode, 'Self use');
  assert.equal(v.manual_mode, 'Force charge');
  assert.equal(v.max_charge_current, 25);
  assert.equal(v.export_limit, 4000);
  assert.equal(v.self_use_minimum_soc, 20);
  assert.ok(SOLAX_SETTINGS.every((s) => s.readOnly));
  assert.equal(solax.readOnly, true);
});

test('driver end to end over a logger, writes refused', async () => {
  const maps = x1();
  await withLogger(maps, async (c) => {
    const d = new SolaxDriver({ modelId: 'x1_hybrid', connection: c, baudRate: 19200, address: 1, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Serial number'], 'H450A2I1234567');
      const m = await d.read();
      assert.equal(m['Grid power'], -600);
      const s = await d.readSettings();
      assert.equal(s.work_mode, 'Self use');
      assert.deepEqual(await d.rawRead(4, 0x1c, 1), [78]);
      await assert.rejects(d.writeSetting('work_mode', 'Manual'), /read-only/);
      await assert.rejects(d.rawWrite(0x1f, [3]), /read-only/);
      assert.equal(maps.holding.get(0x1f), 0);
    } finally {
      await d.close();
    }
  });
});

test('detect accepts Solax and picks the model', async () => {
  const a = await probe(x1().holding);
  assert.equal(a?.modelId, 'x1_hybrid');
  const h3 = new Map<number, number>();
  identity(h3, 'H34A10I1234567', 'SolaX', 'X3-Hybrid-G4');
  assert.equal((await probe(h3))?.modelId, 'x3_hybrid');
  const lite = new Map<number, number>();
  identity(lite, 'XL1080LV123456', 'SolaX', 'X1-Lite-LV');
  assert.equal((await probe(lite))?.modelId, 'x1_lite_lv');
  // Factory name only (blank module name) still passes.
  const bare = new Map<number, number>();
  identity(bare, 'H450A2I1234567', 'SolaX', '');
  assert.ok(await probe(bare));
});

test('detect rejects blank, 0xFFFF, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let i = 0; i < 21; i++) ff.set(i, 0xffff);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>([[0, 3]]);
  put(deye, 3, ascii('2106123456'));
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  put(growatt, 9, ascii('RA1.0 '));
  put(growatt, 23, ascii('XYZ0123456'));
  assert.equal(await probe(growatt), null);
  // Serial alone (no Solax factory/module name) is not enough.
  const anon = new Map<number, number>();
  identity(anon, 'AB12345678CDEF', '', '');
  assert.equal(await probe(anon), null);
});

test("Deye's probe does not claim a Solax unit", async () => {
  assert.equal(await probe(x1().holding, new Map(), sunsynk), null);
});

/** Copies of the identity images in test/inverter-detect-cross.test.ts (that file is not ours to edit). */
const OTHERS: Record<string, [Map<number, number>, Map<number, number>]> = (() => {
  const mk = (f: (h: Map<number, number>, i: Map<number, number>) => void): [Map<number, number>, Map<number, number>] => {
    const h = new Map<number, number>();
    const i = new Map<number, number>();
    f(h, i);
    return [h, i];
  };
  return {
    sunsynk: mk((h) => { h.set(0, 3); put(h, 3, ascii('2106123456')); }),
    growatt: mk((h) => { put(h, 9, ascii('RA1.0 ')); put(h, 23, ascii('XYZ0123456')); }),
    srne: mk((h) => { put(h, 0x0c, ascii('HESP4860S100-H  ')); put(h, 0x35, ascii('SR2209123456')); put(h, 0x100, [80, 520, 0]); }),
    sumry: mk((h) => { put(h, 186, ascii('SM2304120001')); h.set(201, 3); }),
    luxpower: mk((h) => { put(h, 2, ascii('BA12345678')); put(h, 7, ascii('FAAB')); put(h, 115, ascii('BA12345678')); }),
    must: mk((h) => { put(h, 20000, [ascii('PH')[0], 1800, 0x0012, 0xd687, 0, 0x0101]); h.set(25201, 2); }),
    megarevo: mk((h) => { put(h, 0x1215, [10001, 10002]); put(h, 0x121c, ascii('R6KL1')); put(h, 0x1234, ascii('MR2023001234')); }),
    victron: mk((h) => { put(h, 800, ascii('c0619ab1e2f3')); put(h, 840, [532, 0, 0, 76]); }),
    sigenergy: mk((_h, i) => { put(i, 30500, ascii('SigenStor EC 10.0 TP')); put(i, 30515, ascii('110A12345678AB')); i.set(30014, 650); }),
    solis: mk((_h, i) => { i.set(33000, 0x3105); put(i, 33004, ascii('1031110215040123')); }),
    sungrow: mk((_h, i) => { put(i, 4989, ascii('A2210123456')); i.set(4999, 0x0e03); i.set(5000, 100); }),
    huawei: mk((h) => { put(h, 30000, ascii('SUN2000-5KTL-L1')); }),
    goodwe: mk((h) => { put(h, 35003, ascii('9010KETU123A4567')); put(h, 35011, ascii('GW10K-ET')); }),
    felicity: mk((h) => { put(h, 0xf800, [0x50, 0x0102, 0, 0]); put(h, 0xf804, [1234, 5678, 9012, 3400, 0]); }),
  };
})();

test('detect rejects every other brand identity image', async (t) => {
  for (const [brand, [h, i]] of Object.entries(OTHERS)) {
    const r = await probe(h, i);
    await t.test(brand, () => assert.equal(r, null, `claimed ${brand}: ${r?.evidence}`));
  }
});

test('minimal cross-check identity image is accepted', async () => {
  const h = new Map<number, number>();
  put(h, 0, ascii('H450A2I1234567'));
  put(h, 7, ascii('SolaX'));
  assert.ok(await probe(h));
});
