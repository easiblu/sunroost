/**
 * Metric model. Names become MQTT topics compatible with SolarAssistant's published MQTT API ("PV power", "Battery state of charge",
 * "PV voltage 2", "Grid power 3" …) so MQTT topics and Home Assistant entities stay compatible
 * with existing installs. Units and aggregation rules are looked up from the name.
 */

export type Value = number | string | boolean | null;
/** A device's readings keyed by metric name, e.g. { "PV power": 1520, "Device mode": "Battery" }. */
export type Metrics = Record<string, Value>;

export interface MetricMeta {
  unit?: string;
  /** Home Assistant device_class. */
  deviceClass?: string;
  /** How values combine across parallel inverters into the "total" group. */
  agg?: 'sum' | 'avg';
  /** Static information (serial number, firmware) rather than a live reading. */
  info?: boolean;
}

/** Explicit metadata; anything else is inferred from the name in `meta()`. */
const CATALOG: Record<string, MetricMeta> = {
  'Device mode': {},
  'Fault code': {},
  'Load percentage': { unit: '%', agg: 'avg' },
  'Battery state of charge': { unit: '%', deviceClass: 'battery', agg: 'avg' },
  'Battery state of health': { unit: '%', agg: 'avg' },
  'State of charge': { unit: '%', deviceClass: 'battery', agg: 'avg' },
  'State of health': { unit: '%', agg: 'avg' },
  Cycles: { agg: 'sum' },
  'Serial number': { info: true },
  'Model name': { info: true },
  'Firmware version': { info: true },
  'Secondary firmware version': { info: true },
  'Protocol version': { info: true },
  'Battery capacity': { unit: 'kWh', info: true },
  Capacity: { unit: 'Ah', info: true },
  'Design capacity': { unit: 'Ah', info: true },
  'Cell voltage - Difference': { unit: 'V', deviceClass: 'voltage', agg: 'avg' },
  'Charge capacity': { unit: 'Ah' },
  'Max AC output power': { unit: 'W', info: true },
  'Max AC output apparent power': { unit: 'VA', info: true },
  'Load apparent power': { unit: 'VA', deviceClass: 'apparent_power', agg: 'sum' },
  // Energy outlook (src/energy): not inverter readings, but metrics for rules and entities.
  'Solar surplus': { unit: 'W', deviceClass: 'power' },
  'PV forecast today': { unit: 'kWh', deviceClass: 'energy' },
  'PV forecast tomorrow': { unit: 'kWh', deviceClass: 'energy' },
  'PV forecast rest of today': { unit: 'kWh', deviceClass: 'energy' },
};

const SUFFIX_RULES: [RegExp, MetricMeta][] = [
  [/energy|kwh/i, { unit: 'kWh', deviceClass: 'energy', agg: 'sum' }],
  [/apparent power/i, { unit: 'VA', deviceClass: 'apparent_power', agg: 'sum' }],
  [/power/i, { unit: 'W', deviceClass: 'power', agg: 'sum' }],
  [/voltage/i, { unit: 'V', deviceClass: 'voltage', agg: 'avg' }],
  [/current/i, { unit: 'A', deviceClass: 'current', agg: 'sum' }],
  [/frequency/i, { unit: 'Hz', deviceClass: 'frequency', agg: 'avg' }],
  [/temperature/i, { unit: '°C', deviceClass: 'temperature', agg: 'avg' }],
];

/** Strips a trailing phase/MPPT index: "PV power 2" → "PV power". */
export function baseName(name: string) {
  return name.replace(/ \d$/, '');
}

export function meta(name: string): MetricMeta {
  const exact = CATALOG[name] ?? CATALOG[baseName(name)];
  if (exact) return exact;
  for (const [re, m] of SUFFIX_RULES) if (re.test(name)) return m;
  return {};
}

/** "Battery state of charge" → "battery_state_of_charge" (the MQTT topic form). */
export function snake(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function round(v: number, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Signed 16-bit from a Modbus register. */
export const s16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
/** Unsigned 32-bit from two Modbus registers, high word first. */
export const u32 = (r: number[], i: number) => ((r[i] << 16) | r[i + 1]) >>> 0;
/** Signed 32-bit from two Modbus registers, high word first. */
export const s32 = (r: number[], i: number) => (r[i] << 16) | r[i + 1];

/**
 * Metrics that the history store keeps per inverter, and those it keeps for the combined system.
 * The set of metrics kept in long-term history.
 */
export const HISTORY_INVERTER_METRICS = [
  'Load power', 'Grid power', 'PV power', 'PV power 1', 'PV power 2', 'PV power 3', 'PV power 4',
  'PV voltage 1', 'PV voltage 2', 'PV voltage 3', 'PV voltage 4', 'PV current 1', 'PV current 2',
  'PV current 3', 'PV current 4', 'Battery voltage', 'Battery current', 'Grid voltage', 'Grid frequency',
  'AC output voltage', 'Temperature', 'Load power essential', 'Load power non-essential',
  'Generator power', 'Auxiliary load power',
];
export const HISTORY_TOTAL_METRICS = [
  'Load power', 'Grid power', 'PV power', 'Battery power', 'Battery state of charge', 'Battery voltage',
  'Battery temperature', 'Bus voltage', 'Temperature',
];
