/**
 * Sunrise and sunset from the site location, computed locally with NOAA's solar position
 * algorithm (the "General Solar Position Calculations" used by the NOAA solar calculator).
 * Accurate to about a minute for latitudes within ±72°; no network access needed.
 */
import { zonedTs } from './time.ts';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

interface SolarParams {
  /** Equation of time, minutes. */
  eqTime: number;
  /** Sun declination, degrees. */
  decl: number;
}

/** Solar declination and equation of time at a UTC timestamp. */
function solarParams(ts: number): SolarParams {
  const jd = ts / 86_400_000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;
  const l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c =
    Math.sin(rad(m)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * jc) +
    Math.sin(rad(3 * m)) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));
  const y = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(l0)) -
        2 * e * Math.sin(rad(m)) +
        4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) -
        0.5 * y * y * Math.sin(4 * rad(l0)) -
        1.25 * e * e * Math.sin(2 * rad(m)),
    );
  return { eqTime, decl };
}

/** Hour angle of sunrise in degrees, or null when the sun doesn't rise/set (polar day/night). */
function hourAngle(lat: number, decl: number): number | null {
  const cos = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) - Math.tan(rad(lat)) * Math.tan(rad(decl));
  if (cos < -1 || cos > 1) return null;
  return deg(Math.acos(cos));
}

/** One event (minutes after UTC midnight of the date), refined by recomputing at the event time. */
function eventMinutes(dayUtc: number, lat: number, lon: number, rising: boolean): number | null {
  let minutes = 720 - 4 * lon;
  for (let i = 0; i < 3; i++) {
    const p = solarParams(dayUtc + minutes * 60_000);
    const ha = hourAngle(lat, p.decl);
    if (ha === null) return null;
    minutes = 720 - 4 * (lon + (rising ? ha : -ha)) - p.eqTime;
  }
  return minutes;
}

export interface SunTimes {
  sunrise: number | null;
  sunset: number | null;
}

/**
 * Sunrise and sunset (UTC timestamps) on the local calendar date `ymd`. The date is anchored at
 * local noon in `tz`, so sites whose time zone doesn't match their longitude still get that day's events.
 */
export function sunTimes(ymd: string, lat: number, lon: number, tz = 'UTC'): SunTimes {
  const noonLocal = zonedTs(ymd, 720, tz);
  // The UTC midnight from which this longitude's solar noon lands closest to local clock noon.
  const solarNoonMinutes = 720 - 4 * lon;
  const dayUtc = Math.round((noonLocal - solarNoonMinutes * 60_000) / 86_400_000) * 86_400_000;
  const rise = eventMinutes(dayUtc, lat, lon, true);
  const set = eventMinutes(dayUtc, lat, lon, false);
  return {
    sunrise: rise === null ? null : dayUtc + Math.round(rise * 60_000),
    sunset: set === null ? null : dayUtc + Math.round(set * 60_000),
  };
}

/** Whether the sun is above the horizon (refraction-corrected) at `ts`. */
export function sunIsUp(ts: number, lat: number, lon: number): boolean {
  const p = solarParams(ts);
  const utcMinutes = (ts % 86_400_000) / 60_000;
  const trueSolarTime = (((utcMinutes + p.eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = trueSolarTime / 4 - 180;
  const cosZenith =
    Math.sin(rad(lat)) * Math.sin(rad(p.decl)) + Math.cos(rad(lat)) * Math.cos(rad(p.decl)) * Math.cos(rad(ha));
  const zenith = deg(Math.acos(Math.min(1, Math.max(-1, cosZenith))));
  return zenith < 90.833;
}
