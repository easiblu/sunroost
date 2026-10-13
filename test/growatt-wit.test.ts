import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodeInputs, decodeRange, growatt, GrowattDriver, growattFamily } from '../src/devices/inverters/growatt/index.ts';
import { image, type RegisterImage } from '../src/devices/inverters/growatt/registers.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2799887766;
const s16 = (v: number) => v & 0xffff;

function put32(m: Map<number, number>, addr: number, v: number) {
  m.set(addr, (v >>> 16) & 0xffff);
  m.set(addr + 1, v & 0xffff);
}

function ascii(m: Map<number, number>, start: number, s: string, words: number) {
  const p = s.padEnd(words * 2, ' ');
  for (let i = 0; i < words; i++) m.set(start + i, (p.charCodeAt(i * 2) << 8) | p.charCodeAt(i * 2 + 1));
}

/** WIT 100K-HU at midday: 4 strings + PV9, charging the battery at 12 kW and exporting 8 kW. */
function witInput(): Map<number, number> {
  const m = new Map<number, number>();
  m.set(0, 1);
  put32(m, 1, 652000); // 65.2 kW total PV
  m.set(3, 6500); m.set(4, 250); put32(m, 5, 162500);
  m.set(7, 6480); m.set(8, 251); put32(m, 9, 162600);
  m.set(11, 6300); m.set(12, 200); put32(m, 13, 126000);
  m.set(15, 6200); m.set(16, 150); put32(m, 17, 93000);
  put32(m, 35, 520000); // 52 kW AC output
  m.set(37, 5002);
  m.set(38, 2312); m.set(42, 2305); m.set(46, 2320);
  m.set(93, 452);
  m.set(98, 7500);
  m.set(105, 0);
  m.set(8000, 6100); m.set(8001, 180); put32(m, 8002, 109800);
  m.set(8034, 7680); // 768.0 V HV battery
  m.set(8035, s16(-156)); // raw current, sign undocumented
  m.set(8042, 640); m.set(8043, 610); m.set(8044, 655);
  put32(m, 8079, 440000); // 44 kW load
  put32(m, 8081, 0);
  put32(m, 8083, 80000); // 8 kW export
  put32(m, 8091, 120000); // +12 kW battery
  m.set(8093, 63); m.set(8094, 98);
  m.set(8096, 2310); m.set(8097, 2308); m.set(8098, 2315);
  return m;
}

function witHolding(): Map<number, number> {
  const h = new Map<number, number>();
  h.set(0, 1);
  ascii(h, 9, 'TJAA10', 3);
  ascii(h, 23, 'WIT0A12345', 5);
  h.set(43, 5600);
  h.set(44, 0x0a03);
  h.set(122, 3); h.set(123, 500);
  h.set(905, 80); h.set(906, 8640); h.set(907, 6720); h.set(910, 1000); h.set(911, 1200);
  h.set(936, 1); h.set(937, 0); h.set(949, 1); h.set(950, 0); h.set(951, 95); h.set(952, 15);
  h.set(954, 0x8000 | (1 << 13)); h.set(955, (1 << 8) | 30); h.set(956, 5 << 8);
  h.set(988, 0); h.set(996, 30); h.set(998, 10);
  return h;
}

function blockImage(input: Map<number, number>): RegisterImage {
  const regs: RegisterImage = new Map();
  for (const [start, count] of growattFamily('wit').inputBlocks) {
    image(start, Array.from({ length: count }, (_, i) => input.get(start + i) ?? 0), regs);
  }
  return regs;
}

