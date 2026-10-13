import assert from 'node:assert/strict';
import { test } from 'node:test';
import { growattFamily } from '../src/devices/inverters/growatt/index.ts';
import {
  codecWords, decodeSetting, decodeTime, encodeSetting, encodeTime, keyOf, type GrowattSetting,
} from '../src/devices/inverters/growatt/settings.ts';

const MODELS = ['spf', 'sph', 'sph3', 'tlxh', 'tlx'];

test('time encoding is hour<<8 | minute', () => {
  assert.equal(encodeTime('00:00'), 0);
  assert.equal(encodeTime('01:30'), 0x011e);
  assert.equal(encodeTime('23:59'), (23 << 8) | 59);
  assert.equal(decodeTime(0x011e), '01:30');
  assert.equal(decodeTime((17 << 8) | 5), '17:05');
  assert.throws(() => encodeTime('24:00'));
  assert.throws(() => encodeTime('7pm'));
});

test('SPH slot: three registers start, end, enable', () => {
  const def = growattFamily('sph').settings.find((d) => d.key === 'battery_first_slot_2')!;
  assert.equal(def.reg, 1103);
  assert.deepEqual(encodeSetting(def, '01:00,05:30,true'), [0x0100, 0x051e, 1]);
  assert.equal(decodeSetting(def, [0x0100, 0x051e, 1]), '01:00,05:30,true');
  assert.equal(decodeSetting(def, [0x1100, 0x1300, 0]), '17:00,19:00,false');
  const grid = growattFamily('sph').settings.find((d) => d.key === 'grid_first_slot_3')!;
  assert.equal(grid.reg, 1086);
});

test('TL-XH slot: enable bit 15, priority bits 13–14', () => {
  const def = growattFamily('tlxh').settings.find((d) => d.key === 'work_mode_slot_1')!;
  assert.deepEqual(def.slotPriorities, ['Load first', 'Battery first', 'Grid first']);
  const words = encodeSetting(def, '02:15,06:00,Battery first,true');
  assert.deepEqual(words, [0x8000 | (1 << 13) | (2 << 8) | 15, 6 << 8]);
  assert.equal(decodeSetting(def, words), '02:15,06:00,Battery first,true');
  assert.equal(decodeSetting(def, [(2 << 13) | (18 << 8), 21 << 8]), '18:00,21:00,Grid first,false');
});

test('enum, number and inverted bool codecs', () => {
  const spf = growattFamily('spf').settings;
  const prio = spf.find((d) => d.key === 'output_source_priority')!;
  assert.equal(prio.reg, 1);
  assert.deepEqual(encodeSetting(prio, 'Utility first'), [2]);
  assert.deepEqual(encodeSetting(prio, 'solar/battery/utility'), [0]);
  assert.equal(decodeSetting(prio, [7]), 'Unknown (7)');
  assert.throws(() => encodeSetting(prio, 'Nope'));
  const volts = spf.find((d) => d.key === 'battery_float_charge_voltage')!;
  assert.deepEqual(encodeSetting(volts, 54.1), [541]);
  assert.equal(decodeSetting(volts, [541]), 54.1);
  const restart = spf.find((d) => d.key === 'overload_restart')!;
  assert.deepEqual(encodeSetting(restart, true), [0]);
  assert.equal(decodeSetting(restart, [1]), false);
});

/** A representative valid value for a setting definition. */
function sample(def: GrowattSetting) {
  switch (def.type) {
    case 'select':
      return def.options![def.options!.length - 1];
    case 'number': {
      const step = def.step ?? 1;
      const v = Math.min(def.max ?? 100, (def.min ?? 0) + step * 3);
      return Math.round(v * 1000) / 1000;
    }
    case 'checkbox':
      return true;
    case 'slot':
      return def.slotPriorities ? `04:30,07:45,${def.slotPriorities[1]},true` : '04:30,07:45,true';
    default:
      return '12:00';
  }
}

test('every setting round-trips value → registers → value', () => {
  for (const id of MODELS) {
    for (const def of growattFamily(id).settings) {
      if (def.reg === undefined) continue;
      for (const value of [sample(def), def.type === 'checkbox' ? false : undefined].filter((v) => v !== undefined)) {
        const words = encodeSetting(def, value!);
        assert.equal(words.length, codecWords(def.codec), `${id}.${def.key}`);
        for (const w of words) assert.ok(Number.isInteger(w) && w >= 0 && w <= 0xffff, `${id}.${def.key} word ${w}`);
        assert.equal(decodeSetting(def, words), value, `${id}.${def.key}`);
      }
    }
  }
});

test('setting tables: snake_case keys, sections, no overlapping registers, unverified are read-only', () => {
  const sections: Record<string, string[]> = {
    spf: ['Battery', 'Input/output', 'Miscellaneous'],
    sph: ['Work mode', 'Grid', 'Battery', 'Schedule'],
    tlxh: ['Grid', 'Priority', 'Schedule'],
  };
  for (const id of MODELS) {
    const defs = growattFamily(id).settings;
    const used = new Map<number, string>();
    for (const def of defs) {
      assert.equal(def.key, keyOf(def.label));
      if (!def.verified || def.reg === undefined) assert.equal(def.readOnly, true, `${id}.${def.key} must be read-only`);
      if (def.type === 'select') assert.ok(def.options?.length, `${id}.${def.key} options`);
      if (def.reg === undefined) continue;
      for (let i = 0; i < codecWords(def.codec); i++) {
        const other = used.get(def.reg + i);
        assert.equal(other, undefined, `${id}: ${def.key} overlaps ${other} at ${def.reg + i}`);
        used.set(def.reg + i, def.key);
      }
    }
    if (sections[id]) assert.deepEqual([...new Set(defs.map((d) => d.section))].sort(), [...sections[id]].sort());
    assert.equal(new Set(defs.map((d) => d.key)).size, defs.length, `${id}: duplicate keys`);
  }
});

test('SOC control settings exist with the values automations write', () => {
  for (const id of MODELS) {
    const f = growattFamily(id);
    if (!f.socControl) continue;
    const def = f.settings.find((d) => d.key === f.socControl!.setting);
    assert.ok(def, `${id}: ${f.socControl.setting} missing`);
    assert.ok(def.options?.includes(f.socControl.gridValue));
    assert.ok(def.options?.includes(f.socControl.batteryValue));
  }
  assert.equal(growattFamily('spf').settings.find((d) => d.key === 'output_source_priority')!.readOnly, false);
  assert.equal(growattFamily('sph').settings.find((d) => d.key === 'work_mode_priority')!.readOnly, false);
});
