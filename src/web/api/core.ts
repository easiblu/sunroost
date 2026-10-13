/**
 * Core API: auth, live state, app settings, devices (drivers, ports, start/stop),
 * inverter settings and logs.
 */
import { existsSync, readdirSync } from 'node:fs';
import { SerialPort } from 'serialport';
import { log } from '../../core/log.ts';
import { DEFAULTS, settings, type SettingKey } from '../../core/settings.ts';
import { state } from '../../core/state.ts';
import { catalogue, coverage } from '../../devices/catalogue.ts';
import { detect } from '../../devices/detect.ts';
import { devices } from '../../devices/manager.ts';
import { acquireServer, EYBOND_PORT, redirectDongle, releaseServer, sharedServer } from '../../devices/eybond.ts';
import { discoverLoggers } from '../../devices/solarman.ts';
import { BMS_DRIVERS, INVERTER_DRIVERS, inverterDriver } from '../../devices/registry.ts';
import {
  checkPassword, clearCookie, hashPassword, isAuthenticated, loginLockout, passwordRequired, recordLoginFailure,
  recordLockedAttempt, recordLoginSuccess, sessionCookie,
} from '../auth.ts';
import type { App } from '../server.ts';

/** Keys the generic PATCH may not touch (they have dedicated endpoints). */
/** Settings limited to a fixed set of values. */
const CHOICES: Record<string, readonly string[]> = {
  'home.engine': ['auto', 'lite', 'full'],
};

const PROTECTED = new Set<string>([
  'surplus.managed',
  'auth.password_hash', 'auth.secret', 'mqtt_password',
  'remote.mode', 'remote.domain', 'remote.cloudflare_token', 'remote.cloudflared_path', 'remote.ddns_token',
  'remote.https_port', 'remote.upnp', 'remote.acme_email', 'remote.ddns_provider',
]);

