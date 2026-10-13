/**
 * Simulated inverter for development and demos. Models an off-grid unit (SPF-style, controlled by
 * output source priority) or a hybrid unit (SPH-style, controlled by work mode priority and time slots)
 * with a 10 kWh battery, a 5 kW array following the sun, and a household load profile.
 */
import { round, type Metrics, type Value } from '../../core/metrics.ts';
import type { InverterDriver, InverterDriverDescriptor, SettingDef, SettingValues } from '../types.ts';
import { simulatedDeviceLoadW } from './sim-load.ts';

/** Hours added to the clock for the simulated sun and load (demo/testing only). */
const SIM_HOUR_OFFSET = Number(process.env.SOLAR_SIM_HOUR_OFFSET) || 0;

const ARRAY_W = 5000;
const CAPACITY_WH = 10_000;

const OFFGRID_SETTINGS: SettingDef[] = [
  { key: 'output_source_priority', label: 'Output source priority', section: 'Input/output', type: 'select', options: ['Utility first', 'Solar first', 'Solar/Battery/Utility'] },
  { key: 'charger_source_priority', label: 'Charger source priority', section: 'Battery', type: 'select', options: ['Solar first', 'Solar and utility simultaneously', 'Solar only'] },
  { key: 'max_charge_current', label: 'Max charge current', section: 'Battery', type: 'number', min: 10, max: 120, step: 10, unit: 'A' },
  { key: 'max_grid_charge_current', label: 'Max grid charge current', section: 'Battery', type: 'number', min: 0, max: 80, step: 10, unit: 'A' },
  { key: 'back_to_grid_battery_capacity', label: 'To grid battery capacity', section: 'Battery', type: 'number', min: 5, max: 95, step: 5, unit: '%' },
  { key: 'back_to_battery_capacity', label: 'Back to battery capacity', section: 'Battery', type: 'number', min: 10, max: 100, step: 5, unit: '%' },
  { key: 'shutdown_battery_capacity', label: 'Shutdown battery capacity', section: 'Battery', type: 'number', min: 0, max: 50, step: 5, unit: '%' },
  { key: 'buzzer', label: 'Buzzer', section: 'Miscellaneous', type: 'checkbox' },
  { key: 'lcd_backlight', label: 'LCD backlight', section: 'Miscellaneous', type: 'checkbox' },
];

const HYBRID_PRIORITIES = ['Load first', 'Battery first', 'Grid first'];
const HYBRID_SETTINGS: SettingDef[] = [
  { key: 'work_mode_priority', label: 'Work mode priority', section: 'Work mode', type: 'select', options: HYBRID_PRIORITIES },
  { key: 'battery_first_charge_rate', label: 'Battery first charge rate', section: 'Work mode', type: 'number', min: 0, max: 100, unit: '%' },
  { key: 'battery_first_stop_charge', label: 'Battery first stop charge', section: 'Work mode', type: 'number', min: 10, max: 100, unit: '%' },
  { key: 'battery_first_grid_charge', label: 'Battery first grid charge', section: 'Work mode', type: 'checkbox' },
  { key: 'grid_first_discharge_rate', label: 'Grid first discharge rate', section: 'Work mode', type: 'number', min: 0, max: 100, unit: '%' },
  { key: 'grid_first_stop_discharge', label: 'Grid first stop discharge', section: 'Work mode', type: 'number', min: 10, max: 100, unit: '%' },
  { key: 'load_first_stop_discharge', label: 'Load first stop discharge', section: 'Work mode', type: 'number', min: 10, max: 100, unit: '%' },
  { key: 'export_limiter', label: 'Export limiter', section: 'Grid', type: 'checkbox' },
  { key: 'export_power_rate', label: 'Export power rate', section: 'Grid', type: 'number', min: 0, max: 100, unit: '%' },
  ...[1, 2, 3].map((n): SettingDef => ({ key: `battery_first_slot_${n}`, label: `Battery first slot ${n}`, section: 'Schedule', type: 'slot' })),
  ...[1, 2, 3].map((n): SettingDef => ({ key: `grid_first_slot_${n}`, label: `Grid first slot ${n}`, section: 'Schedule', type: 'slot' })),
];

class SimulatorDriver implements InverterDriver {
  private hybrid: boolean;
  private index: number;
  private soc = 55;
  private lastTs = Date.now();
  private cloud = 1;
  private values: SettingValues;

  constructor(modelId: string, index: number) {
    this.hybrid = modelId === 'hybrid';
    this.index = index;
    this.values = this.hybrid
      ? {
          work_mode_priority: 'Load first', battery_first_charge_rate: 100, battery_first_stop_charge: 100,
          battery_first_grid_charge: true, grid_first_discharge_rate: 100, grid_first_stop_discharge: 20,
          load_first_stop_discharge: 15, export_limiter: false, export_power_rate: 100,
          battery_first_slot_1: '01:00,05:00,true', battery_first_slot_2: '00:00,00:00,false', battery_first_slot_3: '00:00,00:00,false',
          grid_first_slot_1: '17:00,19:00,false', grid_first_slot_2: '00:00,00:00,false', grid_first_slot_3: '00:00,00:00,false',
        }
      : {
          output_source_priority: 'Solar/Battery/Utility', charger_source_priority: 'Solar first',
          max_charge_current: 80, max_grid_charge_current: 30, back_to_grid_battery_capacity: 20,
          back_to_battery_capacity: 40, shutdown_battery_capacity: 10, buzzer: false, lcd_backlight: true,
        };
  }

  info(): Metrics {
    return {
      'Model name': this.hybrid ? 'Simulated hybrid 6kW' : 'Simulated off-grid 5kW',
      'Serial number': `SIM${String(this.index + 1).padStart(7, '0')}`,
      'Firmware version': '1.0.0',
      'Max AC output power': this.hybrid ? 6000 : 5000,
    };
  }

