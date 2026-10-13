/**
 * Victron settings decoded for display. The driver is read-only: nothing here is ever written.
 * `unit: 'system'` = com.victronenergy.settings on unit 100; `'vebus'` = the VE.Bus unit.
 */
import { s16, type Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export interface VictronSetting extends SettingDef {
  unitKind: 'system' | 'vebus';
  reg: number;
  decode(raw: number): Value;
  note: string;
}

/** Settings spans on unit 100 (each read separately; either may be missing on old firmware). */
export const SETTING_SPANS: [number, number][] = [
  [2700, 7], // 2700–2706 ESS / DVCC
  [2900, 4], // 2900–2903 ESS BatteryLife / minimum SOC / mode
];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setting(section: string, label: string, rest: Omit<VictronSetting, 'key' | 'label' | 'section' | 'readOnly'>): VictronSetting {
  return { key: snake(label), label, section, readOnly: true, ...rest };
}

function pick(map: Record<number, string>) {
  return (raw: number): Value => map[raw] ?? null;
}

const SWITCH = { 1: 'Charger only', 2: 'Inverter only', 3: 'On', 4: 'Off' };
const ESS_MODES = { 1: 'Optimised with phase compensation', 2: 'Optimised without phase compensation', 3: 'External control' };
const BATTERYLIFE = {
  0: 'Unused', 1: 'Restarting', 2: 'Self-consumption', 3: 'Self-consumption (SOC above 85 %)', 4: 'Self-consumption (SOC 100 %)',
  5: 'Discharge disabled', 6: 'Force charge', 7: 'Sustain', 8: 'Low SOC recharge', 9: 'Keep batteries charged',
  10: 'BatteryLife disabled', 11: 'BatteryLife disabled (low SOC)', 12: 'BatteryLife disabled (low SOC recharge)',
};

/** −1 means "no limit" on the DVCC/ESS limit registers. */
const limit = (scale: number) => (raw: number): Value => {
  const v = s16(raw);
  return v < 0 ? -1 : v * scale;
};

export const VICTRON_SETTINGS: VictronSetting[] = [
  setting('Inverter', 'Switch position', {
    type: 'select', options: Object.values(SWITCH), unitKind: 'vebus', reg: 33, decode: pick(SWITCH),
    note: 'vebus 33: 1 charger only / 2 inverter only / 3 on / 4 off — confident',
  }),
  setting('ESS', 'ESS mode', {
    type: 'select', options: Object.values(ESS_MODES), unitKind: 'system', reg: 2902, decode: pick(ESS_MODES),
    note: '100:2902 /Settings/CGwacs/Hub4Mode — medium (value names UNVERIFIED)',
  }),
  setting('ESS', 'ESS minimum SOC', {
    type: 'number', unit: '%', min: 0, max: 100, step: 1, unitKind: 'system', reg: 2901, decode: (r) => r / 10,
    note: '100:2901 minimum SOC unless grid fails, uint16 0.1 % — confident',
  }),
  setting('ESS', 'ESS BatteryLife state', {
    type: 'select', options: Object.values(BATTERYLIFE), unitKind: 'system', reg: 2900, decode: pick(BATTERYLIFE),
    note: '100:2900 BatteryLife state — medium',
  }),
  setting('ESS', 'ESS BatteryLife SOC limit', {
    type: 'number', unit: '%', min: 0, max: 100, step: 1, unitKind: 'system', reg: 2903, decode: (r) => r / 10,
    note: 'UNVERIFIED: 100:2903 BatteryLife active SOC limit, 0.1 %',
  }),
  setting('Grid', 'Grid setpoint', {
    type: 'number', unit: 'W', min: -32000, max: 32000, step: 1, unitKind: 'system', reg: 2700, decode: (r) => s16(r),
    note: '100:2700 ESS AC power setpoint, int16 W — confident',
  }),
  setting('Grid', 'Maximum feed-in power', {
    type: 'number', unit: 'W', min: -1, max: 320000, step: 100, unitKind: 'system', reg: 2706, decode: limit(100),
    help: '−1 = no limit',
    note: 'UNVERIFIED: 100:2706 max feed-in power, int16 ×100 W, −1 none',
  }),
  setting('Battery', 'Maximum charge current', {
    type: 'number', unit: 'A', min: -1, max: 1000, step: 1, unitKind: 'system', reg: 2705, decode: limit(1),
    help: '−1 = no limit (DVCC)',
    note: 'UNVERIFIED: 100:2705 DVCC max charge current, int16 A, −1 none',
  }),
  setting('ESS', 'ESS power setpoint L1', {
    type: 'number', unit: 'W', min: -32000, max: 32000, step: 1, unitKind: 'vebus', reg: 37, decode: (r) => s16(r),
    note: 'UNVERIFIED: vebus 37 Hub4 L1 AC power setpoint, int16 W',
  }),
];

export function decodeSettings(sys: RegisterImage, vb: RegisterImage | null): SettingValues {
  const out: SettingValues = {};
  for (const s of VICTRON_SETTINGS) {
    const img = s.unitKind === 'system' ? sys : vb;
    const raw = img?.get(s.reg);
    if (raw === undefined) continue;
    const v = s.decode(raw);
    if (v !== null) out[s.key] = v;
  }
  return out;
}
