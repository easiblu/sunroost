import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { test } from 'node:test';
import { decodeLive, phaseCount, victron } from '../src/devices/inverters/victron/index.ts';
import { ModbusConnection, parseConnection } from '../src/devices/modbus.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const s16 = (v: number) => v & 0xffff;
const ascii = (s: string) => Array.from({ length: Math.ceil(s.length / 2) }, (_, i) => (s.charCodeAt(i * 2) << 8) | (s.charCodeAt(i * 2 + 1) || 0));
const put = (m: Map<number, number>, at: number, words: number[]) => words.forEach((w, i) => m.set(at + i, w));

/**
 * A fake GX: Modbus TCP with one register map per unit id. Unknown units get exception 0x0B
 * (gateway target failed to respond), as the GX does. Records any write attempt.
 */
function fakeGx(units: Record<number, Map<number, number>>) {
  const writes: number[] = [];
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const frame = buf.subarray(0, 6 + len);
        buf = buf.subarray(6 + len);
        const tid = frame.readUInt16BE(0);
        const unit = frame[6];
        const fn = frame[7];
        const start = frame.readUInt16BE(8);
        const map = units[unit];
        let pdu: Buffer;
        if (fn === 6 || fn === 16) writes.push(start);
        if (!map) pdu = Buffer.from([fn | 0x80, 0x0b]);
        else if (fn === 3 || fn === 4) {
          const count = frame.readUInt16BE(10);
          pdu = Buffer.alloc(2 + count * 2);
          pdu[0] = fn;
          pdu[1] = count * 2;
          for (let i = 0; i < count; i++) pdu.writeUInt16BE(map.get(start + i) ?? 0, 2 + i * 2);
        } else pdu = Buffer.from([fn | 0x80, 0x01]);
        const head = Buffer.alloc(7);
        head.writeUInt16BE(tid, 0);
        head.writeUInt16BE(0, 2);
        head.writeUInt16BE(pdu.length + 1, 4);
        head[6] = unit;
        sock.write(Buffer.concat([head, pdu]));
      }
    });
  });
  return { server, writes };
}

async function withGx<T>(units: Record<number, Map<number, number>>, fn: (connection: string, writes: number[]) => Promise<T>) {
  const { server, writes } = fakeGx(units);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`127.0.0.1:${(server.address() as AddressInfo).port}`, writes);
  } finally {
    server.close();
  }
}

/** Single-phase EasySolar-II: 1.2 kW MPPT PV + 300 W AC PV, charging 450 W, importing 120 W. */
function systemMap() {
  const h = new Map<number, number>();
  put(h, 800, ascii('c0619ab1e2f3'));
  put(h, 808, [300, 0, 0]); // AC PV on output
  put(h, 817, [1170, 0, 0]); // consumption
  put(h, 820, [120, 0, 0]); // grid import
  h.set(826, 1);
  put(h, 840, [532, 85, 450, 76, 1]); // 53.2 V, 8.5 A, 450 W, 76 %, charging
  put(h, 850, [1200, 225]);
  h.set(860, s16(-40));
  put(h, 2700, [s16(-50), 0, 0, 0, 0, 70, s16(-1)]);
  put(h, 2900, [2, 300, 1, 200]);
  return h;
}

function vebusMap() {
  const v = new Map<number, number>();
  v.set(3, 2312); // 231.2 V
  v.set(6, 9);
  v.set(9, 4998); // 49.98 Hz
  v.set(12, 12);
  v.set(15, 2301);
  v.set(18, 51);
  v.set(21, 5000);
  v.set(22, 160);
  v.set(23, 117); // 1170 W
  v.set(26, 5318);
  v.set(27, 84);
  v.set(28, 1);
  v.set(30, 760);
  v.set(31, 3); // Bulk
  v.set(32, 0);
  v.set(33, 3); // On
  v.set(37, s16(-200));
  v.set(61, 215);
  return v;
}

