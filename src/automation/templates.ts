/**
 * Ready-made rules. Settings and values come from the driver's SOC-control descriptor
 * (`socControl`: the setting that switches between charging from the grid and running from the
 * battery), so each template fits the connected inverter. Every template is validated against
 * the current driver; one that can't work is returned with `available: false` and the reason.
 */
import { settings } from '../core/settings.ts';
import { FORECAST_METRICS } from '../energy/index.ts';
import * as home from '../home/index.ts';
import type { SettingDef, SocControl } from '../devices/types.ts';
import { normalizeRule, OUTAGE_METRIC, type RuleConfig, type RuleContext } from './rules.ts';
import { findDef } from './types.ts';

export type Requirement = 'price' | 'forecast' | 'sun' | 'grid' | 'battery' | 'devices';

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  requires: Requirement[];
  rule: { type: 'rule'; name: string; enabled: boolean; config: RuleConfig };
  available: boolean;
  reason: string | null;
}

export interface TemplateContext extends RuleContext {
  socControl: SocControl | null;
}

const SOC = 'Battery state of charge';

/** A select setting offering "Solar first" and a solar/battery/utility (SBU) option, e.g. output source priority. */
function outputPriority(ctx: TemplateContext): { setting: string; solarFirst: string; sbu: string } | null {
  for (const d of ctx.defs) {
    if (d.type !== 'select' || d.readOnly || !d.options) continue;
    const solar = d.options.find((o) => /^solar first$/i.test(o));
    const sbu = d.options.find((o) => /solar\s*\/\s*battery\s*\/\s*utility|^sbu/i.test(o));
    if (solar && sbu) return { setting: d.key, solarFirst: solar, sbu };
  }
  if (!ctx.defs.length && ctx.socControl?.setting === 'output_source_priority') {
    return { setting: 'output_source_priority', solarFirst: 'Solar first', sbu: 'Solar/Battery/Utility' };
  }
  return null;
}

/** A number setting that caps grid charging at a SOC, when the driver has one. */
function chargeTarget(defs: SettingDef[]): SettingDef | undefined {
  return defs.find((d) => d.type === 'number' && !d.readOnly && d.unit === '%' && /stop.?charge|charge.?(target|limit)|max.?soc/i.test(d.key));
}

const base = (o: Partial<RuleConfig> & Pick<RuleConfig, 'triggers' | 'actions'>): RuleConfig => ({
  description: '',
  priority: 50,
  conditions: { op: 'and', items: [] },
  elseActions: [],
  options: { cooldownMinutes: 5, maxRunsPerDay: 0, revertAfterMinutes: 0 },
  ...o,
});

interface Draft {
  id: string;
  name: string;
  description: string;
  icon: string;
  requires: Requirement[];
  /** null + reason when the inverter can't do it. */
  build(): RuleConfig | string;
}

