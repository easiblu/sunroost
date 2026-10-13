/**
 * Network API and captive-portal probes.
 *  GET  /api/network               status, interfaces, SSID/signal, hotspot, internet
 *  GET  /api/network/wifi/scan     visible networks, strongest first
 *  POST /api/network/wifi          { ssid, password, country } → save + connect in the background
 *  POST /api/network/hotspot       { enabled } start/stop the hotspot manually
 *  POST /api/network/config        { hotspotAuto?, hotspotPassword? }
 * The hotspot fallback loop starts here (this module is auto-loaded) and stops with the server.
 * Phones joining the hotspot request a connectivity probe; redirecting those to / makes them open
 * the UI as a captive portal.
 */
import * as network from '../../network/index.ts';
import type { App } from '../server.ts';

export async function register(app: App) {
  for (const path of ['/generate_204', '/gen_204', '/hotspot-detect.html', '/library/test/success.html', '/ncsi.txt', '/connecttest.txt']) {
    app.get(path, async (_req, reply) => reply.redirect('/', 302));
  }

  app.get('/api/network', async () => network.status());

  app.get('/api/network/wifi/scan', async () => network.scan());

  app.post<{ Body: { ssid?: string; password?: string; country?: string } }>('/api/network/wifi', async (req, reply) => {
    const ssid = String(req.body?.ssid ?? '').trim();
    const password = String(req.body?.password ?? '');
    const country = String(req.body?.country ?? network.getConfig().country).toUpperCase();
    if (!(await network.supported())) return reply.code(501).send({ error: network.unsupportedReason() });
    const invalid = await network.validateWifi(ssid, password, country);
    if (invalid) return reply.code(400).send({ error: invalid });
    const res = await network.connectWifi(ssid, password, country);
    if (!res.ok) return reply.code(500).send({ error: res.message });
    return res;
  });

  app.post<{ Body: { enabled?: boolean } }>('/api/network/hotspot', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'Expected { "enabled": true|false }' });
    if (!(await network.supported())) return reply.code(501).send({ error: network.unsupportedReason() });
    const res = req.body.enabled ? await network.startHotspot(true) : await network.stopHotspot('stopped from the web UI');
    if (!res.ok) return reply.code(500).send({ error: res.message });
    return res;
  });

  app.post<{ Body: { hotspotAuto?: boolean; hotspotPassword?: string } }>('/api/network/config', async (req, reply) => {
    const { hotspotAuto, hotspotPassword } = req.body ?? {};
    if (hotspotAuto !== undefined && typeof hotspotAuto !== 'boolean') return reply.code(400).send({ error: 'Invalid hotspotAuto' });
    if (hotspotPassword !== undefined && (typeof hotspotPassword !== 'string' || (hotspotPassword !== '' && (hotspotPassword.length < 8 || hotspotPassword.length > 63)))) {
      return reply.code(400).send({ error: 'Hotspot password must be 8 to 63 characters, or empty for an open hotspot.' });
    }
    network.setConfig({ hotspotAuto, hotspotPassword });
    const { hotspotPassword: _secret, ...cfg } = network.getConfig();
    return { ...cfg, hotspotOpen: !_secret };
  });

  await network.start();
  app.addHook('onClose', async () => network.stop());
}
