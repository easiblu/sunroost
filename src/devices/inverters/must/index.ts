/**
 * MUST Power inverters (and the Synerji SYSV rebrand) over Modbus RTU: RS485 or the USB port
 * (CH340 serial), 19200 8N1, slave address 4 by default on PV/PH1800 units (1 on some). Also works
 * through an RS485-to-TCP gateway ("host:port") or a Solarman logger ("solarman://ip/serial").
 * Everything is a holding register (function 3). Read-only until verified on hardware.
 *
 * Models:
 *   ph1800 — PV1800 / PH1800 / PV18 / PH18 / EP1800, PH18-Plus, Synerji SYSV (default)
 *   pv1900 — PV19 EXP: PH1800 map + SOC at 113 + second MPPT at 16205+
 *   pv3300 — EP3300 / PV33 TLV / PV3500: assumed PH1800 layout (UNVERIFIED)
 *   ph10   — PH10 / PH11 three-phase hybrid (PH1100 EU): its own map
 */
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { DEFAULT_ADDRESS, DEFAULT_BAUD, FAMILIES, MustDriver } from './driver.ts';
import { decodeMustVersion, MACHINE_TYPES, WORK_STATE } from './registers.ts';

export { decodeLive, decodeRange, FAMILIES, MustDriver, mustFamily, READ_ONLY_MESSAGE } from './driver.ts';

const blank = (regs: number[]) => regs.every((r) => r === 0) || regs.every((r) => r === 0xffff);

/**
 * Detect: identity block 20000–20005 must hold a known machine type at 20001 (1800 …), a non-blank
 * serial at 20002–20003, and the inverter work state (25201) must be a known code. Tries unit 4
 * (MUST's default) then unit 1; at most three read requests, never writes.
 */
export async function detectMust(conn: ModbusConnection, units: number[] = [DEFAULT_ADDRESS, 1]): Promise<Detection | null> {
  for (const unit of units) {
    let id: number[];
    try {
      id = await conn.read(3, 20000, 6, unit);
    } catch {
      continue;
    }
    if (id.length < 6 || blank(id)) continue;
    const type = MACHINE_TYPES[id[1]];
    const serial = ((id[2] << 16) | id[3]) >>> 0;
    if (!type || serial === 0 || serial === 0xffffffff) continue;
    const state = (await conn.read(3, 25201, 1, unit))[0];
    if (WORK_STATE[state] === undefined) return null;
    const sw = id[5] && id[5] !== 0xffff ? `, firmware ${decodeMustVersion(id[5])}` : '';
    return {
      modelId: type.model,
      address: unit,
      evidence: `machine type ${id[1]} (${type.name}), serial ${serial}${sw}, state ${WORK_STATE[state]}, Modbus address ${unit}`,
    };
  }
  return null;
}

export const must: InverterDriverDescriptor = {
  id: 'must',
  name: 'MUST Power',
  manufacturer: 'MUST',
  transport: 'serial',
  defaultBaudRate: DEFAULT_BAUD,
  defaultAddress: DEFAULT_ADDRESS,
  readOnly: true,
  models: [
    { id: 'ph1800', name: 'PV1800 / PH1800 / PV18 / PH18 (also PH18-Plus, Synerji SYSV)' },
    { id: 'pv1900', name: 'PV19 EXP (PV1900, two MPPT)' },
    { id: 'pv3300', name: 'EP3300 / PV33 TLV (unverified map)' },
    { id: 'ph10', name: 'PH10 / PH11 three-phase hybrid' },
  ],
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new MustDriver(opts),
  detect: (conn) => detectMust(conn),
};

export const mustDrivers: InverterDriverDescriptor[] = [must];

export const MUST_MODELS = FAMILIES.map((f) => f.id);
