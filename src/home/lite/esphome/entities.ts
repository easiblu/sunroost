/**
 * ESPHome entities → Sunroost entities: ListEntities* responses describe them, *StateResponse messages
 * update them, and Sunroost's services become *CommandRequest messages. Pure functions.
 */
import { CLIMATE_ACTIONS, CLIMATE_FAN_MODES, CLIMATE_MODES, Fields, MSG, supportsBrightness, Writer } from './proto.ts';

export interface EspEntity {
  key: number;
  objectId: string;
  /** Entity name as configured (may be empty: the device name stands in). */
  name: string;
  domain: string;
  /** Message type of its state responses. */
  stateType: number;
  unit: string | null;
  deviceClass: string | null;
  icon: string | null;
  diagnostic: boolean;
  services: string[];
  /** Static attributes (options, min/max …). */
  attributes: Record<string, unknown>;
  /** Extra info for commands. */
  info: Record<string, unknown>;
}

/** Common ListEntities fields: object_id 1, key 2, name 3, unique_id 4. */
function base(f: Fields, domain: string, stateType: number) {
  return { key: f.fixed32(2), objectId: f.str(1), name: f.str(3), domain, stateType, unit: null, deviceClass: null, icon: null, diagnostic: false, attributes: {}, info: {} };
}

const category = (f: Fields, n: number) => f.int(n) !== 0; // 1 config, 2 diagnostic

