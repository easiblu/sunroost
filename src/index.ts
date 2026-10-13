import { join } from 'node:path';
import * as alerts from './alerts/index.ts';
import * as automation from './automation/index.ts';
import { loadBootConfig } from './config.ts';
import { closeDb, openDb } from './core/db.ts';
import { log, logger } from './core/log.ts';
import * as secrets from './core/secrets.ts';
import { settings } from './core/settings.ts';
import * as diagnostics from './diagnostics/index.ts';
import { devices } from './devices/manager.ts';
import * as grid from './grid/index.ts';
import * as home from './home/index.ts';
import * as mqtt from './mqtt/index.ts';
import * as remote from './remote/index.ts';
import * as stats from './stats/index.ts';
import * as system from './system/index.ts';
import { startServer } from './web/server.ts';
import * as weather from './weather/index.ts';

const config = loadBootConfig();
const l = logger('system');

openDb(join(config.dataDir, 'solar.db'));
settings.init();
settings.seed(config.initialSettings);
secrets.init(config.dataDir);
log.setFile(join(config.dataDir, 'user.log'));

// Order matters: stats must be listening before devices produce readings.
// home after mqtt: its MQTT device driver connects to the broker mqtt starts.
const services = [stats, system, grid, weather, alerts, automation, mqtt, home];
for (const s of services) await s.start();

const server = await startServer(config.http.host, config.http.port);
l.info(`Web UI on http://localhost:${config.http.port}`);
await remote.start(config.http.port, config.dataDir);

if (settings.get('auto_start_devices')) await devices.start();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  l.info('Shutting down.');
  await diagnostics.stopAll().catch(() => {});
  await devices.stop();
  await remote.stop();
  for (const s of [...services].reverse()) await s.stop().catch(() => {});
  await server.close();
  closeDb();
  process.exit(0);
}
// A long-running appliance: one failed async callback (a device answering after it was removed …)
// is logged, not allowed to stop the whole app.
process.on('unhandledRejection', (err) => l.error(`Unhandled error: ${(err as Error)?.stack ?? err}`));

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
