import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as deviceRules from '../src/automation/devices.ts';
import * as runs from '../src/automation/runs.ts';
import * as spareSolar from '../src/automation/surplus.ts';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import { state } from '../src/core/state.ts';
import { factorFrom, forecastFrom, MIN_LEARNED_DAYS } from '../src/energy/forecast.ts';
import { surplusW } from '../src/energy/surplus.ts';
import { newContext } from '../src/home/bus.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import { setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import type { DeviceEngine, EngineHost, ServiceCall } from '../src/home/types.ts';

describe('solar forecast', () => {
  const day = (date: string, pvKwh: number, radiationMj: number) => ({ date, pvKwh, radiationMj });

  it('learns kWh per unit of sunshine from history, ignoring curtailed and dull days', () => {
    // A ~5 kW system: about 4 kWh per kWh/m². Day 3 was curtailed (battery full), day 7 was dull.
    const history = [
      day('d1', 24, 21.6), day('d2', 20, 18), day('d3', 9, 21.6), day('d4', 23, 21), day('d5', 16, 14.4),
      day('d6', 22, 19.8), day('d7', 1, 2), day('d8', 18, 16.2),
    ];
    const f = factorFrom(history, 0, 6);
    assert.equal(f.source, 'learned');
    assert.equal(f.days, 7, 'the dull day is left out');
    assert.ok(f.value > 3.9 && f.value < 4.1, `factor ${f.value}`);
  });

  it('falls back to the array size, then to a rough estimate', () => {
    const few = [day('d1', 20, 18)];
    assert.ok(few.length < MIN_LEARNED_DAYS);
    assert.deepEqual(factorFrom(few, 5, 6), { value: 4, source: 'array', days: 0 });
    assert.deepEqual(factorFrom([], 0, 6), { value: 4.8, source: 'estimate', days: 0 });
  });

  it('turns the forecast into kWh for today, tomorrow and the rest of today', () => {
    const f = forecastFrom(
      { value: 4, source: 'learned', days: 10 },
      [{ date: '2026-10-13', radiationMj: 18 }, { date: '2026-10-14', radiationMj: 9 }],
      [{ time: '2026-10-13T14:00', radiation: 500 }, { time: '2026-10-13T15:00', radiation: 250 }, { time: '2026-10-14T09:00', radiation: 300 }],
      '2026-10-13',
    );
    assert.equal(f.todayKwh, 20, '18 MJ/m² = 5 kWh/m² × 4');
    assert.equal(f.tomorrowKwh, 10);
    assert.equal(f.nowW, 2000);
    assert.equal(f.restOfTodayKwh, 3, '2 kW + 1 kW for an hour each');
  });
});

describe('solar surplus', () => {
  const inputs = (o: Partial<Parameters<typeof surplusW>[0]>) => ({ pvW: 3000, loadW: 1000, gridW: 0, batteryW: 0, soc: 50, ...o });

  it('counts only export while the battery charges, everything beyond the load once it is nearly full', () => {
    assert.equal(surplusW(inputs({ gridW: -400, batteryW: 1600 })), 400, 'battery charging: only what it could not take');
    assert.equal(surplusW(inputs({ soc: 95, gridW: 0, batteryW: 0 })), 2000, 'battery full, inverter curtailing: pv − load');
    assert.equal(surplusW(inputs({ gridW: 300 })), 0, 'importing');
    assert.equal(surplusW(inputs({ batteryW: -500 })), 0, 'draining the battery');
    assert.equal(surplusW(inputs({ pvW: null })), null);
  });
});

/** Two flexible loads with their own power readings, like smart plugs. */
class Loads implements DeviceEngine {
  id = 'lite' as const;
  name = 'Loads';
  host!: EngineHost;
  draw: Record<string, number> = { 'switch.pool': 900, 'switch.heater': 2000 };
  async start(host: EngineHost) {
    this.host = host;
    for (const n of ['pool', 'heater']) {
      const d = host.registerDevice({ uniqueId: n, name: n });
      host.registerEntity({ uniqueId: n, domain: 'switch', name: n, objectId: n, deviceId: d.id });
      host.registerEntity({ uniqueId: `${n}_w`, domain: 'sensor', name: `${n} power`, objectId: `${n}_power`, deviceId: d.id, unit: 'W', readOnly: true });
      host.setState(`switch.${n}`, 'off');
      host.setState(`sensor.${n}_power`, '0');
    }
  }
  async stop() {}
  async callService(call: ServiceCall) {
    const on = call.service === 'turn_on';
    this.host.setState(call.entityId, on ? 'on' : 'off', {}, newContext('device', call.context));
    this.host.setState(`sensor.${call.entityId.slice(7)}_power`, String(on ? this.draw[call.entityId] : 0));
    return { ok: true };
  }
}