async function withLogger<T>(maps: { input?: Map<number, number>; holding?: Map<number, number> }, fn: (c: string) => Promise<T>) {
  const server = fakeLogger({ serial: LOGGER, ...maps });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/${LOGGER}`);
  } finally {
    server.close();
  }
}

test('WIT: family is registered and every input block fits one request', () => {
  const f = growattFamily('wit');
  assert.equal(f.id, 'wit');
  assert.equal(f.name, 'WIT three-phase hybrid (commercial)');
  for (const [, count] of f.inputBlocks) assert.ok(count <= 125);
  assert.ok(growatt.models?.some((m) => m.id === 'wit' && m.name === 'WIT three-phase hybrid (commercial)'));
});

test('WIT: decodes PV, battery, grid, load and three phases', () => {
  const r = decodeInputs(growattFamily('wit'), blockImage(witInput()));
  assert.equal(r['Device mode'], 'Normal');
  assert.equal(r['PV power'], 65200);
  assert.equal(r['PV voltage 1'], 650);
  assert.equal(r['PV current 1'], 25);
  assert.equal(r['PV power 1'], 16250);
  assert.equal(r['PV power 4'], 9300);
  assert.equal(r['PV voltage 9'], 610);
  assert.equal(r['PV power 9'], 10980);
  assert.equal(r['PV voltage 5'], undefined, 'unused strings are not emitted');
  assert.equal(r['PV voltage 10'], undefined);
  assert.equal(r['Battery voltage'], 768);
  assert.equal(r['Battery power'], 12000);
  assert.equal(r['Battery current'], 15.6, 'current takes the direction of battery power');
  assert.equal(r['Battery state of charge'], 63);
  assert.equal(r['Battery state of health'], 98);
  assert.equal(r['Grid power'], -8000);
  assert.equal(r['Load power'], 44000);
  assert.equal(r['Inverter power'], 52000);
  assert.equal(r['Grid frequency'], 50.02);
  assert.equal(r['Grid voltage'], 231.2);
  assert.equal(r['Grid voltage 2'], 230.5);
  assert.equal(r['Grid voltage 3'], 232);
  assert.equal(r['AC output voltage'], 231);
  assert.equal(r['AC output voltage 3'], 231.5);
  assert.equal(r['AC output frequency'], 50.02);
  assert.equal(r['Load current 1'], 64);
  assert.equal(r.Temperature, 45.2);
  assert.equal(r['Bus voltage'], 750);
  assert.equal(r['Fault code'], 0);
  assert.equal(r['Battery power raw'], undefined, 'intermediate values are not emitted');
});

test('WIT: discharging battery, negative 32-bit power, load fallback when Ptoload reads 0', () => {
  const m = witInput();
  put32(m, 8091, -50000 >>> 0); // −5 kW
  m.set(8035, 65);
  put32(m, 8079, 0);
  put32(m, 8081, 30000);
  put32(m, 8083, 0);
  put32(m, 35, 20000);
  const r = decodeInputs(growattFamily('wit'), blockImage(m));
  assert.equal(r['Battery power'], -5000);
  assert.equal(r['Battery current'], -6.5);
  assert.equal(r['Grid power'], 3000);
  assert.equal(r['Load power'], 5000, 'inverter output + grid import');
});

test('WIT: console decodes holding info and slot words', () => {
  const h = witHolding();
  const out = decodeRange(growattFamily('wit'), 3, 950, Array.from({ length: 50 }, (_, i) => h.get(950 + i) ?? 0));
  assert.equal(out['Machine type'], 'WIT');
  assert.equal(out['Time slot 1 enable word'], 0xa000);
  assert.equal(out['Battery charge stop SOC (unverified)'], '95');
  const info = decodeRange(growattFamily('wit'), 3, 40, [0, 0, 0, 5600, 0x0a03]);
  assert.equal(info['Device type code'], 5600);
});

test('WIT: every setting is read-only and SOC control / protection are off', () => {
  const f = growattFamily('wit');
  assert.ok(f.settings.length > 10);
  for (const d of f.settings) assert.equal(d.readOnly, true, d.key);
  assert.equal(growatt.socControl?.('wit'), null);
  assert.equal(growatt.protectionSetting?.('wit'), null);
  assert.deepEqual(growatt.readOnlyModels, ['wit']);
  assert.equal(growatt.readOnly, undefined, 'the Growatt driver itself stays writable');
});

test('WIT driver end-to-end over a Solarman logger: info, poll, settings, writes refused', async () => {
  await withLogger({ input: witInput(), holding: witHolding() }, async (connection) => {
    const d = new GrowattDriver({ connection, modelId: 'wit', baudRate: 9600, address: 1 } as never);
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], 'WIT0A12345');
      assert.equal(info['Firmware version'], 'TJAA10');
      assert.equal(info['Model name'], 'Growatt WIT three-phase hybrid (commercial)');
      const r = await d.read();
      assert.equal(r['Battery state of charge'], 63);
      assert.equal(r['Grid power'], -8000);
      const s = await d.readSettings();
      assert.equal(s.ac_charge, true);
      assert.equal(s.ac_charge_power_rate, 80);
      assert.equal(s.max_charge_voltage, 864);
      assert.equal(s.max_charge_current, 100);
      assert.equal(s.ac_output_voltage, '230');
      assert.equal(s.ac_output_frequency, '50');
      assert.equal(s.off_grid, false);
      assert.equal(s.battery_discharge_stop_soc, 15);
      assert.equal(s.backup_soc, 30);
      assert.equal(s.export_limiter, true);
      assert.equal(s.export_power_rate, 50);
      await assert.rejects(d.writeSetting('ac_charge', false), /read-only/);
      await assert.rejects(d.rawWrite(949, [0]), /read-only/);
      assert.deepEqual(await d.rawRead(4, 8093, 2), [63, 98]);
    } finally {
      await d.close();
    }
  });
});

async function probe(holding: Map<number, number>) {
  return withLogger({ holding }, async (c) => {
    const conn = new ModbusConnection(parseConnection(c, 9600, 1));
    await conn.connect();
    try {
      return await growatt.detect!(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('detect: a WIT answers the shared Growatt probe; DTC 5600–5603 picks the WIT model', async () => {
  const holding = witHolding();
  const dtc = holding.get(43);
  holding.delete(43);
  const plain = await probe(holding);
  assert.ok(plain);
  assert.match(plain.evidence, /WIT0A12345/);
  assert.equal(plain.modelId, undefined);
  holding.set(43, dtc && dtc >= 5600 && dtc <= 5603 ? dtc : 5600);
  assert.equal((await probe(holding))?.modelId, 'wit');
});

test('detect: rejects a blank map and a Deye-like map', async () => {
  assert.equal(await probe(new Map()), null);
  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(deye, 3, '2305123456', 5);
  assert.equal(await probe(deye), null);
});
