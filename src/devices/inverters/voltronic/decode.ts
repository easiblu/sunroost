/**
 * Decoders for Voltronic query replies (payloads without '(' and CRC), as declarative field tables.
 * Field positions follow the public PI30 ("Axpert") protocol; lines marked UNVERIFIED are from
 * later/variant documents and have not been checked against a real unit.
 */
import { round, type Metrics, type Value } from '../../../core/metrics.ts';

const fields = (payload: string) => payload.trim().split(/\s+/).filter(Boolean);
const num = (s: string | undefined) => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

interface FieldDef {
  index: number;
  name: string;
  /** Kept as text (bit strings, version codes). */
  text?: boolean;
  note?: string;
}

/** QPIGS: general status. Raw field names, used by the console and by `decodeStatus`. */
export const QPIGS_FIELDS: FieldDef[] = [
  { index: 0, name: 'Grid voltage' },
  { index: 1, name: 'Grid frequency' },
  { index: 2, name: 'AC output voltage' },
  { index: 3, name: 'AC output frequency' },
  { index: 4, name: 'Load apparent power' },
  { index: 5, name: 'Load power' },
  { index: 6, name: 'Load percentage' },
  { index: 7, name: 'Bus voltage' },
  { index: 8, name: 'Battery voltage' },
  { index: 9, name: 'Battery charge current' },
  { index: 10, name: 'Battery state of charge' },
  { index: 11, name: 'Temperature', note: 'Inverter heat sink temperature' },
  { index: 12, name: 'PV current 1', note: 'PV input current (battery side on older units)' },
  { index: 13, name: 'PV voltage 1' },
  { index: 14, name: 'Battery voltage from SCC' },
  { index: 15, name: 'Battery discharge current' },
  { index: 16, name: 'Device status', text: true, note: 'bits b7..b0' },
  { index: 17, name: 'Battery voltage offset for fans' },
  { index: 18, name: 'EEPROM version', text: true },
  { index: 19, name: 'PV power 1', note: 'PV charging power (W); missing on early firmware' },
  { index: 20, name: 'Device status 2', text: true, note: 'bits b10..b8' },
];

/** QPIGS2 (Axpert MAX / King second MPPT). UNVERIFIED beyond the first three fields. */
export const QPIGS2_FIELDS: FieldDef[] = [
  { index: 0, name: 'PV current 2' },
  { index: 1, name: 'PV voltage 2' },
  { index: 2, name: 'PV power 2' },
];

/** Device status bits from QPIGS field 16 (b7..b0, left to right). */
export interface StatusBits {
  sbuPriorityVersion: boolean;
  configChanged: boolean;
  sccFirmwareUpdated: boolean;
  loadOn: boolean;
  batteryVoltageSteady: boolean;
  charging: boolean;
  sccCharging: boolean;
  acCharging: boolean;
}

export function statusBits(text: string | undefined): StatusBits {
  const b = (i: number) => (text ?? '')[i] === '1';
  return {
    sbuPriorityVersion: b(0), configChanged: b(1), sccFirmwareUpdated: b(2), loadOn: b(3),
    batteryVoltageSteady: b(4), charging: b(5), sccCharging: b(6), acCharging: b(7),
  };
}

/** Raw QPIGS / QPIGS2 values keyed by field name. */
export function decodeFields(defs: FieldDef[], payload: string): Record<string, Value> {
  const f = fields(payload);
  const out: Record<string, Value> = {};
  for (const d of defs) {
    if (f[d.index] === undefined) continue;
    out[d.name] = d.text ? f[d.index] : num(f[d.index]) ?? f[d.index];
  }
  return out;
}

/**
 * QPIGS (+ optional QPIGS2) → Sunroost metrics.
 *
 * Grid power is an estimate: Voltronic off-grid units report no grid power. In Line mode the grid
 * feeds the load (bypass) plus whatever the AC charger puts into the battery beyond the PV charge;
 * in any other mode it is 0.
 */
