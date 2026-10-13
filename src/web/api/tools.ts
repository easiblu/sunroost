/**
 * Diagnostics tools: the Modbus console. Reads registers through the running inverter driver or
 * through a temporary direct RTU/TCP connection, and writes raw registers (explicit confirm only).
 */
import { log } from '../../core/log.ts';
import { settings } from '../../core/settings.ts';
import { devices } from '../../devices/manager.ts';
import { decodeRange, growattFamily } from '../../devices/inverters/growatt/index.ts';
import { inverterDriver } from '../../devices/registry.ts';
import { isSerialPathOpen, MAX_READ, MAX_WRITE, withConnection, type ModbusTarget } from '../../devices/modbus.ts';
import type { App } from '../server.ts';

interface ReadBody {
  source?: 'device' | 'direct';
  index?: number;
  fn?: number;
  start?: number;
  count?: number;
  /** direct only */
  type?: 'rtu' | 'tcp';
  path?: string;
  host?: string;
  port?: number;
  baudRate?: number;
  address?: number;
  /** Growatt family used for decoding; defaults to the configured model when the driver is Growatt. */
  model?: string;
}

interface WriteBody {
  index?: number;
  start?: number;
  values?: number[];
  confirm?: boolean;
}

class BadRequest extends Error {}

function int(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** Serial paths the device manager has (or will have) open. */
function managedPaths(): string[] {
  if (!devices.started) return [];
  return [...settings.get('inverter.connection_ids'), ...settings.get('bms.connection_ids')].filter(Boolean);
}

function directTarget(body: ReadBody): ModbusTarget {
  const address = int(body.address ?? 1, 'Address', 0, 247);
  if (body.type === 'tcp') {
    const host = String(body.host ?? '').trim();
    if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new BadRequest('Enter an IP address or host name');
    return { type: 'tcp', host, port: int(body.port ?? 502, 'Port', 1, 65535), address, timeoutMs: 3000 };
  }
  if (body.type !== 'rtu') throw new BadRequest("type must be 'rtu' or 'tcp'");
  const path = String(body.path ?? '').trim();
  if (!path) throw new BadRequest('Choose a serial device');
  if (managedPaths().includes(path) || isSerialPathOpen(path)) {
    throw new BadRequest(`${path} is in use by the running device connection. Stop devices first, or query through the connected inverter.`);
  }
  return { type: 'rtu', path, baudRate: int(body.baudRate ?? 9600, 'Baud rate', 1200, 115200), address, timeoutMs: 2000 };
}

const hex = (v: number) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');

function decodeFor(model: string | undefined, fn: number, start: number, registers: number[]) {
  const configured = settings.get('inverter.driver_id') === 'growatt' ? settings.get('inverter.model_id') : '';
  const id = model || configured;
  if (!id) return undefined;
  const decoded = decodeRange(growattFamily(id), fn, start, registers);
  return Object.keys(decoded).length ? decoded : undefined;
}

export async function register(app: App) {
  app.post<{ Body: ReadBody }>('/api/tools/modbus/read', async (req, reply) => {
    const body = req.body ?? {};
    try {
      const fn = int(body.fn ?? 4, 'Function', 3, 4);
      const start = int(body.start, 'Start', 0, 65535);
      const count = int(body.count ?? 10, 'Count', 1, MAX_READ);
      let registers: number[];
      if ((body.source ?? 'device') === 'device') {
        const index = int(body.index ?? 0, 'Inverter', 0, 63);
        const driver = devices.driver(index);
        if (!devices.started || !driver) throw new BadRequest('Not connected. Start the inverter connection on the Configuration page.');
        if (!driver.rawRead) throw new BadRequest('This inverter driver has no Modbus console');
        registers = await driver.rawRead(fn, start, count);
      } else {
        registers = await withConnection(directTarget(body), (c) => c.read(fn as 3 | 4, start, count));
      }
      return {
        registers,
        hex: registers.map(hex),
        decoded: decodeFor(body.model, fn, start, registers),
      };
    } catch (err) {
      const message = (err as Error).message || 'Modbus error';
      return reply.code(err instanceof BadRequest ? 400 : 502).send({ error: message });
    }
  });

  app.post<{ Body: WriteBody }>('/api/tools/modbus/write', async (req, reply) => {
    const body = req.body ?? {};
    try {
      if (body.confirm !== true) throw new BadRequest('Writing registers requires confirm: true');
      const index = int(body.index ?? 0, 'Inverter', 0, 63);
      const start = int(body.start, 'Start', 0, 65535);
      const values = body.values;
      if (!Array.isArray(values) || values.length < 1 || values.length > MAX_WRITE) {
        throw new BadRequest(`values must be a list of 1–${MAX_WRITE} registers`);
      }
      values.forEach((v, i) => int(v, `Value ${i + 1}`, 0, 0xffff));
      const driver = devices.driver(index);
      if (!devices.started || !driver) throw new BadRequest('Not connected. Start the inverter connection first.');
      if (!driver.rawWrite) throw new BadRequest('This inverter driver does not support raw writes');
      await driver.rawWrite(start, values.map(Number));
      log.write('devices', 'warn', `Modbus console wrote ${values.length} register(s) at ${start} on inverter ${index + 1}: ${values.join(', ')}`);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message || 'Modbus error';
      return reply.code(err instanceof BadRequest ? 400 : 502).send({ error: message });
    }
  });

  /** Driver/model context for the console page. */
  app.get('/api/tools/modbus/context', async () => {
    const driverId = settings.get('inverter.driver_id');
    return {
      started: devices.started,
      driverId,
      modelId: settings.get('inverter.model_id'),
      inverters: devices.inverterCount,
      hasConsole: Boolean(devices.driver(0)?.rawRead),
      connections: settings.get('inverter.connection_ids'),
      baudRate: settings.get('inverter.baud_rate') || inverterDriver(driverId)?.defaultBaudRate || 9600,
      address: settings.get('inverter.modbus_address') || inverterDriver(driverId)?.defaultAddress || 1,
    };
  });
}
