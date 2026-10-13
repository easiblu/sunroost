/**
 * Megarevo hybrid protocol (Megarevo R-KL1 / R-KLNA / R-KH3, Amensolar N3H-X, Vestwoods R8KL1NA …).
 * Modbus RTU 9600 8N1, address 1; every register is a holding register read with function 3.
 *
 * Source: Megarevo "Hybrid Inverter Modbus Protocol" spreadsheet V01 (sheets "Info" and "Data"),
 * cross-checked against the community ha-solarman "megarevo_r-3h" definition (tested by its author
 * on an R15K3H). Rows say "confident" where the vendor document and the community map agree on
 * address, scale and type; everything else says UNVERIFIED. No row has been checked on hardware by
 * this project.
 *
 * Phases (vendor note): single-phase units report grid and load on phase B; North-American
 * split-phase units report L1 on phase A and L2 on phase B; three-phase units use A/B/C.
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { has, num } from '../growatt/registers.ts';
import { bitNames, type AsciiField, type MegarevoFamily, type RegDef } from './family.ts';
import { MEGAREVO_SETTINGS } from './settings.ts';

const PHASES = ['A', 'B', 'C'] as const;
type Phase = (typeof PHASES)[number];

/** 0x3104 bits 0–4: system state. Vendor document (confident on meaning, UNVERIFIED on hardware). */
export const SYSTEM_STATE: Record<number, string> = {
  0: 'Initializing', 1: 'Standby', 2: 'PV grid', 3: 'Battery grid', 4: 'Hybrid', 5: 'Grid charging',
  6: 'PV charging', 7: 'Bypass', 8: 'Fault', 9: 'Self-check', 10: 'Firmware update', 11: 'Firmware update',
  12: 'Service', 13: 'Test', 14: 'Test', 15: 'Test', 16: 'Test',
};

/** 0x3102 DSP fault word 1, bit n. 0x3103 is all reserved. */
export const FAULTS_1 = [
  'Bus soft start fail', 'Inverter soft start fail', 'Bus short', 'Inverter short', 'Fan fault', 'PV insulation low',
  'Bus relay fault', 'Grid relay fault', 'EPS relay fault', 'GFCI sensor fault', 'Current sensor fault', 'PV short',
  'Bypass relay fault', 'System fault', 'DC current component high', 'DC voltage component high',
];
/** 0x3100 DSP alarm word 1 and 0x3101 alarm word 2, bit n. */
export const ALARMS_1 = [
  'Discharge over current', 'Overload', 'Battery disconnected', 'Battery under voltage', 'Battery low capacity',
  'Battery over voltage', 'Grid low voltage', 'Grid over voltage', 'Grid low frequency', 'Grid over frequency',
  'GFCI over', 'Parallel CAN fail', 'Grid CT reversed', 'Bus under voltage', 'Bus over voltage', 'Inverter over current',
];
export const ALARMS_2 = [
  'Charge over current', 'Bus voltage oscillation', 'Inverter under voltage', 'Inverter over voltage',
  'Inverter frequency abnormal', 'IGBT temperature high', 'BMS system error', 'Battery over temperature',
  'Battery under temperature', 'Battery cell unbalance', 'Battery reversed', 'BMS communication fail', 'Fan fail',
  'Grid overload', 'Grid phase error', 'Arc fault',
];

function phaseRows(): RegDef[] {
  const out: RegDef[] = [];
  PHASES.forEach((p, i) => {
    const g = 0x3110 + i * 3;
    const l = 0x3120 + i * 4;
    const v = 0x3190 + i * 3;
    out.push(
      { addr: g, scale: 0.1, metric: `Grid voltage ${p}`, note: 'confident: grid phase voltage 0.1 V' },
      { addr: g + 1, type: 's16', scale: 0.1, metric: `Grid current ${p}`, note: 'confident: 0.1 A, vendor: + = to grid' },
      { addr: g + 2, type: 's16', metric: `Grid power ${p}`, note: 'confident address; sign UNVERIFIED (assumed + = export like the current)' },
      { addr: l, scale: 0.1, metric: `Load voltage ${p}`, note: 'confident: 0.1 V' },
      { addr: l + 1, scale: 0.1, metric: `Load current ${p}`, note: 'confident: 0.1 A' },
      { addr: l + 2, metric: `Load power ${p}`, note: 'confident: W' },
      { addr: l + 3, scale: 0.1, metric: `Load rate ${p}`, note: 'confident: load percentage 0.1 %' },
      { addr: v, scale: 0.1, metric: `Inverter voltage ${p}`, note: 'UNVERIFIED: inverter output voltage 0.1 V (vendor doc only)' },
      { addr: v + 1, type: 's16', scale: 0.1, metric: `Inverter current ${p}`, note: 'UNVERIFIED: 0.1 A (vendor doc only)' },
      { addr: v + 2, type: 's16', metric: `Inverter power ${p}`, note: 'UNVERIFIED: W (vendor doc only)' },
      { addr: 0x3199 + i, scale: 0.01, metric: `Inverter frequency ${p}`, note: 'UNVERIFIED: 0.01 Hz (vendor doc only)' },
    );
  });
  return out;
}

