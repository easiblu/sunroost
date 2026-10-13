/**
 * Spare solar (src/automation/surplus.ts) and the energy outlook (src/energy):
 *   GET /api/surplus     → status: surplus now, the deferrable devices in order and what each is doing
 *   PUT /api/surplus     → { enabled?, order?, batterySoc?, startMarginW?, startMinutes?, stopMinutes?, minOnMinutes? }
 *   GET /api/energy/outlook → expected solar (today, tomorrow, rest of today, next 24 h) and how it is estimated
 */
import type { FastifyReply } from 'fastify';
import * as spareSolar from '../../automation/surplus.ts';
import { settings, type SettingKey } from '../../core/settings.ts';
import { currentSurplus, MIN_LEARNED_DAYS, solarForecast } from '../../energy/index.ts';
import * as home from '../../home/index.ts';
import type { App } from '../server.ts';

const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

const NUMBERS: [string, SettingKey, number, number][] = [
  ['batterySoc', 'surplus.battery_soc', 0, 100],
  ['startMarginW', 'surplus.start_margin_w', 0, 10_000],
  ['startMinutes', 'surplus.start_minutes', 0, 120],
  ['stopMinutes', 'surplus.stop_minutes', 0, 120],
  ['minOnMinutes', 'surplus.min_on_minutes', 0, 1440],
];

export async function register(app: App) {
  app.get('/api/surplus', async () => spareSolar.status());

  app.put<{ Body: Record<string, unknown> }>('/api/surplus', async (req, reply) => {
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if ('enabled' in b) {
      if (typeof b.enabled !== 'boolean') return bad(reply, 'enabled must be true or false');
      updates['surplus.enabled'] = b.enabled;
    }
    if ('order' in b) {
      if (!Array.isArray(b.order) || b.order.length > 100 || !b.order.every((id) => typeof id === 'string' && home.registry.entity(id))) {
        return bad(reply, 'order must be a list of device entity ids');
      }
      updates['surplus.order'] = [...new Set(b.order as string[])];
    }
    for (const [field, key, min, max] of NUMBERS) {
      if (!(field in b)) continue;
      const v = b[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(reply, `${field} must be between ${min} and ${max}`);
      updates[key] = Math.round(v);
    }
    settings.setMany(updates as never);
    return spareSolar.status();
  });

  app.get('/api/energy/outlook', async () => {
    const f = solarForecast();
    return {
      surplusW: currentSurplus(),
      forecast: f,
      arrayKwp: Number(settings.get('site.pv_kwp')) || 0,
      minLearnedDays: MIN_LEARNED_DAYS,
    };
  });
}
