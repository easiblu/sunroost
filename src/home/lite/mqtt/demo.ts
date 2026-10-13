/**
 * Simulated smart devices for trying the feature (and testing it) without hardware. Each one talks
 * MQTT the way its real counterpart does, so the discovery driver is exercised end to end:
 *
 * - Demo plug: Tasmota legacy discovery (abbreviated keys, "~" base topic, LWT availability, JSON
 *   telemetry read through value templates). A 2 kW water heater: draws power while on.
 * - Demo bulb: Zigbee2MQTT (JSON schema light with brightness, bridge availability via template).
 * - Demo air conditioner: ESPHome climate with plain topics, room temperature drifting toward the
 *   target while cooling. Announced with device-based discovery ("cmps").
 * - Demo EV charger: ESPHome switch plus a charging current number, 7.4 kW at 32 A.
 *
 * Enabled with the `home.demo_devices` setting; only runs alongside the lite engine.
 */
import { connect, type MqttClient } from 'mqtt';
import { logger } from '../../../core/log.ts';
import { setSimulatedDeviceLoad } from '../../../devices/inverters/sim-load.ts';
import { brokerTarget } from './broker.ts';

const log = logger('home');
const TICK_MS = 5000;

interface Sim {
  plug: boolean;
  bulb: { on: boolean; brightness: number };
  ac: { mode: string; target: number; current: number; fan: string };
  charger: { on: boolean; amps: number };
}

const DISCOVERY: [string, Record<string, unknown>][] = [
  // Tasmota (SetOption19 legacy format)
  ['homeassistant/switch/DEMO01_RL_1/config', {
    name: 'Demo plug', '~': 'demo_plug/', cmd_t: '~cmnd/POWER', stat_t: '~tele/STATE', val_tpl: '{{value_json.POWER}}',
    pl_off: 'OFF', pl_on: 'ON', avty_t: '~tele/LWT', pl_avail: 'Online', pl_not_avail: 'Offline', uniq_id: 'DEMO01_RL_1',
    dev: { ids: ['DEMO01'], name: 'Demo plug', mdl: 'Sonoff S31', sw: '14.3.0(tasmota)', mf: 'Tasmota' },
  }],
  ['homeassistant/sensor/DEMO01_ENERGY_Power/config', {
    name: 'Demo plug power', '~': 'demo_plug/', stat_t: '~tele/SENSOR', val_tpl: "{{value_json['ENERGY']['Power']}}",
    unit_of_meas: 'W', dev_cla: 'power', avty_t: '~tele/LWT', pl_avail: 'Online', pl_not_avail: 'Offline', uniq_id: 'DEMO01_ENERGY_Power',
    dev: { ids: ['DEMO01'] },
  }],
  // Zigbee2MQTT
  ['homeassistant/light/0xdemo00000000b01b/light/config', {
    name: null, schema: 'json', brightness: true, brightness_scale: 254, command_topic: 'zigbee2mqtt/Demo bulb/set',
    state_topic: 'zigbee2mqtt/Demo bulb', unique_id: '0xdemo00000000b01b_light_zigbee2mqtt', object_id: 'demo_bulb',
    availability: [{ topic: 'zigbee2mqtt/bridge/state', value_template: '{{ value_json.state }}' }],
    device: { identifiers: ['zigbee2mqtt_0xdemo00000000b01b'], name: 'Demo bulb', manufacturer: 'IKEA', model: 'TRADFRI bulb E27 806 lm' },
  }],
  // ESPHome, device-based discovery
  ['homeassistant/device/demo-ac/config', {
    dev: { ids: 'demo-ac-24dcc3a1b2c3', name: 'Demo air conditioner', mf: 'espressif', mdl: 'esp32dev', sw: '2025.9.0 (ESPHome)' },
    o: { name: 'ESPHome' },
    avty_t: 'demo-ac/status',
    cmps: {
      climate: {
        p: 'climate', name: null, uniq_id: 'demo-ac-climate', modes: ['off', 'cool', 'heat', 'fan_only', 'dry'], fan_modes: ['auto', 'low', 'medium', 'high'],
        mode_stat_t: 'demo-ac/climate/ac/mode/state', mode_cmd_t: 'demo-ac/climate/ac/mode/command',
        temp_stat_t: 'demo-ac/climate/ac/target_temperature/state', temp_cmd_t: 'demo-ac/climate/ac/target_temperature/command',
        curr_temp_t: 'demo-ac/climate/ac/current_temperature/state', fan_mode_stat_t: 'demo-ac/climate/ac/fan_mode/state',
        fan_mode_cmd_t: 'demo-ac/climate/ac/fan_mode/command', min_temp: 16, max_temp: 30, temp_step: 0.5,
      },
      power: { p: 'sensor', name: 'Power', uniq_id: 'demo-ac-power', stat_t: 'demo-ac/sensor/power/state', unit_of_meas: 'W', dev_cla: 'power' },
    },
  }],
  // ESPHome, per-entity discovery
  ['homeassistant/switch/demo-charger/charging/config', {
    name: 'Charging', uniq_id: 'demo-charger-charging', stat_t: 'demo-charger/switch/charging/state', cmd_t: 'demo-charger/switch/charging/command',
    avty_t: 'demo-charger/status', dev: { ids: 'demo-charger-a1b2c3', name: 'Demo EV charger', mf: 'espressif', mdl: 'esp32dev' },
  }],
  ['homeassistant/number/demo-charger/current/config', {
    name: 'Charging current', uniq_id: 'demo-charger-current', stat_t: 'demo-charger/number/current/state', cmd_t: 'demo-charger/number/current/command',
    min: 6, max: 32, step: 1, unit_of_meas: 'A', avty_t: 'demo-charger/status', dev: { ids: 'demo-charger-a1b2c3' },
  }],
  ['homeassistant/sensor/demo-charger/power/config', {
    name: 'Power', uniq_id: 'demo-charger-power', stat_t: 'demo-charger/sensor/power/state', unit_of_meas: 'W', dev_cla: 'power',
    avty_t: 'demo-charger/status', dev: { ids: 'demo-charger-a1b2c3' },
  }],
];

