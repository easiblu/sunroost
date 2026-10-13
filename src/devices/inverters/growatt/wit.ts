/**
 * Growatt WIT three-phase commercial hybrid (WIT 4-15K-H, WIT 28-55K / 29.9-50K-XHU, WIT 50-100K-H/HE/HU).
 *
 * Source: Growatt "Inverter Modbus RTU Protocol II" V1.39 (2024-04-16), which added the WIT TL3 scope:
 *   holding 0–124, 125–249, 875–999 ("business storage power" settings)
 *   input   0–124, 125–249, 8000–8124 (extra PV strings, battery, STS/backup, system power flow)
 * Note: V1.39 does not list the 3000 range for WIT; some WIT firmware also answers the TL-XH 3000
 * range and the VPP 30000/31000 ranges, but those are not used here.
 *
 * Confidence: "confident" = address, name and unit are in the V1.39 tables; signs and some units are
 * not documented there and are marked UNVERIFIED. Nothing here has been checked on hardware.
 *
 * READ-ONLY model: every setting is read-only, socControl/protection are null, and the driver refuses
 * raw writes for this family (see READ_ONLY_FAMILIES in driver.ts).
 */
import { round, type Metrics } from '../../../core/metrics.ts';
import { INFO_HOLDING, type GrowattFamily } from './family.ts';
import { has, num, type RegDef } from './registers.ts';
import { setting, type GrowattSetting } from './settings.ts';

/** Input 0 "Inverter run state" (V1.39 lists 0/1/3; 5 is reported by WIT units in the field — UNVERIFIED). */
export const WIT_STATUS: Record<number, string> = { 0: 'Waiting', 1: 'Normal', 3: 'Fault', 5: 'Standby' };

/** Strings 1–8 at input 3–34: voltage, current, 32-bit power (confident). */
const PV_LOW: RegDef[] = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => {
  const b = 3 + (n - 1) * 4;
  return [
    { addr: b, scale: 0.1, metric: `PV voltage ${n}`, note: `Vpv${n} 0.1 V (confident)` },
    { addr: b + 1, scale: 0.1, metric: `PV current ${n}`, note: `PV${n}Curr 0.1 A (confident)` },
    { addr: b + 2, type: 'u32' as const, scale: 0.1, metric: `PV power ${n}`, note: `Ppv${n} H/L 0.1 W (confident)` },
  ];
});

/** Strings 9–10 at input 8000–8007 (confident). */
const PV_HIGH: RegDef[] = [9, 10].flatMap((n) => {
  const b = 8000 + (n - 9) * 4;
  return [
    { addr: b, scale: 0.1, metric: `PV voltage ${n}`, note: `Vpv${n} 0.1 V (confident)` },
    { addr: b + 1, scale: 0.1, metric: `PV current ${n}`, note: `PV${n}Curr 0.1 A (confident)` },
    { addr: b + 2, type: 'u32' as const, scale: 0.1, metric: `PV power ${n}`, note: `Ppv${n} H/L 0.1 W (confident)` },
  ];
});