describe('spare solar scheduling', () => {
  const MIN = 60_000;
  let loads: Loads;
  const sun = (o: { pv: number; load: number; grid: number; battery?: number; soc?: number }) =>
    state.updateInverter(0, { 'PV power': o.pv, 'Load power': o.load, 'Grid power': o.grid, 'Battery power': o.battery ?? 0, 'Battery state of charge': o.soc ?? 95 });
  const st = (id: string) => states.get(id)!.state;

  beforeEach(async () => {
    openDb(':memory:');
    settings.init();
    runs.initRuns();
    registry.init();
    states.reset();
    deviceRules.resetGuards();
    spareSolar.reset();
    loads = new Loads();
    await loads.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? loads : null));
    registry.updateEntity('switch.pool', { role: 'deferrable', powerW: 900 });
    registry.updateEntity('switch.heater', { role: 'deferrable', powerW: 2000 });
    settings.setMany({
      'surplus.enabled': true, 'surplus.order': ['switch.pool', 'switch.heater'], 'surplus.start_margin_w': 100,
      'surplus.start_minutes': 5, 'surplus.stop_minutes': 3, 'surplus.min_on_minutes': 15,
    });
  });

  it('starts devices one at a time in order as the surplus allows, after the start delay', async () => {
    let now = Date.parse('2026-10-13T10:00:00Z');
    sun({ pv: 4000, load: 1000, grid: -3000 }); // 3 kW spare
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'off', 'waits 5 minutes first');
    assert.equal(spareSolar.status(now).devices[0].status, 'next');
    now += 5 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'on');
    assert.match(runs.listRuns({ limit: 1 })[0].trigger, /Spare solar: 3.00 kW spare/);

    sun({ pv: 4000, load: 1900, grid: -2100 }); // the pool now draws 900 W: 2.1 kW left, the heater needs 2.1 kW
    now += 5 * MIN;
    await spareSolar.evaluate(false, now);
    now += 5 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.heater'), 'on', 'second device once its 2000 W + margin fits');

    const s = spareSolar.status(now);
    assert.deepEqual(s.devices.map((d) => [d.entityId, d.status, d.powerSource]), [['switch.pool', 'running', 'measured'], ['switch.heater', 'running', 'measured']]);
  });

  it('stops the last one it started on a shortfall, but only after its minimum run time', async () => {
    let now = Date.parse('2026-10-13T10:00:00Z');
    sun({ pv: 4000, load: 1000, grid: -3000 });
    await spareSolar.evaluate(false, now);
    now += 5 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'on');

    sun({ pv: 1000, load: 1900, grid: 900 }); // a cloud: importing
    now += MIN;
    await spareSolar.evaluate(false, now);
    now += 3 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'on', 'has run only 4 minutes of its 15');
    now += 12 * MIN;
    await spareSolar.evaluate(false, now);
    now += 3 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'off');
    assert.equal(runs.listRuns({ limit: 1 })[0].actions[0].text, 'Turn off pool');
  });

  it('dead-man switch: devices that time themselves get an off-timer, renewed while they run', async () => {
    let now = Date.parse('2026-10-13T10:00:00Z');
    const calls: Record<string, unknown>[] = [];
    const orig = loads.callService.bind(loads);
    loads.callService = async (call) => {
      calls.push({ id: call.entityId, service: call.service, ...call.data });
      return orig(call);
    };
    states.set('switch.pool', 'off', { supports_auto_off: true });
    sun({ pv: 4000, load: 1000, grid: -3000 });
    await spareSolar.evaluate(false, now);
    now += 5 * MIN;
    await spareSolar.evaluate(false, now);
    assert.deepEqual(calls.at(-1), { id: 'switch.pool', service: 'turn_on', auto_off_s: 1200 });
    states.set('switch.pool', 'on', { supports_auto_off: true });
    sun({ pv: 4000, load: 1900, grid: -2100 });
    now += 9 * MIN;
    await spareSolar.evaluate(false, now);
    const before = calls.length;
    now += 2 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(calls.length, before + 1, 'renewed after 10 minutes');
    assert.deepEqual(calls.at(-1), { id: 'switch.pool', service: 'turn_on', auto_off_s: 1200 });
    assert.equal(calls.filter((c) => c.id === 'switch.heater').length, 0, 'the heater has no timer and is not running');
  });

  it('leaves a device you switched on yourself alone, and does nothing while suspended or disabled', async () => {
    let now = Date.parse('2026-10-13T10:00:00Z');
    states.set('switch.heater', 'on'); // by hand
    sun({ pv: 500, load: 2500, grid: 2000 });
    for (let i = 0; i < 6; i++) {
      now += 5 * MIN;
      await spareSolar.evaluate(false, now);
    }
    assert.equal(st('switch.heater'), 'on');
    assert.equal(spareSolar.status(now).devices.find((d) => d.entityId === 'switch.heater')!.status, 'manual');

    sun({ pv: 4000, load: 1000, grid: -3000 });
    for (let i = 0; i < 3; i++) {
      now += 5 * MIN;
      await spareSolar.evaluate(true, now);
    }
    assert.equal(st('switch.pool'), 'off', 'suspended');
    settings.set('surplus.enabled', false);
    now += 10 * MIN;
    await spareSolar.evaluate(false, now);
    assert.equal(st('switch.pool'), 'off', 'disabled');
  });
});
