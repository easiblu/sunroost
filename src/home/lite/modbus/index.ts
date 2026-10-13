/**
 * Generic Modbus: relay boards, energy meters, transfer switches, EV chargers … anything that
 * speaks Modbus TCP or RTU. One entry = one device (connection + unit id + points).
 *
 * Setup: connection details (checked with a test read: any answer, even a Modbus error, proves the
 * device is there), then a profile (relay board, Eastron SDM120/SDM630) or custom points
 * (points.ts). Polls every 5 s in batches; a write is confirmed by re-reading the point; three failed
 * polls in a row make the device unavailable and the connection is reopened.
 *
 * Give transfer switches and chargers the Protected energy role so automations need explicit
 * permission to switch them.
 */
import { newContext } from '../../bus.ts';
import type { UiField } from '../../full/flows.ts';
import { UNAVAILABLE, UNKNOWN, type Context, type ServiceCall, type ServiceResult } from '../../types.ts';
import type { DriverContext, DriverStatus, FlowContext, FlowStep, LiteDriver, LiteEntry } from '../types.ts';
import { describe, isException, ModbusClient, reason, type Connection } from './client.ts';
import {
  batches, decode, encode, parsePoints, PointError, PROFILES, relayBoard, sdm120, sdm630, tidy, width, type Batch, type Point, type ProfileId,
} from './points.ts';

const POLL_MS = 5000;
const FAILS_BEFORE_UNAVAILABLE = 3;

export interface ModbusOptions {
  /** Default poll interval (tests use less). */
  pollMs?: number;
  /** Request timeout (tests use less). */
  timeoutMs?: number;
}

interface Device {
  entry: LiteEntry;
  client: ModbusClient;
  points: Point[];
  /** point key → entity id */
  entities: Map<string, string>;
  fails: number;
  timer: NodeJS.Timeout | null;
  lastError: string | null;
  polling: boolean;
}

const POINTS_HELP = [
  'One point per line:  name; kind; table; address[; type][; option=value …]',
  'kind: switch, sensor, binary_sensor, number, select · table: coil, discrete, holding, input',
  'address: protocol address, 0-based (holding register 40001 = 0); 0x hex is fine',
  'type: bool, u16, s16, u32, s32, float32 · options: scale=0.1 unit=W order=le on=1 off=0 min= max= step= options=0:Off|1:On',
  'Example:  Transfer to generator; switch; coil; 0',
].join('\n');

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

export class ModbusDriver implements LiteDriver {
  id = 'modbus';
  name = 'Modbus (TCP or RTU)';
  iotClass = 'local_polling' as const;
  private ctx: DriverContext | null = null;
  private devices = new Map<string, Device>(); // entry id → device
  private pollMs: number;
  private timeoutMs: number;

  constructor(opts: ModbusOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? 1500;
  }

  async start(ctx: DriverContext) {
    this.ctx = ctx;
  }

  async stop() {
    for (const d of this.devices.values()) await this.shutdown(d);
    this.devices.clear();
    this.ctx = null;
  }

  status(): DriverStatus {
    const list = [...this.devices.values()];
    const up = list.filter((d) => d.fails < FAILS_BEFORE_UNAVAILABLE);
    return {
      state: !list.length || up.length ? 'connected' : 'error',
      message: list.length && !up.length ? 'No Modbus device is answering' : null,
      entities: list.reduce((n, d) => n + d.entities.size, 0),
      details: { devices: list.map((d) => ({ title: d.entry.title, connection: describe(d.client.conn), ok: d.fails < FAILS_BEFORE_UNAVAILABLE, lastError: d.lastError })) },
    };
  }

  // ---------- Config flow ----------

