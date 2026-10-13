import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ModbusConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';
import {
  checkInfoBlock, detectGoodwe, detectGoodweUdp, fakeGoodwe, GOODWE_CONNECTION_RE, goodwe, goodweDrivers, GoodweDriver, parseGoodweConnection,
} from '../src/devices/inverters/goodwe/index.ts';
import { modelFromIdentity } from '../src/devices/inverters/goodwe/registers.ts';
import { encodeAa55, parseAa55 } from '../src/devices/inverters/goodwe/udp.ts';

const ascii = (text: string, words: number) => {
  const out: number[] = [];
  for (let i = 0; i < words; i++) out.push(((text.charCodeAt(i * 2) || 0) << 8) | (text.charCodeAt(i * 2 + 1) || 0));
  return out;
};
const put = (m: Map<number, number>, start: number, values: number[]) => values.forEach((v, i) => m.set(start + i, v));
const s16 = (v: number) => (v < 0 ? v + 0x10000 : v);
const s32 = (v: number) => [(v >> 16) & 0xffff, v & 0xffff];

/** A GW10K-ET snapshot: PV 4054 W, charging 2048 W, importing 1500 W (meter), house 3506 W. */
function etMaps() {
  const holding = new Map<number, number>();
  put(holding, 35000, [1, 10000, 0, ...ascii('9010KETU123A4567', 8), ...ascii('GW10K-ET', 5), 18, 18, 0, 20, 0]);
  put(holding, 35021, ascii('04029-18-S11', 6));
  put(holding, 35027, ascii('02041-20-S00', 6));
  put(holding, 35103, [4123, 52, ...s32(2144), 3980, 48, ...s32(1910)]);
  put(holding, 35121, [2351, 41, 5002, ...s32(1350)]);
  put(holding, 35126, [2338, 40, 5001, ...s32(1220)]);
  put(holding, 35131, [2345, 42, 5002, ...s32(1230)]);
  put(holding, 35137, [...s32(3800), ...s32(-1500)]);
  put(holding, 35145, [2302, 12, 5000, 1, ...s32(276)]);
  holding.set(35173, 12);
  put(holding, 35174, [351, s16(-50), 452]);
  put(holding, 35178, [3850]);
  put(holding, 35180, [4096, s16(-50), ...s32(-2048), 3, 0, 0, 1]);
  put(holding, 35189, s32(0));
  put(holding, 35191, [0x0001, 0x86a0, 0, 153]); // 10000.0 kWh total, 15.3 today
  put(holding, 36004, [1, s16(-500), s16(-480), s16(-520), s16(-1500)]);
  put(holding, 37003, [255, 25, 25, 0, 76, 98]);
  // Settings
  holding.set(45252, 1);
  put(holding, 45350, [100, 1, 5760, 250, 4200, 250, 80, 4400, 70]);
  holding.set(47000, 0);
  put(holding, 47509, [1, 5000]);
  return { holding, input: new Map<number, number>() };
}

async function withLogger<T>(maps: { holding: Map<number, number>; input: Map<number, number> }, fn: (conn: string, mc: ModbusConnection) => Promise<T>) {
  const server = fakeLogger({ serial: 42, ...maps });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const mc = new ModbusConnection({ type: 'solarman', host: '127.0.0.1', port, loggerSerial: 42, address: 1, timeoutMs: 500 });
  await mc.connect();
  try {
    return await fn(`solarman://127.0.0.1:${port}/42`, mc);
  } finally {
    await mc.close();
    server.close();
  }
}

async function withUdp<T>(sock: Socket, fn: (conn: string) => Promise<T>) {
  sock.bind(0, '127.0.0.1');
  await once(sock, 'listening');
  try {
    return await fn(`goodwe://127.0.0.1:${(sock.address() as AddressInfo).port}`);
  } finally {
    sock.close();
  }
}

