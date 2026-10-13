/**
 * Emulated BMS: estimates state of charge by counting energy in and out of the battery
 * (from the inverter's battery power), optionally drifting toward a voltage-based estimate
 * when the current is low. For lead-acid banks and batteries without a data link.
 */
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import { state } from '../../core/state.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';

const LOW_CURRENT_A = 2;
const DRIFT_PER_POLL = 0.02;

class EmulatedBms implements BmsDriver {
  private soc = settings.get('bms.soc');
  private lastTs = 0;
  private lastSaved = 0;

  async connect() {}
  async close() {
    settings.set('bms.soc', Math.round(this.soc * 10) / 10);
  }

  async read(): Promise<Metrics[]> {
    // Sum across parallel inverters sharing the bank (state.totals would be circular: it prefers BMS values).
    const nums = (name: string) =>
      state.inverters.map((m) => m?.[name]).filter((v): v is number => typeof v === 'number');
    const powers = nums('Battery power');
    const voltages = nums('Battery voltage');
    const power = powers.length ? powers.reduce((a, b) => a + b, 0) : null;
    const voltage = voltages.length ? voltages.reduce((a, b) => a + b, 0) / voltages.length : null;
    const now = Date.now();
    if (power !== null && this.lastTs) {
      const capacityWh = settings.get('bms.capacity') * 1000;
      this.soc += ((power * (now - this.lastTs)) / 3.6e6 / capacityWh) * 100;
      const current = voltage ? power / voltage : 0;
      if (settings.get('bms.drift_soc') && voltage && Math.abs(current) < LOW_CURRENT_A) {
        this.soc += (voltageSoc(voltage) - this.soc) * DRIFT_PER_POLL;
      }
      this.soc = Math.min(100, Math.max(0, this.soc));
    }
    this.lastTs = now;
    if (now - this.lastSaved > 300_000) {
      settings.set('bms.soc', Math.round(this.soc * 10) / 10);
      this.lastSaved = now;
    }
    return [{
      'Device mode': 'Emulated',
      'State of charge': Math.round(this.soc),
      Power: power ?? 0,
      Voltage: voltage ?? 0,
      Current: voltage && power !== null ? Math.round((power / voltage) * 10) / 10 : 0,
      'Battery capacity': settings.get('bms.capacity'),
    }];
  }
}

/** Linear map through the configured 30% and 80% voltage points. */
function voltageSoc(v: number) {
  const v30 = settings.get('bms.voltage_30_soc');
  const v80 = settings.get('bms.voltage_80_soc');
  return 30 + ((v - v30) / (v80 - v30)) * 50;
}

export const emulatedBms: BmsDriverDescriptor = {
  id: 'emulated',
  name: 'Emulated BMS',
  transport: 'none',
  create: () => new EmulatedBms(),
};
