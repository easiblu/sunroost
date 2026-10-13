import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entityName, parseDiscovery, topicsOf, type DiscoveredEntity } from '../src/home/lite/mqtt/discovery.ts';
import { MqttEntity } from '../src/home/lite/mqtt/entities.ts';

const P = 'homeassistant';

function one(topic: string, cfg: Record<string, unknown>): DiscoveredEntity {
  const r = parseDiscovery(P, topic, JSON.stringify(cfg));
  assert.equal(r.kind, 'entities');
  if (r.kind !== 'entities') throw new Error();
  assert.equal(r.entities.length, 1);
  return r.entities[0];
}

const nameOf = (d: DiscoveredEntity) => entityName(d, d.device?.name ?? null);
const entity = (component: string, cfg: Record<string, unknown>) => new MqttEntity(one(`${P}/${component}/x/config`, cfg));
const payloads = (r: ReturnType<MqttEntity['command']>) => {
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  return r.ok ? r.publish.map((p) => `${p.topic}=${p.payload}`) : [];
};

describe('discovery parsing', () => {
  it('expands abbreviations and the ~ base topic (Tasmota)', () => {
    const d = one(`${P}/switch/ABC_RL_1/config`, {
      name: 'Kitchen', '~': 'kitchen/', cmd_t: '~cmnd/POWER', stat_t: '~tele/STATE', avty_t: '~tele/LWT', uniq_id: 'ABC_RL_1',
      dev: { ids: ['ABC'], name: 'Sonoff', mf: 'Tasmota', mdl: 'Basic', sw: '14.3' },
    });
    assert.equal(d.config.command_topic, 'kitchen/cmnd/POWER');
    assert.equal(d.config.state_topic, 'kitchen/tele/STATE');
    assert.equal(d.config.availability_topic, 'kitchen/tele/LWT');
    assert.equal(d.uniqueId, 'ABC_RL_1');
    assert.deepEqual(d.device, { uniqueId: 'ABC', name: 'Sonoff', manufacturer: 'Tasmota', model: 'Basic', swVersion: '14.3' });
    assert.equal(nameOf(d), 'Sonoff Kitchen');
    assert.deepEqual(topicsOf(d.config).sort(), ['kitchen/cmnd/POWER', 'kitchen/tele/LWT', 'kitchen/tele/STATE']);
  });

  it('names entities like Home Assistant: null → device name, prefixed names kept', () => {
    assert.equal(nameOf(one(`${P}/light/n/config`, { name: null, cmd_t: 'a', dev: { ids: 'd', name: 'Desk lamp' } })), 'Desk lamp');
    assert.equal(nameOf(one(`${P}/sensor/n/config`, { name: 'Desk lamp power', stat_t: 'a', dev: { ids: 'd', name: 'Desk lamp' } })), 'Desk lamp power');
    assert.equal(nameOf(one(`${P}/sensor/node/obj/config`, { stat_t: 'a' })), 'obj');
    const partial = one(`${P}/sensor/n/config`, { name: 'Power', stat_t: 'a', dev: { ids: 'd' } });
    assert.equal(partial.device!.name, null, 'device block with only an id');
    assert.equal(entityName(partial, 'Desk lamp'), 'Desk lamp Power', 'named from the merged device');
    assert.equal(one(`${P}/sensor/n/config`, { stat_t: 'a', default_entity_id: 'sensor.my_temp' }).objectId, 'my_temp');
    assert.equal(one(`${P}/sensor/n/config`, { stat_t: 'a', uniq_id: 'u' }).uniqueId, 'u');
    assert.equal(one(`${P}/sensor/n/config`, { stat_t: 'a' }).uniqueId, `${P}/sensor/n/config`, 'falls back to the topic');
  });

  it('identifies devices by connection when there are no identifiers', () => {
    const d = one(`${P}/switch/n/config`, { cmd_t: 'a', dev: { cns: [['mac', 'AA:BB:CC:00:11:22']], name: 'Plug' } });
    assert.equal(d.device!.uniqueId, 'mac:aa:bb:cc:00:11:22');
  });

  it('parses device-based discovery with shared settings', () => {
    const r = parseDiscovery(P, `${P}/device/ac1/config`, JSON.stringify({
      dev: { ids: 'ac1', name: 'AC' }, o: { name: 'ESPHome' }, avty_t: 'ac1/status', '~': 'ac1/',
      cmps: {
        c: { p: 'climate', name: null, uniq_id: 'ac1-c', mode_stat_t: '~mode', mode_cmd_t: '~mode/set' },
        t: { p: 'sensor', name: 'Temp', uniq_id: 'ac1-t', stat_t: '~temp' },
        gone: { p: 'sensor' },
        cam: { p: 'camera', uniq_id: 'ac1-cam' },
      },
    }));
    assert.equal(r.kind, 'entities');
    if (r.kind !== 'entities') return;
    assert.deepEqual(r.entities.map((e) => [e.key.split('#')[1], e.component, nameOf(e)]), [['c', 'climate', 'AC'], ['t', 'sensor', 'AC Temp']]);
    assert.equal(r.entities[0].config.mode_state_topic, 'ac1/mode');
    assert.equal(r.entities[0].config.availability_topic, 'ac1/status', 'shared availability');
    assert.deepEqual(r.removed, [`${P}/device/ac1/config#gone`]);
  });

  it('handles removal, unsupported components and junk', () => {
    assert.deepEqual(parseDiscovery(P, `${P}/switch/x/config`, ''), { kind: 'remove', keyPrefix: `${P}/switch/x/config` });
    assert.equal(parseDiscovery(P, `${P}/camera/x/config`, '{}').kind, 'ignore');
    assert.equal(parseDiscovery(P, `${P}/switch/x/config`, 'not json').kind, 'ignore');
    assert.equal(parseDiscovery(P, `${P}/switch/x/state`, '{}').kind, 'ignore');
    assert.equal(parseDiscovery(P, `${P}/status`, 'online').kind, 'ignore');
    assert.equal(parseDiscovery(P, `${P}/a/b/c/d/config`, '{}').kind, 'ignore');
  });
});

