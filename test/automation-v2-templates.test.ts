import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRule, summarize, type RuleContext } from '../src/automation/rules.ts';
import { templates, type TemplateContext } from '../src/automation/templates.ts';
import { simulator } from '../src/devices/inverters/simulator.ts';
import type { SettingDef } from '../src/devices/types.ts';

function ctxFor(model: 'offgrid' | 'hybrid'): TemplateContext {
  const drv = simulator.create({ modelId: model, connection: '', baudRate: 9600, address: 1, index: 0, verifyCrc: true });
  return {
    connected: true,
    modelName: model,
    inverterCount: 1,
    defs: drv.settingDefs() as SettingDef[],
    sceneExists: () => false,
    automationExists: () => false,
    socControl: simulator.socControl!(model),
  };
}

describe('rule templates', () => {
  it('offers at least 8 templates, each a complete valid rule', () => {
    for (const model of ['offgrid', 'hybrid'] as const) {
      const ctx = ctxFor(model);
      const list = templates(ctx);
      assert.ok(list.length >= 8);
      assert.equal(new Set(list.map((t) => t.id)).size, list.length);
      for (const t of list) {
        assert.ok(t.name && t.description && t.icon && Array.isArray(t.requires), t.id);
        if (!t.available) continue;
        // Round-trips through validation unchanged and reads as a sentence.
        assert.deepEqual(normalizeRule(t.rule.config, ctx as RuleContext), t.rule.config, t.id);
        assert.match(summarize(t.rule.config, ctx.defs), /\.$/);
      }
    }
  });

  it('maps settings through the driver socControl', () => {
    const off = templates(ctxFor('offgrid'));
    const hyb = templates(ctxFor('hybrid'));
    const action = (list: ReturnType<typeof templates>, id: string) => list.find((t) => t.id === id)!.rule.config.actions[0];
    assert.deepEqual(action(off, 'cheapest-hours-charge'), { kind: 'set_setting', inverter: 'all', setting: 'output_source_priority', value: 'Utility first' });
    assert.deepEqual(action(hyb, 'cheapest-hours-charge'), { kind: 'set_setting', inverter: 'all', setting: 'work_mode_priority', value: 'Battery first' });
    assert.equal(off.find((t) => t.id === 'sunset-sbu')!.available, true);
    assert.equal(action(off, 'sunrise-solar-first').kind === 'set_setting' && (action(off, 'sunrise-solar-first') as { value: unknown }).value, 'Solar first');
    // The hybrid has no output source priority: the sun templates are unavailable with a reason.
    const sun = hyb.find((t) => t.id === 'sunrise-solar-first')!;
    assert.equal(sun.available, false);
    assert.match(sun.reason!, /no output source priority/);
    // Hybrid gets a charge target on the cloudy-tomorrow template.
    const cloudy = hyb.find((t) => t.id === 'cloudy-tomorrow-charge')!.rule.config.actions;
    assert.deepEqual(cloudy[1], { kind: 'set_setting', inverter: 'all', setting: 'battery_first_stop_charge', value: 80 });
  });

  it('fails clearly when the driver lacks the setting', () => {
    const ctx = { ...ctxFor('offgrid'), socControl: { setting: 'not_a_setting', gridValue: 'a', batteryValue: 'b' } };
    const t = templates(ctx).find((x) => x.id === 'cheapest-hours-charge')!;
    assert.equal(t.available, false);
    assert.match(t.reason!, /"not_a_setting" is not a setting of offgrid/);
    const none = templates({ ...ctxFor('offgrid'), socControl: null }).find((x) => x.id === 'battery-full-self-use')!;
    assert.equal(none.available, false);
    // Notification templates work everywhere.
    assert.equal(templates({ ...ctxFor('offgrid'), socControl: null }).find((x) => x.id === 'grid-lost-notify')!.available, true);
  });
});
