/**
 * Megarevo-protocol hybrids (Megarevo and its OEMs Amensolar and Vestwoods) plus INVT XD-TL, over
 * Modbus RTU (RS485, 9600 8N1, address 1), Modbus TCP ("host:port") or a Solarman WiFi logger
 * ("solarman://ip/serial"). All reads use function 3. Read-only: nothing is written. Models:
 *   hybrid  — Megarevo single-phase hybrid (R-KL1); grid/load on phase B
 *   split   — Megarevo split-phase hybrid (R-KLNA, Amensolar N3H-X, Vestwoods R8KL1NA); L1 = A, L2 = B
 *   three   — Megarevo three-phase hybrid (R-KH3)
 *   invt_xd — INVT XD-TL single-phase hybrid (INVT's own register map)
 */
import { plausibleId } from '../../ascii.ts';
import type { ModbusConnection } from '../../modbus.ts';
import type { Detection, InverterDriverDescriptor } from '../../types.ts';
import { FAMILIES, MegarevoDriver } from './driver.ts';
import { flexAscii } from './family.ts';
import { MEGAREVO_INFO_SPAN, megarevoVersion, modelFromText } from './megarevo.ts';

export { decodeInfo, decodeLive, FAMILIES, MegarevoDriver, megarevoFamily, READ_ONLY_ERROR } from './driver.ts';

const blank = (words: number[]) => words.every((w) => w === 0) || words.every((w) => w === 0xffff);

/** Megarevo info block: serial 0x1234 (6 regs ASCII), model 0x121C (10 regs), LCD version 0x1215. */
async function detectMegarevo(conn: ModbusConnection): Promise<Detection | null> {
  const [start, count] = MEGAREVO_INFO_SPAN;
  const regs = await conn.read(3, start, count);
  const at = (addr: number, n: number) => regs.slice(addr - start, addr - start + n);
  const snWords = at(0x1234, 6);
  if (blank(snWords)) return null;
  const sn = flexAscii(snWords);
  if (!plausibleId(sn)) return null;
  const modelWords = at(0x121c, 10);
  const model = blank(modelWords) ? '' : flexAscii(modelWords);
  const modelId = plausibleId(model, 3) ? modelFromText(model) : undefined;
  const fw = regs[0];
  const parts = [model && plausibleId(model, 3) ? `model ${model}` : '', `serial ${sn}`];
  if (fw && fw !== 0xffff) parts.push(`firmware ${megarevoVersion(fw)}`);
  return { modelId, evidence: `Megarevo ${parts.filter(Boolean).join(', ')}` };
}

/** INVT block 0x3000–0x307C: serial 0x3001 (16 regs), model recognition 0x3068 = 1 (hybrid), model 0x306D. */
async function detectInvt(conn: ModbusConnection): Promise<Detection | null> {
  const regs = await conn.read(3, 0x3000, 0x7d);
  const snWords = regs.slice(1, 17);
  if (blank(snWords) || regs[0x68] !== 1) return null;
  const sn = flexAscii(snWords);
  if (!plausibleId(sn)) return null;
  const model = flexAscii(regs.slice(0x6d, 0x7d));
  const kw = regs[0] > 0 && regs[0] < 2000 ? `, ${regs[0] / 10} kW` : '';
  return { modelId: 'invt_xd', evidence: `INVT hybrid${plausibleId(model, 3) ? ` ${model}` : ''}${kw}, serial ${sn}` };
}

export const megarevo: InverterDriverDescriptor = {
  id: 'megarevo',
  name: 'Megarevo, INVT, Amensolar, Vestwoods',
  manufacturer: 'Megarevo',
  readOnly: true,
  transport: 'serial',
  defaultBaudRate: 9600,
  models: [
    { id: 'hybrid', name: 'Megarevo single-phase hybrid (R-KL1)' },
    { id: 'split', name: 'Megarevo split-phase hybrid (R-KLNA, Amensolar N3H, Vestwoods)' },
    { id: 'three', name: 'Megarevo three-phase hybrid (R-KH3)' },
    { id: 'invt_xd', name: 'INVT XD-TL hybrid' },
  ],
  consoleFunctions: [{ id: '3', name: 'Holding register' }],
  socControl: () => null,
  protectionSetting: () => null,
  create: (opts) => new MegarevoDriver(opts),
  // At most two read-only requests: the Megarevo info block, then the INVT info block. Neither
  // range overlaps Deye's (holding 0–7) or Growatt's (holding 9–27) identifying registers.
  async detect(conn) {
    try {
      const r = await detectMegarevo(conn);
      if (r) return r;
    } catch {
      // Exception / no answer for 0x1215: maybe an INVT.
    }
    return detectInvt(conn);
  },
};

export const megarevoDrivers: InverterDriverDescriptor[] = [megarevo];

/** Model ids, for tests and the catalogue. */
export const MEGAREVO_MODELS = FAMILIES.map((f) => f.id);
