import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inPriceHours, nextFire, occurrences, priceHours, sunEvent, type PricePoint, type ScheduleEnv } from '../src/automation/scheduler.ts';
import { sunIsUp, sunTimes } from '../src/automation/sun.ts';
import { zonedTs } from '../src/automation/time.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

/** Local wall-clock time of a timestamp. */
const local = (ts: number, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe('sun times (NOAA)', () => {
  // Reference values from the NOAA solar calculator (local clock time, minute resolution).
  const cases: [string, string, number, number, string, string, string][] = [
    ['London', '2026-06-21', 51.5074, -0.1278, 'Europe/London', '04:43', '21:21'],
    ['New York', '2026-01-01', 40.7128, -74.006, 'America/New_York', '07:20', '16:39'],
    ['Cape Town', '2026-12-21', -33.9249, 18.4241, 'Africa/Johannesburg', '05:32', '19:57'],
    ['Johannesburg', '2026-06-21', -26.2041, 28.0473, 'Africa/Johannesburg', '06:54', '17:26'],
  ];
  for (const [name, ymd, lat, lon, tz, rise, set] of cases) {
    it(`${name} ${ymd} within 2 minutes`, () => {
      const s = sunTimes(ymd, lat, lon, tz);
      assert.ok(s.sunrise && s.sunset);
      assert.ok(Math.abs(minutesOf(local(s.sunrise, tz)) - minutesOf(rise)) <= 2, `sunrise ${local(s.sunrise, tz)} vs ${rise}`);
      assert.ok(Math.abs(minutesOf(local(s.sunset, tz)) - minutesOf(set)) <= 2, `sunset ${local(s.sunset, tz)} vs ${set}`);
    });
  }

  it('handles polar day and the sun position', () => {
    assert.deepEqual(sunTimes('2026-06-21', 78.22, 15.65, 'Arctic/Longyearbyen'), { sunrise: null, sunset: null });
    assert.equal(sunIsUp(Date.parse('2026-06-21T12:00:00Z'), 51.5, 0), true);
    assert.equal(sunIsUp(Date.parse('2026-06-21T23:30:00Z'), 51.5, 0), false);
  });

  it('falls back to 06:00/18:00 without a location', () => {
    const env = { tz: 'Europe/Berlin', location: null };
    assert.equal(local(sunEvent('2026-10-12', 'sunrise', env), 'Europe/Berlin'), '06:00');
    assert.equal(local(sunEvent('2026-10-12', 'sunset', env), 'Europe/Berlin'), '18:00');
  });
});

describe('scheduler', () => {
  const env: ScheduleEnv = { tz: 'Europe/Berlin', location: null, prices: [] };

  it('converts local times across DST', () => {
    assert.equal(new Date(zonedTs('2026-10-12', 6 * 60, 'Europe/Berlin')).toISOString(), '2026-10-12T04:00:00.000Z');
    assert.equal(new Date(zonedTs('2026-12-12', 6 * 60, 'Europe/Berlin')).toISOString(), '2026-12-12T05:00:00.000Z');
    // 2026-10-25: clocks go back at 03:00 CEST.
    assert.equal(new Date(zonedTs('2026-10-25', 6 * 60, 'Europe/Berlin')).toISOString(), '2026-10-25T05:00:00.000Z');
  });

  it('computes time triggers with weekdays', () => {
    const from = Date.parse('2026-10-12T00:00:00Z'); // Monday
    const list = occurrences({ kind: 'time', at: '06:30', days: [1, 3] }, from, from + 7 * 24 * HOUR, env);
    assert.deepEqual(list.map((t) => new Date(t).toISOString()), ['2026-10-12T04:30:00.000Z', '2026-10-14T04:30:00.000Z']);
    assert.equal(nextFire({ kind: 'time', at: '06:30' }, Date.parse('2026-10-12T04:30:00Z'), env), Date.parse('2026-10-13T04:30:00Z'));
  });

  it('computes interval and sun triggers', () => {
    const from = Date.parse('2026-10-12T10:02:00Z');
    const list = occurrences({ kind: 'interval', everyMinutes: 15 }, from, from + HOUR, env);
    assert.deepEqual(list.map((t) => new Date(t).toISOString().slice(11, 16)), ['10:15', '10:30', '10:45', '11:00']);
    const located: ScheduleEnv = { tz: 'Europe/London', location: { lat: 51.5074, lon: -0.1278 }, prices: [] };
    const start = Date.parse('2026-06-21T00:00:00Z');
    const [rise] = occurrences({ kind: 'sun', event: 'sunrise', offsetMinutes: -30 }, start, start + 24 * HOUR, located);
    assert.ok(Math.abs(minutesOf(local(rise, 'Europe/London')) - minutesOf('04:13')) <= 2);
  });

  it('selects the N cheapest / most expensive hours per local day', () => {
    // 15-minute slots for two UTC days, price = hour-of-day pattern.
    const day1 = [5, 4, 3, 2, 1, 1.5, 6, 7, 8, 9, 9, 9, 8, 7, 6, 5, 6, 9, 12, 11, 10, 8, 7, 6];
    const day2 = day1.map((p, h) => (h === 13 ? 0.5 : p));
    const slots: PricePoint[] = [];
    [day1, day2].forEach((prices, d) => {
      prices.forEach((p, h) => {
        for (let q = 0; q < 4; q++) {
          const start = Date.parse('2026-10-12T00:00:00Z') + d * 24 * HOUR + h * HOUR + q * 15 * MIN;
          slots.push({ start, end: start + 15 * MIN, price: p });
        }
      });
    });
    const cheap = priceHours(slots, 'cheapest', 2, 'UTC').map((t) => new Date(t).toISOString().slice(5, 16));
    assert.deepEqual(cheap, ['10-12T04:00', '10-12T05:00', '10-13T04:00', '10-13T13:00']);
    const dear = priceHours(slots, 'most_expensive', 1, 'UTC').map((t) => new Date(t).toISOString().slice(5, 16));
    assert.deepEqual(dear, ['10-12T18:00', '10-13T18:00']);
    const trig = occurrences({ kind: 'price', mode: 'cheapest', hours: 2 }, Date.parse('2026-10-12T04:30:00Z'), Date.parse('2026-10-13T00:00:00Z'), { ...env, tz: 'UTC', prices: slots });
    assert.deepEqual(trig, [Date.parse('2026-10-12T05:00:00Z')]);
    assert.equal(inPriceHours(slots, 'cheapest', 2, Date.parse('2026-10-12T05:20:00Z'), 'UTC'), true);
    assert.equal(inPriceHours(slots, 'cheapest', 2, Date.parse('2026-10-12T06:20:00Z'), 'UTC'), false);
    assert.equal(inPriceHours([], 'cheapest', 2, Date.parse('2026-10-12T06:20:00Z'), 'UTC'), null);
  });
});
