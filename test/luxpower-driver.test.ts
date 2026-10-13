import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import modbusSerial from 'modbus-serial';
import { ModbusConnection } from '../src/devices/modbus.ts';
import {
  decodeRange, detectLuxpower, fakeDongle, LuxDongleClient, luxConnection, luxpower, luxpowerDrivers, parseLuxConnection,
} from '../src/devices/inverters/luxpower/index.ts';
import { decodeTable, deriveLive, image, INPUT } from '../src/devices/inverters/luxpower/registers.ts';
import { encodeRequest, splitPackets, parseReplyData, encodePacket } from '../src/devices/inverters/luxpower/dongle.ts';

const ascii = (text: string, words: number) => {
  const out: number[] = [];
  for (let i = 0; i < words; i++) out.push(((text.charCodeAt(i * 2) || 0) << 8) | (text.charCodeAt(i * 2 + 1) || 0));
  return out;
};
const put = (m: Map<number, number>, start: number, values: number[]) => values.forEach((v, i) => m.set(start + i, v));
const s16 = (v: number) => (v < 0 ? v + 0x10000 : v);

/** A realistic EG4 18kPV-ish snapshot: PV 3.2 kW, charging 1.2 kW, exporting 400 W. */
function luxMaps() {
  const input = new Map<number, number>();
  const holding = new Map<number, number>();
  put(input, 0, [
    0x0c, // PV charge on-grid
    3805, 3620, 0, // Vpv 380.5, 362.0, 0
    532, // Vbat 53.2
    (98 << 8) | 76, // SOH 98, SOC 76
    0,
    1800, 1400, 0, // Ppv
    1200, 0, // charge, discharge
    2412, 0, 0, // grid 241.2 V
    6001, // 60.01 Hz
    2000, 0, // Pinv, Prec
    830, 990,
    2405, 0, 0, 6000, // EPS 240.5 V 60.00 Hz
    300, 320, // EPS power, apparent
    400, 0, // to grid, to user
  ]);
  put(input, 60, [0x0010, 0x0001]); // fault 0x00010010 (low word first)
  put(input, 64, [38, 41, 40, s16(-3)]); // internal 38 °C, battery −3 °C
  put(input, 40, [0x86a0, 0x0001]); // PV1 total 100000 × 0.1 = 10000 kWh
  put(input, 127, [1202, 1203, 140, 160]);
  put(holding, 0, [0x0123, 0x4567]);
  put(holding, 2, ascii('4512670118', 5));
  put(holding, 7, ascii('FAAB', 2));
  put(holding, 9, [0x0a0b, 0x0c0d]);
  holding.set(15, 1);
  put(holding, 115, ascii('4512670118', 5));
  holding.set(21, (1 << 0) | (1 << 7) | (1 << 15)); // EPS, AC charge, feed-in
  holding.set(64, 100);
  holding.set(67, 90);
  holding.set(68, (30 << 8) | 1); // 01:30
  holding.set(69, (0 << 8) | 5); // 05:00
  holding.set(99, 576); // 57.6 V
  holding.set(101, 150);
  holding.set(105, 20);
  return { input, holding };
}

test('decodes live values with scaling, packed bytes and signed values', () => {
  const { input } = luxMaps();
  const m = deriveLive(decodeTable(INPUT, input), { pv: true });
  assert.equal(m['Device mode'], 'PV charge on-grid');
  assert.equal(m['PV voltage 1'], 380.5);
  assert.equal(m['PV power 1'], 1800);
  assert.equal(m['PV current 1'], 4.7);
  assert.equal(m['PV power'], 3200);
  assert.equal(m['PV power 3'], undefined, 'idle third string hidden');
  assert.equal(m['Battery voltage'], 53.2);
  assert.equal(m['Battery state of charge'], 76);
  assert.equal(m['Battery state of health'], 98);
  assert.equal(m['Battery power'], 1200);
  assert.equal(m['Battery current'], 22.6);
  assert.equal(m['Battery temperature'], -3);
  assert.equal(m['Grid voltage'], 241.2);
  assert.equal(m['Grid frequency'], 60.01);
  assert.equal(m['Grid power'], -400);
  assert.equal(m['Load power non-essential'], 1600);
  assert.equal(m['Load power essential'], 300);
  assert.equal(m['Load power'], 1900);
  assert.equal(m['Load apparent power'], 320);
  assert.equal(m['AC output voltage'], 240.5);
  assert.equal(m['AC output frequency'], 60);
  assert.equal(m['AC output voltage 1'], 120.2);
  assert.equal(m['Load power 2'], 160);
  assert.equal(m['Fault code'], 0x00010010);
  assert.equal(m.Temperature, 38);
  assert.equal(decodeTable(INPUT, input)['PV1 energy total'], 10000);

  const ac = deriveLive(decodeTable(INPUT, input), { pv: false });
  assert.equal(ac['PV power'], undefined);
  assert.equal(ac['Battery power'], 1200);

  const discharging = image(10, [0, 2500]);
  for (const [k, v] of input) if (k !== 10 && k !== 11) discharging.set(k, v);
  assert.equal(deriveLive(decodeTable(INPUT, discharging), { pv: true })['Battery power'], -2500);
});

