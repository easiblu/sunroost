/**
 * Home Assistant MQTT discovery payloads. Each entity is announced at
 * homeassistant/<component>/<uniq>_<device>_<metric>/config (retained).
 * Live readings are sensors; inverter settings become select/number/switch/text
 * entities with a command topic when setting changes are allowed.
 */
import { meta } from '../core/metrics.ts';
import type { SettingDef } from '../devices/types.ts';
import { availabilityTopic, commandTopic, responseTopic, stateTopic } from './topics.ts';

export const DISCOVERY_PREFIX = 'homeassistant';

export interface DeviceInfo {
  /** Topic segment: inverter_1, battery_1, total, grid. */
  segment: string;
  name: string;
  manufacturer?: string;
  model?: string;
  serial?: string;
  firmware?: string;
}

export interface DiscoveryContext {
  prefix: string;
  uniq: string;
  allowUpdate: boolean;
}

export interface DiscoveryMessage {
  component: string;
  objectId: string;
  topic: string;
  payload: Record<string, unknown>;
}

const TIME_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
const BOOL = '(true|false)';

const objectIdFor = (uniq: string, segment: string, metric: string) => `${uniq}_${segment}_${metric}`;
export const discoveryTopic = (component: string, objectId: string) => `${DISCOVERY_PREFIX}/${component}/${objectId}/config`;

function deviceBlock(ctx: DiscoveryContext, dev: DeviceInfo) {
  const out: Record<string, unknown> = {
    identifiers: [`${ctx.uniq}_${dev.segment}`],
    name: dev.name,
    manufacturer: dev.manufacturer || 'Unknown',
  };
  if (dev.model) out.model = dev.model;
  if (dev.serial) out.serial_number = dev.serial;
  if (dev.firmware) out.sw_version = dev.firmware;
  // Inverters, packs and the grid hang off the "Total" system device.
  if (dev.segment !== 'total') out.via_device = `${ctx.uniq}_total`;
  return out;
}

function base(ctx: DiscoveryContext, dev: DeviceInfo, metric: string, label: string, component: string): DiscoveryMessage {
  const objectId = objectIdFor(ctx.uniq, dev.segment, metric);
  return {
    component,
    objectId,
    topic: discoveryTopic(component, objectId),
    payload: {
      name: label,
      unique_id: objectId,
      object_id: objectId,
      state_topic: stateTopic(ctx.prefix, dev.segment, metric),
      availability_topic: availabilityTopic(ctx.prefix),
      device: deviceBlock(ctx, dev),
    },
  };
}

/** Sensor for a live reading. `name` is the metric name ("PV power"); `numeric` is false for strings. */
export function sensorConfig(ctx: DiscoveryContext, dev: DeviceInfo, metric: string, name: string, numeric: boolean): DiscoveryMessage {
  const msg = base(ctx, dev, metric, name, 'sensor');
  const m = meta(name);
  const p = msg.payload;
  if (m.unit) p.unit_of_measurement = m.unit;
  if (m.deviceClass) p.device_class = m.deviceClass;
  if (numeric && !m.info) p.state_class = m.deviceClass === 'energy' ? 'total_increasing' : 'measurement';
  if (m.info) p.entity_category = 'diagnostic';
  return msg;
}

/** Entity for an inverter setting. Writable components only when updates are allowed. */
export function settingConfig(ctx: DiscoveryContext, dev: DeviceInfo, def: SettingDef): DiscoveryMessage {
  const writable = ctx.allowUpdate && !def.readOnly;
  const component = !writable
    ? 'sensor'
    : def.type === 'select'
      ? 'select'
      : def.type === 'number'
        ? 'number'
        : def.type === 'checkbox'
          ? 'switch'
          : 'text';
  const msg = base(ctx, dev, def.key, def.label, component);
  const p = msg.payload;
  p.entity_category = 'config';
  if (def.type === 'number' && def.unit) p.unit_of_measurement = def.unit;
  if (!writable) return msg;
  p.command_topic = commandTopic(ctx.prefix, dev.segment, def.key);
  switch (def.type) {
    case 'select':
      p.options = def.options ?? [];
      break;
    case 'number':
      if (def.min !== undefined) p.min = def.min;
      if (def.max !== undefined) p.max = def.max;
      p.step = def.step ?? 1;
      p.mode = 'box';
      break;
    case 'checkbox':
      p.payload_on = 'true';
      p.payload_off = 'false';
      p.state_on = 'true';
      p.state_off = 'false';
      break;
    case 'time':
      p.pattern = TIME_PATTERN;
      break;
    case 'slot': {
      const t = '([01]\\d|2[0-3]):[0-5]\\d';
      const prio = def.slotPriorities?.length ? `,(${def.slotPriorities.map(escapeRe).join('|')})` : '';
      p.pattern = `^${t},${t}${prio},${BOOL}$`;
      break;
    }
  }
  return msg;
}

/** The sensor showing the result of the last command. */
export function responseConfig(ctx: DiscoveryContext, total: DeviceInfo): DiscoveryMessage {
  const objectId = `${ctx.uniq}_set_response_message`;
  return {
    component: 'sensor',
    objectId,
    topic: discoveryTopic('sensor', objectId),
    payload: {
      name: 'Set response message',
      unique_id: objectId,
      object_id: objectId,
      state_topic: responseTopic(ctx.prefix),
      availability_topic: availabilityTopic(ctx.prefix),
      entity_category: 'diagnostic',
      icon: 'mdi:message-reply-text',
      device: deviceBlock(ctx, total),
    },
  };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
