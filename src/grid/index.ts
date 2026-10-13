/**
 * Grid provider subsystem. "default" publishes nothing beyond the provider name; "energy_charts"
 * fetches day-ahead prices for a bidding zone from the free Energy-Charts API, caches them in
 * SQLite (so the price survives being offline), and publishes the current price, premium,
 * next-hour price and the next cheapest hour into state.grid. "eskom" fetches South African
 * load-shedding schedules from eskom-calendar, caches them, and publishes the next planned outage
 * for the selected area.
 */
import { db } from '../core/db.ts';
import { logger } from '../core/log.ts';
import type { Metrics } from '../core/metrics.ts';
import { settings } from '../core/settings.ts';
import { state } from '../core/state.ts';
import {
  CURRENCIES, ENERGY_CHARTS_AREAS, dayKey, nextCheapestHour, parseEcbRates, parseEnergyCharts, roundPrice,
  slotAt, toHourly, withPremium, type PriceSlot, type RawSlot,
} from './prices.ts';
import {
  ESKOM_AREAS_URL, ESKOM_CSV_URL, ESKOM_SOURCE_URL, fmtIn, humanName, mergeAdjacent, nextOutage, parseAreaMetadata,
  parseOutagesCsv, type AreaEntry, type Outage,
} from './eskom.ts';

const log = logger('grid');
const API = 'https://api.energy-charts.info/price';
const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const REFRESH_MS = 60 * 60_000;
const RETRY_MS = 10 * 60_000;
const FX_MAX_AGE_MS = 24 * 60 * 60_000;
const KEEP_DAYS = 3;
const FETCH_TIMEOUT_MS = 20_000;

/** Metrics this module owns in state.grid; anything else there (from inverters) is left alone. */
const OWN_KEYS = [
  'Provider', 'Provider area', 'Price', 'Price premium', 'Day ahead price', 'Next cheapest hour',
  'Next planned outage start', 'Next planned outage end', 'Next planned outage in', 'Next planned outage stage',
];

export const PROVIDERS = [
  { id: 'default', name: 'None' },
  { id: 'energy_charts', name: 'Day-ahead prices (Energy-Charts)' },
  { id: 'eskom', name: 'Eskom load-shedding (eskom-calendar)' },
];

/** The configured provider. The settings type predates "eskom", so compare as a plain string. */
const provider = () => String(settings.get('grid.driver_id'));

const AREAS_MAX_AGE_MS = 7 * 86_400_000;

let tick: NodeJS.Timeout | null = null;
let settingsTimer: NodeJS.Timeout | null = null;
let nextAttempt = 0;
let lastError: string | null = null;
let updatedAt: number | null = null;
let inflight: Promise<void> | null = null;
let refetch = false;

export async function start() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS grid_prices (
      area TEXT NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (area, start)
    );
    CREATE TABLE IF NOT EXISTS grid_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS eskom_outages (
      area TEXT NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, stage INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (area, start)
    );
    CREATE TABLE IF NOT EXISTS eskom_areas (area TEXT NOT NULL, name TEXT NOT NULL, municipality TEXT NOT NULL, province TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS eskom_areas_area ON eskom_areas (area);
  `);
  updatedAt = fetchedAt();
  settings.on('change', onSettingChange);
  publish();
  void refresh();
  // Once a minute: republish (the current slot moves on) and refetch when due.
  tick = setInterval(() => {
    publish();
    if (Date.now() >= nextAttempt) void refresh();
  }, 60_000);
}

export async function stop() {
  if (tick) clearInterval(tick);
  if (settingsTimer) clearTimeout(settingsTimer);
  tick = settingsTimer = null;
  settings.off('change', onSettingChange);
  await inflight?.catch(() => {});
}

function onSettingChange(key: string) {
  if (!key.startsWith('grid.') && key !== 'timezone') return;
  // Several keys usually arrive together; react once.
  if (key !== 'timezone') refetch = true;
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    lastError = null;
    updatedAt = fetchedAt();
    publish();
    if (refetch) {
      refetch = false;
      nextAttempt = 0;
      void refresh();
    }
  }, 200);
}

/** When the active provider's data was last fetched. */
function fetchedAt() {
  const key = provider() === 'eskom' ? 'eskom:fetched' : `fetched:${settings.get('grid.area')}`;
  return Number(meta(key)) || null;
}

/** Fetches prices or schedules for the active provider. Never throws; errors land in `lastError`. */
export function refresh(force = false): Promise<void> {
  if (inflight) return inflight;
  if (provider() === 'eskom') {
    if (!force && Date.now() < nextAttempt) return Promise.resolve();
    inflight = refreshEskom().finally(() => {
      inflight = null;
      publish();
    });
    return inflight;
  }
  if (provider() !== 'energy_charts') return Promise.resolve();
  if (!force && Date.now() < nextAttempt) return Promise.resolve();
  inflight = (async () => {
    const area = settings.get('grid.area');
    try {
      await fetchFx(settings.get('grid.currency'));
      const slots = await fetchPrices(area);
      store(area, slots);
      updatedAt = Date.now();
      setMeta(`fetched:${area}`, String(updatedAt));
      if (lastError) log.info(`Day-ahead prices for ${area} available again.`);
      lastError = null;
      nextAttempt = Date.now() + REFRESH_MS;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== lastError) log.warn(`Fetching day-ahead prices for ${area} failed: ${message}`);
      lastError = message;
      nextAttempt = Date.now() + RETRY_MS;
    } finally {
      inflight = null;
      publish();
    }
  })();
  return inflight;
}

async function fetchPrices(area: string): Promise<RawSlot[]> {
  if (!ENERGY_CHARTS_AREAS.some((a) => a.id === area)) throw new Error(`Unsupported area "${area}"`);
  // Dates are interpreted in the exchange's local time; today → tomorrow covers the published day-ahead set.
  const today = dayKey(Date.now(), 'Europe/Berlin');
  const tomorrow = dayKey(Date.now() + 86_400_000, 'Europe/Berlin');
  const url = `${API}?bzn=${encodeURIComponent(area)}&start=${today}&end=${tomorrow}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
  const slots = parseEnergyCharts(await res.json());
  if (!slots.length) throw new Error('No prices published for this area');
  return slots;
}

