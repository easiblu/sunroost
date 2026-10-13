/**
 * Inverter command console for text-protocol drivers (Voltronic "QPIGS" style). Sends one command
 * through the running driver's `rawCommand`. Queries (commands starting with "Q") run freely; anything
 * else may change a setting and needs `confirm: true`.
 */
import { log } from '../../core/log.ts';
import { settings } from '../../core/settings.ts';
import { devices } from '../../devices/manager.ts';
import { decodeReply, KNOWN_COMMANDS } from '../../devices/inverters/voltronic/index.ts';
import type { App } from '../server.ts';

interface CommandBody {
  index?: number;
  command?: string;
  confirm?: boolean;
}

class BadRequest extends Error {}

/** Printable ASCII, 1–32 characters. */
export function validCommand(raw: unknown): string {
  const command = String(raw ?? '').trim();
  if (!command) throw new BadRequest('Enter a command');
  if (command.length > 32) throw new BadRequest('Command must be at most 32 characters');
  if (!/^[\x20-\x7e]+$/.test(command)) throw new BadRequest('Command must be printable ASCII');
  return command;
}

export const isQuery = (command: string) => /^Q/i.test(command);

export async function register(app: App) {
  app.post<{ Body: CommandBody }>('/api/tools/command', async (req, reply) => {
    const body = req.body ?? {};
    try {
      const command = validCommand(body.command);
      const index = Number(body.index ?? 0);
      if (!Number.isInteger(index) || index < 0 || index > 63) throw new BadRequest('Inverter must be a whole number from 0 to 63');
      if (!isQuery(command) && body.confirm !== true) {
        throw new BadRequest(`'${command}' is not a query and may change a setting. Send confirm: true to run it.`);
      }
      const driver = devices.driver(index);
      if (!devices.started || !driver) throw new BadRequest('Not connected. Start the inverter connection on the Configuration page.');
      if (!driver.rawCommand) throw new BadRequest('This inverter driver has no command console');
      const text = await driver.rawCommand(command);
      if (!isQuery(command)) log.write('devices', 'warn', `Command console sent '${command}' to inverter ${index + 1}: ${text}`);
      const decoded = settings.get('inverter.driver_id') === 'voltronic' ? decodeReply(command, text) : undefined;
      return { reply: text, decoded };
    } catch (err) {
      const message = (err as Error).message || 'Command failed';
      return reply.code(err instanceof BadRequest ? 400 : 502).send({ error: message });
    }
  });

  /** Driver context and the known query list for the console page. */
  app.get('/api/tools/command/context', async () => ({
    started: devices.started,
    driverId: settings.get('inverter.driver_id'),
    inverters: devices.inverterCount,
    hasConsole: Boolean(devices.driver(0)?.rawCommand),
    commands: KNOWN_COMMANDS,
  }));
}
