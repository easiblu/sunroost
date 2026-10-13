import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import type { Value } from '../src/core/metrics.ts';
import type { Snapshot } from '../src/core/state.ts';
import type { SettingDef, SettingValues } from '../src/devices/types.ts';
import { Publisher, type DevicesLike } from '../src/mqtt/publisher.ts';
import type { Transport } from '../src/mqtt/transport.ts';

openDb(':memory:');

class FakeTransport implements Transport {
  readonly kind = 'builtin';
  connected = true;
  clients = 0;
  lastError = null;
  onConnect: (() => void) | null = null;
  sent: { topic: string; payload: string; retain: boolean }[] = [];
  handlers: [string, (t: string, p: string) => void][] = [];
  publish(topic: string, payload: string, retain: boolean) {
    this.sent.push({ topic, payload, retain });
  }
  subscribe(filter: string, handler: (t: string, p: string) => void) {
    this.handlers.push([filter, handler]);
  }
  last(topic: string) {
    return this.sent.filter((s) => s.topic === topic).at(-1);
  }
  async flush() {}
  async close() {}
}

const DEFS: SettingDef[] = [
  { key: 'output_source_priority', label: 'Output source priority', section: 'x', type: 'select', options: ['Utility first', 'Solar first'] },
  { key: 'buzzer', label: 'Buzzer', section: 'x', type: 'checkbox' },
  { key: 'serial_lock', label: 'Serial lock', section: 'x', type: 'checkbox', readOnly: true },
];

class FakeDevices extends EventEmitter implements DevicesLike {
  started = true;
  inverterCount = 1;
  calls: [number, string, Value, string | undefined][] = [];
  values: SettingValues = { output_source_priority: 'Solar first', buzzer: false };
  settingDefs() {
    return DEFS;
  }
  settingValues() {
    return this.values;
  }
  async setSetting(index: number, key: string, value: Value, source?: string) {
    this.calls.push([index, key, value, source]);
    if (key === 'output_source_priority' && value !== 'Utility first') return { ok: false, message: `Invalid value '${value}'` };
    return { ok: true, message: `Set '${key}' to '${value}'` };
  }
}

const energy = () => ({ pv: 1.234, load: 2, gridImport: 0.5, gridExport: 0, batteryCharge: 1, batteryDischarge: 0.7 });
const cfg = { prefix: 'solar_assistant', uniq: 'sa', discovery: true, allowUpdate: true, resetEnergy: 'd' as const, manufacturer: 'Simulated' };
const snap = (pv: number): Snapshot => ({
  ts: Date.now(),
  inverters: [{ 'PV power': pv, 'Device mode': 'Battery', 'Model name': 'Sim 5k', 'Serial number': 'S1' }],
  batteries: [{ 'State of charge': 80 }],
  grid: { 'Grid price': 0.21 },
  totals: { 'PV power': pv, 'Serial number': 'S1' },
  energy: null,
  status: { inverter: { name: 'connected', message: '' }, battery: { name: 'connected', message: '' } },
});

test('publishes state, settings, energy and discovery; de-duplicates', async () => {
  const t = new FakeTransport();
  const d = new FakeDevices();
  const p = new Publisher(t, cfg, d, energy);
  p.start(snap(100));
  assert.equal(t.last('solar_assistant/status')?.payload, 'online');
  assert.equal(t.last('solar_assistant/inverter_1/pv_power/state')?.payload, '100');
  assert.equal(t.last('solar_assistant/inverter_1/device_mode/state')?.payload, 'Battery');
  assert.equal(t.last('solar_assistant/battery_1/state_of_charge/state')?.payload, '80');
  assert.equal(t.last('solar_assistant/total/pv_power/state')?.payload, '100');
  assert.equal(t.last('solar_assistant/total/serial_number/state'), undefined, 'info metrics stay off total');
  assert.equal(t.last('solar_assistant/grid/grid_price/state')?.payload, '0.21');
  assert.equal(t.last('solar_assistant/inverter_1/buzzer/state')?.payload, 'false');
  assert.equal(t.last('solar_assistant/total/pv_energy/state')?.payload, '1.23');
  assert.equal(t.last('solar_assistant/total/battery_energy_out/state')?.payload, '0.7');
  assert.ok(t.sent.filter((s) => s.topic.startsWith('solar_assistant/')).every((s) => s.retain));

  const cfgMsg = JSON.parse(t.last('homeassistant/sensor/sa_inverter_1_pv_power/config')!.payload);
  assert.equal(cfgMsg.device.model, 'Sim 5k');
  assert.equal(cfgMsg.device.manufacturer, 'Simulated');
  assert.ok(t.last('homeassistant/select/sa_inverter_1_output_source_priority/config'));
  assert.ok(t.last('homeassistant/switch/sa_inverter_1_buzzer/config'));
  assert.ok(t.last('homeassistant/sensor/sa_set_response_message/config'));

  const before = t.sent.length;
  p.publishSnapshot(snap(100));
  assert.equal(t.sent.length, before, 'unchanged values are not resent');
  p.publishSnapshot(snap(120));
  assert.deepEqual(t.sent.slice(before).map((s) => s.topic).sort(), ['solar_assistant/inverter_1/pv_power/state', 'solar_assistant/total/pv_power/state']);
  await p.stop();
  assert.equal(t.last('solar_assistant/status')?.payload, 'offline');
});

