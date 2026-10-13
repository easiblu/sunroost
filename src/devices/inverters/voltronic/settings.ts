/**
 * Voltronic settings: read from QPIRI (positional fields) and QFLAG (letters), written with the
 * PI30 set commands (POP, PCP, PBCV, PE/PD …). Each entry says where its value comes from and how
 * to encode a write; entries without `encode` are read-only. Notes marked UNVERIFIED are not
 * checked against a real unit.
 */
import type { Value } from '../../../core/metrics.ts';
import type { SettingDef, SettingValues } from '../../types.ts';
import { decodeFlags } from './decode.ts';

export type VoltronicModel = 'axpert' | 'axpert_king' | 'axpert_max' | 'infinisolar';

/** What a setting's encoding may depend on. */
export interface SettingContext {
  model: VoltronicModel;
  /** Nominal battery voltage from QPIRI (12/24/48); voltage ranges scale with it. */
  nominalVoltage: number;
  chargeCurrents: string[];
  gridChargeCurrents: string[];
}

export interface VoltronicSetting {
  label: string;
  section: 'Battery' | 'Input/output' | 'Miscellaneous' | 'Solar PV';
  type: SettingDef['type'];
  /** QPIRI field index, or a QFLAG letter. */
  source: { qpiri: number } | { flag: string };
  /** Code → label for select fields (QPIRI value text as the key). */
  codes?: Record<string, string>;
  unit?: string;
  /** Number range for a 48 V system; scaled by nominal voltage / 48. */
  range48?: [number, number];
  /** Models it applies to; default all. */
  models?: VoltronicModel[];
  /** Builds the set command. Absent → read-only. */
  encode?: (value: Value, ctx: SettingContext) => string;
  note: string;
}

const pad = (n: number, width: number) => String(Math.round(n)).padStart(width, '0');
/** Voltage as "nn.n", the PI30 format for PBCV/PBDV/PSDV/PBFT/PCVV. */
export const volts = (v: Value) => Number(v).toFixed(1).padStart(4, '0');

/** Reverse lookup of a select label to its two-digit code. */
function codeOf(codes: Record<string, string>, value: Value): string {
  const hit = Object.entries(codes).find(([, label]) => label === value);
  if (!hit) throw new Error(`Unsupported value '${value}'`);
  return hit[0].padStart(2, '0');
}

const OUTPUT_PRIORITY: Record<string, string> = { '0': 'Utility first', '1': 'Solar first', '2': 'Solar/Battery/Utility' };
const CHARGER_PRIORITY: Record<string, string> = {
  '0': 'Utility first', '1': 'Solar first', '2': 'Solar and utility simultaneously', '3': 'Solar only',
};
/** MKS II / King / MAX drop "Utility first" for the charger (PCP00 is NAKed) — UNVERIFIED per firmware. */
const CHARGER_PRIORITY_NEW: Record<string, string> = { '1': 'Solar first', '2': 'Solar and utility simultaneously', '3': 'Solar only' };
/** 0–2 are PI30; 3+ are lithium presets on newer firmware (UNVERIFIED, not writable). */
const BATTERY_TYPES: Record<string, string> = {
  '0': 'AGM', '1': 'Flooded', '2': 'User-defined', '3': 'Pylontech', '4': 'Shinheung', '5': 'WECO', '6': 'Soltaro',
  '8': 'LIB protocol', '9': 'Lithium (LIC)',
};
const OUTPUT_MODES: Record<string, string> = {
  '0': 'Single', '1': 'Parallel', '2': 'Phase 1 of 3 Phase output', '3': 'Phase 2 of 3 Phase output',
  '4': 'Phase 3 of 3 Phase output', '5': 'Phase 1 of split phase', '6': 'Phase 2 of split phase (120°)',
  '7': 'Phase 2 of split phase (180°)',
};

const flag = (label: string, letter: string, section: VoltronicSetting['section'], note: string): VoltronicSetting => ({
  label, section, type: 'checkbox', source: { flag: letter },
  encode: (v) => `${v === true ? 'PE' : 'PD'}${letter}`,
  note,
});

const voltage = (
  label: string, field: number, command: string, range48: [number, number], note: string,
): VoltronicSetting => ({
  label, section: 'Battery', type: 'number', unit: 'V', source: { qpiri: field }, range48,
  encode: (v) => `${command}${volts(v)}`,
  note,
});

