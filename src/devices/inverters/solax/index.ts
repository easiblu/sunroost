/**
 * Solax inverters over Modbus RTU (RS485 on the COM/BMS-485 port, 19200 8N1, address 1), Modbus TCP
 * through a Pocket WiFi 3.0 / LAN dongle or RS485 gateway ("host:502") or a Solarman-style logger
 * ("solarman://ip/serial"). Live data is in input registers (function 4), info and settings in
 * holding registers (function 3). The driver is read-only until a real unit has been checked.
 *
 * Models:
 *   x1_hybrid  — X1-Hybrid G4 (also G3 single-phase hybrids, same live block) (default)
 *   x3_hybrid  — X3-Hybrid G4 (also G3 three-phase hybrids)
 *   x1_lite_lv — X1-Lite-8.0/10.0/12.0-LV off-grid (UNVERIFIED: assumed to share the G4 map)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { MODELS, SolaxDriver } from './driver.ts';

export { decodeInfo, decodeLive, derive, liveMap, MODELS, SolaxDriver, solaxModel } from './driver.ts';

/** Model id from the module name or serial prefix (G4: X1 serials start "H4", X3 "H34"; G3: "H1" / "H3"). */
export function modelFromIdentity(serial: string, module: string): string | undefined {
  if (/LITE|-LV\b/i.test(module)) return 'x1_lite_lv';
  if (/X3/i.test(module)) return 'x3_hybrid';
  if (/X1/i.test(module)) return 'x1_hybrid';
  if (/^H3/i.test(serial)) return 'x3_hybrid';
  if (/^H[14]/i.test(serial)) return 'x1_hybrid';
  return undefined;
}

/** True when the first byte of the first register is a printable letter or digit (no leading padding). */
function startsAtZero(regs: number[]) {
  return /[A-Za-z0-9]/.test(String.fromCharCode(regs[0] >> 8));
}

export const solax: InverterDriverDescriptor = {
  id: 'solax',
  name: 'Solax (X1 / X3 Hybrid G4, X1 Lite LV)',
  manufacturer: 'Solax',
  transport: 'serial',
  defaultBaudRate: 19200,
  detectBaudRates: [19200, 9600],
  defaultAddress: 1,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [
    { id: '4', name: 'Input register' },
    { id: '3', name: 'Holding register' },
  ],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new SolaxDriver(opts),
  /**
   * One read: holding 0x0000–0x0014 = serial (7 regs ASCII), factory name (7 regs) and module name
   * (7 regs). Needs a printable serial starting right at register 0 AND either a factory name
   * containing "solax" or a Solax-style module name (X1 / X3 / Hybrid / Lite). Deye's holding 0 is a
   * small device-type code (not ASCII) and Luxpower's serial starts at holding 2, so neither passes;
   * Growatt has nothing at 0–6.
   */
  async detect(conn) {
    const regs = await conn.read(3, 0x0000, 21);
    const serial = regsToAscii(regs.slice(0, 7));
    const factory = regsToAscii(regs.slice(7, 14));
    const module = regsToAscii(regs.slice(14, 21));
    if (!startsAtZero(regs) || !plausibleId(serial, 6)) return null;
    const okFactory = /solax/i.test(factory);
    const okModule = plausibleId(module, 4) && /X1|X3|HYBRID|LITE|SOLAX/i.test(module);
    if (!okFactory && !okModule) return null;
    const parts = [`serial ${serial}`, okFactory ? `factory ${factory}` : '', okModule ? `module ${module}` : ''];
    return { modelId: modelFromIdentity(serial, okModule ? module : ''), evidence: parts.filter(Boolean).join(', ') };
  },
};

export const solaxDrivers: InverterDriverDescriptor[] = [solax];

export const SOLAX_MODELS = MODELS.map((m) => m.id);