/** Inverter block, input 0–124. */
const WIT_INVERTER: RegDef[] = [
  { addr: 0, metric: 'Device mode', enum: WIT_STATUS, note: 'Inverter status (confident for 0/1/3)' },
  { addr: 1, type: 'u32', scale: 0.1, metric: 'PV power', note: 'Ppv H/L 0.1 W (confident)' },
  ...PV_LOW,
  { addr: 35, type: 's32', scale: 0.1, metric: 'Inverter power', note: 'Pac H/L 0.1 W (confident; sign when charging from grid UNVERIFIED)' },
  { addr: 37, scale: 0.01, metric: 'Grid frequency', note: 'Fac 0.01 Hz (confident)' },
  { addr: 38, scale: 0.1, metric: 'Grid voltage 1', note: 'Vac1 0.1 V (confident)' },
  { addr: 39, scale: 0.1, metric: 'Inverter current 1', note: 'Iac1 0.1 A (confident)' },
  { addr: 40, type: 'u32', scale: 0.1, metric: 'Inverter apparent power 1', note: 'Pac1 H/L 0.1 VA (confident)' },
  { addr: 42, scale: 0.1, metric: 'Grid voltage 2', note: 'Vac2 0.1 V (confident)' },
  { addr: 43, scale: 0.1, metric: 'Inverter current 2', note: 'Iac2 0.1 A (confident)' },
  { addr: 44, type: 'u32', scale: 0.1, metric: 'Inverter apparent power 2', note: 'Pac2 H/L 0.1 VA (confident)' },
  { addr: 46, scale: 0.1, metric: 'Grid voltage 3', note: 'Vac3 0.1 V (confident)' },
  { addr: 47, scale: 0.1, metric: 'Inverter current 3', note: 'Iac3 0.1 A (confident)' },
  { addr: 48, type: 'u32', scale: 0.1, metric: 'Inverter apparent power 3', note: 'Pac3 H/L 0.1 VA (confident)' },
  { addr: 53, type: 'u32', scale: 0.1, metric: 'AC energy today', note: 'Eac today 0.1 kWh (confident)' },
  { addr: 55, type: 'u32', scale: 0.1, metric: 'AC energy total', note: 'Eac total 0.1 kWh (confident)' },
  { addr: 91, type: 'u32', scale: 0.1, metric: 'PV energy total', note: 'Epv total 0.1 kWh (confident)' },
  { addr: 93, type: 's16', scale: 0.1, metric: 'Temperature', note: 'Temp1 inverter 0.1 °C (confident; signedness UNVERIFIED)' },
  { addr: 94, type: 's16', scale: 0.1, metric: 'IPM temperature', note: 'Temp2 0.1 °C (confident)' },
  { addr: 95, type: 's16', scale: 0.1, metric: 'Boost temperature', note: 'Temp3 0.1 °C (confident)' },
  { addr: 98, scale: 0.1, metric: 'Bus voltage', note: 'P bus voltage 0.1 V (confident)' },
  { addr: 104, metric: 'Derating mode', note: 'DeratingMode code (confident)' },
  { addr: 105, metric: 'Fault code', note: 'Fault maincode (confident)' },
  { addr: 107, metric: 'Fault subcode', note: 'Fault subcode (confident)' },
  { addr: 112, metric: 'Warning code', note: 'Warn maincode (confident)' },
];