export class DemoDevices {
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private sim: Sim = {
    plug: false,
    bulb: { on: false, brightness: 254 },
    ac: { mode: 'off', target: 24, current: 29, fan: 'auto' },
    charger: { on: false, amps: 16 },
  };
  /** Milliseconds a device takes to act on a command (real ones take 20–300 ms). */
  latencyMs = 80;

  start() {
    this.retry = null;
    const t = brokerTarget();
    if (!t.ok) {
      // The broker may still be starting; MQTT switched off stays off until the settings change.
      if (t.reason === 'error') this.retry = setTimeout(() => this.start(), 5000);
      return;
    }
    const will = (topic: string, payload: string) => ({ topic, payload: Buffer.from(payload), qos: 0 as const, retain: true });
    const client = connect(t.url, {
      clientId: 'solar_demo_devices',
      username: t.username,
      password: t.password,
      reconnectPeriod: 5000,
      will: will('demo_plug/tele/LWT', 'Offline'),
    });
    this.client = client;
    client.on('connect', () => {
      client.subscribe(['demo_plug/cmnd/#', 'zigbee2mqtt/Demo bulb/set', 'demo-ac/climate/ac/+/command', 'demo-charger/+/+/command', 'homeassistant/status']);
      this.announce();
      log.info('Demo devices online.');
    });
    client.on('message', (topic, payload) => setTimeout(() => this.onCommand(topic, payload.toString()), this.latencyMs));
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** `remove` withdraws the devices (the demo was switched off); otherwise they just go offline. */
  async stop(remove = false) {
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    if (!c?.connected) {
      c?.end(true);
      return;
    }
    setSimulatedDeviceLoad(0);
    if (remove) for (const [topic] of DISCOVERY) c.publish(topic, '', { retain: true });
    for (const t of ['demo_plug/tele/LWT', 'demo-ac/status', 'demo-charger/status']) c.publish(t, t.includes('LWT') ? 'Offline' : 'offline', { retain: true });
    c.publish('zigbee2mqtt/bridge/state', JSON.stringify({ state: 'offline' }), { retain: true });
    await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
  }

  private pub(topic: string, payload: string, retain = true) {
    this.client?.publish(topic, payload, { retain });
  }

  private announce() {
    for (const [topic, cfg] of DISCOVERY) this.pub(topic, JSON.stringify(cfg));
    this.pub('demo_plug/tele/LWT', 'Online');
    this.pub('demo-ac/status', 'online');
    this.pub('demo-charger/status', 'online');
    this.pub('zigbee2mqtt/bridge/state', JSON.stringify({ state: 'online' }));
    this.publishAll();
  }

  private publishAll() {
    const { plug, bulb, ac, charger } = this.sim;
    // The simulated inverter sees these devices as part of the house load.
    const acW = ac.mode === 'off' ? 0 : ac.mode === 'fan_only' ? 45 : 1150;
    setSimulatedDeviceLoad((plug ? 2000 : 0) + (bulb.on ? 9 : 0) + acW + (charger.on ? charger.amps * 230 : 0));
    this.pub('demo_plug/tele/STATE', JSON.stringify({ Time: new Date().toISOString().slice(0, 19), POWER: plug ? 'ON' : 'OFF' }));
    this.pub('demo_plug/tele/SENSOR', JSON.stringify({ ENERGY: { Power: plug ? 1980 + Math.round(Math.random() * 40) : 0, Voltage: 231 } }));
    this.pub('zigbee2mqtt/Demo bulb', JSON.stringify({ state: bulb.on ? 'ON' : 'OFF', brightness: bulb.brightness, linkquality: 120 }));
    this.pub('demo-ac/climate/ac/mode/state', ac.mode);
    this.pub('demo-ac/climate/ac/target_temperature/state', ac.target.toFixed(1));
    this.pub('demo-ac/climate/ac/current_temperature/state', ac.current.toFixed(1));
    this.pub('demo-ac/climate/ac/fan_mode/state', ac.fan);
    this.pub('demo-ac/sensor/power/state', String(ac.mode === 'off' ? 0 : ac.mode === 'fan_only' ? 45 : 1150));
    this.pub('demo-charger/switch/charging/state', charger.on ? 'ON' : 'OFF');
    this.pub('demo-charger/number/current/state', String(charger.amps));
    this.pub('demo-charger/sensor/power/state', String(charger.on ? Math.round(charger.amps * 230) : 0));
  }

  private onCommand(topic: string, payload: string) {
    const { sim } = this;
    if (topic === 'homeassistant/status') {
      if (payload === 'online') this.announce();
      return;
    }
    if (topic === 'demo_plug/cmnd/POWER') {
      sim.plug = payload === 'TOGGLE' ? !sim.plug : payload === 'ON';
      this.pub('demo_plug/stat/POWER', sim.plug ? 'ON' : 'OFF', false);
    } else if (topic === 'zigbee2mqtt/Demo bulb/set') {
      try {
        const j = JSON.parse(payload) as { state?: string; brightness?: number };
        if (j.state === 'ON' || j.state === 'OFF') sim.bulb.on = j.state === 'ON';
        if (typeof j.brightness === 'number') sim.bulb.brightness = Math.max(1, Math.min(254, j.brightness));
      } catch {}
    } else if (topic.startsWith('demo-ac/climate/ac/')) {
      const field = topic.split('/')[3];
      if (field === 'mode' && ['off', 'cool', 'heat', 'fan_only', 'dry'].includes(payload)) sim.ac.mode = payload;
      if (field === 'target_temperature' && Number.isFinite(Number(payload))) sim.ac.target = Math.max(16, Math.min(30, Number(payload)));
      if (field === 'fan_mode') sim.ac.fan = payload;
    } else if (topic === 'demo-charger/switch/charging/command') {
      sim.charger.on = payload === 'ON';
    } else if (topic === 'demo-charger/number/current/command' && Number.isFinite(Number(payload))) {
      sim.charger.amps = Math.max(6, Math.min(32, Math.round(Number(payload))));
    } else return;
    this.publishAll();
  }

  private tick() {
    const ac = this.sim.ac;
    const toward = ac.mode === 'cool' ? Math.min(ac.target, ac.current) : ac.mode === 'heat' ? Math.max(ac.target, ac.current) : 29;
    ac.current = Math.round((ac.current + (toward - ac.current) * 0.1) * 10) / 10;
    this.publishAll();
  }
}
