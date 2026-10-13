import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { evaluate, list, reset } from '../src/alerts/index.ts';
import type { Snapshot } from '../src/core/state.ts';
import { describe as weatherText } from '../src/weather/index.ts';

const ok = { name: 'connected' as const, message: 'Connected' };
const snap = (totals: Record<string, unknown>, extra: Partial<Snapshot> = {}): Snapshot => ({
  ts: Date.now(), inverters: [{}], batteries: [], grid: {}, totals: totals as never, energy: null,
  status: { inverter: ok, battery: ok }, ...extra,
});
const ids = () => list().active.map((a) => a.id).sort();

beforeEach(() => reset());

test('battery low raises at 20%, escalates at 10%, clears only above 25%', () => {
  evaluate(snap({ 'Battery state of charge': 19 }));
  assert.equal(list().active[0].level, 'warn');
  evaluate(snap({ 'Battery state of charge': 9 }));
  assert.equal(list().active[0].level, 'bad');
  evaluate(snap({ 'Battery state of charge': 22 }));
  assert.deepEqual(ids(), ['battery-low']); // hysteresis: still active
  evaluate(snap({ 'Battery state of charge': 26 }));
  assert.deepEqual(ids(), []);
  assert.equal(list().recent[0].id, 'battery-low');
});

test('grid outage only after the grid has been seen (off-grid sites never alert)', () => {
  evaluate(snap({ 'Grid voltage': 0 }));
  assert.deepEqual(ids(), []);
  evaluate(snap({ 'Grid voltage': 231 }));
  evaluate(snap({ 'Grid voltage': 3 }));
  assert.deepEqual(ids(), ['grid-outage']);
  evaluate(snap({ 'Grid voltage': 229 }));
  assert.deepEqual(ids(), []);
});

test('inverter faults, link loss and heat', () => {
  evaluate(snap({ Temperature: 72 }, {
    inverters: [{ 'Fault code': 'F13 Grid overvoltage' }, { 'Fault code': 'None' }],
    status: { inverter: { name: 'error', message: 'Timed out' }, battery: ok },
  }));
  assert.deepEqual(ids(), ['fault-0', 'inverter-hot', 'inverter-link']);
  assert.equal(list().active[0].level, 'bad');
});

test('planned outage within two hours', () => {
  evaluate(snap({}, { grid: { 'Next planned outage start': '18:00', 'Next planned outage in': '1h 30m' } }));
  assert.deepEqual(ids(), ['planned-outage']);
  evaluate(snap({}, { grid: { 'Next planned outage start': '18:00', 'Next planned outage in': '5h 0m' } }));
  assert.deepEqual(ids(), []);
});

test('weather codes map to text and icons', () => {
  assert.deepEqual(weatherText(0, true), { text: 'Sunny', icon: 'sun' });
  assert.deepEqual(weatherText(0, false), { text: 'Clear', icon: 'moon' });
  assert.equal(weatherText(63).icon, 'cloud-rain');
  assert.equal(weatherText(95).text, 'Thunderstorm');
});