/** Business-storage block, input 8000–8124 (WIT only). */
const WIT_STORAGE: RegDef[] = [
  ...PV_HIGH,
  { addr: 8034, scale: 0.1, metric: 'Battery voltage', note: 'BAT_Volt 0.1 V (confident)' },
  { addr: 8035, type: 's16', scale: 0.1, metric: 'Battery current raw', note: 'BAT_Curr 0.1 A (confident; sign UNVERIFIED — re-signed from battery power)' },
  { addr: 8036, scale: 0.1, metric: 'Backup voltage 1', note: 'STS R voltage 0.1 V (confident)' },
  { addr: 8037, scale: 0.1, metric: 'Backup voltage 2', note: 'STS S voltage 0.1 V (confident)' },
  { addr: 8038, scale: 0.1, metric: 'Backup voltage 3', note: 'STS T voltage 0.1 V (confident)' },
  { addr: 8042, scale: 0.1, metric: 'Load current 1', note: 'STS R load current 0.1 A (confident)' },
  { addr: 8043, scale: 0.1, metric: 'Load current 2', note: 'STS S load current 0.1 A (confident)' },
  { addr: 8044, scale: 0.1, metric: 'Load current 3', note: 'STS T load current 0.1 A (confident)' },
  { addr: 8045, type: 'u32', scale: 0.1, metric: 'Self-use power', note: 'Pself 0.1 W (confident)' },
  { addr: 8049, type: 'u32', scale: 0.1, metric: 'Battery discharge energy today', note: 'Edischr_today 0.1 kWh (confident)' },
  { addr: 8053, type: 'u32', scale: 0.1, metric: 'Battery charge energy today', note: 'Echr_today 0.1 kWh (confident)' },
  { addr: 8079, type: 'u32', scale: 0.1, metric: 'Local load power', note: 'Ptoload total 0.1 W (confident; reported 0 on some units — fallback below)' },
  { addr: 8081, type: 'u32', scale: 0.1, metric: 'Grid import power', note: 'Ptouser total (forward) 0.1 W (confident)' },
  { addr: 8083, type: 'u32', scale: 0.1, metric: 'Grid export power', note: 'Ptogrid total (reverse) 0.1 W (confident)' },
  { addr: 8085, type: 'u32', scale: 0.1, metric: 'System output power', note: 'Psys 0.1 W (confident)' },
  { addr: 8091, type: 's32', scale: 0.1, metric: 'Battery power raw', note: 'BatPower H/L 0.1 W (address confident; signed and + = charging UNVERIFIED)' },
  { addr: 8093, metric: 'Battery state of charge', note: 'SOC % (confident)' },
  { addr: 8094, metric: 'Battery state of health', note: 'SOH % (confident)' },
  { addr: 8095, scale: 0.1, metric: 'BMS battery voltage', note: 'BMS_BATVol 0.1 V (confident)' },
  { addr: 8096, scale: 0.1, metric: 'Inverter voltage 1', note: 'INV R voltage 0.1 V (confident)' },
  { addr: 8097, scale: 0.1, metric: 'Inverter voltage 2', note: 'INV S voltage 0.1 V (confident)' },
  { addr: 8098, scale: 0.1, metric: 'Inverter voltage 3', note: 'INV T voltage 0.1 V (confident)' },
  { addr: 8108, type: 's16', scale: 0.1, metric: 'ATS SCR temperature', note: 'ATS SCR temperature 0.1 °C (confident)' },
];

/** Holding registers decoded in the console besides the settings. */
const WIT_HOLDING: RegDef[] = [
  { addr: 0, metric: 'On/off', note: 'OnOff 0/1 inverter, 2/3 BDC (confident)' },
  ...INFO_HOLDING,
  { addr: 44, metric: 'Trackers and phases', note: 'TP e.g. 0x0203 = 2 MPPT, 3 phase (confident)' },
  { addr: 88, metric: 'Modbus version', note: 'e.g. 207 = V2.07 (confident)' },
  { addr: 988, metric: 'Machine type', enum: { 0: 'WIT', 1: 'WIS' }, note: 'MachineType (confident)' },
  // Six time-of-use slots, three registers each (confident). Shown raw here: the enable/priority word
  // and separate start/end words don't fit the existing slot codecs, and the model is read-only.
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => {
    const b = 954 + (n - 1) * 3;
    return [
      { addr: b, metric: `Time slot ${n} enable word`, note: 'bit 15 enable, bits 13–14 0 load / 1 battery / 2 grid first (confident)' },
      { addr: b + 1, metric: `Time slot ${n} start`, note: 'bits 8–12 hour, bits 0–7 minute (confident)' },
      { addr: b + 2, metric: `Time slot ${n} end`, note: 'bits 8–12 hour, bits 0–7 minute (confident)' },
    ];
  }),
];

const ro = { readOnly: true } as const;

