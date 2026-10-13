/**
 * Huawei SUN2000 inverters (SUN2000 KTL-L1 single-phase hybrid, SUN2000 KTL-M0/M1/M2/M3
 * three-phase), with an optional LUNA2000 battery and DTSU666-H power meter.
 *
 * Connections (every register is a holding register, function 3):
 *   - SDongleA Modbus TCP: "ip:502", unit 1 (the default address).
 *   - Inverter WLAN-FE access point / LAN Modbus TCP: "ip:6607" (older firmware "ip:502"), unit 0.
 *     Usually needs "Modbus TCP" enabled in FusionSolar / SUN2000 app.
 *   - RS485 Modbus RTU: a serial path, 9600 8N1, address 1.
 *   - A Solarman/other RS485-TCP gateway also works through ModbusConnection.
 *
 * The driver waits ~1 s after connecting before its first request (Huawei drops early requests),
 * and reads only short contiguous spans (Huawei rejects reads over gaps and > 125 registers).
 * Read-only until checked on a real unit.
 *
 * Models:
 *   hybrid — SUN2000 KTL-L1 single-phase hybrid (default)
 *   three  — SUN2000 KTL-M0/M1/M2/M3 three-phase
 */
import { regsToAscii } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { HuaweiDriver, MODELS } from './driver.ts';

export { decodeInfo, decodeLive, derive, huaweiModel, HuaweiDriver, MODELS, timing } from './driver.ts';

/** Model name → model id: "…-L1" single-phase hybrid, "…-M0/M1/M2/M3" three-phase. */
export function modelFromName(name: string): string | undefined {
  if (/L1/i.test(name)) return 'hybrid';
  if (/M[0-3]/i.test(name)) return 'three';
  return undefined;
}

function text(regs: number[]) {
  return regsToAscii(regs).replace(/[^\x20-\x7e]/g, '').trim();
}

/**
 * Detect (read-only, at most 2 requests): reads holding 30000–30024 (model name ASCII + serial
 * ASCII) at unit 1; only if unit 1 doesn't answer at all, the same at unit 0 (the inverter's own
 * Modbus TCP; not tried on RS485, where 0 is broadcast). Accepts only a model name starting with
 * "SUN2000", which blank, 0x0000 and 0xFFFF data and every other brand's identity registers (all
 * below 0x1300 or at 20000/0xF800) can't give.
 */
export async function detectHuawei(conn: ModbusConnection): Promise<Detection | null> {
  // Unit 0 is broadcast on RS485 (no reply), so it is only tried over the network.
  const units = conn.target.type === 'rtu' ? [1] : [1, 0];
  for (const unit of units) {
    let regs: number[];
    try {
      regs = await conn.read(3, 30000, 25, unit);
    } catch {
      continue;
    }
    const model = text(regs.slice(0, 15));
    if (!/^SUN2000/i.test(model)) return null;
    const serial = text(regs.slice(15, 25));
    const parts = [`model ${model}`];
    if (/^[A-Za-z0-9]{6,}$/.test(serial)) parts.push(`serial ${serial}`);
    parts.push(`unit ${unit}`);
    return { modelId: modelFromName(model), evidence: parts.join(', '), address: unit };
  }
  return null;
}

export const huawei: InverterDriverDescriptor = {
  id: 'huawei',
  name: 'Huawei SUN2000',
  manufacturer: 'Huawei',
  transport: 'serial',
  defaultBaudRate: 9600,
  defaultAddress: 1,
  readOnly: true,
  models: MODELS.map(({ id, name }) => ({ id, name })),
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new HuaweiDriver(opts),
  detect: detectHuawei,
};

export const huaweiDrivers: InverterDriverDescriptor[] = [huawei];

export const HUAWEI_MODELS = MODELS.map((m) => m.id);
