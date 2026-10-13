/**
 * "USB Voltronic LIB RS485": the lithium-battery (LIB) RS485 protocol Voltronic/Axpert-compatible
 * batteries speak to the inverter — Felicity Solar LPBF, Giter, BlueNova, Hubble X-100 RS485,
 * Freedom Won, Upower. The LIB console runs Modbus queries against this driver at
 * addresses 0–16, so it is Modbus RTU underneath; packs sit at dip addresses 1..n.
 *
 * EXPERIMENTAL: there is no public spec. The register map below is the Felicity battery map as
 * shared by the community (function 3, 9600 8N1) and every address/scale is [verify]:
 *   0x1302 status bits · 0x1303 fault bits · 0x1304 warning bits · 0x1306 pack V (10 mV) ·
 *   0x1307 current (100 mA, signed, + = charging) · 0x1308 temperature (°C) · 0x130A SOC (%) ·
 *   0x130B SOH (%)
 *   0x131C charge voltage limit (10 mV) · 0x131D discharge voltage limit · 0x131E max charge
 *   current (100 mA) · 0x131F max discharge current (100 mA)
 *   0x132A–0x1339 cells 1–16 (mV) · 0x133A–0x133D cell temperatures 1–4 (°C)
 *   0x1340 cycles · 0x1341 remaining (10 mAh) · 0x1342 full (10 mAh) · 0x1343 design (10 mAh)
 *
 * Models Default, Full, FullHD and Minimal: we map them to how many register
 * blocks are read each poll (Minimal: basics only … FullHD: everything). The Felicity and Giter
 * presets read the Full set; Giter keeps scanning past empty addresses because its dip scheme
 * (first pack 2+4, last 1+2+4, others 4) doesn't give consecutive addresses.
 *
 * Replies are checked for plausibility; when nothing valid answers, the error points the user at
 * Diagnostics › Serial inspect to capture the inverter↔battery traffic.
 */
import { settings } from '../../core/settings.ts';
import type { BmsDriverDescriptor } from '../types.ts';
import { bitNames, type PackReading } from './pack.ts';
import { ModbusPackScanner, modbusBus, noConnectionBus, type Block, type RegisterBus, type RegisterMap, type Regs } from './modbus-bms.ts';

const BASIC: Block = { fn: 3, start: 0x1302, count: 10 };
const LIMITS: Block = { fn: 3, start: 0x131c, count: 4, optional: true };
const CELLS: Block = { fn: 3, start: 0x132a, count: 20, optional: true };
const CAPACITY: Block = { fn: 3, start: 0x1340, count: 4, optional: true };

export type LibDetail = 'minimal' | 'default' | 'full' | 'fullhd';

export const LIB_BLOCKS: Record<LibDetail, Block[]> = {
  minimal: [BASIC],
  default: [BASIC, CELLS],
  full: [BASIC, CELLS, LIMITS],
  fullhd: [BASIC, CELLS, LIMITS, CAPACITY],
};

export interface LibModel {
  id: string;
  name: string;
  detail: LibDetail;
  stopAtGap: boolean;
}

export const LIB_MODELS: LibModel[] = [
  { id: 'default', name: 'Default', detail: 'default', stopAtGap: true },
  { id: 'full', name: 'Full', detail: 'full', stopAtGap: true },
  { id: 'fullhd', name: 'FullHD', detail: 'fullhd', stopAtGap: true },
  { id: 'minimal', name: 'Minimal', detail: 'minimal', stopAtGap: true },
  { id: 'felicity', name: 'Felicity Solar LPBF (experimental)', detail: 'full', stopAtGap: true },
  { id: 'giter', name: 'Giter (experimental)', detail: 'full', stopAtGap: false },
];

export const libModel = (id: string) => LIB_MODELS.find((m) => m.id === id) ?? LIB_MODELS[0];

const FAULT_BITS = [
  'Cell over voltage',
  'Cell under voltage',
  'Charge over current',
  'Discharge over current',
  'Over temperature',
  'Under temperature',
  'Short circuit',
  'BMS fault',
];

