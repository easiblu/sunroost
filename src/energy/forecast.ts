/**
 * Expected solar production from the weather forecast, in kWh and W.
 *
 * The weather service gives solar radiation on flat ground. How much a system makes from it depends
 * on its size, tilt, shading and losses, so Sunroost learns one factor, "kWh produced per kWh/m² of
 * sunshine" (effectively an effective array size in kW), from its own history:
 *
 *   factor = 80th percentile over recent days of  PV energy (kWh) / radiation (kWh/m²)
 *
 * The high percentile skips days the inverter curtailed (battery full, nothing to export). Until
 * enough days exist, the array size from settings is used (kWp × 0.8), else a rough estimate.
 */

export const MIN_LEARNED_DAYS = 5;
const PERFORMANCE_RATIO = 0.8;
/** Days with less sunshine than this (kWh/m²) say little about the system. */
const MIN_RADIATION_KWH_M2 = 1;

export type FactorSource = 'learned' | 'array' | 'estimate';

export interface Factor {
  /** kWh per kWh/m² (equivalently kW per kW/m²). */
  value: number;
  source: FactorSource;
  /** Days the learned factor is based on (0 unless learned). */
  days: number;
}

export interface DayPoint {
  date: string;
  /** Measured PV energy that day, kWh. */
  pvKwh: number;
  /** Radiation that day, MJ/m². */
  radiationMj: number;
}

const mjToKwh = (mj: number) => mj / 3.6;

function percentile(sorted: number[], p: number) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Learns the factor from past days; falls back to the array size, then to a rough estimate. */
export function factorFrom(history: DayPoint[], arrayKwp: number, roughKwp: number): Factor {
  const ratios = history
    .filter((d) => mjToKwh(d.radiationMj) >= MIN_RADIATION_KWH_M2 && d.pvKwh > 0.2)
    .map((d) => d.pvKwh / mjToKwh(d.radiationMj))
    .sort((a, b) => a - b);
  if (ratios.length >= MIN_LEARNED_DAYS) return { value: round(percentile(ratios, 0.8), 3), source: 'learned', days: ratios.length };
  if (arrayKwp > 0) return { value: round(arrayKwp * PERFORMANCE_RATIO, 3), source: 'array', days: 0 };
  return { value: round(roughKwp * PERFORMANCE_RATIO, 3), source: 'estimate', days: 0 };
}

export interface SolarForecast {
  factor: Factor;
  todayKwh: number | null;
  tomorrowKwh: number | null;
  /** From the current hour to midnight. */
  restOfTodayKwh: number | null;
  /** Expected power this hour, W. */
  nowW: number | null;
  /** Next 24 hours: expected power per hour, W. */
  hourly: { time: string; w: number }[];
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * `daily` starts today; `hourly` starts at the current hour (radiation in W/m², hourly averages).
 * `today` is the site's local date (YYYY-MM-DD).
 */
export function forecastFrom(
  factor: Factor,
  daily: { date: string; radiationMj: number }[],
  hourly: { time: string; radiation: number }[],
  today: string,
): SolarForecast {
  const day = (date: string) => {
    const d = daily.find((x) => x.date === date);
    return d && typeof d.radiationMj === 'number' ? round(mjToKwh(d.radiationMj) * factor.value) : null;
  };
  const tomorrow = daily.find((x) => x.date > today)?.date;
  const hours = hourly.map((h) => ({ time: h.time, w: Math.round((Math.max(0, h.radiation) / 1000) * factor.value * 1000) }));
  const rest = hours.filter((h) => h.time.slice(0, 10) === today);
  return {
    factor,
    todayKwh: day(today),
    tomorrowKwh: tomorrow ? day(tomorrow) : null,
    restOfTodayKwh: hours.length ? round(rest.reduce((s, h) => s + h.w, 0) / 1000) : null,
    nowW: hours[0]?.w ?? null,
    hourly: hours,
  };
}
