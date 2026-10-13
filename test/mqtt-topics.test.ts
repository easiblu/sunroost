import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responseConfig, sensorConfig, settingConfig, type DeviceInfo } from '../src/mqtt/discovery.ts';
import {
  availabilityTopic, commandFilter, deviceName, deviceSegment, formatPayload, metricSegment, parseCommandTopic,
  responseTopic, safeUrl, stateTopic,
} from '../src/mqtt/topics.ts';
import { matches } from '../src/mqtt/transport.ts';

const ctx = { prefix: 'solar_assistant', uniq: 'sa', allowUpdate: true };
const inv: DeviceInfo = { segment: 'inverter_1', name: 'Inverter 1', manufacturer: 'Growatt', model: 'SPF 5000' };

test('topic naming follows the published MQTT API', () => {
  assert.equal(metricSegment('PV power 1'), 'pv_power_1');
  assert.equal(metricSegment('Battery state of charge'), 'battery_state_of_charge');
  assert.equal(metricSegment('Cell voltage - Highest'), 'cell_voltage_-_highest');
  assert.equal(deviceSegment('inverter', 0), 'inverter_1');
  assert.equal(deviceSegment('battery', 1), 'battery_2');
  assert.equal(deviceSegment('total'), 'total');
  assert.equal(deviceName('inverter', 1), 'Inverter 2');
  assert.equal(deviceName('total'), 'Total');
  assert.equal(stateTopic('solar_assistant', 'inverter_1', 'pv_power'), 'solar_assistant/inverter_1/pv_power/state');
  assert.equal(commandFilter('solar_assistant'), 'solar_assistant/+/+/set');
  assert.equal(responseTopic('solar_assistant'), 'solar_assistant/set/response_message/state');
  assert.equal(availabilityTopic('x'), 'x/status');
});

test('payloads are plain text', () => {
  assert.equal(formatPayload(12.5), '12.5');
  assert.equal(formatPayload(true), 'true');
  assert.equal(formatPayload(false), 'false');
  assert.equal(formatPayload('Battery'), 'Battery');
  assert.equal(formatPayload(null), null);
  assert.equal(formatPayload(NaN), null);
});

test('command topic parsing and filter matching', () => {
  assert.deepEqual(parseCommandTopic('solar_assistant', 'solar_assistant/inverter_1/buzzer/set'), { device: 'inverter_1', metric: 'buzzer' });
  assert.equal(parseCommandTopic('solar_assistant', 'solar_assistant/inverter_1/buzzer/state'), null);
  assert.equal(parseCommandTopic('solar_assistant', 'other/inverter_1/buzzer/set'), null);
  assert.ok(matches('a/+/+/set', 'a/inverter_1/x/set'));
  assert.ok(!matches('a/+/+/set', 'a/set/response_message/state'));
  assert.ok(matches('a/#', 'a/b/c'));
  assert.equal(safeUrl('mqtt://user:secret@host:1883'), 'mqtt://host:1883');
});

test('sensor discovery payload', () => {
  const m = sensorConfig(ctx, inv, 'pv_power', 'PV power', true);
  assert.equal(m.topic, 'homeassistant/sensor/sa_inverter_1_pv_power/config');
  assert.deepEqual(m.payload, {
    name: 'PV power',
    unique_id: 'sa_inverter_1_pv_power',
    object_id: 'sa_inverter_1_pv_power',
    state_topic: 'solar_assistant/inverter_1/pv_power/state',
    availability_topic: 'solar_assistant/status',
    device: { identifiers: ['sa_inverter_1'], name: 'Inverter 1', manufacturer: 'Growatt', model: 'SPF 5000', via_device: 'sa_total' },
    unit_of_measurement: 'W',
    device_class: 'power',
    state_class: 'measurement',
  });
  const total: DeviceInfo = { segment: 'total', name: 'Total', manufacturer: 'Growatt' };
  const e = sensorConfig(ctx, total, 'pv_energy', 'PV energy', true).payload;
  assert.equal(e.state_class, 'total_increasing');
  assert.equal(e.unit_of_measurement, 'kWh');
  assert.equal(e.device_class, 'energy');
  assert.equal((e.device as Record<string, unknown>).via_device, undefined);
  const soc = sensorConfig(ctx, inv, 'battery_state_of_charge', 'Battery state of charge', true).payload;
  assert.equal(soc.device_class, 'battery');
  const mode = sensorConfig(ctx, inv, 'device_mode', 'Device mode', false).payload;
  assert.equal(mode.state_class, undefined);
  assert.equal(mode.unit_of_measurement, undefined);
});

test('setting discovery: select, number, switch, text', () => {
  const sel = settingConfig(ctx, inv, { key: 'output_source_priority', label: 'Output source priority', section: 'x', type: 'select', options: ['A', 'B'] });
  assert.equal(sel.topic, 'homeassistant/select/sa_inverter_1_output_source_priority/config');
  assert.equal(sel.payload.command_topic, 'solar_assistant/inverter_1/output_source_priority/set');
  assert.deepEqual(sel.payload.options, ['A', 'B']);

  const num = settingConfig(ctx, inv, { key: 'max_charge_current', label: 'Max charge current', section: 'x', type: 'number', min: 10, max: 120, step: 10, unit: 'A' });
  assert.equal(num.component, 'number');
  assert.equal(num.payload.min, 10);
  assert.equal(num.payload.max, 120);
  assert.equal(num.payload.step, 10);
  assert.equal(num.payload.unit_of_measurement, 'A');

  const sw = settingConfig(ctx, inv, { key: 'buzzer', label: 'Buzzer', section: 'x', type: 'checkbox' });
  assert.equal(sw.component, 'switch');
  assert.equal(sw.payload.payload_on, 'true');
  assert.equal(sw.payload.payload_off, 'false');

  const slot = settingConfig(ctx, inv, { key: 'slot_1', label: 'Slot 1', section: 'x', type: 'slot', slotPriorities: ['Load first', 'Battery first'] });
  assert.equal(slot.component, 'text');
  assert.ok(new RegExp(slot.payload.pattern as string).test('01:00,05:00,Battery first,true'));
  assert.ok(!new RegExp(slot.payload.pattern as string).test('01:00,05:00,true'));
  const time = settingConfig(ctx, inv, { key: 't', label: 'T', section: 'x', type: 'time' });
  assert.ok(new RegExp(time.payload.pattern as string).test('23:59'));

  // Read-only when updates aren't allowed.
  const ro = settingConfig({ ...ctx, allowUpdate: false }, inv, { key: 'buzzer', label: 'Buzzer', section: 'x', type: 'checkbox' });
  assert.equal(ro.component, 'sensor');
  assert.equal(ro.payload.command_topic, undefined);

  const resp = responseConfig(ctx, { segment: 'total', name: 'Total' });
  assert.equal(resp.topic, 'homeassistant/sensor/sa_set_response_message/config');
  assert.equal(resp.payload.state_topic, 'solar_assistant/set/response_message/state');
});