function checkEt(m: Record<string, unknown>) {
  assert.equal(m['PV voltage 1'], 412.3);
  assert.equal(m['PV current 1'], 5.2);
  assert.equal(m['PV power 1'], 2144);
  assert.equal(m['PV power 2'], 1910);
  assert.equal(m['PV power 3'], undefined, 'unused string hidden');
  assert.equal(m['PV power'], 4054);
  assert.equal(m['Battery voltage'], 409.6);
  assert.equal(m['Battery current'], 5, '+ = charging');
  assert.equal(m['Battery power'], 2048);
  assert.equal(m['Battery state of charge'], 76);
  assert.equal(m['Battery state of health'], 98);
  assert.equal(m['Battery temperature'], 25.5);
  assert.equal(m['Battery mode'], 'Charging');
  assert.equal(m['Grid power'], 1500, '+ = import');
  assert.equal(m['Grid power 1'], 500);
  assert.equal(m['Grid voltage'], 235.1);
  assert.equal(m['Grid voltage 3'], 234.5);
  assert.equal(m['Grid frequency'], 50.02);
  assert.equal(m['AC output voltage'], 230.2);
  assert.equal(m['Load power'], 3506);
  assert.equal(m['Load percentage'], 12);
  assert.equal(m['Device mode'], 'On-grid');
  assert.equal(m['Fault code'], 'None');
  assert.equal(m.Temperature, 45.2);
  assert.equal(m['Bus voltage'], 385);
  assert.equal(m['PV energy total'], 10000);
  assert.equal(m['PV energy today'], 15.3);
}

test('descriptor contract', () => {
  assert.equal(goodweDrivers.length, 1);
  assert.equal(goodwe.id, 'goodwe');
  assert.equal(goodwe.readOnly, true);
  assert.equal(goodwe.defaultAddress, 247);
  assert.equal(goodwe.defaultBaudRate, 9600);
  assert.equal(goodwe.socControl!('et'), null);
  assert.equal(goodwe.protectionSetting!('et'), null);
  assert.deepEqual(goodwe.models!.map((m) => m.id), ['et', 'eh', 'et-split', 'es']);
  const d = new GoodweDriver({ modelId: 'et', connection: '/dev/null', baudRate: 9600, address: 247, index: 0 });
  assert.ok(d.settingDefs().length > 5);
  assert.ok(d.settingDefs().every((s) => s.readOnly === true));
});

test('ET over Modbus (Solarman logger): info, live decode, settings', async () => {
  await withLogger(etMaps(), async (conn) => {
    const d = new GoodweDriver({ modelId: 'et', connection: conn, baudRate: 9600, address: 247, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], '9010KETU123A4567');
      assert.equal(info['Model name'], 'GW10K-ET');
      assert.equal(info['Firmware version'], '04029-18-S11');
      assert.equal(info['Secondary firmware version'], '02041-20-S00');
      assert.equal(info['Max AC output power'], 10000);
      checkEt(await d.read());
      const s = await d.readSettings();
      assert.equal(s.work_mode, 'General');
      assert.equal(s.battery_charge_voltage, 576);
      assert.equal(s.max_charge_current, 25);
      assert.equal(s.depth_of_discharge_on_grid, 80);
      assert.equal(s.export_limit_enabled, true);
      assert.equal(s.export_limit, 5000);
      assert.equal(s.backup_supply, true);
    } finally {
      await d.close();
    }
  });
});

test('single-phase model keeps unsuffixed grid values only', async () => {
  await withLogger(etMaps(), async (conn) => {
    const d = new GoodweDriver({ modelId: 'eh', connection: conn, baudRate: 9600, address: 247, index: 0 });
    await d.connect();
    try {
      const m = await d.read();
      assert.equal(m['Grid voltage 2'], undefined);
      assert.equal(m['Grid current'], 4.1);
      assert.equal(m['Grid power'], 1500);
    } finally {
      await d.close();
    }
  });
});

test('writes are refused', async () => {
  const d = new GoodweDriver({ modelId: 'et', connection: '/dev/null', baudRate: 9600, address: 247, index: 0 });
  await assert.rejects(d.writeSetting('work_mode', 'Eco'), /read-only/);
  await assert.rejects(d.rawWrite(47000, [1]), /read-only/);
});

