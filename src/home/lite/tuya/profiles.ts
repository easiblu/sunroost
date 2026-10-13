/**
 * What a Tuya device's data points (DPs) mean. Tuya devices report numbered DPs; the meaning depends on the
 * product, so the user picks a profile (or lists the DPs). Values come scaled as integers.
 *
 * - switch: DPs 1–6 are outlets (bool). Very common for plugs, wall switches and power strips.
 * - metering: the common energy plug layout — 1 switch, 9 countdown (s), 17 add_ele, 18 current (mA),
 *   19 power (W × 10), 20 voltage (V × 10). DP 17's unit varies between products (often 0.001 kWh steps).
 * - breaker: the DIN-rail breaker/meter layout ("dlq" category) as widely reported — 16 switch, 1 total
 *   forward energy (kWh × 100), 6 phase A as base64 raw (V × 10 in 2 bytes, mA in 3, W in 3). Less certain:
 *   many breakers instead use the metering layout; choose that, or Custom, if values look wrong.
 */

export type DpKind = 'switch' | 'sensor' | 'binary_sensor' | 'countdown' | 'phase';

export interface DpDef {
  dp: string;
  kind: DpKind;
  /** Name suffix ("" = the device itself). */
  name: string;
  scale?: number;
  unit?: string | null;
}

export type ProfileId = 'switch' | 'metering' | 'breaker' | 'custom';

export const PROFILES: { value: ProfileId; label: string; title: string }[] = [
  { value: 'switch', label: 'Switch or plug (1–6 outlets)', title: 'Tuya switch' },
  { value: 'metering', label: 'Plug with energy metering', title: 'Tuya plug' },
  { value: 'breaker', label: 'Circuit breaker / DIN-rail meter', title: 'Tuya breaker' },
  { value: 'custom', label: 'Custom data points', title: 'Tuya device' },
];

export function defsFor(profile: ProfileId, outlets: number, custom: DpDef[]): DpDef[] {
  switch (profile) {
    case 'switch':
      return Array.from({ length: outlets }, (_, i) => ({ dp: String(i + 1), kind: 'switch' as const, name: outlets === 1 ? '' : `outlet ${i + 1}` }));
    case 'metering':
      return [
        { dp: '1', kind: 'switch', name: '' },
        { dp: '9', kind: 'countdown', name: 'countdown' },
        { dp: '19', kind: 'sensor', name: 'power', scale: 0.1, unit: 'W' },
        { dp: '18', kind: 'sensor', name: 'current', scale: 0.001, unit: 'A' },
        { dp: '20', kind: 'sensor', name: 'voltage', scale: 0.1, unit: 'V' },
        { dp: '17', kind: 'sensor', name: 'energy added', scale: 0.001, unit: 'kWh' },
      ];
    case 'breaker':
      return [
        { dp: '16', kind: 'switch', name: '' },
        { dp: '1', kind: 'sensor', name: 'energy', scale: 0.01, unit: 'kWh' },
        { dp: '6', kind: 'phase', name: '' },
      ];
    case 'custom':
      return custom;
  }
}

const KINDS: DpKind[] = ['switch', 'sensor', 'binary_sensor', 'countdown'];

/**
 * Custom DPs, one per line: `dp:kind[:scale[:unit[:name]]]`, e.g.
 *   1:switch            19:sensor:0.1:W:power            101:binary_sensor::: door
 * Throws with the line number on a mistake.
 */
export function parseCustom(text: string): DpDef[] {
  const out: DpDef[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [dp, kind, scale, unit, ...name] = line.split(':').map((s) => s.trim());
    if (!/^\d{1,3}$/.test(dp ?? '')) throw new Error(`Line ${i + 1}: "${dp}" is not a DP number`);
    if (!KINDS.includes(kind as DpKind)) throw new Error(`Line ${i + 1}: kind must be one of ${KINDS.join(', ')}`);
    const sc = scale ? Number(scale) : undefined;
    if (sc !== undefined && !(Number.isFinite(sc) && sc > 0)) throw new Error(`Line ${i + 1}: scale must be a positive number`);
    if (out.some((d) => d.dp === dp)) throw new Error(`Line ${i + 1}: DP ${dp} is listed twice`);
    out.push({ dp, kind: kind as DpKind, name: name.join(':') || (kind === 'switch' && !out.some((d) => d.kind === 'switch') ? '' : `dp ${dp}`), scale: sc, unit: unit || null });
  });
  if (!out.some((d) => d.kind !== 'countdown')) throw new Error('List at least one data point');
  return out;
}

/** Breaker phase DP: base64 of V × 10 (2 bytes), mA (3 bytes), W (3 bytes). */
export function decodePhase(raw: unknown): { voltage: number; current: number; power: number } | null {
  if (typeof raw !== 'string') return null;
  const b = Buffer.from(raw, 'base64');
  if (b.length < 8) return null;
  return {
    voltage: b.readUInt16BE(0) / 10,
    current: b.readUIntBE(2, 3) / 1000,
    power: b.readUIntBE(5, 3),
  };
}

export const deviceClassFor = (unit: string | null | undefined) =>
  unit === 'W' ? 'power' : unit === 'A' ? 'current' : unit === 'V' ? 'voltage' : unit === 'kWh' ? 'energy' : unit === '°C' ? 'temperature' : null;

/** A DP's numeric value for display, rounded to its scale's precision. */
export function scaled(v: unknown, scale = 1): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const digits = Math.max(0, Math.ceil(-Math.log10(scale)));
  return Number((v * scale).toFixed(digits));
}
