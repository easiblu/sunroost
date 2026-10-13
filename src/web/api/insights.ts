/**
 * Data for the redesigned dashboard:
 *  GET /api/dashboard/summary → today's energy vs yesterday at the same time of day, cost, CO₂ saved,
 *      self-sufficiency, load peak/average, battery time-to-full/empty, and rule-based insights.
 *  GET /api/dashboard/usage?range=day|week|month → energy usage series for the usage chart.
 *  GET /api/weather, GET /api/weather/places?q= → weather and place search.
 *  GET /api/alerts → active and recently resolved alerts.
 */
import * as alerts from '../../alerts/index.ts';
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import { state } from '../../core/state.ts';
import { queryHistory } from '../../stats/history.ts';
import { energyTotals, readDays, tz } from '../../stats/totals.ts';
import { addDays, dayKey, dayStart } from '../../stats/tz.ts';
import * as weather from '../../weather/index.ts';
import type { App } from '../server.ts';

const ENERGY_METRICS = ['PV power', 'Load power', 'Grid power', 'Battery power'];
const CACHE_MS = 60_000;
let cache: { at: number; value: unknown } | null = null;

interface Window {
  pv: number;
  load: number;
  gridImport: number;
  gridExport: number;
  batteryCharge: number;
  batteryDischarge: number;
  peak: { w: number; at: number } | null;
}

/** Integrates the stored power history over [from, to). */
function windowEnergy(from: number, to: number): Window {
  const h = queryHistory({ from, to, metrics: ENERGY_METRICS });
  const step = h.resolution / 3600 / 1000; // W × step → kWh
  const w: Window = { pv: 0, load: 0, gridImport: 0, gridExport: 0, batteryCharge: 0, batteryDischarge: 0, peak: null };
  const s = h.series;
  h.xs.forEach((x, i) => {
    const pv = s['PV power']?.[i];
    const load = s['Load power']?.[i];
    const grid = s['Grid power']?.[i];
    const batt = s['Battery power']?.[i];
    if (typeof pv === 'number' && pv > 0) w.pv += pv * step;
    if (typeof load === 'number') {
      w.load += Math.max(0, load) * step;
      if (!w.peak || load > w.peak.w) w.peak = { w: load, at: x * 1000 };
    }
    if (typeof grid === 'number') grid > 0 ? (w.gridImport += grid * step) : (w.gridExport -= grid * step);
    if (typeof batt === 'number') batt > 0 ? (w.batteryCharge += batt * step) : (w.batteryDischarge -= batt * step);
  });
  return w;
}

const pct = (now: number, then: number) => (then > 0.05 ? Math.round(((now - then) / then) * 100) : null);
const cost = (e: { gridImport: number; gridExport: number }) =>
  e.gridImport * settings.get('tariff.import_price') - e.gridExport * settings.get('tariff.export_price');

