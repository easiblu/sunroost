/**
 * Pylontech/Sunsynk inverter-BMS CAN protocol (500 kbit/s, 11-bit IDs, little-endian). The
 * BMS broadcasts these about once a second; the inverter answers with 0x305 keep-alives,
 * which we ignore. The whole bank appears as one pack.
 *
 * 0x351 charge voltage limit (0.1 V), charge current limit (0.1 A), discharge current limit
 *       (0.1 A), discharge voltage limit (0.1 V)
 * 0x355 SOC (%), SOH (%)
 * 0x356 voltage (0.01 V), current (0.1 A, signed), temperature (0.1 °C)
 * 0x359 protection flags (bytes 0–1), alarm flags (bytes 2–3), module count (byte 4), "PN"
 * 0x35C request flags: charge enable, discharge enable, force charge I/II, full charge
 * 0x35E manufacturer name, ASCII ("PYLON")
 * 0x370 Sunsynk: max/min cell temperature (0.1 °C), max/min cell voltage (mV) [verify order]
 * 0x371 Sunsynk: IDs of those cells [verify]
 * 0x373 extended (Victron-style, sent by many Pylontech-protocol BMSs): min/max cell voltage
 *       (mV), min/max cell temperature (K) [verify]
 * 0x379 extended: installed capacity (Ah) [verify]
 */
import type { Metrics } from '../../../core/metrics.ts';
import { bitNames, packMetrics, round } from '../pack.ts';
import type { CanFrame } from './frames.ts';

const u16 = (d: Buffer, o: number) => (d.length >= o + 2 ? d.readUInt16LE(o) : undefined);
const s16 = (d: Buffer, o: number) => (d.length >= o + 2 ? d.readInt16LE(o) : undefined);
const scale = (v: number | undefined, f: number) => (v === undefined ? undefined : v * f);

export function decode351(d: Buffer) {
  return {
    chargeVoltage: scale(u16(d, 0), 0.1),
    chargeCurrent: scale(s16(d, 2), 0.1),
    dischargeCurrent: scale(s16(d, 4), 0.1),
    dischargeVoltage: scale(u16(d, 6), 0.1),
  };
}

export function decode355(d: Buffer) {
  return { soc: u16(d, 0), soh: u16(d, 2) };
}

export function decode356(d: Buffer) {
  return { voltage: scale(s16(d, 0), 0.01), current: scale(s16(d, 2), 0.1), temperature: scale(s16(d, 4), 0.1) };
}

const PROTECTION = [
  ['', 'Over voltage protection', 'Under voltage protection', 'Over temperature protection',
    'Under temperature protection', '', '', 'Discharge over current protection'],
  ['Charge over current protection', '', '', 'System error'],
];
const ALARM = [
  ['', 'High voltage alarm', 'Low voltage alarm', 'High temperature alarm', 'Low temperature alarm', '', '',
    'Discharge high current alarm'],
  ['Charge high current alarm', '', '', 'Internal communication failure'],
];

export function decode359(d: Buffer) {
  const alarms = [
    ...bitNames(d[0] ?? 0, PROTECTION[0]),
    ...bitNames(d[1] ?? 0, PROTECTION[1]),
    ...bitNames(d[2] ?? 0, ALARM[0]),
    ...bitNames(d[3] ?? 0, ALARM[1]),
  ];
  return { alarms, modules: d.length > 4 ? d[4] : undefined };
}

export function decode35C(d: Buffer) {
  const b = d[0] ?? 0;
  return {
    chargeEnable: Boolean(b & 0x80),
    dischargeEnable: Boolean(b & 0x40),
    forceCharge1: Boolean(b & 0x20),
    forceCharge2: Boolean(b & 0x10),
    fullCharge: Boolean(b & 0x08),
  };
}

export function decode35E(d: Buffer) {
  return d.toString('latin1').replace(/[\0\s]+$/g, '').replace(/[^\x20-\x7e]/g, '').trim();
}

/** Sunsynk 0x370 [verify]: max cell temp, min cell temp (0.1 °C), max cell V, min cell V (mV). */
export function decode370(d: Buffer) {
  return {
    cellTempMax: scale(s16(d, 0), 0.1),
    cellTempMin: scale(s16(d, 2), 0.1),
    cellVoltageMax: scale(u16(d, 4), 0.001),
    cellVoltageMin: scale(u16(d, 6), 0.001),
  };
}

