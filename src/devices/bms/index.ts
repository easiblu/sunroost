/**
 * Serial battery BMS drivers (one port per BMS / Pylontech stack) plus the simulated bank.
 * Each descriptor is wrapped so the "Invert current" advanced setting (bms.invert_current)
 * flips Current/Power (and the derived Device mode) for every driver alike.
 */
import type { Metrics } from '../../core/metrics.ts';
import { settings } from '../../core/settings.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';
import { canBmsDriver } from './can/index.ts';
import { daly } from './daly.ts';
import { jbd } from './jbd.ts';
import { jk } from './jk.ts';
import { modbusBmsDriver } from './modbus-bms.ts';
import { naradaDriver } from './narada.ts';
import { deviceMode } from './pack.ts';
import { pylontechConsoleDriver } from './pylontech-console.ts';
import { serialDriver } from './serial-ascii.ts';
import { simulatedBms } from './simulated.ts';
import { veDirectDriver } from './ve-direct.ts';
import { voltronicLibDriver } from './voltronic-lib.ts';

/** Negates Current and Power of each pack (holes in a sparse array are preserved). */
export function invertPacks(packs: Metrics[]): Metrics[] {
  const out: Metrics[] = [];
  packs.forEach((p, i) => {
    const m = { ...p };
    if (typeof m.Current === 'number') m.Current = -m.Current || 0;
    if (typeof m.Power === 'number') m.Power = -m.Power || 0;
    if ('Device mode' in m && typeof m.Current === 'number') m['Device mode'] = deviceMode(m.Current);
    out[i] = m;
  });
  return out;
}

function withInvert(desc: BmsDriverDescriptor): BmsDriverDescriptor {
  return {
    ...desc,
    create(opts) {
      const inner = desc.create(opts);
      const driver: BmsDriver = {
        connect: () => inner.connect(),
        close: () => inner.close(),
        read: async () => {
          const packs = await inner.read();
          return settings.get('bms.invert_current') ? invertPacks(packs) : packs;
        },
      };
      return driver;
    },
  };
}

/** Battery drivers in dropdown order; the simulated bank is for demos. */
export const serialBmsDrivers: BmsDriverDescriptor[] = [
  daly, jbd, jk, modbusBmsDriver, naradaDriver, pylontechConsoleDriver, serialDriver,
  voltronicLibDriver, veDirectDriver, canBmsDriver, simulatedBms,
].map(withInvert);
