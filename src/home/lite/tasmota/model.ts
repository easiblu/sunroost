/**
 * Tasmota native discovery, pure parts (modelled on Home Assistant's tasmota integration / hatasmota):
 * reading the retained `tasmota/discovery/<MAC>/config` and `…/sensors` messages, building the
 * device's topics, and turning state/sensor JSON into entity values.
 */

export interface TasmotaConfig {
  mac: string;
  ip: string | null;
  /** Device name (dn), friendly names per relay (fn), hostname (hn). */
  name: string;
  friendly: (string | null)[];
  hostname: string;
  model: string;
  version: string | null;
  topic: string;
  /** Full-topic pattern, e.g. "%prefix%/%topic%/". */
  fullTopic: string;
  /** Prefixes: [cmnd, stat, tele]. */
  prefixes: [string, string, string];
  /** Payloads for OFF, ON, TOGGLE, HOLD. */
  states: [string, string, string, string];
  online: string;
  offline: string;
  /** Relay types per channel: 0 none, 1 relay, 2 light, 3 shutter. */
  relays: number[];
  /** Light subtype (lt_st): 0 none, 1 dimmer, 2 CT, 3 RGB, 4 RGBW, 5 RGBCW. */
  lightType: number;
  /** Shutter count. */
  shutters: number;
  /** SetOption26: report POWER1 even with one relay. */
  powerIndexed: boolean;
}

const str = (v: unknown, dflt = '') => (typeof v === 'string' ? v : dflt);

export const normMac = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

/** Parses a discovery config; null when it isn't one (missing MAC/topic). */
export function parseConfig(raw: unknown): TasmotaConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, any>;
  const mac = normMac(c.mac);
  const topic = str(c.t);
  if (!mac || !topic) return null;
  const tp = Array.isArray(c.tp) && c.tp.length >= 3 ? c.tp.map(String) : ['cmnd', 'stat', 'tele'];
  const st = Array.isArray(c.state) && c.state.length >= 2 ? c.state.map(String) : ['OFF', 'ON', 'TOGGLE', 'HOLD'];
  const relays = Array.isArray(c.rl) ? c.rl.map((x: unknown) => Number(x) || 0) : [];
  const so = c.so && typeof c.so === 'object' ? c.so : {};
  const sht = Array.isArray(c.sht) ? c.sht : [];
  return {
    mac,
    ip: str(c.ip) || null,
    name: str(c.dn) || str(c.hn) || `Tasmota ${mac.slice(-6)}`,
    friendly: Array.isArray(c.fn) ? c.fn.map((x: unknown) => (typeof x === 'string' && x ? x : null)) : [],
    hostname: str(c.hn),
    model: str(c.md, 'Tasmota'),
    version: str(c.sw) || null,
    topic,
    fullTopic: str(c.ft, '%prefix%/%topic%/'),
    prefixes: [tp[0], tp[1], tp[2]],
    states: [st[0], st[1], st[2] ?? 'TOGGLE', st[3] ?? 'HOLD'],
    online: str(c.onln, 'Online'),
    offline: str(c.ofln, 'Offline'),
    relays,
    lightType: Number(c.lt_st) || 0,
    shutters: sht.length || Math.floor(relays.filter((r: number) => r === 3).length / 2),
    powerIndexed: String(so['26'] ?? '0') === '1',
  };
}

/** Topic for a prefix kind and command, e.g. ("cmnd", "POWER1") → "cmnd/tasmota_ABC/POWER1". */
export function topicFor(c: TasmotaConfig, kind: 0 | 1 | 2, command: string): string {
  const base = c.fullTopic
    .replace('%prefix%', c.prefixes[kind])
    .replace('%topic%', c.topic)
    .replace('%hostname%', c.hostname)
    .replace('%id%', c.mac.slice(-6).toUpperCase());
  return (base.endsWith('/') ? base : `${base}/`) + command;
}

/** Relay channels (1-based index) that are plain relays or lights. */
export function channels(c: TasmotaConfig): { index: number; kind: 'switch' | 'light' }[] {
  const out: { index: number; kind: 'switch' | 'light' }[] = [];
  c.relays.forEach((r, i) => {
    if (r === 1) out.push({ index: i + 1, kind: 'switch' });
    else if (r === 2) out.push({ index: i + 1, kind: 'light' });
  });
  return out;
}

