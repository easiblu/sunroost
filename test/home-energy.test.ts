import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as alerts from '../src/alerts/index.ts';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import type { Snapshot } from '../src/core/state.ts';
import { EnergyEngine, gridAvailable } from '../src/home/energy.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import * as states from '../src/home/states.ts';

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ts: Date.now(),
    inverters: [],
    batteries: [],
    grid: { Provider: 'Energy-Charts', Price: 0.21 },
    totals: { 'Battery state of charge': 64, 'PV power': 1520, 'Grid voltage': 231, 'Device mode': 'Battery', 'Serial number': 'X1' },
    energy: { day: '2026-10-12', pv: 12.4, load: 9.1, gridImport: 0.5, gridExport: 3.2, batteryCharge: 4, batteryDischarge: 2.2 },
    status: { inverter: { name: 'connected', message: '' }, battery: { name: 'disconnected', message: '' } },
    ...over,
  };
}

const val = (id: string) => states.get(id)?.state;

describe('energy engine', () => {
  let engine: EnergyEngine;
  beforeEach(async () => {
    openDb(':memory:');
    settings.init();
    registry.init();
    states.reset();
    alerts.reset();
    engine = new EnergyEngine();
    await engine.start(hostFor('energy'));
  });

  it('exposes totals, today\'s energy, grid metrics and the grid as entities', async () => {
    engine.update(snapshot());
    assert.equal(val('sensor.battery_state_of_charge'), '64');
    assert.equal(val('sensor.pv_power'), '1520');
    assert.equal(val('sensor.device_mode'), 'Battery');
    assert.equal(val('sensor.pv_energy_today'), '12.4');
    assert.equal(val('sensor.grid_import_energy_today'), '0.5');
    assert.equal(val('sensor.grid_price'), '0.21');
    assert.equal(val('sensor.grid_provider'), 'Energy-Charts');
    assert.equal(val('binary_sensor.grid_available'), 'on');
    assert.equal(registry.entity('sensor.serial_number'), null, 'static info is not an entity');

    const soc = registry.entity('sensor.battery_state_of_charge')!;
    assert.equal(soc.unit, '%');
    assert.equal(soc.deviceClass, 'battery');
    assert.equal(soc.readOnly, true);
    assert.equal(registry.device(soc.deviceId!)!.name, 'Sunroost system');
    assert.equal(val('sensor.solar_radiation_tomorrow'), 'unknown', 'no site location, no forecast');
    await engine.stop();
  });

  it('marks readings unavailable when no device is connected, or a metric disappears', async () => {
    engine.update(snapshot());
    engine.update(snapshot({ status: { inverter: { name: 'error', message: 'timeout' }, battery: { name: 'disconnected', message: '' } } }));
    assert.equal(val('sensor.battery_state_of_charge'), 'unavailable');
    assert.equal(val('binary_sensor.grid_available'), 'unavailable');

    engine.update(snapshot({ totals: { 'Battery state of charge': 70 } }));
    assert.equal(val('sensor.battery_state_of_charge'), '70');
    assert.equal(val('sensor.pv_power'), 'unavailable');
    assert.ok(registry.entity('sensor.pv_power'), 'kept in the registry');
    await engine.stop();
  });

  it('keeps the same entity ids after a restart', async () => {
    engine.update(snapshot());
    await engine.stop();
    registry.init();
    const again = new EnergyEngine();
    await again.start(hostFor('energy'));
    again.update(snapshot());
    assert.equal(registry.allEntities('energy').filter((e) => e.entityId.startsWith('sensor.pv_power')).length, 1);
    await again.stop();
  });
});

describe('grid availability', () => {
  it('uses the outage alert first, then the voltage', () => {
    assert.equal(gridAvailable({ 'Grid voltage': 230 }, true), false);
    assert.equal(gridAvailable({ 'Grid voltage': 230 }, false), true);
    assert.equal(gridAvailable({ 'Grid voltage': 0 }, false), false);
    assert.equal(gridAvailable({}, false), null);
  });
});
