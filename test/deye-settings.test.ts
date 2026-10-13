import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deyeFamily } from '../src/devices/inverters/deye/index.ts';
import { decodeHhmm, decodeSettings, encodeHhmm, encodeSetting, type DeyeSetting } from '../src/devices/inverters/deye/settings.ts';

const def = (model: string, key: string) => deyeFamily(model).settings.find((d) => d.key === key) as DeyeSetting;

test('HHMM time encoding round-trips', () => {
  assert.equal(encodeHhmm('22:30'), 2230);
  assert.equal(encodeHhmm('00:05'), 5);
  assert.equal(decodeHhmm(2230), '22:30');
  assert.equal(decodeHhmm(5), '00:05');
  for (let h = 0; h < 24; h++) for (const m of [0, 1, 30, 59]) {
    const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    assert.equal(decodeHhmm(encodeHhmm(t)), t);
  }
  assert.throws(() => encodeHhmm('24:00'));
  assert.equal(decodeHhmm(9999), '23:59');
});

test('TOU program encode/decode through the settings table', () => {
  const regs = new Map<number, number>();
  const program = [
    ['01:00', 3000, 100, true, false], ['05:00', 5000, 30, false, true], ['08:00', 5000, 20, false, false],
    ['16:00', 4000, 40, false, false], ['20:00', 5000, 25, false, false], ['22:30', 2500, 90, true, true],
  ] as const;
  program.forEach(([time, power, soc, grid, gen], i) => {
    const n = i + 1;
    regs.set(250 + i, encodeSetting(def('hybrid', `time_point_${n}`), time));
    regs.set(256 + i, encodeSetting(def('hybrid', `power_point_${n}`), power));
    regs.set(268 + i, encodeSetting(def('hybrid', `capacity_point_${n}`), soc));
    let flags = encodeSetting(def('hybrid', `grid_charge_point_${n}`), grid, 0);
    flags = encodeSetting(def('hybrid', `gen_charge_point_${n}`), gen, flags);
    regs.set(274 + i, flags);
  });
  regs.set(248, encodeSetting(def('hybrid', 'use_timer'), true, 0b11111110));
  assert.equal(regs.get(255), 2230);
  assert.equal(regs.get(279), 3);
  assert.equal(regs.get(248), 0xff);
  const v = decodeSettings(deyeFamily('hybrid').settings, regs);
  program.forEach(([time, power, soc, grid, gen], i) => {
    const n = i + 1;
    assert.equal(v[`time_point_${n}`], time);
    assert.equal(v[`power_point_${n}`], power);
    assert.equal(v[`capacity_point_${n}`], soc);
    assert.equal(v[`grid_charge_point_${n}`], grid);
    assert.equal(v[`gen_charge_point_${n}`], gen);
  });
  assert.equal(v.use_timer, true);
  assert.equal(v.time_of_use_sunday, true);
  // Clearing one bit keeps the others.
  assert.equal(encodeSetting(def('hybrid', 'time_of_use_monday'), false, 0xff), 0xfd);
});

test('writable vs read-only', () => {
  const s = deyeFamily('hybrid').settings;
  const writable = s.filter((d) => !d.readOnly).map((d) => d.reg);
  for (const r of [244, 243, 245, 248, 250, 261, 268, 279, 210, 211, 217, 218, 219, 230, 232]) assert.ok(writable.includes(r), `reg ${r} writable`);
  for (const r of [247, 204, 111, 262]) assert.ok(!writable.includes(r), `reg ${r} read-only`);
  assert.ok(deyeFamily('hybrid3hv').settings.every((d) => d.readOnly));
  assert.equal(def('hybrid', 'system_work_mode').options?.length, 3);
  assert.equal(encodeSetting(def('hybrid', 'system_work_mode'), 'Zero export to CT'), 2);
  assert.equal(encodeSetting(def('hybrid', 'energy_pattern'), 'Load first'), 1);
});
