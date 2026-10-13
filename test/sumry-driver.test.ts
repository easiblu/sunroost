import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { image, type RegisterImage } from '../src/devices/inverters/growatt/registers.ts';
import { decodeLive, decodeRange, serialFrom, sumry, sumryDrivers, sumryFamily } from '../src/devices/inverters/sumry/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const ascii = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => (s.charCodeAt(i * 2) << 8) | (s.charCodeAt(i * 2 + 1) || 0));
const s16 = (v: number) => v & 0xffff;

function frame(model: string, values: Record<number, number>): RegisterImage {
  const m: RegisterImage = new Map();
  for (const [start, count] of sumryFamily(model).liveBlocks) image(start, new Array(count).fill(0), m);
  for (const [a, v] of Object.entries(values)) m.set(Number(a), v & 0xffff);
  return m;
}

/** A classic SMG-II unit: off-grid, PV charging while discharging into a load. */
function smgHolding(): Map<number, number> {
  const h = new Map<number, number>();
  ascii('SM2207123456').forEach((v, i) => h.set(186 + i, v));
  const set = (a: number, v: number) => h.set(a, v & 0xffff);
  set(100, 0); set(101, 0x0004); set(201, 3); set(202, 2312); set(203, 4998); set(204, 0);
  set(210, 2301); set(211, 87); set(212, 5000); set(213, 1850); set(214, 1990);
  set(215, 512); set(216, -123); set(217, -630); set(219, 3405); set(220, 36); set(223, 1220);
  set(225, 31); set(226, 38); set(227, 45); set(229, 67);
  set(301, 2); set(322, 8); set(324, 564); set(325, 540); set(331, 1); set(332, 600); set(333, 300);
  set(341, 20); set(342, 80); set(343, 10); set(303, 3); set(305, 1); set(643, 6200);
  return h;
}

