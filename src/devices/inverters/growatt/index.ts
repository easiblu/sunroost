/**
 * Growatt inverters over Modbus RTU (RS232/RS485/USB) or Modbus TCP (connection "host:port").
 * One descriptor; the model picks the register family:
 *   spf  — SPF off-grid (SPF 3000TL / 5000ES / 6000ES)
 *   sph  — SPH single-phase hybrid (and SPA AC-coupled)
 *   sph3 — SPH TL3 three-phase hybrid
 *   tlxh — MIN TL-XH / MOD XH hybrid (3000-range register map)
 *   tlx  — MIN TL-X grid-tie, no battery
 *   wit  — WIT three-phase commercial hybrid (read-only)
 */
import { plausibleId, regsToAscii } from '../../ascii.ts';
import type { InverterDriverDescriptor } from '../../types.ts';
import { FAMILIES, GrowattDriver, growattFamily, READ_ONLY_FAMILIES } from './driver.ts';

export { decodeInputs, decodeRange, FAMILIES, GrowattDriver, growattFamily, READ_ONLY_FAMILIES } from './driver.ts';

export const growatt: InverterDriverDescriptor = {
  id: 'growatt',
  name: 'Growatt',
  manufacturer: 'Growatt',
  transport: 'serial',
  defaultBaudRate: 9600,
  models: [
    { id: 'spf', name: 'SPF off-grid (SPF 3000TL / 5000ES / 6000ES)' },
    { id: 'sph', name: 'SPH single-phase hybrid (also SPA)' },
    { id: 'sph3', name: 'SPH TL3 three-phase hybrid' },
    { id: 'tlxh', name: 'MIN TL-XH / MOD XH hybrid' },
    { id: 'tlx', name: 'MIN TL-X grid-tie (no battery)' },
    { id: 'wit', name: 'WIT three-phase hybrid (commercial)' },
  ],
  readOnlyModels: [...READ_ONLY_FAMILIES],
  consoleFunctions: [
    { id: '4', name: 'Input register' },
    { id: '3', name: 'Holding register' },
  ],
  socControl: (model) => growattFamily(model).socControl,
  protectionSetting: (model) => growattFamily(model).protection,
  create: (opts) => new GrowattDriver(opts),
  // Holding 9–11 firmware and 23–27 serial, both ASCII, on every Growatt protocol. The register
  // layout doesn't say which family, so the model is left to the user.
  async detect(conn) {
    const fw = regsToAscii(await conn.read(3, 9, 3));
    const sn = regsToAscii(await conn.read(3, 23, 5));
    if (!plausibleId(sn) || !plausibleId(fw, 2)) return null;
    // Device type code (holding 43): 5600–5603 is only ever a WIT. Other codes don't pin a family.
    let dtc: number | undefined;
    try {
      dtc = (await conn.read(3, 43, 1))[0];
    } catch {}
    const wit = dtc !== undefined && dtc >= 5600 && dtc <= 5603;
    return { modelId: wit ? 'wit' : undefined, evidence: `firmware ${fw}, serial ${sn}${wit ? `, WIT (DTC ${dtc})` : ''}` };
  },
};

export const growattDrivers: InverterDriverDescriptor[] = [growatt];

/** Family ids, for tests and the console. */
export const GROWATT_MODELS = FAMILIES.map((f) => f.id);