/** The state key a relay reports under: "POWER" for a lone relay (unless SetOption26), else "POWER<n>". */
export function powerKey(c: TasmotaConfig, index: number): string {
  const count = c.relays.filter((r) => r === 1 || r === 2).length;
  return count === 1 && !c.powerIndexed && index === 1 ? 'POWER' : `POWER${index}`;
}

/**
 * PulseTime value for an off-timer in seconds: 1–111 are tenths of a second, 112–64900 are
 * (value − 100) seconds. Returns null when it can't be expressed.
 */
export function pulseTime(seconds: number): number | null {
  if (!(seconds > 0)) return null;
  if (seconds <= 11.1) return Math.max(1, Math.round(seconds * 10));
  const v = 100 + Math.round(seconds);
  return v <= 64900 ? v : null;
}

export interface SensorDef {
  /** "ENERGY.Power", "AM2301.Temperature". */
  key: string;
  label: string;
  unit: string | null;
  deviceClass: string | null;
}

const QUANTITIES: Record<string, { label: string; unit: string | null; deviceClass: string | null }> = {
  Power: { label: 'Power', unit: 'W', deviceClass: 'power' },
  ApparentPower: { label: 'Apparent power', unit: 'VA', deviceClass: 'apparent_power' },
  ReactivePower: { label: 'Reactive power', unit: 'var', deviceClass: 'reactive_power' },
  Factor: { label: 'Power factor', unit: null, deviceClass: 'power_factor' },
  Voltage: { label: 'Voltage', unit: 'V', deviceClass: 'voltage' },
  Current: { label: 'Current', unit: 'A', deviceClass: 'current' },
  Total: { label: 'Energy total', unit: 'kWh', deviceClass: 'energy' },
  Today: { label: 'Energy today', unit: 'kWh', deviceClass: 'energy' },
  Yesterday: { label: 'Energy yesterday', unit: 'kWh', deviceClass: 'energy' },
  Temperature: { label: 'Temperature', unit: '°C', deviceClass: 'temperature' },
  Humidity: { label: 'Humidity', unit: '%', deviceClass: 'humidity' },
  DewPoint: { label: 'Dew point', unit: '°C', deviceClass: 'temperature' },
  Pressure: { label: 'Pressure', unit: 'hPa', deviceClass: 'pressure' },
  Illuminance: { label: 'Illuminance', unit: 'lx', deviceClass: 'illuminance' },
  CarbonDioxide: { label: 'CO₂', unit: 'ppm', deviceClass: 'carbon_dioxide' },
  CO2: { label: 'CO₂', unit: 'ppm', deviceClass: 'carbon_dioxide' },
};

/** Keys that are units, timestamps or covered elsewhere (shutters, switches). */
const SKIP = /^(Time|TempUnit|PressureUnit|SpeedUnit|Shutter\d*|Switch\d*|Button\d*|TotalStartTime|Period)$/;

/**
 * Flattens a sensors object (discovery `sn`, tele/SENSOR, StatusSNS) into numeric readings
 * keyed "SENSOR.Quantity". Arrays (multi-phase energy) take their first element.
 */
export function flattenSensors(sn: unknown, tempUnit?: string): Map<string, { value: number; def: SensorDef }> {
  const out = new Map<string, { value: number; def: SensorDef }>();
  if (!sn || typeof sn !== 'object') return out;
  const unitT = tempUnit ?? str((sn as Record<string, unknown>).TempUnit, 'C');
  for (const [sensor, body] of Object.entries(sn as Record<string, unknown>)) {
    if (SKIP.test(sensor) || !body || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const [q, raw] of Object.entries(body as Record<string, unknown>)) {
      if (SKIP.test(q)) continue;
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const known = QUANTITIES[q];
      const unit = known?.unit === '°C' && unitT === 'F' ? '°F' : known?.unit ?? null;
      out.set(`${sensor}.${q}`, {
        value: v,
        def: {
          key: `${sensor}.${q}`,
          label: sensor === 'ENERGY' ? known?.label ?? q : `${sensor} ${known?.label ?? q}`,
          unit,
          deviceClass: known?.deviceClass ?? null,
        },
      });
    }
  }
  return out;
}

/** Shutter state from `{"Shutter1":{"Position":50,"Direction":0}}`. */
export function shutterState(body: unknown): { state: string; position: number } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const pos = Number(b.Position);
  if (!Number.isFinite(pos)) return null;
  const dir = Number(b.Direction) || 0;
  return { state: dir > 0 ? 'opening' : dir < 0 ? 'closing' : pos <= 0 ? 'closed' : 'open', position: pos };
}