/** Describes one ListEntities* response; null for types Sunroost doesn't map. */
export function describeEntity(type: number, f: Fields): EspEntity | null {
  switch (type) {
    case MSG.ListEntitiesBinarySensorResponse:
      return { ...base(f, 'binary_sensor', MSG.BinarySensorStateResponse), deviceClass: f.str(5) || null, icon: f.str(8) || null, diagnostic: category(f, 9) || f.bool(6), services: [] };
    case MSG.ListEntitiesSensorResponse:
      return {
        ...base(f, 'sensor', MSG.SensorStateResponse), icon: f.str(5) || null, unit: f.str(6) || null, deviceClass: f.str(9) || null,
        diagnostic: category(f, 13), services: [], info: { decimals: f.int(7) },
      };
    case MSG.ListEntitiesTextSensorResponse:
      return { ...base(f, 'sensor', MSG.TextSensorStateResponse), icon: f.str(5) || null, deviceClass: f.str(8) || null, diagnostic: category(f, 7), services: [] };
    case MSG.ListEntitiesSwitchResponse:
      return { ...base(f, 'switch', MSG.SwitchStateResponse), icon: f.str(5) || null, deviceClass: f.str(9) || null, diagnostic: category(f, 8), services: ['turn_on', 'turn_off', 'toggle'] };
    case MSG.ListEntitiesLightResponse: {
      const modes = f.ints(12);
      const dims = modes.length ? supportsBrightness(modes) : f.bool(5);
      return { ...base(f, 'light', MSG.LightStateResponse), icon: f.str(14) || null, diagnostic: category(f, 15), services: ['turn_on', 'turn_off', 'toggle'], attributes: { supports_brightness: dims } };
    }
    case MSG.ListEntitiesFanResponse: {
      const speeds = f.int(8);
      return {
        ...base(f, 'fan', MSG.FanStateResponse), icon: f.str(10) || null, diagnostic: category(f, 11),
        services: f.bool(6) ? ['turn_on', 'turn_off', 'toggle', 'set_percentage'] : ['turn_on', 'turn_off', 'toggle'],
        info: { speeds: f.bool(6) ? speeds || 100 : 0 },
      };
    }
    case MSG.ListEntitiesCoverResponse: {
      const position = f.bool(6);
      const services = ['open_cover', 'close_cover', ...(f.bool(12) ? ['stop_cover'] : []), ...(position ? ['set_cover_position'] : [])];
      return { ...base(f, 'cover', MSG.CoverStateResponse), deviceClass: f.str(8) || null, icon: f.str(10) || null, diagnostic: category(f, 11), services, info: { position } };
    }
    case MSG.ListEntitiesNumberResponse:
      return {
        ...base(f, 'number', MSG.NumberStateResponse), icon: f.str(5) || null, diagnostic: category(f, 10), unit: f.str(11) || null, deviceClass: f.str(13) || null,
        services: ['set_value'], attributes: { min: round(f.float(6)), max: round(f.float(7)), step: round(f.float(8)) || 1, mode: ['auto', 'box', 'slider'][f.int(12)] ?? 'auto' },
      };
    case MSG.ListEntitiesSelectResponse:
      return { ...base(f, 'select', MSG.SelectStateResponse), icon: f.str(5) || null, diagnostic: category(f, 8), services: ['select_option'], attributes: { options: f.strs(6) } };
    case MSG.ListEntitiesButtonResponse:
      return { ...base(f, 'button', 0), icon: f.str(5) || null, diagnostic: category(f, 7), deviceClass: f.str(8) || null, services: ['press'] };
    case MSG.ListEntitiesClimateResponse: {
      const modes = f.ints(7).map((m) => CLIMATE_MODES[m]).filter(Boolean);
      const fanModes = f.ints(13).map((m) => CLIMATE_FAN_MODES[m]).filter(Boolean);
      const services = ['set_hvac_mode', 'set_temperature', 'turn_on', 'turn_off', ...(fanModes.length ? ['set_fan_mode'] : [])];
      return {
        ...base(f, 'climate', MSG.ClimateStateResponse), icon: f.str(19) || null, diagnostic: category(f, 20), services,
        attributes: {
          hvac_modes: modes, min_temp: round(f.float(8, 7)), max_temp: round(f.float(9, 35)), target_temp_step: round(f.float(10, 0.5)) || 0.5,
          ...(fanModes.length ? { fan_modes: fanModes } : {}),
        },
        // feature_flags (27) bit 0 = supports current temperature; field 5 on older firmware.
        info: { currentTemp: f.bool(5) || (f.uint(27) & 1) === 1 },
      };
    }
    default:
      return null;
  }
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** A state message → Sunroost state and attributes (merged with the entity's static ones). null = not this entity's state. */
export function stateOf(e: EspEntity, f: Fields): { state: string; attributes: Record<string, unknown> } {
  const attrs: Record<string, unknown> = { ...e.attributes };
  switch (e.domain) {
    case 'binary_sensor':
      return { state: f.bool(3) ? 'unknown' : f.bool(2) ? 'on' : 'off', attributes: attrs };
    case 'sensor': {
      if (e.stateType === MSG.TextSensorStateResponse) return { state: f.bool(3) ? 'unknown' : f.str(2), attributes: attrs };
      const v = f.float(2, NaN);
      if (f.bool(3) || !Number.isFinite(v)) return { state: 'unknown', attributes: attrs };
      const d = Number(e.info.decimals ?? 2);
      return { state: String(Number(v.toFixed(Math.max(0, Math.min(6, d))))), attributes: attrs };
    }
    case 'switch':
      return { state: f.bool(2) ? 'on' : 'off', attributes: attrs };
    case 'light':
      if (e.attributes.supports_brightness) attrs.brightness = Math.round(f.float(3) * 255);
      return { state: f.bool(2) ? 'on' : 'off', attributes: attrs };
    case 'fan': {
      const speeds = Number(e.info.speeds ?? 0);
      if (speeds) attrs.percentage = Math.round((f.int(6) / speeds) * 100);
      return { state: f.bool(2) ? 'on' : 'off', attributes: attrs };
    }
    case 'cover': {
      const pos = f.float(3, NaN);
      const op = f.int(5);
      if (Number.isFinite(pos)) attrs.current_position = Math.round(pos * 100);
      const state = op === 1 ? 'opening' : op === 2 ? 'closing' : e.info.position ? (pos > 0 ? 'open' : 'closed') : f.int(2) === 1 ? 'closed' : 'open';
      return { state, attributes: attrs };
    }
    case 'number': {
      const v = f.float(2, NaN);
      return { state: f.bool(3) || !Number.isFinite(v) ? 'unknown' : String(round(v)), attributes: attrs };
    }
    case 'select':
      return { state: f.bool(3) ? 'unknown' : f.str(2), attributes: attrs };
    case 'climate': {
      const mode = CLIMATE_MODES[f.int(2)] ?? 'off';
      if (e.info.currentTemp) attrs.current_temperature = round(f.float(3), 1);
      attrs.temperature = round(f.float(4), 1);
      if (f.has(8)) attrs.hvac_action = CLIMATE_ACTIONS[f.int(8)] ?? 'idle';
      if (f.has(9)) attrs.fan_mode = CLIMATE_FAN_MODES[f.int(9)];
      return { state: mode, attributes: attrs };
    }
    default:
      return { state: 'unknown', attributes: attrs };
  }
}

export type Command = { type: number; payload: Buffer } | { error: string };

/**
 * A Sunroost service call → an ESPHome command. `current` is the entity's state now (for toggle and
 * climate turn_on). Keys a command doesn't know (e.g. auto_off_s) are ignored.
 */
export function commandFor(e: EspEntity, service: string, data: Record<string, unknown>, current: string | undefined, lastMode?: string): Command {
  const w = new Writer().fixed32(1, e.key);
  const on = service === 'toggle' ? current !== 'on' : service === 'turn_on';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  switch (e.domain) {
    case 'switch':
      return { type: MSG.SwitchCommandRequest, payload: w.bool(2, on).bytes() };
    case 'light': {
      w.bool(2, true).bool(3, on);
      const b = num(data.brightness);
      if (on && Number.isFinite(b)) w.bool(4, true).float(5, Math.max(0, Math.min(255, b)) / 255);
      return { type: MSG.LightCommandRequest, payload: w.bytes() };
    }
    case 'fan': {
      if (service === 'set_percentage') {
        const p = num(data.percentage);
        if (!(p >= 0 && p <= 100)) return { error: 'percentage must be 0–100' };
        const speeds = Number(e.info.speeds ?? 100);
        if (p === 0) return { type: MSG.FanCommandRequest, payload: w.bool(2, true).bool(3, false).bytes() };
        return { type: MSG.FanCommandRequest, payload: w.bool(2, true).bool(3, true).bool(10, true).varint(11, Math.max(1, Math.round((p / 100) * speeds))).bytes() };
      }
      return { type: MSG.FanCommandRequest, payload: w.bool(2, true).bool(3, on).bytes() };
    }
    case 'cover': {
      if (service === 'stop_cover') return { type: MSG.CoverCommandRequest, payload: w.bool(8, true).bytes() };
      if (service === 'set_cover_position') {
        const p = num(data.position);
        if (!(p >= 0 && p <= 100)) return { error: 'position must be 0–100' };
        return { type: MSG.CoverCommandRequest, payload: w.bool(4, true).float(5, p / 100).bytes() };
      }
      const open = service === 'open_cover';
      if (e.info.position) return { type: MSG.CoverCommandRequest, payload: w.bool(4, true).float(5, open ? 1 : 0).bytes() };
      return { type: MSG.CoverCommandRequest, payload: w.bool(2, true).varint(3, open ? 0 : 1).bytes() };
    }
    case 'number': {
      const v = num(data.value);
      const { min, max } = e.attributes as { min: number; max: number };
      if (!(v >= min && v <= max)) return { error: `value must be between ${min} and ${max}` };
      return { type: MSG.NumberCommandRequest, payload: w.float(2, v).bytes() };
    }
    case 'select': {
      const o = String(data.option ?? '');
      if (!(e.attributes.options as string[]).includes(o)) return { error: `"${o}" is not one of the options` };
      return { type: MSG.SelectCommandRequest, payload: w.str(2, o).bytes() };
    }
    case 'button':
      return { type: MSG.ButtonCommandRequest, payload: w.bytes() };
    case 'climate': {
      const modes = e.attributes.hvac_modes as string[];
      const setMode = (m: string): Command | null => {
        const i = CLIMATE_MODES.indexOf(m);
        if (i < 0 || !modes.includes(m)) return { error: `"${m}" is not one of the modes` };
        w.bool(2, true).varint(3, i);
        return null;
      };
      if (service === 'turn_off') return setMode('off') ?? { type: MSG.ClimateCommandRequest, payload: w.bytes() };
      if (service === 'turn_on') {
        const m = lastMode && lastMode !== 'off' ? lastMode : modes.find((x) => x !== 'off');
        if (!m) return { error: 'No mode to turn on to' };
        return setMode(m) ?? { type: MSG.ClimateCommandRequest, payload: w.bytes() };
      }
      if (service === 'set_hvac_mode') return setMode(String(data.hvac_mode ?? '')) ?? { type: MSG.ClimateCommandRequest, payload: w.bytes() };
      if (service === 'set_fan_mode') {
        const i = CLIMATE_FAN_MODES.indexOf(String(data.fan_mode ?? ''));
        if (i < 0) return { error: 'Unknown fan mode' };
        return { type: MSG.ClimateCommandRequest, payload: w.bool(12, true).varint(13, i).bytes() };
      }
      if (service === 'set_temperature') {
        const t = num(data.temperature);
        const { min_temp: lo, max_temp: hi } = e.attributes as { min_temp: number; max_temp: number };
        if (!(t >= lo && t <= hi)) return { error: `temperature must be between ${lo} and ${hi}` };
        if (typeof data.hvac_mode === 'string') {
          const err = setMode(data.hvac_mode);
          if (err) return err;
        }
        return { type: MSG.ClimateCommandRequest, payload: w.bool(4, true).float(5, t).bytes() };
      }
      return { error: `Climate doesn't support ${service}` };
    }
    default:
      return { error: `This ${e.domain} can't be controlled` };
  }
}
