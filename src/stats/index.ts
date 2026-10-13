/**
 * stats subsystem: records history samples and integrates energy totals from live state.
 *  - every 10 s: one history row for the combined system (+ one per inverter when parallel)
 *  - every 30 s: buffered rows are written in one transaction
 *  - every minute: today's totals are saved, the 5-minute rollup is advanced, midnight rollover
 *  - every hour: raw rows past the retention period are pruned
 */
import { logger } from '../core/log.ts';
import { state, type Snapshot } from '../core/state.ts';
import {
  ensureHistoryTables, flushPending, makeSamples, prune, queueSamples, rollup, SAMPLE_SECONDS,
} from './history.ts';
import { applyStagedRestore } from './storage.ts';
import { ensureTotalsTables, tracker } from './totals.ts';

const l = logger('db');
const FLUSH_MS = 30_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Readings older than this are not recorded (the device stopped reporting). */
const STALE_MS = 30_000;

let lastSlot = 0;
let lastEnergyTs = 0;
const timers: NodeJS.Timeout[] = [];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function onRefresh(snap: Snapshot) {
  const now = Date.now();
  if (!snap.ts || now - snap.ts > STALE_MS) return;
  const t = snap.totals;

  // Energy: integrate each distinct reading.
  if (snap.ts !== lastEnergyTs) {
    lastEnergyTs = snap.ts;
    const pv = num(t['PV power']);
    const load = num(t['Load power']);
    const grid = num(t['Grid power']);
    const battery = num(t['Battery power']);
    if (pv !== null || load !== null || grid !== null || battery !== null) {
      tracker.sample({ t: snap.ts, pv, load, grid, battery });
    }
  }

  // History: one sample per 10 s slot, timestamped at the slot start.
  const slot = Math.floor(now / 1000 / SAMPLE_SECONDS) * SAMPLE_SECONDS;
  if (slot > lastSlot) {
    lastSlot = slot;
    queueSamples(makeSamples(slot, t, snap.inverters));
  }
}

function safely(name: string, fn: () => void) {
  return () => {
    try {
      fn();
    } catch (err) {
      l.error(`${name} failed: ${(err as Error).message}`);
    }
  };
}

const minutely = safely('Saving totals', () => {
  flushPending();
  tracker.checkRollover();
  tracker.save();
  // Leave a minute for late samples of the bucket to be flushed.
  rollup(Math.floor(Date.now() / 1000) - 60);
});

export async function start() {
  applyStagedRestore();
  ensureHistoryTables();
  ensureTotalsTables();
  tracker.start();
  state.on('refresh', onRefresh);
  timers.push(setInterval(safely('Writing history', flushPending), FLUSH_MS));
  timers.push(setInterval(minutely, MINUTE_MS));
  timers.push(
    setInterval(
      safely('Pruning history', () => {
        const n = prune();
        if (n > 0) l.info(`Pruned ${n} history rows older than the retention period.`);
      }),
      HOUR_MS,
    ),
  );
  for (const t of timers) t.unref();
  // Catch up on rollup/pruning left over from the previous run.
  setTimeout(safely('Catching up rollup', () => (minutely(), prune())), 5_000).unref();
}

export async function stop() {
  state.off('refresh', onRefresh);
  for (const t of timers.splice(0)) clearInterval(t);
  try {
    flushPending();
    tracker.stop();
  } catch (err) {
    l.error(`Saving history on shutdown failed: ${(err as Error).message}`);
  }
}