export const MEGAREVO_LIVE: RegDef[] = [
  { addr: 0x3100, metric: 'Alarm word 1', note: 'UNVERIFIED: DSP alarm bits (vendor doc only)' },
  { addr: 0x3101, metric: 'Alarm word 2', note: 'UNVERIFIED: DSP alarm bits (vendor doc only)' },
  { addr: 0x3102, metric: 'Fault word 1', note: 'UNVERIFIED: DSP fault bits (vendor doc only)' },
  { addr: 0x3103, metric: 'Fault word 2', note: 'UNVERIFIED: reserved in the vendor doc' },
  { addr: 0x3104, metric: 'State word', note: 'UNVERIFIED: DSP state; bits 0–4 system state (vendor doc only)' },
  ...phaseRows(),
  { addr: 0x3119, scale: 0.01, metric: 'Grid frequency', note: 'confident: 0.01 Hz' },
  { addr: 0x311a, type: 's16', metric: 'Inverter temperature', note: 'confident: 1 °C signed' },
  { addr: 0x311b, type: 's16', metric: 'Internal temperature', note: 'confident: 1 °C signed' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 0x3130 + (n - 1) * 3, scale: 0.1, metric: `PV voltage ${n}`, note: 'confident: 0.1 V' },
    { addr: 0x3131 + (n - 1) * 3, scale: 0.1, metric: `PV current ${n}`, note: 'confident: 0.1 A' },
    { addr: 0x3132 + (n - 1) * 3, metric: `PV power ${n}`, note: 'confident: W' },
  ]),
  { addr: 0x3140, scale: 0.1, metric: 'Battery voltage', note: 'confident: 0.1 V' },
  { addr: 0x3141, type: 's16', scale: 0.1, metric: 'Battery current', note: 'confident: 0.1 A, vendor: + = charging' },
  { addr: 0x3145, scale: 0.1, metric: 'Battery state of charge', note: 'confident: 0.1 %' },
  { addr: 0x3146, type: 's16', scale: 0.1, metric: 'Battery temperature', note: 'confident: 0.1 °C (BMS)' },
  { addr: 0x314a, type: 's16', metric: 'Battery power raw', note: 'confident address, W; sign UNVERIFIED — taken from the current' },
  { addr: 0x3152, type: 's16', metric: 'DC-DC temperature', note: 'confident: 1 °C signed' },
];

/**
 * Info block 0x1215–0x1239 (one request). Vendor "Info" sheet, function 0x03: versions are decimal
 * (10001 → V1.00.01), model 10 registers ASCII, serial 6 registers ASCII. All UNVERIFIED on hardware.
 */
export const MEGAREVO_INFO: RegDef[] = [
  { addr: 0x1215, metric: 'LCD version', note: 'UNVERIFIED: decimal, 10001 = V1.00.01' },
  { addr: 0x1216, metric: 'DSP version', note: 'UNVERIFIED: decimal, 10001 = V1.00.01' },
  { addr: 0x1219, metric: 'Protocol number', note: 'UNVERIFIED: decimal, 10001 = V1.00.01' },
];
export const MEGAREVO_ASCII: AsciiField[] = [
  { metric: 'Model', addr: 0x121c, words: 10, note: 'UNVERIFIED: device model ASCII, e.g. "R6KL1"' },
  { metric: 'Serial', addr: 0x1234, words: 6, note: 'UNVERIFIED: 12 ASCII chars, e.g. "F12201000000"' },
];
/** The whole info block in one request (0x1215–0x1239). */
export const MEGAREVO_INFO_SPAN: [number, number] = [0x1215, 0x1239 - 0x1215 + 1];

