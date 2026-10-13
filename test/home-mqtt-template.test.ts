import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, payloadVars, TemplateError } from '../src/home/lite/mqtt/template.ts';

const r = (tpl: string, payload: string) => compile(tpl).render(payloadVars(payload));

test('renders the templates real devices use', () => {
  // Tasmota
  assert.equal(r('{{value_json.POWER}}', '{"POWER":"ON"}'), 'ON');
  assert.equal(r("{{value_json['ENERGY']['Power']}}", '{"ENERGY":{"Power":152}}'), '152');
  // Zigbee2MQTT
  assert.equal(r('{{ value_json.state }}', '{"state":"OFF","brightness":120}'), 'OFF');
  assert.equal(r('{{ value_json.contact }}', '{"contact":false}'), 'False');
  assert.equal(r("{{ value_json.get('battery', 0) }}", '{"x":1}'), '0');
  // ESPHome: plain payloads
  assert.equal(r('{{ value }}', '23.5'), '23.5');
  // Filters bind tighter than arithmetic, as in Jinja: this rounds the 10, not the product.
  assert.equal(r('{{ value | float * 10 | round(1) }}', '2.345'), '23.450000000000003');
  assert.equal(r('{{ (value | float * 10) | round(1) }}', '2.345'), '23.5');
});

test('arithmetic, filters and precedence', () => {
  assert.equal(r('{{ (value | float * 1000) | int }}', '1.2345'), '1234');
  assert.equal(r('{{ value | int + 1 }}', '41'), '42');
  assert.equal(r('{{ "12.7" | int }}', ''), '12');
  assert.equal(r('{{ "abc" | float(0) }}', ''), '0');
  assert.equal(r('{{ float("x", default=5) }}', ''), '5');
  assert.equal(r('{{ value_json.t | round(1) }}', '{"t":21.456}'), '21.5');
  assert.equal(r("{{ value_json.mode | upper ~ '!' }}", '{"mode":"cool"}'), 'COOL!');
  assert.equal(r('{{ 7 // 2 }} {{ 7 % 3 }} {{ -2 * 3 }}', ''), '3 1 -6');
  assert.equal(r('{{ value_json.missing | default("n/a") }}', '{}'), 'n/a');
});

test('conditions: inline if, if blocks, tests, in', () => {
  assert.equal(r("{{ 'ON' if value_json.state == 'on' else 'OFF' }}", '{"state":"on"}'), 'ON');
  assert.equal(r('{% if value_json.contact %}closed{% else %}open{% endif %}', '{"contact":true}'), 'closed');
  assert.equal(r('{% if value | int > 50 %}high{% elif value | int > 10 %}mid{% else %}low{% endif %}', '20'), 'mid');
  assert.equal(r('{{ value_json.x is defined }} {{ value_json.y is not defined }}', '{"x":1}'), 'True True');
  assert.equal(r("{{ 'b' in value_json.list }} {{ 'z' not in value_json.list }}", '{"list":["a","b"]}'), 'True True');
  assert.equal(r('{{ value_json.a and value_json.b }} {{ not value_json.a }}', '{"a":1,"b":0}'), '0 False');
  assert.equal(r('{{ 1 == 1.0 }} {{ true == 1 }}', ''), 'True True');
});

test('whitespace control and plain text', () => {
  assert.equal(r('  {%- if true -%}  yes  {%- endif -%}  ', ''), 'yes');
  assert.equal(r('Power: {{ value }} W', '5'), 'Power: 5 W');
  assert.equal(r('no template', 'x'), 'no template');
});

test('missing values render empty, not as an error', () => {
  assert.equal(r('{{ value_json.nope }}', '{"a":1}'), '');
  assert.equal(r('{{ value_json.a.b.c }}', '{"a":1}'), '');
  assert.equal(r('{{ value_json.x }}', 'not json'), '');
});

test('unsupported syntax is a TemplateError, never code execution', () => {
  for (const bad of ['{{ value.__class__() }}', '{% for x in y %}{% endfor %}', '{{ value | evil }}', '{{ "a" + }}', '{% if x %}', "{{ 'x }}", '{{ value | int < none }}']) {
    assert.throws(() => r(bad, '{"a":1}'), TemplateError, bad);
  }
  assert.throws(() => r('{{ value_json.a | is_defined }}', '{}'), TemplateError);
  assert.throws(() => r('{{ 1 / 0 }}', ''), TemplateError);
});