export const SETTINGS: VoltronicSetting[] = [
  // Battery
  {
    label: 'Battery type', section: 'Battery', type: 'select', source: { qpiri: 12 }, codes: BATTERY_TYPES,
    encode: (v) => {
      const code = codeOf(BATTERY_TYPES, v);
      if (Number(code) > 2) throw new Error(`Setting battery type '${v}' is not supported (UNVERIFIED code)`);
      return `PBT${code}`;
    },
    note: 'QPIRI[12]; PBT00 AGM / 01 Flooded / 02 User. Lithium codes 3+ are UNVERIFIED and read-only.',
  },
  {
    label: 'Charger source priority', section: 'Battery', type: 'select', source: { qpiri: 17 }, codes: CHARGER_PRIORITY,
    models: ['axpert', 'infinisolar'],
    encode: (v) => `PCP${codeOf(CHARGER_PRIORITY, v)}`,
    note: 'QPIRI[17]; PCP00..03',
  },
  {
    label: 'Charger source priority', section: 'Battery', type: 'select', source: { qpiri: 17 }, codes: CHARGER_PRIORITY_NEW,
    models: ['axpert_king', 'axpert_max'],
    encode: (v) => `PCP${codeOf(CHARGER_PRIORITY_NEW, v)}`,
    note: 'QPIRI[17]; PCP01..03 (no utility-first on MKS II/King/MAX, UNVERIFIED)',
  },
  voltage('Shutdown battery voltage', 9, 'PSDV', [40, 48], 'QPIRI[9] battery under voltage; PSDVnn.n'),
  voltage('To grid battery voltage', 8, 'PBCV', [44, 51], 'QPIRI[8] battery re-charge voltage; PBCVnn.n'),
  voltage('Back to battery voltage', 22, 'PBDV', [0, 58], 'QPIRI[22] battery re-discharge voltage; PBDVnn.n, 00.0 = battery full'),
  voltage('Battery float charge voltage', 11, 'PBFT', [48, 58.4], 'QPIRI[11]; PBFTnn.n'),
  voltage('Battery absorption charge voltage', 10, 'PCVV', [48, 58.4], 'QPIRI[10] bulk (CV) voltage; PCVVnn.n'),
  {
    label: 'Max charge current', section: 'Battery', type: 'select', unit: 'A', source: { qpiri: 14 },
    encode: (v, ctx) => {
      const a = Number(v);
      // MCHGC<mnn> (m = parallel unit 0) only fits two digits; MNCHGC<mnnn> is the newer form.
      return ctx.model === 'axpert' && a < 100 ? `MCHGC${pad(a, 3)}` : `MNCHGC0${pad(a, 3)}`;
    },
    note: 'QPIRI[14]; options from QMCHGCR; MCHGC0nn (Axpert) / MNCHGC0nnn (King/MAX, ≥100 A)',
  },
  {
    label: 'Max grid charge current', section: 'Battery', type: 'select', unit: 'A', source: { qpiri: 13 },
    encode: (v) => `MUCHGC${pad(Number(v), 3)}`,
    note: 'QPIRI[13]; options from QMUCHGCR; MUCHGCnnn (values ≥100 A UNVERIFIED)',
  },

  // Input/output
  {
    label: 'Output mode', section: 'Input/output', type: 'select', source: { qpiri: 21 }, codes: OUTPUT_MODES,
    note: 'QPIRI[21]; read-only (changing parallel/phase setup belongs on the LCD)',
  },
  {
    label: 'AC input voltage range', section: 'Input/output', type: 'select', source: { qpiri: 15 },
    codes: { '0': 'Appliance', '1': 'UPS' },
    encode: (v) => `PGR${codeOf({ '0': 'Appliance', '1': 'UPS' }, v)}`,
    note: 'QPIRI[15]; PGR00 Appliance / PGR01 UPS',
  },
  {
    label: 'AC output voltage', section: 'Input/output', type: 'number', unit: 'V', source: { qpiri: 2 },
    note: 'QPIRI[2]; read-only',
  },
  {
    label: 'AC output frequency', section: 'Input/output', type: 'select', unit: 'Hz', source: { qpiri: 3 },
    codes: { '50.0': '50', '60.0': '60' },
    note: 'QPIRI[3]; read-only (F50/F60 only accepted in standby)',
  },
  {
    label: 'Output source priority', section: 'Input/output', type: 'select', source: { qpiri: 16 }, codes: OUTPUT_PRIORITY,
    encode: (v) => `POP${codeOf(OUTPUT_PRIORITY, v)}`,
    note: 'QPIRI[16]; POP00 Utility first / POP01 Solar first / POP02 SBU',
  },
  {
    label: 'Operation logic', section: 'Input/output', type: 'select', source: { qpiri: 26 },
    codes: { '0': 'Automatic', '1': 'Online mode', '2': 'ECO mode' }, models: ['axpert_king', 'axpert_max'],
    note: 'UNVERIFIED: QPIRI[26] on King; read-only',
  },
  flag('Overload bypass', 'b', 'Input/output', 'QFLAG b; PEb/PDb'),
  flag('Overload restart', 'u', 'Input/output', 'QFLAG u; PEu/PDu'),
  flag('Primary source interrupt alarm', 'y', 'Input/output', 'QFLAG y; PEy/PDy'),

  // Miscellaneous
  flag('Buzzer', 'a', 'Miscellaneous', 'QFLAG a; PEa/PDa'),
  flag('LCD backlight', 'x', 'Miscellaneous', 'QFLAG x; PEx/PDx'),
  flag('LCD reset to default', 'k', 'Miscellaneous', 'QFLAG k; PEk/PDk (escape to default page after 1 min)'),
  flag('Over temperature restart', 'v', 'Miscellaneous', 'QFLAG v; PEv/PDv'),
  flag('Power saving', 'j', 'Miscellaneous', 'QFLAG j; PEj/PDj'),
  flag('Record fault code', 'z', 'Miscellaneous', 'QFLAG z; PEz/PDz'),

  // Solar PV
  {
    label: 'PV OK condition', section: 'Solar PV', type: 'select', source: { qpiri: 23 },
    codes: { '0': 'One unit has PV', '1': 'All units have PV' }, models: ['axpert_king', 'axpert_max'],
    note: 'UNVERIFIED: QPIRI[23] PV OK condition for parallel; read-only',
  },
  {
    label: 'PV power balance', section: 'Solar PV', type: 'select', source: { qpiri: 24 },
    codes: { '0': 'Charge current limited', '1': 'Charge + load' }, models: ['axpert_king', 'axpert_max'],
    note: 'UNVERIFIED: QPIRI[24] PV power balance; read-only',
  },
];

