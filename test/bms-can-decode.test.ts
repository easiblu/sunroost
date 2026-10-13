import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as can from '../src/devices/bms/can/decode.ts';
import { encodeWaveshare, type CanFrame } from '../src/devices/bms/can/frames.ts';
import { CanBms, canBitrate, canBmsDriver, resolveCanSetup } from '../src/devices/bms/can/index.ts';
import { SerialCanSource, type CanSource, type RawPort } from '../src/devices/bms/can/sources.ts';

const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');
const fr = (id: number, h: string): CanFrame => ({ id, ext: false, rtr: false, data: hex(h) });

test('0x351 limits', () => {
  // 53.2 V, 50.0 A, 100.0 A, 47.0 V
  assert.deepEqual(roundAll(can.decode351(hex('1402 f401 e803 d601'))), {
    chargeVoltage: 53.2, chargeCurrent: 50, dischargeCurrent: 100, dischargeVoltage: 47,
  });
});

test('0x355 SOC/SOH', () => {
  assert.deepEqual(can.decode355(hex('5500 6300')), { soc: 85, soh: 99 });
});

test('0x356 voltage/current/temperature (signed)', () => {
  // 52.10 V, -12.5 A, -3.5 °C
  assert.deepEqual(roundAll(can.decode356(hex('5a14 83ff ddff'))), { voltage: 52.1, current: -12.5, temperature: -3.5 });
});

test('0x359 alarms and module count', () => {
  const r = can.decode359(hex('04 01 08 08 03 50 4e'));
  assert.deepEqual(r.alarms, ['Under voltage protection', 'Charge over current protection', 'High temperature alarm', 'Internal communication failure']);
  assert.equal(r.modules, 3);
  assert.deepEqual(can.decode359(hex('0000000002504e')), { alarms: [], modules: 2 });
});

test('0x35C flags', () => {
  assert.deepEqual(can.decode35C(hex('c0 00')), { chargeEnable: true, dischargeEnable: true, forceCharge1: false, forceCharge2: false, fullCharge: false });
  assert.equal(can.decode35C(hex('60')).forceCharge1, true);
  assert.equal(can.decode35C(hex('60')).chargeEnable, false);
});

test('0x35E manufacturer', () => {
  assert.equal(can.decode35E(Buffer.from('PYLON   ')), 'PYLON');
  assert.equal(can.decode35E(Buffer.from('SOLARMD\0')), 'SOLARMD');
});

test('0x370 / 0x371 Sunsynk cell extremes', () => {
  // 28.5 °C, 21.0 °C, 3.345 V, 3.312 V
  assert.deepEqual(roundAll(can.decode370(hex('1d01 d200 110d f00c'))), { cellTempMax: 28.5, cellTempMin: 21, cellVoltageMax: 3.345, cellVoltageMin: 3.312 });
  assert.deepEqual(can.decode371(hex('0300 0700 0100 1000')), { cellTempMaxId: 3, cellTempMinId: 7, cellVoltageMaxId: 1, cellVoltageMinId: 16 });
});

test('0x373 / 0x379 extended frames', () => {
  // 3.300 V, 3.350 V, 293.15 K, 303.15 K → 20 / 30 °C
  const r = can.decode373(hex('e40c 160d 2501 2f01'));
  assert.equal(Math.round((r.cellVoltageMin ?? 0) * 1000), 3300);
  assert.equal(Math.round((r.cellVoltageMax ?? 0) * 1000), 3350);
  assert.equal(Math.round(r.cellTempMin ?? 0), 20);
  assert.equal(Math.round(r.cellTempMax ?? 0), 30);
  assert.deepEqual(can.decode379(hex('c800')), { capacityAh: 200 });
});

