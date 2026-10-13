/**
 * Diagnostics API: serial test, serial inspect (pipe / trace), protocol broker, serial BMS console
 * and the standalone Modbus console. Live updates go out as Server-Sent Events on
 * GET /api/diagnostics/stream?topic=test|inspect|broker.
 */
import { dirname, join } from 'node:path';
import { dbPath } from '../../core/db.ts';
import { settings } from '../../core/settings.ts';
import { decodeRange, growattFamily } from '../../devices/inverters/growatt/index.ts';
import { hexByte } from '../../diagnostics/bms-console.ts';
import {
  BROKER_TYPES, defaultConfig, deleteBroker, getBroker, listBrokers, normalizeConfig, saveBroker, type BrokerConfig, type BrokerType,
} from '../../diagnostics/broker.ts';
import { diagBus, type Topic } from '../../diagnostics/bus.ts';
import { parseHex, parseText } from '../../diagnostics/frames.ts';
import { bmsConsole, broker, inspector, modbusConsole, serialTest } from '../../diagnostics/index.ts';
import type { Dev } from '../../diagnostics/inspect.ts';
import { busyReason, listSerialPaths } from '../../diagnostics/port.ts';
import type { App } from '../server.ts';

class BadRequest extends Error {}

type Body = Record<string, unknown>;

function int(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}
const str = (v: unknown, name: string) => {
  const s = String(v ?? '').trim();
  if (!s) throw new BadRequest(`${name} is required`);
  if (s.length > 200) throw new BadRequest(`${name} is too long`);
  return s;
};
const dev = (v: unknown): Dev => {
  if (v !== 'dev1' && v !== 'dev2') throw new BadRequest("dev must be 'dev1' or 'dev2'");
  return v;
};
const side = (v: unknown) => {
  if (v !== 'from' && v !== 'to') throw new BadRequest("side must be 'from' or 'to'");
  return v;
};

/** Wraps a handler: thrown errors become 400 { error }. */
function handle<T>(fn: (body: Body, params: Record<string, string>, query: Record<string, string>) => Promise<T> | T) {
  return async (req: { body?: unknown; params?: unknown; query?: unknown }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    try {
      return await fn((req.body ?? {}) as Body, (req.params ?? {}) as Record<string, string>, (req.query ?? {}) as Record<string, string>);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message || 'Failed' });
    }
  };
}

function snapshot(topic: Topic) {
  if (topic === 'inspect') return inspector.state();
  if (topic === 'broker') return broker.state();
  if (topic === 'bms') return bmsConsole.state();
  return serialTest.state();
}