test('command validation guards and their messages', async () => {
  const t = new FakeTransport();
  const d = new FakeDevices();
  const p = new Publisher(t, cfg, d, energy);
  const resp = 'solar_assistant/set/response_message/state';

  assert.equal(await p.handleCommand('solar_assistant/inverter_2/buzzer/set', 'true'), 'Error: invalid device: inverter_2');
  assert.equal(await p.handleCommand('solar_assistant/battery_1/buzzer/set', 'true'), 'Error: invalid device: battery_1');
  assert.equal(await p.handleCommand('solar_assistant/inverter_1/nope/set', 'true'), 'Error: invalid setting: nope');
  assert.equal(await p.handleCommand('solar_assistant/inverter_1/serial_lock/set', 'true'), "Error: changing 'Serial lock' is not supported");
  assert.equal(t.last(resp)?.retain, false);
  assert.equal(d.calls.length, 0);

  assert.equal(await p.handleCommand('solar_assistant/inverter_1/buzzer/set', 'true'), "Set 'buzzer' to 'true'");
  assert.deepEqual(d.calls[0], [0, 'buzzer', 'true', 'mqtt']);
  assert.equal(t.last(resp)?.payload, "Set 'buzzer' to 'true'");
  assert.equal(await p.handleCommand('solar_assistant/inverter_1/output_source_priority/set', 'x'), "Invalid value 'x'");

  const noUpdates = new Publisher(t, { ...cfg, allowUpdate: false }, d, energy);
  assert.equal(await noUpdates.handleCommand('solar_assistant/inverter_1/buzzer/set', 'true'), 'Error: updates not allowed');
  d.started = false;
  assert.equal(await p.handleCommand('solar_assistant/inverter_1/buzzer/set', 'true'), 'Error: devices are not connected');
});

test('discovery: component switch removes the old config; clear and stale sweep', async () => {
  const t = new FakeTransport();
  const d = new FakeDevices();
  const p1 = new Publisher(t, { ...cfg, allowUpdate: false }, d, energy);
  p1.start(snap(1));
  assert.ok(t.last('homeassistant/sensor/sa_inverter_1_buzzer/config')?.payload);
  await p1.stop();

  // Enabling updates turns the sensor into a switch; the sensor config is removed.
  const p2 = new Publisher(t, cfg, d, energy);
  p2.start(snap(1));
  assert.equal(t.last('homeassistant/sensor/sa_inverter_1_buzzer/config')?.payload, '');
  assert.ok(t.last('homeassistant/switch/sa_inverter_1_buzzer/config')?.payload);
  await p2.stop();

  // A metric that disappears is swept after restart.
  const p3 = new Publisher(t, cfg, d, energy);
  const s = snap(1);
  delete s.inverters[0]['Device mode'];
  p3.start(s);
  assert.equal(p3.sweepStale(), 1);
  assert.equal(t.last('homeassistant/sensor/sa_inverter_1_device_mode/config')?.payload, '');

  p3.clearDiscovery();
  assert.equal(t.last('homeassistant/sensor/sa_inverter_1_pv_power/config')?.payload, '');
  await p3.stop();
});
