/**
 * MidNite Solar inverters.
 *
 * MN15-12KW-AIO "The One" (model `aio`): Modbus RTU on the inverter's RS485 port (RJ45, pin 1 = A,
 * pin 2 = B, 3/6/7/8 = GND; 9600 8N1, address 1), Modbus TCP ("host:port", an RS485 gateway) or a
 * Solarman logger ("solarman://ip/serial"). The AIO is a Senergy SE 11.4KHB-UL OEM build and speaks
 * the Senergy holding-register map (see registers.ts). Read-only until a real unit has been checked.
 *
 * Rosie (MNROSIE7048M / 7048RE) is not supported: it only talks MidNite's own CAN protocol (29-bit
 * ids, register << 18 | device type << 11 | index << 7 | bus id, broadcast), which MidNite has not
 * published. Only a handful of reverse-engineered registers are known and the bitrate is unconfirmed.
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { MidniteDriver, MODELS } from './driver.ts';
import { IDENT_SPAN, MODEL_REG, SERIAL_REG } from './registers.ts';

export { decodeInfo, decodeLive, derive, MidniteDriver, midniteModel, MODELS } from './driver.ts';

function text(regs: number[]) {
  return regsToAscii(regs).replace(/[\xff]/g, '').trim();
}

/** A model string that names a MidNite unit (plain Senergy / Sungold / Duracell units are left to the Senergy driver). */
export function isMidniteModel(name: string) {
  return /MN15|MIDNITE|\bAIO\b/i.test(name);
}

export const midnite: InverterDriverDescriptor = {
  id: 'midnite',
  name: 'MidNite Solar (MN15-12KW-AIO)',
  manufacturer: 'MidNite Solar',
  transport: 'serial',
  defaultBaudRate: 9600,
  detectBaudRates: [9600],
  defaultAddress: 1,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new MidniteDriver(opts),
  /**
   * Two reads: model + serial (holding 0x1A00–0x1A18, ASCII) and the battery block (0x2000–0x2006).
   * Needs a MidNite model string (MN15 / MidNite / AIO), a printable serial, SOC ≤ 100 % and a
   * 9–70 V battery. Other brands keep nothing at 0x1A00; a Senergy-branded unit with the same map
   * fails the model check and is left to the Senergy driver.
   */
  async detect(conn) {
    try {
      const ident = await conn.read(3, IDENT_SPAN[0], IDENT_SPAN[1]);
      const model = text(ident.slice(0, 8));
      const serial = text(ident.slice(SERIAL_REG - MODEL_REG, SERIAL_REG - MODEL_REG + 8));
      if (!plausibleId(model, 4) || !isMidniteModel(model)) return null;
      if (!plausibleId(serial, 6)) return null;
      const batt = await conn.read(3, 0x2000, 7);
      const soc = batt[0];
      const vraw = batt[6];
      if (soc > 100 || vraw < 90 || vraw > 700) return null;
      return { modelId: 'aio', evidence: `model ${model}, serial ${serial}, battery ${(vraw / 10).toFixed(1)} V ${soc}%` };
    } catch {
      return null;
    }
  },
};

export const midniteDrivers: InverterDriverDescriptor[] = [midnite];

export const MIDNITE_MODELS = MODELS.map((m) => m.id);