/** All read-only. Addresses from V1.39 holding 122–123 and 875–999; meaning confident, scaling noted. */
export const WIT_SETTINGS: GrowattSetting[] = [
  setting('Battery', 'AC charge', { ...ro, type: 'checkbox', reg: 949, codec: { kind: 'bool' }, note: 'holding 949 uwACChargeEnable (confident)' }),
  setting('Battery', 'AC charge power rate', {
    ...ro, type: 'number', reg: 905, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 905 uwACChargePowerRate % (confident)',
  }),
  setting('Battery', 'Battery charge stop SOC', {
    ...ro, type: 'number', reg: 951, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 951 uwBatChargeStopSoc (confident)',
  }),
  setting('Battery', 'Battery discharge stop SOC', {
    ...ro, type: 'number', reg: 952, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 952 uwBatDisChargeStopSoc (confident)',
  }),
  setting('Battery', 'Off-grid discharge stop SOC', {
    ...ro, type: 'number', reg: 998, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 998 OffGridDisChgStopSoc (confident)',
  }),
  setting('Battery', 'Backup SOC', {
    ...ro, type: 'number', reg: 996, codec: { kind: 'number' }, unit: '%', min: 0, max: 100, step: 1,
    note: 'holding 996 BakSoc (confident)',
  }),
  setting('Battery', 'Max charge current', {
    ...ro, type: 'number', reg: 910, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 6553.5, step: 0.1,
    note: 'holding 910 uwBatMaxChargeCurrent ×10 (confident address; 0.1 A scale UNVERIFIED)',
  }),
  setting('Battery', 'Max discharge current', {
    ...ro, type: 'number', reg: 911, codec: { kind: 'number', scale: 0.1 }, unit: 'A', min: 0, max: 6553.5, step: 0.1,
    note: 'holding 911 uwBatMaxDisChargeCurrent ×10 (confident address; 0.1 A scale UNVERIFIED)',
  }),
  setting('Battery', 'Max charge voltage', {
    ...ro, type: 'number', reg: 906, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 0, max: 6553.5, step: 0.1,
    note: 'holding 906 uwBattMaxChargeVol ×10 (confident address; 0.1 V scale UNVERIFIED)',
  }),
  setting('Battery', 'End of discharge voltage', {
    ...ro, type: 'number', reg: 907, codec: { kind: 'number', scale: 0.1 }, unit: 'V', min: 0, max: 6553.5, step: 0.1,
    note: 'holding 907 uwBattEODVol ×10 (confident address; 0.1 V scale UNVERIFIED)',
  }),
  setting('Battery', 'BMS', { ...ro, type: 'checkbox', reg: 972, codec: { kind: 'bool' }, note: 'holding 972 BMS enable (confident)' }),
  setting('Grid', 'Off-grid', { ...ro, type: 'checkbox', reg: 950, codec: { kind: 'bool' }, note: 'holding 950 uwOffGridEnable (confident)' }),
  setting('Grid', 'AC output voltage', {
    ...ro, type: 'select', reg: 936, codec: { kind: 'enum' }, unit: 'V', options: ['220', '230', '240', '277', '127'],
    note: 'holding 936 uwOffGridVol 0 220 / 1 230 / 2 240 / 3 277 / 4 127 (confident)',
  }),
  setting('Grid', 'AC output frequency', {
    ...ro, type: 'select', reg: 937, codec: { kind: 'enum' }, unit: 'Hz', options: ['50', '60'],
    note: 'holding 937 uwOffGridFreq 0 50 / 1 60 (confident)',
  }),
  setting('Grid', 'Export limiter', {
    ...ro, type: 'checkbox', reg: 122, codec: { kind: 'bool' },
    note: 'holding 122 ExportLimit 0 off / 1 RS485 / 2 RS232 / 3 CT (confident; non-zero reads as on)',
  }),
  setting('Grid', 'Export power rate', {
    ...ro, type: 'number', reg: 123, codec: { kind: 'number', scale: 0.1 }, unit: '%', min: 0, max: 100, step: 0.1,
    note: 'holding 123 ExportLimitPowerRate (confident address; 0.1 % scale UNVERIFIED, negative values not decoded)',
  }),
  setting('Grid', 'Demand management', { ...ro, type: 'checkbox', reg: 946, codec: { kind: 'bool' }, note: 'holding 946 (confident)' }),
  setting('Grid', 'Parallel', { ...ro, type: 'checkbox', reg: 973, codec: { kind: 'bool' }, note: 'holding 973 uwParallelEnable (confident)' }),
  setting('Work mode', 'Remote dispatch (VPP)', { ...ro, type: 'checkbox', reg: 918, codec: { kind: 'bool' }, note: 'holding 918 uwPowerDispatchEnable (confident)' }),
];

