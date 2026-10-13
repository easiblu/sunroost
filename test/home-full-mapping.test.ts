import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDefaults } from '../src/home/full/index.ts';
import { initialValue } from '../src/home/full/flows.ts';
import { applyCompressed, includeEntity, isSolarsOwn, servicesFor, uiAttributes, type HaDevice, type HaState } from '../src/home/full/mapping.ts';

test('subscribe_entities events, in the shapes Home Assistant 2026.10 sends', () => {
  const cache = new Map<string, HaState>();
  let r = applyCompressed(cache, { a: { 'light.bed': { s: 'off', a: { friendly_name: 'Bed', brightness: null }, c: 'ctx0', lc: 1 } } });
  assert.deepEqual(r, { changed: ['light.bed'], removed: [] });
  // Captured: a change carries only what changed; attributes merge.
  r = applyCompressed(cache, { c: { 'light.bed': { '+': { s: 'on', lc: 2, c: { id: 'ctx1', user_id: 'u' }, a: { brightness: 100, color_mode: 'color_temp' } } } } });
  assert.deepEqual(cache.get('light.bed'), { s: 'on', a: { friendly_name: 'Bed', brightness: 100, color_mode: 'color_temp' }, lc: 2 });
  applyCompressed(cache, { c: { 'light.bed': { '+': { lu: 3 }, '-': { a: ['color_mode'] } } } });
  assert.deepEqual(cache.get('light.bed'), { s: 'on', a: { friendly_name: 'Bed', brightness: 100 }, lc: 2, lu: 3 });
  assert.deepEqual(applyCompressed(cache, { c: { 'switch.unknown': { '+': { s: 'on' } } } }).changed, [], 'changes to unknown ids are ignored');
  assert.deepEqual(applyCompressed(cache, { r: ['light.bed', 'light.never'] }), { changed: [], removed: ['light.bed'] });
});

test('which Home Assistant entities Sunroost mirrors', () => {
  const entry = (entity_id: string, extra = {}) => ({ entity_id, id: 'x', device_id: null, disabled_by: null, entity_category: null, platform: 'demo', ...extra });
  const solarDevice: HaDevice = { id: 'd1', name: 'Total', name_by_user: null, manufacturer: null, model: null, sw_version: null, area_id: null, identifiers: [['mqtt', 'sa_total']], disabled_by: null };
  const otherMqtt: HaDevice = { ...solarDevice, identifiers: [['mqtt', 'tasmota_ABC']] };
  assert.equal(includeEntity(entry('switch.a'), undefined, 'sa'), true);
  assert.equal(includeEntity(entry('switch.a', { disabled_by: 'user' }), undefined, 'sa'), false);
  assert.equal(includeEntity(entry('update.fw'), undefined, 'sa'), false, 'skipped domain');
  assert.equal(includeEntity(entry('sensor.backup_state', { platform: 'backup' }), undefined, 'sa'), false, 'Home Assistant housekeeping');
  assert.equal(includeEntity(entry('sensor.pv_power'), solarDevice, 'sa'), false, "Sunroost's own data coming back through MQTT");
  assert.equal(isSolarsOwn(otherMqtt, 'sa'), false);
  assert.equal(includeEntity(entry('switch.plug'), otherMqtt, 'sa'), true);
});

test('services and UI attributes', () => {
  const services = { switch: { turn_on: {}, turn_off: {}, toggle: {} }, sensor: {}, light: { turn_on: {}, reload: {} } };
  assert.deepEqual(servicesFor('switch', services), ['turn_on', 'turn_off', 'toggle']);
  assert.deepEqual(servicesFor('light', services), ['turn_on'], 'housekeeping services hidden');
  assert.deepEqual(servicesFor('sensor', services), []);
  assert.deepEqual(servicesFor('vacuum', services), [], 'unknown domain without services');
  assert.equal(uiAttributes('light', { supported_color_modes: ['onoff'] }).supports_brightness, false);
  assert.equal(uiAttributes('light', { supported_color_modes: ['color_temp', 'hs'] }).supports_brightness, true);
});

test('form input is completed like Home Assistant\'s own UI (captured MQTT broker form)', () => {
  const schema = [
    { name: 'broker', required: true, selector: { text: {} } },
    { name: 'port', required: true, default: 1883, type: 'integer' },
    { name: 'protocol', required: true, default: '5', selector: { select: { options: ['5', '3.1.1'] } } },
    { type: 'expandable', name: 'other_settings', required: true, schema: [
      { name: 'client_id', required: false, optional: true, selector: { text: {} } },
      { name: 'set_client_cert', required: true, selector: { boolean: {} } },
      { name: 'set_ca_cert', required: true, selector: { select: { options: ['off', 'auto', 'custom'] } } },
      { name: 'transport', required: true, default: 'tcp', selector: { select: { options: [{ value: 'tcp', label: 'TCP' }] } } },
    ] },
  ];
  assert.deepEqual(withDefaults({ broker: 'x', protocol: '3.1.1' }, schema), {
    broker: 'x', port: 1883, protocol: '3.1.1', other_settings: { set_client_cert: false, set_ca_cert: 'off', transport: 'tcp' },
  });
  assert.deepEqual(withDefaults({ broker: 'x', other_settings: { set_ca_cert: 'auto' } }, schema).other_settings,
    { set_ca_cert: 'auto', set_client_cert: false, transport: 'tcp' }, 'given values win');
  assert.equal(initialValue({ name: 'host', required: true, type: 'string' }), undefined, 'the user must type a host');
  assert.deepEqual(initialValue({ name: 'days', required: true, selector: { select: { options: ['mon'], multiple: true } } }), []);
  assert.equal(initialValue({ name: 'mode', required: true, type: 'select', options: [['a', 'A']] }), 'a');
});
