/**
 * Runtime behaviour of one MQTT-discovered entity, following Home Assistant's MQTT platforms:
 * which topics it listens to, how a message changes its state, and which messages a command sends.
 * Defaults (ON/OFF payloads, brightness scale 255, cover OPEN/CLOSE/STOP …) are Home Assistant's.
 * No I/O here: the driver feeds messages in and publishes what `command()` returns.
 */
import { UNKNOWN } from '../../types.ts';
import type { Component, Config, DiscoveredEntity } from './discovery.ts';
import { compile, payloadVars, pyStr, type Template } from './template.ts';

export interface Publish {
  topic: string;
  payload: string;
  retain: boolean;
  qos: 0 | 1 | 2;
}

export type CommandResult = { ok: true; publish: Publish[] } | { ok: false; message: string };

const DOMAIN: Record<Component, string> = {
  sensor: 'sensor', binary_sensor: 'binary_sensor', switch: 'switch', light: 'light', fan: 'fan', button: 'button',
  select: 'select', number: 'number', cover: 'cover', lock: 'lock', climate: 'climate',
};
const DEFAULT_HVAC_MODES = ['auto', 'off', 'cool', 'heat', 'dry', 'fan_only'];

interface AvailabilitySource {
  topic: string;
  available: string;
  notAvailable: string;
  template: Template | null;
}

const s = (v: unknown, dflt: string) => (v === undefined ? dflt : pyStr(v));
const n = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt);
const topicOf = (cfg: Config, key: string) => (typeof cfg[key] === 'string' && cfg[key] ? (cfg[key] as string) : null);

export class MqttEntity {
  readonly d: DiscoveredEntity;
  readonly cfg: Config;
  readonly domain: string;
  readonly qos: 0 | 1 | 2;
  readonly retain: boolean;
  /** No state topic (or `optimistic: true`): the state follows our own commands. */
  readonly optimistic: boolean;
  state: string = UNKNOWN;
  attributes: Record<string, unknown> = {};
  private templates = new Map<string, Template | null>();
  private availability: AvailabilitySource[] = [];
  private availMode: 'all' | 'any' | 'latest';
  private availState = new Map<string, boolean>();
  private latestAvail: boolean | null = null;
  /** Climate: the last mode other than off, for turn_on without a power topic. */
  private lastActiveMode: string | null = null;

  constructor(d: DiscoveredEntity) {
    this.d = d;
    this.cfg = d.config;
    this.domain = DOMAIN[d.component];
    const q = n(this.cfg.qos, 0);
    this.qos = q === 1 || q === 2 ? q : 0;
    this.retain = this.cfg.retain === true;
    const stateTopic = this.d.component === 'climate' ? topicOf(this.cfg, 'mode_state_topic') : topicOf(this.cfg, 'state_topic');
    const stateless = this.d.component === 'button' || this.d.component === 'sensor' || this.d.component === 'binary_sensor';
    this.optimistic = !stateless && (this.cfg.optimistic === true || (!stateTopic && !topicOf(this.cfg, 'position_topic')));
    if (this.optimistic && this.d.component !== 'button') this.state = this.d.component === 'climate' ? 'off' : UNKNOWN;

    const avail = this.cfg.availability;
    if (Array.isArray(avail)) {
      for (const a of avail) {
        if (a && typeof a === 'object' && typeof (a as Config).topic === 'string') {
          const c = a as Config;
          this.availability.push({
            topic: c.topic as string,
            available: s(c.payload_available, 'online'),
            notAvailable: s(c.payload_not_available, 'offline'),
            template: typeof c.value_template === 'string' ? compile(c.value_template) : null,
          });
        }
      }
    } else if (topicOf(this.cfg, 'availability_topic')) {
      this.availability.push({
        topic: this.cfg.availability_topic as string,
        available: s(this.cfg.payload_available, 'online'),
        notAvailable: s(this.cfg.payload_not_available, 'offline'),
        template: typeof this.cfg.availability_template === 'string' ? compile(this.cfg.availability_template) : null,
      });
    }
    const mode = this.cfg.availability_mode;
    this.availMode = mode === 'all' || mode === 'any' ? mode : 'latest';
    this.initAttributes();
  }

