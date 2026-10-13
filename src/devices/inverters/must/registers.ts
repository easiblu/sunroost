/**
 * MUST Power register tables (all holding registers, function 3, addresses as sent on the wire).
 *
 * Sources: MUST's "PV1800/PH1800 RS485 Modbus" register document (block layout: charger display
 * 15201+, inverter display 25201+, charger settings 10101+, inverter settings 20101+, identity
 * 20000+), cross-checked for facts against two independent open-source readers that were live-tested
 * on a PV18-3224 VPM, a PV19 EXP and a PH11 three-phase (PH1100 EU). No code was copied.
 *
 * Confidence: "confident" = the address, scale and meaning agree across those sources;
 * "UNVERIFIED" = only one source, or the sign/scale is a guess. Everything still needs checking on
 * real hardware with the Modbus console (see docs/HARDWARE_TEST.md).
 *
 * WARNING (from field reports): bulk reads across 10009–10100 or 20016–20100 have crashed PV1800
 * units until power-cycled. The driver therefore reads only the explicit blocks listed per family,
 * never a planned/merged span.
 */
import type { RegDef } from '../growatt/registers.ts';

export type { RegDef };

/** Charger state (15201). confident */
export const CHARGER_STATE: Record<number, string> = { 0: 'Initialising', 1: 'Self test', 2: 'Working', 3: 'Stopped' };
/** MPPT state (15202). confident */
export const MPPT_STATE: Record<number, string> = { 0: 'Stopped', 1: 'MPPT', 2: 'Current limiting' };
/** Charging stage (15203). confident */
export const CHARGE_STAGE: Record<number, string> = { 0: 'Not charging', 1: 'Absorption', 2: 'Float', 3: 'Equalisation' };
/** Inverter work state (25201) → Device mode. confident */
export const WORK_STATE: Record<number, string> = {
  0: 'Power on',
  1: 'Self test',
  2: 'Off-grid',
  3: 'Grid-tie',
  4: 'Bypass',
  5: 'Stop',
  6: 'Grid charging',
};

