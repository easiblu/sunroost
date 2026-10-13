/** What each Deye / Sunsynk model family provides to the shared driver. */
import type { Metrics } from '../../../core/metrics.ts';
import type { SocControl } from '../../types.ts';
import { decodeOne, decodeVersion, planTable, type RegDef, type RegisterImage } from './registers.ts';
import type { DeyeSetting } from './settings.ts';

export interface DeyeFamily {
  id: string;
  /** Model option text and "Model name" fallback. */
  name: string;
  /** Live holding registers read on every poll. */
  liveMap: RegDef[];
  /** Raw table values → Sunroost metrics. */
  derive(raw: Metrics): Metrics;
  settings: DeyeSetting[];
  socControl: SocControl | null;
}

/** Holding register 0: device type (same address on every family). UNVERIFIED for 0x0106. */
export const DEVICE_TYPES: Record<number, string> = {
  0x0002: 'string inverter',
  0x0003: 'single-phase hybrid',
  0x0004: 'micro inverter',
  0x0005: 'three-phase LV hybrid',
  0x0006: 'three-phase HV hybrid',
  0x0106: 'three-phase HV hybrid (20–50 kW)',
};

/**
 * Info block, read once on connect (holding 0–24, one request). Serial number 3–7 and rated power
 * 16–17 (0.1 W, low word first) are well established on every family; the firmware words 13/14 are
 * UNVERIFIED as to which board each belongs to.
 */
export const INFO_MAP: RegDef[] = [
  { addr: 0, metric: 'Device type', note: 'device type code (confident)' },
  { addr: 2, metric: 'Protocol version', note: 'Modbus protocol version (medium)' },
  { addr: 3, type: 'ascii', words: 5, metric: 'Serial number', note: '10 ASCII chars (confident)' },
  { addr: 13, metric: 'Control board version', note: 'UNVERIFIED: control board firmware, hex nibbles' },
  { addr: 14, metric: 'Communication board version', note: 'UNVERIFIED: comm board firmware, hex nibbles' },
  { addr: 16, type: 'u32le', scale: 0.1, metric: 'Rated power', note: 'rated power 0.1 W, low word first (confident)' },
];
export const INFO_SPAN: [number, number] = [0, 25];

export function decodeInfo(family: DeyeFamily, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': `Deye ${family.name}` };
  const get = (metric: string) => {
    const def = INFO_MAP.find((d) => d.metric === metric)!;
    return decodeOne(def, regs);
  };
  const sn = get('Serial number');
  if (typeof sn === 'string' && sn) out['Serial number'] = sn;
  const type = get('Device type');
  const rated = get('Rated power');
  if (typeof rated === 'number' && rated > 0 && rated < 100000) out['Max AC output power'] = Math.round(rated);
  if (typeof type === 'number' && DEVICE_TYPES[type]) {
    const kw = typeof rated === 'number' && rated > 0 ? ` ${Math.round(rated / 100) / 10} kW` : '';
    out['Model name'] = `Deye${kw} ${DEVICE_TYPES[type]}`;
  }
  const control = get('Control board version');
  const comm = get('Communication board version');
  if (typeof control === 'number' && control) out['Firmware version'] = decodeVersion(control);
  if (typeof comm === 'number' && comm) out['Secondary firmware version'] = decodeVersion(comm);
  const proto = get('Protocol version');
  if (typeof proto === 'number' && proto) out['Protocol version'] = decodeVersion(proto);
  return out;
}

/** Read requests for a family's live table. */
export function livePlan(family: DeyeFamily): [number, number][] {
  return planTable(family.liveMap);
}
