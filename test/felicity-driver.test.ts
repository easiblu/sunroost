import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, felicity, felicityFamily } from '../src/devices/inverters/felicity/index.ts';
import { decodeInfo, decodeSerial } from '../src/devices/inverters/felicity/family.ts';
import { image, type RegisterImage } from '../src/devices/inverters/felicity/registers.ts';
import { ModbusConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const neg = (v: number) => (v + 0x10000) & 0xffff;
const ascii = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => (s.charCodeAt(i * 2) << 8) | s.charCodeAt(i * 2 + 1));

/** Zero-filled poll blocks for a family, overlaid with values. */
function frame(model: string, values: Record<number, number>): RegisterImage {
  const m: RegisterImage = new Map();
  for (const [start, count] of felicityFamily(model).blocks) image(start, new Array(count).fill(0), m);
  for (const [a, v] of Object.entries(values)) m.set(Number(a), v & 0xffff);
  return m;
}

/** IVEM5048 info block: type 0x50, subtype 0x0408, serial 01354820250001, firmware 1.03 / 2.05. */
function ivemInfo(into: Map<number, number>) {
  [0x50, 0x0408, 0, 0, 135, 4820, 2500, 100, 0, 0, 0, 103, 205].forEach((v, i) => into.set(0xf800 + i, v));
}

test('IVEM: discharging on battery with some PV (signed values, scaling)', () => {
  const r = decodeLive(felicityFamily('ivem'), frame('ivem', {
    0x1101: 3, 0x1103: 0, 0x1108: 5126, 0x1109: neg(-18), 0x110a: neg(-930),
    0x1111: 2301, 0x1117: 0, 0x1119: 0, 0x111e: 1450, 0x111f: 1620, 0x1120: 29,
    0x1126: 3105, 0x112a: 520,
  }));
  assert.equal(r['Device mode'], 'Battery');
  assert.equal(r['Battery voltage'], 51.26);
  assert.equal(r['Battery current'], -18);
  assert.equal(r['Battery power'], -930);
  assert.equal(r['AC output voltage'], 230.1);
  assert.equal(r['Load power'], 1450);
  assert.equal(r['Load apparent power'], 1620);
  assert.equal(r['Load percentage'], 29);
  assert.equal(r['PV voltage 1'], 310.5);
  assert.equal(r['PV power'], 520);
  assert.equal(r['PV power 1'], 520);
  assert.equal(r['PV current 1'], 1.7);
  assert.equal(r['Grid power'], 0, 'no grid draw on battery');
  assert.equal(r['Fault code'], 0);
  assert.equal(r['Charge stage'], undefined, 'intermediate values are not emitted');
});

test('IVEM: on line, grid power is derived from load + charging − PV', () => {
  const r = decodeLive(felicityFamily('ivem'), frame('ivem', {
    0x1101: 5, 0x1108: 5400, 0x1109: 20, 0x110a: 1080, 0x1117: 2352, 0x1119: 4998,
    0x111e: 800, 0x112a: 300,
  }));
  assert.equal(r['Device mode'], 'Line');
  assert.equal(r['Grid voltage'], 235.2);
  assert.equal(r['Grid frequency'], 49.98);
  assert.equal(r['AC output frequency'], 49.98);
  assert.equal(r['Grid power'], 1580);
  assert.equal(r['Battery power'], 1080);
});

test('T-REX LP: hybrid exporting while charging', () => {
  const r = decodeLive(felicityFamily('trex'), frame('trex', {
    0x1101: 5, 0x1109: 2318, 0x110b: 5001, 0x110c: neg(-640), 0x110d: 532, 0x110e: 375,
    0x110f: 2000, 0x1110: 815, 0x1111: 2300, 0x1113: 5000, 0x1114: 1200, 0x1115: 1300, 0x1116: 24,
    0x1117: 3800, 0x1118: 85, 0x1119: 3230, 0x111a: 3600, 0x111b: 17, 0x111c: 610, 0x114c: neg(-52),
  }));
  assert.equal(r['Device mode'], 'Line');
  assert.equal(r['Grid voltage'], 231.8);
  assert.equal(r['Grid frequency'], 50.01);
  assert.equal(r['Grid power'], -640);
  assert.equal(r['Battery voltage'], 53.2);
  assert.equal(r['Battery current'], 37.5);
  assert.equal(r['Battery power'], 2000);
  assert.equal(r['Battery state of charge'], 81.5);
  assert.equal(r['Load power'], 1200);
  assert.equal(r['PV power 1'], 3230);
  assert.equal(r['PV power'], 3840);
  assert.equal(r['PV current 2'], 1.7);
  assert.equal(r.Temperature, -5.2);
  assert.equal(r['AC output frequency'], 50);
});