  private initAttributes() {
    const c = this.cfg;
    if (this.d.component === 'select') this.attributes.options = Array.isArray(c.options) ? c.options.map(pyStr) : [];
    if (this.d.component === 'number') {
      Object.assign(this.attributes, { min: n(c.min, 1), max: n(c.max, 100), step: n(c.step, 1), mode: s(c.mode, 'auto') });
    }
    if (this.d.component === 'climate') {
      Object.assign(this.attributes, {
        hvac_modes: Array.isArray(c.modes) ? c.modes.map(pyStr) : DEFAULT_HVAC_MODES,
        min_temp: n(c.min_temp, 7),
        max_temp: n(c.max_temp, 35),
        target_temp_step: n(c.temp_step, 1),
        ...(Array.isArray(c.fan_modes) ? { fan_modes: c.fan_modes.map(pyStr) } : {}),
      });
    }
    if (this.d.component === 'light' && (this.lightJson || topicOf(c, 'brightness_command_topic'))) this.attributes.supports_brightness = true;
  }

  private get lightJson() {
    return this.d.component === 'light' && this.cfg.schema === 'json';
  }

  /** A compiled template, or null when the config has none. Throws TemplateError for unsupported syntax. */
  template(key: string): Template | null {
    if (!this.templates.has(key)) {
      const src = this.cfg[key];
      this.templates.set(key, typeof src === 'string' && src.trim() ? compile(src) : null);
    }
    return this.templates.get(key)!;
  }

  /** Renders `key`'s template on a payload, or returns the payload itself when there is none. */
  private value(key: string, payload: string): string {
    const t = this.template(key);
    return t ? t.render(payloadVars(payload)) : payload;
  }

  /** Throws TemplateError early, so a bad config is reported when it's discovered, not on the first message. */
  validateTemplates() {
    for (const k of Object.keys(this.cfg)) if (k.endsWith('_template')) this.template(k);
  }

  /** Every topic this entity needs messages from. */
  subscriptions(): string[] {
    const keys = [
      'state_topic', 'json_attributes_topic', 'brightness_state_topic', 'percentage_state_topic', 'position_topic',
      'mode_state_topic', 'temperature_state_topic', 'current_temperature_topic', 'fan_mode_state_topic', 'action_topic',
    ];
    const topics = keys.map((k) => topicOf(this.cfg, k)).filter((t): t is string => !!t);
    return [...new Set([...topics, ...this.availability.map((a) => a.topic)])];
  }

  get services(): string[] {
    const c = this.cfg;
    switch (this.d.component) {
      case 'switch': return ['turn_on', 'turn_off', 'toggle'];
      case 'light': return ['turn_on', 'turn_off', 'toggle'];
      case 'fan': return topicOf(c, 'percentage_command_topic') ? ['turn_on', 'turn_off', 'toggle', 'set_percentage'] : ['turn_on', 'turn_off', 'toggle'];
      case 'button': return ['press'];
      case 'select': return ['select_option'];
      case 'number': return ['set_value'];
      case 'lock': return ['lock', 'unlock'];
      case 'cover': {
        const out: string[] = [];
        if (topicOf(c, 'command_topic')) {
          if (c.payload_open !== null) out.push('open_cover');
          if (c.payload_close !== null) out.push('close_cover');
          if (c.payload_stop !== null) out.push('stop_cover');
        }
        if (topicOf(c, 'set_position_topic')) out.push('set_cover_position');
        return out;
      }
      case 'climate': {
        const out: string[] = [];
        if (topicOf(c, 'mode_command_topic')) out.push('set_hvac_mode', 'turn_off', 'turn_on');
        else if (topicOf(c, 'power_command_topic')) out.push('turn_off', 'turn_on');
        if (topicOf(c, 'temperature_command_topic')) out.push('set_temperature');
        if (topicOf(c, 'fan_mode_command_topic')) out.push('set_fan_mode');
        return [...new Set(out)];
      }
      default: return [];
    }
  }

