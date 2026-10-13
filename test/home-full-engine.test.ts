import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { newContext } from '../src/home/bus.ts';
import { FullEngine, TOKEN_SECRET } from '../src/home/full/index.ts';
import { hostFor } from '../src/home/index.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';

/**
 * A fake Home Assistant with the parts of its API Sunroost uses, in the shapes captured from
 * Home Assistant 2026.10.1: onboarding, auth, registries, subscribe_entities, call_service.
 */
function fakeHa() {
  const ha = {
    onboarded: false,
    tokens: new Set<string>(),
    states: {
      'switch.pump': { s: 'off', a: { friendly_name: 'Pool pump' }, c: 'c0', lc: 1 },
      'sensor.pump_power': { s: '0', a: { friendly_name: 'Pool pump Power', unit_of_measurement: 'W', device_class: 'power' }, c: 'c0', lc: 1 },
      'sensor.pump_signal': { s: '-60', a: { friendly_name: 'Pool pump Signal', unit_of_measurement: 'dBm' }, c: 'c0', lc: 1 },
      'update.pump_firmware': { s: 'off', a: { friendly_name: 'Firmware' }, c: 'c0', lc: 1 },
    } as Record<string, { s: string; a: Record<string, unknown>; c: string; lc: number }>,
    entities: [
      { entity_id: 'switch.pump', id: 'e1', device_id: 'd1', disabled_by: null, entity_category: null, platform: 'shelly' },
      { entity_id: 'sensor.pump_power', id: 'e2', device_id: 'd1', disabled_by: null, entity_category: null, platform: 'shelly' },
      { entity_id: 'sensor.pump_signal', id: 'e3', device_id: 'd1', disabled_by: null, entity_category: 'diagnostic', platform: 'shelly' },
      { entity_id: 'update.pump_firmware', id: 'e4', device_id: 'd1', disabled_by: null, entity_category: 'config', platform: 'shelly' },
    ],
    devices: [{ id: 'd1', name: 'Pool pump', name_by_user: null, manufacturer: 'Shelly', model: 'Plus Plug S', sw_version: '1.4', area_id: 'garden', identifiers: [['shelly', 'abc']], disabled_by: null }],
    sockets: new Set<{ send(t: string): void; close(): void }>(),
    entitySubs: [] as { send(t: string): void; id: number }[],
    registrySubs: [] as { send(t: string): void; id: number }[],
    calls: [] as Record<string, unknown>[],
  };
  const app = Fastify();
  app.register(fastifyWebsocket);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  app.get('/api/onboarding', async () => [
    { step: 'user', done: ha.onboarded }, { step: 'core_config', done: ha.onboarded }, { step: 'analytics', done: ha.onboarded }, { step: 'integration', done: ha.onboarded },
  ]);
  app.post('/api/onboarding/users', async () => {
    ha.onboarded = true;
    return { auth_code: 'code1' };
  });
  app.post('/auth/token', async (req) => {
    assert.equal((req.body as Record<string, string>).code, 'code1');
    ha.tokens.add('short-lived');
    return { access_token: 'short-lived', token_type: 'Bearer' };
  });
  for (const step of ['core_config', 'analytics', 'integration']) app.post(`/api/onboarding/${step}`, async () => ({}));
  app.register(async (scope) => {
    scope.get('/api/websocket', { websocket: true }, (socket) => {
      ha.sockets.add(socket);
      socket.on('close', () => ha.sockets.delete(socket));
      const send = (m: unknown) => socket.send(JSON.stringify(m));
      send({ type: 'auth_required', ha_version: '2026.10.1' });
      socket.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth') return send(ha.tokens.has(m.access_token) ? { type: 'auth_ok', ha_version: '2026.10.1' } : { type: 'auth_invalid', message: 'Invalid access token' });
        const ok = (result: unknown = null) => send({ id: m.id, type: 'result', success: true, result });
        switch (m.type) {
          case 'auth/long_lived_access_token':
            ha.tokens.add('long-lived-token-0123456789');
            return ok('long-lived-token-0123456789');
          case 'config/core/update':
            return ok();
          case 'get_services':
            return ok({ switch: { turn_on: {}, turn_off: {}, toggle: {} }, sensor: {}, update: { install: {} } });
          case 'config/entity_registry/list':
            return ok(ha.entities);
          case 'config/device_registry/list':
            return ok(ha.devices);
          case 'config/area_registry/list':
            return ok([{ area_id: 'garden', name: 'Garden' }]);
          case 'subscribe_entities':
            ok();
            ha.entitySubs.push({ send: (t) => socket.send(t), id: m.id });
            return send({ id: m.id, type: 'event', event: { a: ha.states } });
          case 'subscribe_events':
            ha.registrySubs.push({ send: (t) => socket.send(t), id: m.id });
            return ok();
          case 'call_service': {
            ha.calls.push(m);
            const id = m.target.entity_id;
            const st = ha.states[id];
            const next = m.service === 'toggle' ? (st.s === 'on' ? 'off' : 'on') : m.service === 'turn_on' ? 'on' : 'off';
            st.s = next;
            ok({ context: { id: 'ctx-cmd-1', parent_id: null, user_id: 'u' } });
            // As captured: only what changed, with the command's context.
            for (const sub of ha.entitySubs) sub.send(JSON.stringify({ id: sub.id, type: 'event', event: { c: { [id]: { '+': { s: next, lc: 2, c: { id: 'ctx-cmd-1' } } } } } }));
            return;
          }
          default:
            return send({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command', message: `Unknown command ${m.type}` } });
        }
      });
    });
  });
  return { ha, app };
}