test('IVGM / T-Rex HP: three-phase decode with 0.01 kW power registers', () => {
  const r = decodeLive(felicityFamily('hv3'), frame('hv3', {
    0x1100: 2, 0x1118: 4120, 0x111c: 92, 0x1128: 379, 0x1119: 3980, 0x111d: 80, 0x1129: 318,
    0x112c: 536, 0x1130: neg(-151), 0x1131: neg(-80), 0x1138: 642, 0x1145: 349,
    0x1150: 2301, 0x1151: 2312, 0x1152: 2323, 0x1153: 2300, 0x116d: 5000, 0x116e: 5001,
    0x1173: 120, 0x1174: neg(-30), 0x1175: 0, 0x1179: 250, 0x117a: 200, 0x117b: 180,
    0x117f: 12, 0x1180: 20, 0x1181: 9, 0x1193: 630, 0x1194: 90,
  }));
  assert.equal(r['Device mode'], 'Mode 2');
  assert.equal(r['PV voltage 1'], 412);
  assert.equal(r['PV current 1'], 9.2);
  assert.equal(r['PV power 1'], 3790);
  assert.equal(r['PV power 2'], 3180);
  assert.equal(r['PV power'], 6970);
  assert.equal(r['Battery voltage'], 53.6);
  assert.equal(r['Battery current'], -15.1);
  assert.equal(r['Battery power'], -800);
  assert.equal(r['Battery state of charge'], 64.2);
  assert.equal(r.Temperature, 34.9);
  assert.equal(r['Grid voltage'], 230.1);
  assert.equal(r['Grid voltage 3'], 232.3);
  assert.equal(r['AC output voltage'], 230);
  assert.equal(r['AC output frequency'], 50.01);
  assert.equal(r['Grid power 1'], 1200);
  assert.equal(r['Grid power 2'], -300);
  assert.equal(r['Grid power'], 900);
  assert.equal(r['Load power 1'], 2500);
  assert.equal(r['Load power'], 6300);
  assert.equal(r['Load percentage'], 20);
});

test('info: digit-word serial, firmware hundredths, model from subtype', () => {
  const regs = new Map<number, number>();
  ivemInfo(regs);
  const info = decodeInfo(felicityFamily('ivem'), regs);
  assert.equal(info['Serial number'], '01354820250001');
  assert.equal(info['Firmware version'], '1.03');
  assert.equal(info['Secondary firmware version'], '2.05');
  assert.equal(info['Model name'], 'Felicity IVEM5048');
  assert.equal(decodeSerial([0, 0, 0, 0, 0]), '');
  assert.equal(decodeSerial([0xffff, 0xffff, 0xffff, 0xffff, 0xffff]), '');
  assert.equal(decodeSerial([1234, 5678, 9012, 3456, 7890], 20), '12345678901234567890');
  const blank = decodeInfo(felicityFamily('trex'), new Map([[0xf80b, 0xffff]]));
  assert.deepEqual(blank, { 'Model name': 'Felicity T-REX LP hybrid (5–10 kW)' });
});

