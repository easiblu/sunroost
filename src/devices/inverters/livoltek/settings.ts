/**
 * Livoltek settings (holding registers 0–109, function 3). Read-only: decoded and shown, never
 * written. Addresses: community Hyper-6000 list (0-based) and Livoltek's cloud point table (4xxxx,
 * 40001 = holding 0); where both name a register they agree. Notes say which source(s) and how sure.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef } from '../../types.ts';
import type { RegisterImage } from './registers.ts';

export type Codec = { kind: 'enum'; map: Record<number, string> } | { kind: 'number'; scale?: number };

export interface LivoltekSetting extends SettingDef {
  reg: number;
  codec: Codec;
  note: string;
}

/** Holding 0–109 in one read. */
export const SETTING_SPANS: [number, number][] = [[0, 110]];

function snake(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function enumSetting(section: string, label: string, reg: number, map: Record<number, string>, note: string): LivoltekSetting {
  return { key: snake(label), label, section, type: 'select', options: Object.values(map), readOnly: true, reg, codec: { kind: 'enum', map }, note };
}

function numSetting(
  section: string, label: string, reg: number, scale: number, unit: string, min: number, max: number, note: string,
): LivoltekSetting {
  return { key: snake(label), label, section, type: 'number', unit, min, max, step: scale, readOnly: true, reg, codec: { kind: 'number', scale }, note };
}

export const LIVOLTEK_SETTINGS: LivoltekSetting[] = [
  enumSetting('Work mode', 'Work mode', 0, { 0: 'Self use', 1: 'Backup' }, 'confident: both sources (community: 0 self use / 1 backup)'),
  enumSetting('Battery', 'Battery type', 1, { 0: 'No battery', 2: 'Lithium', 5: 'LFP', 16: 'Battery without BMS' },
    'UNVERIFIED codes: community list 0 none / 2 lithium / 5 LFP / 16 no BMS; forum also saw 1'),
  numSetting('Battery', 'Battery capacity', 2, 1, 'Ah', 1, 500, 'confident: both sources, Ah'),
  numSetting('Battery', 'Max charge current', 3, 0.1, 'A', 0.5, 125, 'confident: both sources, 0.1 A'),
  numSetting('Battery', 'Charge cut-off voltage', 4, 0.1, 'V', 48, 64, 'UNVERIFIED: cloud 40005 only, 0.1 V'),
  numSetting('Battery', 'Float charge voltage', 5, 0.1, 'V', 48, 64, 'UNVERIFIED: cloud 40006 only, 0.1 V'),
  numSetting('Battery', 'Float charge current', 6, 0.1, 'A', 0, 125, 'UNVERIFIED: cloud 40007 only, 0.1 A'),
  numSetting('Battery', 'Max discharge current', 7, 0.1, 'A', 0.5, 125, 'confident: both sources, 0.1 A'),
  numSetting('Battery', 'Discharge cut-off voltage', 8, 0.1, 'V', 40, 60, 'UNVERIFIED: cloud 40009 only, 0.1 V'),
  numSetting('Battery', 'Discharge end SOC on grid', 9, 1, '%', 0, 100, 'confident: both sources'),
  numSetting('Battery', 'Discharge end SOC on EPS', 10, 1, '%', 0, 100, 'confident: both sources'),
  numSetting('Grid', 'Inverter power limit', 57, 1, 'W', 0, 65535, 'UNVERIFIED: cloud 40058 only'),
  numSetting('Grid', 'Feed-in power limit', 58, 1, 'W', 0, 65535, 'confident: both sources; 65535 = no limit'),
  enumSetting('Output', 'EPS mode', 64, { 1: 'EPS without bypass', 3: 'UPS with bypass' }, 'confident: both sources'),
  enumSetting('Output', 'Beep on EPS', 67, { 0: 'Off', 1: 'On' }, 'UNVERIFIED: cloud 40068; community says reg 11 mirrors it'),
  enumSetting('Output', 'Beep on fault', 68, { 0: 'Off', 1: 'On' }, 'UNVERIFIED: cloud 40069 only'),
  enumSetting('Grid', 'Feed-in control method', 82, { 0: 'Disabled', 1: 'Single-phase meter', 7: 'Three-phase meter', 50: 'CT' },
    'confident: both sources (cloud calls it Smartmeter_Type)'),
  numSetting('Battery', 'Max AC charge current', 106, 0.1, 'A', 0, 125, 'confident: both sources, 0.1 A'),
  enumSetting('Battery', 'Battery light', 107, { 0: 'On', 1: 'Off' }, 'confident: both sources (0 = light on)'),
  numSetting('Battery', 'Low SOC warning', 109, 1, '%', 0, 100, 'UNVERIFIED: cloud 40110 only'),
];

export function decodeSettings(defs: LivoltekSetting[], regs: RegisterImage): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const s of defs) {
    const raw = regs.get(s.reg);
    if (raw === undefined) continue;
    if (s.codec.kind === 'enum') {
      out[s.key] = s.codec.map[raw] ?? `Unknown (${raw})`;
    } else {
      const scale = s.codec.scale ?? 1;
      out[s.key] = scale === 1 ? raw : Math.round(raw * scale * 100) / 100;
    }
  }
  return out;
}