function drafts(ctx: TemplateContext): Draft[] {
  const sc = ctx.socControl;
  const noSoc = `${ctx.modelName || 'This inverter'} has no setting to switch between grid charging and battery use.`;
  const set = (value: string, setting = sc!.setting) => ({ kind: 'set_setting' as const, inverter: 'all' as const, setting, value });
  const target = chargeTarget(ctx.defs);
  return [
    {
      id: 'cheapest-hours-charge',
      name: 'Charge in the cheapest hours',
      description: 'Charges the battery from the grid during the 3 cheapest hours of each day, then switches back.',
      icon: 'piggy-bank',
      requires: ['price', 'battery'],
      build: () =>
        sc
          ? base({
              description: 'Grid-charges the battery during the 3 cheapest hours of the day.',
              priority: 60,
              triggers: [{ kind: 'price', mode: 'cheapest', hours: 3 }],
              conditions: { op: 'and', items: [{ kind: 'metric', metric: SOC, op: 'below', value: 95 }] },
              actions: [set(sc.gridValue)],
              options: { cooldownMinutes: 0, maxRunsPerDay: 0, revertAfterMinutes: 60 },
            })
          : noSoc,
    },
    {
      id: 'expensive-hours-battery',
      name: 'Battery first in expensive hours',
      description: 'Avoids grid import during the 3 most expensive hours of the day by running from the battery.',
      icon: 'trending-up',
      requires: ['price', 'battery'],
      build: () =>
        sc
          ? base({
              description: 'Runs from the battery during the 3 most expensive hours.',
              priority: 70,
              triggers: [{ kind: 'price', mode: 'most_expensive', hours: 3 }],
              conditions: { op: 'and', items: [{ kind: 'metric', metric: SOC, op: 'above', value: 30 }] },
              actions: [set(sc.batteryValue)],
              options: { cooldownMinutes: 0, maxRunsPerDay: 0, revertAfterMinutes: 60 },
            })
          : noSoc,
    },
    {
      id: 'outage-reserve',
      name: 'Keep a reserve before load-shedding',
      description: 'When a planned outage (Eskom) starts within 3 hours, charges the battery from the grid until the outage.',
      icon: 'shield-alert',
      requires: ['grid', 'battery'],
      build: () =>
        sc
          ? base({
              description: 'Needs the Eskom load-shedding grid provider with an area selected.',
              priority: 80,
              triggers: [{ kind: 'metric', metric: OUTAGE_METRIC, op: 'below', value: 180, forMinutes: 0 }],
              conditions: { op: 'and', items: [{ kind: 'metric', metric: SOC, op: 'below', value: 95 }] },
              actions: [
                set(sc.gridValue),
                { kind: 'notify', channel: 'app', title: 'Planned outage soon', message: 'Charging the battery before the outage (now {soc}).' },
              ],
              options: { cooldownMinutes: 30, maxRunsPerDay: 0, revertAfterMinutes: 180 },
            })
          : noSoc,
    },
    {
      id: 'cloudy-tomorrow-charge',
      name: 'Cloudy tomorrow: charge overnight',
      description: `When tomorrow's solar forecast is poor, charges from the grid overnight${target ? ' up to 80%' : ''} and switches back in the morning.`,
      icon: 'cloud-sun',
      requires: ['forecast', 'battery'],
      build: () =>
        sc
          ? base({
              description: 'Checked at 22:00; reverts after 8 hours.',
              priority: 55,
              triggers: [{ kind: 'forecast', at: '22:00', metric: 'tomorrow_sun', op: 'below', value: 8 }],
              conditions: { op: 'and', items: [{ kind: 'metric', metric: SOC, op: 'below', value: 80 }] },
              actions: [
                set(sc.gridValue),
                ...(target ? [{ kind: 'set_setting' as const, inverter: 'all' as const, setting: target.key, value: 80 }] : []),
              ],
              options: { cooldownMinutes: 5, maxRunsPerDay: 1, revertAfterMinutes: 480 },
            })
          : noSoc,
    },
    {
      id: 'battery-full-self-use',
      name: 'Battery full: self-use',
      description: 'Once the battery has been full for 5 minutes, switches to battery/self-use so surplus solar is used or exported.',
      icon: 'battery-full',
      requires: ['battery'],
      build: () =>
        sc
          ? base({
              triggers: [{ kind: 'metric', metric: SOC, op: 'above', value: 98, forMinutes: 5 }],
              actions: [set(sc.batteryValue)],
              options: { cooldownMinutes: 30, maxRunsPerDay: 0, revertAfterMinutes: 0 },
            })
          : noSoc,
    },
    {
      id: 'low-battery-night-utility',
      name: 'Low battery at night: use the grid',
      description: 'If the battery drops below 20% at night, switches the load to the grid to protect the battery.',
      icon: 'moon',
      requires: ['battery', 'grid'],
      build: () =>
        sc
          ? base({
              priority: 75,
              triggers: [{ kind: 'metric', metric: SOC, op: 'below', value: 20, forMinutes: 2 }],
              conditions: {
                op: 'and',
                items: [{ kind: 'time_between', from: '18:00', to: '06:00' }, { kind: 'grid', available: true }],
              },
              actions: [set(sc.gridValue)],
              options: { cooldownMinutes: 30, maxRunsPerDay: 0, revertAfterMinutes: 0 },
            })
          : noSoc,
    },
    {
      id: 'grid-lost-notify',
      name: 'Grid lost: notify me',
      description: 'Sends a notification when the grid goes down and when it comes back.',
      icon: 'unplug',
      requires: ['grid'],
      build: () =>
        base({
          triggers: [{ kind: 'grid', event: 'lost' }],
          actions: [{ kind: 'notify', channel: 'app', title: 'Grid lost', message: 'Grid power was lost at {time}. Battery at {soc}, load {load}.' }],
          options: { cooldownMinutes: 1, maxRunsPerDay: 0, revertAfterMinutes: 0 },
        }),
    },
    {
      id: 'inverter-hot-notify',
      name: 'Inverter hot: notify me',
      description: 'Notifies you when the inverter temperature stays above 70 °C for 5 minutes.',
      icon: 'thermometer',
      requires: [],
      build: () =>
        base({
          triggers: [{ kind: 'metric', metric: 'Temperature', op: 'above', value: 70, forMinutes: 5 }],
          actions: [{ kind: 'notify', channel: 'app', title: 'Inverter running hot', message: 'Inverter temperature above 70 °C at {time} (load {load}).' }],
          options: { cooldownMinutes: 60, maxRunsPerDay: 0, revertAfterMinutes: 0 },
        }),
    },
    {
      id: 'sunrise-solar-first',
      name: 'Sunrise: solar first',
      description: 'Switches the output source to solar first 30 minutes after sunrise.',
      icon: 'sunrise',
      requires: ['sun'],
      build: () => {
        const op = outputPriority(ctx);
        if (!op) return `${ctx.modelName || 'This inverter'} has no output source priority with "Solar first".`;
        return base({
          triggers: [{ kind: 'sun', event: 'sunrise', offsetMinutes: 30 }],
          actions: [set(op.solarFirst, op.setting)],
        });
      },
    },
    {
      id: 'battery-low-shed',
      name: 'Low battery: switch off sheddable devices',
      description: 'When the battery drops below 25% for 2 minutes, switches off every device with the Sheddable role and tells you.',
      icon: 'battery-warning',
      requires: ['battery', 'devices'],
      build: () => base({
        priority: 80,
        triggers: [{ kind: 'metric', metric: SOC, op: 'below', value: 25, forMinutes: 2 }],
        actions: [
          { kind: 'device', target: 'role:sheddable', service: 'turn_off', data: {} },
          { kind: 'notify', channel: 'app', title: 'Battery low', message: 'Battery at {soc}: switched off sheddable devices.' },
        ],
        options: { cooldownMinutes: 30, maxRunsPerDay: 0, revertAfterMinutes: 0 },
      }),
    },
    {
      id: 'grid-lost-shed',
      name: 'Grid lost: keep only the essentials',
      description: 'When the grid goes down, switches off sheddable and deferrable devices so the battery lasts longer.',
      icon: 'unplug',
      requires: ['grid', 'devices'],
      build: () => base({
        priority: 90,
        triggers: [{ kind: 'grid', event: 'lost' }],
        actions: [
          { kind: 'device', target: 'role:sheddable', service: 'turn_off', data: {} },
          { kind: 'device', target: 'role:deferrable', service: 'turn_off', data: {} },
          { kind: 'notify', channel: 'app', title: 'Grid lost', message: 'Running on battery ({soc}); switched off non-essential devices.' },
        ],
        options: { cooldownMinutes: 10, maxRunsPerDay: 0, revertAfterMinutes: 0 },
      }),
    },
    {
      id: 'expensive-hours-pause',
      name: 'Expensive hours: pause flexible devices',
      description: 'At the start of each of the 3 most expensive hours, switches off devices with the Deferrable role.',
      icon: 'trending-up',
      requires: ['price', 'devices'],
      build: () => base({
        triggers: [{ kind: 'price', mode: 'most_expensive', hours: 3 }],
        actions: [{ kind: 'device', target: 'role:deferrable', service: 'turn_off', data: {} }],
        options: { cooldownMinutes: 0, maxRunsPerDay: 0, revertAfterMinutes: 0 },
      }),
    },
    {
      id: 'poor-solar-tomorrow',
      name: 'Poor solar tomorrow: let me know',
      description: 'At 20:00, if less than 5 kWh of solar is expected tomorrow, sends a notification so you can plan.',
      icon: 'cloud-rain',
      requires: ['forecast'],
      build: () => base({
        triggers: [{ kind: 'time', at: '20:00' }],
        conditions: { op: 'and', items: [{ kind: 'metric', metric: FORECAST_METRICS.tomorrow, op: 'below', value: 5 }] },
        actions: [{ kind: 'notify', channel: 'app', title: 'Little sun tomorrow', message: 'Less than 5 kWh of solar is expected tomorrow. Battery now {soc}.' }],
      }),
    },
    {
      id: 'sunset-sbu',
      name: 'Sunset: solar/battery/utility',
      description: 'Switches the output source to solar/battery/utility (SBU) at sunset so the battery carries the evening load.',
      icon: 'sunset',
      requires: ['sun', 'battery'],
      build: () => {
        const op = outputPriority(ctx);
        if (!op) return `${ctx.modelName || 'This inverter'} has no output source priority with a solar/battery/utility option.`;
        return base({
          triggers: [{ kind: 'sun', event: 'sunset', offsetMinutes: 0 }],
          actions: [set(op.sbu, op.setting)],
        });
      },
    },
  ];
}