test('descriptor is read-only, all settings read-only, no SOC control', () => {
  assert.equal(felicity.id, 'felicity');
  assert.equal(felicity.readOnly, true);
  assert.equal(felicity.defaultBaudRate, 2400);
  assert.deepEqual(felicity.models?.map((m) => m.id), ['ivem', 'trex', 'hv3']);
  for (const m of ['ivem', 'trex', 'hv3']) {
    assert.equal(felicity.socControl?.(m), null);
    const d = felicity.create({ modelId: m, connection: '/dev/null', baudRate: 2400, address: 1, index: 0 });
    const defs = d.settingDefs();
    assert.ok(defs.length > 0);
    for (const s of defs) {
      assert.equal(s.readOnly, true, `${m} ${s.key}`);
      assert.equal((s as unknown as Record<string, unknown>).reg, undefined, 'register bookkeeping is stripped');
    }
  }
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

test('IVEM end to end: info, live read, settings, writes refused', async () => {
  const holding = new Map<number, number>();
  ivemInfo(holding);
  holding.set(0x1101, 6);
  holding.set(0x1108, 5310);
  holding.set(0x110a, 700);
  holding.set(0x112a, 900);
  holding.set(0x1126, 3500);
  holding.set(0x111e, 200);
  holding.set(0x212a, 2);
  holding.set(0x212c, 3);
  holding.set(0x212d, 3);
  holding.set(0x212e, 80);
  holding.set(0x211f, 440);
  holding.set(0x2159, 601);
  holding.set(0x2131, 1);
  await withLogger(holding, async (connection) => {
    const d = felicity.create({ modelId: 'ivem', connection, baudRate: 2400, address: 1, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Serial number'], '01354820250001');
      assert.equal(d.info()['Model name'], 'Felicity IVEM5048');
      const m = await d.read();
      assert.equal(m['Device mode'], 'PV charge');
      assert.equal(m['Battery voltage'], 53.1);
      assert.equal(m['Battery power'], 700);
      assert.equal(m['PV power'], 900);
      const s = await d.readSettings();
      assert.equal(s.output_source_priority, 'Solar/Battery/Utility');
      assert.equal(s.charger_source_priority, 'Solar only');
      assert.equal(s.battery_type, 'Lithium (LiFePO4)');
      assert.equal(s.max_charge_current, 80);
      assert.equal(s.shutdown_battery_voltage, 44);
      assert.equal(s.back_to_battery_voltage, 60.1);
      assert.equal(s.buzzer, true);
      assert.equal(s.overload_bypass, false);
      await assert.rejects(d.writeSetting('output_source_priority', 'Utility first'), /read-only/);
      await assert.rejects(d.rawWrite!(0x212a, [0]), /read-only/);
      await assert.rejects(d.rawRead!(4, 0x1100, 1), /function 3/);
      assert.deepEqual(await d.rawRead!(3, 0x212a, 1), [2]);
      assert.equal(holding.get(0x212a), 2, 'nothing was written');
    } finally {
      await d.close();
    }
  });
});

async function probe(holding: Map<number, number>) {
  let result: Awaited<ReturnType<NonNullable<typeof felicity.detect>>> = null;
  await withLogger(holding, async (connection) => {
    const sm = /solarman:\/\/([^:]+):(\d+)\/(\d+)/.exec(connection)!;
    const conn = new ModbusConnection({ type: 'solarman', host: sm[1], port: Number(sm[2]), loggerSerial: Number(sm[3]), address: 1, timeoutMs: 500 });
    await conn.connect();
    try {
      result = await felicity.detect!(conn);
    } finally {
      await conn.close();
    }
  });
  return result as Awaited<ReturnType<NonNullable<typeof felicity.detect>>>;
}

test('detect: accepts an IVEM and picks the model from the device type', async () => {
  const holding = new Map<number, number>();
  ivemInfo(holding);
  const r = await probe(holding);
  assert.ok(r);
  assert.equal(r.modelId, 'ivem');
  assert.match(r.evidence, /01354820250001/);
  assert.match(r.evidence, /subtype 0x0408/);
});

test('detect: an IVGM (type 0x54) maps to hv3; an unknown type is accepted without a model', async () => {
  const ivgm = new Map<number, number>([[0xf800, 0x54], [0xf801, 1052]]);
  [2501, 2309, 1200, 3400, 0].forEach((v, i) => ivgm.set(0xf804 + i, v));
  assert.equal((await probe(ivgm))?.modelId, 'hv3');
  ivgm.set(0xf800, 0x60);
  const r = await probe(ivgm);
  assert.ok(r);
  assert.equal(r.modelId, undefined);
});

test('detect: rejects a blank map, a 0xFFFF map and a Deye-like or Growatt-like map', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let i = 0; i < 13; i++) ff.set(0xf800 + i, 0xffff);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>([[0, 3]]);
  ascii('2106123456').forEach((v, i) => deye.set(3 + i, v));
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  ascii('RA1.0 ').forEach((v, i) => growatt.set(9 + i, v));
  ascii('XYZ0123456').forEach((v, i) => growatt.set(23 + i, v));
  assert.equal(await probe(growatt), null);
  // A type code with an all-zero serial is not enough.
  assert.equal(await probe(new Map([[0xf800, 0x50]])), null);
  // ASCII text where the serial words should be is not a Felicity serial.
  const textual = new Map<number, number>([[0xf800, 0x50]]);
  ascii('ABCDEFGHIJ').forEach((v, i) => textual.set(0xf804 + i, v));
  assert.equal(await probe(textual), null);
});