let srv: ReturnType<typeof fakeHa>;
let engine: FullEngine;

async function until<T>(what: string, fn: () => T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
  srv = fakeHa();
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (srv.app.server.address() as { port: number }).port;
  settings.setMany({ 'home.full_url': `http://127.0.0.1:${port}`, publish_mqtt: false });
  engine = new FullEngine();
  engine.retryMs = [50];
  engine.resyncMs = 20;
  setEngineLookup((id) => (id === 'full' ? engine : null));
  await engine.start(hostFor('full'));
});

after(async () => {
  await engine.stop();
  await srv.app.close();
});

test('sets up a fresh Home Assistant by itself and stores the token encrypted', async () => {
  await until('connected', () => engine.info().state === 'connected');
  assert.equal(secrets.get(TOKEN_SECRET), 'long-lived-token-0123456789');
  assert.ok(secrets.get('home.full_password'), 'owner password kept for later admin');
  assert.equal(engine.info().version, '2026.10.1');
});

test('mirrors devices and entities with Home Assistant\'s ids, rooms and visibility', async () => {
  await until('pump', () => states.get('switch.pump')?.state === 'off');
  const pump = registry.entity('switch.pump')!;
  assert.equal(pump.originalName, 'Pool pump');
  assert.deepEqual(pump.services, ['turn_on', 'turn_off', 'toggle']);
  const dev = registry.device(pump.deviceId!)!;
  assert.deepEqual([dev.name, dev.manufacturer, dev.model], ['Pool pump', 'Shelly', 'Plus Plug S']);
  assert.equal(dev.reviewed, true, 'already set up in Home Assistant when Solar first linked: not "new"');
  assert.equal(areas.get(dev.areaId!)?.name, 'Garden', "Home Assistant's room is suggested");
  assert.equal(registry.entity('sensor.pump_power')!.unit, 'W');
  assert.equal(registry.entity('sensor.pump_power')!.readOnly, true);
  assert.equal(registry.entity('sensor.pump_signal')!.hidden, true, 'diagnostic entities start hidden');
  assert.equal(registry.entity('update.pump_firmware'), null, 'skipped domain');
});

test('commands go through call_service and are confirmed by the pushed change, with the context chain', async () => {
  const res = await callService('switch', 'turn_on', 'switch.pump', {}, newContext('user'), { confirmMs: 2000 });
  assert.deepEqual(res.results['switch.pump'], { ok: true, confirmed: true, message: undefined });
  assert.deepEqual(srv.ha.calls.at(-1)!.target, { entity_id: 'switch.pump' });
  assert.equal(states.get('switch.pump')!.context.parentId, res.context.id);
});

test('follows registry changes: a removed entity disappears from Sunroost', async () => {
  srv.ha.entities = srv.ha.entities.filter((e) => e.entity_id !== 'sensor.pump_power');
  delete srv.ha.states['sensor.pump_power'];
  for (const sub of srv.ha.registrySubs) sub.send(JSON.stringify({ id: sub.id, type: 'event', event: { event_type: 'entity_registry_updated', data: { action: 'remove' } } }));
  await until('removed', () => registry.entity('sensor.pump_power') === null);
  assert.ok(registry.entity('switch.pump'));
});

test('a device added in Home Assistant later shows up as new, in its Home Assistant room', async () => {
  srv.ha.devices.push({ id: 'd2', name: 'Geyser', name_by_user: null, manufacturer: 'Sonoff', model: 'POW', sw_version: '1.0', area_id: 'garden', identifiers: [['esphome', 'g1']], disabled_by: null });
  srv.ha.entities.push({ entity_id: 'switch.geyser', id: 'e9', device_id: 'd2', disabled_by: null, entity_category: null, platform: 'esphome' });
  srv.ha.states['switch.geyser'] = { s: 'off', a: { friendly_name: 'Geyser' }, c: 'c0', lc: 1 };
  for (const sub of srv.ha.entitySubs) sub.send(JSON.stringify({ id: sub.id, type: 'event', event: { a: { 'switch.geyser': srv.ha.states['switch.geyser'] } } }));
  await until('geyser', () => registry.entity('switch.geyser'));
  const dev = registry.device(registry.entity('switch.geyser')!.deviceId!)!;
  assert.equal(dev.reviewed, false);
  assert.equal(areas.get(dev.areaId!)?.name, 'Garden');
});

test('a dropped connection marks everything unavailable, then reconnects with the stored token', async () => {
  for (const s of [...srv.ha.sockets]) s.close();
  await until('unavailable', () => states.get('switch.pump')?.state === 'unavailable');
  assert.notEqual(engine.info().state, 'connected');
  await until('reconnected', () => engine.info().state === 'connected' && states.get('switch.pump')?.state === 'on');
});

test('a rejected token asks for a new one instead of retrying forever', async () => {
  srv.ha.tokens.clear();
  for (const s of [...srv.ha.sockets]) s.close();
  await until('setup state', () => engine.info().state === 'setup');
  assert.match(engine.info().message!, /rejected/);
});
