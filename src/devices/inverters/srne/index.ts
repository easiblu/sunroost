/**
 * SRNE inverters over Modbus RTU (RS485 / RS232 / USB, 9600 8N1, address 1), Modbus TCP
 * ("host:port", an RS485 gateway) or a Solarman logger ("solarman://ip/serial"). Also sold as PowMr,
 * Easun, Eco-worthy, Hanchu, RUiXU and SunGoldPower. Every register is a holding register
 * (function 3). The driver is read-only until a real unit has been checked.
 *
 * Models (pick the register layout; the probe can only tell off-grid from hybrid by model name):
 *   offgrid       — single-phase off-grid: HF / ASP / ASF / ABP (default)
 *   offgrid-split — split-phase off-grid: ASP / ABP split-phase
 *   offgrid-three — three-phase off-grid: ASP three-phase
 *   hybrid        — single-phase hybrid: HESP / HYP
 *   hybrid-split  — split-phase hybrid: HYP split-phase, ASP split-phase hybrid
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { MODELS, SrneDriver } from './driver.ts';

export { decodeInfo, decodeLive, derive, liveMap, MODELS, SrneDriver, srneModel } from './driver.ts';

/** ASCII with 0xFF padding bytes removed (SRNE pads unused string registers with 0xFF or 0x00). */
function text(regs: number[]) {
  return regsToAscii(regs).replace(/\xff/g, '').trim();
}

/** Model string → model id, when it names a known series. */
export function modelFromName(name: string): string | undefined {
  if (/HESP|HYP|HYBRID/i.test(name)) return 'hybrid';
  if (/ASP|ASF|ABP|HF/i.test(name)) return 'offgrid';
  return undefined;
}

export const srne: InverterDriverDescriptor = {
  id: 'srne',
  name: 'SRNE (PowMr, Easun, SunGoldPower …)',
  manufacturer: 'SRNE',
  transport: 'serial',
  defaultBaudRate: 9600,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new SrneDriver(opts),
  /**
   * Three reads: product model (holding 0x000A–0x0016, ASCII at 0x000C), serial (0x0035, ASCII) and
   * battery SOC/voltage (0x0100–0x0102). Needs a printable model or serial AND a sane battery
   * (SOC ≤ 100 %, 9–70 V). Deye (type code at 0, serial at 3–7) has nothing at 0x000C or 0x0035;
   * Growatt's ASCII at 9–14 can spill into 0x000C, but its holding 0x0100 is no battery reading.
   */
  async detect(conn) {
    const info = await conn.read(3, 0x000a, 13);
    const model = text(info.slice(2, 10));
    let serial = '';
    try {
      serial = text(await conn.read(3, 0x0035, 20));
    } catch {}
    const okModel = plausibleId(model, 6);
    const okSerial = plausibleId(serial, 6);
    if (!okModel && !okSerial) return null;
    const [soc, vraw] = await conn.read(3, 0x0100, 3);
    if (soc > 100 || vraw < 90 || vraw > 700) return null;
    const parts = [okModel ? `model ${model}` : '', okSerial ? `serial ${serial}` : '', `battery ${(vraw / 10).toFixed(1)} V ${soc}%`];
    return { modelId: okModel ? modelFromName(model) : undefined, evidence: parts.filter(Boolean).join(', ') };
  },
};

export const srneDrivers: InverterDriverDescriptor[] = [srne];

export const SRNE_MODELS = MODELS.map((m) => m.id);
