import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lfpCellVoltage, SimulatedBms, simulatedBms } from '../src/devices/bms/simulated.ts';
import { state } from '../src/core/state.ts';

test('simulated: two 16-cell packs following bank power', async () => {
  let now = 1_700_000_000_000;
  let power = 2000;
  const bms = new SimulatedBms({ source: () => ({ power, soc: null }), now: () => now });
  await bms.connect();
  const first = await bms.read();
  assert.equal(first.length, 2);
  for (const p of first) {
    for (const name of ['State of charge', 'State of health', 'Power', 'Voltage', 'Current', 'Temperature', 'Cycles',
      'Charge capacity', 'Capacity', 'Design capacity', 'Cell voltage 16', 'Cell voltage - Highest',
      'Cell voltage - Average', 'Cell voltage - Lowest', 'Cell voltage - Difference', 'Cell temperature - Average',
      'Max charge current', 'Max discharge current', 'Alarms', 'Device mode', 'Model name', 'Serial number', 'Firmware version']) {
      assert.ok(name in p, `${name} present`);
    }
    assert.equal(p['Cell voltage 17'], undefined);
    assert.equal(p['Device mode'], 'Charging');
    assert.ok((p.Voltage as number) > 48 && (p.Voltage as number) < 58);
  }
  const total = (first[0].Power as number) + (first[1].Power as number);
  assert.ok(Math.abs(total - 2000) <= 2, `pack powers add up (${total})`);

  const soc0 = first[0]['State of charge'] as number;
  now += 30 * 60_000; // capped at 60 s per step, so step a few times
  for (let i = 0; i < 30; i++) {
    now += 60_000;
    await bms.read();
  }
  const later = await bms.read();
  assert.ok((later[0]['State of charge'] as number) > soc0, 'charging raises SOC');

  power = -3000;
  now += 60_000;
  const dis = await bms.read();
  assert.equal(dis[0]['Device mode'], 'Discharging');
  assert.ok((dis[0].Current as number) < 0);
});

test('simulated: bank totals from pack metrics', async () => {
  const bms = simulatedBms.create({ connections: [], baudRate: 0, modelId: '' });
  state.updateInverter(0, { 'Battery power': -1500, 'Battery state of charge': 60 });
  const packs = await bms.read();
  packs.forEach((p, i) => state.updateBattery(i, p));
  assert.ok(Math.abs((state.totals['Battery power'] as number) + 1500) <= 2);
  assert.ok(Math.abs((state.totals['Battery state of charge'] as number) - 60) < 1.5);
  assert.equal(typeof state.totals['Battery voltage'], 'number');
  state.clear('inverter');
  state.clear('battery');
});

test('simulated: LFP curve is monotonic', () => {
  let prev = 0;
  for (let s = 0; s <= 100; s += 5) {
    const v = lfpCellVoltage(s);
    assert.ok(v >= prev);
    prev = v;
  }
});
