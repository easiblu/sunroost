import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { test } from 'node:test';
import { decodeLive, detectSigenergy, modelFromName, sigenergy, sigenModel } from '../src/devices/inverters/sigenergy/index.ts';
import { image } from '../src/devices/inverters/sigenergy/registers.ts';
import { decodeSettings, SIGEN_SETTINGS } from '../src/devices/inverters/sigenergy/settings.ts';
import { ModbusConnection } from '../src/devices/modbus.ts';
import { INVERTER_DRIVERS } from '../src/devices/registry.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

type Regs = Map<number, number>;
interface Unit { input: Regs; holding: Regs }

function ascii(into: Regs, start: number, s: string, words: number) {
  const padded = s.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into.set(start + i, (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}
function u32(into: Regs, addr: number, v: number) {
  const x = v < 0 ? v + 0x100000000 : v;
  into.set(addr, Math.floor(x / 0x10000));
  into.set(addr + 1, x & 0xffff);
}
const s16 = (v: number) => v & 0xffff;

/** A SigenStor EC 10.0 TP exporting 1.5 kW while charging 2.2 kW from 6.4 kW PV. */
function plantMap(): Unit {
  const input: Regs = new Map();
  input.set(30003, 0);
  input.set(30004, 1);
  u32(input, 30005, -1500);
  input.set(30009, 0);
  input.set(30014, 653);
  for (let a = 30027; a <= 30030; a++) input.set(a, 0);
  u32(input, 30031, 4200);
  u32(input, 30035, 6400);
  u32(input, 30037, 2200);
  input.set(30051, 1);
  u32(input, 30052, -400);
  u32(input, 30054, -600);
  u32(input, 30056, -500);
  const holding: Regs = new Map();
  holding.set(40029, 0);
  holding.set(40030, 0);
  holding.set(40031, 2);
  u32(holding, 40032, 10000);
  u32(holding, 40034, 0xffffffff);
  u32(holding, 40038, 5000);
  holding.set(40046, 200);
  holding.set(40047, 1000);
  holding.set(40048, 50);
  return { input, holding };
}

function inverterMap(model = 'SigenStor EC 10.0 TP'): Unit {
  const input: Regs = new Map();
  ascii(input, 30500, model, 15);
  ascii(input, 30515, '110A12345678AB', 10);
  ascii(input, 30525, 'V100R001C00SPC112', 15);
  u32(input, 30540, 10000);
  u32(input, 30548, 1610);
  input.set(30578, 1);
  u32(input, 30587, 4200);
  u32(input, 30599, 2200);
  input.set(30601, 652);
  input.set(30602, 995);
  input.set(30603, s16(-35));
  input.set(30604, 3312);
  input.set(31002, 5001);
  input.set(31003, 412);
  input.set(31004, 2);
  u32(input, 31011, 23150);
  u32(input, 31013, 23280);
  u32(input, 31015, 22990);
  u32(input, 31017, 612);
  u32(input, 31019, -12);
  u32(input, 31021, 598);
  input.set(31025, 2);
  input.set(31027, 3850);
  input.set(31028, 920);
  input.set(31029, 4010);
  input.set(31030, 712);
  u32(input, 31035, 6400);
  return { input, holding: new Map() };
}

/** A minimal Modbus TCP server with per-unit register maps (unknown unit → exception 0x0B). */
function fakeModbusTcp(units: Record<number, Unit>) {
  const writes: number[] = [];
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 7) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const frame = buf.subarray(0, 6 + len);
        buf = buf.subarray(6 + len);
        const unit = frame[6];
        const fn = frame[7];
        const start = frame.readUInt16BE(8);
        const u = units[unit];
        let pdu: Buffer;
        if (!u) pdu = Buffer.from([fn | 0x80, 0x0b]);
        else if (fn === 3 || fn === 4) {
          const count = frame.readUInt16BE(10);
          const m = fn === 3 ? u.holding : u.input;
          pdu = Buffer.alloc(2 + count * 2);
          pdu[0] = fn;
          pdu[1] = count * 2;
          for (let i = 0; i < count; i++) pdu.writeUInt16BE(m.get(start + i) ?? 0, 2 + i * 2);
        } else {
          writes.push(start);
          pdu = Buffer.from([fn | 0x80, 0x01]);
        }
        const head = Buffer.alloc(7);
        frame.copy(head, 0, 0, 4);
        head.writeUInt16BE(pdu.length + 1, 4);
        head[6] = unit;
        sock.write(Buffer.concat([head, pdu]));
      }
    });
  });
  return { server, writes };
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('model ids from model type strings', () => {
  assert.equal(modelFromName('SigenStor EC 10.0 TP'), 'hybrid3');
  assert.equal(modelFromName('SigenStor EC 6.0 SP'), 'hybrid');
  assert.equal(modelFromName('SigenStor EC 30.0 TP AU'), 'hybrid3');
  assert.equal(modelFromName('Sigen something'), undefined);
});

