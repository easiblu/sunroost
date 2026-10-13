import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import { bus, newContext, type StateChangedEvent } from '../src/home/bus.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import type { DeviceEngine, EngineHost, ServiceCall, ServiceResult } from '../src/home/types.ts';

function fresh() {
  openDb(':memory:');
  registry.init();
  states.reset();
}

function capture() {
  const events: StateChangedEvent[] = [];
  const on = (e: StateChangedEvent) => events.push(e);
  bus.on('state_changed', on);
  return { events, stop: () => bus.off('state_changed', on) };
}

describe('state machine', () => {
  beforeEach(fresh);

  it('follows Home Assistant semantics for lastChanged / lastUpdated', () => {
    const c = capture();
    assert.equal(states.set('switch.a', 'off', {}, undefined, 1000), true);
    assert.equal(states.set('switch.a', 'off', {}, undefined, 2000), false, 'identical write is a no-op');
    states.set('switch.a', 'off', { power: 5 }, undefined, 3000);
    let s = states.get('switch.a')!;
    assert.equal(s.lastChanged, 1000, 'attribute-only change keeps lastChanged');
    assert.equal(s.lastUpdated, 3000);
    states.set('switch.a', 'on', { power: 5 }, undefined, 4000);
    s = states.get('switch.a')!;
    assert.equal(s.lastChanged, 4000);
    assert.equal(c.events.length, 3);
    assert.equal(c.events[0].oldState, null);
    assert.equal(c.events[2].oldState!.state, 'off');
    states.remove('switch.a');
    assert.equal(c.events.at(-1)!.newState, null);
    assert.equal(states.get('switch.a'), null);
    c.stop();
  });

  it('a failing listener does not stop the others or the write', () => {
    const seen: string[] = [];
    const bad = () => {
      throw new Error('boom');
    };
    const good = (e: StateChangedEvent) => seen.push(e.entityId);
    bus.on('state_changed', bad);
    bus.on('state_changed', good);
    assert.doesNotThrow(() => states.set('switch.b', 'on'));
    bus.off('state_changed', bad);
    bus.off('state_changed', good);
    assert.deepEqual(seen, ['switch.b']);
    assert.equal(states.get('switch.b')!.state, 'on');
  });

  it('carries the context that caused a change', () => {
    const c = capture();
    const parent = newContext('rule', null, 7);
    const child = newContext('device', parent);
    states.set('switch.a', 'on', {}, child);
    assert.equal(c.events[0].context.parentId, parent.id);
    assert.equal(parent.ruleId, 7);
    c.stop();
  });
});

describe('registry', () => {
  beforeEach(fresh);

  it('gives stable entity ids that survive a restart, with user overrides kept', () => {
    const dev = registry.registerDevice('lite', { uniqueId: 'AA:BB', name: 'Shelly Plug S' });
    const e = registry.registerEntity('lite', { uniqueId: 'AA:BB:relay0', domain: 'switch', name: 'Water heater', deviceId: dev.id });
    assert.equal(e.entityId, 'switch.water_heater');
    registry.updateEntity(e.entityId, { name: 'Geyser', role: 'deferrable' });
    registry.updateDevice(dev.id, { nameByUser: 'Bathroom plug' });

    registry.init(); // reload from the database, like a restart
    const again = registry.registerEntity('lite', { uniqueId: 'AA:BB:relay0', domain: 'switch', name: 'Relay 0 (renamed by firmware)', deviceId: dev.id });
    assert.equal(again.entityId, 'switch.water_heater', 'id fixed at first sight');
    assert.equal(again.name, 'Geyser');
    assert.equal(again.role, 'deferrable');
    assert.equal(again.originalName, 'Relay 0 (renamed by firmware)');
    assert.equal(registry.deviceName(registry.registerDevice('lite', { uniqueId: 'AA:BB', name: 'Shelly Plug S' })), 'Bathroom plug');
  });

  it('suffixes colliding ids and keeps engines apart', () => {
    const a = registry.registerEntity('lite', { uniqueId: 'x', domain: 'switch', name: 'Pump' });
    const b = registry.registerEntity('lite', { uniqueId: 'y', domain: 'switch', name: 'Pump' });
    const c = registry.registerEntity('full', { uniqueId: 'x', domain: 'switch', name: 'Pump' });
    assert.deepEqual([a.entityId, b.entityId, c.entityId], ['switch.pump', 'switch.pump_2', 'switch.pump_3']);
  });

  it('retires the old id when a device changes domain', () => {
    registry.registerEntity('lite', { uniqueId: 'z', domain: 'switch', name: 'Lamp' });
    const light = registry.registerEntity('lite', { uniqueId: 'z', domain: 'light', name: 'Lamp' });
    assert.equal(light.entityId, 'light.lamp');
    assert.equal(registry.entity('switch.lamp'), null);
  });
});

