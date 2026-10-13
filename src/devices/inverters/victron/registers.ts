/**
 * Victron GX Modbus TCP register map (holding registers, function 3), from Victron's public
 * "CCGX-Modbus-TCP-register-list" spreadsheet. Each D-Bus service answers on its own unit id:
 * com.victronenergy.system and com.victronenergy.settings on 100, the VE.Bus inverter/charger on
 * 227 / 246 / 242 (varies with firmware and port; the GX lists it under Settings → Services →
 * Modbus TCP → Available services).
 *
 * Confidence per register is in the comments: "confident" = matches the published list as known,
 * "UNVERIFIED" = not certain of the address or scale.
 */
import { round, s16, type Metrics } from '../../../core/metrics.ts';
import { regsToAscii } from '../../ascii.ts';

/** Register address → raw 16-bit value, for one unit id. */
export type RegisterImage = Map<number, number>;

export function image(start: number, regs: number[], into: RegisterImage = new Map()): RegisterImage {
  regs.forEach((v, i) => into.set(start + i, v));
  return into;
}

/** com.victronenergy.system unit id. */
export const SYSTEM_UNIT = 100;
/** VE.Bus unit ids tried in order; the first that answers is kept. */
export const VEBUS_UNITS = [227, 246, 242];

/**
 * System spans read each poll. Read in separate blocks because the GX rejects a read that spans an
 * undefined register (827–839 and 847–849 are gaps on older firmware).
 */
export const SYSTEM_SERIAL_SPAN: [number, number] = [800, 6]; // 800–805 serial (VRM id), string[6] — confident
export const SYSTEM_AC_SPAN: [number, number] = [808, 19]; // 808–826 AC PV / consumption / grid / genset / active input — confident
export const SYSTEM_BATTERY_SPAN: [number, number] = [840, 5]; // 840–844 battery V/I/P/SOC/state — confident
export const SYSTEM_DCPV_SPAN: [number, number] = [850, 2]; // 850–851 DC-coupled PV power/current — confident
export const SYSTEM_DC_SPAN: [number, number] = [860, 1]; // 860 DC system power — confident (optional read)

/** VE.Bus core block 3–41 (input/output per phase, battery, state, error, switch, ESS setpoints). */
export const VEBUS_SPAN: [number, number] = [3, 39];
/** VE.Bus battery temperature (int16, 0.1 °C) — UNVERIFIED address; read separately and optional. */
export const VEBUS_TEMP_SPAN: [number, number] = [61, 1];

/*
 * System (unit 100):
 *   808–810 AC-coupled PV on output L1–L3, uint16 W — confident
 *   811–813 AC-coupled PV on input L1–L3, uint16 W — confident
 *   814–816 AC-coupled PV on generator L1–L3, uint16 W — confident
 *   817–819 AC consumption L1–L3, uint16 W — confident
 *   820–822 grid L1–L3, int16 W (+ import) — confident
 *   823–825 genset L1–L3, int16 W — confident
 *   826     active input source: 0 unknown, 1 grid, 2 generator, 3 shore, 240 not connected — confident
 *   840     battery voltage, uint16 0.1 V — confident
 *   841     battery current, int16 0.1 A — confident
 *   842     battery power, int16 W (+ charging) — confident
 *   843     battery SOC, uint16 % — confident
 *   844     battery state: 0 idle, 1 charging, 2 discharging — confident
 *   850     DC-coupled PV power, uint16 W — confident
 *   851     DC-coupled PV current, int16 0.1 A — confident
 *   860     DC system power, int16 W — confident
 *
 * VE.Bus (unit 227 / 246 / 242):
 *   3–5   input voltage L1–L3, uint16 0.1 V — confident
 *   6–8   input current L1–L3, int16 0.1 A — confident
 *   9–11  input frequency L1–L3, int16 0.01 Hz — confident
 *   12–14 input power L1–L3, int16 ×10 W (scale 0.1 in the list) — confident
 *   15–17 output voltage L1–L3, uint16 0.1 V — confident
 *   18–20 output current L1–L3, int16 0.1 A — confident
 *   21    output frequency, int16 0.01 Hz — confident
 *   22    active input current limit, int16 0.1 A — confident
 *   23–25 output power L1–L3, int16 ×10 W — confident
 *   26    battery voltage, uint16 0.01 V — confident
 *   27    battery current, int16 0.1 A (+ charging) — confident
 *   28    phase count — confident
 *   29    active input: 0 AC-in 1, 1 AC-in 2, 240 disconnected — confident
 *   30    VE.Bus SOC, uint16 0.1 % — confident
 *   31    VE.Bus state (see STATES) — confident
 *   32    VE.Bus error (see ERRORS) — confident
 *   33    switch position: 1 charger only, 2 inverter only, 3 on, 4 off — confident
 *   37    ESS power setpoint L1, int16 W — UNVERIFIED (the brief listed 37 as "mode"; the public list
 *         as remembered has the Hub4 L1 AC power setpoint here, so it is decoded as that)
 *   61    battery temperature, int16 0.1 °C — UNVERIFIED
 */

