/**
 * Senergy (Senergytec) hybrid inverters over Modbus RTU (RS485 on the RJ45 monitoring port, pins 1 = A,
 * 2 = B; 9600 8N1, address 1), Modbus TCP ("host:port", an RS485 gateway or the LAN dongle) or a
 * Solarman logger ("solarman://ip/serial"). Duracell Dura-i and Salvare 10 PRO units are Senergy OEM
 * builds with the same map. Every register is a holding register (function 3). The driver is
 * read-only until a real unit has been checked.
 *
 * Models (pick the layout; the probe guesses from the model string):
 *   hybrid  — single-phase hybrid: Duracell Dura-i G1 / G3 (PD-DH1P-…) (default)
 *   split   — split-phase hybrid: Senergy SE 2…15KTL-G2P
 *   hybrid3 — three-phase high-voltage hybrid: Salvare 10 PRO (SE 10KHB-210-T/EU)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { MODELS, SenergyDriver } from './driver.ts';
import { MODEL_REG, SERIAL_REG } from './registers.ts';

export { decodeInfo, decodeLive, derive, liveMap, MODELS, SenergyDriver, senergyModel } from './driver.ts';

function text(regs: number[]) {
  return regsToAscii(regs).replace(/[\xff]/g, '').trim();
}

/** Model string → model id, when it names a known series. */
export function modelFromName(name: string): string | undefined {
  if (/G2P|SPLIT/i.test(name)) return 'split';
  if (/DH1P|DURA/i.test(name)) return 'hybrid';
  if (/HB-?\d*-?T\b|-T\/|3P|THREE/i.test(name)) return 'hybrid3';
  return undefined;
}

export const senergy: InverterDriverDescriptor = {
  id: 'senergy',
  name: 'Senergy (Duracell Dura-i, Salvare …)',
  manufacturer: 'Senergy',
  transport: 'serial',
  defaultBaudRate: 9600,
  defaultAddress: 1,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new SenergyDriver(opts),
  /**
   * Three reads: model + serial (holding 0x1A00–0x1A17, ASCII), battery SOC (0x2000) and grid voltage /
   * frequency (0x1001–0x1005). Needs a printable serial at 0x1A10, SOC ≤ 100 % and a grid voltage and
   * frequency that are either 0 (not connected) or sane. Other brands keep nothing at 0x1A00, and
   * blank or 0xFFFF-filled maps fail the serial or range checks.
   */
  async detect(conn) {
    try {
      const info = await conn.read(3, MODEL_REG, 0x18);
      const model = text(info.slice(0, 8));
      const serial = text(info.slice(SERIAL_REG - MODEL_REG, SERIAL_REG - MODEL_REG + 8));
      if (!plausibleId(serial, 6)) return null;
      const okModel = plausibleId(model, 4);
      if (model && !/^[\x20-\x7e]+$/.test(model)) return null;
      // MidNite's MN15 AIO is a Senergy underneath; its own driver claims units that say so.
      if (/MN15|MIDNITE/i.test(model)) return null;
      const [soc] = await conn.read(3, 0x2000, 1);
      if (soc > 100) return null;
      const ac = await conn.read(3, 0x1001, 5);
      const v = ac[0];
      const hz = ac[4];
      if (v !== 0 && (v < 800 || v > 3000)) return null;
      if (hz !== 0 && (hz < 4500 || hz > 6500)) return null;
      const parts = [okModel ? `model ${model}` : '', `serial ${serial}`, `battery ${soc}%`, v ? `grid ${(v / 10).toFixed(1)} V` : ''];
      return { modelId: okModel ? modelFromName(model) : undefined, evidence: parts.filter(Boolean).join(', ') };
    } catch {
      return null;
    }
  },
};

export const senergyDrivers: InverterDriverDescriptor[] = [senergy];

export const SENERGY_MODELS = MODELS.map((m) => m.id);
