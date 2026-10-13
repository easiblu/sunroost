/**
 * Weather for the dashboard from Open-Meteo (free, no API key). Uses the site location set on the
 * Configuration page. Includes solar radiation so the dashboard can show tomorrow's solar outlook.
 */
import { logger } from '../core/log.ts';
import { settings } from '../core/settings.ts';

const log = logger('system');
const REFRESH_MS = 30 * 60_000;
const TIMEOUT_MS = 10_000;

export interface Weather {
  location: string;
  current: { temperature: number; code: number; isDay: boolean; text: string };
  hourly: { time: string; temperature: number; code: number; radiation: number }[];
  daily: { date: string; code: number; max: number; min: number; sunrise: string; sunset: string; radiationMj: number }[];
  /** Solar radiation of the past days (oldest first), for learning how much this system makes per unit of sunshine. */
  past: { date: string; radiationMj: number }[];
  updatedAt: number;
}

/** WMO weather interpretation codes → short text and an icon name (Lucide). */
export function describe(code: number, isDay = true): { text: string; icon: string } {
  if (code === 0) return { text: isDay ? 'Sunny' : 'Clear', icon: isDay ? 'sun' : 'moon' };
  if (code === 1) return { text: 'Mostly clear', icon: isDay ? 'sun' : 'moon' };
  if (code === 2) return { text: 'Partly cloudy', icon: isDay ? 'cloud-sun' : 'cloud-moon' };
  if (code === 3) return { text: 'Cloudy', icon: 'cloud' };
  if (code === 45 || code === 48) return { text: 'Fog', icon: 'cloud-fog' };
  if (code >= 51 && code <= 57) return { text: 'Drizzle', icon: 'cloud-drizzle' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { text: 'Rain', icon: 'cloud-rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { text: 'Snow', icon: 'cloud-snow' };
  if (code >= 95) return { text: 'Thunderstorm', icon: 'cloud-lightning' };
  return { text: 'Unknown', icon: 'cloud' };
}

let cache: Weather | null = null;
let lastError: string | null = null;
let timer: NodeJS.Timeout | null = null;

export function current() {
  const lat = settings.get('site.latitude');
  const lon = settings.get('site.longitude');
  return { configured: lat !== null && lon !== null, weather: cache, error: lastError };
}

export async function refresh(): Promise<void> {
  const lat = settings.get('site.latitude');
  const lon = settings.get('site.longitude');
  if (lat === null || lon === null) {
    cache = null;
    return;
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,is_day' +
    '&hourly=temperature_2m,weather_code,shortwave_radiation' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,shortwave_radiation_sum' +
    '&timezone=auto&forecast_days=3&past_days=14';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`);
    const j = (await res.json()) as any;
    const nowIdx = Math.max(0, (j.hourly.time as string[]).findIndex((t) => t >= j.current.time.slice(0, 13)));
    const today = String(j.current.time).slice(0, 10);
    cache = {
      location: settings.get('site.location_name'),
      current: {
        temperature: j.current.temperature_2m,
        code: j.current.weather_code,
        isDay: Boolean(j.current.is_day),
        text: describe(j.current.weather_code, Boolean(j.current.is_day)).text,
      },
      hourly: (j.hourly.time as string[]).slice(nowIdx, nowIdx + 24).map((time, i) => ({
        time,
        temperature: j.hourly.temperature_2m[nowIdx + i],
        code: j.hourly.weather_code[nowIdx + i],
        radiation: j.hourly.shortwave_radiation[nowIdx + i],
      })),
      // Daily rows start 14 days back; `daily` stays today onwards (the dashboard reads daily[0] as today).
      daily: (j.daily.time as string[]).map((date, i) => ({
        date,
        code: j.daily.weather_code[i],
        max: j.daily.temperature_2m_max[i],
        min: j.daily.temperature_2m_min[i],
        sunrise: j.daily.sunrise[i],
        sunset: j.daily.sunset[i],
        radiationMj: j.daily.shortwave_radiation_sum[i],
      })).filter((d) => d.date >= today),
      past: (j.daily.time as string[])
        .map((date, i) => ({ date, radiationMj: j.daily.shortwave_radiation_sum[i] as number }))
        .filter((d) => d.date < today && typeof d.radiationMj === 'number'),
      updatedAt: Date.now(),
    };
    if (lastError) log.info('Weather updates restored.');
    lastError = null;
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? 'Weather service timed out' : (err as Error).message;
    if (msg !== lastError) log.warn(`Weather: ${msg}`);
    lastError = msg;
  }
}

/** Place search for the location picker. */
export async function geocode(query: string) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status})`);
  const j = (await res.json()) as { results?: any[] };
  return (j.results ?? []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: Math.round(r.latitude * 1000) / 1000,
    longitude: Math.round(r.longitude * 1000) / 1000,
  }));
}

function onSettings(key: string) {
  if (key === 'site.latitude' || key === 'site.longitude') void refresh();
}

export async function start() {
  settings.on('change', onSettings);
  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
}

export async function stop() {
  settings.off('change', onSettings);
  if (timer) clearInterval(timer);
}