describe('entity behaviour', () => {
  it('switch: templates, custom payloads, commands and toggle', () => {
    const e = entity('switch', { stat_t: 's', cmd_t: 'c', val_tpl: '{{ value_json.POWER }}', pl_on: 'ON', pl_off: 'OFF', qos: 1, ret: true });
    assert.equal(e.optimistic, false);
    assert.deepEqual(e.subscriptions(), ['s']);
    assert.equal(e.handle('s', '{"POWER":"ON"}'), true);
    assert.equal(e.state, 'on');
    assert.equal(e.handle('s', '{"POWER":"ON"}'), false, 'no change');
    const r = e.command('toggle', {});
    assert.deepEqual(payloads(r), ['c=OFF']);
    assert.equal(r.ok && r.publish[0].qos, 1);
    assert.equal(r.ok && r.publish[0].retain, true);
    assert.equal(e.state, 'on', 'not optimistic: waits for the device');
  });

  it('switch without a state topic is optimistic', () => {
    const e = entity('switch', { cmd_t: 'c', pl_on: 1, pl_off: 0 });
    assert.equal(e.optimistic, true);
    assert.deepEqual(payloads(e.command('turn_on', {})), ['c=1']);
    assert.equal(e.state, 'on');
  });

  it('binary_sensor compares like Python (Zigbee2MQTT booleans)', () => {
    const e = entity('binary_sensor', { stat_t: 'z', val_tpl: '{{ value_json.contact }}', pl_on: false, pl_off: true });
    e.handle('z', '{"contact":false}');
    assert.equal(e.state, 'on');
    e.handle('z', '{"contact":true}');
    assert.equal(e.state, 'off');
    assert.deepEqual(e.services, []);
  });

  it('sensor ignores messages its template has no value for', () => {
    const e = entity('sensor', { stat_t: 't', val_tpl: '{{ value_json.temperature }}', unit_of_meas: '°C' });
    e.handle('t', '{"temperature":21.5}');
    e.handle('t', '{"humidity":40}');
    assert.equal(e.state, '21.5');
  });

  it('availability: latest (default), all and any', () => {
    const latest = entity('sensor', { stat_t: 't', avty: [{ t: 'a1' }, { t: 'a2', pl_avail: 'up', pl_not_avail: 'down' }] });
    assert.equal(latest.available, false, 'unavailable until announced');
    latest.handle('a1', 'online');
    assert.equal(latest.available, true);
    latest.handle('a2', 'down');
    assert.equal(latest.available, false);

    const all = entity('sensor', { stat_t: 't', avty_mode: 'all', avty: [{ t: 'a1' }, { t: 'a2' }] });
    all.handle('a1', 'online');
    assert.equal(all.available, false);
    all.handle('a2', 'online');
    assert.equal(all.available, true);

    const any = entity('sensor', { stat_t: 't', avty_mode: 'any', avty: [{ t: 'a1' }, { t: 'a2' }] });
    any.handle('a2', 'online');
    assert.equal(any.available, true);

    const tpl = entity('light', { schema: 'json', cmd_t: 'c', stat_t: 's', avty: [{ t: 'bridge', val_tpl: '{{ value_json.state }}' }] });
    tpl.handle('bridge', '{"state":"online"}');
    assert.equal(tpl.available, true);
    assert.equal(entity('sensor', { stat_t: 't' }).available, true, 'no availability topic: always available');
  });

  it('json attributes are merged in', () => {
    const e = entity('sensor', { stat_t: 't', json_attr_t: 'attrs' });
    e.handle('attrs', '{"rssi":-60,"ip":"10.0.0.5"}');
    assert.deepEqual(e.attributes, { rssi: -60, ip: '10.0.0.5' });
  });

  it('light, JSON schema: brightness scaled to and from 0–255', () => {
    const e = entity('light', { schema: 'json', cmd_t: 'c', stat_t: 's', brightness_scale: 254 });
    e.handle('s', '{"state":"ON","brightness":254}');
    assert.equal(e.state, 'on');
    assert.equal(e.attributes.brightness, 255);
    assert.deepEqual(payloads(e.command('turn_on', { brightness: 255 })), ['c={"state":"ON","brightness":254}']);
    assert.deepEqual(payloads(e.command('turn_off', {})), ['c={"state":"OFF"}']);
    assert.equal(e.command('turn_on', { brightness: 300 }).ok, false);
  });

  it('light, default schema: on_command_type ordering', () => {
    const base = { cmd_t: 'c', stat_t: 's', bri_cmd_t: 'b', bri_stat_t: 'bs', bri_scl: 100 };
    assert.deepEqual(payloads(entity('light', base).command('turn_on', { brightness: 255 })), ['b=100', 'c=ON']);
    assert.deepEqual(payloads(entity('light', { ...base, on_cmd_type: 'first' }).command('turn_on', { brightness: 51 })), ['c=ON', 'b=20']);
    assert.deepEqual(payloads(entity('light', { ...base, on_cmd_type: 'brightness' }).command('turn_on', { brightness: 255 })), ['b=100']);
    assert.deepEqual(payloads(entity('light', base).command('turn_on', {})), ['c=ON']);
    const e = entity('light', base);
    e.handle('bs', '50');
    assert.equal(e.attributes.brightness, 128);
  });

  it('fan: percentage through the speed range', () => {
    const e = entity('fan', { cmd_t: 'c', stat_t: 's', pct_cmd_t: 'p', pct_stat_t: 'ps', spd_rng_min: 1, spd_rng_max: 3 });
    assert.deepEqual(e.services, ['turn_on', 'turn_off', 'toggle', 'set_percentage']);
    assert.deepEqual(payloads(e.command('set_percentage', { percentage: 50 })), ['p=2']);
    e.handle('ps', '3');
    assert.equal(e.attributes.percentage, 100);
  });

  it('select and number validate before sending', () => {
    const sel = entity('select', { cmd_t: 'c', stat_t: 's', ops: ['eco', 'boost'] });
    assert.equal(sel.command('select_option', { option: 'turbo' }).ok, false);
    assert.deepEqual(payloads(sel.command('select_option', { option: 'boost' })), ['c=boost']);
    sel.handle('s', 'nonsense');
    assert.notEqual(sel.state, 'nonsense');

    const num = entity('number', { cmd_t: 'c', stat_t: 's', min: 6, max: 32, cmd_tpl: '{"current": {{ value }}}' });
    assert.equal(num.command('set_value', { value: 40 }).ok, false);
    assert.deepEqual(payloads(num.command('set_value', { value: 16 })), ['c={"current": 16}']);
    num.handle('s', '16.0');
    assert.equal(num.state, '16');
  });

  it('cover: commands and position, state derived from position', () => {
    const e = entity('cover', { cmd_t: 'c', pos_t: 'p', set_pos_t: 'sp', pl_stop: null });
    assert.deepEqual(e.services, ['open_cover', 'close_cover', 'set_cover_position']);
    assert.deepEqual(payloads(e.command('open_cover', {})), ['c=OPEN']);
    assert.deepEqual(payloads(e.command('set_cover_position', { position: 40 })), ['sp=40']);
    e.handle('p', '0');
    assert.equal(e.state, 'closed');
    e.handle('p', '75');
    assert.equal(e.state, 'open');
    assert.equal(e.attributes.current_position, 75);
  });

  it('lock maps device payloads to locked/unlocked', () => {
    const e = entity('lock', { cmd_t: 'c', stat_t: 's' });
    e.handle('s', 'LOCKED');
    assert.equal(e.state, 'locked');
    assert.deepEqual(payloads(e.command('unlock', {})), ['c=UNLOCK']);
  });

  it('climate: modes, temperature limits, turn_on restores the last mode', () => {
    const e = entity('climate', {
      mode_cmd_t: 'm/set', mode_stat_t: 'm', temp_cmd_t: 't/set', temp_stat_t: 't', curr_temp_t: 'ct',
      modes: ['off', 'cool', 'heat'], min_temp: 16, max_temp: 30,
    });
    e.handle('m', 'cool');
    e.handle('ct', '27.5');
    e.handle('t', '24');
    assert.equal(e.state, 'cool');
    assert.equal(e.attributes.current_temperature, 27.5);
    assert.equal(e.attributes.temperature, 24);
    assert.deepEqual(payloads(e.command('turn_off', {})), ['m/set=off']);
    e.handle('m', 'off');
    assert.deepEqual(payloads(e.command('turn_on', {})), ['m/set=cool'], 'back to the last active mode');
    assert.equal(e.command('set_temperature', { temperature: 40 }).ok, false);
    assert.deepEqual(payloads(e.command('set_temperature', { temperature: 22, hvac_mode: 'heat' })), ['m/set=heat', 't/set=22']);
    assert.equal(e.command('set_hvac_mode', { hvac_mode: 'auto' }).ok, false);
    assert.equal(e.command('press', {}).ok, false);
  });

  it('button presses and records the time', () => {
    const e = entity('button', { cmd_t: 'b' });
    assert.deepEqual(payloads(e.command('press', {})), ['b=PRESS']);
    assert.match(e.state, /^\d{4}-\d\d-\d\dT/);
  });
});