export function decodeStatus(qpigs: string, mode: string | null, qpigs2?: string | null): Metrics {
  const f = fields(qpigs);
  if (f.length < 16) throw new Error(`QPIGS reply too short (${f.length} fields)`);
  const v = (i: number) => num(f[i]) ?? 0;
  const bits = statusBits(f[16]);

  const battV = v(8);
  const battI = round(v(9) - v(15), 1);
  const battP = Math.round(battV * battI);
  const pvV1 = v(13);
  const pvI1 = v(12);
  // Field 19 (PV charging power) where present; otherwise PV current × SCC battery voltage, because on
  // early firmware field 12 is the charger's battery-side current.
  const pvP1 = f[19] !== undefined && num(f[19]) !== null ? v(19) : Math.round(pvI1 * (v(14) || battV));

  const m: Metrics = {
    'Grid voltage': v(0),
    'Grid frequency': v(1),
    'AC output voltage': v(2),
    'AC output frequency': v(3),
    'Load apparent power': v(4),
    'Load power': v(5),
    'Load percentage': v(6),
    'Bus voltage': v(7),
    'Battery voltage': battV,
    'Battery current': battI,
    'Battery power': battP,
    'Battery state of charge': v(10),
    Temperature: v(11),
    'PV current 1': pvI1,
    'PV voltage 1': pvV1,
    'PV power 1': pvP1,
  };

  let pvTotal = pvP1;
  if (qpigs2) {
    const g = fields(qpigs2);
    const i2 = num(g[0]);
    const v2 = num(g[1]);
    const p2 = num(g[2]);
    if (i2 !== null && v2 !== null) {
      const pv2 = p2 ?? Math.round(i2 * v2);
      m['PV current 2'] = i2;
      m['PV voltage 2'] = v2;
      m['PV power 2'] = pv2;
      pvTotal += pv2;
    }
  }
  m['PV power'] = pvTotal;

  const acCharge = bits.acCharging && battP > 0 ? Math.max(0, battP - pvTotal) : 0;
  m['Grid power'] = mode === 'Grid' ? Math.round(v(5) + acCharge) : 0;
  if (mode) m['Device mode'] = mode;
  return m;
}

/** QMOD letter → Sunroost device mode. D/Y/E/C appear on newer/variant firmware (UNVERIFIED). */
export const MODES: Record<string, string> = {
  P: 'Power on',
  S: 'Standby',
  L: 'Grid',
  B: 'Solar/Battery',
  F: 'Fault',
  H: 'Power saving',
  D: 'Shutdown',
  Y: 'Bypass',
  E: 'Eco',
  C: 'Charging',
};

export function decodeMode(payload: string): string {
  const letter = payload.trim().charAt(0);
  return MODES[letter] ?? `Unknown (${letter})`;
}

/** QPIWS bit positions a0..a31 (PI30). Bits 1–4, 7, 8, 18–24 are faults; the rest warnings. */
export const WARNINGS: (string | null)[] = [
  null, 'Inverter fault', 'Bus over', 'Bus under', 'Bus soft fail', 'Line fail', 'OPV short',
  'Inverter voltage too low', 'Inverter voltage too high', 'Over temperature', 'Fan locked',
  'Battery voltage high', 'Battery low alarm', null, 'Battery under shutdown', null, 'Overload',
  'EEPROM fault', 'Inverter over current', 'Inverter soft fail', 'Self test fail', 'OP DC voltage over',
  'Battery open', 'Current sensor fail', 'Battery short', 'Power limit', 'PV voltage high',
  'MPPT overload fault', 'MPPT overload warning', 'Battery too low to charge', null, null,
];

/** Active warnings as text; "" when none. */
export function decodeWarnings(payload: string): string {
  const bits = payload.trim().replace(/[^01]/g, '');
  const active: string[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    active.push(WARNINGS[i] ?? `Warning ${i}`);
  }
  return active.join(', ');
}

/** QPIRI field positions (PI30). 23+ only on MKS/King/MAX (UNVERIFIED there). */
export const QPIRI_FIELDS: FieldDef[] = [
  { index: 0, name: 'Grid rating voltage' },
  { index: 1, name: 'Grid rating current' },
  { index: 2, name: 'AC output rating voltage' },
  { index: 3, name: 'AC output rating frequency' },
  { index: 4, name: 'AC output rating current' },
  { index: 5, name: 'AC output rating apparent power' },
  { index: 6, name: 'AC output rating active power' },
  { index: 7, name: 'Battery rating voltage' },
  { index: 8, name: 'Battery re-charge voltage' },
  { index: 9, name: 'Battery under voltage' },
  { index: 10, name: 'Battery bulk voltage' },
  { index: 11, name: 'Battery float voltage' },
  { index: 12, name: 'Battery type', text: true },
  { index: 13, name: 'Max AC charging current' },
  { index: 14, name: 'Max charging current' },
  { index: 15, name: 'Input voltage range', text: true },
  { index: 16, name: 'Output source priority', text: true },
  { index: 17, name: 'Charger source priority', text: true },
  { index: 18, name: 'Parallel max num' },
  { index: 19, name: 'Machine type', text: true },
  { index: 20, name: 'Topology', text: true },
  { index: 21, name: 'Output mode', text: true },
  { index: 22, name: 'Battery re-discharge voltage' },
  { index: 23, name: 'PV OK condition for parallel', text: true },
  { index: 24, name: 'PV power balance', text: true },
  { index: 25, name: 'Max charging time at CV stage' },
  { index: 26, name: 'Operation logic', text: true },
];

export const MACHINE_TYPES: Record<string, string> = { '00': 'Grid tie', '01': 'Off grid', '10': 'Hybrid' };
export const TOPOLOGIES: Record<string, string> = { '0': 'Transformerless', '1': 'Transformer' };

