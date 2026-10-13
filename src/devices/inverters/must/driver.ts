/** The MUST Power Modbus driver (read-only) and its model families. */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';
import { ModbusConnection, parseConnection, type RegisterFunction } from '../../modbus.ts';
import type { DriverOptions, InverterDriver, SettingDef, SettingValues } from '../../types.ts';
import { decodeTable, has, image, num, type RegisterImage } from '../growatt/registers.ts';
import {
  decodeBits, decodeMustVersion, IDENTITY, IDENTITY_SPAN, MACHINE_TYPES, PH10_IDENTITY_SPAN, PH10_LIVE, PH1800_LIVE,
  PV1900_EXTRA, type RegDef,
} from './registers.ts';
import {
  decodeSettings, PH10_SETTING_SPANS, PH10_SETTINGS, PH1800_SETTING_SPANS, PH1800_SETTINGS, type MustSetting,
} from './settings.ts';

/** MUST's documented default RS485 address on PV/PH1800 units. */
export const DEFAULT_ADDRESS = 4;
export const DEFAULT_BAUD = 19200;

export interface MustBlock {
  start: number;
  count: number;
  /** Optional blocks may be missing on some firmware; a failure leaves their metrics out. */
  optional?: boolean;
}

export interface MustFamily {
  id: string;
  name: string;
  /** Exact blocks read on every poll (never merged: see the crash warning in registers.ts). */
  blocks: MustBlock[];
  liveMap: RegDef[];
  identity: [number, number];
  decodeInfo(regs: RegisterImage): Metrics;
  derive(raw: Metrics): Metrics;
  settings: MustSetting[];
  settingSpans: [number, number][];
}

const copy = (raw: Metrics, out: Metrics, from: string, to = from) => {
  if (raw[from] !== undefined) out[to] = raw[from];
};

/**
 * Battery from the raw power (assumed + = discharging, UNVERIFIED). The current register's scale is
 * unknown, so current is derived from power / voltage instead.
 */
function deriveBattery(raw: Metrics, out: Metrics) {
  if (!has(raw, 'Battery power raw')) return;
  const power = -num(raw, 'Battery power raw');
  out['Battery power'] = power;
  const v = num(out, 'Battery voltage');
  out['Battery current'] = v > 0 ? round(power / v, 1) : 0;
}

export function derivePh1800(raw: Metrics): Metrics {
  const out: Metrics = {};
  copy(raw, out, 'Work state', 'Device mode');
  // PV (single MPPT on PV/PH1800; PV19 adds a second one).
  const pv1 = num(raw, 'PV power');
  const v1 = num(raw, 'PV voltage');
  out['PV voltage 1'] = v1;
  out['PV power 1'] = pv1;
  out['PV current 1'] = v1 > 0 ? round(pv1 / v1, 1) : 0;
  let pv = pv1;
  if (has(raw, 'PV power 2 raw')) {
    const p2 = num(raw, 'PV power 2 raw');
    const v2 = num(raw, 'PV voltage 2 raw');
    out['PV voltage 2'] = v2;
    out['PV power 2'] = p2;
    out['PV current 2'] = v2 > 0 ? round(p2 / v2, 1) : 0;
    pv += p2;
  }
  out['PV power'] = pv;
  // Battery: inverter-side voltage, falling back to the charger's reading.
  if (has(raw, 'Battery voltage')) out['Battery voltage'] = raw['Battery voltage'];
  else copy(raw, out, 'Charger battery voltage', 'Battery voltage');
  deriveBattery(raw, out);
  copy(raw, out, 'Battery state of charge');
  copy(raw, out, 'Battery state of health');
  copy(raw, out, 'External temperature', 'Battery temperature');
  // Grid.
  copy(raw, out, 'Grid voltage');
  copy(raw, out, 'Grid frequency');
  copy(raw, out, 'Grid power raw', 'Grid power');
  // Load / output.
  copy(raw, out, 'Load power');
  copy(raw, out, 'Load apparent power');
  copy(raw, out, 'Load percentage');
  copy(raw, out, 'Inverter voltage', 'AC output voltage');
  copy(raw, out, 'Inverter frequency', 'AC output frequency');
  copy(raw, out, 'Bus voltage');
  const temps = ['AC heat sink temperature', 'Transformer temperature', 'DC heat sink temperature', 'Charger temperature']
    .filter((k) => has(raw, k))
    .map((k) => num(raw, k));
  if (temps.length) out.Temperature = Math.max(...temps);
  out['Fault code'] = decodeBits([
    { label: 'Inverter fault', word: num(raw, 'Inverter fault word 1'), offset: 0 },
    { label: 'Inverter fault', word: num(raw, 'Inverter fault word 2'), offset: 16 },
    { label: 'Charger fault', word: num(raw, 'Charger fault word'), offset: 0 },
  ]);
  return out;
}