test('descriptor contract: read-only, 19200 baud, models, console', () => {
  assert.deepEqual(luxpowerDrivers, [luxpower]);
  assert.equal(luxpower.id, 'luxpower');
  assert.equal(luxpower.readOnly, true);
  assert.equal(luxpower.defaultBaudRate, 19200);
  assert.deepEqual(luxpower.models?.map((m) => m.id), ['hybrid', 'ac']);
  assert.deepEqual(luxpower.consoleFunctions?.map((f) => f.id), ['4', '3']);
  assert.equal(luxpower.socControl!('hybrid'), null);
  const d = luxpower.create({ modelId: 'hybrid', connection: '/dev/null', baudRate: 19200, address: 1, index: 0 });
  assert.ok(d.settingDefs().length > 20);
  assert.ok(d.settingDefs().every((s) => s.readOnly === true));
  assert.ok(d.settingDefs().every((s) => !('reg' in s)));
  assert.equal(decodeRange(4, 0, [0x10])['Status'], 'Battery on-grid');
});

test('connection strings', () => {
  assert.deepEqual(parseLuxConnection('luxpower://192.168.1.50/BA12345678/4512670118'), {
    host: '192.168.1.50', port: 8000, dongleSerial: 'BA12345678', inverterSerial: '4512670118',
  });
  assert.deepEqual(parseLuxConnection('luxpower://lux.local:8001/BA12345678'), {
    host: 'lux.local', port: 8001, dongleSerial: 'BA12345678', inverterSerial: '',
  });
  assert.equal(parseLuxConnection('luxpower://1.2.3.4/short'), null);
  assert.equal(parseLuxConnection('192.168.1.50:502'), null);
  assert.equal(luxConnection('10.0.0.2', 'BA12345678'), 'luxpower://10.0.0.2/BA12345678');
});

test('dongle frames: request layout, CRC and reply parsing', () => {
  const data = encodeRequest(4, '4512670118', 40, 40);
  assert.equal(data.length, 18);
  assert.equal(data[0], 0);
  assert.equal(data[1], 4);
  assert.equal(data.subarray(2, 12).toString(), '4512670118');
  assert.equal(data.readUInt16LE(12), 40);
  assert.equal(data.readUInt16LE(14), 40);
  const pkt = encodePacket(0xc2, 'BA12345678', data);
  assert.equal(pkt.length, 38);
  assert.deepEqual([...pkt.subarray(0, 2)], [0xa1, 0x1a]);
  assert.equal(pkt.readUInt16LE(4), 32);
  assert.equal(pkt[7], 0xc2);
  // Split works across garbage and partial packets.
  const { packets, rest } = splitPackets(Buffer.concat([Buffer.from([1, 2, 3]), pkt, pkt.subarray(0, 10)]));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].dongleSerial, 'BA12345678');
  assert.equal(rest.length, 10);
  const bad = Buffer.from(data);
  bad[5] ^= 0xff;
  assert.throws(() => parseReplyData(bad), /CRC/);
});