/** All templates for the current driver, each validated as a rule. */
export function templates(ctx: TemplateContext): Template[] {
  return drafts(ctx).map((d) => {
    const built = d.build();
    let config: RuleConfig | null = typeof built === 'string' ? null : built;
    let reason = typeof built === 'string' ? built : null;
    if (config) {
      try {
        config = normalizeRule(config, ctx);
      } catch (err) {
        reason = (err as Error).message;
      }
    }
    // Data sources the template depends on must be configured, or it can never fire usefully.
    if (reason === null && d.requires.includes('price') && settings.get('grid.driver_id') !== 'energy_charts') {
      reason = 'Needs day-ahead prices: choose a price provider under Configuration › Advanced › Grid.';
    }
    if (reason === null && d.requires.includes('forecast') && (settings.get('site.latitude') === null || settings.get('site.longitude') === null)) {
      reason = 'Needs a weather forecast: set your location under Configuration › General.';
    }
    // Device templates act on energy roles: at least one of its roles must have a device.
    if (config && reason === null) {
      const roles = [...config.actions, ...config.elseActions]
        .filter((a) => a.kind === 'device' && a.target.startsWith('role:'))
        .map((a) => (a as { target: string }).target.slice(5));
      if (roles.length && !roles.some((r) => home.registry.allEntities().some((e) => e.role === r))) {
        const names = [...new Set(roles)].map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join(' or ');
        reason = `Give at least one device the ${names} role first (Smart devices page).`;
      }
    }
    if (config && reason === null && ctx.defs.length) {
      const missing = config.actions.find((a) => a.kind === 'set_setting' && !findDef(ctx.defs, a.setting));
      if (missing) reason = `Setting not supported by ${ctx.modelName || 'this inverter'}.`;
    }
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      icon: d.icon,
      requires: d.requires,
      rule: { type: 'rule' as const, name: d.name, enabled: true, config: config ?? base({ triggers: [{ kind: 'manual' }], actions: [] }) },
      available: reason === null,
      reason,
    };
  });
}

export const templateById = (ctx: TemplateContext, id: string) => templates(ctx).find((t) => t.id === id) ?? null;