export function derivePh10(raw: Metrics): Metrics {
  const out: Metrics = {};
  let pv = 0;
  for (const n of [1, 2, 3, 4]) {
    for (const k of ['PV voltage', 'PV current', 'PV power']) copy(raw, out, `${k} ${n}`);
    pv += num(raw, `PV power ${n}`);
  }
  out['PV power'] = pv;
  copy(raw, out, 'Battery voltage');
  if (has(raw, 'Battery power raw')) out['Battery power'] = -num(raw, 'Battery power raw');
  if (has(raw, 'Battery current raw')) out['Battery current'] = round(-num(raw, 'Battery current raw'), 1);
  copy(raw, out, 'Battery state of charge');
  copy(raw, out, 'Battery temperature');
  copy(raw, out, 'Grid frequency');
  copy(raw, out, 'Grid power raw', 'Grid power');
  for (const p of [1, 2, 3]) {
    copy(raw, out, `Grid voltage ${p}`);
    copy(raw, out, `Inverter voltage ${p}`, `AC output voltage ${p}`);
  }
  // The first phase doubles as the headline (unnumbered) value, as in the Deye three-phase driver.
  copy(raw, out, 'Grid voltage 1', 'Grid voltage');
  copy(raw, out, 'Inverter voltage 1', 'AC output voltage');
  copy(raw, out, 'Inverter frequency', 'AC output frequency');
  copy(raw, out, 'Load power');
  copy(raw, out, 'Load apparent power');
  copy(raw, out, 'Inverter temperature', 'Temperature');
  return out;
}

/** PV/PH1800 identity block → info metrics. */
function decodeIdentity(familyName: string, regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': `MUST ${familyName}` };
  const id = decodeTable(IDENTITY, regs);
  const type = num(id, 'Machine type');
  if (type > 0 && type < 0xffff) {
    const prefix = typeof id['Model prefix'] === 'string' && /^[A-Z]{2}$/.test(id['Model prefix']) ? id['Model prefix'] : '';
    out['Model name'] = `MUST ${prefix ? `${prefix}${type}` : (MACHINE_TYPES[type]?.name ?? String(type))}`;
  }
  const serial = num(id, 'Serial');
  if (serial > 0 && serial !== 0xffffffff) out['Serial number'] = String(serial);
  if (has(id, 'Software version raw') && num(id, 'Software version raw') !== 0xffff) {
    out['Firmware version'] = decodeMustVersion(num(id, 'Software version raw'));
  }
  return out;
}

/** PH11 three-phase: serial as three zero-padded 5-digit words (UNVERIFIED). */
function decodePh10Identity(regs: RegisterImage): Metrics {
  const out: Metrics = { 'Model name': 'MUST PH11 three-phase' };
  const w = [20001, 20002, 20003].map((a) => regs.get(a));
  if (w.every((x) => x !== undefined && x !== 0xffff) && w.some((x) => x !== 0)) {
    out['Serial number'] = w.map((x) => String(x).padStart(5, '0')).join('');
  }
  return out;
}

const PH1800_BLOCKS: MustBlock[] = [
  { start: 15201, count: 20 },
  { start: 25201, count: 79 },
];

export const ph1800: MustFamily = {
  id: 'ph1800',
  name: 'PV1800 / PH1800 / PV18 / PH18',
  blocks: PH1800_BLOCKS,
  liveMap: PH1800_LIVE,
  identity: IDENTITY_SPAN,
  decodeInfo: (regs) => decodeIdentity('PV1800/PH1800', regs),
  derive: derivePh1800,
  settings: PH1800_SETTINGS,
  settingSpans: PH1800_SETTING_SPANS,
};

export const pv1900: MustFamily = {
  ...ph1800,
  id: 'pv1900',
  name: 'PV19 EXP (PV1900, two MPPT)',
  blocks: [...PH1800_BLOCKS, { start: 113, count: 2, optional: true }, { start: 16205, count: 4, optional: true }],
  liveMap: [...PH1800_LIVE, ...PV1900_EXTRA],
  decodeInfo: (regs) => decodeIdentity('PV19 EXP', regs),
};

/**
 * EP3300 / PV33 TLV / PV3500: assumed to share the PV1800 block layout (one open-source reader decodes
 * PH3000/PV3500 with the same blocks; nobody has confirmed EP3300 TLV). Entirely UNVERIFIED.
 */