  private connectionForm(errors?: Record<string, string>, values: Record<string, unknown> = {}): FlowStep {
    const v = (k: string, d: unknown) => (values[k] !== undefined && values[k] !== '' ? values[k] : d);
    const fields: UiField[] = [
      { name: 'name', label: 'Name', help: 'e.g. Transfer switch, EV charger, Main meter', kind: 'text', required: true, default: v('name', '') },
      { name: 'transport', label: 'Connection', help: null, kind: 'select', required: true, default: v('transport', 'tcp'),
        options: [{ value: 'tcp', label: 'Modbus TCP (network)' }, { value: 'rtu', label: 'Modbus RTU (RS-485 serial adapter)' }] },
      { name: 'host', label: 'IP address or host name', help: 'Modbus TCP only', kind: 'text', required: false, default: v('host', '') },
      { name: 'port', label: 'TCP port', help: 'Modbus TCP only', kind: 'number', required: false, default: v('port', 502), min: 1, max: 65535, step: 1 },
      { name: 'path', label: 'Serial port', help: 'RTU only, e.g. /dev/ttyUSB0', kind: 'text', required: false, default: v('path', '') },
      { name: 'baud', label: 'Baud rate', help: 'RTU only', kind: 'select', required: false, default: String(v('baud', 9600)),
        options: BAUDS.map((b) => ({ value: String(b), label: String(b) })) },
      { name: 'parity', label: 'Parity', help: 'RTU only', kind: 'select', required: false, default: v('parity', 'none'),
        options: [{ value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }] },
      { name: 'unit', label: 'Unit id (slave address)', help: '1–247; often 1', kind: 'number', required: true, default: v('unit', 1), min: 0, max: 247, step: 1 },
    ];
    return {
      type: 'form', stepId: 'connection', title: 'Add a Modbus device',
      description: 'Relay boards, energy meters, transfer switches, chargers … Sunroost checks the connection before continuing.',
      fields, errors,
    };
  }

  private profileForm(errors?: Record<string, string>): FlowStep {
    return {
      type: 'form', stepId: 'profile', title: 'What is it?',
      description: 'Choose a built-in profile, or Custom to define the registers from the device manual.',
      fields: [
        { name: 'profile', label: 'Profile', help: null, kind: 'select', required: true, default: 'custom', options: PROFILES },
        { name: 'relays', label: 'Number of relays', help: 'Relay board only', kind: 'number', required: false, default: 8, min: 1, max: 32, step: 1 },
        { name: 'first', label: 'First coil address', help: 'Relay board only (0-based)', kind: 'number', required: false, default: 0, min: 0, max: 65535, step: 1 },
        { name: 'poll', label: 'Read every', help: null, kind: 'number', required: true, default: this.pollMs / 1000, min: 1, max: 3600, step: 1, unit: 's' },
      ],
      errors,
    };
  }

  private customForm(errors?: Record<string, string>, text = ''): FlowStep {
    return {
      type: 'form', stepId: 'custom', title: 'Define the points',
      description: POINTS_HELP,
      fields: [{ name: 'points', label: 'Points', help: 'Up to 16. Lines starting with # are ignored.', kind: 'text', multiline: true, required: true, default: text }],
      errors,
    };
  }

