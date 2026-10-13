/**
 * Sigenergy SigenStor EC hybrids (single-phase "SP" and three-phase "TP") over Modbus TCP
 * ("host:port", port 502 on the SigenStor / Sigen gateway, Modbus TCP server enabled in the app).
 *
 * Two unit ids on one connection: the plant (system totals) on 247 — the default address — and the
 * hybrid inverter on 1. Every live register is an input register (function 4); settings are
 * holding registers (function 3) on 247. Read-only until checked on a real unit.
 *
 * Models:
 *   hybrid  — single-phase SigenStor EC … SP (default)
 *   hybrid3 — three-phase SigenStor EC … TP
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { MODELS, modelFromName, SigenergyDriver } from './driver.ts';
import { INVERTER_UNIT, PLANT_UNIT } from './registers.ts';

export { decodeInfo, decodeLive, modelFromName, MODELS, READ_ONLY_ERROR, SigenergyDriver, sigenModel } from './driver.ts';

function text(regs: number[]) {
  return regsToAscii(regs).replace(/[^\x20-\x7e]/g, '').trim();
}

/** A Sigenergy model type: names Sigen, or a "<kW> SP|TP" rating code (SigenStor EC 10.0 TP). */
export function isSigenModel(model: string) {
  return plausibleId(model, 4) && (/sigen/i.test(model) || /\b\d{1,2}(\.\d)?\s?(SP|TP)\b/.test(model));
}

/**
 * Detect (read-only, 2 requests):
 *   1. input 30500–30524 on unit 1: model type ASCII (15 regs) + serial ASCII (10 regs).
 *      Needs a Sigenergy model string (contains "Sigen" or an "<kW> SP/TP" code) AND a printable
 *      serial of ≥ 8 characters. Blank / 0x0000 / 0xFFFF data never passes.
 *   2. input 30014 on unit 247 (plant ESS SOC): if it answers it must be ≤ 1000 (100.0 %);
 *      a gateway that doesn't answer on 247 is still accepted.
 * Other brands keep their identity in holding registers well below 30000, so nothing they hold
 * looks like this.
 */
export async function detectSigenergy(conn: ModbusConnection): Promise<Detection | null> {
  const regs = await conn.read(4, 30500, 25, INVERTER_UNIT);
  const model = text(regs.slice(0, 15));
  const serial = text(regs.slice(15, 25));
  if (!isSigenModel(model) || !plausibleId(serial, 8)) return null;
  let socText = '';
  try {
    const [soc] = await conn.read(4, 30014, 1, PLANT_UNIT);
    if (soc > 1000) return null;
    socText = `, plant SOC ${(soc / 10).toFixed(1)}%`;
  } catch {}
  return { modelId: modelFromName(model), evidence: `model ${model}, serial ${serial}${socText}`, address: PLANT_UNIT };
}

export const sigenergy: InverterDriverDescriptor = {
  id: 'sigenergy',
  name: 'Sigenergy SigenStor',
  manufacturer: 'Sigenergy',
  transport: 'tcp',
  defaultAddress: PLANT_UNIT,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '4', name: 'Input register' }, { id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new SigenergyDriver(opts),
  detect: detectSigenergy,
};

export const sigenergyDrivers: InverterDriverDescriptor[] = [sigenergy];