test('detect: accepts GoodWe at unit 247, rejects blank / Deye / Growatt maps', async () => {
  await withLogger(etMaps(), async (_c, mc) => {
    const r = await detectGoodwe(mc);
    assert.ok(r);
    assert.equal(r.modelId, 'et');
    assert.equal(r.address, 247);
    assert.match(r.evidence, /9010KETU123A4567/);
  });
  await withLogger({ holding: new Map(), input: new Map() }, async (_c, mc) => assert.equal(await detectGoodwe(mc), null));
  const ff = new Map<number, number>();
  for (let a = 35000; a < 35033; a++) ff.set(a, 0xffff);
  await withLogger({ holding: ff, input: new Map() }, async (_c, mc) => assert.equal(await detectGoodwe(mc), null));
  const deye = new Map<number, number>();
  deye.set(0, 3);
  put(deye, 3, ascii('2106123456', 5));
  await withLogger({ holding: deye, input: new Map() }, async (_c, mc) => assert.equal(await detectGoodwe(mc), null));
  const growatt = new Map<number, number>();
  put(growatt, 9, ascii('RA1.0 ', 3));
  put(growatt, 23, ascii('XYZ0123456', 5));
  await withLogger({ holding: growatt, input: new Map() }, async (_c, mc) => assert.equal(await detectGoodwe(mc), null));
});

test('detect: falls back to unit 1 and reports it', async () => {
  const { holding } = etMaps();
  const regs = Array.from({ length: 33 }, (_, i) => holding.get(35000 + i) ?? 0);
  const units: number[] = [];
  const fake = {
    async read(_fn: number, _start: number, _count: number, unit?: number) {
      units.push(unit ?? -1);
      if (unit === 247) throw new Error('timeout');
      return regs;
    },
  } as unknown as ModbusConnection;
  const r = await detectGoodwe(fake);
  assert.equal(r?.address, 1);
  assert.deepEqual(units, [247, 1]);
});

test('identity checks', () => {
  assert.equal(checkInfoBlock(new Array(33).fill(0)), null);
  assert.equal(modelFromIdentity('9010KETU123A4567'), 'et');
  assert.equal(modelFromIdentity('95000EHB123W0000'), 'eh');
  assert.equal(modelFromIdentity('95048ESU227W0000'), 'es');
  assert.equal(modelFromIdentity('XXXXXXXXXXXX', 'GW6000-EH'), 'eh');
});

test('goodwe:// connection strings', () => {
  assert.deepEqual(parseGoodweConnection('goodwe://192.168.1.50'), { host: '192.168.1.50', port: 8899 });
  assert.deepEqual(parseGoodweConnection('goodwe://inverter.lan:9000'), { host: 'inverter.lan', port: 9000 });
  assert.equal(parseGoodweConnection('192.168.1.50:8899'), null);
  assert.ok(GOODWE_CONNECTION_RE.test('goodwe://10.0.0.7:8899'));
  assert.ok(!GOODWE_CONNECTION_RE.test('goodwe://'));
});

test('AA55 framing: 16-bit sum checksum', () => {
  assert.equal(encodeAa55(0x01, 0x06).toString('hex'), 'aa55c07f0106000245');
  assert.equal(encodeAa55(0x01, 0x02).toString('hex'), 'aa55c07f0102000241');
  const reply = encodeAa55(0x01, 0x86, Buffer.from([1, 2, 3]), 0x7f, 0xc0);
  assert.deepEqual([...parseAa55(reply, 0x01, 0x06)], [1, 2, 3]);
  const bad = Buffer.from(reply);
  bad[8] ^= 1;
  assert.throws(() => parseAa55(bad, 0x01, 0x06), /checksum/);
});

