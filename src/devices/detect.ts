/**
 * Inverter auto-detect: probes one connection with every driver that can identify itself and
 * reports what answered. Probes only read (Voltronic QPI/QMN queries, Modbus register reads).
 *
 * Order: Voltronic first on serial/HID paths (2400 baud ASCII), then each Modbus driver's
 * `detect` at its own default baud rate (address 1). Network connections (host:port, solarman://)
 * only get the Modbus probes. A connection held by the running device manager is refused.
 */
import { isSerialPathOpen, ModbusConnection, parseConnection } from './modbus.ts';
import { detectGoodweUdp } from './inverters/goodwe/index.ts';
import { transportFor, VoltronicLink } from './inverters/voltronic/protocol.ts';
import { INVERTER_DRIVERS } from './registry.ts';
import type { InverterDriverDescriptor } from './types.ts';

export interface DetectResult {
  driverId: string;
  driverName: string;
  modelId: string | null;
  evidence: string;
  baudRate: number | null;
  /** Modbus unit id that answered, when it isn't the driver's default. */
  address: number | null;
}

export interface DetectDeps {
  drivers?: InverterDriverDescriptor[];
  /** GoodWe UDP probe; injected by tests. */
  goodweUdp?: typeof detectGoodweUdp;
  /** Voltronic probe; injected by tests. Returns the QPI reply (and model name) or throws. */
  voltronic?: (connection: string) => Promise<{ protocol: string; model?: string }>;
  modbusTimeoutMs?: number;
  /** Pause after a network connect before the first probe (Huawei drops requests sent at once). */
  networkSettleMs?: number;
}

const isNetwork = (c: string) => parseConnection(c, 9600, 1).type !== 'rtu';

async function probeVoltronic(connection: string) {
  const link = new VoltronicLink(transportFor(connection, 2400), { timeoutMs: 1200 });
  await link.open();
  try {
    const protocol = (await link.ask('QPI')).trim();
    let model: string | undefined;
    try {
      model = (await link.ask('QMN')).trim();
    } catch {}
    return { protocol, model };
  } finally {
    await link.close().catch(() => {});
  }
}

/** Voltronic protocol id (QPI) → our model id, where it tells. PI17/PI18 are the InfiniSolar family. */
function voltronicModelFor(protocol: string): string | null {
  if (/^PI1[78]/i.test(protocol)) return 'infinisolar';
  return null;
}

export async function detect(connection: string, deps: DetectDeps = {}): Promise<DetectResult[]> {
  const conn = connection.trim();
  if (!conn) throw new Error('Choose a connection to probe');
  // A Luxpower dongle address already says what's behind it.
  if (/^luxpower:\/\//i.test(conn)) {
    const lux = (deps.drivers ?? INVERTER_DRIVERS).find((d) => d.id === 'luxpower');
    return lux ? [{ driverId: lux.id, driverName: lux.name, modelId: null, evidence: 'Luxpower/EG4 WiFi dongle connection', baudRate: null, address: null }] : [];
  }
  // GoodWe WiFi/LAN dongles answer on UDP 8899 (Modbus-over-UDP or the older AA55 protocol).
  if (/^goodwe:\/\//i.test(conn)) {
    const gw = (deps.drivers ?? INVERTER_DRIVERS).find((d) => d.id === 'goodwe');
    const r = gw ? await (deps.goodweUdp ?? detectGoodweUdp)(conn) : null;
    if (!gw || !r) return [];
    const address = r.address !== undefined && r.address !== (gw.defaultAddress ?? 1) ? r.address : null;
    return [{ driverId: gw.id, driverName: gw.name, modelId: r.modelId ?? null, evidence: r.evidence, baudRate: null, address }];
  }
  if (!isNetwork(conn) && isSerialPathOpen(conn)) throw new Error(`${conn} is in use by the device connection. Disconnect first.`);
  const drivers = deps.drivers ?? INVERTER_DRIVERS;
  const found: DetectResult[] = [];

  if (!isNetwork(conn)) {
    const volt = drivers.find((d) => d.id === 'voltronic');
    if (volt) {
      try {
        const r = await (deps.voltronic ?? probeVoltronic)(conn);
        found.push({
          driverId: volt.id, driverName: volt.name, modelId: voltronicModelFor(r.protocol), baudRate: 2400, address: null,
          evidence: `protocol ${r.protocol}${r.model ? `, model ${r.model}` : ''}`,
        });
        return found;
      } catch {
        // Silence or garbage: not a Voltronic, try Modbus.
      }
    }
    if (/hidraw/i.test(conn)) return found;
  }

  // Group Modbus probes by baud rate so each rate opens the port once.
  const byBaud = new Map<number, InverterDriverDescriptor[]>();
  for (const d of drivers) {
    // Network-only drivers (GX devices, plant controllers) are never behind a serial port.
    if (!d.detect || (d.transport === 'tcp' && !isNetwork(conn))) continue;
    for (const baud of d.detectBaudRates ?? [d.defaultBaudRate ?? 9600]) byBaud.set(baud, [...(byBaud.get(baud) ?? []), d]);
  }
  const rates = isNetwork(conn) ? [[0, [...new Set([...byBaud.values()].flat())]] as const] : [...byBaud.entries()];
  for (const [baud, list] of rates) {
    // Eybond dongles dial in to us: give one that's already been redirected a little while to show up.
    const target = { ...parseConnection(conn, baud || 9600, 1), timeoutMs: deps.modbusTimeoutMs ?? 1000, connectTimeoutMs: 15_000 };
    const mc = new ModbusConnection(target);
    try {
      await mc.connect();
    } catch (err) {
      if (isNetwork(conn)) throw new Error(`Can't connect to ${conn}: ${(err as Error).message}`);
      continue;
    }
    if (isNetwork(conn)) await new Promise((r) => setTimeout(r, deps.networkSettleMs ?? 1000));
    try {
      for (const d of list) {
        try {
          const r = await d.detect!(mc);
          if (r) {
            found.push({
              driverId: d.id, driverName: d.name, modelId: r.modelId ?? null, evidence: r.evidence, baudRate: baud || null,
              address: r.address !== undefined && r.address !== (d.defaultAddress ?? 1) ? r.address : null,
            });
          }
        } catch {
          // No answer / exception: not this one.
        }
        if (found.length) return found;
      }
    } finally {
      await mc.close().catch(() => {});
    }
  }
  return found;
}