test('detect accepts a Luxpower map and rejects blank, 0xFFFF and Deye maps', async () => {
  const lux = luxMaps();
  const deye = { input: new Map<number, number>(), holding: new Map<number, number>() };
  deye.holding.set(0, 3);
  deye.holding.set(2, 0);
  put(deye.holding, 3, ascii('AB12345678', 5));
  const ffff = { input: new Map<number, number>(), holding: new Map<number, number>() };
  for (let i = 0; i < 200; i++) {
    ffff.holding.set(i, 0xffff);
    ffff.input.set(i, 0xffff);
  }
  const growatt = { input: new Map<number, number>(), holding: new Map<number, number>() };
  put(growatt.holding, 9, ascii('RAA1.0', 3));
  put(growatt.holding, 23, ascii('GW12345678', 5));

  const holdingOnly115 = luxMaps();
  holdingOnly115.holding.set(7, 0); // no firmware code
  const lowOnly = luxMaps();
  put(lowOnly.holding, 115, [0, 0, 0, 0, 0]);
  const deyeNoFw = { input: new Map<number, number>(), holding: new Map<number, number>() };
  put(deyeNoFw.holding, 3, ascii('AB12345678', 5)); // ASCII at 3–7 with holding 0 = 0

  const results: Record<string, unknown> = {};
  let port = 17000 + Math.floor(Math.random() * 800);
  for (const [name, maps] of Object.entries({
    lux, deye, ffff, growatt, blank: { input: new Map(), holding: new Map() }, holdingOnly115, lowOnly, deyeNoFw,
  })) {
    const server = new modbusSerial.ServerTCP(
      {
        getHoldingRegister: (addr: number) => maps.holding.get(addr) ?? 0,
        getInputRegister: (addr: number) => maps.input.get(addr) ?? 0,
        setRegister: () => {
          throw new Error('detect must not write');
        },
      },
      { host: '127.0.0.1', port: ++port, unitID: 1 },
    );
    await once(server, 'initialized');
    const conn = new ModbusConnection({ type: 'tcp', host: '127.0.0.1', port, address: 1, timeoutMs: 1000 });
    await conn.connect();
    let reads = 0;
    const orig = conn.read.bind(conn);
    conn.read = (fn, start, count) => {
      reads++;
      return orig(fn, start, count);
    };
    try {
      results[name] = await detectLuxpower(conn);
      assert.ok(reads <= 3, `${name}: ${reads} requests`);
    } finally {
      await conn.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  assert.match((results.lux as { evidence: string }).evidence, /serial 4512670118 \(holding 115\), firmware FAAB/);
  assert.ok(results.holdingOnly115, 'serial at holding 115 alone is enough');
  assert.match((results.lowOnly as { evidence: string }).evidence, /holding 2/);
  for (const k of ['deye', 'ffff', 'growatt', 'blank', 'deyeNoFw']) assert.equal(results[k], null, k);
});

let dongle: ReturnType<typeof fakeDongle>;
let dongleMaps: ReturnType<typeof luxMaps>;
let donglePort = 0;

before(async () => {
  dongleMaps = luxMaps();
  dongle = fakeDongle({ dongleSerial: 'BA12345678', inverterSerial: '4512670118', ...dongleMaps, noise: true });
  dongle.listen(0, '127.0.0.1');
  await once(dongle, 'listening');
  donglePort = (dongle.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => dongle.close(() => resolve()));
});

test('dongle round trip: info, live data, settings; writes refused', async () => {
  const driver = luxpower.create({
    modelId: 'hybrid', connection: luxConnection('127.0.0.1', 'BA12345678', '', donglePort), baudRate: 19200, address: 1, index: 0,
  });
  await driver.connect();
  try {
    const info = driver.info();
    assert.equal(info['Serial number'], '4512670118');
    assert.equal(info['Firmware version'], 'FAAB-0A0B-0C0D');
    assert.equal(info['Model name'], 'Luxpower hybrid');

    const m = await driver.read();
    assert.equal(m['Battery state of charge'], 76);
    assert.equal(m['Grid power'], -400);
    assert.equal(m['PV power'], 3200);

    const s = await driver.readSettings();
    assert.equal(s.grid_charge, true);
    assert.equal(s.forced_discharge, false);
    assert.equal(s.eps_output, true);
    assert.equal(s.grid_charge_stop_capacity, 90);
    assert.equal(s.absorption_charge_voltage, 57.6);
    assert.equal(s.max_charge_current, 150);
    assert.equal(s.stop_discharge_capacity, 20);
    assert.equal(s.grid_charge_slot_1, '01:30,05:00,true');
    assert.equal(s.grid_charge_slot_2, '00:00,00:00,false');

    const before = new Map(dongleMaps.holding);
    await assert.rejects(driver.writeSetting('max_charge_current', 100), /read-only/);
    await assert.rejects(driver.rawWrite!(101, [100]), /read-only/);
    assert.deepEqual(dongleMaps.holding, before);

    assert.deepEqual(await driver.rawRead!(3, 101, 1), [150]);
  } finally {
    await driver.close();
  }
});

test('dongle client: write path and serial filtering', async () => {
  const target = parseLuxConnection(`luxpower://127.0.0.1:${donglePort}/BA12345678/4512670118`)!;
  const client = new LuxDongleClient(target, 1000);
  await client.connect();
  try {
    assert.deepEqual(await client.read(4, 4, 2), [532, (98 << 8) | 76]);
    // The transport can write (the driver never calls it); check against a throwaway register.
    await client.write(190, [7]);
    await client.write(191, [8, 9]);
    assert.deepEqual(await client.read(3, 190, 3), [7, 8, 9]);
  } finally {
    await client.close();
  }
  const wrong = new LuxDongleClient({ ...target, inverterSerial: '9999999999' }, 300);
  await wrong.connect();
  try {
    await assert.rejects(wrong.read(4, 0, 1), /No reply/);
  } finally {
    await wrong.close();
  }
});