const temp = (v: number | undefined) => (v === undefined || v < -40 || v > 120 ? undefined : v);

export function libMap(detail: LibDetail): RegisterMap {
  return {
    blocks: LIB_BLOCKS[detail],
    decode(r: Regs): PackReading {
      const ah = (a: number) => {
        const v = r.u16(a);
        return v ? v / 100 : undefined;
      };
      const tenthA = (a: number) => {
        const v = r.u16(a);
        return v ? v / 10 : undefined;
      };
      const cellTemps = r.list(0x133a, 4, (x, a) => temp(x.s16(a)));
      return {
        voltage: (r.u16(0x1306) ?? NaN) / 100,
        current: (r.s16(0x1307) ?? NaN) / 10,
        temperature: cellTemps.length ? undefined : temp(r.s16(0x1308)),
        soc: r.u16(0x130a),
        soh: r.u16(0x130b) || undefined,
        alarms: [...bitNames(r.u16(0x1303) ?? 0, FAULT_BITS), ...bitNames(r.u16(0x1304) ?? 0, FAULT_BITS)],
        maxChargeCurrent: tenthA(0x131e),
        maxDischargeCurrent: tenthA(0x131f),
        cells: r.list(0x132a, 16, (x, a) => (x.u16(a) ? x.u16(a)! / 1000 : undefined)),
        temperatures: cellTemps,
        cycles: r.u16(0x1340),
        remainingAh: ah(0x1341),
        fullAh: ah(0x1342),
        designAh: ah(0x1343),
      };
    },
  };
}

export const INSPECT_HINT =
  'This battery protocol is experimental; capture the inverter↔battery traffic with Diagnostics › Serial inspect (/diagnostic/serial/inspect) and share the trace so the map can be fixed';

/** LIB batteries are low-voltage (48 V class) packs: reject anything outside 20–70 V. */
export function validateLib(r: PackReading, address: number) {
  const fail = (what: string) => new Error(`Voltronic LIB: unexpected response from address ${address} (${what}). ${INSPECT_HINT}`);
  if (r.voltage === undefined || !(r.voltage >= 20 && r.voltage <= 70)) throw fail(`voltage ${r.voltage}`);
  if (r.soc === undefined || r.soc > 100) throw fail(`state of charge ${r.soc}`);
  if (Math.abs(r.current ?? 0) > 1000) throw fail(`current ${r.current}`);
  if (r.cells?.some((v) => !(v > 1 && v < 5))) throw fail('cell voltages');
}

export function createVoltronicLib(opts: { connection: string; baudRate: number; modelId: string; maxPacks?: number; bus?: RegisterBus }) {
  const model = libModel(opts.modelId);
  const bus = opts.bus ?? (opts.connection ? modbusBus(opts.connection, opts.baudRate) : noConnectionBus());
  const maxPacks = opts.maxPacks ?? 16;
  return new ModbusPackScanner(bus, {
    label: 'Voltronic LIB',
    map: libMap(model.detail),
    startAddress: 1,
    maxPacks,
    stopAtGap: model.stopAtGap,
    validate: validateLib,
    noPacks: (err) => {
      const why = err instanceof Error ? err.message.replace(/\s*This battery protocol is experimental.*$/, '') : 'no reply';
      return new Error(`Voltronic LIB: no valid battery reply at addresses 1–${maxPacks} (${why}). ${INSPECT_HINT}`);
    },
  });
}

export const voltronicLibDriver: BmsDriverDescriptor = {
  id: 'voltronic_lib',
  name: 'USB Voltronic LIB RS485',
  transport: 'serial',
  defaultBaudRate: 9600,
  multiConnection: false,
  models: LIB_MODELS.map(({ id, name }) => ({ id, name })),
  create: ({ connections, baudRate, modelId }) =>
    createVoltronicLib({ connection: connections[0] ?? '', baudRate, modelId, maxPacks: settings.get('bms.maximum_pack_count') }),
};
