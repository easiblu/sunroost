/**
 * System API: device information, kernel log + USB list, reboot / shutdown / restart-app,
 * and OS access settings (time, HDMI kiosk, Bluetooth, SSH, USB power).
 */
import { accessInfo, cycleUsbPower, setBluetooth, setHdmi, setSsh, setTime, type ActionResult, type BluetoothMode } from '../../system/access.ts';
import { ACTION_SECONDS, kernelLog, perform, systemInfo, type PowerAction } from '../../system/index.ts';
import type { SshMode } from '../../system/info.ts';
import type { App } from '../server.ts';

export async function register(app: App) {
  app.get('/api/system', async () => systemInfo());

  app.get<{ Querystring: { limit?: string } }>('/api/system/kernel-log', async (req) =>
    kernelLog(Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000)),
  );

  for (const action of ['reboot', 'shutdown', 'restart-app'] as PowerAction[]) {
    app.post<{ Body: { confirm?: boolean } }>(`/api/system/${action}`, async (req, reply) => {
      if (req.body?.confirm !== true) return reply.code(400).send({ error: 'Confirmation required ({"confirm": true})' });
      const res = await perform(action);
      if (!res.ok) return reply.code(res.status).send({ error: res.message });
      return { ok: true, message: res.message, seconds: ACTION_SECONDS[action] };
    });
  }

  app.get('/api/system/access', async () => accessInfo());

  /** Failures carry `command` when the user can fix it by running a command with sudo. */
  const send = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, r: ActionResult) =>
    r.ok ? r : reply.code(r.command ? 403 : 500).send({ error: r.message, command: r.command });

  app.post<{ Body: { internetTime?: boolean; manual?: string; timezone?: string } }>('/api/system/time', async (req, reply) => {
    const { internetTime, manual, timezone } = req.body ?? {};
    if (internetTime !== undefined && typeof internetTime !== 'boolean') return reply.code(400).send({ error: 'Invalid internetTime' });
    if (timezone !== undefined && !/^[A-Za-z0-9_+\-/]+$/.test(String(timezone))) return reply.code(400).send({ error: 'Invalid time zone' });
    return send(reply, await setTime({ internetTime, manual, timezone }));
  });

  app.post<{ Body: { mode?: string } }>('/api/system/hdmi', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== 'kiosk' && mode !== 'console') return reply.code(400).send({ error: 'mode must be kiosk or console' });
    return send(reply, await setHdmi(mode));
  });

  app.post<{ Body: { mode?: string } }>('/api/system/bluetooth', async (req, reply) => {
    const mode = req.body?.mode as BluetoothMode;
    if (!['auto-pair', 'no-pair', 'disabled'].includes(mode)) return reply.code(400).send({ error: 'Invalid mode' });
    return send(reply, await setBluetooth(mode));
  });

  app.post<{ Body: { mode?: string } }>('/api/system/ssh', async (req, reply) => {
    const mode = req.body?.mode as SshMode;
    if (!['key,password', 'key', 'disabled'].includes(mode)) return reply.code(400).send({ error: 'Invalid mode' });
    return send(reply, await setSsh(mode));
  });

  app.post<{ Body: { confirm?: boolean } }>('/api/system/usb-cycle', async (req, reply) => {
    if (req.body?.confirm !== true) return reply.code(400).send({ error: 'Confirmation required ({"confirm": true})' });
    return send(reply, await cycleUsbPower());
  });
}