/** Info metrics taken from QPIRI. */
export function decodeRatingInfo(payload: string): Metrics {
  const f = fields(payload);
  const out: Metrics = {};
  if (num(f[6]) !== null) out['Max AC output power'] = num(f[6]);
  if (num(f[5]) !== null) out['Max AC output apparent power'] = num(f[5]);
  if (num(f[7]) !== null) out['Nominal battery voltage'] = num(f[7]);
  if (num(f[0]) !== null) out['Expected AC input voltage'] = num(f[0]);
  if (f[18] !== undefined) out['Max parallel units'] = num(f[18]);
  if (f[19] !== undefined) out['Machine type'] = MACHINE_TYPES[f[19]] ?? f[19];
  if (f[20] !== undefined) out['Topology'] = TOPOLOGIES[f[20]] ?? f[20];
  return out;
}

/** QFLAG letters (PI30). Reply looks like "EakxyzDbjuv": enabled after E, disabled after D. */
export const FLAG_LETTERS: Record<string, string> = {
  a: 'Buzzer',
  b: 'Overload bypass',
  j: 'Power saving',
  k: 'LCD reset to default',
  u: 'Overload restart',
  v: 'Over temperature restart',
  x: 'LCD backlight',
  y: 'Primary source interrupt alarm',
  z: 'Record fault code',
};

export function decodeFlags(payload: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let enabled: boolean | null = null;
  for (const ch of payload.trim()) {
    if (ch === 'E') enabled = true;
    else if (ch === 'D') enabled = false;
    else if (enabled !== null && /[a-z]/.test(ch)) out[ch] = enabled;
  }
  return out;
}

/** QMCHGCR / QMUCHGCR: the selectable charge currents, e.g. "010 020 030" → ["10","20","30"]. */
export function decodeCurrentList(payload: string): string[] {
  return fields(payload)
    .map((s) => num(s))
    .filter((n): n is number => n !== null && n >= 0)
    .map((n) => String(n));
}

/** Known commands offered by the console, with a one-line description. */
export const KNOWN_COMMANDS: { command: string; name: string }[] = [
  { command: 'QPI', name: 'Protocol ID' },
  { command: 'QID', name: 'Serial number' },
  { command: 'QVFW', name: 'Main CPU firmware version' },
  { command: 'QVFW2', name: 'Secondary CPU firmware version' },
  { command: 'QMN', name: 'Model name' },
  { command: 'QGMN', name: 'General model number' },
  { command: 'QPIRI', name: 'Rating information / settings' },
  { command: 'QFLAG', name: 'Flag status' },
  { command: 'QPIGS', name: 'General status' },
  { command: 'QPIGS2', name: 'General status, second MPPT' },
  { command: 'QMOD', name: 'Device mode' },
  { command: 'QPIWS', name: 'Warning status' },
  { command: 'QDI', name: 'Default settings' },
  { command: 'QMCHGCR', name: 'Selectable max charging currents' },
  { command: 'QMUCHGCR', name: 'Selectable max utility charging currents' },
  { command: 'QBOOT', name: 'DSP bootstrap' },
  { command: 'QOPM', name: 'Output mode' },
  { command: 'QPGS0', name: 'Parallel information, unit 0' },
  { command: 'QBV', name: 'Battery voltage compensated (UNVERIFIED)' },
];

/** Console helper: decodes a reply to a known query into name → value rows. */
export function decodeReply(command: string, payload: string): Record<string, Value> | undefined {
  const cmd = command.trim().toUpperCase();
  if (/^(NAK|ACK)/.test(payload)) return undefined;
  switch (cmd) {
    case 'QPIGS': {
      const raw = decodeFields(QPIGS_FIELDS, payload);
      const bits = statusBits(String(raw['Device status'] ?? ''));
      return {
        ...raw,
        'Load on': bits.loadOn,
        Charging: bits.charging,
        'SCC charging': bits.sccCharging,
        'AC charging': bits.acCharging,
      };
    }
    case 'QPIGS2':
      return decodeFields(QPIGS2_FIELDS, payload);
    case 'QPIRI':
      return decodeFields(QPIRI_FIELDS, payload);
    case 'QMOD':
      return { 'Device mode': decodeMode(payload) };
    case 'QPIWS':
      return { Warnings: decodeWarnings(payload) || 'None' };
    case 'QFLAG': {
      const out: Record<string, Value> = {};
      for (const [letter, on] of Object.entries(decodeFlags(payload))) out[FLAG_LETTERS[letter] ?? letter] = on;
      return out;
    }
    case 'QMCHGCR':
    case 'QMUCHGCR':
      return { Options: decodeCurrentList(payload).join(', ') };
    case 'QID':
      return { 'Serial number': payload.trim() };
    case 'QPI':
      return { 'Protocol version': payload.trim() };
    case 'QVFW':
    case 'QVFW2':
      return { 'Firmware version': payload.replace(/^VERFW\d?:/, '').trim() };
    default:
      return undefined;
  }
}