export async function register(app: App) {
  app.get('/api/auth/status', async (req) => ({
    passwordRequired: passwordRequired(),
    authenticated: isAuthenticated(req),
    siteName: settings.get('site.name'),
  }));

  app.post<{ Body: { password: string } }>('/api/auth/login', async (req, reply) => {
    const wait = loginLockout(req.ip);
    if (wait > 0) {
      recordLockedAttempt(req.ip);
      return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` });
    }
    if (!checkPassword(String(req.body?.password ?? ''))) {
      recordLoginFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    recordLoginSuccess(req.ip);
    reply.header('set-cookie', sessionCookie(req));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearCookie);
    return { ok: true };
  });

  app.post<{ Body: { password: string | null } }>('/api/password', async (req, reply) => {
    const pw = req.body?.password;
    const remote = settings.get('remote.mode') !== 'off';
    if (!pw && remote) return reply.code(409).send({ error: 'Turn off remote access before clearing the password.' });
    const min = remote ? 10 : 4;
    if (pw && pw.length < min) {
      return reply.code(400).send({ error: `Password must be at least ${min} characters${remote ? ' while remote access is on' : ''}` });
    }
    settings.set('auth.password_hash', pw ? hashPassword(pw) : '');
    log.write('system', 'info', pw ? 'Local password updated.' : 'Local password cleared.');
    if (pw) reply.header('set-cookie', sessionCookie(req));
    return { ok: true, passwordSet: Boolean(pw) };
  });

  app.get('/api/state', async () => state.snapshot());

  app.get('/api/settings', async () => settings.publicView());

  app.patch<{ Body: Record<string, unknown> }>('/api/settings', async (req, reply) => {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.body ?? {})) {
      if (!settings.isKey(key) || PROTECTED.has(key)) return reply.code(400).send({ error: `Unknown setting: ${key}` });
      const def = DEFAULTS[key as SettingKey];
      const ok =
        def === null ? value === null || (typeof value === 'number' && Number.isFinite(value))
        : Array.isArray(def) ? Array.isArray(value)
        : typeof value === typeof def;
      if (!ok || (CHOICES[key] && !CHOICES[key].includes(value as string))) return reply.code(400).send({ error: `Invalid value for ${key}` });
      updates[key] = value;
    }
    settings.setMany(updates as never);
    return settings.publicView();
  });

  app.get('/api/devices/drivers', async () => ({
    inverters: INVERTER_DRIVERS.map(({ id, name, manufacturer, models, transport, defaultBaudRate, defaultAddress, consoleFunctions, readOnly, readOnlyModels }) => ({
      id, name, manufacturer, models: models ?? [], transport, defaultBaudRate, defaultAddress: defaultAddress ?? 1, consoleFunctions: consoleFunctions ?? [],
      readOnly: Boolean(readOnly), readOnlyModels: readOnlyModels ?? [],
    })),
    batteries: [
      { id: 'inverter', name: 'Use inverter values', transport: 'none' },
      ...BMS_DRIVERS.map(({ id, name, transport, defaultBaudRate, models, multiConnection }) => ({
        id, name, transport, defaultBaudRate, models: models ?? [], multiConnection: Boolean(multiConnection),
      })),
    ],
  }));

  app.get('/api/devices/ports', async () => {
    try {
      const ports = (await SerialPort.list()).map((p) => ({
        path: p.path,
        label: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(' · '),
      }));
      // Voltronic/Axpert inverters often appear as a USB HID device rather than a serial port.
      const hid = existsSync('/dev') ? readdirSync('/dev').filter((f) => f.startsWith('hidraw')) : [];
      return [...ports, ...hid.map((f) => ({ path: `/dev/${f}`, label: `/dev/${f} · USB HID` }))];
    } catch (err) {
      return [{ path: '', label: `Unable to list serial ports: ${(err as Error).message}` }];
    }
  });

  /** Every known inverter brand/series → driver, model and support level. */
  app.get('/api/devices/catalogue', async () => ({ entries: catalogue(), coverage: coverage() }));

  /** Solarman WiFi loggers on the local network (UDP broadcast, ~2 s). */
  app.get('/api/devices/solarman', async () => ({ loggers: await discoverLoggers() }));

  /** Eybond/SmartESS dongles connected to our listener. */
  app.get('/api/devices/eybond', async () => {
    const server = sharedServer(EYBOND_PORT);
    return { port: EYBOND_PORT, listening: Boolean(server), dongles: server?.dongles() ?? [] };
  });

  /**
   * Points one Eybond dongle at this board (UDP "set>server", temporary: it reverts on the dongle's
   * next reboot). Only ever on a user's click. Keeps the listener up for 10 minutes so the dongle can
   * dial in and be added; a saved connection holds its own reference.
   */
  app.post<{ Body: { ip?: string } }>('/api/devices/eybond/redirect', async (req, reply) => {
    const ip = String(req.body?.ip ?? '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return reply.code(400).send({ error: "Enter the dongle's IP address" });
    const server = await acquireServer(EYBOND_PORT);
    setTimeout(() => void releaseServer(server), 10 * 60_000).unref();
    try {
      return await redirectDongle(ip, undefined, EYBOND_PORT);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Probes one connection (read-only queries) and says which driver answered. */
  app.post<{ Body: { connection?: string } }>('/api/devices/detect', async (req, reply) => {
    if (devices.started) return reply.code(409).send({ error: 'Disconnect the inverter before auto-detecting.' });
    try {
      return { results: await detect(String(req.body?.connection ?? '')) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/devices/status', async () => ({
    started: devices.started,
    status: state.status,
    inverterCount: devices.inverterCount,
    driver: inverterDriver(settings.get('inverter.driver_id'))?.name ?? null,
  }));

  app.post('/api/devices/start', async () => {
    await devices.start();
    return { started: devices.started };
  });

  app.post('/api/devices/stop', async () => {
    await devices.stop();
    return { started: devices.started };
  });

  app.post('/api/devices/restart', async () => {
    await devices.restart();
    return { started: devices.started };
  });

  app.get('/api/inverter/settings', async () => {
    const desc = inverterDriver(settings.get('inverter.driver_id'));
    return {
      connected: devices.started && state.status.inverter.name === 'connected',
      driver: desc?.name ?? null,
      model: desc?.models?.find((m) => m.id === settings.get('inverter.model_id'))?.name ?? null,
      inverters: devices.allSettings(),
    };
  });

  app.post<{ Body: { index?: number; values: Record<string, string | number | boolean> } }>(
    '/api/inverter/settings',
    async (req) => {
      const index = req.body.index ?? 0;
      const results: Record<string, { ok: boolean; message: string }> = {};
      for (const [key, value] of Object.entries(req.body.values ?? {})) {
        results[key] = await devices.setSetting(index, key, value, 'ui');
      }
      return { results, values: devices.settingValues(index) };
    },
  );

  app.post<{ Body: { index?: number } }>('/api/inverter/settings/refresh', async (req) => {
    await devices.readSettings(req.body?.index ?? 0);
    return { values: devices.settingValues(req.body?.index ?? 0) };
  });

  app.get<{ Querystring: { tag?: string; limit?: string } }>('/api/logs', async (req) =>
    log.recent({ tag: req.query.tag || undefined, limit: Math.min(Number(req.query.limit) || 200, 2000) }),
  );
}