/** PV1800 / PH1800 / EP1800 (and Synerji SYSV) live map: charger block + inverter block. */
export const PH1800_LIVE: RegDef[] = [
  // Charger display block 15201–15220.
  { addr: 15201, metric: 'Charger state', enum: CHARGER_STATE, note: 'confident' },
  { addr: 15202, metric: 'MPPT state', enum: MPPT_STATE, note: 'confident' },
  { addr: 15203, metric: 'Charge stage', enum: CHARGE_STAGE, note: 'confident' },
  { addr: 15205, scale: 0.1, metric: 'PV voltage', note: 'PV input voltage 0.1 V (confident)' },
  { addr: 15206, scale: 0.1, metric: 'Charger battery voltage', note: 'battery voltage seen by the charger 0.1 V (confident)' },
  { addr: 15207, scale: 0.1, metric: 'Charger current', note: 'solar charger output (battery-side) current 0.1 A (confident)' },
  { addr: 15208, metric: 'PV power', note: 'solar charger power W (confident)' },
  { addr: 15209, type: 's16', metric: 'Charger temperature', note: 'charger heat-sink °C, no scale (confident)' },
  { addr: 15210, type: 's16', metric: 'External temperature', note: 'external (battery) probe °C — UNVERIFIED that it is the battery probe' },
  { addr: 15213, metric: 'Charger fault word', note: 'bit field (confident)' },
  { addr: 15214, metric: 'Charger warning word', note: 'bit field (confident)' },
  { addr: 15215, metric: 'Battery voltage grade', note: 'nominal 12/24/48 V (confident)' },
  // Inverter display block 25201–25279.
  { addr: 25201, metric: 'Work state', enum: WORK_STATE, note: 'confident' },
  { addr: 25203, metric: 'Rated power', note: 'VA (confident)' },
  { addr: 25205, scale: 0.1, metric: 'Battery voltage', note: '0.1 V (confident)' },
  { addr: 25206, scale: 0.1, metric: 'Inverter voltage', note: 'AC output voltage 0.1 V (confident)' },
  { addr: 25207, scale: 0.1, metric: 'Grid voltage', note: '0.1 V (confident)' },
  { addr: 25208, scale: 0.1, metric: 'Bus voltage', note: 'DC bus 0.1 V (confident)' },
  { addr: 25210, type: 's16', scale: 0.1, metric: 'Inverter current', note: '0.1 A (confident)' },
  { addr: 25211, type: 's16', scale: 0.1, metric: 'Grid current', note: '0.1 A (confident)' },
  { addr: 25212, type: 's16', scale: 0.1, metric: 'Load current', note: '0.1 A (confident)' },
  { addr: 25213, type: 's16', metric: 'Inverter power', note: 'W (confident address; sign UNVERIFIED)' },
  { addr: 25214, type: 's16', metric: 'Grid power raw', note: 'W, assumed + = import — UNVERIFIED sign' },
  { addr: 25215, type: 's16', metric: 'Load power', note: 'W (confident)' },
  { addr: 25216, metric: 'Load percentage', note: '% (confident)' },
  { addr: 25219, type: 's16', metric: 'Load apparent power', note: 'VA (confident)' },
  { addr: 25225, scale: 0.01, metric: 'Inverter frequency', note: '0.01 Hz (confident)' },
  { addr: 25226, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (confident)' },
  { addr: 25233, type: 's16', metric: 'AC heat sink temperature', note: '°C, no scale (confident)' },
  { addr: 25234, type: 's16', metric: 'Transformer temperature', note: '°C, no scale (confident)' },
  { addr: 25235, type: 's16', metric: 'DC heat sink temperature', note: '°C, no scale (confident)' },
  { addr: 25261, metric: 'Inverter fault word 1', note: 'bit field (confident)' },
  { addr: 25262, metric: 'Inverter fault word 2', note: 'bit field (confident)' },
  { addr: 25265, metric: 'Inverter warning word', note: 'bit field (confident)' },
  { addr: 25273, type: 's16', metric: 'Battery power raw', note: 'W (confident address); assumed + = discharging — UNVERIFIED sign, negated' },
  { addr: 25274, type: 's16', metric: 'Battery current raw', note: 'UNVERIFIED scale; not used (current is derived from power/voltage)' },
];

/** PV19 EXP extras: battery SOC/SOH and the second MPPT (16205+ mirrors the 15205 layout). */
export const PV1900_EXTRA: RegDef[] = [
  { addr: 113, metric: 'Battery state of charge', note: '% (UNVERIFIED: one source, PV19 only)' },
  { addr: 114, metric: 'Battery state of health', note: '% (UNVERIFIED: one source, PV19 only)' },
  { addr: 16205, scale: 0.1, metric: 'PV voltage 2 raw', note: '0.1 V — UNVERIFIED' },
  { addr: 16207, scale: 0.1, metric: 'Charger current 2', note: '0.1 A — UNVERIFIED' },
  { addr: 16208, metric: 'PV power 2 raw', note: 'W — UNVERIFIED' },
];

/**
 * PH11 three-phase hybrid (PH1100 EU, 5–16 kW): a different map. Battery/BMS block 15104–15119 and
 * a three-phase display block 25225–25339. All from a single source → UNVERIFIED unless noted.
 */
const phase = (base: number, metric: string, scale: number | undefined, note: string): RegDef[] =>
  [1, 2, 3].map((p) => ({ addr: base + p - 1, type: 's16', metric: `${metric} ${p}`, ...(scale ? { scale } : {}), note }));

export const PH10_LIVE: RegDef[] = [
  { addr: 15104, scale: 0.1, metric: 'Battery voltage', note: '0.1 V (UNVERIFIED)' },
  { addr: 15105, type: 's16', scale: 0.1, metric: 'Battery current raw', note: '0.1 A, assumed + = discharging — UNVERIFIED' },
  { addr: 15106, type: 's16', metric: 'Battery power raw', note: 'W, assumed + = discharging — UNVERIFIED, negated' },
  { addr: 15107, type: 's16', scale: 0.1, metric: 'Inverter temperature', note: '0.1 °C (UNVERIFIED)' },
  { addr: 15108, type: 's16', scale: 0.1, metric: 'DC heat sink temperature', note: '0.1 °C (UNVERIFIED)' },
  { addr: 15111, type: 's16', scale: 0.1, metric: 'Battery temperature', note: '0.1 °C (UNVERIFIED)' },
  { addr: 15115, metric: 'Battery state of charge', note: 'BMS SOC % (UNVERIFIED)' },
  ...[1, 2, 3, 4].flatMap((n): RegDef[] => [
    { addr: 25222 + n * 3, scale: 0.1, metric: `PV voltage ${n}`, note: '0.1 V (UNVERIFIED)' },
    { addr: 25223 + n * 3, scale: 0.1, metric: `PV current ${n}`, note: '0.1 A (UNVERIFIED)' },
    { addr: 25224 + n * 3, metric: `PV power ${n}`, note: 'W (UNVERIFIED)' },
  ]),
  ...phase(25237, 'Grid voltage', 0.1, '0.1 V (UNVERIFIED)'),
  { addr: 25243, scale: 0.01, metric: 'Grid frequency', note: '0.01 Hz (UNVERIFIED)' },
  { addr: 25244, type: 's16', metric: 'Grid power raw', note: 'W, assumed + = import — UNVERIFIED sign' },
  ...phase(25247, 'Inverter voltage', 0.1, '0.1 V (UNVERIFIED)'),
  { addr: 25253, scale: 0.01, metric: 'Inverter frequency', note: '0.01 Hz (UNVERIFIED)' },
  { addr: 25254, type: 's16', metric: 'Inverter power', note: 'W (UNVERIFIED)' },
  { addr: 25263, type: 's16', metric: 'Load power', note: 'W (UNVERIFIED)' },
  { addr: 25265, type: 's16', metric: 'Load apparent power', note: 'VA (UNVERIFIED)' },
];

/** Identity block 20000–20005 (PV/PH1800 family). Read once on connect and by detect. */
export const IDENTITY_SPAN: [number, number] = [20000, 6];
/**
 * 20000: two ASCII letters ("PV"/"PH") — UNVERIFIED (one source).
 * 20001: machine type number, e.g. 1800 — confident (two sources).
 * 20002–20003: serial number, 32-bit high word first — confident address; display format UNVERIFIED
 *   (one source prints it as decimal, the other as 8 hex digits). Shown as decimal.
 * 20004/20005: hardware/software version, decimal AABBCC → "A.BB.CC" — confident.
 */
export const IDENTITY: RegDef[] = [
  { addr: 20000, type: 'ascii', words: 1, metric: 'Model prefix', note: 'UNVERIFIED' },
  { addr: 20001, metric: 'Machine type', note: 'confident' },
  { addr: 20002, type: 'u32', metric: 'Serial', note: 'confident address; format UNVERIFIED' },
  { addr: 20004, metric: 'Hardware version raw', note: 'confident' },
  { addr: 20005, metric: 'Software version raw', note: 'confident' },
];

/** PH11 three-phase: serial as three 5-digit decimal words at 20001–20003 (UNVERIFIED, one source). */
export const PH10_IDENTITY_SPAN: [number, number] = [20001, 3];

/** Machine type (20001) → model id. 1800 confident; the others are UNVERIFIED guesses. */
export const MACHINE_TYPES: Record<number, { name: string; model?: string }> = {
  1600: { name: 'PC1600' },
  1800: { name: 'PV1800/PH1800', model: 'ph1800' },
  1900: { name: 'PV1900', model: 'pv1900' },
  3000: { name: 'PH3000', model: 'pv3300' },
  3300: { name: 'PV3300/EP3300', model: 'pv3300' },
  3500: { name: 'PV3500', model: 'pv3300' },
};

/** Decimal AABBCC → "A.BB.CC" (MUST's version encoding). */
export function decodeMustVersion(raw: number): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(raw / 10000)}.${p2(Math.floor(raw / 100) % 100)}.${p2(raw % 100)}`;
}

/** Fault/warning words → "None" or a list like "Inverter fault 4, Charger fault 2" (bit n → n+1). */
export function decodeBits(words: { label: string; word: number; offset: number }[]): string {
  const out: string[] = [];
  for (const { label, word, offset } of words) {
    for (let b = 0; b < 16; b++) if (word & (1 << b)) out.push(`${label} ${offset + b + 1}`);
  }
  return out.length ? out.join(', ') : 'None';
}
