import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import { decodeLive, detectSungrow, sungrow, sungrowModel, typeFamily } from '../src/devices/inverters/sungrow/index.ts';
import { image } from '../src/devices/inverters/sungrow/registers.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const LOGGER = 2712345678;

function ascii(into: Map<number, number>, start: number, s: string, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
/** 32-bit value, low word first (Sungrow order). */
function u32(into: Map<number, number>, addr: number, v: number) {
  const u = v < 0 ? v + 0x100000000 : v;
  into.set(addr, u & 0xffff);
  into.set(addr + 1, Math.floor(u / 0x10000) & 0xffff);
}
const s16 = (v: number) => v & 0xffff;

function identity(input: Map<number, number>, serial: string, code: number, nominal: number, outType: number) {
  ascii(input, 4989, serial, 10);
  input.set(4999, code);
  input.set(5000, nominal);
  input.set(5001, outType);
}

/** SH10RT three-phase hybrid, charging the battery from PV while importing a little. */
function sh10rt() {
  const input = new Map<number, number>();
  const holding = new Map<number, number>();
  identity(input, 'A2210123456', 0x0e03, 100, 1);
  ascii(input, 4953, 'SAPPHIRE-H_01011.95.10', 15);
  ascii(input, 4968, 'MCU_01011.95.08', 15);
  Object.entries({
    5007: 412, 5010: 6123, 5011: 85, 5012: 5980, 5013: 40, 5014: 0, 5015: 0,
    5018: 2301, 5019: 2312, 5020: 2295, 5021: 110, 5022: 120, 5023: 105, 5035: 500,
    12999: 0x0000, 13000: 0x13, 13001: 184, 13019: 2056, 13020: 123, 13021: 2530, 13022: 765, 13023: 990,
    13024: s16(-25), 13025: 52, 13035: 31, 13039: 96, 13044: 140,
  }).forEach(([a, v]) => input.set(Number(a), v));
  u32(input, 5016, 7600);
  u32(input, 5030, 5600);
  u32(input, 13002, 1234567);
  u32(input, 13007, 1200);
  u32(input, 13009, -350);
  Object.entries({ 13049: 2, 13050: 0xaa, 13051: 3000, 13057: 1000, 13058: 100, 13073: 5000, 13086: 0xaa, 13099: 20 })
    .forEach(([a, v]) => holding.set(Number(a), v));
  return { input, holding };
}

/** SG10RT grid-tied with a meter, exporting. */
function sg10rt() {
  const input = new Map<number, number>();
  const holding = new Map<number, number>();
  identity(input, 'B2109876543', 0x2433, 100, 1);
  Object.entries({ 5002: 231, 5007: 380, 5010: 5500, 5011: 70, 5018: 2300, 5019: 2310, 5020: 2320, 5035: 500, 5037: 0, 5044: 0 })
    .forEach(([a, v]) => input.set(Number(a), v));
  u32(input, 5003, 70000);
  u32(input, 5016, 4100);
  u32(input, 5030, 4000);
  u32(input, 5082, -1200);
  holding.set(5005, 0xcf);
  holding.set(5006, 0x55);
  holding.set(5007, 1000);
  return { input, holding };
}

async function withLogger<T>(maps: { input: Map<number, number>; holding: Map<number, number> }, fn: (connection: string) => Promise<T>): Promise<T> {
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
  return withLogger({ input: maps.input ?? new Map(), holding: maps.holding ?? new Map() }, async (c) => {
    const conn = new ModbusConnection(parseConnection(c, 9600, 1));
    await conn.connect();
    try {
      return await detectSungrow(conn).catch(() => null);
    } finally {
      await conn.close();
    }
  });
}

test('descriptor: read-only, sungrow id, TCP, 9600 / address 1', () => {
  assert.equal(sungrow.id, 'sungrow');
  assert.equal(sungrow.readOnly, true);
  // 'serial' so the form offers both RS485 ports and the WiNet-S host:port.
  assert.equal(sungrow.transport, 'serial');
  assert.equal(sungrow.defaultBaudRate, 9600);
  assert.equal(sungrow.defaultAddress, 1);
  assert.deepEqual(sungrow.models?.map((m) => m.id), ['hybrid3', 'hybrid', 'grid']);
  assert.equal(sungrow.socControl?.('hybrid3'), null);
  assert.equal(sungrow.protectionSetting?.('hybrid3'), null);
  for (const model of ['hybrid3', 'grid']) {
    const d = sungrow.create({ modelId: model, connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
    assert.ok(d.settingDefs().length >= 3);
    for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
  }
});

test('type code families', () => {
  assert.equal(typeFamily(0x0e03)?.model, 'hybrid3');
  assert.equal(typeFamily(0x0e21)?.model, 'hybrid3');
  assert.equal(typeFamily(0x0d0f)?.model, 'hybrid');
  assert.equal(typeFamily(0x2433)?.model, 'grid');
  assert.equal(typeFamily(0), undefined);
  assert.equal(typeFamily(0xffff), undefined);
  assert.equal(typeFamily(0x0003), undefined);
});

test('SH10RT over a logger: info, live decode and settings', async () => {
  await withLogger(sh10rt(), async (connection) => {
    const d = sungrow.create({ modelId: 'hybrid3', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], 'A2210123456');
      assert.equal(info['Model name'], 'Sungrow SH10RT');
      assert.equal(info['Device type code'], '0x0E03');
      assert.equal(info['Rated power'], 10000);
      assert.equal(info['Output type'], 'Three-phase 4-wire');
      assert.equal(info['Firmware version'], 'SAPPHIRE-H_01011.95.10');
      assert.equal(info['Secondary firmware version'], 'MCU_01011.95.08');

      const m = await d.read();
      assert.equal(m.Temperature, 41.2);
      assert.equal(m['PV voltage 1'], 612.3);
      assert.equal(m['PV current 1'], 8.5);
      assert.equal(m['PV power 1'], 5205);
      assert.equal(m['PV power 2'], 2392);
      assert.equal(m['PV power'], 7600);
      assert.equal(m['Grid voltage'], 230.1);
      assert.equal(m['Grid voltage 3'], 229.5);
      assert.equal(m['Grid frequency'], 50);
      assert.equal(m['Inverter power'], 5600);
      assert.equal(m['Device mode'], 'Run');
      assert.equal(m['Load power'], 1200);
      assert.equal(m['Grid power'], 350, 'export −350 W = importing 350 W');
      assert.equal(m['Battery voltage'], 205.6);
      assert.equal(m['Battery current'], 12.3);
      assert.equal(m['Battery power'], 2530, 'charging is positive');
      assert.equal(m['Battery state of charge'], 76.5);
      assert.equal(m['Battery state of health'], 99);
      assert.equal(m['Battery temperature'], -2.5);
      assert.equal(m['PV energy today'], 18.4);
      assert.equal(m['PV energy total'], 123456.7);
      assert.equal(m['Import energy today'], 3.1);
      assert.equal(m['Export energy today'], 14);
      assert.equal(m['Running state'], undefined);
      assert.equal(m['Export power'], undefined);

      const s = await d.readSettings();
      assert.equal(s.ems_mode, 'Forced mode');
      assert.equal(s.forced_charge_discharge_command, 'Charge');
      assert.equal(s.forced_charge_discharge_power, 3000);
      assert.equal(s.max_battery_soc, 100);
      assert.equal(s.min_battery_soc, 10);
      assert.equal(s.export_power_limit, 5000);
      assert.equal(s.export_power_limitation, true);
      assert.equal(s.backup_reserve_soc, 20);

      const raw = await d.rawRead!(4, 4999, 1);
      assert.deepEqual(raw, [0x0e03]);
    } finally {
      await d.close();
    }
  });
});

test('hybrid discharging: battery power and current go negative', () => {
  const { input } = sh10rt();
  input.set(13000, 0x04 | 0x08);
  const regs = image(0, []);
  for (const [a, v] of input) regs.set(a, v);
  const m = decodeLive(sungrowModel('hybrid3'), regs);
  assert.equal(m['Battery power'], -2530);
  assert.equal(m['Battery current'], -12.3);
  // Signed firmware: a negative value is taken as is.
  regs.set(13021, s16(-800));
  regs.set(13020, s16(-40));
  const n = decodeLive(sungrowModel('hybrid3'), regs);
  assert.equal(n['Battery power'], -800);
  assert.equal(n['Battery current'], -4);
});

test('single-phase hybrid uses unsuffixed grid voltage', () => {
  const { input } = sh10rt();
  const m = decodeLive(sungrowModel('hybrid'), new Map(input));
  assert.equal(m['Grid voltage'], 230.1);
  assert.equal(m['Grid voltage 1'], undefined);
  assert.equal(m['Grid voltage 2'], undefined);
  assert.equal(m['PV voltage 3'], undefined);
});

test('SG10RT grid-tied: meter, load and settings, no battery', async () => {
  await withLogger(sg10rt(), async (connection) => {
    const d = sungrow.create({ modelId: 'grid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Model name'], 'Sungrow SG10RT');
      const m = await d.read();
      assert.equal(m['PV energy today'], 23.1);
      assert.equal(m['PV energy total'], 70000);
      assert.equal(m['PV power'], 4100);
      assert.equal(m['Grid power'], -1200);
      assert.equal(m['Load power'], 2800);
      assert.equal(m['Grid frequency'], 50);
      assert.equal(m['Device mode'], 'Run');
      assert.equal(m['Fault code'], 'None');
      assert.equal(m['Battery power'], undefined);
      assert.equal(m['Battery state of charge'], undefined);
      const s = await d.readSettings();
      assert.equal(s.inverter_on, true);
      assert.equal(s.power_limitation, false);
      assert.equal(s.power_limitation_setting, 100);
    } finally {
      await d.close();
    }
  });
});

test('detect accepts Sungrow hybrid and grid images', async () => {
  const h = await probe(sh10rt());
  assert.ok(h);
  assert.equal(h.modelId, 'hybrid3');
  assert.match(h.evidence, /0x0E03.*A2210123456/);
  const g = await probe(sg10rt());
  assert.equal(g?.modelId, 'grid');
  // Minimal cross-check image: serial + type + nominal power only.
  const input = new Map<number, number>();
  identity(input, 'A2210123456', 0x0e03, 100, 0);
  assert.equal((await probe({ input }))?.modelId, 'hybrid3');
});

test('detect rejects blank, 0xFFFF, other brands and partial identities', async () => {
  assert.equal(await probe({}), null, 'blank');
  const ff = new Map<number, number>();
  for (let a = 4989; a <= 5001; a++) ff.set(a, 0xffff);
  assert.equal(await probe({ input: ff }), null, '0xFFFF');

  const deye = new Map<number, number>();
  deye.set(0, 3);
  ascii(deye, 3, '2106123456', 5);
  assert.equal(await probe({ holding: deye }), null, 'Deye-like');

  const growatt = new Map<number, number>();
  ascii(growatt, 9, 'RA1.0 ', 3);
  ascii(growatt, 23, 'XYZ0123456', 5);
  assert.equal(await probe({ holding: growatt }), null, 'Growatt-like');

  const unknownType = new Map<number, number>();
  identity(unknownType, 'A2210123456', 0x1234, 100, 1);
  assert.equal(await probe({ input: unknownType }), null, 'unknown type code');

  const noSerial = new Map<number, number>();
  identity(noSerial, '', 0x0e03, 100, 1);
  assert.equal(await probe({ input: noSerial }), null, 'no serial');

  const noPower = new Map<number, number>();
  identity(noPower, 'A2210123456', 0x0e03, 0, 1);
  assert.equal(await probe({ input: noPower }), null, 'zero nominal power');
});

test('writes are refused', async () => {
  const d = sungrow.create({ modelId: 'hybrid3', connection: '/dev/null', baudRate: 9600, address: 1, index: 0 });
  await assert.rejects(d.writeSetting('ems_mode', 'Self-consumption'), /read-only/);
  await assert.rejects(d.rawWrite!(13049, [0]), /read-only/);
});

test('silent Modbus TCP (encrypted WiNet-S) fails with a clear message', async () => {
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
    s.on('data', () => {}); // swallow requests, never answer
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    const conn = new ModbusConnection({ type: 'tcp', host: '127.0.0.1', port, address: 1, timeoutMs: 300 });
    await conn.connect();
    try {
      await assert.rejects(detectSungrow(conn), /encrypts Modbus TCP.*RS485/);
    } finally {
      await conn.close();
    }
    const d = sungrow.create({ modelId: 'hybrid3', connection: `127.0.0.1:${port}`, baudRate: 9600, address: 1, index: 0 });
    await assert.rejects(d.connect(), /RS485 cable/);
    await d.close();
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});
