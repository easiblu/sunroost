/**
 * Parses Home Assistant MQTT discovery messages:
 *
 *   <prefix>/<component>/[<node_id>/]<object_id>/config   one entity
 *   <prefix>/device/<object_id>/config                    a device with several components ("cmps")
 *
 * Payloads may use abbreviated keys ("stat_t" for "state_topic") and "~" as a base topic. An empty
 * payload removes what that topic announced. Pure functions; see docs/SMART_HOME.md.
 */

/** Components the lite engine can run. */
export const SUPPORTED_COMPONENTS = ['sensor', 'binary_sensor', 'switch', 'light', 'fan', 'button', 'select', 'number', 'cover', 'lock', 'climate'] as const;
export type Component = (typeof SUPPORTED_COMPONENTS)[number];

// Home Assistant's abbreviations (homeassistant/components/mqtt/abbreviations.py), the ones these components use.
const ABBREVIATIONS: Record<string, string> = {
  act_t: 'action_topic', act_tpl: 'action_template', atype: 'automation_type', avty: 'availability', avty_mode: 'availability_mode',
  avty_t: 'availability_topic', avty_tpl: 'availability_template', bri_cmd_t: 'brightness_command_topic',
  bri_cmd_tpl: 'brightness_command_template', bri_scl: 'brightness_scale', bri_stat_t: 'brightness_state_topic',
  bri_val_tpl: 'brightness_value_template', cmd_off_tpl: 'command_off_template', cmd_on_tpl: 'command_on_template',
  cmd_t: 'command_topic', cmd_tpl: 'command_template', cmps: 'components', curr_temp_t: 'current_temperature_topic',
  curr_temp_tpl: 'current_temperature_template', def_ent_id: 'default_entity_id', dev: 'device', dev_cla: 'device_class',
  e: 'encoding', en: 'enabled_by_default', ent_cat: 'entity_category', fan_mode_cmd_t: 'fan_mode_command_topic',
  fan_mode_cmd_tpl: 'fan_mode_command_template', fan_mode_stat_t: 'fan_mode_state_topic', fan_mode_stat_tpl: 'fan_mode_state_template',
  fan_modes: 'fan_modes', ic: 'icon', json_attr_t: 'json_attributes_topic', json_attr_tpl: 'json_attributes_template',
  max: 'max', max_temp: 'max_temp', min: 'min', min_temp: 'min_temp', mode: 'mode', mode_cmd_t: 'mode_command_topic',
  mode_cmd_tpl: 'mode_command_template', mode_stat_t: 'mode_state_topic', mode_stat_tpl: 'mode_state_template', modes: 'modes',
  name: 'name', o: 'origin', obj_id: 'object_id', on_cmd_type: 'on_command_type', opt: 'optimistic', ops: 'options', p: 'platform',
  pct_cmd_t: 'percentage_command_topic', pct_cmd_tpl: 'percentage_command_template', pct_stat_t: 'percentage_state_topic',
  pct_val_tpl: 'percentage_value_template', pl_avail: 'payload_available', pl_cls: 'payload_close', pl_lock: 'payload_lock',
  pl_not_avail: 'payload_not_available', pl_off: 'payload_off', pl_on: 'payload_on', pl_open: 'payload_open', pl_prs: 'payload_press',
  pl_stop: 'payload_stop', pl_unlk: 'payload_unlock', pos_clsd: 'position_closed', pos_open: 'position_open', pos_t: 'position_topic',
  pos_tpl: 'position_template', pow_cmd_t: 'power_command_topic', pow_cmd_tpl: 'power_command_template', qos: 'qos', ret: 'retain',
  schema: 'schema', set_pos_t: 'set_position_topic', set_pos_tpl: 'set_position_template', spd_rng_max: 'speed_range_max',
  spd_rng_min: 'speed_range_min', stat_cla: 'state_class', stat_closing: 'state_closing', stat_clsd: 'state_closed',
  stat_jam: 'state_jammed', stat_locked: 'state_locked', stat_locking: 'state_locking', stat_off: 'state_off', stat_on: 'state_on',
  stat_open: 'state_open', stat_opening: 'state_opening', stat_stopped: 'state_stopped', stat_t: 'state_topic',
  stat_tpl: 'state_template', stat_unlocked: 'state_unlocked', stat_unlocking: 'state_unlocking', stat_val_tpl: 'state_value_template',
  step: 'step', sug_dsp_prc: 'suggested_display_precision', temp_cmd_t: 'temperature_command_topic',
  temp_cmd_tpl: 'temperature_command_template', temp_stat_t: 'temperature_state_topic', temp_stat_tpl: 'temperature_state_template',
  temp_step: 'temp_step', temp_unit: 'temperature_unit', t: 'topic', uniq_id: 'unique_id', unit_of_meas: 'unit_of_measurement',
  val_tpl: 'value_template',
};

