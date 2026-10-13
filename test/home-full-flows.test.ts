import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogue, field, fillPlaceholders, flowView } from '../src/home/full/flows.ts';

// Captured from Home Assistant 2026.10.1 (the MQTT broker step, its translations, and a slice of integration/descriptions).
const fx = JSON.parse(readFileSync(new URL('./fixtures/ha-mqtt-flow.json', import.meta.url), 'utf8'));

test('a real selector-based form becomes translated fields, including a section', () => {
  const v = flowView(fx.step, fx.translations, 'MQTT');
  assert.equal(v.type, 'form');
  if (v.type !== 'form') return;
  const byName = Object.fromEntries(v.fields.map((f) => [f.name, f]));
  assert.equal(byName.broker.kind, 'text');
  assert.equal(byName.broker.required, true);
  assert.equal(byName.broker.label, fx.translations['component.mqtt.config.step.broker.data.broker']);
  assert.equal(byName.port.kind, 'number');
  assert.deepEqual([byName.port.min, byName.port.max, byName.port.default], [1, 65535, 1883]);
  assert.equal(byName.password.kind, 'password');
  assert.equal(byName.protocol.kind, 'select');
  assert.deepEqual(byName.protocol.options!.map((o) => o.value), ['5', '3.1.1', '3.1']);
  const section = v.fields.find((f) => f.kind === 'section')!;
  assert.ok(section.fields!.some((f) => f.name === 'client_id'), 'advanced options live in a section');
  assert.equal(section.collapsed, true);
});

test('voluptuous-style fields, menus, aborts and errors', () => {
  const tr = {
    'component.met.config.step.user.data.latitude': 'Latitude',
    'component.met.config.error.already_configured': 'Already set up for {place}',
    'component.met.config.abort.single_instance_allowed': 'Only one, please.',
    'component.template.config.step.user.menu_options.switch': 'Template a switch',
  };
  const met = flowView({
    type: 'form', flow_id: 'f1', handler: 'met', step_id: 'user', errors: { base: 'already_configured' }, description_placeholders: { place: 'Home' },
    data_schema: [
      { type: 'float', name: 'latitude', required: true, valueMin: -90, valueMax: 90, default: 1.5 },
      { type: 'string', name: 'api_key', required: false },
      { type: 'select', name: 'mode', options: [['a', 'Mode A'], ['b', 'Mode B']] },
      { type: 'multi_select', name: 'days', options: { mon: 'Monday', tue: 'Tuesday' } },
      { selector: { entity: {} }, name: 'sensor' },
    ],
  }, tr, 'Met.no');
  assert.equal(met.type, 'form');
  if (met.type !== 'form') return;
  assert.deepEqual(met.fields.map((f) => [f.name, f.kind]), [['latitude', 'number'], ['api_key', 'password'], ['mode', 'select'], ['days', 'multiselect'], ['sensor', 'unsupported']]);
  assert.equal(met.fields[0].label, 'Latitude');
  assert.equal(met.fields[1].label, 'Api key', 'untranslated names are humanised');
  assert.deepEqual(met.fields[3].options, [{ value: 'mon', label: 'Monday' }, { value: 'tue', label: 'Tuesday' }]);
  assert.equal(met.errors.base, 'Already set up for Home');
  assert.equal(met.title, 'Met.no');

  const menu = flowView({ type: 'menu', flow_id: 'f2', handler: 'template', step_id: 'user', menu_options: ['switch', 'binary_sensor'] }, tr, 'Template');
  assert.deepEqual(menu.type === 'menu' && menu.options, [{ value: 'switch', label: 'Template a switch' }, { value: 'binary_sensor', label: 'Binary sensor' }]);

  assert.deepEqual(flowView({ type: 'abort', handler: 'met', reason: 'single_instance_allowed' }, tr, 'Met.no'), { type: 'abort', handler: 'met', title: 'Met.no', reason: 'Only one, please.' });
  assert.equal(flowView({ type: 'create_entry', handler: 'met', title: 'Home' }, tr, 'Met.no').type, 'create_entry');
  assert.equal(flowView({ type: 'external', flow_id: 'f3', handler: 'x', step_id: 'auth', url: 'https://x' }, {}, 'X').type, 'external');
});

test('the integration catalogue lists only integrations with a config flow, brands flattened', () => {
  const list = catalogue(fx.descriptions);
  const domains = list.map((i) => i.domain);
  assert.ok(domains.includes('hue') && domains.includes('esphome') && domains.includes('mqtt') && domains.includes('shelly'));
  assert.ok(!domains.includes('demo'), 'no config flow');
  assert.ok(!domains.includes('philips'), 'brands are not integrations');
  assert.equal(list.find((i) => i.domain === 'hue')!.brand, 'Philips');
  assert.deepEqual([...domains].sort((a, b) => list.find((i) => i.domain === a)!.name.localeCompare(list.find((i) => i.domain === b)!.name)), domains, 'sorted by name');
});

test('placeholders and section translation paths', () => {
  assert.equal(fillPlaceholders('Pair {name} at {host}', { name: 'Hue' }), 'Pair Hue at {host}');
  const sec = field({ type: 'expandable', name: 'advanced', expanded: true, schema: [{ type: 'string', name: 'path' }] },
    { 'component.x.config.step.s.sections.advanced.name': 'Advanced', 'component.x.config.step.s.sections.advanced.data.path': 'Path' }, 'x', 'component.x.config.step.s');
  assert.deepEqual([sec.label, sec.collapsed, sec.fields![0].label], ['Advanced', false, 'Path']);
});
