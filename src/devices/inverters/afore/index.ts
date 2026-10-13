/**
 * Afore hybrid inverters over Modbus RTU (RS485, 9600 8N1, address 1), Modbus TCP ("host:port", an
 * RS485 gateway) or the Afore WiFi stick, which is a Solarman-type logger ("solarman://ip/serial").
 * Live data are input registers (function 4), settings holding registers (function 3). Read-only
 * until a real unit has been checked. Also sold rebadged (e.g. Bluesun BSE…H).
 *
 * Models:
 *   hybrid  — AF-SL single-phase hybrid (AF3.6K-SL, AF5K-SL, AF6K-SL) (default)
 *   hybrid3 — AF-TH three-phase hybrid (AF3K-TH … AF10K-TH)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { AforeDriver, MODELS, modelFromType } from './driver.ts';
import { INFO_SPAN, SERIAL_REG, TYPE_REG } from './registers.ts';

export { aforeModel, AforeDriver, decodeFaults, decodeInfo, decodeLive, derive, MODELS, modelFromType } from './driver.ts';

export const afore: InverterDriverDescriptor = {
  id: 'afore',
  name: 'Afore (AF-SL / AF-TH hybrid)',
  manufacturer: 'Afore',
  transport: 'serial',
  defaultBaudRate: 9600,
  defaultAddress: 1,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [
    { id: '4', name: 'Input register' },
    { id: '3', name: 'Holding register' },
  ],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new AforeDriver(opts),
  /**
   * One read: the info block (input 0–53). Accepts only a hybrid type code at input 6 (200–399),
   * a rated power of 1–100 kW at input 7–8 and a printable 16-char serial at input 41–48. Other
   * brands' identity data live in holding registers or at input ≥ 4989, so this block is blank on
   * them; a Growatt input block has no ASCII at 41–48.
   */
  async detect(conn) {
    const regs = await conn.read(4, INFO_SPAN[0], INFO_SPAN[1]);
    if (regs.length < INFO_SPAN[1]) return null;
    const type = regs[TYPE_REG];
    const modelId = modelFromType(type);
    if (!modelId) return null;
    const rated = regs[7] * 0x10000 + regs[8];
    if (rated < 1000 || rated > 100000) return null;
    const serial = regsToAscii(regs.slice(SERIAL_REG, SERIAL_REG + 8));
    if (!plausibleId(serial, 6)) return null;
    return { modelId, evidence: `type ${type}, rated ${rated} W, serial ${serial}` };
  },
};

export const aforeDrivers: InverterDriverDescriptor[] = [afore];

export const AFORE_MODELS = MODELS.map((m) => m.id);
