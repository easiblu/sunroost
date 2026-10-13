/**
 * Auto-detect cross-check: every Modbus driver's `detect` probe runs against a minimal register image
 * of every other brand. Each probe must accept its own brand and reject all the others, so the
 * order the probes run in can't make one brand claim another's inverter.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ModbusConnection } from '../src/devices/modbus.ts';
import { INVERTER_DRIVERS } from '../src/devices/registry.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const ascii = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => (s.charCodeAt(i * 2) << 8) | (s.charCodeAt(i * 2 + 1) || 0));
const put = (m: Map<number, number>, at: number, words: number[]) => words.forEach((w, i) => m.set(at + i, w));

type Image = { holding: Map<number, number>; input: Map<number, number> };
const image = (fill: (h: Map<number, number>, i: Map<number, number>) => void): Image => {
  const holding = new Map<number, number>();
  const input = new Map<number, number>();
  fill(holding, input);
  return { holding, input };
};

/** One minimal, plausible identity image per driver id. */
const IMAGES: Record<string, Image> = {
  sunsynk: image((h) => {
    h.set(0, 3);
    put(h, 3, ascii('2106123456'));
  }),
  growatt: image((h) => {
    put(h, 9, ascii('RA1.0 '));
    put(h, 23, ascii('XYZ0123456'));
  }),
  srne: image((h) => {
    put(h, 0x0c, ascii('HESP4860S100-H  '));
    put(h, 0x35, ascii('SR2209123456'));
    put(h, 0x100, [80, 520, 0]);
  }),
  sumry: image((h) => {
    put(h, 186, ascii('SM2304120001'));
    h.set(201, 3);
  }),
  luxpower: image((h) => {
    put(h, 2, ascii('BA12345678'));
    put(h, 7, ascii('FAAB'));
    put(h, 115, ascii('BA12345678'));
  }),
  must: image((h) => {
    put(h, 20000, [ascii('PH')[0], 1800, 0x0012, 0xd687, 0, 0x0101]);
    h.set(25201, 2);
  }),
  megarevo: image((h) => {
    put(h, 0x1215, [10001, 10002]);
    put(h, 0x121c, ascii('R6KL1'));
    put(h, 0x1234, ascii('MR2023001234'));
  }),
  victron: image((h) => {
    put(h, 800, ascii('c0619ab1e2f3'));
    put(h, 840, [532, 0, 0, 76]);
  }),
  sigenergy: image((_h, i) => {
    put(i, 30500, ascii('SigenStor EC 10.0 TP'));
    put(i, 30515, ascii('110A12345678AB'));
    i.set(30014, 650);
  }),
  solis: image((_h, i) => {
    i.set(33000, 0x3105);
    put(i, 33004, ascii('1031110215040123'));
  }),
  sungrow: image((_h, i) => {
    put(i, 4989, ascii('A2210123456'));
    i.set(4999, 0x0e03);
    i.set(5000, 100);
  }),
  huawei: image((h) => {
    put(h, 30000, ascii('SUN2000-5KTL-L1'));
  }),
  goodwe: image((h) => {
    put(h, 35003, ascii('9010KETU123A4567'));
    put(h, 35011, ascii('GW10K-ET'));
  }),
  solax: image((h) => {
    put(h, 0, ascii('H450A2I1234567'));
    put(h, 7, ascii('SolaX'));
  }),
  afore: image((_h, i) => {
    i.set(6, 206);
    put(i, 7, [0, 6000]);
    put(i, 41, ascii('AF6KSL2306001234'));
  }),
  livoltek: image((h) => {
    put(h, 578, ascii('LVH50A2203001234'));
    h.set(469, 532);
  }),
  senergy: image((h) => {
    put(h, 0x1a10, ascii('SE2304123456'));
    h.set(0x2000, 55);
  }),
  midnite: image((h) => {
    put(h, 0x1a00, ascii('MN15-12KW-AIO'));
    put(h, 0x1a10, ascii('MN2406A01234'));
    h.set(0x2006, 532);
  }),
  felicity: image((h) => {
    put(h, 0xf800, [0x50, 0x0102, 0, 0]);
    put(h, 0xf804, [1234, 5678, 9012, 3400, 0]);
  }),
};

test('every Modbus detect probe accepts its own brand and rejects every other', async (t) => {
  const probes = INVERTER_DRIVERS.filter((d) => d.detect);
  // Every probe has an image, and every image a probe.
  assert.deepEqual(probes.map((d) => d.id).sort(), Object.keys(IMAGES).sort());
  for (const [owner, img] of Object.entries(IMAGES)) {
    const server = fakeLogger({ serial: 7, holding: img.holding, input: img.input });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const conn = new ModbusConnection({ type: 'solarman', host: '127.0.0.1', port: (server.address() as AddressInfo).port, loggerSerial: 7, address: 1, timeoutMs: 500 });
    await conn.connect();
    try {
      for (const d of probes) {
        const r = await d.detect!(conn).catch(() => null);
        await t.test(`${d.id} on a ${owner} image`, () => {
          if (d.id === owner) assert.ok(r, `${d.id} should recognise its own image`);
          else assert.equal(r, null, `${d.id} claimed a ${owner} inverter: ${r?.evidence}`);
        });
      }
    } finally {
      await conn.close();
      server.close();
    }
  }
});
