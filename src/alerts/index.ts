/**
 * Alerts derived from the live state: battery low/full, grid outage, inverter fault, high
 * temperature, lost device connections and upcoming planned outages. Each condition uses
 * hysteresis so an alert doesn't flicker on and off around its threshold.
 */
import { logger } from '../core/log.ts';
import type { Metrics } from '../core/metrics.ts';
import { state, type Snapshot } from '../core/state.ts';

const log = logger('alerts');
const MAX_HISTORY = 50;

export type AlertLevel = 'info' | 'warn' | 'bad';

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  since: number;
  resolvedAt?: number;
}

const active = new Map<string, Alert>();
const history: Alert[] = [];
let gridSeen = false;

const num = (m: Metrics, k: string) => (typeof m[k] === 'number' ? (m[k] as number) : null);

function raise(id: string, level: AlertLevel, title: string, detail: string) {
  const existing = active.get(id);
  if (existing) {
    existing.detail = detail;
    existing.level = level;
    existing.title = title;
    return;
  }
  active.set(id, { id, level, title, detail, since: Date.now() });
  (level === 'info' ? log.info : log.warn)(`${title}: ${detail}`);
}

function clear(id: string) {
  const a = active.get(id);
  if (!a) return;
  active.delete(id);
  history.unshift({ ...a, resolvedAt: Date.now() });
  history.length = Math.min(history.length, MAX_HISTORY);
}

/** Exported for tests: evaluates every rule against one snapshot. */
export function evaluate(s: Snapshot) {
  const t = s.totals ?? {};

  // Device links
  if (s.status.inverter.name === 'error') raise('inverter-link', 'bad', 'Inverter connection lost', s.status.inverter.message);
  else if (s.status.inverter.name === 'connected') clear('inverter-link');
  if (s.status.battery.name === 'error') raise('battery-link', 'warn', 'Battery connection lost', s.status.battery.message);
  else if (s.status.battery.name === 'connected' || s.status.battery.name === 'disconnected') clear('battery-link');

  // Battery state of charge (hysteresis 5 %)
  const soc = num(t, 'Battery state of charge');
  if (soc !== null) {
    if (soc <= 10) raise('battery-low', 'bad', 'Battery critically low', `State of charge ${Math.round(soc)}%`);
    else if (soc <= 20) raise('battery-low', 'warn', 'Battery charge low', `State of charge ${Math.round(soc)}%`);
    else if (soc >= 25) clear('battery-low');
    if (soc >= 99) raise('battery-full', 'info', 'Battery full', 'Fully charged');
    else if (soc <= 95) clear('battery-full');
  }

  // Grid outage: only once the grid has been seen, so off-grid sites never alert.
  const gridV = num(t, 'Grid voltage');
  if (gridV !== null) {
    if (gridV >= 100) gridSeen = true;
    if (gridSeen && gridV < 100) raise('grid-outage', 'bad', 'Grid outage', 'No grid voltage at the inverter');
    else if (gridV >= 180) clear('grid-outage');
  }

  // Inverter temperature (hysteresis 5 °C)
  const temp = num(t, 'Temperature');
  if (temp !== null) {
    if (temp >= 70) raise('inverter-hot', 'warn', 'Inverter running hot', `${Math.round(temp)} °C`);
    else if (temp <= 65) clear('inverter-hot');
  }

  // Fault codes reported by the inverter(s)
  s.inverters.forEach((inv, i) => {
    const fault = inv?.['Fault code'];
    const id = `fault-${i}`;
    if (fault && !['none', '0', 'ok', 'no fault'].includes(String(fault).toLowerCase())) {
      raise(id, 'bad', s.inverters.length > 1 ? `Inverter ${i + 1} fault` : 'Inverter fault', String(fault));
    } else clear(id);
  });

  // Planned grid outage (Eskom) within the next two hours
  const outageIn = s.grid?.['Next planned outage in'];
  const outageStart = s.grid?.['Next planned outage start'];
  const minutes = typeof outageIn === 'string' ? parseMinutes(outageIn) : null;
  if (outageStart && minutes !== null && minutes <= 120) {
    raise('planned-outage', 'warn', 'Planned grid outage soon', `Starts ${outageStart} (in ${outageIn})`);
  } else clear('planned-outage');
}

/** "1h 20m" / "45m" / "2 hours" → minutes. */
function parseMinutes(text: string): number | null {
  const h = /(\d+)\s*h/.exec(text)?.[1];
  const m = /(\d+)\s*m/.exec(text)?.[1];
  if (h === undefined && m === undefined) return null;
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

const LEVEL_ORDER: Record<AlertLevel, number> = { bad: 0, warn: 1, info: 2 };

export function list() {
  return {
    active: [...active.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.since - a.since),
    recent: history.slice(0, 20),
  };
}

/** For tests. */
export function reset() {
  active.clear();
  history.length = 0;
  gridSeen = false;
}

export async function start() {
  state.on('refresh', evaluate);
}

export async function stop() {
  state.off('refresh', evaluate);
}