function insights(t: Metrics, today: ReturnType<typeof energyTotals>, yesterday: Window, avg7pv: number | null) {
  const out: { icon: string; text: string; tone: 'ok' | 'info' | 'warn' }[] = [];
  const soc = typeof t['Battery state of charge'] === 'number' ? (t['Battery state of charge'] as number) : null;
  const batt = typeof t['Battery power'] === 'number' ? (t['Battery power'] as number) : null;
  const capacity = settings.get('bms.capacity');
  if (soc !== null && batt !== null && capacity > 0 && Math.abs(batt) > 50) {
    const hours = batt > 0 ? ((100 - soc) / 100) * capacity * 1000 / batt : ((soc - 10) / 100) * capacity * 1000 / -batt;
    if (hours > 0 && hours < 24) {
      const when = new Date(Date.now() + hours * 3.6e6).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
      out.push(batt > 0
        ? { icon: 'battery-charging', text: `Battery full around ${when} at the current charge rate.`, tone: 'ok' }
        : { icon: 'battery-low', text: `Battery reaches 10% around ${when} at the current load.`, tone: hours < 3 ? 'warn' : 'info' });
    }
  }
  if (today.load > 0.5) {
    const self = Math.round(Math.max(0, Math.min(1, 1 - today.gridImport / today.load)) * 100);
    out.push({ icon: 'leaf', text: `Solar and battery covered ${self}% of today's usage so far.`, tone: self >= 70 ? 'ok' : 'info' });
  }
  if (avg7pv !== null && avg7pv > 0.5 && today.pv > 0.2) {
    const d = pct(today.pv, avg7pv);
    if (d !== null && Math.abs(d) >= 10) {
      out.push({ icon: 'sun', text: `Solar is ${Math.abs(d)}% ${d > 0 ? 'above' : 'below'} the 7-day average at this time of day.`, tone: d > 0 ? 'ok' : 'info' });
    }
  }
  const cheapest = state.grid?.['Next cheapest hour'];
  if (cheapest) out.push({ icon: 'piggy-bank', text: `Cheapest grid hour coming up: ${cheapest}.`, tone: 'info' });
  if (yesterday.peak && today.load > 0) {
    const at = new Date(yesterday.peak.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
    out.push({ icon: 'activity', text: `Yesterday's peak load was ${(yesterday.peak.w / 1000).toFixed(1)} kW at ${at}.`, tone: 'info' });
  }
  return out.slice(0, 4);
}

function summary() {
  const zone = tz();
  const now = Date.now();
  const todayKey = dayKey(now, zone);
  const start = dayStart(todayKey, zone);
  const sinceMidnight = now - start;
  const yStart = dayStart(addDays(todayKey, -1), zone);
  const today = energyTotals('d');
  const todayWin = windowEnergy(start, now);
  const yesterday = windowEnergy(yStart, yStart + sinceMidnight);

  // PV over the previous 7 days up to the same time of day.
  let sum = 0;
  let n = 0;
  for (let d = 1; d <= 7; d++) {
    const s = dayStart(addDays(todayKey, -d), zone);
    const w = windowEnergy(s, s + sinceMidnight);
    if (w.load > 0.05 || w.pv > 0.05) {
      sum += w.pv;
      n++;
    }
  }
  const avg7pv = n ? sum / n : null;
  const hours = Math.max(sinceMidnight / 3.6e6, 1 / 60);
  const t = state.totals;
  const co2 = settings.get('site.co2_kg_per_kwh');
  const priced = settings.get('tariff.import_price') > 0 || settings.get('tariff.export_price') > 0;

  return {
    today,
    yesterdaySameTime: yesterday,
    change: {
      pv: pct(today.pv, yesterday.pv),
      load: pct(today.load, yesterday.load),
      gridImport: pct(today.gridImport, yesterday.gridImport),
      cost: priced ? pct(cost(today), cost(yesterday)) : null,
    },
    cost: priced ? { today: Math.round(cost(today) * 100) / 100, yesterday: Math.round(cost(yesterday) * 100) / 100, currency: settings.get('grid.currency') } : null,
    co2SavedKg: Math.round(today.pv * co2 * 10) / 10,
    selfSufficiency: today.load > 0.05 ? Math.round(Math.max(0, Math.min(1, 1 - today.gridImport / today.load)) * 100) : null,
    load: {
      avgKw: Math.round((todayWin.load / hours) * 100) / 100,
      peak: todayWin.peak ? { kw: Math.round(todayWin.peak.w / 10) / 100, at: todayWin.peak.at } : null,
    },
    insights: insights(t, today, yesterday, avg7pv),
  };
}

/** Usage chart data: hourly today, or daily for the last 7 / 30 days (kWh). */
function usage(range: string) {
  const zone = tz();
  const todayKey = dayKey(Date.now(), zone);
  if (range === 'day') {
    const start = dayStart(todayKey, zone);
    const labels: string[] = [];
    const load: number[] = [];
    const pv: number[] = [];
    for (let h = 0; h < 24; h++) {
      const from = start + h * 3.6e6;
      if (from > Date.now()) break;
      const w = windowEnergy(from, Math.min(from + 3.6e6, Date.now()));
      labels.push(`${String(h).padStart(2, '0')}:00`);
      load.push(Math.round(w.load * 100) / 100);
      pv.push(Math.round(w.pv * 100) / 100);
    }
    return { range, labels, load, pv };
  }
  const days = range === 'month' ? 30 : 7;
  const rows = readDays(addDays(todayKey, -(days - 1)), todayKey);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const labels: string[] = [];
  const load: number[] = [];
  const pv: number[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const key = addDays(todayKey, -d);
    const r = key === todayKey ? energyTotals('d') : byDay.get(key);
    labels.push(key.slice(5));
    load.push(Math.round((r?.load ?? 0) * 100) / 100);
    pv.push(Math.round((r?.pv ?? 0) * 100) / 100);
  }
  return { range, labels, load, pv };
}

export async function register(app: App) {
  app.get('/api/dashboard/summary', async () => {
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), value: summary() };
    return cache.value;
  });

  app.get<{ Querystring: { range?: string } }>('/api/dashboard/usage', async (req) =>
    usage(['day', 'week', 'month'].includes(req.query.range ?? '') ? req.query.range! : 'day'),
  );

  app.get('/api/weather', async () => {
    const w = weather.current();
    return {
      ...w,
      icon: w.weather ? weather.describe(w.weather.current.code, w.weather.current.isDay).icon : null,
      hourlyIcons: w.weather?.hourly.map((h) => weather.describe(h.code, true).icon) ?? [],
      dailyIcons: w.weather?.daily.map((d) => weather.describe(d.code, true).icon) ?? [],
    };
  });

  app.get<{ Querystring: { q?: string } }>('/api/weather/places', async (req, reply) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return [];
    try {
      return await weather.geocode(q);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/alerts', async () => alerts.list());
}