test('decodes plant totals, signed 32-bit power and per-phase values', () => {
  const p = plantMap();
  const inv = inverterMap();
  const m = decodeLive(sigenModel('hybrid3'), p.input, inv.input);
  assert.equal(m['Grid power'], -1500);
  assert.equal(m['PV power'], 6400);
  assert.equal(m['Battery power'], 2200);
  assert.equal(m['Battery state of charge'], 65.3);
  assert.equal(m['Inverter power'], 4200);
  assert.equal(m['Load power'], 2700);
  assert.equal(m['Device mode'], 'Running');
  assert.equal(m['EMS work mode'], 'Max self consumption');
  assert.equal(m['Fault code'], 'None');
  assert.equal(m['Battery state of health'], 99.5);
  assert.equal(m['Battery temperature'], -3.5);
  assert.equal(m['Grid frequency'], 50.01);
  assert.equal(m.Temperature, 41.2);
  assert.equal(m['Grid voltage 1'], 231.5);
  assert.equal(m['Grid voltage 3'], 229.9);
  assert.equal(m['Grid voltage'], 231.5);
  assert.equal(m['AC output current 2'], -0.12);
  assert.equal(m['Grid power 2'], -600);
  assert.equal(m['PV voltage 1'], 385);
  assert.equal(m['PV current 1'], 9.2);
  assert.equal(m['PV power 1'], 3542);
  assert.equal(m['PV power 2'], 2855);
  assert.equal(m['PV voltage 3'], undefined);

  // Single-phase: no numbered phase metrics; off-grid running → Off-grid; alarms surface.
  p.input.set(30009, 1);
  p.input.set(30028, 0x0010);
  const s = decodeLive(sigenModel('hybrid'), p.input, inv.input);
  assert.equal(s['Grid voltage 2'], undefined);
  assert.equal(s['Grid power 1'], undefined);
  assert.equal(s['AC output current'], 6.12);
  assert.equal(s['Device mode'], 'Off-grid');
  assert.equal(s['Fault code'], 'A2:0x0010');
});

test('settings decode (u32 kW, no-limit, SOC) and are all read-only', () => {
  const v = decodeSettings(SIGEN_SETTINGS, plantMap().holding);
  assert.equal(v.remote_ems, false);
  assert.equal(v.remote_ems_control_mode, 'Max self consumption');
  assert.equal(v.max_charge_power, 10);
  assert.equal(v.max_discharge_power, null);
  assert.equal(v.max_export_power, 5);
  assert.equal(v.backup_soc, 20);
  assert.equal(v.charge_cut_off_soc, 100);
  assert.equal(v.discharge_cut_off_soc, 5);
  assert.ok(SIGEN_SETTINGS.every((s) => s.readOnly));
  assert.equal(sigenergy.readOnly, true);
  assert.equal(sigenergy.defaultAddress, 247);
  assert.equal(sigenergy.transport, 'tcp');
});

test('driver end to end over Modbus TCP: plant on unit 247, inverter on unit 1, writes refused', async () => {
  const { server, writes } = fakeModbusTcp({ 247: plantMap(), 1: inverterMap() });
  const port = await listen(server);
  const driver = sigenergy.create({ modelId: 'hybrid3', connection: `127.0.0.1:${port}`, baudRate: 0, address: 247, index: 0 });
  try {
    await driver.connect();
    const info = driver.info();
    assert.equal(info['Serial number'], '110A12345678AB');
    assert.equal(info['Model name'], 'SigenStor EC 10.0 TP');
    assert.equal(info['Firmware version'], 'V100R001C00SPC112');
    assert.equal(info['Battery capacity'], 16.1);
    const m = await driver.read();
    assert.equal(m['Grid power'], -1500);
    assert.equal(m['Battery state of charge'], 65.3);
    assert.equal(m['Grid voltage 2'], 232.8);
    const s = await driver.readSettings();
    assert.equal(s.backup_soc, 20);
    assert.deepEqual(await driver.rawRead!(4, 30014, 1), [653]);
    assert.deepEqual(await driver.rawRead!(4, 30601, 1), [652]);
    await assert.rejects(driver.writeSetting('backup_soc', 30), /read-only/);
    await assert.rejects(driver.rawWrite!(40046, [300]), /read-only/);
    assert.deepEqual(writes, []);
  } finally {
    await driver.close();
    server.close();
  }
});

