import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { ModbusDriver } from '../src/home/lite/modbus/index.ts';
import { batches, decode, encode, parsePoints, sdm120 } from '../src/home/lite/modbus/points.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { ModbusSim } from './sims/modbus.ts';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const st = (id: string) => states.get(id)?.state;

describe('points', () => {
  it('parses the compact syntax with sensible defaults', () => {
    const p = parsePoints(`# a comment
Generator; switch; coil; 0
Pump; switch; holding; 0x10; on=5; off=0
Voltage; sensor; holding; 3; u16; scale=0.1; unit=V
Energy; sensor; input; 20; s32; order=le; unit=kWh
Mode; select; holding; 40; options=0:Off|1:Auto|2:Manual
Limit; number; holding; 50; min=6; max=32; unit=A
Door; binary_sensor; discrete; 4`);
    assert.equal(p.length, 7);
    assert.deepEqual([p[0].type, p[0].table, p[0].address], ['bool', 'coil', 0]);
    assert.deepEqual([p[1].address, p[1].on, p[1].off, p[1].type], [16, 5, 0, 'u16']);
    assert.deepEqual([p[2].scale, p[2].unit, p[2].deviceClass], [0.1, 'V', 'voltage']);
    assert.deepEqual([p[3].type, p[3].order], ['s32', 'le']);
    assert.deepEqual(p[4].options, [{ value: 0, label: 'Off' }, { value: 1, label: 'Auto' }, { value: 2, label: 'Manual' }]);
    assert.deepEqual([p[5].min, p[5].max, p[5].step], [6, 32, 1]);
  });

  it('explains mistakes with the line number', () => {
    const bad: [string, RegExp][] = [
      ['Pump; switch; coil', /Line 1: expected/],
      ['Pump; pump; coil; 0', /kind must be/],
      ['Pump; switch; ram; 0', /table must be/],
      ['Pump; switch; coil; 70000', /0–65535/],
      ['Pump; switch; input; 0', /needs a coil or a holding register/],
      ['Temp; sensor; coil; 0', /use binary_sensor/],
      ['Temp; sensor; holding; 0; bool', /number type/],
      ['Temp; sensor; holding; 0; f64', /unknown type/],
      ['Temp; sensor; holding; 0; colour=red', /unknown option "colour"/],
      ['Mode; select; holding; 0', /needs options=/],
      ['Pump; switch; holding; 0; on=1; off=1', /on and off must differ/],
      ['', /at least one point/],
      [Array.from({ length: 17 }, (_, i) => `R${i}; switch; coil; ${i}`).join('\n'), /At most 16/],
    ];
    for (const [text, re] of bad) assert.throws(() => parsePoints(text), re, text);
    assert.throws(() => parsePoints('A; switch; coil; 0\nB; switch; nope; 0'), /Line 2:/);
  });

  it('decodes and encodes 16/32-bit integers and floats in both word orders', () => {
    assert.equal(decode([0xfff6], 's16', 'be'), -10);
    assert.equal(decode([0x0001, 0x86a0], 'u32', 'be'), 100000);
    assert.equal(decode([0x86a0, 0x0001], 'u32', 'le'), 100000);
    assert.equal(decode([0xffff, 0xfffe], 's32', 'be'), -2);
    assert.equal(decode([0x4366, 0x8000], 'float32', 'be'), 230.5);
    assert.deepEqual(encode(230.5, 'float32', 'be'), [0x4366, 0x8000]);
    assert.deepEqual(encode(100000, 'u32', 'le'), [0x86a0, 0x0001]);
    assert.deepEqual(encode(-10, 's16', 'be'), [0xfff6]);
    assert.throws(() => encode(70000, 'u16', 'be'), /doesn't fit/);
  });

  it('batches touching addresses, never across gaps', () => {
    const b = batches(sdm120());
    // Voltage, current, power (0, 6, 12) and total energy (0x156) stand alone; frequency, import and
    // export energy (0x46, 0x48, 0x4A) are adjacent floats and share one read.
    assert.deepEqual(b.map((x) => [x.start, x.count]), [[0, 2], [6, 2], [12, 2], [0x46, 6], [0x156, 2]]);
    const c = batches(parsePoints('A; sensor; holding; 0; u32\nB; sensor; holding; 2\nC; sensor; holding; 3\nD; sensor; holding; 10\nE; switch; coil; 0\nF; switch; coil; 1'));
    assert.deepEqual(c.map((x) => [x.table, x.start, x.count, x.points.length]), [['coil', 0, 2, 2], ['holding', 0, 4, 3], ['holding', 10, 1, 1]]);
  });
});

describe('modbus driver', () => {
  const board = new ModbusSim(1);
  const meter = new ModbusSim(2);
  const custom = new ModbusSim(3);
  let engine: LiteEngine;
  let boardPort = 0;
  let meterPort = 0;
  let customPort = 0;

  before(async () => {
    openDb(':memory:');
    settings.init();
    secrets.init(null);
    registry.init();
    areas.init();
    states.reset();
    boardPort = await board.start();
    meterPort = await meter.start();
    customPort = await custom.start();
    engine = new LiteEngine([new ModbusDriver({ pollMs: 100, timeoutMs: 300 })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });

  after(async () => {
    await engine.stop();
    await Promise.all([board.stop(), meter.stop(), custom.stop()]);
  });

  /** Runs a flow to the end; returns each step's view. */
  async function setup(steps: Record<string, unknown>[]) {
    const first = await engine.startFlow('modbus');
    const flowId = (first as { flowId: string }).flowId;
    const views = [first];
    for (const input of steps) views.push(await engine.flowStep(flowId, input));
    return views;
  }

  const tcp = (port: number, unit: number, name: string) => ({ name, transport: 'tcp', host: '127.0.0.1', port, unit });

  it('checks the connection before going on', async () => {
    const [, nobody] = await setup([tcp(1, 1, 'Nothing')]);
    assert.match(JSON.stringify(nobody), /No answer from 127\.0\.0\.1:1 unit 1: connection refused/);
    const [, wrongUnit] = await setup([tcp(boardPort, 9, 'Wrong unit')]);
    assert.match(JSON.stringify(wrongUnit), /No answer from .* unit 9: no answer \(timed out\)/);
    const [, missing] = await setup([{ name: '', transport: 'rtu', path: 'COM1', unit: 1, baud: '9600' }]);
    assert.equal(missing.type, 'form');
    const errors = (missing as { errors: Record<string, string> }).errors;
    assert.ok(errors.name && errors.path, JSON.stringify(errors));
  });

  it('relay board profile: one switch per coil, writes confirmed by reading back', async () => {
    const views = await setup([tcp(boardPort, 1, 'Board'), { profile: 'relay', relays: 4, first: 0, poll: 1 }]);
    assert.deepEqual(views.map((v) => v.type), ['form', 'form', 'create_entry']);
    await until('relays', () => st('switch.board_relay_4') === 'off');
    const res = await callService('switch', 'turn_on', 'switch.board_relay_2', {}, undefined, { confirmMs: 2000 });
    assert.deepEqual(res.results['switch.board_relay_2'], { ok: true, confirmed: true, message: undefined });
    assert.equal(board.coils.get(1), true);
    const t = await callService('switch', 'toggle', 'switch.board_relay_2', {}, undefined, { confirmMs: 2000 });
    assert.equal(t.results['switch.board_relay_2'].confirmed, true);
    assert.equal(board.coils.get(1), false);
    // A change made at the device shows up on the next poll.
    board.coils.set(3, true);
    await until('external change', () => st('switch.board_relay_4') === 'on');
  });

  it('SDM120 profile reads float registers', async () => {
    meter.setFloat('input', 0x0000, 230.5);
    meter.setFloat('input', 0x0006, 4.25);
    meter.setFloat('input', 0x000c, 979);
    meter.setFloat('input', 0x0046, 50);
    meter.setFloat('input', 0x0156, 1234.5);
    await setup([tcp(meterPort, 2, 'Meter'), { profile: 'sdm120', poll: 1 }]);
    await until('meter', () => st('sensor.meter_voltage') === '230.5');
    assert.equal(st('sensor.meter_current'), '4.25');
    assert.equal(st('sensor.meter_power'), '979');
    assert.equal(st('sensor.meter_total_energy'), '1234.5');
    const e = registry.entity('sensor.meter_power')!;
    assert.deepEqual([e.unit, e.deviceClass, e.readOnly], ['W', 'power', true]);
    assert.equal(registry.device(e.deviceId!)!.manufacturer, 'Eastron');
  });

  it('custom points: holding-register switch, scaled sensor, number, select', async () => {
    custom.holding.set(3, 2305);
    custom.holding.set(40, 1);
    custom.holding.set(50, 16);
    const [, , form, bad] = await setup([
      tcp(customPort, 3, 'ATS'),
      { profile: 'custom', poll: 1 },
      { points: 'Generator; switch; holding; 0; on=1; off=0\nOops; sensor; holding' },
    ]);
    assert.equal(form.type, 'form');
    assert.match(JSON.stringify(bad), /Line 2: expected/);
    const flowId = (bad as { flowId: string }).flowId;
    const done = await engine.flowStep(flowId, {
      points: 'Generator; switch; holding; 0; on=1; off=0\nGrid voltage; sensor; holding; 3; scale=0.1; unit=V\nMode; select; holding; 40; options=0:Off|1:Auto|2:Manual\nLimit; number; holding; 50; min=6; max=32; unit=A',
    });
    assert.equal(done.type, 'create_entry');
    await until('custom', () => st('sensor.ats_grid_voltage') === '230.5');
    assert.equal(st('switch.ats_generator'), 'off');
    assert.equal(st('select.ats_mode'), 'Auto');
    assert.deepEqual(states.get('select.ats_mode')!.attributes.options, ['Off', 'Auto', 'Manual']);
    assert.equal(st('number.ats_limit'), '16');

    const on = await callService('switch', 'turn_on', 'switch.ats_generator', {}, undefined, { confirmMs: 2000 });
    assert.equal(on.results['switch.ats_generator'].confirmed, true);
    assert.equal(custom.holding.get(0), 1);
    const sel = await callService('select', 'select_option', 'select.ats_mode', { option: 'Manual' }, undefined, { confirmMs: 2000 });
    assert.equal(sel.results['select.ats_mode'].confirmed, true);
    assert.equal(custom.holding.get(40), 2);
    const num = await callService('number', 'set_value', 'number.ats_limit', { value: 25 });
    assert.equal(num.ok, true);
    assert.equal(custom.holding.get(50), 25);
    await until('number', () => st('number.ats_limit') === '25');
    const out = await callService('number', 'set_value', 'number.ats_limit', { value: 40 });
    assert.match(out.results['number.ats_limit'].message!, /between 6 and 32/);
  });

  it('refuses to add the same device twice', async () => {
    const views = await setup([tcp(customPort, 3, 'ATS again'), { profile: 'relay', relays: 1, first: 0, poll: 1 }]);
    assert.equal(views.at(-1)!.type, 'abort');
    assert.match(JSON.stringify(views.at(-1)), /already set up/);
  });

  it('a refused address makes only its point unknown', async () => {
    const strict = new ModbusSim(4);
    strict.strict = true; // like many real devices: unmapped addresses are refused
    strict.holding.set(60, 7);
    const port = await strict.start();
    try {
      // Adjacent points share one read; the device refuses 61, so the read is retried point by point.
      await setup([tcp(port, 4, 'Strict'), { profile: 'custom', poll: 1 }, { points: 'Good; sensor; holding; 60\nMissing; sensor; holding; 61' }]);
      await until('strict', () => st('sensor.strict_good') === '7' && st('sensor.strict_missing') === 'unknown');
      const entry = (await engine.entries()).find((e) => e.title === 'Strict')!;
      await engine.removeEntry(entry.entryId);
    } finally {
      await strict.stop();
    }
  });

  it('an unreachable device becomes unavailable, recovers, and removing it removes its entities', async () => {
    await board.stop();
    await until('unavailable', () => st('switch.board_relay_1') === 'unavailable');
    const status = engine.info().drivers[0];
    assert.equal(status.id, 'modbus');
    await board.start();
    await until('back', () => st('switch.board_relay_1') === 'off', 8000);
    const entry = (await engine.entries()).find((e) => e.title === 'Board')!;
    await engine.removeEntry(entry.entryId);
    assert.equal(registry.entity('switch.board_relay_1'), null);
    assert.ok(registry.entity('sensor.meter_voltage'), 'other devices stay');
  });
});