/** Megarevo decimal version word: 10001 → "1.00.01". */
export function megarevoVersion(v: number): string {
  return `${Math.floor(v / 10000)}.${String(Math.floor(v / 100) % 100).padStart(2, '0')}.${String(v % 100).padStart(2, '0')}`;
}

/** Megarevo model text → model id: …H3 three-phase, …NA split-phase, otherwise single-phase. UNVERIFIED. */
export function modelFromText(text: string): string | undefined {
  const t = text.toUpperCase();
  if (!/[A-Z0-9]{3}/.test(t)) return undefined;
  if (/H3|3H/.test(t)) return 'three';
  if (/NA/.test(t)) return 'split';
  return 'hybrid';
}

function decodeInfoFor(fallback: string) {
  return (raw: Metrics): Metrics => {
    const out: Metrics = { 'Model name': fallback };
    const sn = raw.Serial;
    if (typeof sn === 'string' && sn) out['Serial number'] = sn;
    const model = raw.Model;
    if (typeof model === 'string' && /[A-Za-z0-9]{3}/.test(model)) out['Model name'] = `Megarevo ${model}`;
    const valid = (k: string) => typeof raw[k] === 'number' && raw[k] !== 0 && raw[k] !== 0xffff;
    if (valid('LCD version')) out['Firmware version'] = megarevoVersion(raw['LCD version'] as number);
    if (valid('DSP version')) out['Secondary firmware version'] = megarevoVersion(raw['DSP version'] as number);
    if (valid('Protocol number')) out['Protocol version'] = megarevoVersion(raw['Protocol number'] as number);
    return out;
  };
}

/** Device mode, fault code, temperature and battery: the same on every Megarevo family. */
function deriveCommon(raw: Metrics, out: Metrics) {
  if (has(raw, 'State word')) out['Device mode'] = SYSTEM_STATE[num(raw, 'State word') & 0x1f] ?? 'Unknown';
  if (has(raw, 'Fault word 1')) {
    const faults = bitNames(num(raw, 'Fault word 1'), FAULTS_1);
    out['Fault code'] = faults.length ? faults.join(', ') : 'None';
  }
  if (has(raw, 'Alarm word 1') && has(raw, 'Alarm word 2')) {
    const alarms = [...bitNames(num(raw, 'Alarm word 1'), ALARMS_1), ...bitNames(num(raw, 'Alarm word 2'), ALARMS_2)];
    out['Warning code'] = alarms.length ? alarms.join(', ') : 'None';
  }
  const temps = ['Inverter temperature', 'Internal temperature', 'DC-DC temperature'].filter((k) => has(raw, k));
  if (temps.length) out.Temperature = Math.max(...temps.map((k) => num(raw, k)));
  for (const k of ['Battery voltage', 'Battery current', 'Battery state of charge', 'Battery temperature', 'Grid frequency']) {
    if (has(raw, k)) out[k] = raw[k];
  }
  if (has(raw, 'Battery state of charge')) out['Battery state of charge'] = round(num(raw, 'Battery state of charge'), 0);
  // Battery power: the vendor documents "+ = charging" only for the current, so the power register's
  // magnitude takes the current's sign (Sunroost uses + = charging). Idle current: raw value.
  if (has(raw, 'Battery power raw')) {
    const p = num(raw, 'Battery power raw');
    const i = num(raw, 'Battery current');
    out['Battery power'] = i === 0 ? p : Math.sign(i) * Math.abs(p);
  }
  let pv = 0;
  for (const n of [1, 2, 3, 4]) {
    const v = num(raw, `PV voltage ${n}`);
    const p = num(raw, `PV power ${n}`);
    if (!has(raw, `PV power ${n}`)) continue;
    // Inputs 3/4 only when they report anything (2-MPPT units read 0 there).
    if (n > 2 && !(v > 0 || p > 0)) continue;
    out[`PV power ${n}`] = p;
    out[`PV voltage ${n}`] = v;
    out[`PV current ${n}`] = num(raw, `PV current ${n}`);
    pv += p;
  }
  out['PV power'] = pv;
}

