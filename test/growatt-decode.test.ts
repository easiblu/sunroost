import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeInputs, decodeRange, growattFamily } from '../src/devices/inverters/growatt/index.ts';
import { decodeInfo } from '../src/devices/inverters/growatt/family.ts';
import { decodeTable, image, planReads, type RegisterImage } from '../src/devices/inverters/growatt/registers.ts';
import { growatt } from '../src/devices/inverters/growatt/index.ts';

/** Builds a register image from { address: u16 } plus { address: u32 } (two registers, high word first). */
function regs(u16: Record<number, number>, u32: Record<number, number> = {}): RegisterImage {
  const m: RegisterImage = new Map();
  for (const [a, v] of Object.entries(u16)) m.set(Number(a), v & 0xffff);
  for (const [a, v] of Object.entries(u32)) {
    m.set(Number(a), (v >>> 16) & 0xffff);
    m.set(Number(a) + 1, v & 0xffff);
  }
  return m;
}

/** Fills every input block of a family with zeros, then overlays the given values. */
function frame(model: string, u16: Record<number, number>, u32: Record<number, number> = {}) {
  const m: RegisterImage = new Map();
  for (const [start, count] of growattFamily(model).inputBlocks) image(start, new Array(count).fill(0), m);
  for (const [k, v] of regs(u16, u32)) m.set(k, v);
  return m;
}

test('SPF: discharging on PV + battery (v1 frame)', () => {
  const r = decodeInputs(growattFamily('spf'), frame(
    'spf',
    { 0: 12, 1: 3125, 7: 48, 17: 5260, 18: 74, 19: 3901, 20: 0, 22: 2300, 23: 5000, 25: 412, 26: 0xffec, 27: 286 },
    { 3: 15000, 9: 21000, 11: 22500 },
  ));
  assert.equal(r['Device mode'], 'PV charge & discharge');
  assert.equal(r['PV voltage 1'], 312.5);
  assert.equal(r['PV current 1'], 4.8);
  assert.equal(r['PV power'], 1500);
  assert.equal(r['Load power'], 2100);
  assert.equal(r['Load apparent power'], 2250);
  assert.equal(r['Battery voltage'], 52.6);
  assert.equal(r['Battery state of charge'], 74);
  assert.equal(r['Grid power'], 0);
  assert.equal(r['Battery power'], -600);
  assert.equal(r['Battery current'], -11.4);
  assert.equal(r['Bus voltage'], 390.1);
  assert.equal(r['AC output voltage'], 230);
  assert.equal(r['AC output frequency'], 50);
  assert.equal(r.Temperature, 41.2);
  assert.equal(r['Load percentage'], 28.6);
  assert.equal(r['AC charge power'], undefined, 'intermediate values are not emitted');
});

test('SPF: bypass carries the load and AC-charges the battery', () => {
  const r = decodeInputs(growattFamily('spf'), frame('spf', { 0: 10, 18: 30, 17: 5000 }, { 9: 8000, 13: 10000 }));
  assert.equal(r['Device mode'], 'AC charge & bypass');
  assert.equal(r['Grid power'], 1800);
  assert.equal(r['Battery power'], 1000);
  assert.equal(r['Battery current'], 20);
});

test('SPF: 32-bit PV power above 6553.5 W and unknown status', () => {
  const r = decodeInputs(growattFamily('spf'), frame('spf', { 0: 99 }, { 3: 72000 }));
  assert.equal(r['PV power 1'], 7200);
  assert.equal(r['Device mode'], 'Unknown (99)');
});

test('SPH: hybrid exporting while charging the battery', () => {
  const r = decodeInputs(growattFamily('sph'), frame(
    'sph',
    { 0: 1, 3: 3600, 4: 85, 7: 3400, 8: 40, 37: 5001, 38: 2405, 93: 385, 98: 3900, 1000: 5, 1013: 525, 1014: 81, 1040: 0xffe2 },
    { 1: 44000, 5: 30600, 9: 13400, 35: 30000, 1009: 0, 1011: 15000, 1021: 0, 1029: 12000, 1037: 17000 },
  ));
  assert.equal(r['Device mode'], 'Normal');
  assert.equal(r['PV power'], 4400);
  assert.equal(r['PV power 1'], 3060);
  assert.equal(r['PV voltage 1'], 360);
  assert.equal(r['PV current 1'], 8.5);
  assert.equal(r['Battery power'], 1500);
  assert.equal(r['Battery voltage'], 52.5);
  assert.equal(r['Battery current'], 28.6);
  assert.equal(r['Battery state of charge'], 81);
  assert.equal(r['Battery temperature'], -3);
  assert.equal(r['Grid power'], -1200);
  assert.equal(r['Load power'], 1700);
  assert.equal(r['Grid voltage'], 240.5);
  assert.equal(r['Grid frequency'], 50.01);
  assert.equal(r['AC output voltage'], 240.5);
  assert.equal(r.Temperature, 38.5);
  assert.equal(r['Bus voltage'], 390);
});

test('SPH: importing and discharging; load falls back to AC balance without a load reading', () => {
  const r = decodeInputs(growattFamily('sph'), frame('sph', { 1000: 6 }, { 1009: 8000, 1021: 5000, 35: 8000 }));
  assert.equal(r['Device mode'], 'Battery online');
  assert.equal(r['Battery power'], -800);
  assert.equal(r['Grid power'], 500);
  assert.equal(r['Load power'], 1300);
});