/** Keeps the ECB reference rates fresh enough for currency conversion. */
async function fetchFx(currency: string) {
  if (currency === 'EUR') return;
  const cached = fxCache();
  if (cached && Date.now() - cached.fetchedAt < FX_MAX_AGE_MS && cached.rates[currency]) return;
  try {
    const res = await fetch(ECB, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rates = parseEcbRates(await res.text());
    if (Object.keys(rates).length < 2) throw new Error('no rates in response');
    setMeta('fx', JSON.stringify({ rates, fetchedAt: Date.now() }));
  } catch (err) {
    // A stale rate is better than none; only warn.
    log.warn(`Fetching exchange rates failed: ${(err as Error).message}`);
  }
}

function fxCache(): { rates: Record<string, number>; fetchedAt: number } | null {
  try {
    return JSON.parse(meta('fx') ?? 'null');
  } catch {
    return null;
  }
}

/** Currency used for display and the rate from EUR. Falls back to EUR without a rate. */
function conversion(): { currency: string; rate: number; fxError: string | null } {
  const currency = settings.get('grid.currency');
  if (currency === 'EUR') return { currency, rate: 1, fxError: null };
  const rate = fxCache()?.rates[currency];
  if (rate) return { currency, rate, fxError: null };
  return { currency: 'EUR', rate: 1, fxError: `No exchange rate for ${currency} yet; prices shown in EUR.` };
}

function store(area: string, slots: RawSlot[]) {
  const d = db();
  const insert = d.prepare(`INSERT OR REPLACE INTO grid_prices (area, start, "end", price) VALUES (?, ?, ?, ?)`);
  d.exec('BEGIN');
  try {
    for (const s of slots) insert.run(area, s.start, s.end, s.price);
    d.prepare(`DELETE FROM grid_prices WHERE "end" < ?`).run(Date.now() - KEEP_DAYS * 86_400_000);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function cached(area: string): RawSlot[] {
  return db()
    .prepare(`SELECT start, "end" AS end, price FROM grid_prices WHERE area = ? AND "end" > ? ORDER BY start`)
    .all(area, Date.now() - 2 * 86_400_000) as unknown as RawSlot[];
}

/** Converted prices for the configured area from today (in the configured time zone) onwards. */
export function prices(): PriceSlot[] {
  const tz = settings.get('timezone');
  const { rate } = conversion();
  const all = withPremium(cached(settings.get('grid.area')), { rate, multiplier: settings.get('grid.price_multiplier'), timeZone: tz });
  const today = dayKey(Date.now(), tz);
  return all.filter((s) => dayKey(s.start, tz) >= today);
}

function fmtHour(ts: number, tz: string) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
  if (dayKey(ts, tz) === dayKey(Date.now(), tz)) return time;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(ts);
  return `${day} ${time}`;
}

/** Writes this module's metrics into state.grid, replacing (not merging) the previous set. */
function publish() {
  const id = provider();
  const metrics: Metrics = { Provider: id === 'eskom' ? 'Eskom' : PROVIDERS.find((p) => p.id === id)?.name ?? id };
  if (id === 'eskom') Object.assign(metrics, eskomMetrics(Date.now()));
  if (id === 'energy_charts') {
    const tz = settings.get('timezone');
    const now = Date.now();
    const slots = safe(() => prices(), []);
    const current = slotAt(slots, now);
    const next = slotAt(slots, now + 3_600_000);
    const cheapest = nextCheapestHour(slots, now);
    metrics['Provider area'] = settings.get('grid.area');
    metrics.Price = current ? roundPrice(current.price) : null;
    metrics['Price premium'] = current ? roundPrice(current.premium) : null;
    metrics['Day ahead price'] = next ? roundPrice(next.price) : null;
    metrics['Next cheapest hour'] = cheapest ? fmtHour(cheapest.start, tz) : null;
  }
  const rest = Object.fromEntries(Object.entries(state.grid).filter(([k]) => !OWN_KEYS.includes(k)));
  state.grid = rest;
  state.updateGrid(metrics);
}

/** Everything the grid status page and the API need. */
export function status(opts: { hourly?: boolean } = {}) {
  const id = provider();
  if (id === 'eskom') return eskomStatus();
  const { currency, fxError } = conversion();
  const slots = id === 'energy_charts' ? safe(() => prices(), []) : [];
  const list = opts.hourly ? toHourly(slots) : slots;
  const resolutionMin = slots.length ? Math.round((slots[0].end - slots[0].start) / 60_000) : null;
  return {
    provider: id,
    providerName: PROVIDERS.find((p) => p.id === id)?.name ?? id,
    area: settings.get('grid.area'),
    currency,
    unit: `${currency}/kWh`,
    multiplier: settings.get('grid.price_multiplier'),
    resolutionMin: opts.hourly && slots.length ? 60 : resolutionMin,
    prices: list.map((s) => ({ start: s.start, end: s.end, price: roundPrice(s.price), premium: roundPrice(s.premium) })),
    updatedAt,
    nextRefresh: id === 'energy_charts' ? nextAttempt || null : null,
    error: id === 'energy_charts' ? (lastError ?? fxError) : null,
    source: id === 'energy_charts' ? 'Energy-Charts (Fraunhofer ISE), CC BY 4.0' : null,
  };
}

export const areas = () => ENERGY_CHARTS_AREAS;

// ---------- Eskom (eskom-calendar) ----------

/** The selected load-shedding area: the eskom-calendar calendar id plus a display name. */
export function eskomArea(): { id: string; name: string } | null {
  try {
    const v = JSON.parse(meta('eskom:area') ?? 'null');
    return v && typeof v.id === 'string' && v.id ? v : null;
  } catch {
    return null;
  }
}

async function fetchText(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Downloads every announced outage and replaces the cache. */
async function refreshEskom() {
  try {
    const outages = parseOutagesCsv(await fetchText(ESKOM_CSV_URL));
    const d = db();
    const insert = d.prepare(`INSERT OR REPLACE INTO eskom_outages (area, start, "end", stage, source) VALUES (?, ?, ?, ?, ?)`);
    d.exec('BEGIN');
    try {
      d.exec('DELETE FROM eskom_outages');
      for (const o of outages) insert.run(o.area, o.start, o.end, o.stage, o.source);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
    updatedAt = Date.now();
    setMeta('eskom:fetched', String(updatedAt));
    if (lastError) log.info('Load-shedding schedules available again.');
    lastError = null;
    nextAttempt = Date.now() + REFRESH_MS;
  } catch (err) {
    const message = (err as Error).message;
    if (message !== lastError) log.warn(`Fetching load-shedding schedules failed: ${message}`);
    lastError = message;
    nextAttempt = Date.now() + RETRY_MS;
  }
}

let areasInflight: Promise<void> | null = null;

/** Makes sure the searchable area list is cached (fetched at most weekly). */
export function loadEskomAreas(force = false): Promise<void> {
  if (areasInflight) return areasInflight;
  const fetched = Number(meta('eskom:areas_fetched')) || 0;
  const count = (db().prepare('SELECT COUNT(*) AS n FROM eskom_areas').get() as { n: number }).n;
  if (!force && count > 0 && Date.now() - fetched < AREAS_MAX_AGE_MS) return Promise.resolve();
  areasInflight = (async () => {
    try {
      const entries = parseAreaMetadata(await fetchText(ESKOM_AREAS_URL));
      if (entries.length < 10) throw new Error('No areas in eskom-calendar metadata');
      await storeAreas(entries);
      setMeta('eskom:areas_fetched', String(Date.now()));
      log.info(`Loaded ${new Set(entries.map((e) => e.area)).size} load-shedding areas.`);
    } catch (err) {
      log.warn(`Fetching load-shedding areas failed: ${(err as Error).message}`);
      if (!count) throw err;
    } finally {
      areasInflight = null;
    }
  })();
  return areasInflight;
}

/** Replaces the area list in chunks, yielding between them so the event loop stays responsive. */
async function storeAreas(entries: AreaEntry[]) {
  const d = db();
  const insert = d.prepare('INSERT INTO eskom_areas (area, name, municipality, province) VALUES (?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM eskom_areas');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      insert.run(e.area, e.name, e.municipality, e.province);
      if (i % 4000 === 3999) await new Promise((r) => setImmediate(r));
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Area search for the "Select Eskom connection/area" modal. Every word must match the place
 * name, municipality, province or calendar id. One row per (area, place), best matches first.
 */
export async function searchEskomAreas(q: string, limit = 50) {
  let error: string | null = null;
  await loadEskomAreas().catch((err) => (error = (err as Error).message));
  const words = q.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  let rows: AreaEntry[] = [];
  if (words.length) {
    const where = words.map(() => `(lower(name) || ' ' || municipality || ' ' || province || ' ' || area) LIKE ?`).join(' AND ');
    const like = (w: string) => `%${w.replace(/[%_]/g, '')}%`;
    rows = db()
      .prepare(`SELECT area, name, municipality, province FROM eskom_areas WHERE ${where} LIMIT ?`)
      .all(...words.map(like), 400) as unknown as AreaEntry[];
    // Exact and prefix name matches first.
    const first = words[0];
    const rank = (r: AreaEntry) => (r.name.toLowerCase() === q.toLowerCase().trim() ? 0 : r.name.toLowerCase().startsWith(first) ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.area.localeCompare(b.area));
  }
  const seen = new Set<string>();
  const areas = [];
  for (const r of rows) {
    const key = `${r.area}|${r.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    areas.push({
      id: r.area,
      name: titleCase(r.name),
      municipality: humanName(r.municipality),
      province: humanName(r.province),
      areaName: humanName(r.area),
    });
    if (areas.length >= limit) break;
  }
  return { query: q, areas, selected: eskomArea(), error };
}

const titleCase = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Selects (or with an empty id, clears) the load-shedding area. */
export async function selectEskomArea(id: string, name?: string) {
  const area = String(id ?? '').trim();
  if (!area) {
    setMeta('eskom:area', 'null');
  } else {
    const known =
      db().prepare('SELECT 1 FROM eskom_areas WHERE area = ? LIMIT 1').get(area) ??
      db().prepare('SELECT 1 FROM eskom_outages WHERE area = ? LIMIT 1').get(area);
    if (!known) throw new Error(`Unknown load-shedding area "${area}"`);
    const label = String(name ?? '').trim().slice(0, 120);
    const display = label && label.toLowerCase() !== humanName(area).toLowerCase() ? `${label} (${humanName(area)})` : humanName(area);
    setMeta('eskom:area', JSON.stringify({ id: area, name: display }));
    log.info(`Load-shedding area set to ${display}.`);
  }
  publish();
  if (provider() === 'eskom' && !(Number(meta('eskom:fetched')) > 0)) await refresh(true);
  return eskomStatus();
}

/** Planned outages for the selected area from the start of today (local), merged. */
export function eskomOutages(now = Date.now()): Outage[] {
  const area = eskomArea();
  if (!area) return [];
  const rows = db()
    .prepare(`SELECT area, start, "end" AS end, stage, source FROM eskom_outages WHERE area = ? AND "end" > ? ORDER BY start`)
    .all(area.id, now - 86_400_000) as unknown as Outage[];
  const today = dayKey(now, settings.get('timezone'));
  return mergeAdjacent(rows).filter((o) => dayKey(o.end, settings.get('timezone')) >= today);
}

function eskomMetrics(now: number): Metrics {
  const area = eskomArea();
  const m: Metrics = { 'Provider area': area?.name ?? null };
  const next = area ? nextOutage(safe(() => eskomOutages(now), []), now) : null;
  if (next) {
    const tz = settings.get('timezone');
    m['Next planned outage start'] = fmtHour(next.start, tz);
    m['Next planned outage end'] = fmtHour(next.end, tz);
    m['Next planned outage in'] = fmtIn(next.start - now);
    m['Next planned outage stage'] = next.stage;
  }
  return m;
}

function eskomStatus() {
  const area = eskomArea();
  return {
    provider: 'eskom',
    providerName: PROVIDERS.find((p) => p.id === 'eskom')!.name,
    area: area?.id ?? null,
    areaName: area?.name ?? null,
    outages: safe(() => eskomOutages(), []).map(({ start, end, stage, source }) => ({ start, end, stage, source })),
    prices: [],
    updatedAt,
    nextRefresh: nextAttempt || null,
    error: lastError,
    source: 'eskom-calendar',
    sourceUrl: ESKOM_SOURCE_URL,
  };
}
export const currencies = () => CURRENCIES;

function meta(key: string): string | null {
  const row = db().prepare(`SELECT value FROM grid_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string) {
  db().prepare(`INSERT OR REPLACE INTO grid_meta (key, value) VALUES (?, ?)`).run(key, value);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    log.error((err as Error).message);
    return fallback;
  }
}