test('descriptor: read-only Victron over TCP, unit 100', () => {
  assert.equal(victron.id, 'victron');
  assert.equal(victron.transport, 'tcp');
  assert.equal(victron.readOnly, true);
  assert.equal(victron.defaultAddress, 100);
  assert.deepEqual(victron.models?.map((m) => m.id), ['gx']);
  assert.equal(victron.socControl?.('gx'), null);
  assert.equal(victron.protectionSetting?.('gx'), null);
  const d = victron.create({ modelId: 'gx', connection: '127.0.0.1:502', baudRate: 9600, address: 100, index: 0 });
  assert.ok(d.settingDefs().length >= 5);
  for (const def of d.settingDefs()) assert.equal(def.readOnly, true, def.key);
});

test('single-phase GX end to end: info, live, settings, VE.Bus on 246', async () => {
  await withGx({ 100: systemMap(), 246: vebusMap() }, async (connection, writes) => {
    const d = victron.create({ modelId: 'gx', connection, baudRate: 9600, address: 100, index: 0 });
    await d.connect();
    try {
      const info = d.info();
      assert.equal(info['Serial number'], 'c0619ab1e2f3');
      assert.match(String(info['Model name']), /MultiPlus-II/);
      assert.equal(info['VE.Bus unit id'], 246);

      const m = await d.read();
      assert.equal(m['PV power'], 1500);
      assert.equal(m['PV power 1'], 1200);
      assert.equal(m['PV current 1'], 22.5);
      assert.equal(m['Battery voltage'], 53.2);
      assert.equal(m['Battery current'], 8.5);
      assert.equal(m['Battery power'], 450);
      assert.equal(m['Battery state of charge'], 76);
      assert.equal(m['Grid power'], 120);
      assert.equal(m['Load power'], 1170);
      assert.equal(m['DC system power'], -40);
      assert.equal(m['Grid voltage'], 231.2);
      assert.equal(m['Grid frequency'], 49.98);
      assert.equal(m['AC output voltage'], 230.1);
      assert.equal(m['AC output frequency'], 50);
      assert.equal(m['AC output power'], 1170);
      assert.equal(m['Device mode'], 'Bulk');
      assert.equal(m['Fault code'], 'None');
      assert.equal(m['Battery temperature'], 21.5);
      assert.equal(m['Grid power 1'], undefined, 'single-phase gets no suffixes');

      const s = await d.readSettings();
      assert.equal(s.switch_position, 'On');
      assert.equal(s.ess_minimum_soc, 30);
      assert.equal(s.ess_mode, 'Optimised with phase compensation');
      assert.equal(s.grid_setpoint, -50);
      assert.equal(s.maximum_feed_in_power, -1);
      assert.equal(s.maximum_charge_current, 70);
      assert.equal(s.ess_power_setpoint_l1, -200);

      await assert.rejects(d.writeSetting('switch_position', 'Off'), /read-only/);
      await assert.rejects(d.rawWrite!(33, [4]), /read-only/);
      assert.deepEqual(writes, []);
      assert.deepEqual(await d.rawRead!(3, 843, 1), [76]);
    } finally {
      await d.close();
    }
  });
});

test('system-only GX (no VE.Bus answers) still reports power flows', async () => {
  await withGx({ 100: systemMap() }, async (connection) => {
    const d = victron.create({ modelId: 'gx', connection, baudRate: 9600, address: 100, index: 0 });
    await d.connect();
    try {
      const m = await d.read();
      assert.equal(m['Battery state of charge'], 76);
      assert.equal(m['PV power'], 1500);
      assert.equal(m['Device mode'], undefined);
      assert.equal(d.info()['VE.Bus unit id'], undefined);
    } finally {
      await d.close();
    }
  });
});

