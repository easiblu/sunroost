/**
 * GoodWe hybrids.
 *
 * Models:
 *   et       — ET / BT / ET G2 three-phase hybrids (ET Modbus map)
 *   eh       — EH / BH / ES G2 / ES Uniq (ES-C10) / D-ES / EHB single-phase hybrids (ET Modbus map)
 *   et-split — GW-ES split-phase hybrid (ET Modbus map, L1/L2)
 *   es       — legacy ES / EM / BP (AA55 protocol, WiFi/LAN dongle only)
 *
 * Connections:
 *   - RS485 Modbus RTU: a serial path, 9600 8N1, unit 247 (0xF7, GoodWe's default).
 *   - Modbus TCP gateway "host:port" or Solarman "solarman://…" (via ModbusConnection).
 *   - GoodWe WiFi/LAN dongle: "goodwe://ip[:8899]" (UDP; see udp.ts).
 *
 * Read-only: no register write has been checked on a real unit.
 */
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { GoodweDriver, MODELS } from './driver.ts';
import { decodeAscii, decodeEsInfo, INFO_SPAN, modelFromIdentity } from './registers.ts';
import { AA55_DEVICE_INFO, GOODWE_UNIT, GoodweUdpClient, parseGoodweConnection } from './udp.ts';

export { decodeRange, GoodweDriver, goodweModel, MODELS, READ_ONLY_ERROR } from './driver.ts';
export {
  fakeGoodwe, GOODWE_PORT, GOODWE_UNIT, goodweConnection, GoodweUdpClient, isGoodweConnection, parseGoodweConnection,
} from './udp.ts';

/** UI validator for the dongle connection string. */
export const GOODWE_CONNECTION_RE = /^goodwe:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/i;

const SERIAL_RE = /^[A-Za-z0-9]{8,16}$/;

/**
 * Checks a 35000+ device-info block (35000–35032). Needs a 8–16 char alphanumeric serial at
 * 35003–35010 that isn't one repeated character, plus either a printable model name at
 * 35011–35015 or a sane rated power (1–60 kW) at 35001. Blank / 0x0000 / 0xFFFF data fails.
 */
export function checkInfoBlock(regs: number[]): { serial: string; model: string; modelId?: string } | null {
  if (regs.length < 16) return null;
  if (regs.every((w) => w === 0) || regs.every((w) => w === 0xffff)) return null;
  const serial = decodeAscii(regs.slice(3, 11));
  const model = decodeAscii(regs.slice(11, 16));
  if (!SERIAL_RE.test(serial) || /^(.)\1*$/.test(serial)) return null;
  const okModel = /^[\x20-\x7e]{3,10}$/.test(model) && /[A-Za-z]/.test(model);
  const rated = regs[1];
  const okRated = rated >= 1000 && rated <= 60000;
  if (!okModel && !okRated) return null;
  return { serial, model: okModel ? model : '', modelId: modelFromIdentity(serial, model) };
}

/**
 * Modbus detect (read-only, at most 2 requests): device info 35000–35032 at unit 247, then at
 * unit 1 if that fails or isn't a GoodWe block. Other brands (Deye, Growatt, SRNE, …) keep their
 * identity in low registers and have nothing at 35000, so they read blank or raise an exception.
 */
export async function detectGoodwe(conn: ModbusConnection): Promise<Detection | null> {
  for (const unit of [GOODWE_UNIT, 1]) {
    let regs: number[];
    try {
      regs = await conn.read(3, INFO_SPAN[0], INFO_SPAN[1], unit);
    } catch {
      continue;
    }
    const hit = checkInfoBlock(regs);
    if (!hit) continue;
    return {
      modelId: hit.modelId,
      evidence: `${hit.model ? `model ${hit.model}, ` : ''}serial ${hit.serial} (holding 35000, unit ${unit})`,
      address: unit,
    };
  }
  return null;
}

/**
 * Detect over the WiFi/LAN dongle (goodwe://ip[:port]), for detect.ts to call (at most 3 UDP
 * requests): Modbus-over-UDP read of 35000–35032 at unit 247 (one retry), then the AA55 device-info
 * request (legacy ES/EM/BP). Returns null if neither answers with a GoodWe identity.
 */
export async function detectGoodweUdp(connection: string, opts: { timeoutMs?: number } = {}): Promise<Detection | null> {
  const target = parseGoodweConnection(connection);
  if (!target) throw new Error(`Not a goodwe:// connection: ${connection}`);
  const client = new GoodweUdpClient(target, { timeoutMs: opts.timeoutMs ?? 1500, retries: 1 });
  await client.connect();
  try {
    try {
      const hit = checkInfoBlock(await client.read(3, INFO_SPAN[0], INFO_SPAN[1], GOODWE_UNIT));
      if (hit) {
        return {
          modelId: hit.modelId ?? 'et',
          evidence: `${hit.model ? `model ${hit.model}, ` : ''}serial ${hit.serial} (Modbus over UDP, unit ${GOODWE_UNIT})`,
          address: GOODWE_UNIT,
        };
      }
    } catch {}
    client.retries = 0;
    try {
      const info = decodeEsInfo(await client.aa55(...AA55_DEVICE_INFO));
      const serial = typeof info['Serial number'] === 'string' ? info['Serial number'] : '';
      const model = typeof info['Model name'] === 'string' ? info['Model name'] : '';
      if (SERIAL_RE.test(serial) || /[A-Za-z]{2}/.test(model)) {
        return {
          // Only the legacy family answers AA55 here, whatever its serial tag says.
          modelId: 'es',
          evidence: `${model ? `model ${model}, ` : ''}${serial ? `serial ${serial} ` : ''}(AA55 protocol)`,
        };
      }
    } catch {}
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

export const goodwe: InverterDriverDescriptor = {
  id: 'goodwe',
  name: 'GoodWe hybrid (ET, EH, ES, BT, BH …)',
  manufacturer: 'GoodWe',
  transport: 'serial',
  defaultBaudRate: 9600,
  defaultAddress: GOODWE_UNIT,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new GoodweDriver(opts),
  detect: detectGoodwe,
};

export const goodweDrivers: InverterDriverDescriptor[] = [goodwe];
