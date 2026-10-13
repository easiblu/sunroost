/**
 * Livoltek hybrid inverters over Modbus RTU: the Hyper series through the RS485 pins of its USB
 * WiFi-dongle port (a USB-RS485 adapter wired to A/B), the HP3 series through the RS485 terminals of
 * its communication port. 9600 8N1, unit id 17. Also Modbus TCP ("host:port", an RS485 gateway) or
 * a Solarman-style logger ("solarman://ip/serial") where one is fitted. Every register is read
 * as a holding register (function 3). Read-only until checked on a real unit.
 *
 * Models (one shared map; the id only changes the fallback model name):
 *   hyper — Hyper-2000…6000 single-phase hybrid
 *   hp3   — HP3-5KD2…12KL2 and HP3-xxKS1LV (map assumed the same: UNVERIFIED)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import type { ModbusConnection } from '../../modbus.ts';
import { LIVOLTEK_ADDRESS, LivoltekDriver, MODELS, modelFromName } from './driver.ts';
import { INFO_SPAN, LIVE_SPAN } from './registers.ts';

export { decodeInfo, decodeLive, derive, LIVOLTEK_ADDRESS, LivoltekDriver, livoltekModel, modelFromName, MODELS } from './driver.ts';

/**
 * At most three reads, all function 3: identity block 570–593 (model 570, serial 578) on unit 17,
 * then — only if unit 17 doesn't answer — on the connection's own unit; then the live block 450–497.
 * Needs a printable serial (or a model naming Hyper/HP3) AND a sane live block: SOC ≤ 100 %, battery
 * 9–1000 V, inverter frequency 0 or 45–65 Hz, not every word blank/0xFFFF. None of the other brands'
 * identity images put text at 570–585.
 */
async function detect(conn: ModbusConnection): Promise<Detection | null> {
  const units = [...new Set([LIVOLTEK_ADDRESS, conn.target.address])];
  let ident: number[] | null = null;
  let unit = LIVOLTEK_ADDRESS;
  for (const u of units) {
    try {
      ident = await conn.read(3, INFO_SPAN[0], INFO_SPAN[1], u);
      unit = u;
      break;
    } catch {
      // No answer on this unit id: try the next.
    }
  }
  if (!ident) return null;
  if (ident.every((w) => w === 0) || ident.every((w) => w === 0xffff)) return null;
  const model = regsToAscii(ident.slice(0, 5)).replace(/\xff/g, '').trim();
  const serial = regsToAscii(ident.slice(8, 16)).replace(/\xff/g, '').trim();
  const modelId = plausibleId(model, 4) ? modelFromName(model) : undefined;
  const okSerial = plausibleId(serial, 8);
  if (!okSerial && !modelId) return null;

  const live = await conn.read(3, LIVE_SPAN[0], LIVE_SPAN[1], unit);
  if (live.every((w) => w === 0) || live.every((w) => w === 0xffff)) return null;
  const freq = live[453 - 450];
  const soc = live[468 - 450];
  const battRaw = live[469 - 450];
  if (soc > 100) return null;
  if (battRaw < 90 || battRaw > 10000) return null;
  if (freq !== 0 && (freq < 4500 || freq > 6500)) return null;

  const parts = [modelId ? `model ${model}` : '', okSerial ? `serial ${serial}` : '', `battery ${(battRaw / 10).toFixed(1)} V ${soc}%`, `unit ${unit}`];
  return { modelId, evidence: parts.filter(Boolean).join(', '), address: unit };
}

export const livoltek: InverterDriverDescriptor = {
  id: 'livoltek',
  name: 'Livoltek (Hyper, HP3)',
  manufacturer: 'Livoltek',
  transport: 'serial',
  defaultBaudRate: 9600,
  detectBaudRates: [9600, 19200],
  defaultAddress: LIVOLTEK_ADDRESS,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [
    { id: '3', name: 'Holding register' },
    { id: '4', name: 'Input register' },
  ],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new LivoltekDriver(opts),
  detect,
};

export const livoltekDrivers: InverterDriverDescriptor[] = [livoltek];

export const LIVOLTEK_MODELS = MODELS.map((m) => m.id);
