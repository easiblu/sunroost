import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeLive, deyeFamily, sunsynk } from '../src/devices/inverters/deye/index.ts';
import { decodeInfo, livePlan } from '../src/devices/inverters/deye/family.ts';
import { decodeFaults, decodeOne, planTable, type RegisterImage } from '../src/devices/inverters/deye/registers.ts';

const u16 = (v: number) => v & 0xffff;
function frame(entries: Record<number, number>): RegisterImage {
  return new Map(Object.entries(entries).map(([a, v]) => [Number(a), u16(v)]));
}
function ascii(text: string, start: number, words: number, into: Record<number, number>) {
  const t = text.padEnd(words * 2, '\0');
  for (let i = 0; i < words; i++) into[start + i] = (t.charCodeAt(i * 2) << 8) | t.charCodeAt(i * 2 + 1);
}

test('single-phase hybrid: signs, scales, temperature offset, faults', () => {
  const regs = frame({
    59: 2, 79: 5002, 90: 1355, 91: 1412, 103: 0, 104: 0, 105: 0, 106: 0,
    109: 3521, 110: 84, 111: 2900, 112: 31, 113: 0, 114: 0, 115: 0, 116: 0,
    150: 2312, 154: 2300, 157: 2301, 160: -150, 166: 0, 167: -400, 169: 650, 172: 1150, 175: -1200,
    176: 0, 177: 0, 178: 1800, 182: 1215, 183: 5234, 184: 87, 186: 2950, 187: 900, 188: 0, 189: 0,
    190: -1500, 191: -2866, 192: 5001, 193: 5000,
  });
  const m = decodeLive(deyeFamily('hybrid'), regs);
  assert.equal(m['Device mode'], 'Normal');
  assert.equal(m['Fault code'], 'None');
  assert.equal(m['PV power 1'], 2950);
  assert.equal(m['PV power 2'], 900);
  assert.equal(m['PV power'], 3850);
  assert.equal(m['PV voltage 1'], 352.1);
  assert.equal(m['PV current 1'], 8.4);
  assert.equal('PV power 3' in m, false, 'unused MPPT 3 is hidden');
  // Deye: + discharge. Sunroost: + charge.
  assert.equal(m['Battery power'], 1500);
  assert.equal(m['Battery current'], 28.66);
  assert.equal(m['Battery voltage'], 52.34);
  assert.equal(m['Battery state of charge'], 87);
  assert.equal(m['Battery temperature'], 21.5);
  assert.equal(m['Temperature DC'], 35.5);
  assert.equal(m['Temperature AC'], 41.2);
  assert.equal(m.Temperature, 41.2);
  assert.equal(m['Grid power'], 650);
  assert.equal(m['Grid power CT'], 1150);
  assert.equal(m['Grid power LD'], -400);
  assert.equal(m['Load power'], 1800);
  assert.equal(m['Load power essential'], 1800);
  assert.equal(m['Load power non-essential'], 1550);
  assert.equal(m['Grid voltage'], 231.2);
  assert.equal(m['Grid frequency'], 50.02);
  assert.equal(m['AC output voltage'], 230);
  assert.equal(m['AC output frequency'], 50);
  assert.equal(m['Generator power'], 0);
});

test('battery discharging reads negative; sub-zero temperatures decode', () => {
  const m = decodeLive(deyeFamily('hybrid'), frame({ 190: 2200, 191: 4200, 182: 950, 59: 4, 103: 0x1000, 104: 1, 105: 0, 106: 0 }));
  assert.equal(m['Battery power'], -2200);
  assert.equal(m['Battery current'], -42);
  assert.equal(m['Battery temperature'], -5);
  assert.equal(m['Device mode'], 'Fault');
  assert.equal(m['Fault code'], 'F13, F17');
  assert.equal(decodeFaults([0, 0, 0, 0x8000]), 'F64');
});

test('three-phase LV: per-phase grid voltage and load', () => {
  const regs = frame({
    500: 2, 587: 5100, 588: 60, 590: 1000, 598: 2300, 599: 2310, 600: 2320, 604: 100, 605: 200, 606: 300, 607: 600,
    609: 4998, 616: 150, 617: 0, 618: 350, 619: 500, 625: 500, 650: 700, 651: 800, 652: 900, 653: 2400,
    672: 1000, 673: 1100, 676: 4000, 677: 25, 678: 4100, 679: 27,
  });
  const m = decodeLive(deyeFamily('hybrid3'), regs);
  assert.equal(m['Battery power'], -1000);
  assert.equal(m['Grid voltage 1'], 230);
  assert.equal(m['Grid voltage 3'], 232);
  assert.equal(m['Grid voltage'], 230);
  assert.equal(m['Grid power 1'], 150);
  assert.equal(m['Grid power 2'], 200, 'falls back to LD when the CT phase reads 0');
  assert.equal(m['Load power 3'], 900);
  assert.equal(m['Load power'], 2400);
  assert.equal(m['PV power'], 2100);
  assert.equal(m['AC output frequency'], 49.98);
});

test('info: serial ASCII, rated power low word first, model name', () => {
  const r: Record<number, number> = { 0: 3, 2: 0x0102, 13: 0x3417, 14: 0x1052, 16: 50000 & 0xffff, 17: 50000 >>> 16 };
  ascii('2207123456', 3, 5, r);
  const info = decodeInfo(deyeFamily('hybrid'), frame(r));
  assert.equal(info['Serial number'], '2207123456');
  assert.equal(info['Max AC output power'], 5000);
  assert.equal(info['Model name'], 'Deye 5 kW single-phase hybrid');
  assert.equal(info['Firmware version'], '3.4.1.7');
  assert.equal(decodeOne({ addr: 0, type: 'u32le', metric: 'x' }, frame({ 0: 0x0002, 1: 0x0001 })), 0x10002);
  assert.equal(decodeOne({ addr: 0, type: 's32le', metric: 'x' }, frame({ 0: 0xfffe, 1: 0xffff })), -2);
});

test('read planning merges close spans into few requests', () => {
  assert.deepEqual(livePlan(deyeFamily('hybrid')), [[59, 58], [150, 44]]);
  assert.ok(livePlan(deyeFamily('hybrid3')).length <= 3);
  for (const f of ['hybrid', 'hybrid3', 'hybrid3hv', 'string']) {
    for (const [, count] of livePlan(deyeFamily(f))) assert.ok(count <= 125);
  }
  assert.deepEqual(planTable([{ addr: 10, metric: 'a' }, { addr: 30, metric: 'b' }, { addr: 100, metric: 'c' }]), [[10, 21], [100, 1]]);
});

test('descriptor', () => {
  assert.equal(sunsynk.id, 'sunsynk');
  assert.equal(sunsynk.defaultBaudRate, 9600);
  assert.deepEqual(sunsynk.consoleFunctions, [{ id: '3', name: 'Holding register' }]);
  assert.deepEqual(sunsynk.socControl!('hybrid'), { setting: 'grid_charge', gridValue: 'true', batteryValue: 'false' });
  assert.equal(sunsynk.socControl!('hybrid3hv'), null);
  assert.equal(sunsynk.protectionSetting!('hybrid'), null);
  assert.equal(deyeFamily('nope').id, 'hybrid');
});