test('SPH TL3: per-phase grid voltage and power', () => {
  const r = decodeInputs(growattFamily('sph3'), frame(
    'sph3',
    { 38: 2301, 42: 2312, 46: 2323 },
    { 1015: 1000, 1017: 0, 1019: 3000, 1023: 0, 1025: 2000, 1027: 0, 1021: 4000, 1029: 2000 },
  ));
  assert.equal(r['Grid voltage 1'], 230.1);
  assert.equal(r['Grid voltage 2'], 231.2);
  assert.equal(r['Grid voltage 3'], 232.3);
  assert.equal(r['Grid power 1'], 100);
  assert.equal(r['Grid power 2'], -200);
  assert.equal(r['Grid power 3'], 300);
  assert.equal(r['Grid power'], 200);
});

test('TL-XH: 3000-range decode with battery', () => {
  const r = decodeInputs(growattFamily('tlxh'), frame(
    'tlxh',
    { 3000: 1, 3003: 4100, 3004: 52, 3025: 4998, 3026: 2318, 3093: 0xfff6, 3169: 5212, 3171: 64, 3176: 215 },
    { 3001: 21300, 3005: 21300, 3041: 0, 3043: 5000, 3045: 9000, 3178: 0, 3180: 7000 },
  ));
  assert.equal(r['Device mode'], 'Normal');
  assert.equal(r['PV power'], 2130);
  assert.equal(r['PV voltage 1'], 410);
  assert.equal(r['Battery voltage'], 52.12);
  assert.equal(r['Battery state of charge'], 64);
  assert.equal(r['Battery temperature'], 21.5);
  assert.equal(r['Battery power'], 700);
  assert.equal(r['Grid power'], -500);
  assert.equal(r['Load power'], 900);
  assert.equal(r['Grid voltage'], 231.8);
  assert.equal(r['Grid frequency'], 49.98);
  assert.equal(r.Temperature, -1);
});

test('TL-X: no battery metrics', () => {
  const r = decodeInputs(growattFamily('tlx'), frame('tlx', { 3000: 3 }, { 3001: 10000, 3023: 9800 }));
  assert.equal(r['Device mode'], 'Fault');
  assert.equal(r['PV power'], 1000);
  assert.equal(r['Load power'], 980);
  assert.equal('Battery power' in r, false);
  assert.equal('Battery state of charge' in r, false);
});

test('every input table row lies inside a polled block and blocks fit one request', () => {
  for (const id of ['spf', 'sph', 'sph3', 'tlxh', 'tlx']) {
    const f = growattFamily(id);
    for (const [, count] of f.inputBlocks) assert.ok(count <= 125, `${id} block too large`);
    const decoded = decodeTable(f.inputMap, frame(id, {}));
    for (const def of f.inputMap) assert.ok(def.metric in decoded, `${id}: ${def.metric} @${def.addr} outside the polled blocks`);
  }
});

test('info registers: ASCII serial and firmware', () => {
  const ascii = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => (s.charCodeAt(i * 2) << 8) | s.charCodeAt(i * 2 + 1));
  const m = image(0, new Array(44).fill(0));
  image(9, ascii('RA1.0b'), m);
  image(23, ascii('AB12345678'), m);
  const info = decodeInfo(growattFamily('sph'), m);
  assert.equal(info['Serial number'], 'AB12345678');
  assert.equal(info['Firmware version'], 'RA1.0b');
  assert.equal(info['Model name'], 'Growatt SPH / SPA (single-phase hybrid)');
});

test('console decode: input range and holding settings', () => {
  const input = decodeRange(growattFamily('spf'), 4, 17, [5260, 74]);
  assert.deepEqual(input, { 'Battery voltage': 52.6, 'Battery state of charge': 74 });
  const holding = decodeRange(growattFamily('spf'), 3, 1, [2, 1]);
  assert.equal(holding['Output source priority'], 'Utility first');
  assert.equal(holding['Charger source priority'], 'Solar and utility simultaneously');
  const slots = decodeRange(growattFamily('sph'), 3, 1100, [0x0130, 0x051e, 1]);
  assert.equal(slots['Battery first slot 1'], '01:48,05:30,true');
});

test('read planning merges close spans and respects the request limit', () => {
  assert.deepEqual(planReads([[1044, 1], [1048, 1], [1070, 2], [1080, 3], [1090, 3], [1100, 9]]), [[1044, 5], [1070, 39]]);
  assert.deepEqual(planReads([[0, 100], [101, 100]]), [[0, 100], [101, 100]]);
});

test('descriptor: models, console functions and SOC control', () => {
  assert.equal(growatt.id, 'growatt');
  assert.deepEqual(growatt.models?.map((m) => m.id), ['spf', 'sph', 'sph3', 'tlxh', 'tlx', 'wit']);
  assert.deepEqual(growatt.consoleFunctions?.map((f) => f.id), ['4', '3']);
  assert.deepEqual(growatt.socControl?.('spf'), { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' });
  assert.deepEqual(growatt.socControl?.('sph'), { setting: 'work_mode_priority', gridValue: 'Battery first', batteryValue: 'Load first' });
  assert.equal(growatt.socControl?.('tlx'), null);
  assert.deepEqual(growatt.protectionSetting?.('spf'), { setting: 'output_source_priority', shutdownValue: 'Utility first' });
  assert.equal(growatt.protectionSetting?.('sph'), null);
});
