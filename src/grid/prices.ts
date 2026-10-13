/**
 * Day-ahead price math, kept free of I/O so it can be unit tested.
 *
 * Raw prices are stored as the exchange publishes them (EUR/MWh per slot, 15 or 60 minutes).
 * They are converted to <currency>/kWh × multiplier when read, so changing the currency or
 * multiplier never needs a refetch.
 */

/** One price slot as published: start/end in ms since epoch, price in EUR/MWh. */
export interface RawSlot {
  start: number;
  end: number;
  price: number;
}

/** A converted slot: price in <currency>/kWh and its deviation from that day's average. */
export interface PriceSlot {
  start: number;
  end: number;
  price: number;
  premium: number;
}

/**
 * Parses an Energy-Charts `/price` response: `{ unix_seconds: number[], price: (number|null)[], unit }`.
 * Each slot ends where the next begins; the last one gets the median slot length.
 */
export function parseEnergyCharts(json: unknown): RawSlot[] {
  const j = json as { unix_seconds?: unknown; price?: unknown; unit?: unknown };
  if (!j || !Array.isArray(j.unix_seconds) || !Array.isArray(j.price)) {
    throw new Error('Unexpected response from Energy-Charts');
  }
  if (typeof j.unit === 'string' && !/EUR\s*\/\s*MWh/i.test(j.unit)) {
    throw new Error(`Unexpected price unit "${j.unit}"`);
  }
  const ts = j.unix_seconds as number[];
  const prices = j.price as (number | null)[];
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((g) => g > 0).sort((a, b) => a - b);
  const slotS = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600;
  const out: RawSlot[] = [];
  for (let i = 0; i < ts.length; i++) {
    const p = prices[i];
    if (typeof p !== 'number' || !Number.isFinite(p) || typeof ts[i] !== 'number') continue;
    const next = ts[i + 1];
    const len = typeof next === 'number' && next > ts[i] && next - ts[i] <= slotS * 2 ? next - ts[i] : slotS;
    out.push({ start: ts[i] * 1000, end: (ts[i] + len) * 1000, price: p });
  }
  return out;
}

/** EUR/MWh → currency/kWh: ÷1000, × exchange rate (currency per EUR), × the user's multiplier. */
export function convertPrice(eurPerMwh: number, rate = 1, multiplier = 1) {
  return (eurPerMwh / 1000) * rate * multiplier;
}

/** "YYYY-MM-DD" of a timestamp in a time zone (falls back to UTC for an unknown zone). */
export function dayKey(ts: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/**
 * Converts raw slots and adds the premium: price minus the time-weighted average price of the
 * same calendar day (in `timeZone`). A negative premium means cheaper than average.
 */
export function withPremium(raw: RawSlot[], opts: { rate?: number; multiplier?: number; timeZone?: string } = {}): PriceSlot[] {
  const tz = opts.timeZone ?? 'UTC';
  const converted = raw
    .map((s) => ({ start: s.start, end: s.end, price: convertPrice(s.price, opts.rate, opts.multiplier) }))
    .sort((a, b) => a.start - b.start);
  const days = new Map<string, { sum: number; weight: number }>();
  for (const s of converted) {
    const d = days.get(dayKey(s.start, tz)) ?? { sum: 0, weight: 0 };
    const w = Math.max(1, s.end - s.start);
    d.sum += s.price * w;
    d.weight += w;
    days.set(dayKey(s.start, tz), d);
  }
  return converted.map((s) => {
    const d = days.get(dayKey(s.start, tz))!;
    return { ...s, premium: s.price - d.sum / d.weight };
  });
}

/** Averages sub-hourly slots into whole hours (premium averaged too). Hourly input passes through. */
export function toHourly(slots: PriceSlot[]): PriceSlot[] {
  const buckets = new Map<number, { price: number; premium: number; weight: number }>();
  for (const s of slots) {
    const hour = Math.floor(s.start / 3_600_000) * 3_600_000;
    const b = buckets.get(hour) ?? { price: 0, premium: 0, weight: 0 };
    const w = Math.max(1, s.end - s.start);
    b.price += s.price * w;
    b.premium += s.premium * w;
    b.weight += w;
    buckets.set(hour, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, b]) => ({ start, end: start + 3_600_000, price: b.price / b.weight, premium: b.premium / b.weight }));
}

