/**
 * Luxpower and EG4 hybrids (LXP-LB, LXP AC-coupled, SNA, SNA-US; EG4 18kPV, 12kPV, 6000XP,
 * FlexBOSS — all speak the Luxpower protocol).
 *
 * Connections:
 *   - RS485 Modbus RTU: a serial path, 19200 8N1, address 1 (input = live, holding = settings).
 *   - Modbus TCP gateway "host:port" or Solarman "solarman://…" (via ModbusConnection).
 *   - Luxpower/EG4 WiFi dongle: "luxpower://ip[:8000]/<dongleSerial>[/<inverterSerial>]".
 *
 * Read-only: no register write has been checked on a real unit.
 */
import { regsToAscii } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { LuxpowerDriver, MODELS } from './driver.ts';
import { isSerial } from './registers.ts';

export { decodeRange, LuxpowerDriver, luxModel, MODELS, READ_ONLY_ERROR, type RegisterBus } from './driver.ts';
export { fakeDongle, LuxDongleClient, luxConnection, parseLuxConnection, DONGLE_PORT } from './dongle.ts';

async function tryRead(conn: ModbusConnection, fn: 3 | 4, start: number, count: number): Promise<number[] | null> {
  try {
    return await conn.read(fn, start, count);
  } catch {
    return null;
  }
}

/**
 * Detect (read-only, at most 3 requests):
 *   1. holding 0–11: Deye signature (holding 0 = 2..6 and 3–7 ASCII serial) → reject.
 *      Otherwise serial at 2–6 and firmware code at 7–8 (UNVERIFIED layout).
 *   2. holding 115–119 and 3. input 115–119: 10-char ASCII serial (UNVERIFIED, per protocol brief).
 * Accepts when a 10-char alphanumeric serial is found and either a 4-char firmware code sits at
 * holding 7–8 or the serial is at 115–119. Blank, 0x0000 and 0xFFFF data never form a serial.
 * Growatt keeps ASCII at holding 9–11 and 23–27, which none of these ranges match.
 */
export async function detectLuxpower(conn: ModbusConnection): Promise<Detection | null> {
  const h = await tryRead(conn, 3, 0, 12);
  if (h) {
    if (h[0] >= 2 && h[0] <= 6 && /^[A-Za-z0-9]{6,}$/.test(regsToAscii(h.slice(3, 8)))) return null; // Deye
    if (h.every((w) => w === 0) || h.every((w) => w === 0xffff)) return null;
    // An ASCII serial starting at holding 0 is Solax's layout, not ours (holding 0–1 are numeric codes here).
    if (/^[A-Za-z0-9]{4}$/.test(regsToAscii(h.slice(0, 2)))) return null;
  }
  const lowSerial = h ? regsToAscii(h.slice(2, 7)) : '';
  const fwCode = h ? regsToAscii(h.slice(7, 9)) : '';
  const hasFw = /^[A-Za-z0-9]{4}$/.test(fwCode);

  let serial = '';
  let where = '';
  for (const [fn, label] of [[3, 'holding'], [4, 'input']] as const) {
    const r = await tryRead(conn, fn, 115, 5);
    const text = r ? regsToAscii(r) : '';
    if (isSerial(text)) {
      serial = text;
      where = `${label} 115`;
      break;
    }
  }
  if (!serial && hasFw && isSerial(lowSerial)) {
    serial = lowSerial;
    where = 'holding 2';
  }
  if (!serial) return null;
  // Hybrid and AC-coupled share the layout; the model is left to the user.
  return { evidence: `serial ${serial} (${where})${hasFw ? `, firmware ${fwCode}` : ''}` };
}

export const luxpower: InverterDriverDescriptor = {
  id: 'luxpower',
  name: 'Luxpower, EG4 hybrid',
  manufacturer: 'Luxpower',
  transport: 'serial',
  defaultBaudRate: 19200,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [
    { id: '4', name: 'Input register' },
    { id: '3', name: 'Holding register' },
  ],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new LuxpowerDriver(opts),
  detect: detectLuxpower,
};

export const luxpowerDrivers: InverterDriverDescriptor[] = [luxpower];
