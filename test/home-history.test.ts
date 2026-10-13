import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as history from '../src/home/history.ts';
import * as registry from '../src/home/registry.ts';
import * as states from '../src/home/states.ts';

const T0 = Date.parse('2026-10-13T08:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  openDb(':memory:');
  registry.init();
  states.reset();
  history.reset();
  history.start();
  registry.registerEntity('lite', { uniqueId: 'p', domain: 'sensor', name: 'Heater power', unit: 'W', readOnly: true });
  registry.registerEntity('lite', { uniqueId: 's', domain: 'switch', name: 'Heater' });
  registry.registerEntity('energy', { uniqueId: 'pv', domain: 'sensor', name: 'PV power', readOnly: true });
});

test('records state changes, thins numeric noise, and skips Sunroost\'s own energy readings', () => {
  const set = (id: string, v: string, at: number) => states.set(id, v, {}, undefined, at);
  set('switch.heater', 'off', T0);
  set('switch.heater', 'on', T0 + MIN);
  set('sensor.heater_power', '2000', T0 + MIN);
  set('sensor.heater_power', '2010', T0 + MIN + 5000); // < 2%, 5 s later: skipped
  set('sensor.heater_power', '2010', T0 + MIN + 70_000); // unchanged: no state_changed at all
  set('sensor.heater_power', '2015', T0 + MIN + 80_000); // small, but 80 s since the last row
  set('sensor.heater_power', '0', T0 + 31 * MIN);
  set('sensor.pv_power', '3000', T0);
  history.stop(); // flushes
  assert.deepEqual(history.history('switch.heater', T0 - MIN, T0 + 60 * MIN).map((p) => p.state), ['off', 'on']);
  assert.deepEqual(history.history('sensor.heater_power', T0 - MIN, T0 + 60 * MIN).map((p) => p.num), [2000, 2015, 0]);
  assert.deepEqual(history.history('sensor.pv_power', T0 - MIN, T0 + 60 * MIN), []);
});

test('the chart starts with the state from before the window', () => {
  states.set('switch.heater', 'on', {}, undefined, T0);
  history.stop();
  const pts = history.history('switch.heater', T0 + 10 * MIN, T0 + 20 * MIN);
  assert.deepEqual(pts, [{ ts: T0 + 10 * MIN, state: 'on', num: null }]);
});

test('energy from a power reading: each value held until the next', () => {
  states.set('sensor.heater_power', '2000', {}, undefined, T0);
  states.set('sensor.heater_power', '0', {}, undefined, T0 + 30 * MIN);
  history.stop();
  assert.equal(history.energyKwh('sensor.heater_power', T0, T0 + 60 * MIN), 1, '2 kW for 30 min');
  assert.equal(history.energyKwh('sensor.heater_power', T0 + 15 * MIN, T0 + 60 * MIN), 0.5, 'from mid-run');
});

test('long numeric series are averaged into a bounded number of points', () => {
  for (let i = 0; i < 2000; i++) states.set('sensor.heater_power', String(i % 2 ? 100 : 5000), {}, undefined, T0 + i * 61_000);
  history.stop();
  const pts = history.history('sensor.heater_power', T0, T0 + 2000 * 61_000);
  assert.ok(pts.length <= 600 && pts.length > 500, `${pts.length} points`);
});