  /** Whether the entity is available, from its availability topics (always true without any). */
  get available(): boolean {
    if (!this.availability.length) return true;
    if (this.availMode === 'latest') return this.latestAvail === true;
    const values = this.availability.map((a) => this.availState.get(a.topic));
    return this.availMode === 'all' ? values.every((v) => v === true) : values.some((v) => v === true);
  }

  /** Feeds one message in; returns true when the visible state, attributes or availability changed. */
  handle(topic: string, payload: string): boolean {
    const before = JSON.stringify([this.state, this.attributes, this.available]);
    for (const a of this.availability) {
      if (a.topic !== topic) continue;
      const v = a.template ? a.template.render(payloadVars(payload)) : payload;
      if (v === a.available) this.setAvail(a.topic, true);
      else if (v === a.notAvailable) this.setAvail(a.topic, false);
    }
    const c = this.cfg;
    if (topic === topicOf(c, 'json_attributes_topic')) {
      try {
        const obj = JSON.parse(this.value('json_attributes_template', payload));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) this.attributes = { ...this.attributes, ...obj };
      } catch {}
    }
    this.handleState(topic, payload);
    return before !== JSON.stringify([this.state, this.attributes, this.available]);
  }

  private setAvail(topic: string, v: boolean) {
    this.availState.set(topic, v);
    this.latestAvail = v;
  }

  private handleState(topic: string, payload: string) {
    const c = this.cfg;
    const stateTopic = topicOf(c, 'state_topic');
    switch (this.d.component) {
      case 'sensor': {
        if (topic !== stateTopic) return;
        const v = this.value('value_template', payload);
        if (v !== '') this.state = v === 'None' ? UNKNOWN : v;
        return;
      }
      case 'binary_sensor': {
        if (topic !== stateTopic) return;
        const v = this.value('value_template', payload);
        if (v === s(c.payload_on, 'ON')) this.state = 'on';
        else if (v === s(c.payload_off, 'OFF')) this.state = 'off';
        else if (v === 'None') this.state = UNKNOWN;
        return;
      }
      case 'switch':
      case 'fan': {
        if (topic === stateTopic) this.onOff(this.value(this.d.component === 'fan' ? 'state_value_template' : 'value_template', payload));
        if (this.d.component === 'fan' && topic === topicOf(c, 'percentage_state_topic')) {
          const raw = Number(this.value('percentage_value_template', payload));
          if (Number.isFinite(raw)) this.attributes.percentage = this.fromRange(raw);
        }
        return;
      }
      case 'light': {
        if (topic !== stateTopic && topic !== topicOf(c, 'brightness_state_topic')) return;
        const scale = n(c.brightness_scale, 255);
        if (this.lightJson) {
          let j: Config;
          try {
            j = JSON.parse(payload);
          } catch {
            return;
          }
          if (j.state === 'ON' || j.state === 'OFF') this.state = j.state === 'ON' ? 'on' : 'off';
          if (typeof j.brightness === 'number') this.attributes.brightness = Math.round((j.brightness / scale) * 255);
          if (typeof j.color_temp === 'number') this.attributes.color_temp = j.color_temp;
          return;
        }
        if (topic === stateTopic) this.onOff(this.value('state_value_template', payload));
        if (topic === topicOf(c, 'brightness_state_topic')) {
          const b = Number(this.value('brightness_value_template', payload));
          if (Number.isFinite(b)) this.attributes.brightness = Math.round((b / scale) * 255);
        }
        return;
      }
      case 'select': {
        if (topic !== stateTopic) return;
        const v = this.value('value_template', payload);
        if ((this.attributes.options as string[]).includes(v)) this.state = v;
        return;
      }
      case 'number': {
        if (topic !== stateTopic) return;
        const v = this.value('value_template', payload);
        if (v === 'None') this.state = UNKNOWN;
        else if (v !== '' && Number.isFinite(Number(v))) this.state = String(Number(v));
        return;
      }
      case 'lock': {
        if (topic !== stateTopic) return;
        const v = this.value('value_template', payload);
        const map: [string, string][] = [
          [s(c.state_locked, 'LOCKED'), 'locked'], [s(c.state_unlocked, 'UNLOCKED'), 'unlocked'], [s(c.state_locking, 'LOCKING'), 'locking'],
          [s(c.state_unlocking, 'UNLOCKING'), 'unlocking'], [s(c.state_jammed, 'JAMMED'), 'jammed'],
        ];
        const hit = map.find(([p]) => p === v);
        if (hit) this.state = hit[1];
        return;
      }
      case 'cover': {
        const open = n(c.position_open, 100);
        const closed = n(c.position_closed, 0);
        if (topic === topicOf(c, 'position_topic')) {
          const raw = Number(this.value('position_template', payload));
          if (Number.isFinite(raw) && open !== closed) {
            const pct = Math.max(0, Math.min(100, Math.round(((raw - closed) / (open - closed)) * 100)));
            this.attributes.current_position = pct;
            if (!stateTopic) this.state = pct === 0 ? 'closed' : 'open';
          }
        }
        if (topic === stateTopic) {
          const v = this.value('value_template', payload);
          const map: [string, string][] = [
            [s(c.state_open, 'open'), 'open'], [s(c.state_closed, 'closed'), 'closed'], [s(c.state_opening, 'opening'), 'opening'],
            [s(c.state_closing, 'closing'), 'closing'],
          ];
          const hit = map.find(([p]) => p === v);
          if (hit) this.state = hit[1];
          else if (v === s(c.state_stopped, 'stopped')) this.state = this.attributes.current_position === 0 ? 'closed' : 'open';
        }
        return;
      }
      case 'climate': {
        if (topic === topicOf(c, 'mode_state_topic')) {
          const v = this.value('mode_state_template', payload);
          if ((this.attributes.hvac_modes as string[]).includes(v)) this.setMode(v);
        }
        const numAttr = (key: string, tplKey: string, attr: string) => {
          if (topic !== topicOf(c, key)) return;
          const v = Number(this.value(tplKey, payload));
          if (Number.isFinite(v)) this.attributes[attr] = v;
        };
        numAttr('temperature_state_topic', 'temperature_state_template', 'temperature');
        numAttr('current_temperature_topic', 'current_temperature_template', 'current_temperature');
        if (topic === topicOf(c, 'fan_mode_state_topic')) this.attributes.fan_mode = this.value('fan_mode_state_template', payload);
        if (topic === topicOf(c, 'action_topic')) this.attributes.hvac_action = this.value('action_template', payload);
        return;
      }
    }
  }

  private onOff(v: string) {
    const on = s(this.cfg.state_on, s(this.cfg.payload_on, 'ON'));
    const off = s(this.cfg.state_off, s(this.cfg.payload_off, 'OFF'));
    if (v === on) this.state = 'on';
    else if (v === off) this.state = 'off';
    else if (v === 'None') this.state = UNKNOWN;
  }

  private setMode(mode: string) {
    this.state = mode;
    if (mode !== 'off') this.lastActiveMode = mode;
  }

  /** Fan percentage from the device's speed range (1..100 by default). */
  private fromRange(raw: number) {
    const min = n(this.cfg.speed_range_min, 1);
    const max = n(this.cfg.speed_range_max, 100);
    if (raw <= 0) return 0;
    return Math.round(((raw - min + 1) / (max - min + 1)) * 100);
  }
  private toRange(pct: number) {
    const min = n(this.cfg.speed_range_min, 1);
    const max = n(this.cfg.speed_range_max, 100);
    if (pct <= 0) return 0;
    return Math.ceil((pct / 100) * (max - min + 1)) + min - 1;
  }

  private pub(topicKey: string, value: unknown, templateKey?: string): Publish | null {
    const topic = topicOf(this.cfg, topicKey);
    if (!topic) return null;
    const tpl = templateKey ? this.template(templateKey) : null;
    const payload = tpl ? tpl.render({ value }) : pyStr(value);
    return { topic, payload, retain: this.retain, qos: this.qos };
  }

  /**
   * Builds the messages for a service call and, for optimistic entities, applies the expected
   * state. Throws TemplateError if a command template can't be rendered.
   */
  command(service: string, data: Record<string, unknown>): CommandResult {
    if (!this.services.includes(service)) return { ok: false, message: `This ${this.domain} doesn't support ${service}` };
    const c = this.cfg;
    const out: (Publish | null)[] = [];
    let next: string | null = null;
    const fail = (message: string): CommandResult => ({ ok: false, message });
    const want = service === 'toggle' ? (this.state === 'on' ? 'turn_off' : 'turn_on') : service;

    switch (this.d.component) {
      case 'switch':
        out.push(this.pub('command_topic', want === 'turn_on' ? s(c.payload_on, 'ON') : s(c.payload_off, 'OFF'), 'command_template'));
        next = want === 'turn_on' ? 'on' : 'off';
        break;
      case 'fan': {
        if (service === 'set_percentage') {
          const pct = n(data.percentage, NaN);
          if (!(pct >= 0 && pct <= 100)) return fail('percentage must be 0–100');
          out.push(this.pub('percentage_command_topic', this.toRange(pct), 'percentage_command_template'));
          if (this.optimistic) this.attributes.percentage = pct;
          break;
        }
        out.push(this.pub('command_topic', want === 'turn_on' ? s(c.payload_on, 'ON') : s(c.payload_off, 'OFF'), 'command_template'));
        if (want === 'turn_on' && data.percentage !== undefined) {
          out.push(this.pub('percentage_command_topic', this.toRange(n(data.percentage, 100)), 'percentage_command_template'));
        }
        next = want === 'turn_on' ? 'on' : 'off';
        break;
      }
      case 'light': {
        const scale = n(c.brightness_scale, 255);
        const bri = data.brightness === undefined ? null : n(data.brightness, NaN);
        if (bri !== null && !(bri >= 0 && bri <= 255)) return fail('brightness must be 0–255');
        if (this.lightJson) {
          const body: Record<string, unknown> = { state: want === 'turn_on' ? 'ON' : 'OFF' };
          if (want === 'turn_on' && bri !== null) body.brightness = Math.round((bri / 255) * scale);
          out.push(this.pub('command_topic', JSON.stringify(body)));
        } else if (want === 'turn_off') {
          out.push(this.pub('command_topic', s(c.payload_off, 'OFF')));
        } else {
          // on_command_type: "last" (default) sends brightness then ON, "first" ON then brightness, "brightness" only brightness.
          const on = this.pub('command_topic', s(c.payload_on, 'ON'));
          const level = bri === null ? null : this.pub('brightness_command_topic', Math.round((bri / 255) * scale), 'brightness_command_template');
          const onType = s(c.on_command_type, 'last');
          if (!level) out.push(on);
          else if (onType === 'first') out.push(on, level);
          else if (onType === 'brightness') out.push(level);
          else out.push(level, on);
        }
        if (this.optimistic && bri !== null) this.attributes.brightness = bri;
        next = want === 'turn_on' ? 'on' : 'off';
        break;
      }
      case 'button':
        out.push(this.pub('command_topic', s(c.payload_press, 'PRESS'), 'command_template'));
        next = new Date().toISOString();
        break;
      case 'select': {
        const option = pyStr(data.option);
        if (!(this.attributes.options as string[]).includes(option)) return fail(`"${option}" is not one of the options`);
        out.push(this.pub('command_topic', option, 'command_template'));
        next = option;
        break;
      }
      case 'number': {
        const v = n(data.value, NaN);
        const { min, max } = this.attributes as { min: number; max: number };
        if (!(v >= min && v <= max)) return fail(`value must be between ${min} and ${max}`);
        out.push(this.pub('command_topic', v, 'command_template'));
        next = String(v);
        break;
      }
      case 'lock':
        out.push(this.pub('command_topic', service === 'lock' ? s(c.payload_lock, 'LOCK') : s(c.payload_unlock, 'UNLOCK'), 'command_template'));
        next = service === 'lock' ? 'locked' : 'unlocked';
        break;
      case 'cover': {
        if (service === 'set_cover_position') {
          const pct = n(data.position, NaN);
          if (!(pct >= 0 && pct <= 100)) return fail('position must be 0–100');
          const open = n(c.position_open, 100);
          const closed = n(c.position_closed, 0);
          out.push(this.pub('set_position_topic', Math.round(closed + (pct / 100) * (open - closed)), 'set_position_template'));
          if (this.optimistic) this.attributes.current_position = pct;
          next = pct === 0 ? 'closed' : 'open';
          break;
        }
        const payload = service === 'open_cover' ? s(c.payload_open, 'OPEN') : service === 'close_cover' ? s(c.payload_close, 'CLOSE') : s(c.payload_stop, 'STOP');
        out.push(this.pub('command_topic', payload, 'command_template'));
        next = service === 'open_cover' ? 'open' : service === 'close_cover' ? 'closed' : null;
        break;
      }
      case 'climate': {
        const modes = this.attributes.hvac_modes as string[];
        if (service === 'set_temperature') {
          const t = n(data.temperature, NaN);
          const { min_temp: lo, max_temp: hi } = this.attributes as { min_temp: number; max_temp: number };
          if (!(t >= lo && t <= hi)) return fail(`temperature must be between ${lo} and ${hi}`);
          if (typeof data.hvac_mode === 'string') {
            if (!modes.includes(data.hvac_mode)) return fail(`"${data.hvac_mode}" is not one of the modes`);
            out.push(this.pub('mode_command_topic', data.hvac_mode, 'mode_command_template'));
            if (this.optimistic) this.setMode(data.hvac_mode);
          }
          out.push(this.pub('temperature_command_topic', t, 'temperature_command_template'));
          if (!topicOf(c, 'temperature_state_topic')) this.attributes.temperature = t;
          break;
        }
        if (service === 'set_fan_mode') {
          const fm = pyStr(data.fan_mode);
          const fanModes = this.attributes.fan_modes as string[] | undefined;
          if (fanModes && !fanModes.includes(fm)) return fail(`"${fm}" is not one of the fan modes`);
          out.push(this.pub('fan_mode_command_topic', fm, 'fan_mode_command_template'));
          if (!topicOf(c, 'fan_mode_state_topic')) this.attributes.fan_mode = fm;
          break;
        }
        let mode: string | null = null;
        if (service === 'set_hvac_mode') mode = pyStr(data.hvac_mode);
        else if (service === 'turn_off') mode = 'off';
        else mode = this.lastActiveMode ?? modes.find((m) => m !== 'off') ?? null;
        if (topicOf(c, 'power_command_topic') && (service === 'turn_on' || service === 'turn_off')) {
          out.push(this.pub('power_command_topic', service === 'turn_on' ? s(c.payload_on, 'ON') : s(c.payload_off, 'OFF'), 'power_command_template'));
          if (!topicOf(c, 'mode_command_topic')) break;
        }
        if (!mode || !modes.includes(mode)) return fail(`"${mode}" is not one of the modes`);
        out.push(this.pub('mode_command_topic', mode, 'mode_command_template'));
        next = mode;
        break;
      }
      default:
        return fail(`This ${this.domain} can't be controlled`);
    }
    const publish = out.filter((p): p is Publish => !!p);
    if (!publish.length) return fail(`This ${this.domain} has no command topic for ${service}`);
    if (this.optimistic && next !== null) {
      if (this.d.component === 'climate') this.setMode(next);
      else this.state = next;
    }
    if (this.d.component === 'button' && next) this.state = next;
    return { ok: true, publish };
  }
}
