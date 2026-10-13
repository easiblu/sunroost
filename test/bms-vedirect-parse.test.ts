import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeVeBlock, productName, VeDirectBms, veDirectDriver, veDirectMetrics, VeDirectParser } from '../src/devices/bms/ve-direct.ts';
import type { RawPort } from '../src/devices/bms/can/sources.ts';

const LIVE: [string, string][] = [
  ['PID', '0xA389'], ['V', '52480'], ['VS', '12950'], ['I', '-12500'], ['P', '-656'], ['CE', '-45000'],
  ['SOC', '775'], ['TTG', '1440'], ['Alarm', 'OFF'], ['Relay', 'OFF'], ['AR', '0'], ['BMV', 'SmartShunt 500A/50mV'],
  ['FW', '0414'], ['MON', '0'], ['T', '23'],
];
const HIST: [string, string][] = [['H1', '-120000'], ['H4', '37'], ['H7', '47100'], ['H17', '12345'], ['H18', '13456']];

test('checksum: block bytes sum to 0 mod 256, bad blocks dropped', () => {
  const block = encodeVeBlock(LIVE);
  let s = 0;
  for (const b of block) s += b;
  assert.equal(s & 0xff, 0);
  const p = new VeDirectParser();
  // Leading partial block (we joined mid-stream) and a corrupted block are dropped.
  const bad = Buffer.from(encodeVeBlock(HIST));
  bad[5] ^= 1;
  const out = p.push(Buffer.concat([Buffer.from('12\r\nI\t-5\r\nChecksum\t\x01', 'latin1'), bad, block]));
  assert.equal(out.length, 1);
  assert.equal(out[0].V, '52480');
  assert.equal(out[0]['PID'], '0xA389');
  assert.equal(p.bad, 2);
});

test('hex-protocol ":" messages are ignored, inside and between blocks', () => {
  const block = encodeVeBlock(LIVE);
  const mid = block.indexOf('\r\nSOC');
  const hexMsg = Buffer.from(':A0102000543\n', 'latin1');
  const stream = Buffer.concat([hexMsg, block.subarray(0, mid), hexMsg, block.subarray(mid), hexMsg, encodeVeBlock(HIST)]);
  const p = new VeDirectParser();
  const out: Record<string, string>[] = [];
  for (let i = 0; i < stream.length; i += 7) out.push(...p.push(stream.subarray(i, i + 7)));
  assert.equal(out.length, 2);
  assert.equal(out[0].SOC, '775');
  assert.equal(out[1].H4, '37');
  assert.equal(p.bad, 0);
});

test('checksum byte that looks like ":" or newline', () => {
  // Find field values whose checksum byte is 0x3a and 0x0a.
  for (const target of [0x3a, 0x0a]) {
    let found = false;
    for (let v = 0; v < 100000 && !found; v++) {
      const b = encodeVeBlock([['BMV', v.toString(36)]]);
      if (b[b.length - 1] !== target) continue;
      found = true;
      const out = new VeDirectParser().push(Buffer.concat([b, encodeVeBlock([['I', '1']])]));
      assert.deepEqual(out, [{ BMV: v.toString(36) }, { I: '1' }]);
    }
    assert.ok(found);
  }
});

test('metrics mapping', () => {
  const m = veDirectMetrics(Object.fromEntries([...LIVE, ...HIST]));
  assert.equal(m['Model name'], 'SmartShunt 500A/50mV');
  assert.equal(m.Voltage, 52.48);
  assert.equal(m.Current, -12.5);
  assert.equal(m.Power, -656);
  assert.equal(m['State of charge'], 77.5);
  assert.equal(m['Consumed Ah'], -45);
  assert.equal(m['Charge capacity'], 155); // 200 Ah estimated full − 45 consumed
  assert.equal(m.Temperature, 23);
  assert.equal(m['Time to go'], 1440);
  assert.equal(m['Starter voltage'], 12.95);
  assert.equal(m.Alarms, '');
  assert.equal(m.Cycles, 37);
  assert.equal(m['Deepest discharge'], -120);
  assert.equal(m['Minimum voltage'], 47.1);
  assert.equal(m['Discharged energy'], 123.45);
  assert.equal(m['Firmware version'], '0414');
  assert.equal(m['Device mode'], 'Discharging');

  const alarm = veDirectMetrics({ V: '44000', Alarm: 'ON', AR: '5', TTG: '-1', T: '---' });
  assert.equal(alarm.Alarms, 'Low voltage, Low SOC');
  assert.equal('Time to go' in alarm, false);
  assert.equal('Temperature' in alarm, false);
  assert.equal(productName('0x0204'), 'BMV-702');
  assert.equal(productName('0xBEEF'), 'Victron 0xBEEF');
});

test('driver: merges blocks, single connection, stale after 10 s', async () => {
  let t = 0;
  let onData: (c: Buffer) => void = () => {};
  const port: RawPort = { open: async (d) => void (onData = d), write: async () => {}, close: async () => {} };
  const bms = new VeDirectBms('/dev/ttyUSB0', () => port, () => t);
  bms.firstBlockWaitMs = 0;
  await bms.connect();
  await assert.rejects(bms.read(), /No VE.Direct data/);
  onData(encodeVeBlock(LIVE));
  onData(encodeVeBlock(HIST));
  const [m] = await bms.read();
  assert.equal(m.Voltage, 52.48);
  assert.equal(m.Cycles, 37);
  t = 11_000;
  await assert.rejects(bms.read(), /for 11 s/);
  assert.equal(veDirectDriver.name, 'USB Victron VE.Direct');
  assert.equal(veDirectDriver.multiConnection, false);
  await assert.rejects(veDirectDriver.create({ connections: [], baudRate: 19200, modelId: '' }).connect());
});