export const STATES: Record<number, string> = {
  0: 'Off',
  1: 'Low power',
  2: 'Fault',
  3: 'Bulk',
  4: 'Absorption',
  5: 'Float',
  6: 'Storage',
  7: 'Equalize',
  8: 'Passthru',
  9: 'Inverting',
  10: 'Power assist',
  11: 'Power supply',
  244: 'Sustain', // UNVERIFIED code
  252: 'External control',
};

/** VE.Bus error codes (register 32) — confident for the common ones, wording ours. */
export const ERRORS: Record<number, string> = {
  0: 'None',
  1: 'Device switched off by another phase',
  2: 'Mixed old and new devices',
  3: 'Not all devices found',
  4: 'No other device detected',
  5: 'AC overvoltage on output',
  6: 'DDC program error',
  7: 'VE.Bus BMS without assistant',
  10: 'System time synchronisation problem',
  14: 'Device cannot transmit data',
  16: 'Dongle missing',
  17: 'No master',
  18: 'AC overvoltage',
  22: 'Device cannot be slave',
  24: 'Switch-over system protection',
  25: 'Firmware incompatibility',
  26: 'Internal error',
};

export const SWITCH_POSITIONS: Record<number, string> = { 1: 'Charger only', 2: 'Inverter only', 3: 'On', 4: 'Off' };
const BATTERY_STATES: Record<number, string> = { 0: 'Idle', 1: 'Charging', 2: 'Discharging' };
const INPUT_SOURCES: Record<number, string> = { 0: 'Unknown', 1: 'Grid', 2: 'Generator', 3: 'Shore', 240: 'Not connected' };

const u = (m: RegisterImage, a: number) => m.get(a);
function i16(m: RegisterImage, a: number) {
  const v = m.get(a);
  return v === undefined ? undefined : s16(v);
}
/** Unsigned value, treating 0xFFFF (the GX's "invalid") as missing. */
function uv(m: RegisterImage, a: number) {
  const v = m.get(a);
  return v === undefined || v === 0xffff ? undefined : v;
}
/** Signed value, treating 0x7FFF (the GX's "invalid" for int16) as missing. */
function sv(m: RegisterImage, a: number) {
  const v = m.get(a);
  return v === undefined || v === 0x7fff ? undefined : s16(v);
}
const n = (v: number | undefined) => v ?? 0;

/** Serial (VRM portal id) at 800–805, ASCII. */
export function decodeSerial(sys: RegisterImage): string {
  const regs = Array.from({ length: 6 }, (_, i) => sys.get(800 + i) ?? 0);
  return regsToAscii(regs).replace(/[^\x20-\x7e]/g, '').trim();
}

/** How many phases carry data: the VE.Bus phase count, or the highest phase with a non-zero reading. */
export function phaseCount(sys: RegisterImage, vb: RegisterImage | null): 1 | 2 | 3 {
  let p = 1;
  const pc = vb ? uv(vb, 28) : undefined;
  if (pc !== undefined && pc >= 1 && pc <= 3) p = pc;
  for (const ph of [2, 3]) {
    const i = ph - 1;
    const sysVals = [808, 811, 814, 817, 820, 823].map((b) => n(i16(sys, b + i)));
    const vbVals = vb ? [3, 12, 15, 23].map((b) => n(i16(vb, b + i))) : [];
    if ([...sysVals, ...vbVals].some((v) => v !== 0)) p = Math.max(p, ph);
  }
  return p as 1 | 2 | 3;
}

/**
 * System + optional VE.Bus images → Sunroost metrics. The system service is authoritative for
 * power flows (it includes grid meters, AC-coupled PV inverters and MPPTs); VE.Bus adds voltages,
 * frequencies, state and errors.
 */
