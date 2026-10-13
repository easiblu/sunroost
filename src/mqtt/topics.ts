/**
 * Topic naming and payload formatting, compatible with SolarAssistant's published MQTT API:
 *   <prefix>/inverter_<n>/<metric>/state   (n is 1-based)
 *   <prefix>/battery_<n>/<metric>/state
 *   <prefix>/total/<metric>/state
 *   <prefix>/grid/<metric>/state           (grid-provider data; a Sunroost addition)
 *   <prefix>/<device>/<setting>/set        (commands)
 *   <prefix>/set/response_message/state    (command results, not retained)
 *   <prefix>/status                        (availability: online/offline)
 */
import type { Value } from '../core/metrics.ts';

export type DeviceKind = 'inverter' | 'battery' | 'total' | 'grid';

/** Device topic segment: inverter_1, battery_2, total, grid. `index` is 0-based. */
export function deviceSegment(kind: DeviceKind, index = 0) {
  return kind === 'inverter' || kind === 'battery' ? `${kind}_${index + 1}` : kind;
}

/** Human device name used in Home Assistant: "Inverter 1", "Battery 2", "Total", "Grid". */
export function deviceName(kind: DeviceKind, index = 0) {
  const name = kind[0].toUpperCase() + kind.slice(1);
  return kind === 'inverter' || kind === 'battery' ? `${name} ${index + 1}` : name;
}

/**
 * The published rule: lowercase, spaces to "_" ("Battery state of charge" → "battery_state_of_charge",
 * "Cell voltage - Highest" → "cell_voltage_-_highest"). Kept verbatim so existing Home Assistant
 * setups written for that API keep working. MQTT wildcard characters are stripped.
 */
export const metricSegment = (name: string) => name.toLowerCase().replace(/ /g, '_').replace(/[#+/]/g, '');

export const stateTopic = (prefix: string, device: string, metric: string) => `${prefix}/${device}/${metric}/state`;
export const commandTopic = (prefix: string, device: string, metric: string) => `${prefix}/${device}/${metric}/set`;
export const commandFilter = (prefix: string) => `${prefix}/+/+/set`;
export const responseTopic = (prefix: string) => `${prefix}/set/response_message/state`;
export const availabilityTopic = (prefix: string) => `${prefix}/status`;

/** Plain-text payload: numbers and strings as-is, booleans as true/false. null → no publish. */
export function formatPayload(value: Value): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return String(value);
}

/** Splits "<prefix>/<device>/<metric>/set" into its parts, or null when it isn't a command topic. */
export function parseCommandTopic(prefix: string, topic: string): { device: string; metric: string } | null {
  if (!topic.startsWith(prefix + '/') || !topic.endsWith('/set')) return null;
  const parts = topic.slice(prefix.length + 1, -'/set'.length).split('/');
  return parts.length === 2 && parts[0] && parts[1] ? { device: parts[0], metric: parts[1] } : null;
}

/** Strips credentials from a broker URL before showing or logging it. */
export function safeUrl(url: string) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}
