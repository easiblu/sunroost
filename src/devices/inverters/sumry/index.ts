/**
 * Sumry-class all-in-one inverters (Sumry, Anenji, Easun ISolar SMG/SMH, Tingen/POWLAND/LiveFun/
 * Busbyr GES, Vevor, Daxtromn, HumsiENK, HZSolar, Conderenergy …) speaking the "SMG-II" Modbus RTU
 * protocol: RS232/RS485/USB at 9600 8N1, unit id 1, holding registers (function 3) only.
 * Connections: a serial path, Modbus TCP "host:port" (RS485 gateway), or "solarman://ip/serial".
 *
 * Models (register maps):
 *   smg     — classic SMG-II map: live 201–234, settings 300–343 (default; best documented)
 *   smg_ext — extended map with per-phase blocks (338/376/414) and settings 600–709 (protocol 3–6)
 *
 * READ-ONLY: nothing has been checked on a real unit. Settings are decoded and shown, writes refused.
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { FAMILIES, SumryDriver, sumryFamily } from './driver.ts';
import { SMG_MODES } from './smg.ts';

export { decodeLive, decodeRange, FAMILIES, READ_ONLY_MESSAGE, SumryDriver, sumryFamily } from './driver.ts';

const printable = (b: number) => b >= 0x20 && b <= 0x7e;

/**
 * Serial at holding 186–197. Stricter than plausibleId alone: the first four registers must each hold
 * two printable characters, so small numeric settings (0x00xx) another brand keeps there don't pass.
 */
export function serialFrom(words: number[]): string | null {
  if (words.length < 4 || !words.slice(0, 4).every((w) => printable(w >> 8) && printable(w & 0xff))) return null;
  const sn = regsToAscii(words);
  return plausibleId(sn) ? sn : null;
}

export const sumry: InverterDriverDescriptor = {
  id: 'sumry',
  name: 'Sumry, Anenji, Easun SMG',
  manufacturer: 'Sumry',
  readOnly: true,
  transport: 'serial',
  defaultBaudRate: 9600,
  models: FAMILIES.map((f) => ({ id: f.id, name: f.name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new SumryDriver(opts),
  /**
   * Request 1: holding 186–201 — ASCII serial (186–197) and working mode (201, 0–6).
   * Request 2: holding 184 — protocol number; 3–6 means the extended map (UNVERIFIED rule).
   * Deye keeps its serial at 3–7 and Growatt at 23–27, so neither matches here.
   */
  async detect(conn) {
    let regs: number[];
    try {
      regs = await conn.read(3, 186, 16);
    } catch {
      return null;
    }
    const sn = serialFrom(regs.slice(0, 12));
    const mode = regs[15];
    if (!sn || !(mode in SMG_MODES)) return null;
    let protocol: number | undefined;
    try {
      protocol = (await conn.read(3, 184, 1))[0];
    } catch {}
    const ext = protocol !== undefined && protocol >= 3 && protocol <= 6;
    const modelId = ext ? 'smg_ext' : 'smg';
    return {
      modelId,
      evidence: `serial ${sn}, mode ${SMG_MODES[mode]}${ext ? `, protocol ${protocol}` : ''} (${sumryFamily(modelId).name})`,
    };
  },
};

export const sumryDrivers: InverterDriverDescriptor[] = [sumry];

export const SUMRY_MODELS = FAMILIES.map((f) => f.id);
