/**
 * Sungrow inverters: SH-RT / SH-T three-phase hybrids, SH-RS single-phase hybrids and SG-RT
 * three-phase grid-tied string inverters.
 *
 * Connections:
 *   - Modbus TCP through the WiNet-S / WiFi dongle or the LAN port: "host:502", unit 1 (default).
 *   - Modbus RTU over RS485: a serial path, 9600 8N1, address 1.
 *   - A Solarman logger "solarman://ip/serial" or another RS485 gateway "host:port" also work.
 * Live data are input registers (function 4), settings holding registers (function 3). Register
 * numbers in Sungrow's documents are 1-based; the wire address is one less (see registers.ts).
 *
 * Out of scope: newer WiNet-S firmware that encrypts Modbus TCP. A TCP read that gets no plain
 * Modbus reply fails with a message saying to use RS485 or a firmware that allows plain Modbus TCP.
 *
 * Read-only: no register write has been checked on a real unit.
 */
import { plausibleId } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { explainError, MODELS, SungrowDriver } from './driver.ts';
import { decodeAscii, IDENTITY_SPAN, typeFamily } from './registers.ts';

export { decodeInfo, decodeLive, derive, ENCRYPTED_HINT, liveMap, MODELS, SungrowDriver, sungrowModel } from './driver.ts';
export { DEVICE_TYPES, typeFamily } from './registers.ts';

/**
 * Detect (read-only, one request): input registers 4989–5001 (doc 4990–5002) at unit 1 — serial
 * (10 regs ASCII), device type code, nominal power, output type. Accepts only a known Sungrow type
 * code family together with a plausible serial and a nominal power of 0.1–200 kW. Other brands
 * answer this input range with an exception or zeros; blank, 0x0000 and 0xFFFF data never pass.
 */
export async function detectSungrow(conn: ModbusConnection): Promise<Detection | null> {
  let regs: number[];
  try {
    regs = await conn.read(4, IDENTITY_SPAN[0], IDENTITY_SPAN[1]);
  } catch (err) {
    throw explainError(conn, err);
  }
  const serial = decodeAscii(regs.slice(0, 10));
  const code = regs[10];
  const nominal = regs[11];
  if (code === 0 || code === 0xffff) return null;
  const fam = typeFamily(code);
  if (!fam) return null;
  if (!plausibleId(serial, 6) || !/^[A-Za-z0-9]+$/.test(serial)) return null;
  if (nominal < 1 || nominal > 2000) return null;
  const hex = `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return { modelId: fam.model, evidence: `device type ${hex} (${fam.name}), serial ${serial}, ${nominal / 10} kW` };
}

export const sungrow: InverterDriverDescriptor = {
  id: 'sungrow',
  name: 'Sungrow (SH hybrid, SG grid-tied)',
  manufacturer: 'Sungrow',
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
  create: (opts) => new SungrowDriver(opts),
  detect: detectSungrow,
};

export const sungrowDrivers: InverterDriverDescriptor[] = [sungrow];
