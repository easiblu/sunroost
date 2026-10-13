/**
 * Felicity Solar inverters over Modbus RTU (RS232 or RS485 on the COM RJ45), Modbus TCP
 * ("host:port", e.g. an RS485-to-Ethernet bridge) or a Solarman-style logger
 * ("solarman://ip/serial"). Holding registers only (function 3). The model picks the map:
 *   ivem — IVEM / IVPA high-frequency all-in-ones (RS232, 2400 8N1) — vendor document
 *   trex — T-REX LP hybrids, 5–10 kW (RS485, 2400 8N1) — community map, UNVERIFIED
 *   hv3  — IVGM and T-Rex HP three-phase hybrids (RS485, 9600 on T-REX-25/50) — UNVERIFIED
 *
 * Read-only: nothing has been checked on a real unit by this project yet.
 */
import type { InverterDriverDescriptor } from '../../types.ts';
import { FAMILIES, FelicityDriver } from './driver.ts';
import { decodeSerial, DEVICE_TYPES, TYPE_MODEL } from './family.ts';

export { decodeLive, decodeRange, FAMILIES, FelicityDriver, felicityFamily, READ_ONLY_MESSAGE } from './driver.ts';

export const felicity: InverterDriverDescriptor = {
  id: 'felicity',
  name: 'Felicity Solar',
  manufacturer: 'Felicity Solar',
  readOnly: true,
  transport: 'serial',
  defaultBaudRate: 2400,
  detectBaudRates: [2400, 9600],
  models: [
    { id: 'ivem', name: 'IVEM / IVPA all-in-one (RS232, 2400 baud)' },
    { id: 'trex', name: 'T-REX LP hybrid 5–10 kW (RS485, 2400 baud)' },
    { id: 'hv3', name: 'IVGM / T-Rex HP three-phase hybrid (RS485, 9600 baud)' },
  ],
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new FelicityDriver(opts),
  /**
   * One read of the product-information block 0xF800–0xF80C: a small device type code (not 0 or
   * 0xFFFF) and a serial made of decimal-digit words. Deye and Growatt keep their identity at
   * holding 0–27 and have nothing (or an exception) at 0xF800.
   */
  async detect(conn) {
    const regs = await conn.read(3, 0xf800, 13);
    const [type, sub] = regs;
    if (type === undefined || type === 0 || type === 0xffff || type > 0xff) return null;
    const sn = decodeSerial(regs.slice(4, 9));
    // Felicity serials are digits; reject an ASCII-looking or short one.
    if (!/^\d{8,}$/.test(sn)) return null;
    const kind = DEVICE_TYPES[type] ?? `type 0x${type.toString(16)}`;
    const subText = sub !== undefined && sub !== 0xffff ? `, subtype 0x${sub.toString(16).padStart(4, '0')}` : '';
    return { modelId: TYPE_MODEL[type], evidence: `Felicity ${kind}${subText}, serial ${sn}` };
  },
};

export const felicityDrivers: InverterDriverDescriptor[] = [felicity];

export const FELICITY_MODELS = FAMILIES.map((f) => f.id);
