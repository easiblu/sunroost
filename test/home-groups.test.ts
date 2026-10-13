import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDb } from '../src/core/db.ts';
import * as areas from '../src/home/areas.ts';
import { newContext } from '../src/home/bus.ts';
import { GroupEngine, GroupError } from '../src/home/groups.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import type { DeviceEngine, EngineHost, ServiceCall } from '../src/home/types.ts';

/** Plugs that switch instantly; `broken` ones refuse. */
class Plugs implements DeviceEngine {
  id = 'lite' as const;
  name = 'Plugs';
  host!: EngineHost;
  broken = new Set<string>();
  calls: ServiceCall[] = [];
  async start(host: EngineHost) {
    this.host = host;
    const dev = host.registerDevice({ uniqueId: 'strip', name: 'Power strip' });
    for (const n of ['heater', 'pump', 'fridge']) {
      host.registerEntity({ uniqueId: n, domain: 'switch', name: n, deviceId: dev.id });
      host.setState(`switch.${n}`, 'off');
    }
    host.registerEntity({ uniqueId: 'temp', domain: 'sensor', name: 'temp', readOnly: true });
  }
  async stop() {}
  async callService(call: ServiceCall) {
    this.calls.push(call);
    if (this.broken.has(call.entityId)) return { ok: false, message: 'relay stuck' };
    this.host.setState(call.entityId, call.service === 'turn_on' ? 'on' : 'off', {}, newContext('device', call.context));
    return { ok: true };
  }
}

let plugs: Plugs;
let groups: GroupEngine;

beforeEach(async () => {
  await groups?.stop();
  openDb(':memory:');
  registry.init();
  areas.init();
  states.reset();
  plugs = new Plugs();
  await plugs.start(hostFor('lite'));
  groups = new GroupEngine();
  await groups.start(hostFor('group'));
  setEngineLookup((id) => (id === 'lite' ? plugs : id === 'group' ? groups : null));
});

describe('groups', () => {
  it('becomes an entity whose state follows its members (any / all)', async () => {
    const any = groups.create({ name: 'Water', members: ['switch.heater', 'switch.pump'] });
    const all = groups.create({ name: 'Everything', members: ['switch.heater', 'switch.pump'], mode: 'all' });
    assert.equal(any.entityId, 'group.water');
    assert.equal(states.get('group.water')!.state, 'off');
    states.set('switch.heater', 'on');
    assert.equal(states.get('group.water')!.state, 'on');
    assert.equal(states.get(all.entityId)!.state, 'off');
    states.set('switch.pump', 'on');
    assert.equal(states.get(all.entityId)!.state, 'on');
    assert.equal(states.get('group.water')!.attributes.members_on, 2);
    states.set('switch.heater', 'unavailable');
    states.set('switch.pump', 'unavailable');
    assert.equal(states.get('group.water')!.state, 'unavailable');
  });

  it('switches all members, traced to the group command, and confirms', async () => {
    const g = groups.create({ name: 'Water', members: ['switch.heater', 'switch.pump'] });
    const res = await callService('group', 'turn_on', g.entityId, {}, newContext('user'), { confirmMs: 200 });
    assert.deepEqual(res.results[g.entityId], { ok: true, confirmed: true, message: undefined });
    assert.equal(states.get('switch.heater')!.state, 'on');
    assert.equal(states.get('switch.pump')!.state, 'on');
    const memberCtx = plugs.calls[0].context;
    assert.equal(memberCtx.parentId, res.context.id, 'member command is a child of the group command');

    await callService('group', 'toggle', g.entityId, {}, undefined, { confirmMs: 200 });
    assert.equal(states.get('switch.heater')!.state, 'off');
  });

  it('reports partial failures and skips unavailable members', async () => {
    const g = groups.create({ name: 'Water', members: ['switch.heater', 'switch.pump', 'switch.fridge'] });
    plugs.broken.add('switch.pump');
    states.set('switch.fridge', 'unavailable');
    const res = await callService('group', 'turn_on', g.entityId, {}, undefined, { confirmMs: 200 });
    const r = res.results[g.entityId];
    assert.equal(r.ok, true);
    assert.match(r.message!, /1 of 2 failed \(switch\.pump\); 1 unavailable, skipped/);
    assert.equal(plugs.calls.some((c) => c.entityId === 'switch.fridge'), false);

    plugs.broken.add('switch.heater');
    const all = await callService('group', 'turn_on', g.entityId);
    assert.equal(all.results[g.entityId].ok, false, 'every member failed');
  });

  it('validates members, persists, updates and removes', async () => {
    assert.throws(() => groups.create({ name: '', members: ['switch.heater'] }), GroupError);
    assert.throws(() => groups.create({ name: 'x', members: [] }), /at least one/);
    assert.throws(() => groups.create({ name: 'x', members: ['sensor.temp'] }), /can't be switched/);
    assert.throws(() => groups.create({ name: 'x', members: ['switch.nope'] }), /unknown entity/);
    assert.throws(() => groups.create({ name: 'x', members: ['switch.heater'], mode: 'most' }), /mode/);

    const g = groups.create({ name: 'Water', icon: 'droplets', members: ['switch.heater'] });
    assert.throws(() => groups.update(g.id, { members: [g.entityId] }), /itself|can't be switched/);
    groups.update(g.id, { name: 'Hot water', members: ['switch.heater', 'switch.pump'] });

    await groups.stop();
    const again = new GroupEngine();
    await again.start(hostFor('group'));
    groups = again;
    assert.deepEqual(again.list().map((x) => [x.name, x.entityId, x.members.length]), [['Hot water', 'group.water', 2]], 'entity id stays after a rename');
    assert.equal(again.remove(g.id), true);
    assert.equal(registry.entity('group.water'), null);
    assert.equal(states.get('group.water'), null);
  });
});

describe('rooms and device flags', () => {
  it('creates unique rooms and clears them from devices when deleted', () => {
    const kitchen = areas.create('Kitchen', 'cooking-pot')!;
    assert.equal(kitchen.id, 'kitchen');
    assert.equal(areas.create('kitchen'), null, 'names are unique, case-insensitive');
    const dev = registry.allDevices('lite')[0];
    registry.updateDevice(dev.id, { areaId: 'kitchen' });
    registry.updateEntity('switch.pump', { areaId: 'kitchen' });
    assert.equal(areas.update('kitchen', { name: 'Kitchen & dining' })!.name, 'Kitchen & dining');
    assert.equal(areas.remove('kitchen'), true);
    assert.equal(registry.device(dev.id)!.areaId, null);
    assert.equal(registry.entity('switch.pump')!.areaId, null);
  });

  it('marks discovered devices new until reviewed; Sunroost\'s own are never new', () => {
    const dev = registry.allDevices('lite')[0];
    assert.equal(dev.reviewed, false);
    assert.equal(registry.registerDevice('energy', { uniqueId: 'system', name: 'Sunroost system' }).reviewed, true);
    registry.updateDevice(dev.id, { reviewed: true, hidden: true });
    registry.init();
    const again = registry.registerDevice('lite', { uniqueId: 'strip', name: 'Power strip' });
    assert.deepEqual([again.reviewed, again.hidden], [true, true], 'kept across re-registration and restart');
  });

  it('removes a device with its entities', () => {
    const dev = registry.allDevices('lite')[0];
    const ids = registry.removeDevice(dev.id);
    assert.deepEqual(ids.sort(), ['switch.fridge', 'switch.heater', 'switch.pump']);
    assert.equal(registry.device(dev.id), null);
    assert.ok(registry.entity('sensor.temp'), 'entities without the device are untouched');
  });
});
