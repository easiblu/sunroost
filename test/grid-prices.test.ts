import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  convertPrice, dayKey, nextCheapestHour, parseEcbRates, parseEnergyCharts, roundPrice, slotAt, toHourly, withPremium,
} from '../src/grid/prices.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 0, 0); // midnight UTC

test('converts EUR/MWh to currency/kWh with rate and multiplier', () => {
  assert.equal(convertPrice(100), 0.1);
  assert.equal(convertPrice(100, 1, 100), 10); // cents
  assert.ok(Math.abs(convertPrice(250, 11.5) - 2.875) < 1e-9); // SEK
  assert.equal(convertPrice(-20), -0.02);
});

test('parses an Energy-Charts response, deriving slot ends and skipping gaps', () => {
  const t = T0 / 1000;
  const slots = parseEnergyCharts({ unix_seconds: [t, t + 900, t + 1800, t + 2700], price: [100, null, 80, 90], unit: 'EUR / MWh' });
  assert.equal(slots.length, 3);
  assert.deepEqual(slots[0], { start: T0, end: T0 + 900_000, price: 100 });
  assert.equal(slots[2].end - slots[2].start, 900_000); // last slot gets the typical length
  assert.throws(() => parseEnergyCharts({ foo: 1 }));
  assert.throws(() => parseEnergyCharts({ unix_seconds: [], price: [], unit: 'USD / MWh' }));
});

test('premium is the deviation from the day average, per day in the time zone', () => {
  const raw = [
    { start: T0, end: T0 + H, price: 100 },
    { start: T0 + H, end: T0 + 2 * H, price: 200 },
    { start: T0 + 24 * H, end: T0 + 25 * H, price: 50 }, // next day, own average
  ];
  const s = withPremium(raw, { timeZone: 'UTC' });
  assert.ok(Math.abs(s[0].price - 0.1) < 1e-9);
  assert.ok(Math.abs(s[0].premium - -0.05) < 1e-9);
  assert.ok(Math.abs(s[1].premium - 0.05) < 1e-9);
  assert.ok(Math.abs(s[2].premium) < 1e-9);
  // The premium scales with the multiplier.
  const m = withPremium(raw, { timeZone: 'UTC', multiplier: 100 });
  assert.ok(Math.abs(m[0].premium - -5) < 1e-9);
});

test('day boundaries follow the configured time zone', () => {
  // 23:00 UTC on the 12th is already the 13th in Berlin.
  assert.equal(dayKey(T0 + 23 * H, 'UTC'), '2026-10-12');
  assert.equal(dayKey(T0 + 23 * H, 'Europe/Berlin'), '2026-10-13');
  assert.equal(dayKey(T0, 'Not/AZone'), '2026-10-12');
});

test('aggregates 15-minute slots into hours', () => {
  const q = [100, 200, 300, 400].map((p, i) => ({ start: T0 + i * 900_000, end: T0 + (i + 1) * 900_000, price: p }));
  const hourly = toHourly(withPremium(q, { timeZone: 'UTC' }));
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].end - hourly[0].start, H);
  assert.ok(Math.abs(hourly[0].price - 0.25) < 1e-9);
  assert.ok(Math.abs(hourly[0].premium) < 1e-9);
});

test('finds the current slot and the next cheapest hour', () => {
  const s = withPremium(
    [300, 100, 200, 50].map((p, i) => ({ start: T0 + i * H, end: T0 + (i + 1) * H, price: p })),
    { timeZone: 'UTC' },
  );
  assert.equal(slotAt(s, T0 + 1.5 * H)?.start, T0 + H);
  assert.equal(slotAt(s, T0 + 10 * H), null);
  assert.equal(nextCheapestHour(s, T0)?.start, T0 + 3 * H);
  assert.equal(nextCheapestHour(s, T0 + 5 * H), null);
});

test('rounds prices and parses ECB rates', () => {
  assert.equal(roundPrice(0.123456), 0.1235);
  assert.equal(roundPrice(12.34567), 12.346);
  const rates = parseEcbRates(`<Cube time='2026-10-12'><Cube currency='USD' rate='1.0812'/><Cube currency='SEK' rate='11.43'/></Cube>`);
  assert.deepEqual(rates, { EUR: 1, USD: 1.0812, SEK: 11.43 });
});
