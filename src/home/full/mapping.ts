/**
 * How Home Assistant's data maps onto Sunroost's model. Pure functions, tested against captured payloads.
 */

/** A state as Home Assistant's `subscribe_entities` keeps it (compressed field names). */
export interface HaState {
  s: string;
  a: Record<string, unknown>;
  lc: number;
  lu?: number;
}

/**
 * Applies one `subscribe_entities` event to the cache: `a` (added, full states), `c` (changes:
 * "+" sets fields and merges attributes, "-" removes attributes), `r` (removed ids).
 * Returns the ids that changed and those removed.
 */
export function applyCompressed(cache: Map<string, HaState>, ev: Record<string, any>): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, st] of Object.entries((ev.a ?? {}) as Record<string, any>)) {
    cache.set(id, { s: String(st.s), a: st.a ?? {}, lc: st.lc, ...(st.lu !== undefined ? { lu: st.lu } : {}) });
    changed.push(id);
  }
  for (const [id, diff] of Object.entries((ev.c ?? {}) as Record<string, any>)) {
    const cur = cache.get(id);
    if (!cur) continue;
    const plus = diff['+'] ?? {};
    const next: HaState = { ...cur, a: { ...cur.a } };
    if (plus.s !== undefined) next.s = String(plus.s);
    if (plus.lc !== undefined) {
      next.lc = plus.lc;
      delete next.lu;
    }
    if (plus.lu !== undefined) next.lu = plus.lu;
    if (plus.a) Object.assign(next.a, plus.a);
    for (const k of (diff['-']?.a ?? []) as string[]) delete next.a[k];
    cache.set(id, next);
    changed.push(id);
  }
  for (const id of (ev.r ?? []) as string[]) {
    if (cache.delete(id)) removed.push(id);
  }
  return { changed, removed };
}

/** Domains Sunroost doesn't show: Home Assistant internals, media pipelines and things with no place on an energy app. */
export const SKIPPED_DOMAINS = new Set([
  'ai_task', 'assist_satellite', 'automation', 'calendar', 'camera', 'conversation', 'event', 'geo_location', 'image',
  'image_processing', 'notify', 'person', 'scene', 'script', 'stt', 'sun', 'tag', 'todo', 'tts', 'update', 'wake_word', 'zone',
]);

/** Integrations that are Home Assistant's own housekeeping, not devices. */
export const INTERNAL_PLATFORMS = new Set([
  'backup', 'cloud', 'go2rtc', 'hassio', 'homeassistant_alerts', 'analytics', 'radio_browser', 'shopping_list', 'google_translate',
  // Defaults Home Assistant sets up itself; Sunroost has its own sun and weather.
  'sun', 'met',
]);

/** Domains that only report. */
export const READ_ONLY_DOMAINS = new Set(['sensor', 'binary_sensor', 'weather', 'air_quality', 'device_tracker']);

/** Services that are housekeeping, not device control. */
const HIDDEN_SERVICES = new Set(['reload', 'reload_all']);

export function servicesFor(domain: string, haServices: Record<string, Record<string, unknown>>): string[] {
  if (READ_ONLY_DOMAINS.has(domain)) return [];
  return Object.keys(haServices[domain] ?? {}).filter((s) => !HIDDEN_SERVICES.has(s));
}

/**
 * Attributes Sunroost's UI uses that Home Assistant expresses differently: lights say whether they
 * dim through `supported_color_modes`.
 */
export function uiAttributes(domain: string, a: Record<string, unknown>): Record<string, unknown> {
  if (domain === 'light') {
    const modes = Array.isArray(a.supported_color_modes) ? (a.supported_color_modes as string[]) : [];
    return { ...a, supports_brightness: modes.some((m) => m !== 'onoff') };
  }
  return a;
}

export interface HaDevice {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  sw_version: string | null;
  area_id: string | null;
  identifiers: [string, string][];
  disabled_by: string | null;
}

export interface HaEntityEntry {
  entity_id: string;
  id: string;
  device_id: string | null;
  disabled_by: string | null;
  entity_category: string | null;
  platform: string;
}

/** Devices Sunroost announces itself (inverter data over MQTT discovery) come back through Home Assistant's MQTT integration. */
export function isSolarsOwn(device: HaDevice | undefined, uniqPrefix: string): boolean {
  return !!device?.identifiers?.some(([domain, id]) => domain === 'mqtt' && String(id).startsWith(`${uniqPrefix}_`));
}

/** Whether Sunroost should mirror this registry entry. */
export function includeEntity(e: HaEntityEntry, device: HaDevice | undefined, uniqPrefix: string): boolean {
  const domain = e.entity_id.split('.')[0];
  if (SKIPPED_DOMAINS.has(domain) || INTERNAL_PLATFORMS.has(e.platform) || e.disabled_by) return false;
  if (device?.disabled_by) return false;
  return !isSolarsOwn(device, uniqPrefix);
}