const DEVICE_ABBREVIATIONS: Record<string, string> = {
  cns: 'connections', ids: 'identifiers', name: 'name', mf: 'manufacturer', mdl: 'model', mdl_id: 'model_id', hw: 'hw_version',
  sw: 'sw_version', sa: 'suggested_area', sn: 'serial_number', via_device: 'via_device', cu: 'configuration_url',
};

export type Config = Record<string, unknown>;

export interface DeviceInfo {
  uniqueId: string;
  /** Often only on the first entity of a device; the driver merges device info across entities. */
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  swVersion: string | null;
}

export interface DiscoveredEntity {
  /** Key for updates and removal: the config topic, plus "#<component key>" for device discovery. */
  key: string;
  component: Component;
  /** unique_id from the payload; falls back to the key (Home Assistant keeps such entities out of its registry). */
  uniqueId: string;
  /** The entity's own name: null = use the device name; undefined = not given. See `entityName`. */
  ownName: string | null | undefined;
  /** Last part of the discovery topic, the fallback name without a device. */
  topicName: string;
  /** Preferred object id from default_entity_id or object_id. */
  objectId: string | null;
  device: DeviceInfo | null;
  config: Config;
}

export type ParseResult =
  | { kind: 'entities'; entities: DiscoveredEntity[]; removed: string[] }
  | { kind: 'remove'; keyPrefix: string }
  | { kind: 'ignore'; reason: string };

function expand(obj: Config, table: Record<string, string>): Config {
  const out: Config = {};
  for (const [k, v] of Object.entries(obj)) out[table[k] ?? k] = v;
  return out;
}

/** Replaces "~" at the start or end of every topic with the base topic. */
function applyBase(cfg: Config, base: string | undefined): Config {
  if (!base) return cfg;
  const sub = (v: unknown) =>
    typeof v === 'string' ? (v.startsWith('~') ? base + v.slice(1) : v.endsWith('~') ? v.slice(0, -1) + base : v) : v;
  const out: Config = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.endsWith('_topic') || k === 'topic') out[k] = sub(v);
    else if (k === 'availability' && Array.isArray(v)) {
      out[k] = v.map((a) => (a && typeof a === 'object' ? applyBase(expand(a as Config, ABBREVIATIONS), base) : a));
    } else out[k] = v;
  }
  return out;
}

