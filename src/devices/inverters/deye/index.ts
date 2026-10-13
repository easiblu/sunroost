/**
 * Deye / Sunsynk hybrid inverters (also Sol-Ark, Turbo Energy and other rebrands) over Modbus RTU
 * (RS485, 9600 8N1, address 1) or Modbus TCP (connection "host:port"). All registers are holding
 * registers (function 3); writes use function 16. The model picks the register family:
 *   hybrid    — single-phase LV hybrid 3.6–16 kW (default)
 *   hybrid3   — three-phase LV hybrid 5–12 kW
 *   hybrid3hv — three-phase HV hybrid 5–50 kW (settings read-only)
 *   string    — grid-tie string inverter, no battery (mostly UNVERIFIED)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { DeyeDriver, deyeFamily, FAMILIES } from './driver.ts';
import { DEVICE_TYPES } from './family.ts';

/** Device type (holding 0) → model id. */
const TYPE_MODEL: Record<number, string> = { 0x0002: 'string', 0x0003: 'hybrid', 0x0005: 'hybrid3', 0x0006: 'hybrid3hv', 0x0106: 'hybrid3hv' };

export { decodeLive, decodeRange, DeyeDriver, deyeFamily, FAMILIES } from './driver.ts';

export const sunsynk: InverterDriverDescriptor = {
  // Driver id 'sunsynk' (power-management routing keys off it).
  id: 'sunsynk',
  name: 'Deye, SunSynk, Sol-Ark',
  manufacturer: 'Deye',
  transport: 'serial',
  defaultBaudRate: 9600,
  models: [
    { id: 'hybrid', name: 'Single-phase hybrid (3.6–16 kW)' },
    { id: 'hybrid3', name: 'Three-phase LV hybrid (5–12 kW)' },
    { id: 'hybrid3hv', name: 'Three-phase HV hybrid (5–50 kW)' },
    { id: 'string', name: 'String inverter (grid-tie, no battery)' },
  ],
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: (model) => deyeFamily(model).socControl,
  protectionSetting: () => null,
  create: (opts) => new DeyeDriver(opts),
  // Holding 0 is a known device type code and 3–7 a 10-character ASCII serial.
  async detect(conn) {
    const regs = await conn.read(3, 0, 8);
    const sn = regsToAscii(regs.slice(3, 8));
    if (!DEVICE_TYPES[regs[0]] || !plausibleId(sn)) return null;
    return { modelId: TYPE_MODEL[regs[0]], evidence: `device type ${DEVICE_TYPES[regs[0]]}, serial ${sn}` };
  },
};

export const deyeDrivers: InverterDriverDescriptor[] = [sunsynk];

export const DEYE_MODELS = FAMILIES.map((f) => f.id);