test('ET over the UDP dongle (Modbus over UDP), with split datagrams and a lost request', async () => {
  const maps = etMaps();
  await withUdp(fakeGoodwe({ ...maps, split: true, drop: 1 }), async (conn) => {
    const d = new GoodweDriver({ modelId: 'et', connection: conn, baudRate: 0, address: 0, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Serial number'], '9010KETU123A4567');
      checkEt(await d.read());
      assert.deepEqual(await d.rawRead(3, 37007, 2), [76, 98]);
    } finally {
      await d.close();
    }
  });
});

/** ES running-info payload: PV1 380.0 V 5.0 A, charging 10 A at 52.0 V, importing 300 W. */
function esRunning() {
  const b = Buffer.alloc(140);
  b.writeUInt16BE(3800, 0);
  b.writeUInt16BE(50, 2);
  b.writeUInt16BE(0, 5);
  b.writeUInt16BE(520, 10);
  b.writeInt16BE(231, 16);
  b.writeUInt16BE(100, 18);
  b[26] = 64;
  b[29] = 99;
  b[30] = 3; // charging
  b.writeUInt16BE(2398, 34);
  b.writeInt16BE(300, 38);
  b.writeUInt16BE(4999, 40);
  b.writeUInt16BE(2301, 43);
  b.writeUInt16BE(1100, 47);
  b.writeUInt16BE(5000, 49);
  b[52] = 1;
  b.writeInt16BE(415, 53);
  b.writeUInt32BE(0x00000040, 55);
  b.writeUInt32BE(52345, 59);
  b[80] = 2; // importing
  b.writeInt16BE(100, 81);
  return b;
}

function esInfo() {
  const b = Buffer.alloc(64);
  b.write('V1.18', 0, 'latin1');
  b.write('GW5048-EM ', 5, 'latin1');
  b.write('95048EMU227W0001', 31, 'latin1');
  b.write('02032-11-S00', 51, 'latin1');
  return b;
}

test('ES over the UDP dongle (AA55)', async () => {
  await withUdp(fakeGoodwe({ running: esRunning(), deviceInfo: esInfo() }), async (conn) => {
    const d = new GoodweDriver({ modelId: 'es', connection: conn, baudRate: 0, address: 0, index: 0 });
    await d.connect();
    try {
      assert.equal(d.info()['Serial number'], '95048EMU227W0001');
      assert.equal(d.info()['Model name'], 'GW5048-EM');
      const m = await d.read();
      assert.equal(m['PV power 1'], 1900);
      assert.equal(m['PV power'], 1900);
      assert.equal(m['Battery current'], 10);
      assert.equal(m['Battery power'], 520);
      assert.equal(m['Battery state of charge'], 64);
      assert.equal(m['Battery temperature'], 23.1);
      assert.equal(m['Grid power'], 300);
      assert.equal(m['Grid frequency'], 49.99);
      assert.equal(m['Load power'], 1200);
      assert.equal(m['Device mode'], 'On-grid');
      assert.equal(m['Fault code'], '0x00000040');
      assert.equal(m['PV energy total'], 5234.5);
      assert.deepEqual(d.settingDefs(), []);
    } finally {
      await d.close();
    }
  });
});

test('ES model on a serial path is refused with a hint', async () => {
  const d = new GoodweDriver({ modelId: 'es', connection: '/dev/ttyUSB9', baudRate: 9600, address: 247, index: 0 });
  await assert.rejects(d.connect(), /goodwe:\/\//);
});

test('detectGoodweUdp: ET via Modbus-over-UDP, ES via AA55, nothing on a blank dongle', async () => {
  await withUdp(fakeGoodwe(etMaps()), async (conn) => {
    const r = await detectGoodweUdp(conn, { timeoutMs: 300 });
    assert.equal(r?.modelId, 'et');
    assert.equal(r?.address, 247);
  });
  await withUdp(fakeGoodwe({ units: [], deviceInfo: esInfo() }), async (conn) => {
    const r = await detectGoodweUdp(conn, { timeoutMs: 200 });
    assert.equal(r?.modelId, 'es');
    assert.match(r!.evidence, /95048EMU227W0001/);
  });
  await withUdp(fakeGoodwe({}), async (conn) => {
    assert.equal(await detectGoodweUdp(conn, { timeoutMs: 200 }), null);
  });
});