function normalize(raw: Config): Config {
  const cfg = expand(raw, ABBREVIATIONS);
  const base = typeof cfg['~'] === 'string' ? (cfg['~'] as string) : undefined;
  const out = applyBase(cfg, base);
  if (Array.isArray(out.availability)) out.availability = out.availability.map((a) => (a && typeof a === 'object' ? expand(a as Config, ABBREVIATIONS) : a));
  if (out.device && typeof out.device === 'object') out.device = expand(out.device as Config, DEVICE_ABBREVIATIONS);
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function deviceInfo(dev: unknown): DeviceInfo | null {
  if (!dev || typeof dev !== 'object') return null;
  const d = dev as Config;
  const ids = Array.isArray(d.identifiers) ? d.identifiers : d.identifiers !== undefined ? [d.identifiers] : [];
  const conns = Array.isArray(d.connections) ? d.connections : [];
  const firstConn = conns.find((c) => Array.isArray(c) && c.length === 2) as [string, string] | undefined;
  const uniqueId = ids.length ? String(ids[0]) : firstConn ? `${firstConn[0]}:${firstConn[1].toLowerCase()}` : null;
  if (!uniqueId) return null;
  return {
    uniqueId,
    name: str(d.name),
    manufacturer: str(d.manufacturer),
    model: str(d.model),
    swVersion: str(d.sw_version),
  };
}

/** Home Assistant's naming: no own name → the device name; otherwise "<device> <name>" unless it already starts with it. */
export function entityName(d: Pick<DiscoveredEntity, 'ownName' | 'topicName' | 'component'>, deviceName: string | null): string {
  const own = d.ownName ?? null;
  if (deviceName) {
    if (own === null) return deviceName;
    return own.toLowerCase().startsWith(deviceName.toLowerCase()) ? own : `${deviceName} ${own}`;
  }
  return own ?? d.topicName ?? `MQTT ${d.component}`;
}

function objectIdOf(cfg: Config): string | null {
  const def = str(cfg.default_entity_id);
  if (def) return def.includes('.') ? def.slice(def.indexOf('.') + 1) : def;
  return str(cfg.object_id);
}

function entityFrom(key: string, component: Component, cfg: Config, objectIdFromTopic: string, sharedDevice?: DeviceInfo | null): DiscoveredEntity {
  const device = sharedDevice ?? deviceInfo(cfg.device);
  return {
    key,
    component,
    uniqueId: str(cfg.unique_id) ?? key,
    ownName: !('name' in cfg) ? undefined : cfg.name === null ? null : (str(cfg.name) ?? undefined),
    topicName: objectIdFromTopic,
    objectId: objectIdOf(cfg),
    device,
    config: cfg,
  };
}

const isSupported = (c: string): c is Component => (SUPPORTED_COMPONENTS as readonly string[]).includes(c);

/** Parses one message on `<prefix>/#`. `prefix` is the discovery prefix (usually "homeassistant"). */
export function parseDiscovery(prefix: string, topic: string, payload: string): ParseResult {
  if (!topic.startsWith(prefix + '/') || !topic.endsWith('/config')) return { kind: 'ignore', reason: 'not a config topic' };
  const parts = topic.slice(prefix.length + 1, -'/config'.length).split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return { kind: 'ignore', reason: 'unexpected topic layout' };
  const [component] = parts;
  const objectIdFromTopic = parts.at(-1)!;

  if (payload.trim() === '') return { kind: 'remove', keyPrefix: topic };

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { kind: 'ignore', reason: 'payload is not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'ignore', reason: 'payload is not a JSON object' };

  // Device discovery: shared settings at the top level, one entry per component.
  if (component === 'device') {
    const top = normalize(raw as Config);
    const device = deviceInfo(top.device);
    const cmps = top.components;
    if (!device || !cmps || typeof cmps !== 'object') return { kind: 'ignore', reason: 'device discovery needs "dev" and "cmps"' };
    const shared: Config = {};
    for (const k of ['state_topic', 'command_topic', 'availability', 'availability_topic', 'availability_mode', 'payload_available', 'payload_not_available', 'qos', 'json_attributes_topic']) {
      if (k in top) shared[k] = top[k];
    }
    const entities: DiscoveredEntity[] = [];
    const removed: string[] = [];
    for (const [cmpKey, cmpRaw] of Object.entries(cmps as Config)) {
      if (!cmpRaw || typeof cmpRaw !== 'object') continue;
      const cmp = normalize({ ...(cmpRaw as Config), ...('~' in (raw as Config) && !('~' in (cmpRaw as Config)) ? { '~': (raw as Config)['~'] } : {}) });
      const platform = String(cmp.platform ?? '');
      const key = `${topic}#${cmpKey}`;
      // A component reduced to just its platform is being removed.
      if (Object.keys(cmp).filter((k) => k !== 'platform' && k !== '~').length === 0) {
        removed.push(key);
        continue;
      }
      if (!isSupported(platform)) continue;
      entities.push(entityFrom(key, platform, { ...shared, ...cmp }, cmpKey, device));
    }
    return { kind: 'entities', entities, removed };
  }

  if (!isSupported(component)) return { kind: 'ignore', reason: `"${component}" entities are not supported yet` };
  return { kind: 'entities', entities: [entityFrom(topic, component, normalize(raw as Config), objectIdFromTopic)], removed: [] };
}

/** Every topic a config mentions (for spotting Sunroost's own announcements). */
export function topicsOf(cfg: Config): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if ((k.endsWith('_topic') || k === 'topic') && typeof v === 'string') out.push(v);
    if (k === 'availability' && Array.isArray(v)) for (const a of v) if (a && typeof a.topic === 'string') out.push(a.topic);
  }
  return out;
}