export function deriveWit(raw: Metrics): Metrics {
  const pvStrings = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const stringSum = pvStrings.reduce((s, n) => s + num(raw, `PV power ${n}`), 0);
  const pv = has(raw, 'PV power') ? num(raw, 'PV power') : stringSum;
  const grid = num(raw, 'Grid import power') - num(raw, 'Grid export power');
  const inverter = num(raw, 'Inverter power');
  // Ptoload reads 0 on some WIT units; fall back to the AC-side balance (inverter output + grid).
  const load = num(raw, 'Local load power') > 0 ? num(raw, 'Local load power') : Math.max(0, inverter + grid);
  const battV = num(raw, 'Battery voltage');
  const battP = has(raw, 'Battery power raw') ? num(raw, 'Battery power raw') : battV * num(raw, 'Battery current raw');
  const battI = Math.abs(num(raw, 'Battery current raw'));

  const out: Metrics = {
    'Device mode': String(raw['Device mode'] ?? ''),
    'PV power': round(pv, 0),
    'Grid power': round(grid, 0),
    'Load power': round(load, 0),
    'Inverter power': round(inverter, 0),
    'Battery power': round(battP, 0),
    // The current register's sign is undocumented; take its magnitude and the power's direction.
    'Battery current': battP < 0 ? -battI : battI,
  };
  for (const n of pvStrings) {
    // Strings 1–2 always; higher strings only when wired (the 4–15K has 2–4 MPPTs, the 100K up to 10).
    const used = n <= 2 || num(raw, `PV voltage ${n}`) > 0 || num(raw, `PV power ${n}`) > 0;
    if (!used) continue;
    for (const k of ['PV voltage', 'PV current']) if (has(raw, `${k} ${n}`)) out[`${k} ${n}`] = raw[`${k} ${n}`];
    if (has(raw, `PV power ${n}`)) out[`PV power ${n}`] = round(num(raw, `PV power ${n}`), 0);
  }
  for (const k of [
    'Battery voltage', 'Battery state of charge', 'Battery state of health', 'Grid frequency', 'Temperature',
    'Bus voltage', 'Fault code',
  ]) {
    if (has(raw, k)) out[k] = raw[k];
  }
  for (const p of [1, 2, 3]) {
    if (has(raw, `Grid voltage ${p}`)) out[`Grid voltage ${p}`] = raw[`Grid voltage ${p}`];
    if (has(raw, `Inverter voltage ${p}`)) out[`AC output voltage ${p}`] = raw[`Inverter voltage ${p}`];
    if (has(raw, `Load current ${p}`)) out[`Load current ${p}`] = raw[`Load current ${p}`];
  }
  if (has(raw, 'Grid voltage 1')) out['Grid voltage'] = raw['Grid voltage 1'];
  // The INV phase voltages are the AC (backup) output; before the 8000 block is read, use the grid side.
  const acOut = num(raw, 'Inverter voltage 1') > 0 ? raw['Inverter voltage 1'] : raw['Grid voltage 1'];
  if (typeof acOut === 'number') out['AC output voltage'] = acOut;
  if (has(raw, 'Grid frequency')) out['AC output frequency'] = raw['Grid frequency'];
  return out;
}

export const wit: GrowattFamily = {
  id: 'wit',
  name: 'WIT three-phase hybrid (commercial)',
  // Input 0–112 (inverter) and 8000–8110 (storage); both within the 125-register limit.
  inputBlocks: [[0, 113], [8000, 111]],
  inputMap: [...WIT_INVERTER, ...WIT_STORAGE],
  holdingMap: WIT_HOLDING,
  settings: WIT_SETTINGS,
  derive: deriveWit,
  socControl: null,
  protection: null,
};