/** A push device: it reports its new state shortly after a command, like a Shelly over websocket. */
class FakeEngine implements DeviceEngine {
  id = 'lite' as const;
  name = 'Fake';
  host!: EngineHost;
  calls: ServiceCall[] = [];
  /** null = never reports back (an unconfirmed command). */
  pushAfterMs: number | null = 5;
  answer: ServiceResult = { ok: true };

  async start(host: EngineHost) {
    this.host = host;
    const dev = host.registerDevice({ uniqueId: 'plug1', name: 'Plug', config: { password: 'secret' } });
    host.registerEntity({ uniqueId: 'plug1:relay', domain: 'switch', name: 'Pump', deviceId: dev.id });
    host.registerEntity({ uniqueId: 'plug1:power', domain: 'sensor', name: 'Pump power', deviceId: dev.id, unit: 'W', readOnly: true });
    host.setState('switch.pump', 'off');
    host.setState('sensor.pump_power', '0');
  }
  async stop() {}
  async callService(call: ServiceCall) {
    this.calls.push(call);
    const to = call.service === 'turn_on' ? 'on' : call.service === 'turn_off' ? 'off' : states.get(call.entityId)!.state === 'on' ? 'off' : 'on';
    if (this.answer.ok && this.pushAfterMs !== null) {
      setTimeout(() => this.host.setState(call.entityId, to, {}, newContext('device', call.context)), this.pushAfterMs);
    }
    return this.answer;
  }
}

describe('service calls', () => {
  let fake: FakeEngine;
  beforeEach(async () => {
    fresh();
    fake = new FakeEngine();
    await fake.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? fake : null));
  });

  it('sends the command and confirms it from the pushed state', async () => {
    const res = await callService('switch', 'turn_on', 'switch.pump', {}, newContext('user'), { confirmMs: 500 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.results['switch.pump'], { ok: true, confirmed: true, message: undefined });
    assert.equal(states.get('switch.pump')!.state, 'on');
    assert.equal(states.get('switch.pump')!.context.parentId, res.context.id, 'the change is traceable to the call');
    assert.equal(fake.calls[0].domain, 'switch');
  });

  it('reports an unconfirmed command without failing it', async () => {
    fake.pushAfterMs = null;
    const res = await callService('switch', 'toggle', 'switch.pump', {}, undefined, { confirmMs: 30 });
    assert.equal(res.ok, true);
    assert.equal(res.results['switch.pump'].confirmed, false);
    assert.match(res.results['switch.pump'].message!, /not confirmed/);
  });

  it('accepts the generic homeassistant.turn_off on any on/off entity', async () => {
    states.set('switch.pump', 'on');
    const res = await callService('homeassistant', 'turn_off', 'switch.pump', {}, undefined, { confirmMs: 500 });
    assert.equal(res.ok, true);
    assert.equal(fake.calls[0].domain, 'switch');
  });

  it('rejects bad calls before they reach the engine', async () => {
    const res = await callService('switch', 'turn_on', ['sensor.pump_power', 'switch.nope', 'switch.pump'], {}, undefined, { confirmMs: 500 });
    assert.equal(res.ok, false);
    assert.match(res.results['sensor.pump_power'].message!, /not a switch/);
    assert.match(res.results['switch.nope'].message!, /Unknown entity/);
    assert.equal(res.results['switch.pump'].ok, true, 'one bad target does not block the others');
    assert.equal(fake.calls.length, 1);

    const ro = await callService('sensor', 'turn_on', 'sensor.pump_power');
    assert.match(ro.results['sensor.pump_power'].message!, /read-only/);
    const unsupported = await callService('switch', 'set_temperature', 'switch.pump');
    assert.match(unsupported.results['switch.pump'].message!, /doesn't support/);
  });

  it('refuses unavailable entities and stopped engines', async () => {
    fake.host.setState('switch.pump', 'unavailable');
    assert.match((await callService('switch', 'turn_on', 'switch.pump')).results['switch.pump'].message!, /unavailable/);
    fake.host.setState('switch.pump', 'off');
    setEngineLookup(() => null);
    assert.match((await callService('switch', 'turn_on', 'switch.pump')).results['switch.pump'].message!, /isn't running/);
  });

  it('passes engine failures through and emits call_service', async () => {
    fake.answer = { ok: false, message: 'Device refused' };
    let event: unknown = null;
    bus.once('call_service', (e) => (event = e));
    const res = await callService('switch', 'turn_on', 'switch.pump');
    assert.deepEqual(res.results['switch.pump'], { ok: false, message: 'Device refused', confirmed: null });
    assert.equal((event as { service: string }).service, 'turn_on');
  });

  it('keeps each engine to its own entities', () => {
    const energy = hostFor('energy');
    energy.setState('switch.pump', 'on');
    assert.equal(states.get('switch.pump')!.state, 'off', "another engine's entity is left alone");
    assert.doesNotThrow(() => energy.setState('switch.gone', 'on'), 'a removed entity is ignored');
    energy.removeEntity('switch.pump');
    assert.ok(registry.entity('switch.pump'), 'another engine cannot remove it');
    assert.deepEqual(energy.entities(), []);
  });
});
