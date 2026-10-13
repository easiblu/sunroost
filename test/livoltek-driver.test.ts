import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeLive, livoltek } from '../src/devices/inverters/livoltek/index.ts';
import { image } from '../src/devices/inverters/livoltek/registers.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;
const s16 = (v: number) => v & 0xffff;

function ascii(start: number, s: string, into: Map<number, number>, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
const put = (m: Map<number, number>, at: number, words: number[]) => words.forEach((w, i) => m.set(at + i, w));

/** A Hyper-5000 exporting while charging the battery. */
function hyperMap() {
  const h = new Map<number, number>();
  put(h, 0, [0, 5, 100, 1000, 562, 562, 50, 1000, 460, 10, 20]);
  h.set(58, 65535);
  h.set(64, 3);
  h.set(82, 50);
  h.set(106, 500);
  h.set(107, 0);
  ascii(570, 'Hyper5000', h, 5);
  ascii(578, 'LVH50A2203001234', h, 8);
  ascii(586, 'HW-V1.1', h, 8);
  h.set(604, 1203);
  h.set(636, 113);
  Object.entries({
    450: 2305, 451: 132, 452: 3020, 453: 5001, 455: 3815, 456: 3402, 457: 52, 458: 48, 463: 1984, 464: 1633,
    466: 0, 467: 3617, 468: 76, 469: 532, 470: 189, 471: 1005, 474: 2306, 475: 61, 476: 1380, 477: 0,
    478: 2300, 479: 0, 481: 5000, 495: 41,
    501: 58, 504: 0x0001, 505: 0x86a0, 506: 0, 507: 23456, 510: 0, 512: 0, 513: 9800, 514: 0x0002, 515: 0x2710,
    516: 0, 517: 45000, 524: 85, 525: 42, 526: 213, 527: 98, 530: 76, 531: 576, 532: 480, 533: 600, 534: 1000,
    535: 28, 536: 24, 543: 2312, 544: s16(-27), 545: s16(-6350), 549: 4998, 568: 98,
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
      return await livoltek.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: read-only, id livoltek, 9600 baud, unit 17', () => {
  assert.equal(livoltek.id, 'livoltek');
  assert.equal(livoltek.readOnly, true);
  assert.equal(livoltek.defaultBaudRate, 9600);
  assert.equal(livoltek.defaultAddress, 17);
  assert.equal(livoltek.transport, 'serial');
  assert.deepEqual(livoltek.models?.map((m) => m.id), ['hyper', 'hp3']);
  assert.equal(livoltek.socControl?.('hyper'), null);
  assert.equal(livoltek.protectionSetting?.('hyper'), null);
  assert.ok(livoltek.consoleFunctions?.length);
  const d = livoltek.create({ modelId: 'hyper', connection: '/dev/null', baudRate: 9600, address: 17, index: 0 });
  assert.ok(d.settingDefs().length > 10);
  for (const def of d.settingDefs()) {
    assert.equal(def.readOnly, true, def.key);
    if (def.options) assert.equal(new Set(def.options).size, def.options.length, `${def.key} has duplicate options`);
  }
});

test('decode: scaling, signed and 32-bit values', () => {
  const m = decodeLive(image(0, [], hyperMap()));
  assert.equal(m['AC output voltage'], 230.5);
  assert.equal(m['AC output frequency'], 50.01);
  assert.equal(m['PV voltage 1'], 381.5);
  assert.equal(m['PV current 1'], 5.2);
  assert.equal(m['PV power 1'], 1984);
  assert.equal(m['PV power 2'], 1633);
  assert.equal(m['PV power'], 3617);
  assert.equal(m['Battery state of charge'], 76);
  assert.equal(m['Battery voltage'], 53.2);
  assert.equal(m['Battery current'], 18.9);
  assert.equal(m['Battery power'], 1005);
  assert.equal(m['Load power'], 1380);
  assert.equal(m.Temperature, 41);
  assert.equal(m['Grid voltage'], 231.2);
  assert.equal(m['Grid current'], -2.7);
  assert.equal(m['Grid power'], -635);
  assert.equal(m['Grid frequency'], 49.98);
  assert.equal(m['Charge energy total'], 10000); // 0x000186A0 = 100000 × 0.1
  assert.equal(m['PV energy total'], 14107.2); // 0x00022710 = 141072 × 0.1
  assert.equal(m['Export energy total'], 2345.6);
  assert.equal(m['PV energy today'], 21.3);
  assert.equal(m['Battery state of health'], 98);
  assert.equal(m['Battery charge current limit'], 60);
});

test('PV total falls back to the sum of strings when the 32-bit total is 0', () => {
  const h = hyperMap();
  h.set(467, 0);
  assert.equal(decodeLive(h)['PV power'], 3617);
});

test('over a logger: info, live and settings; writes are refused', async () => {
  await withLogger(hyperMap(), async (connection) => {
    const d = livoltek.create({ modelId: 'hyper', connection, baudRate: 9600, address: 17, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Model name'], 'Livoltek Hyper5000');
      assert.equal(info['Serial number'], 'LVH50A2203001234');
      assert.equal(info['Hardware version'], 'HW-V1.1');
      assert.equal(info['Firmware version'], '1203 / 113');
      const live = await d.read();
      assert.equal(live['Battery state of charge'], 76);
      assert.equal(live['Grid power'], -635);
      const s = await d.readSettings();
      assert.equal(s.work_mode, 'Self use');
      assert.equal(s.battery_type, 'LFP');
      assert.equal(s.battery_capacity, 100);
      assert.equal(s.max_charge_current, 100);
      assert.equal(s.charge_cut_off_voltage, 56.2);
      assert.equal(s.discharge_end_soc_on_grid, 10);
      assert.equal(s.feed_in_power_limit, 65535);
      assert.equal(s.eps_mode, 'UPS with bypass');
      assert.equal(s.feed_in_control_method, 'CT');
      assert.equal(s.max_ac_charge_current, 50);
      assert.equal(s.battery_light, 'On');
      await assert.rejects(d.writeSetting('work_mode', 'Backup'), /read-only/);
      await assert.rejects(d.rawWrite!(0, [1]), /read-only/);
      assert.deepEqual(await d.rawRead!(3, 468, 2), [76, 532]);
    } finally {
      await d.close();
    }
  });
});

test('detect accepts a Hyper and reports model, serial and unit', async () => {
  const r = await probe(hyperMap());
  assert.ok(r);
  assert.equal(r.modelId, 'hyper');
  assert.equal(r.address, 17);
  assert.match(r.evidence, /LVH50A2203001234/);
});

test('detect tells an HP3 from its model text', async () => {
  const h = hyperMap();
  ascii(570, 'HP3-8KS1LV', h, 5);
  assert.equal((await probe(h))?.modelId, 'hp3');
});

test('detect rejects blank, 0xFFFF, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 0; a < 700; a++) ff.set(a, 0xffff);
  assert.equal(await probe(ff), null);
  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(3, '2106123456', deye, 5);
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  ascii(9, 'RA1.0 ', growatt, 3);
  ascii(23, 'XYZ0123456', growatt, 5);
  assert.equal(await probe(growatt), null);
  // Serial present but no plausible live block.
  const noLive = new Map<number, number>();
  ascii(578, 'LVH50A2203001234', noLive, 8);
  assert.equal(await probe(noLive), null);
});