export const pv3300: MustFamily = {
  ...ph1800,
  id: 'pv3300',
  name: 'EP3300 / PV33 TLV / PV3500 (UNVERIFIED map)',
  decodeInfo: (regs) => decodeIdentity('EP3300/PV33 TLV', regs),
};

export const ph10: MustFamily = {
  id: 'ph10',
  name: 'PH10 / PH11 three-phase hybrid (PH1100)',
  blocks: [
    { start: 15104, count: 16 },
    { start: 25225, count: 115 },
  ],
  liveMap: PH10_LIVE,
  identity: PH10_IDENTITY_SPAN,
  decodeInfo: decodePh10Identity,
  derive: derivePh10,
  settings: PH10_SETTINGS,
  settingSpans: PH10_SETTING_SPANS,
};

export const FAMILIES: MustFamily[] = [ph1800, pv1900, pv3300, ph10];

/** Model id → family; unknown ids fall back to PV/PH1800 (the most common MUST protocol). */
export function mustFamily(modelId: string): MustFamily {
  return FAMILIES.find((f) => f.id === modelId) ?? ph1800;
}

export function decodeLive(family: MustFamily, regs: RegisterImage): Metrics {
  return family.derive(decodeTable(family.liveMap, regs));
}

/** Console helper: raw table values, identity and settings found inside a read range. */
export function decodeRange(family: MustFamily, fn: number, start: number, registers: number[]): Record<string, number | string> {
  if (fn !== 3) return {};
  const regs = image(start, registers);
  const out = { ...decodeTable(IDENTITY, regs), ...decodeTable(family.liveMap, regs) } as Record<string, number | string>;
  const values = decodeSettings(family.settings, regs);
  for (const s of family.settings) if (s.key in values) out[`${s.label} (unverified)`] = String(values[s.key]);
  return out;
}

export const READ_ONLY_MESSAGE = 'The MUST driver is read-only: settings are shown but cannot be changed until the register map is verified on hardware';

export class MustDriver implements InverterDriver {
  readonly family: MustFamily;
  private conn: ModbusConnection;
  private infoMetrics: Metrics;

  constructor(opts: DriverOptions) {
    this.family = mustFamily(opts.modelId);
    this.conn = new ModbusConnection(parseConnection(opts.connection, opts.baudRate || DEFAULT_BAUD, opts.address || DEFAULT_ADDRESS));
    this.infoMetrics = { 'Model name': `MUST ${this.family.name}` };
  }

  info(): Metrics {
    return { ...this.infoMetrics };
  }

  async connect() {
    await this.conn.connect();
    const regs: RegisterImage = new Map();
    try {
      const [start, count] = this.family.identity;
      image(start, await this.conn.read(3, start, count), regs);
    } catch {
      // Identity unreadable on this firmware: keep the family name.
    }
    this.infoMetrics = { ...this.infoMetrics, ...this.family.decodeInfo(regs) };
  }

  async close() {
    await this.conn.close();
  }

  async read(): Promise<Metrics> {
    const regs: RegisterImage = new Map();
    for (const b of this.family.blocks) {
      try {
        image(b.start, await this.conn.read(3, b.start, b.count), regs);
      } catch (err) {
        if (!b.optional) throw err;
      }
    }
    return decodeLive(this.family, regs);
  }

  settingDefs(): SettingDef[] {
    return this.family.settings.map(({ reg: _r, codec: _c, note: _n, ...d }) => ({ ...d, readOnly: true }));
  }

  async readSettings(): Promise<SettingValues> {
    const regs: RegisterImage = new Map();
    for (const [start, count] of this.family.settingSpans) {
      try {
        image(start, await this.conn.read(3, start, count), regs);
      } catch {
        // Unsupported range on this firmware: leave those settings blank.
      }
    }
    return decodeSettings(this.family.settings, regs);
  }

  async writeSetting(key: string, _value: Value): Promise<void> {
    const def = this.family.settings.find((d) => d.key === key);
    throw new Error(def ? `'${def.label}': ${READ_ONLY_MESSAGE}` : `Unknown setting: ${key}`);
  }

  rawRead(fn: number, start: number, count: number): Promise<number[]> {
    if (fn !== 3 && fn !== 4) return Promise.reject(new Error(`Unsupported function ${fn}`));
    return this.conn.read(fn as RegisterFunction, start, count);
  }

  rawWrite(_start: number, _values: number[]): Promise<void> {
    return Promise.reject(new Error(READ_ONLY_MESSAGE));
  }
}