export async function register(app: App) {
  try {
    inspector.traceDir = join(dirname(dbPath()) || 'data', 'traces');
  } catch {}

  app.get('/api/diagnostics/ports', async () => {
    const list = await listSerialPaths();
    return list.map((p) => ({ ...p, busy: busyReason(p.path) }));
  });

  // ---- Live stream -------------------------------------------------------------------
  // Hijacked SSE responses would keep server.close() waiting forever; end them on shutdown.
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });
  app.get('/api/diagnostics/stream', (req, reply) => {
    const topic = String((req.query as Record<string, string>)?.topic ?? 'test') as Topic;
    if (!['test', 'inspect', 'broker', 'bms'].includes(topic)) return reply.code(400).send({ error: 'Unknown topic' });
    reply.hijack();
    const res = reply.raw;
    streams.add(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', snapshot(topic));
    const onEvent = (e: { topic: Topic; type: string; data: unknown }) => e.topic === topic && send(e.type, e.data);
    diagBus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref();
    req.raw.on('close', () => {
      clearInterval(ping);
      streams.delete(res);
      diagBus.off('event', onEvent);
    });
  });

  // ---- Serial test -------------------------------------------------------------------
  app.get('/api/diagnostics/serial-test', handle(() => serialTest.preview()));
  app.post('/api/diagnostics/serial-test/start', handle(() => serialTest.start()));
  app.post('/api/diagnostics/serial-test/stop', handle(() => serialTest.stop()));

  // ---- Serial inspect ----------------------------------------------------------------
  app.get('/api/diagnostics/inspect', handle(() => inspector.state()));
  app.post('/api/diagnostics/inspect/connect', handle(async (b) => {
    await inspector.connect(dev(b.dev), str(b.path, 'Device'), int(b.baud ?? 9600, 'Baud', 50, 4_000_000));
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/disconnect', handle(async (b) => {
    await inspector.disconnect(dev(b.dev));
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/pipe', handle((b) => {
    inspector.setPipe(dev(b.dev), b.on === true);
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/split', handle((b) => {
    inspector.setSplit(int(b.ms, 'Split', 1, 10_000));
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/send', handle(async (b) => {
    const text = String(b.data ?? '');
    if (!text) throw new BadRequest('Enter data to send');
    let data: Buffer;
    if (b.format === 'hex') data = parseHex(text);
    else if (b.format === 'text') data = parseText(text);
    else {
      // auto: hex when it parses as hex, else text with escapes
      try {
        data = parseHex(text);
      } catch {
        data = parseText(text);
      }
    }
    await inspector.send(dev(b.dev), data);
    return { ok: true, bytes: data.length };
  }));
  app.post('/api/diagnostics/inspect/clear', handle(() => {
    inspector.clearLog();
    return inspector.state();
  }));
  app.get('/api/diagnostics/inspect/traces', handle(() => inspector.listTraces()));
  app.post('/api/diagnostics/inspect/trace/load', handle(async (b) => {
    await inspector.loadTrace(str(b.name, 'File name'));
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/trace/save', handle(async (b) => {
    await inspector.saveTrace(str(b.name, 'File name'));
    return inspector.state();
  }));
  app.post('/api/diagnostics/inspect/trace/close', handle(() => {
    inspector.closeTrace();
    return inspector.state();
  }));

  // ---- Broker ------------------------------------------------------------------------
  app.get('/api/diagnostics/brokers', handle(() => listBrokers()));
  app.get('/api/diagnostics/brokers/:id', handle((_b, p) => {
    const cfg = getBroker(int(p.id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!cfg) throw new BadRequest('Broker not found');
    return cfg;
  }));
  app.post('/api/diagnostics/brokers', handle((b) => saveBroker(normalizeConfig(b as Partial<BrokerConfig>))));
  app.delete('/api/diagnostics/brokers/:id', handle(async (_b, p) => {
    const id = int(p.id, 'id', 1, Number.MAX_SAFE_INTEGER);
    if (broker.config?.id === id) await broker.stop();
    deleteBroker(id);
    return { ok: true };
  }));

  app.get('/api/diagnostics/broker', handle(() => broker.state()));
  app.post('/api/diagnostics/broker/start', handle(async (b) => {
    let cfg: BrokerConfig | null;
    if (b.id !== undefined && b.id !== null && b.id !== '') {
      cfg = getBroker(int(b.id, 'id', 1, Number.MAX_SAFE_INTEGER));
      if (!cfg) throw new BadRequest('Broker not found');
    } else {
      const type = String(b.type ?? 'modbus') as BrokerType;
      if (!BROKER_TYPES.includes(type)) throw new BadRequest('Unknown broker type');
      cfg = defaultConfig(type);
    }
    await broker.start(cfg);
    return broker.state();
  }));
  app.post('/api/diagnostics/broker/stop', handle(() => broker.stop().then(() => broker.state())));
  app.post('/api/diagnostics/broker/connect', handle(async (b) => {
    const s = side(b.side);
    await broker.connect(s, str(b.path, 'Device'), int(b.baud ?? (s === 'from' ? 9600 : 115200), 'Baud', 50, 4_000_000));
    return broker.state();
  }));
  app.post('/api/diagnostics/broker/disconnect', handle(async (b) => {
    await broker.disconnect(side(b.side));
    return broker.state();
  }));
  app.post('/api/diagnostics/broker/allow-write', handle((b) => {
    broker.setAllowWrite(b.on === true);
    return broker.state();
  }));
  app.put('/api/diagnostics/broker/data', handle((b) => {
    const partial: Partial<BrokerConfig> = {};
    if (b.name !== undefined) partial.name = String(b.name);
    if (Array.isArray(b.tables)) partial.tables = b.tables as BrokerConfig['tables'];
    if (Array.isArray(b.responses)) partial.responses = b.responses as BrokerConfig['responses'];
    if (b.from !== undefined) partial.from = b.from as BrokerConfig['from'];
    if (b.to !== undefined) partial.to = b.to as BrokerConfig['to'];
    broker.update(partial);
    return broker.state();
  }));
  app.post('/api/diagnostics/broker/save', handle(() => {
    if (!broker.config) throw new BadRequest('No broker running');
    const saved = saveBroker(broker.config);
    broker.config.id = saved.id;
    return { ...broker.state(), saved };
  }));

  // ---- Serial BMS console ------------------------------------------------------------
  app.get('/api/diagnostics/bms', handle(() => bmsConsole.state()));
  app.post('/api/diagnostics/bms/connect', handle(async (b) => {
    await bmsConsole.connect(str(b.path, 'Device'), int(b.baud ?? 9600, 'Baud', 50, 4_000_000));
    return bmsConsole.state();
  }));
  app.post('/api/diagnostics/bms/disconnect', handle(async () => {
    await bmsConsole.disconnect();
    return bmsConsole.state();
  }));
  app.post('/api/diagnostics/bms/submit', handle((b) =>
    bmsConsole.submit(hexByte(b.protocol ?? '20', 'Protocol'), hexByte(b.address ?? '02', 'Address'), hexByte(b.unit ?? 'FF', 'Unit'), b.simulate === true),
  ));

  // ---- Standalone Modbus console -----------------------------------------------------
  app.get('/api/diagnostics/modbus', handle(() => modbusConsole.state()));
  app.post('/api/diagnostics/modbus/connect', handle(async (b) => {
    if (b.type === 'tcp') await modbusConsole.connect({ type: 'tcp', host: str(b.host, 'IP address'), port: int(b.port ?? 502, 'Port', 1, 65535) });
    else await modbusConsole.connect({ type: 'rtu', path: str(b.path, 'Device'), baud: int(b.baud ?? 9600, 'Baud', 50, 4_000_000) });
    return modbusConsole.state();
  }));
  app.post('/api/diagnostics/modbus/disconnect', handle(async () => {
    await modbusConsole.disconnect();
    return modbusConsole.state();
  }));
  app.post('/api/diagnostics/modbus/query', handle(async (b) => {
    const fn = int(b.fn ?? 4, 'Function', 1, 4);
    const start = int(b.start, 'Start', 0, 65535);
    const count = int(b.count ?? 10, 'Limit', 1, 125);
    const res = await modbusConsole.query(int(b.address ?? 1, 'Address', 0, 247), fn, start, count);
    const configured = settings.get('inverter.driver_id') === 'growatt' ? settings.get('inverter.model_id') : '';
    const model = typeof b.model === 'string' && b.model ? b.model : configured;
    let decoded: Record<string, number | string> | undefined;
    if (model && (fn === 3 || fn === 4)) {
      decoded = decodeRange(growattFamily(model), fn, start, res.registers);
      if (!Object.keys(decoded).length) decoded = undefined;
    }
    return { ...res, decoded, log: modbusConsole.log.entries.slice(-10) };
  }));
}
