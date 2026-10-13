/**
 * Simulated battery: two 16-cell LiFePO4 packs (51.2 V, 100 Ah each) for demos and UI work.
 *
 * Bank power follows the inverters' "Battery power" (summed across parallel inverters; not
 * state.totals, which would be circular because the totals prefer BMS pack power) and is
 * split unevenly between the packs. SOC is coulomb-counted per pack and nudged toward the
 * inverter's own SOC so the two views agree. Without inverter data, a slow day-shaped
 * charge/discharge cycle is generated.
 */
import type { Metrics } from '../../core/metrics.ts';
import { state } from '../../core/state.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';
import { packMetrics } from './pack.ts';

const CELLS = 16;
const CAPACITY_AH = 100;
const PACKS = [
  { share: 0.52, cellOffsets: offsets(1), soh: 98, cycles: 412, serial: 'SIM16P1A0001', tempBias: 0.4, socBias: 0.6 },
  { share: 0.48, cellOffsets: offsets(2), soh: 96, cycles: 437, serial: 'SIM16P1A0002', tempBias: -0.3, socBias: -0.6 },
];
const INTERNAL_RESISTANCE_OHM = 0.012;

/** Deterministic small per-cell offsets (±12 mV) so cell spreads look real but stable. */
function offsets(seed: number) {
  return Array.from({ length: CELLS }, (_, i) => Math.round(Math.sin(seed * 12.9898 + i * 78.233) * 12) / 1000);
}

/** LiFePO4 open-circuit cell voltage by SOC: steep ends, flat middle. */
export function lfpCellVoltage(soc: number) {
  const pts: [number, number][] = [
    [0, 2.8], [5, 3.0], [10, 3.18], [20, 3.24], [40, 3.27], [60, 3.29], [80, 3.32], [90, 3.34], [97, 3.4], [100, 3.5],
  ];
  const s = Math.min(100, Math.max(0, soc));
  for (let i = 1; i < pts.length; i++) {
    const [s1, v1] = pts[i];
    const [s0, v0] = pts[i - 1];
    if (s <= s1) return v0 + ((s - s0) / (s1 - s0)) * (v1 - v0);
  }
  return 3.5;
}

export interface SimSource {
  /** Bank power, W (+ charging), or null when no inverter data. */
  power: number | null;
  /** Inverter-reported SOC, if any. */
  soc: number | null;
}

/** Reads the inverters directly (sum of Battery power, average SOC). */
export function inverterSource(): SimSource {
  const nums = (name: string) =>
    state.inverters.map((m) => m?.[name]).filter((v): v is number => typeof v === 'number');
  const p = nums('Battery power');
  const s = nums('Battery state of charge');
  return {
    power: p.length ? p.reduce((a, b) => a + b, 0) : null,
    soc: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
  };
}

/** Day-shaped stand-in when there's no inverter: charge around midday, discharge evenings. */
function syntheticPower(now: number) {
  const d = new Date(now);
  const h = d.getHours() + d.getMinutes() / 60;
  return Math.round(Math.sin(((h - 7) / 24) * 2 * Math.PI) * 1800);
}

export class SimulatedBms implements BmsDriver {
  private socs: number[] | null = null;
  private last = 0;
  private temps = PACKS.map(() => 24);
  private source: () => SimSource;
  private now: () => number;

  constructor(opts: { source?: () => SimSource; now?: () => number } = {}) {
    this.source = opts.source ?? inverterSource;
    this.now = opts.now ?? Date.now;
  }

  async connect() {}
  async close() {}

  async read(): Promise<Metrics[]> {
    const now = this.now();
    const src = this.source();
    const bankPower = src.power ?? syntheticPower(now);
    this.socs ??= PACKS.map((p) => Math.min(100, Math.max(0, (src.soc ?? 55) + p.socBias)));
    const dtH = this.last ? Math.min(60, (now - this.last) / 1000) / 3600 : 0;
    this.last = now;

    return PACKS.map((p, i) => {
      const socs = this.socs!;
      const ocv = lfpCellVoltage(socs[i]) * CELLS;
      const power = bankPower * p.share;
      const estimate = power / ocv;
      socs[i] += ((estimate * dtH) / (CAPACITY_AH * (p.soh / 100))) * 100;
      if (src.soc !== null) socs[i] += (src.soc + p.socBias - socs[i]) * 0.02; // stay near the inverter's view
      socs[i] = Math.min(100, Math.max(0, socs[i]));

      const sag = estimate * INTERNAL_RESISTANCE_OHM;
      const cells = p.cellOffsets.map((o) => lfpCellVoltage(socs[i]) + o + sag / CELLS);
      const voltage = cells.reduce((a, b) => a + b, 0);
      const current = power / voltage; // terminal values, so Voltage × Current = Power
      // Temperature eases toward ambient + I²R heating.
      const target = 22 + p.tempBias + Math.min(15, (current * current) / 250);
      this.temps[i] += (target - this.temps[i]) * Math.min(1, dtH * 60);
      const t = this.temps[i];
      const fullAh = CAPACITY_AH * (p.soh / 100);
      return packMetrics({
        model: 'SIM-LFP16-100',
        serial: p.serial,
        firmware: '1.2.7',
        soc: socs[i],
        soh: p.soh,
        voltage,
        current,
        temperature: t,
        temperatureMos: t + 3 + Math.abs(current) / 20,
        temperatures: [t - 0.3, t + 0.2, t + 0.5, t - 0.1],
        cells,
        cycles: p.cycles,
        remainingAh: (fullAh * socs[i]) / 100,
        fullAh,
        designAh: CAPACITY_AH,
        maxChargeCurrent: socs[i] > 97 ? 10 : 100,
        maxDischargeCurrent: socs[i] < 5 ? 10 : 100,
        alarms: socs[i] < 5 ? ['SOC low'] : [],
      });
    });
  }
}

export const simulatedBms: BmsDriverDescriptor = {
  id: 'simulated',
  name: 'Simulated battery (2 × 16-cell packs)',
  transport: 'none',
  create: () => new SimulatedBms(),
};
