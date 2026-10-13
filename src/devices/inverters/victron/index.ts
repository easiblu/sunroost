/**
 * Victron MultiPlus-II / EasySolar-II / Quattro (VE.Bus inverter/chargers) read through a GX device
 * (Cerbo GX, Venus GX, Ekrano, or the GX built into EasySolar-II) over Modbus TCP: "host:502" with
 * Settings → Services → Modbus TCP enabled on the GX. Unit 100 is the system service (default
 * address); the VE.Bus service is found on 227, 246 or 242. VE.Bus over MK3-USB is not supported.
 * All registers are holding registers (function 3). The driver is read-only until checked on a unit.
 */
import { plausibleId } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { MODELS, VictronDriver } from './driver.ts';
import { decodeSerial, image, SYSTEM_UNIT } from './registers.ts';

export { MODEL_NAME, MODELS, VictronDriver } from './driver.ts';
export { decodeLive, decodeSerial, phaseCount } from './registers.ts';
export { decodeSettings, VICTRON_SETTINGS } from './settings.ts';

export const victron: InverterDriverDescriptor = {
  id: 'victron',
  name: 'Victron (GX device, Modbus TCP)',
  manufacturer: 'Victron Energy',
  transport: 'tcp',
  defaultAddress: SYSTEM_UNIT,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new VictronDriver(opts),
  /**
   * Two reads on unit 100: serial / VRM id (800–805, ASCII) and battery 840–843. Needs a printable
   * serial AND a sane battery (9–70 V, SOC ≤ 100 %). Other brands keep nothing ASCII at 800.
   */
  async detect(conn) {
    let serial: string;
    let batt: number[];
    try {
      serial = decodeSerial(image(800, await conn.read(3, 800, 6, SYSTEM_UNIT)));
      if (!plausibleId(serial, 6)) return null;
      batt = await conn.read(3, 840, 4, SYSTEM_UNIT);
    } catch {
      return null;
    }
    const [vraw, , , soc] = batt;
    if (vraw < 90 || vraw > 700 || soc > 100) return null;
    return { modelId: 'gx', evidence: `GX serial ${serial}, battery ${(vraw / 10).toFixed(1)} V ${soc}%`, address: SYSTEM_UNIT };
  },
};

export const victronDrivers: InverterDriverDescriptor[] = [victron];