test('three-phase decode: suffixed per-phase values, signed grid export', () => {
  const sys = new Map<number, number>();
  put(sys, 808, [100, 200, 300]);
  put(sys, 817, [800, 900, 1000]);
  put(sys, 820, [s16(-500), 50, s16(-100)]);
  put(sys, 840, [512, s16(-200), s16(-1024), 55, 2]);
  put(sys, 850, [0, 0]);
  const vb = new Map<number, number>();
  put(vb, 3, [2300, 2310, 2320]);
  put(vb, 9, [5001]);
  put(vb, 15, [2295, 2305, 2315]);
  put(vb, 18, [35, 39, 43]);
  put(vb, 23, [80, 90, 100]);
  vb.set(28, 3);
  vb.set(31, 10);
  vb.set(32, 26);
  assert.equal(phaseCount(sys, vb), 3);
  const m = decodeLive(sys, vb);
  assert.equal(m['PV power'], 600);
  assert.equal(m['Grid power'], -550);
  assert.equal(m['Grid power 1'], -500);
  assert.equal(m['Grid power 3'], -100);
  assert.equal(m['Load power'], 2700);
  assert.equal(m['Load power 2'], 900);
  assert.equal(m['Grid voltage 2'], 231);
  assert.equal(m['AC output voltage 3'], 231.5);
  assert.equal(m['AC output current 1'], 3.5);
  assert.equal(m['AC output power'], 2700);
  assert.equal(m['Battery current'], -20);
  assert.equal(m['Battery power'], -1024);
  assert.equal(m['Battery state'], 'Discharging');
  assert.equal(m['Device mode'], 'Power assist');
  assert.equal(m['Fault code'], 'Internal error');
});

test('L2 non-zero without a phase count still splits phases', () => {
  const sys = new Map<number, number>();
  put(sys, 817, [500, 400, 0]);
  assert.equal(phaseCount(sys, null), 2);
  const m = decodeLive(sys, null);
  assert.equal(m['Load power 2'], 400);
  assert.equal(m['Load power 3'], undefined);
});

async function probe(holding: Map<number, number>) {
  const server = fakeLogger({ serial: 9, holding });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const conn = new ModbusConnection(parseConnection(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/9`, 9600, 1));
  await conn.connect();
  try {
    return await victron.detect!(conn);
  } finally {
    await conn.close();
    server.close();
  }
}

test('detect accepts a GX on unit 100 and reports address 100', async () => {
  await withGx({ 100: systemMap(), 227: vebusMap() }, async (connection) => {
    const conn = new ModbusConnection(parseConnection(connection, 9600, 1));
    await conn.connect();
    try {
      const r = await victron.detect!(conn);
      assert.ok(r);
      assert.equal(r.modelId, 'gx');
      assert.equal(r.address, 100);
      assert.match(r.evidence, /c0619ab1e2f3/);
    } finally {
      await conn.close();
    }
  });
  const minimal = new Map<number, number>();
  put(minimal, 800, ascii('c0619ab1e2f3'));
  put(minimal, 840, [532, 0, 0, 76]);
  assert.ok(await probe(minimal));
});

test('detect rejects blank, 0xFFFF, implausible battery, Deye-like and Growatt-like maps', async () => {
  assert.equal(await probe(new Map()), null);
  const ff = new Map<number, number>();
  for (let a = 800; a < 806; a++) ff.set(a, 0xffff);
  put(ff, 840, [0xffff, 0xffff, 0xffff, 0xffff]);
  assert.equal(await probe(ff), null);
  const badBatt = new Map<number, number>();
  put(badBatt, 800, ascii('c0619ab1e2f3'));
  put(badBatt, 840, [532, 0, 0, 150]);
  assert.equal(await probe(badBatt), null);
  const lowV = new Map<number, number>();
  put(lowV, 800, ascii('c0619ab1e2f3'));
  put(lowV, 840, [0, 0, 0, 50]);
  assert.equal(await probe(lowV), null);
  const deye = new Map<number, number>();
  deye.set(0, 3);
  put(deye, 3, ascii('2106123456'));
  assert.equal(await probe(deye), null);
  const growatt = new Map<number, number>();
  put(growatt, 9, ascii('RA1.0 '));
  put(growatt, 23, ascii('XYZ0123456'));
  assert.equal(await probe(growatt), null);
  // Nothing answers on unit 100 at all.
  await withGx({ 1: systemMap() }, async (connection) => {
    const conn = new ModbusConnection(parseConnection(connection, 9600, 1));
    await conn.connect();
    try {
      assert.equal(await victron.detect!(conn), null);
    } finally {
      await conn.close();
    }
  });
});
