/**
 * Solar surplus: power that extra loads could use right now without importing from the grid or
 * taking it from the battery.
 *
 * - While the battery is below `batterySoc` (default 90%) it has first claim on the sun, so only
 *   what is exported counts.
 * - Once it's nearly full, everything solar makes beyond the house load counts (an inverter that
 *   can't export curtails solar, so export alone would show nothing).
 * - Importing, or discharging the battery, means no surplus.
 */

export interface SurplusInputs {
  pvW: number | null;
  loadW: number | null;
  /** + import, − export. */
  gridW: number | null;
  /** + charging, − discharging. */
  batteryW: number | null;
  soc: number | null;
}

/** Below this the readings are noise. */
const DEADBAND_W = 50;

export function surplusW(i: SurplusInputs, batterySoc = 90): number | null {
  if (i.pvW === null || i.loadW === null) return null;
  if ((i.gridW ?? 0) > DEADBAND_W) return 0;
  if ((i.batteryW ?? 0) < -DEADBAND_W) return 0;
  const exportW = Math.max(0, -(i.gridW ?? 0));
  const batteryFull = i.soc === null ? i.batteryW === null : i.soc >= batterySoc;
  const v = batteryFull ? Math.max(exportW, i.pvW - i.loadW) : exportW;
  return Math.max(0, Math.round(v));
}