async function withLogger<T>(holding: Map<number, number>, fn: (connection: string) => Promise<T>): Promise<T> {
  const server = fakeLogger({ serial: 7, holding });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/7`);
  } finally {
    server.close();
  }
}

async function probe(holding: Map<number, number>) {
  return withLogger(holding, async (connection) => {
    const conn = new ModbusConnection({ ...parseConnection(connection, 9600, 1), timeoutMs: 500 });
    await conn.connect();
    try {
      return await sumry.detect!(conn);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: id, read-only, models, console', () => {
  assert.equal(sumryDrivers[0], sumry);
  assert.equal(sumry.id, 'sumry');
  assert.equal(sumry.readOnly, true);
  assert.equal(sumry.defaultBaudRate, 9600);
  assert.deepEqual(sumry.models!.map((m) => m.id), ['smg', 'smg_ext']);
  assert.equal(sumry.socControl!('smg'), null);
  assert.ok(sumry.consoleFunctions!.some((f) => f.id === '3'));
  for (const m of ['smg', 'smg_ext']) {
    for (const d of sumryFamily(m).settings) assert.equal(d.readOnly, true, `${m} ${d.key}`);
  }
});

test('smg: decodes scaling and signed battery values', () => {
  const r = decodeLive(sumryFamily('smg'), frame('smg', Object.fromEntries(smgHolding())));
  assert.equal(r['Device mode'], 'Off-grid');
  assert.equal(r['Grid voltage'], 231.2);
  assert.equal(r['Grid frequency'], 49.98);
  assert.equal(r['Grid power'], 0);
  assert.equal(r['AC output voltage'], 230.1);
  assert.equal(r['AC output frequency'], 50);
  assert.equal(r['Load power'], 1850);
  assert.equal(r['Load apparent power'], 1990);
  assert.equal(r['Load percentage'], 31);
  assert.equal(r['Battery voltage'], 51.2);
  assert.equal(r['Battery current'], -12.3);
  assert.equal(r['Battery power'], -630);
  assert.equal(r['Battery state of charge'], 67);
  assert.equal(r['PV voltage 1'], 340.5);
  assert.equal(r['PV current 1'], 3.6);
  assert.equal(r['PV power 1'], 1220);
  assert.equal(r['PV power'], 1220);
  assert.equal(r.Temperature, 45);
  assert.equal(r['Fault code'], 4);
  assert.equal(r['Grid power raw'], undefined, 'intermediate values are not emitted');
});

test('smg: unknown mode and line-mode import', () => {
  const r = decodeLive(sumryFamily('smg'), frame('smg', { 201: 9, 204: 1400, 216: 250, 217: 1300, 215: 520 }));
  assert.equal(r['Device mode'], 'Unknown (9)');
  assert.equal(r['Grid power'], 1400);
  assert.equal(r['Battery power'], 1300);
  assert.equal(r['Battery current'], 25);
});

test('smg_ext: split-phase unit with two PV strings', () => {
  const r = decodeLive(sumryFamily('smg_ext'), frame('smg_ext', {
    201: 2, 203: 6001, 204: 900, 231: 41, 253: 6000, 254: 3100, 255: 3300, 256: 26,
    277: 528, 278: s16(-85), 279: s16(-450), 280: 72,
    338: 1201, 346: 1200, 348: 1600, 349: 1700, 351: 3800, 352: 52, 353: 1976,
    376: 1199, 384: 1201, 386: 1500, 387: 1600, 389: 3600, 390: 40, 391: 1440,
  }));
  assert.equal(r['Device mode'], 'Line');
  assert.equal(r['Grid frequency'], 60.01);
  assert.equal(r['Grid power'], 900);
  assert.equal(r['Grid voltage'], 120.1);
  assert.equal(r['Grid voltage 2'], 119.9);
  assert.equal(r['AC output voltage 1'], 120);
  assert.equal(r['AC output voltage 2'], 120.1);
  assert.equal(r['Load power 1'], 1600);
  assert.equal(r['Load power 2'], 1500);
  assert.equal(r['Load power'], 3100);
  assert.equal(r['Load apparent power'], 3300);
  assert.equal(r['AC output voltage 3'], undefined, 'idle phase 3 is not emitted');
  assert.equal(r['Battery voltage'], 52.8);
  assert.equal(r['Battery current'], -8.5);
  assert.equal(r['Battery power'], -450);
  assert.equal(r['Battery state of charge'], 72);
  assert.equal(r['PV voltage 2'], 360);
  assert.equal(r['PV power'], 3416);
  assert.equal(r.Temperature, 41);
});

test('serial check rejects blank, 0xFFFF and small numeric words', () => {
  assert.equal(serialFrom(ascii('SM2207123456')), 'SM2207123456');
  assert.equal(serialFrom(new Array(12).fill(0)), null);
  assert.equal(serialFrom(new Array(12).fill(0xffff)), null);
  assert.equal(serialFrom([0x0064, 0x0050, 0x0041, 0x0042, 0x0043, 0x0044]), null);
});

test('detect: accepts a classic SMG-II unit', async () => {
  const r = await probe(smgHolding());
  assert.equal(r?.modelId, 'smg');
  assert.match(r!.evidence, /SM2207123456/);
});

test('detect: protocol number 3–6 means the extended map', async () => {
  const h = smgHolding();
  h.set(184, 4);
  const r = await probe(h);
  assert.equal(r?.modelId, 'smg_ext');
});

test('detect: rejects blank, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 180; a < 210; a++) ff.set(a, 0xffff);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>([[0, 3]]);
  ascii('2106123456').forEach((v, i) => deye.set(3 + i, v));
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  ascii('RA1.0 ').forEach((v, i) => growatt.set(9 + i, v));
  ascii('XYZ0123456').forEach((v, i) => growatt.set(23 + i, v));
  assert.equal(await probe(growatt), null);
  // Serial present but working mode out of range: not one of ours.
  const bad = smgHolding();
  bad.set(201, 300);
  assert.equal(await probe(bad), null);
});

test('driver: info, live read, settings, and refused writes', async () => {
  const holding = smgHolding();
  await withLogger(holding, async (connection) => {
    const d = sumry.create({ modelId: 'smg', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], 'SM2207123456');
      assert.equal(info['Max AC output power'], 6200);
      assert.match(String(info['Model name']), /SMG/);
      const r = await d.read();
      assert.equal(r['Battery voltage'], 51.2);
      assert.equal(r['Battery state of charge'], 67);
      const s = await d.readSettings();
      assert.equal(s.output_source_priority, 'Solar/Battery/Utility');
      assert.equal(s.charger_source_priority, 'Solar first');
      assert.equal(s.battery_type, 'Lithium (BMS)');
      assert.equal(s.battery_absorption_charge_voltage, 56.4);
      assert.equal(s.max_charge_current, 60);
      assert.equal(s.back_to_grid_battery_capacity, 20);
      assert.equal(s.lcd_backlight, true);
      assert.ok(d.settingDefs().every((def) => def.readOnly));
      await assert.rejects(d.writeSetting('output_source_priority', 'Utility first'), /read-only/);
      await assert.rejects(d.rawWrite!(301, [0]), /read-only/);
      assert.equal(holding.get(301), 2, 'nothing was written');
      assert.deepEqual(await d.rawRead!(3, 229, 1), [67]);
    } finally {
      await d.close();
    }
  });
});

test('decodeRange: console shows live values and settings', () => {
  const out = decodeRange(sumryFamily('smg'), 3, 300, [0, 2, 0, 3]);
  assert.equal(out['Output source priority (unverified)'], 'Solar/Battery/Utility');
  assert.deepEqual(decodeRange(sumryFamily('smg'), 4, 0, [1]), {});
});
