/**
 * Solis (Ginlong) inverters, and Dyness's 1P-A hybrids (rebranded Solis).
 *
 * Connections (all through ModbusConnection):
 *   - RS485 Modbus RTU: a serial path, 9600 8N1, address 1 (COM port / RJ45 "485" on the inverter).
 *   - Solis / Solarman WiFi data stick: "solarman://ip[:8899]/<loggerSerial>".
 *   - Modbus TCP gateway: "host:port".
 * Live data are input registers (function 4) at 33000+; settings are holding registers at 43000+.
 * The driver is read-only until a real unit has been checked.
 *
 * Models:
 *   hybrid  — single-phase hybrid: RHI, S5-EH1P-L, S6-EH1P, Dyness 1P-A (default)
 *   hybrid3 — three-phase hybrid: RHI-3P / RHI-HVES-5G-DC, S6-EH3P K-H, S6-EH3P Solarator
 *   string  — single-phase grid-tie string inverter (no battery)
 *   string3 — three-phase grid-tie string inverter (no battery)
 */
import { plausibleId } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { MODELS, SolisDriver } from './driver.ts';
import { decodeSerial, SERIAL_WORDS } from './registers.ts';

export { decodeInfo, decodeLive, derive, MODELS, READ_ONLY_ERROR, SolisDriver, solisModel } from './driver.ts';
export { decodeSerial } from './registers.ts';
export { decodeSettings, SOLIS_SETTINGS, workMode } from './settings.ts';

const blank = (ws: number[]) => ws.every((w) => w === 0) || ws.every((w) => w === 0xffff);

/**
 * Detect (read-only, three function-4 requests):
 *   1. input 33000–33019: model code (33000), firmware (33001–33002), serial (33004–33019).
 *      Rejects a blank / 0x0000 / 0xFFFF model code or block and a serial that isn't printable.
 *   2. input 33049–33095: PV/AC block. Rejects implausible grid voltage (> 300 V) or frequency.
 *   3. input 33133–33139: battery voltage and SOC, which tell a hybrid from a string inverter.
 * Other brands either raise an exception or return zeros at 33000 (Deye, Growatt, SRNE … keep
 * their identity in holding registers), so the probe can't claim them.
 */
export async function detectSolis(conn: ModbusConnection): Promise<Detection | null> {
  const info = await conn.read(4, 33000, 4 + SERIAL_WORDS);
  if (info.length < 4 + SERIAL_WORDS || blank(info)) return null;
  const code = info[0];
  if (code === 0 || code === 0xffff) return null;
  const serial = decodeSerial(info.slice(4));
  if (!plausibleId(serial, 6)) return null;

  const ac = await conn.read(4, 33049, 47);
  const v = (i: number) => ac[i - 33049] ?? 0;
  const [va, vb, vc] = [v(33073), v(33074), v(33075)];
  const freq = v(33094);
  if (va > 3000 || vb > 3000 || vc > 3000) return null;
  if (freq !== 0 && (freq < 4500 || freq > 6500)) return null;

  let battery = false;
  let battText = '';
  try {
    const b = await conn.read(4, 33133, 7);
    const bv = b[0];
    const soc = b[6];
    if (bv !== 0xffff && soc <= 100 && bv > 0 && bv < 10000) {
      battery = true;
      battText = `, battery ${(bv / 10).toFixed(1)} V ${soc}%`;
    }
  } catch {
    // String inverters may not implement the battery block.
  }
  const three = vb > 500 || vc > 500;
  const live = va > 500 || three;
  const modelId = battery ? (three ? 'hybrid3' : 'hybrid') : live ? (three ? 'string3' : 'string') : undefined;
  const fw = info[1] && info[1] !== 0xffff ? `, firmware ${info[1].toString(16).toUpperCase()}` : '';
  const hex = code.toString(16).toUpperCase().padStart(4, '0');
  return { modelId, evidence: `model code 0x${hex}, serial ${serial}${fw}${battText}` };
}

export const solis: InverterDriverDescriptor = {
  id: 'solis',
  name: 'Solis (Ginlong, Dyness 1P-A)',
  manufacturer: 'Solis',
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
  create: (opts) => new SolisDriver(opts),
  detect: detectSolis,
};

export const solisDrivers: InverterDriverDescriptor[] = [solis];

export const SOLIS_MODELS = MODELS.map((m) => m.id);