export function decodeLive(sys: RegisterImage, vb: RegisterImage | null): Metrics {
  const out: Metrics = {};
  const phases = phaseCount(sys, vb);
  const idx = Array.from({ length: phases }, (_, i) => i);

  // PV: AC-coupled on output + input + generator, plus DC-coupled (MPPTs).
  const acPv = idx.map((i) => n(uv(sys, 808 + i)) + n(uv(sys, 811 + i)) + n(uv(sys, 814 + i)));
  const dcPv = n(uv(sys, 850));
  out['PV power'] = acPv.reduce((a, b) => a + b, 0) + dcPv;
  if (uv(sys, 850) !== undefined) out['PV power 1'] = dcPv;
  const dcPvI = sv(sys, 851);
  if (dcPvI !== undefined) out['PV current 1'] = round(dcPvI / 10, 1);
  if (acPv.some((v) => v !== 0)) out['PV power AC-coupled'] = acPv.reduce((a, b) => a + b, 0);

  // Battery (system service).
  const bv = uv(sys, 840);
  if (bv !== undefined) out['Battery voltage'] = round(bv / 10, 1);
  const bi = sv(sys, 841);
  if (bi !== undefined) out['Battery current'] = round(bi / 10, 1);
  const bp = sv(sys, 842);
  if (bp !== undefined) out['Battery power'] = bp;
  const soc = uv(sys, 843);
  if (soc !== undefined && soc <= 100) out['Battery state of charge'] = soc;
  const bs = u(sys, 844);
  if (bs !== undefined && BATTERY_STATES[bs]) out['Battery state'] = BATTERY_STATES[bs];

  // Grid and load (system service), per phase.
  const grid = idx.map((i) => n(sv(sys, 820 + i)));
  const load = idx.map((i) => n(uv(sys, 817 + i)));
  out['Grid power'] = grid.reduce((a, b) => a + b, 0);
  out['Load power'] = load.reduce((a, b) => a + b, 0);
  const gen = idx.map((i) => n(sv(sys, 823 + i)));
  if (gen.some((v) => v !== 0)) out['Generator power'] = gen.reduce((a, b) => a + b, 0);
  const src = u(sys, 826);
  if (src !== undefined && INPUT_SOURCES[src]) out['AC input source'] = INPUT_SOURCES[src];
  const dcSys = sv(sys, 860);
  if (dcSys !== undefined) out['DC system power'] = dcSys;
  if (phases > 1) {
    idx.forEach((i) => {
      out[`Grid power ${i + 1}`] = grid[i];
      out[`Load power ${i + 1}`] = load[i];
    });
  }

  if (vb) {
    const vin = idx.map((i) => uv(vb, 3 + i));
    const fin = sv(vb, 9);
    const vout = idx.map((i) => uv(vb, 15 + i));
    const iout = idx.map((i) => sv(vb, 18 + i));
    const pout = idx.map((i) => sv(vb, 23 + i));
    if (vin[0] !== undefined) out['Grid voltage'] = round(vin[0] / 10, 1);
    if (fin !== undefined) out['Grid frequency'] = round(fin / 100, 2);
    if (vout[0] !== undefined) out['AC output voltage'] = round(vout[0] / 10, 1);
    const fout = sv(vb, 21);
    if (fout !== undefined) out['AC output frequency'] = round(fout / 100, 2);
    if (pout.some((v) => v !== undefined)) out['AC output power'] = pout.reduce<number>((a, v) => a + n(v) * 10, 0);
    if (phases > 1) {
      idx.forEach((i) => {
        if (vin[i] !== undefined) out[`Grid voltage ${i + 1}`] = round(vin[i]! / 10, 1);
        if (vout[i] !== undefined) out[`AC output voltage ${i + 1}`] = round(vout[i]! / 10, 1);
        if (iout[i] !== undefined) out[`AC output current ${i + 1}`] = round(iout[i]! / 10, 1);
      });
    } else if (iout[0] !== undefined) {
      out['AC output current'] = round(iout[0] / 10, 1);
    }
    const limit = sv(vb, 22);
    if (limit !== undefined) out['AC input current limit'] = round(limit / 10, 1);
    // Battery fallbacks when the system service has no battery monitor reading.
    const vbv = uv(vb, 26);
    if (out['Battery voltage'] === undefined && vbv !== undefined) out['Battery voltage'] = round(vbv / 100, 2);
    const vbi = sv(vb, 27);
    if (out['Battery current'] === undefined && vbi !== undefined) out['Battery current'] = round(vbi / 10, 1);
    const vsoc = uv(vb, 30);
    if (out['Battery state of charge'] === undefined && vsoc !== undefined && vsoc <= 1000) out['Battery state of charge'] = round(vsoc / 10, 1);
    if (out['Battery power'] === undefined && typeof out['Battery voltage'] === 'number' && typeof out['Battery current'] === 'number') {
      out['Battery power'] = Math.round(out['Battery voltage'] * out['Battery current']);
    }
    const state = u(vb, 31);
    if (state !== undefined) out['Device mode'] = STATES[state] ?? `Unknown (${state})`;
    const err = u(vb, 32);
    if (err !== undefined) out['Fault code'] = ERRORS[err] ?? `Error ${err}`;
    const temp = sv(vb, 61);
    if (temp !== undefined) out['Battery temperature'] = round(temp / 10, 1);
  }
  return out;
}
