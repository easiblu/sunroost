/** Every available inverter and battery driver. Add new drivers here. */
import { emulatedBms } from './bms/emulated.ts';
import { serialBmsDrivers } from './bms/index.ts';
import { aforeDrivers } from './inverters/afore/index.ts';
import { deyeDrivers } from './inverters/deye/index.ts';
import { growattDrivers } from './inverters/growatt/index.ts';
import { livoltekDrivers } from './inverters/livoltek/index.ts';
import { midniteDrivers } from './inverters/midnite/index.ts';
import { senergyDrivers } from './inverters/senergy/index.ts';
import { solaxDrivers } from './inverters/solax/index.ts';
import { voltronicDrivers } from './inverters/voltronic/index.ts';
import { simulator } from './inverters/simulator.ts';
import { felicityDrivers } from './inverters/felicity/index.ts';
import { goodweDrivers } from './inverters/goodwe/index.ts';
import { huaweiDrivers } from './inverters/huawei/index.ts';
import { luxpowerDrivers } from './inverters/luxpower/index.ts';
import { megarevoDrivers } from './inverters/megarevo/index.ts';
import { mustDrivers } from './inverters/must/index.ts';
import { sigenergyDrivers } from './inverters/sigenergy/index.ts';
import { solisDrivers } from './inverters/solis/index.ts';
import { srneDrivers } from './inverters/srne/index.ts';
import { sumryDrivers } from './inverters/sumry/index.ts';
import { sungrowDrivers } from './inverters/sungrow/index.ts';
import { victronDrivers } from './inverters/victron/index.ts';
import type { BmsDriverDescriptor, InverterDriverDescriptor } from './types.ts';

// Dropdown order; the simulator is last.
export const INVERTER_DRIVERS: InverterDriverDescriptor[] = [
  ...deyeDrivers, ...growattDrivers, ...felicityDrivers, ...goodweDrivers, ...huaweiDrivers, ...luxpowerDrivers, ...megarevoDrivers, ...mustDrivers, ...sigenergyDrivers, ...solisDrivers, ...srneDrivers, ...sumryDrivers, ...sungrowDrivers, ...victronDrivers, ...solaxDrivers, ...aforeDrivers, ...livoltekDrivers, ...senergyDrivers, ...midniteDrivers, ...voltronicDrivers, simulator,
];

/** "inverter" (read battery data from the inverter) is the default and has no driver. */
export const BMS_DRIVERS: BmsDriverDescriptor[] = [emulatedBms, ...serialBmsDrivers];

export const inverterDriver = (id: string) => INVERTER_DRIVERS.find((d) => d.id === id) ?? null;
export const bmsDriver = (id: string) => BMS_DRIVERS.find((d) => d.id === id) ?? null;