  /** Validates the connection step's input; returns the connection or field errors. */
  private connectionFrom(input: Record<string, unknown>): { conn: Connection; name: string } | { errors: Record<string, string> } {
    const errors: Record<string, string> = {};
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) errors.name = 'Give it a name (up to 60 characters).';
    const transport = input.transport === 'rtu' ? 'rtu' : 'tcp';
    const unit = Number(input.unit);
    if (!Number.isInteger(unit) || unit < 0 || unit > 247) errors.unit = 'Unit id must be 0–247.';
    const conn: Connection = { transport, unit, timeoutMs: this.timeoutMs };
    if (transport === 'tcp') {
      conn.host = String(input.host ?? '').trim();
      conn.port = Number(input.port ?? 502) || 502;
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(conn.host)) errors.host = 'Enter the IP address or host name.';
      if (!Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535) errors.port = 'Port must be 1–65535.';
    } else {
      conn.path = String(input.path ?? '').trim();
      conn.baud = Number(input.baud ?? 9600);
      conn.parity = input.parity === 'even' || input.parity === 'odd' ? input.parity : 'none';
      if (!/^\/dev\/[A-Za-z0-9._/-]+$/.test(conn.path)) errors.path = 'Enter the serial port, e.g. /dev/ttyUSB0.';
      if (!BAUDS.includes(conn.baud)) errors.baud = 'Choose a baud rate.';
    }
    return Object.keys(errors).length ? { errors } : { conn, name };
  }

  /** Any answer proves the device is there, including a Modbus error for an unmapped register. */
  async testConnection(conn: Connection): Promise<string | null> {
    const client = new ModbusClient(conn);
    try {
      await client.ensureOpen();
      try {
        await client.readRegisters('holding', 0, 1);
      } catch (err) {
        if (!isException(err)) throw err;
      }
      return null;
    } catch (err) {
      return `No answer from ${describe(conn)}: ${reason(err)}.`;
    } finally {
      await client.close().catch(() => {});
    }
  }

  flow = {
    start: async (_ctx: FlowContext): Promise<FlowStep> => this.connectionForm(),
    submit: async (ctx: FlowContext, stepId: string, input: Record<string, unknown>): Promise<FlowStep> => {
      if (stepId === 'connection') {
        const r = this.connectionFrom(input);
        if ('errors' in r) return this.connectionForm(r.errors, input);
        const problem = await this.testConnection(r.conn);
        if (problem) return this.connectionForm({ base: problem }, input);
        ctx.state.conn = r.conn;
        ctx.state.name = r.name;
        return this.profileForm();
      }
      if (stepId === 'profile') {
        const profile = String(input.profile ?? '') as ProfileId;
        const poll = Number(input.poll ?? 5);
        if (!PROFILES.some((p) => p.value === profile)) return this.profileForm({ profile: 'Choose a profile.' });
        if (!(poll >= 1 && poll <= 3600)) return this.profileForm({ poll: 'Read every 1–3600 seconds.' });
        ctx.state.pollMs = Math.round(poll * 1000);
        ctx.state.profile = profile;
        if (profile === 'custom') return this.customForm();
        let points: Point[];
        if (profile === 'relay') {
          const n = Number(input.relays ?? 8);
          const first = Number(input.first ?? 0);
          if (!Number.isInteger(n) || n < 1 || n > 32) return this.profileForm({ relays: 'Number of relays must be 1–32.' });
          if (!Number.isInteger(first) || first < 0 || first + n - 1 > 0xffff) return this.profileForm({ first: 'Invalid first coil address.' });
          points = relayBoard(n, first);
        } else points = profile === 'sdm120' ? sdm120() : sdm630();
        return this.finish(ctx, points);
      }
      if (stepId === 'custom') {
        const text = String(input.points ?? '');
        try {
          return this.finish(ctx, parsePoints(text));
        } catch (err) {
          if (!(err instanceof PointError)) throw err;
          return this.customForm({ points: err.message }, text);
        }
      }
      return { type: 'abort', reason: 'Unknown step' };
    },
  };

  private finish(ctx: FlowContext, points: Point[]): FlowStep {
    const conn = ctx.state.conn as Connection;
    const where = conn.transport === 'tcp' ? `${conn.host}:${conn.port}` : conn.path;
    return {
      type: 'create_entry',
      title: String(ctx.state.name),
      uniqueId: `${conn.transport}:${where}#${conn.unit}`,
      data: { conn: { ...conn, timeoutMs: undefined }, profile: ctx.state.profile, points, pollMs: ctx.state.pollMs },
    };
  }

  // ---------- Entries → devices ----------

  async entryAdded(entry: LiteEntry) {
    const ctx = this.ctx;
    if (!ctx) return;
    const host = ctx.host;
    const conn = { ...(entry.data.conn as Connection), timeoutMs: this.timeoutMs };
    const points = entry.data.points as Point[];
    const profile = String(entry.data.profile ?? 'custom');
    const dev = host.registerDevice({
      uniqueId: `modbus:${entry.uniqueId ?? entry.id}`, name: entry.title,
      manufacturer: profile.startsWith('sdm') ? 'Eastron' : null,
      model: PROFILES.find((p) => p.value === profile)?.label ?? 'Modbus device',
      config: { entryId: entry.id },
    });
    const d: Device = { entry, client: new ModbusClient(conn), points, entities: new Map(), fails: 0, timer: null, lastError: null, polling: false };
    for (const p of points) {
      const writable = p.kind !== 'sensor' && p.kind !== 'binary_sensor';
      const e = host.registerEntity({
        uniqueId: `modbus:${entry.id}:${p.key}`,
        domain: p.kind,
        name: `${entry.title} ${p.name}`,
        deviceId: dev.id,
        unit: p.unit,
        deviceClass: p.deviceClass,
        readOnly: !writable,
      });
      d.entities.set(p.key, e.entityId);
    }
    const old = this.devices.get(entry.id);
    if (old) await this.shutdown(old);
    this.devices.set(entry.id, d);
    const every = Number(entry.data.pollMs) || this.pollMs;
    d.timer = setInterval(() => void this.poll(entry.id), every);
    await this.poll(entry.id);
  }

  async entryRemoved(entry: LiteEntry) {
    const d = this.devices.get(entry.id);
    this.devices.delete(entry.id);
    if (d) await this.shutdown(d);
  }

  private async shutdown(d: Device) {
    if (d.timer) clearInterval(d.timer);
    d.timer = null;
    await d.client.close().catch(() => {});
  }

  /** Static attributes the UI needs (ranges, options). */
  private attributes(p: Point): Record<string, unknown> {
    if (p.kind === 'number') return { min: p.min, max: p.max, step: p.step };
    if (p.kind === 'select') return { options: (p.options ?? []).map((o) => o.label) };
    return {};
  }

  /** Raw read value → entity state. */
  private stateOf(p: Point, raw: number | boolean): string {
    if (typeof raw === 'boolean') return raw ? 'on' : 'off';
    if (p.kind === 'switch') return raw === p.on ? 'on' : raw === p.off ? 'off' : UNKNOWN;
    if (p.kind === 'binary_sensor') return (p.on !== undefined ? raw === p.on : raw !== 0) ? 'on' : 'off';
    if (p.kind === 'select') return p.options?.find((o) => o.value === raw)?.label ?? UNKNOWN;
    return String(tidy(raw * p.scale));
  }

  /** Reads all points (or just `only`) and updates their entities. Exposed for tests. */
  async poll(entryId: string, context: Context = newContext('device'), only?: Point[]): Promise<boolean> {
    const d = this.devices.get(entryId);
    if (!d || !this.ctx || (d.polling && !only)) return false;
    d.polling = !only;
    try {
      await d.client.ensureOpen();
      for (const b of batches(only ?? d.points)) {
        let values: (number | boolean)[];
        try {
          values = await this.readBatch(d, b);
        } catch (err) {
          if (!isException(err)) throw err;
          // The device answered but refused part of the range: read the points one by one, so only
          // the ones it really doesn't have become unknown.
          if (this.devices.get(entryId) !== d) return false;
          for (const p of b.points) {
            try {
              const single = { table: b.table, start: p.address, count: width(p.type), points: [p] };
              this.apply(d, single, await this.readBatch(d, single), context);
            } catch (e2) {
              if (!isException(e2)) throw e2;
              d.lastError = `${b.table} ${p.address}: ${reason(e2)}`;
              if (this.devices.get(entryId) !== d) return false;
              this.ctx?.host.setState(d.entities.get(p.key)!, UNKNOWN, this.attributes(p), context);
            }
          }
          continue;
        }
        if (this.devices.get(entryId) !== d) return false; // removed while reading
        this.apply(d, b, values, context);
      }
      d.fails = 0;
      return true;
    } catch (err) {
      if (this.devices.get(entryId) !== d) return false;
      d.lastError = reason(err);
      if (++d.fails >= FAILS_BEFORE_UNAVAILABLE) {
        for (const p of d.points) this.ctx?.host.setState(d.entities.get(p.key)!, UNAVAILABLE, this.attributes(p));
      }
      // Reopen on the next poll (the link may have dropped).
      await d.client.close().catch(() => {});
      return false;
    } finally {
      if (!only) d.polling = false;
    }
  }

  private readBatch(d: Device, b: Batch): Promise<(number | boolean)[]> {
    return b.table === 'coil' || b.table === 'discrete' ? d.client.readBits(b.table, b.start, b.count) : d.client.readRegisters(b.table, b.start, b.count);
  }

  /** Decodes one batch's values into its points' entity states. */
  private apply(d: Device, b: Batch, values: (number | boolean)[], context: Context) {
    for (const p of b.points) {
      const off = p.address - b.start;
      const raw = typeof values[0] === 'boolean'
        ? (values[off] as boolean)
        : decode((values as number[]).slice(off, off + width(p.type)), p.type, p.order);
      this.ctx?.host.setState(d.entities.get(p.key)!, this.stateOf(p, raw), this.attributes(p), context);
    }
  }

  async callService(call: ServiceCall): Promise<ServiceResult> {
    let d: Device | undefined;
    let p: Point | undefined;
    for (const dev of this.devices.values()) {
      for (const [key, id] of dev.entities) {
        if (id === call.entityId) {
          d = dev;
          p = dev.points.find((x) => x.key === key);
        }
      }
    }
    if (!d || !p) return { ok: false, message: 'Unknown Modbus point' };
    try {
      await d.client.ensureOpen();
      if (p.kind === 'switch') {
        if (!['turn_on', 'turn_off', 'toggle'].includes(call.service)) return { ok: false, message: `A switch can't ${call.service}` };
        const on = call.service === 'toggle' ? !(await this.currentlyOn(d, p)) : call.service === 'turn_on';
        if (p.table === 'coil') await d.client.writeCoil(p.address, on);
        else await d.client.writeRegisters(p.address, encode(on ? p.on! : p.off!, p.type, p.order));
      } else if (p.kind === 'number') {
        if (call.service !== 'set_value') return { ok: false, message: `A number can't ${call.service}` };
        const v = Number(call.data.value);
        if (!Number.isFinite(v) || v < p.min! || v > p.max!) return { ok: false, message: `Value must be between ${p.min} and ${p.max}` };
        await d.client.writeRegisters(p.address, encode(v / p.scale, p.type, p.order));
      } else if (p.kind === 'select') {
        if (call.service !== 'select_option') return { ok: false, message: `A select can't ${call.service}` };
        const o = p.options?.find((x) => x.label === call.data.option);
        if (!o) return { ok: false, message: `"${String(call.data.option)}" is not one of the options` };
        await d.client.writeRegisters(p.address, encode(o.value, p.type, p.order));
      } else {
        return { ok: false, message: 'This point is read-only' };
      }
    } catch (err) {
      return { ok: false, message: `Write failed: ${reason(err)}` };
    }
    // Confirm by reading the point back.
    await this.poll(d.entry.id, newContext('device', call.context), [p]);
    return { ok: true };
  }

  private async currentlyOn(d: Device, p: Point): Promise<boolean> {
    if (p.table === 'coil') return (await d.client.readBits('coil', p.address, 1))[0];
    const raw = decode(await d.client.readRegisters('holding', p.address, width(p.type)), p.type, p.order);
    return raw === p.on;
  }
}