/** Copies phase `p` readings into SA metrics with `suffix` ("" for single-phase, " 1" …). */
function phaseMetrics(raw: Metrics, p: Phase, suffix: string, out: Metrics) {
  // Vendor: grid current is + when feeding the grid; Sunroost uses + = import.
  if (has(raw, `Grid voltage ${p}`)) out[`Grid voltage${suffix}`] = raw[`Grid voltage ${p}`];
  if (has(raw, `Grid power ${p}`)) out[`Grid power${suffix}`] = -num(raw, `Grid power ${p}`) || 0;
  if (has(raw, `Grid current ${p}`)) out[`Grid current${suffix}`] = round(-num(raw, `Grid current ${p}`), 1) || 0;
  if (has(raw, `Load power ${p}`)) out[`Load power${suffix}`] = raw[`Load power ${p}`];
  if (has(raw, `Inverter voltage ${p}`)) out[`AC output voltage${suffix}`] = raw[`Inverter voltage ${p}`];
}

/** Single-phase: phase B per the vendor; falls back to A when B reads 0 V and A doesn't (UNVERIFIED). */
export function deriveSingle(raw: Metrics): Metrics {
  const out: Metrics = {};
  deriveCommon(raw, out);
  const p: Phase = num(raw, 'Grid voltage B') === 0 && num(raw, 'Load voltage B') === 0 && num(raw, 'Grid voltage A') > 0 ? 'A' : 'B';
  phaseMetrics(raw, p, '', out);
  if (!has(raw, `Grid power ${p}`)) out['Grid power'] = 0;
  if (has(raw, `Load rate ${p}`)) out['Load percentage'] = raw[`Load rate ${p}`];
  if (has(raw, `Load voltage ${p}`) && !has(out, 'AC output voltage')) out['AC output voltage'] = raw[`Load voltage ${p}`];
  const f = num(raw, `Inverter frequency ${p}`);
  out['AC output frequency'] = f > 0 ? f : num(raw, 'Grid frequency');
  return out;
}

function deriveMulti(phases: Phase[]) {
  return (raw: Metrics): Metrics => {
    const out: Metrics = {};
    deriveCommon(raw, out);
    let grid = 0;
    let load = 0;
    const rates: number[] = [];
    phases.forEach((p, i) => {
      phaseMetrics(raw, p, ` ${i + 1}`, out);
      grid += num(out, `Grid power ${i + 1}`);
      load += num(raw, `Load power ${p}`);
      if (has(raw, `Load rate ${p}`)) rates.push(num(raw, `Load rate ${p}`));
    });
    // The first leg doubles as the headline (unnumbered) value, as on the Deye three-phase driver.
    if (has(out, 'Grid voltage 1')) out['Grid voltage'] = out['Grid voltage 1'];
    if (has(out, 'AC output voltage 1')) out['AC output voltage'] = out['AC output voltage 1'];
    out['Grid power'] = grid;
    out['Load power'] = load;
    if (rates.length) out['Load percentage'] = Math.max(...rates);
    const f = num(raw, 'Inverter frequency A');
    out['AC output frequency'] = f > 0 ? f : num(raw, 'Grid frequency');
    return out;
  };
}

export const hybrid: MegarevoFamily = {
  id: 'hybrid',
  name: 'single-phase hybrid',
  liveMap: MEGAREVO_LIVE,
  derive: deriveSingle,
  infoMap: MEGAREVO_INFO,
  asciiInfo: MEGAREVO_ASCII,
  decodeInfo: decodeInfoFor('Megarevo single-phase hybrid'),
  settings: MEGAREVO_SETTINGS,
};

export const split: MegarevoFamily = {
  id: 'split',
  name: 'split-phase hybrid',
  // C-phase rows exist in the map but read 0 on split-phase units; they are still read (same request).
  liveMap: MEGAREVO_LIVE,
  derive: deriveMulti(['A', 'B']),
  infoMap: MEGAREVO_INFO,
  asciiInfo: MEGAREVO_ASCII,
  decodeInfo: decodeInfoFor('Megarevo split-phase hybrid'),
  settings: MEGAREVO_SETTINGS,
};

export const three: MegarevoFamily = {
  id: 'three',
  name: 'three-phase hybrid',
  liveMap: MEGAREVO_LIVE,
  derive: deriveMulti(['A', 'B', 'C']),
  infoMap: MEGAREVO_INFO,
  asciiInfo: MEGAREVO_ASCII,
  decodeInfo: decodeInfoFor('Megarevo three-phase hybrid'),
  settings: MEGAREVO_SETTINGS,
};