export const settingKey = (label: string) => label.toLowerCase().replace(/ /g, '_');

/** The settings that apply to a model. InfiniSolar is UNVERIFIED: everything is read-only there. */
export function modelSettings(model: VoltronicModel): VoltronicSetting[] {
  const list = SETTINGS.filter((s) => !s.models || s.models.includes(model));
  return model === 'infinisolar' ? list.map(({ encode: _e, ...s }) => s) : list;
}

const DEFAULT_CHARGE = ['10', '20', '30', '40', '50', '60', '70', '80'];
const DEFAULT_GRID_CHARGE = ['2', '10', '20', '30', '40', '50', '60'];

export function settingDefs(ctx: SettingContext): SettingDef[] {
  const f = (ctx.nominalVoltage || 48) / 48;
  return modelSettings(ctx.model).map((s): SettingDef => {
    const def: SettingDef = { key: settingKey(s.label), label: s.label, section: s.section, type: s.type };
    if (s.unit) def.unit = s.unit;
    if (s.codes) def.options = [...new Set(Object.values(s.codes))];
    if (s.label === 'Max charge current') def.options = ctx.chargeCurrents.length ? ctx.chargeCurrents : DEFAULT_CHARGE;
    if (s.label === 'Max grid charge current') def.options = ctx.gridChargeCurrents.length ? ctx.gridChargeCurrents : DEFAULT_GRID_CHARGE;
    if (s.range48) {
      def.min = Math.round(s.range48[0] * f * 10) / 10;
      def.max = Math.round(s.range48[1] * f * 10) / 10;
      def.step = 0.1;
    }
    if (!s.encode) def.readOnly = true;
    return def;
  });
}

/** Decodes QPIRI (+ QFLAG) into setting values. Missing fields are left out. */
export function decodeSettings(model: VoltronicModel, qpiri: string, qflag: string | null): SettingValues {
  const f = qpiri.trim().split(/\s+/);
  const flags = qflag ? decodeFlags(qflag) : {};
  const out: SettingValues = {};
  for (const s of modelSettings(model)) {
    const key = settingKey(s.label);
    if ('flag' in s.source) {
      if (s.source.flag in flags) out[key] = flags[s.source.flag];
      continue;
    }
    const raw = f[s.source.qpiri];
    if (raw === undefined || raw === '') continue;
    if (s.codes) {
      // Codes are compared numerically ("01" == "1", "50.0" == "50").
      const hit = Object.entries(s.codes).find(([code]) => Number(code) === Number(raw));
      out[key] = hit ? hit[1] : `Unknown (${raw})`;
    } else if (s.type === 'select') {
      out[key] = String(Number(raw));
    } else {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : raw;
    }
  }
  return out;
}

/** The set command for one setting (throws for read-only or unknown settings). */
export function encodeSetting(model: VoltronicModel, key: string, value: Value, ctx: SettingContext): string {
  const s = modelSettings(model).find((d) => settingKey(d.label) === key);
  if (!s) throw new Error(`Unknown setting: ${key}`);
  if (!s.encode) throw new Error(`'${s.label}' is read-only on this model`);
  return s.encode(value, ctx);
}