test('detect accepts a SigenStor over Modbus TCP and reports address 247', async () => {
  for (const [model, id] of [['SigenStor EC 10.0 TP', 'hybrid3'], ['SigenStor EC 6.0 SP', 'hybrid']]) {
    const { server } = fakeModbusTcp({ 247: plantMap(), 1: inverterMap(model) });
    const port = await listen(server);
    const conn = new ModbusConnection({ type: 'tcp', host: '127.0.0.1', port, address: 247 });
    await conn.connect();
    try {
      const r = await detectSigenergy(conn);
      assert.ok(r);
      assert.equal(r.modelId, id);
      assert.equal(r.address, 247);
      assert.match(r.evidence, /serial 110A12345678AB/);
      assert.match(r.evidence, /65\.3%/);
    } finally {
      await conn.close();
      server.close();
    }
  }
});

async function detectOn(holding: Regs, input: Regs) {
  const server = fakeLogger({ serial: 9, holding, input });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const conn = new ModbusConnection({ type: 'solarman', host: '127.0.0.1', port: (server.address() as AddressInfo).port, loggerSerial: 9, address: 1, timeoutMs: 500 });
  await conn.connect();
  try {
    return await detectSigenergy(conn).catch(() => null);
  } finally {
    await conn.close();
    server.close();
  }
}

test('detect rejects blank, 0xFFFF, Deye-like, Growatt-like and non-Sigenergy images', async () => {
  assert.equal(await detectOn(new Map(), new Map()), null);
  const ff: Regs = new Map();
  for (let a = 30500; a < 30525; a++) ff.set(a, 0xffff);
  assert.equal(await detectOn(new Map(), ff), null);
  const deye: Regs = new Map([[0, 3]]);
  ascii(deye, 3, '2106123456', 5);
  assert.equal(await detectOn(deye, new Map()), null);
  const growatt: Regs = new Map();
  ascii(growatt, 9, 'RA1.0 ', 3);
  ascii(growatt, 23, 'XYZ0123456', 5);
  assert.equal(await detectOn(growatt, new Map()), null);
  const other: Regs = new Map();
  ascii(other, 30500, 'SUN2000-10KTL', 15);
  ascii(other, 30515, 'ABCD12345678', 10);
  assert.equal(await detectOn(new Map(), other), null);
  // Model OK but no serial.
  const noSerial: Regs = new Map();
  ascii(noSerial, 30500, 'SigenStor EC 6.0 SP', 15);
  assert.equal(await detectOn(new Map(), noSerial), null);
  // Implausible plant SOC.
  const badSoc = inverterMap().input;
  badSoc.set(30014, 5000);
  assert.equal(await detectOn(new Map(), badSoc), null);
  // Minimal identity image (as for the cross-check test) is accepted.
  const minimal: Regs = new Map();
  ascii(minimal, 30500, 'SigenStor EC 10.0 TP', 15);
  ascii(minimal, 30515, '110A12345678AB', 10);
  minimal.set(30014, 650);
  const r = await detectOn(new Map(), minimal);
  assert.equal(r?.modelId, 'hybrid3');
});

test('no other registered driver claims a Sigenergy identity image', async () => {
  const input: Regs = new Map();
  ascii(input, 30500, 'SigenStor EC 10.0 TP', 15);
  ascii(input, 30515, '110A12345678AB', 10);
  input.set(30014, 650);
  const server = fakeLogger({ serial: 9, holding: new Map(), input });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const conn = new ModbusConnection({ type: 'solarman', host: '127.0.0.1', port: (server.address() as AddressInfo).port, loggerSerial: 9, address: 1, timeoutMs: 500 });
  await conn.connect();
  try {
    for (const d of INVERTER_DRIVERS.filter((x) => x.detect && x.id !== 'sigenergy')) {
      const r = await d.detect!(conn).catch(() => null);
      assert.equal(r, null, `${d.id} claimed a Sigenergy image: ${r?.evidence}`);
    }
  } finally {
    await conn.close();
    server.close();
  }
});

test('image helper masks to 16 bits', () => {
  assert.equal(image(1, [-1]).get(1), 0xffff);
});
