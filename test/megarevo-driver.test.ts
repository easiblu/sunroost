import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { test } from 'node:test';
import { decodeLive, megarevo, megarevoDrivers, MegarevoDriver, megarevoFamily } from '../src/devices/inverters/megarevo/index.ts';
import { flexAscii, image } from '../src/devices/inverters/megarevo/family.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const SERIAL = 2712345678;
const s16 = (v: number) => v & 0xffff;
const ascii = (s: string) => {
  const t = s.length % 2 ? `${s}\0` : s;
  return Array.from({ length: t.length / 2 }, (_, i) => (t.charCodeAt(i * 2) << 8) | t.charCodeAt(i * 2 + 1));
};
function put(map: Map<number, number>, addr: number, words: number[]) {
  words.forEach((w, i) => map.set(addr + i, w & 0xffff));
}
/** s32, high word first. */
const s32 = (v: number) => [(v >> 16) & 0xffff, v & 0xffff];

async function withLogger(holding: Map<number, number>, fn: (connection: string) => Promise<void>) {
  const server = fakeLogger({ serial: SERIAL, holding });
  const sockets = new Set<Socket>();
  server.on('connection', (sock: Socket) => sockets.add(sock));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/${SERIAL}`);
  } finally {
    for (const sock of sockets) sock.destroy();
    server.close();
  }
}

async function withConn<T>(holding: Map<number, number>, fn: (c: ModbusConnection, reads: () => number) => Promise<T>) {
  let result: T | undefined;
  await withLogger(holding, async (connection) => {
    const conn = new ModbusConnection({ ...parseConnection(connection, 9600, 1), timeoutMs: 500 });
    await conn.connect();
    let n = 0;
    const read = conn.read.bind(conn);
    conn.read = (...args: Parameters<typeof conn.read>) => {
      n++;
      return read(...args);
    };
    try {
      result = await fn(conn, () => n);
    } finally {
      await conn.close();
    }
  });
  return result as T;
}

/** A single-phase Megarevo R6KL1 mid-afternoon: PV 2.9 kW, battery discharging, importing a little. */
function megarevoSingle(): Map<number, number> {
  const h = new Map<number, number>();
  // Info block
  h.set(0x1215, 10203);
  h.set(0x1216, 10001);
  h.set(0x1219, 10100);
  put(h, 0x121c, ascii('R6KL1'));
  put(h, 0x1234, ascii('F12201000123'));
  // Status: system state 4 (hybrid) with inverter-state bits set above bit 4; fault word 1 bit 7
  h.set(0x3100, 0b10);
  h.set(0x3102, 1 << 7);
  h.set(0x3104, 4 | (2 << 5));
  // Grid phase B (single-phase units use B): 231.2 V, −2.5 A, −580 W (vendor sign: + = to grid)
  put(h, 0x3113, [2312, s16(-25), s16(-580)]);
  h.set(0x3119, 5001);
  h.set(0x311a, 38);
  h.set(0x311b, 42);
  // Load phase B: 230.0 V, 5.2 A, 1180 W, 23.6 %
  put(h, 0x3124, [2300, 52, 1180, 236]);
  // PV1 / PV2
  put(h, 0x3130, [3605, 52, 1875, 3402, 31, 1054]);
  // Battery: 53.2 V, −15.0 A (discharging), SOC 87.3 %, 25.1 °C, power magnitude 798 W
  h.set(0x3140, 532);
  h.set(0x3141, s16(-150));
  h.set(0x3145, 873);
  h.set(0x3146, 251);
  h.set(0x314a, 798);
  h.set(0x3152, s16(-5));
  // Inverter phase B: 230.1 V; frequency B 50.00 Hz
  h.set(0x3193, 2301);
  h.set(0x319a, 5000);
  // Settings
  h.set(0x3400, 2);
  h.set(0x340f, 2);
  h.set(0x3402, 95);
  h.set(0x3445, (1 << 2) | (1 << 4));
  h.set(0x3504, 2230);
  h.set(0x3505, 530);
  return h;
}

test('descriptor: id, read-only, models, console', () => {
  assert.equal(megarevo.id, 'megarevo');
  assert.deepEqual(megarevoDrivers, [megarevo]);
  assert.equal(megarevo.readOnly, true);
  assert.equal(megarevo.defaultBaudRate, 9600);
  assert.deepEqual(megarevo.models!.map((m) => m.id), ['hybrid', 'split', 'three', 'invt_xd']);
  assert.deepEqual(megarevo.consoleFunctions, [{ id: '3', name: 'Holding register' }]);
  for (const m of megarevo.models!) {
    assert.equal(megarevo.socControl!(m.id), null);
    for (const s of megarevoFamily(m.id).settings) assert.equal(s.readOnly, true, `${m.id} ${s.key}`);
  }
});

test('single-phase hybrid: live decode, info and settings through a Solarman logger', async () => {
  const holding = megarevoSingle();
  await withLogger(holding, async (connection) => {
    const d = new MegarevoDriver({ modelId: 'hybrid', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    const info = d.info();
    assert.equal(info['Serial number'], 'F12201000123');
    assert.equal(info['Model name'], 'Megarevo R6KL1');
    assert.equal(info['Firmware version'], '1.02.03');
    assert.equal(info['Secondary firmware version'], '1.00.01');
    assert.equal(info['Protocol version'], '1.01.00');

    const m = await d.read();
    assert.equal(m['Device mode'], 'Hybrid');
    assert.equal(m['Fault code'], 'Grid relay fault');
    assert.equal(m['Warning code'], 'Overload');
    assert.equal(m['PV power'], 2929);
    assert.equal(m['PV voltage 1'], 360.5);
    assert.equal(m['PV current 1'], 5.2);
    assert.equal(m['PV power 2'], 1054);
    assert.equal('PV power 3' in m, false);
    assert.equal(m['Battery voltage'], 53.2);
    assert.equal(m['Battery current'], -15);
    assert.equal(m['Battery power'], -798);
    assert.equal(m['Battery state of charge'], 87);
    assert.equal(m['Battery temperature'], 25.1);
    assert.equal(m['Grid voltage'], 231.2);
    assert.equal(m['Grid power'], 580);
    assert.equal(m['Grid current'], 2.5);
    assert.equal(m['Grid frequency'], 50.01);
    assert.equal(m['Load power'], 1180);
    assert.equal(m['Load percentage'], 23.6);
    assert.equal(m['AC output voltage'], 230.1);
    assert.equal(m['AC output frequency'], 50);
    assert.equal(m.Temperature, 42);

    const s = await d.readSettings();
    assert.equal(s.work_mode, 'Battery priority');
    assert.equal(s.battery_type, 'Lithium');
    assert.equal(s.max_charge_current, 95);
    assert.equal(s.grid_charge, true);
    assert.equal(s.time_of_use, true);
    assert.equal(s.charge_from_solar_only, false);
    assert.equal(s.charge_time_1_start, '22:30');
    assert.equal(s.charge_time_1_end, '05:30');
    assert.ok(d.settingDefs().every((x) => x.readOnly));

    // Raw console reads work; writes are refused and nothing reaches the device.
    assert.deepEqual(await d.rawRead(3, 0x3140, 1), [532]);
    await assert.rejects(d.writeSetting('work_mode', 'Self consumption'), /read-only/);
    await assert.rejects(d.rawWrite(0x3400, [0]), /read-only/);
    assert.equal(holding.get(0x3400), 2);
    await d.close();
  });
});

test('split-phase: L1 = phase A, L2 = phase B, totals and signs', () => {
  const h = new Map<number, number>();
  put(h, 0x3110, [1201, s16(-25), s16(-300), 1198, 17, 200]);
  put(h, 0x3120, [1200, 75, 900, 112, 1199, 58, 700, 87]);
  put(h, 0x3190, [1202, 0, 0, 1201]);
  h.set(0x3199, 6000);
  h.set(0x3119, 5999);
  h.set(0x3104, 2);
  h.set(0x3141, 100);
  h.set(0x314a, s16(-1000));
  const m = decodeLive(megarevoFamily('split'), h);
  assert.equal(m['Device mode'], 'PV grid');
  assert.equal(m['Grid voltage 1'], 120.1);
  assert.equal(m['Grid voltage 2'], 119.8);
  assert.equal(m['Grid voltage'], 120.1);
  assert.equal(m['Grid power 1'], 300);
  assert.equal(m['Grid power 2'], -200);
  assert.equal(m['Grid power'], 100);
  assert.equal(m['Load power 1'], 900);
  assert.equal(m['Load power 2'], 700);
  assert.equal(m['Load power'], 1600);
  assert.equal(m['Load percentage'], 11.2);
  assert.equal(m['AC output voltage 1'], 120.2);
  assert.equal(m['AC output frequency'], 60);
  // Charging current (+) gives the battery power its sign even when the power word is negative.
  assert.equal(m['Battery power'], 1000);
  assert.equal(m['Fault code'], undefined);
});

test('three-phase: per-phase names 1–3', () => {
  const h = new Map<number, number>();
  put(h, 0x3110, [2301, 0, s16(-100), 2302, 0, s16(-110), 2303, 0, 50]);
  put(h, 0x3120, [0, 0, 1000, 0, 0, 0, 1100, 0, 0, 0, 1200, 0]);
  const m = decodeLive(megarevoFamily('three'), h);
  assert.equal(m['Grid voltage 3'], 230.3);
  assert.equal(m['Grid power 3'], -50);
  assert.equal(m['Grid power'], 160);
  assert.equal(m['Load power'], 3300);
});

/** An INVT XD10KTL: PV 4.2 kW, charging 1.5 kW, exporting 300 W. */
function invtMap(): Map<number, number> {
  const h = new Map<number, number>();
  h.set(0x3000, 100);
  put(h, 0x3001, ascii('71XD10KTL2401001'));
  h.set(0x3068, 1);
  put(h, 0x306d, ascii('XD10KTL'));
  h.set(0x3802, 1023);
  h.set(0x3805, 205);
  h.set(0x3806, 2);
  h.set(0x3809, 0);
  h.set(0x3811, 2405);
  h.set(0x381a, 6001);
  put(h, 0x381d, s32(25000));
  h.set(0x3826, s16(452));
  put(h, 0x3827, s32(-3000));
  put(h, 0x3836, [3801, 650, 3702, 470]);
  put(h, 0x3908, s32(15000));
  h.set(0x390a, 512);
  h.set(0x390b, 293);
  h.set(0x393b, 64);
  h.set(0x393c, 99);
  h.set(0x394d, 238);
  put(h, 0x3b01, [24700, 17400]);
  return h;
}

test('INVT XD: decode (s32 high word first, 0.1 W) and info', async () => {
  const holding = invtMap();
  await withLogger(holding, async (connection) => {
    const d = new MegarevoDriver({ modelId: 'invt_xd', connection, baudRate: 9600, address: 1, index: 0 });
    await d.connect();
    const info = d.info();
    assert.equal(info['Serial number'], '71XD10KTL2401001');
    assert.equal(info['Model name'], 'INVT XD10KTL');
    assert.equal(info['Firmware version'], '10.23');
    assert.equal(info['Max AC output power'], 10000);
    const m = await d.read();
    assert.equal(m['Device mode'], 'Grid');
    assert.equal(m['Fault code'], 'None');
    assert.equal(m['PV power 1'], 2470);
    assert.equal(m['PV power'], 4210);
    assert.equal(m['PV current 1'], 6.5);
    assert.equal(m['Battery power'], 1500);
    assert.equal(m['Battery current'], 29.3);
    assert.equal(m['Battery state of charge'], 64);
    assert.equal(m['Grid power'], -300);
    assert.equal(m['Load power'], 2200);
    assert.equal(m['Grid voltage'], 240.5);
    assert.equal(m.Temperature, 45.2);
    assert.equal((await d.readSettings()).active_power_limit, 0);
    await assert.rejects(d.writeSetting('active_power_limit', 50), /read-only/);
    await d.close();
  });
});

test('flexAscii: two characters per register, or one in the low byte', () => {
  assert.equal(flexAscii(ascii('AB12CD')), 'AB12CD');
  assert.equal(flexAscii([0x41, 0x42, 0x31, 0x32, 0, 0]), 'AB12');
  assert.equal(flexAscii([0xffff, 0xffff]), '');
  assert.equal(image(5, [1, 2]).get(6), 2);
});

test('detect: Megarevo single and split, INVT; at most 3 reads', async () => {
  const r = await withConn(megarevoSingle(), async (c, reads) => {
    const out = await megarevo.detect!(c);
    assert.ok(reads() <= 3);
    return out;
  });
  assert.equal(r?.modelId, 'hybrid');
  assert.match(r!.evidence, /F12201000123/);
  assert.match(r!.evidence, /R6KL1/);

  const na = megarevoSingle();
  put(na, 0x121c, ascii('R8KL1NA   '));
  assert.equal((await withConn(na, (c) => megarevo.detect!(c)))?.modelId, 'split');
  const h3 = megarevoSingle();
  put(h3, 0x121c, ascii('R15KH3    '));
  assert.equal((await withConn(h3, (c) => megarevo.detect!(c)))?.modelId, 'three');

  const invt = await withConn(invtMap(), async (c, reads) => {
    const out = await megarevo.detect!(c);
    assert.ok(reads() <= 3);
    return out;
  });
  assert.equal(invt?.modelId, 'invt_xd');
  assert.match(invt!.evidence, /71XD10KTL2401001/);
});

test('detect: rejects blank, 0xFFFF-filled, Deye-like and Growatt-like maps', async () => {
  assert.equal(await withConn(new Map(), (c) => megarevo.detect!(c)), null);
  const ff = new Map<number, number>();
  for (let a = 0x1215; a <= 0x1239; a++) ff.set(a, 0xffff);
  for (let a = 0x3000; a < 0x307d; a++) ff.set(a, 0xffff);
  assert.equal(await withConn(ff, (c) => megarevo.detect!(c)), null);
  const deye = new Map<number, number>([[0, 3]]);
  put(deye, 3, ascii('2106123456'));
  put(deye, 16, [50000, 0]);
  assert.equal(await withConn(deye, (c) => megarevo.detect!(c)), null);
  const growatt = new Map<number, number>();
  put(growatt, 9, ascii('RA1.0 '));
  put(growatt, 23, ascii('XYZ0123456'));
  assert.equal(await withConn(growatt, (c) => megarevo.detect!(c)), null);
  // An INVT that says it's grid-tied (0x3068 = 2) is not a hybrid this driver handles.
  const gridTied = invtMap();
  gridTied.set(0x3068, 2);
  assert.equal(await withConn(gridTied, (c) => megarevo.detect!(c)), null);
});