test('CanBank combines a broadcast cycle into one pack', () => {
  const bank = new can.CanBank();
  for (const f of [
    fr(0x351, '1402 f401 e803 d601'),
    fr(0x355, '5500 6300'),
    fr(0x356, '5a14 83ff 0e01'),
    fr(0x359, '0000000002504e'),
    fr(0x35c, 'c0'),
    fr(0x35e, Buffer.from('PYLON   ').toString('hex')),
    fr(0x370, '1d01 d200 110d f00c'),
  ]) assert.equal(bank.apply(f), true);
  assert.equal(bank.apply(fr(0x305, '0000000000000000')), false); // inverter keep-alive
  const m = bank.metrics();
  assert.equal(m['Model name'], 'PYLON');
  assert.equal(m['State of charge'], 85);
  assert.equal(m['State of health'], 99);
  assert.equal(m.Voltage, 52.1);
  assert.equal(m.Current, -12.5);
  assert.equal(m.Power, -651);
  assert.equal(m.Temperature, 27);
  assert.equal(m['Device mode'], 'Discharging');
  assert.equal(m['Recommended charge voltage'], 53.2);
  assert.equal(m['Max charge current'], 50);
  assert.equal(m['Max discharge current'], 100);
  assert.equal(m.Alarms, '');
  assert.equal(m['Module count'], 2);
  assert.equal(m['Charge enabled'], 'Yes');
  assert.equal(m['Cell voltage - Highest'], 3.345);
  assert.equal(m['Cell voltage - Lowest'], 3.312);
  assert.equal(m['Cell voltage - Difference'], 0.033);
  assert.equal(m['Cell temperature - Highest'], 28.5);
  assert.equal(m['Cell temperature - Lowest'], 21);
});

test('setup resolution: adapters, interfaces, bitrate', () => {
  assert.deepEqual(resolveCanSetup({ connection: 'can0', baudRate: 500000 }), { kind: 'socketcan', iface: 'can0', bitrate: 500000 });
  assert.deepEqual(resolveCanSetup({ connection: '/dev/ttyUSB0', baudRate: 500000 }), { kind: 'serial', path: '/dev/ttyUSB0', adapter: 'auto', bitrate: 500000 });
  assert.deepEqual(resolveCanSetup({ connection: '', iface: 'can1', baudRate: 250000 }), { kind: 'socketcan', iface: 'can1', bitrate: 250000 });
  assert.deepEqual(resolveCanSetup({ connection: '/dev/ttyUSB0', adapter: 'socketcan', iface: 'can0', baudRate: 0 }), { kind: 'socketcan', iface: 'can0', bitrate: 500000 });
  assert.equal(resolveCanSetup({ connection: '/dev/ttyUSB1', adapter: 'seeed', baudRate: 1000000 }).kind, 'serial');
  assert.throws(() => resolveCanSetup({ connection: 'can0', adapter: 'waveshare', baudRate: 500000 }));
  assert.equal(canBitrate(2_000_000), 500_000); // "2 Mbps" is the serial speed, not a CAN bitrate
  assert.equal(canBitrate(1_000_000), 1_000_000);
  assert.equal(canBmsDriver.name, 'USB CAN bus');
  assert.deepEqual(canBmsDriver.models?.map((m) => m.name), ['Auto detect', 'SocketCAN interface', 'Waveshare USB-CAN-A', 'Seeed USB-CAN Analyzer']);
});

test('CanBms: one pack, stale after 10 s without BMS frames', async () => {
  let t = 1000;
  let emit: (f: CanFrame) => void = () => {};
  const source: CanSource = { name: 'can0', failure: null, open: async (cb) => void (emit = cb), close: async () => {} };
  const bms = new CanBms(source, () => t);
  bms.firstFrameWaitMs = 0;
  await bms.connect();
  await assert.rejects(bms.read(), /No battery data/);
  emit(fr(0x355, '5000 6400'));
  assert.equal((await bms.read())[0]['State of charge'], 80);
  t += 9000;
  emit(fr(0x305, '00')); // inverter keep-alives don't keep the battery data fresh
  t += 2000;
  await assert.rejects(bms.read(), /No CAN frames/);
});

test('SerialCanSource auto: configures as Waveshare, falls back to Seeed when silent', async () => {
  const writes: Buffer[] = [];
  let onData: (c: Buffer) => void = () => {};
  const port: RawPort = { open: async (d) => void (onData = d), write: async (b) => void writes.push(b), close: async () => {} };
  const src = new SerialCanSource('/dev/ttyUSB0', 'auto', 500000, () => port, 200);
  const frames: CanFrame[] = [];
  await src.open((f) => frames.push(f));
  assert.deepEqual(writes.map((w) => w[2]), [0x12, 0x02]);
  onData(encodeWaveshare(fr(0x355, '5000')));
  assert.equal(frames.length, 1);

  writes.length = 0;
  const src2 = new SerialCanSource('/dev/ttyUSB0', 'auto', 500000, () => port, 2000);
  const opening = src2.open(() => {});
  setTimeout(() => onData(encodeWaveshare(fr(0x356, '00'))), 20);
  await opening;
  assert.deepEqual(writes.map((w) => w[2]), [0x12]); // frames arrived: stays Waveshare
});

function roundAll<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v])) as T;
}
