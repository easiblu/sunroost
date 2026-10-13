/**
 * Voltronic / Axpert family over the public Voltronic ASCII protocol (PI30). Also sold as MPP Solar,
 * EASUN, PowMr, Mecer, Kodak and others. Connection: USB-serial / RS232 at 2400 8N1, or USB HID
 * (any connection path containing "hidraw").
 */
import type { InverterDriverDescriptor } from '../../types.ts';
import { MODEL_NAMES, VoltronicDriver, voltronicModel } from './driver.ts';

export { decodeReply, KNOWN_COMMANDS } from './decode.ts';
export { VoltronicDriver, voltronicDefaults } from './driver.ts';

export const voltronic: InverterDriverDescriptor = {
  id: 'voltronic',
  name: 'Voltronic, Axpert, MPP, Infini, etc.',
  manufacturer: 'Voltronic',
  transport: 'serial',
  defaultBaudRate: 2400,
  readOnlyModels: ['infinisolar'],
  models: Object.entries(MODEL_NAMES).map(([id, name]) => ({ id, name })),
  // Read-only on InfiniSolar (UNVERIFIED), so no SOC control there.
  socControl: (model) =>
    voltronicModel(model) === 'infinisolar'
      ? null
      : { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' },
  // Spec §3.6 variant 1 raises "Shutdown battery voltage" to cut the output. A fixed raise is not
  // safe without knowing the bank (12/24/48 V, lithium vs lead-acid) and the inverter may NAK or
  // re-enable output at once, so it is not offered.
  protectionSetting: () => null,
  create: (opts) => new VoltronicDriver(opts),
};

export const voltronicDrivers: InverterDriverDescriptor[] = [voltronic];