  async connect() {}
  async close() {}

  async read(): Promise<Metrics> {
    const now = new Date();
    const dtH = (now.getTime() - this.lastTs) / 3.6e6;
    this.lastTs = now.getTime();
    // SOLAR_SIM_HOUR_OFFSET shifts the simulated time of day (e.g. to watch midday solar at night).
    const hour = (((now.getHours() + now.getMinutes() / 60 + SIM_HOUR_OFFSET) % 24) + 24) % 24;

    const sun = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 13));
    this.cloud = Math.min(1, Math.max(0.35, this.cloud + (Math.random() - 0.5) * 0.06));
    let pv = ARRAY_W * sun ** 1.3 * this.cloud;
    const evening = hour > 17 && hour < 22 ? 900 : 0;
    const morning = hour > 6.5 && hour < 8.5 ? 500 : 0;
    const load = 330 + evening + morning + Math.random() * 220 + (Math.random() < 0.03 ? 1800 : 0) + simulatedDeviceLoadW();

    let grid = 0;
    let mode: string;
    if (this.hybrid) {
      const prio = this.activeHybridPriority(hour);
      if (prio === 'Battery first') {
        const charge = this.values.battery_first_grid_charge && this.soc < Number(this.values.battery_first_stop_charge) ? 2500 : 0;
        grid = Math.max(0, load + charge - pv);
        if (this.soc >= Number(this.values.battery_first_stop_charge)) grid = Math.max(0, load - pv);
      } else if (prio === 'Grid first' && this.soc > Number(this.values.grid_first_stop_discharge)) {
        grid = -Math.min(3000, pv + 2500 - load);
      } else {
        grid = this.soc <= Number(this.values.load_first_stop_discharge) ? Math.max(0, load - pv) : 0;
        if (this.soc >= 100 && pv > load) grid = -(pv - load);
      }
      mode = grid < 0 ? 'Export' : prio;
    } else {
      const prio = this.values.output_source_priority;
      const lowSoc = Number(this.values.back_to_grid_battery_capacity);
      if (prio === 'Utility first' || this.soc <= lowSoc) grid = load;
      if (this.soc >= 100) pv = Math.min(pv, load - grid);
      mode = grid > 0 ? 'Grid' : 'Solar/Battery';
    }

    const battery = pv + grid - load;
    this.soc = Math.min(100, Math.max(0, this.soc + ((battery * dtH) / CAPACITY_WH) * 100));
    const battV = 48 + (this.soc / 100) * 6 + battery / 2500;
    const pv1 = pv * 0.55;
    const pv2 = pv - pv1;
    return {
      'Device mode': mode,
      'PV power': Math.round(pv),
      'PV power 1': Math.round(pv1),
      'PV power 2': Math.round(pv2),
      'PV voltage 1': pv > 0 ? round(320 + Math.random() * 30, 1) : 0,
      'PV voltage 2': pv > 0 ? round(300 + Math.random() * 30, 1) : 0,
      'PV current 1': pv > 0 ? round(pv1 / 330, 1) : 0,
      'PV current 2': pv > 0 ? round(pv2 / 310, 1) : 0,
      'Battery voltage': round(battV, 2),
      'Battery current': round(battery / battV, 1),
      'Battery power': Math.round(battery),
      'Battery state of charge': Math.round(this.soc),
      'Battery temperature': round(24 + Math.abs(battery) / 1000, 1),
      'Grid power': Math.round(grid),
      'Grid voltage': round(229 + Math.random() * 4, 1),
      'Grid frequency': round(49.95 + Math.random() * 0.1, 2),
      'Load power': Math.round(load),
      'Load apparent power': Math.round(load * 1.07),
      'Load percentage': round((load / 5000) * 100, 1),
      'AC output voltage': 230,
      'AC output frequency': 50,
      'Bus voltage': round(380 + Math.random() * 10, 1),
      Temperature: round(30 + pv / 500 + Math.abs(battery) / 1000, 1),
    };
  }

  private activeHybridPriority(hour: number): string {
    const inSlot = (prefix: string) =>
      [1, 2, 3].some((n) => {
        const [s, e, on] = String(this.values[`${prefix}_slot_${n}`] ?? '').split(',');
        if (on !== 'true') return false;
        const toH = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
        const start = toH(s);
        const end = toH(e);
        return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
      });
    if (inSlot('battery_first')) return 'Battery first';
    if (inSlot('grid_first')) return 'Grid first';
    return String(this.values.work_mode_priority);
  }

  settingDefs() {
    return this.hybrid ? HYBRID_SETTINGS : OFFGRID_SETTINGS;
  }

  async readSettings() {
    return { ...this.values };
  }

  async writeSetting(key: string, value: Value) {
    this.values[key] = value;
  }
}

export const simulator: InverterDriverDescriptor = {
  id: 'simulator',
  name: 'Simulator',
  manufacturer: 'Simulated',
  transport: 'none',
  models: [
    { id: 'offgrid', name: 'Off-grid (SPF style)' },
    { id: 'hybrid', name: 'Hybrid (SPH style)' },
  ],
  socControl: (model) =>
    model === 'hybrid'
      ? { setting: 'work_mode_priority', gridValue: 'Battery first', batteryValue: 'Load first' }
      : { setting: 'output_source_priority', gridValue: 'Utility first', batteryValue: 'Solar/Battery/Utility' },
  protectionSetting: (model) => (model === 'hybrid' ? null : { setting: 'output_source_priority', shutdownValue: 'Utility first' }),
  create: (opts) => new SimulatorDriver(opts.modelId, opts.index),
};