/** The slot containing `ts`, or null. */
export function slotAt<T extends { start: number; end: number }>(slots: T[], ts: number): T | null {
  return slots.find((s) => s.start <= ts && ts < s.end) ?? null;
}

/** The cheapest whole hour that hasn't finished yet (the current hour counts). */
export function nextCheapestHour(slots: PriceSlot[], now: number): PriceSlot | null {
  let best: PriceSlot | null = null;
  for (const h of toHourly(slots)) {
    if (h.end <= now) continue;
    if (!best || h.price < best.price) best = h;
  }
  return best;
}

/** Rounds a price for display/MQTT: 4 decimals below 1, else 3. */
export function roundPrice(v: number) {
  const digits = Math.abs(v) < 1 ? 4 : 3;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Bidding zones served by the free Energy-Charts API (https://api.energy-charts.info). */
export const ENERGY_CHARTS_AREAS: { id: string; name: string }[] = [
  { id: 'AT', name: 'Austria' },
  { id: 'BE', name: 'Belgium' },
  { id: 'BG', name: 'Bulgaria' },
  { id: 'CH', name: 'Switzerland' },
  { id: 'CZ', name: 'Czech Republic' },
  { id: 'DE-LU', name: 'Germany / Luxembourg' },
  { id: 'DK1', name: 'Denmark West (DK1)' },
  { id: 'DK2', name: 'Denmark East (DK2)' },
  { id: 'EE', name: 'Estonia' },
  { id: 'ES', name: 'Spain' },
  { id: 'FI', name: 'Finland' },
  { id: 'FR', name: 'France' },
  { id: 'GR', name: 'Greece' },
  { id: 'HR', name: 'Croatia' },
  { id: 'HU', name: 'Hungary' },
  { id: 'IT-North', name: 'Italy North' },
  { id: 'IT-Centre-North', name: 'Italy Centre-North' },
  { id: 'IT-Centre-South', name: 'Italy Centre-South' },
  { id: 'IT-South', name: 'Italy South' },
  { id: 'IT-Calabria', name: 'Italy Calabria' },
  { id: 'IT-Sardinia', name: 'Italy Sardinia' },
  { id: 'IT-Sicily', name: 'Italy Sicily' },
  { id: 'LT', name: 'Lithuania' },
  { id: 'LV', name: 'Latvia' },
  { id: 'ME', name: 'Montenegro' },
  { id: 'NL', name: 'Netherlands' },
  { id: 'NO1', name: 'Norway Oslo (NO1)' },
  { id: 'NO2', name: 'Norway Kristiansand (NO2)' },
  { id: 'NO3', name: 'Norway Trondheim (NO3)' },
  { id: 'NO4', name: 'Norway Tromsø (NO4)' },
  { id: 'NO5', name: 'Norway Bergen (NO5)' },
  { id: 'PL', name: 'Poland' },
  { id: 'PT', name: 'Portugal' },
  { id: 'RO', name: 'Romania' },
  { id: 'RS', name: 'Serbia' },
  { id: 'SE1', name: 'Sweden Luleå (SE1)' },
  { id: 'SE2', name: 'Sweden Sundsvall (SE2)' },
  { id: 'SE3', name: 'Sweden Stockholm (SE3)' },
  { id: 'SE4', name: 'Sweden Malmö (SE4)' },
  { id: 'SI', name: 'Slovenia' },
  { id: 'SK', name: 'Slovakia' },
];

/** Currencies offered for conversion. Rates other than EUR come from the ECB reference rates. */
export const CURRENCIES = ['EUR', 'BGN', 'CHF', 'CZK', 'DKK', 'GBP', 'HUF', 'NOK', 'PLN', 'RON', 'SEK', 'USD'];

/** Parses the ECB daily reference-rate XML into { USD: 1.08, … } (currency units per EUR). */
export function parseEcbRates(xml: string): Record<string, number> {
  const out: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) out[m[1]] = Number(m[2]);
  return out;
}