/** Sunsynk 0x371 [verify]: cell numbers of the max/min temperature and voltage. */
export function decode371(d: Buffer) {
  return { cellTempMaxId: u16(d, 0), cellTempMinId: u16(d, 2), cellVoltageMaxId: u16(d, 4), cellVoltageMinId: u16(d, 6) };
}

/** Extended 0x373 [verify]: min cell V, max cell V (mV), min cell temp, max cell temp (K). */
export function decode373(d: Buffer) {
  const k = (v: number | undefined) => (v === undefined ? undefined : v - 273.15);
  return {
    cellVoltageMin: scale(u16(d, 0), 0.001),
    cellVoltageMax: scale(u16(d, 2), 0.001),
    cellTempMin: k(u16(d, 4)),
    cellTempMax: k(u16(d, 6)),
  };
}

/** Extended 0x379 [verify]: installed capacity (Ah). */
export function decode379(d: Buffer) {
  return { capacityAh: u16(d, 0) };
}

type Bank = Partial<
  ReturnType<typeof decode351> & ReturnType<typeof decode355> & ReturnType<typeof decode356> &
  ReturnType<typeof decode35C> & ReturnType<typeof decode370> & ReturnType<typeof decode379>
> & { alarms?: string[]; modules?: number; manufacturer?: string };

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Accumulates broadcast frames into one bank reading. */
export class CanBank {
  private b: Bank = {};
  /** Recognised BMS frames seen so far. */
  frames = 0;

  /** Applies one frame; returns whether its ID is a BMS broadcast we understand. */
  apply(f: CanFrame): boolean {
    if (f.ext || f.rtr) return false;
    const d = f.data;
    switch (f.id) {
      case 0x351: Object.assign(this.b, defined(decode351(d))); break;
      case 0x355: Object.assign(this.b, defined(decode355(d))); break;
      case 0x356: Object.assign(this.b, defined(decode356(d))); break;
      case 0x359: Object.assign(this.b, defined(decode359(d))); break;
      case 0x35c: Object.assign(this.b, decode35C(d)); break;
      case 0x35e: {
        const name = decode35E(d);
        if (name) this.b.manufacturer = name;
        break;
      }
      case 0x370: case 0x373: Object.assign(this.b, defined(f.id === 0x370 ? decode370(d) : decode373(d))); break;
      case 0x379: Object.assign(this.b, defined(decode379(d))); break;
      default: return false;
    }
    this.frames++;
    return true;
  }

  metrics(): Metrics {
    const b = this.b;
    const m = packMetrics({
      soc: b.soc,
      soh: b.soh,
      voltage: b.voltage,
      current: b.current,
      temperature: b.temperature,
      maxChargeCurrent: b.chargeCurrent,
      maxDischargeCurrent: b.dischargeCurrent,
      fullAh: b.capacityAh || undefined,
      remainingAh: b.capacityAh && b.soc !== undefined ? (b.capacityAh * b.soc) / 100 : undefined,
      alarms: b.alarms,
      model: b.manufacturer,
    });
    if (b.chargeVoltage !== undefined) m['Recommended charge voltage'] = round(b.chargeVoltage, 1);
    if (b.dischargeVoltage !== undefined) m['Recommended discharge voltage'] = round(b.dischargeVoltage, 1);
    if (b.chargeEnable !== undefined) {
      m['Charge enabled'] = b.chargeEnable ? 'Yes' : 'No';
      m['Discharge enabled'] = b.dischargeEnable ? 'Yes' : 'No';
      m['Force charge'] = b.forceCharge1 || b.forceCharge2 ? 'Yes' : 'No';
    }
    if (b.modules !== undefined) m['Module count'] = b.modules;
    const vHi = b.cellVoltageMax;
    const vLo = b.cellVoltageMin;
    if (vHi) m['Cell voltage - Highest'] = round(vHi, 3);
    if (vLo) m['Cell voltage - Lowest'] = round(vLo, 3);
    if (vHi && vLo) m['Cell voltage - Difference'] = round(vHi - vLo, 3);
    if (b.cellTempMax !== undefined) m['Cell temperature - Highest'] = round(b.cellTempMax, 1);
    if (b.cellTempMin !== undefined) m['Cell temperature - Lowest'] = round(b.cellTempMin, 1);
    return m;
  }
}
