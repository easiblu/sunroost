/**
 * "USB PylonTech/Pytes console": the RS232 console CLI of Pylontech US2000/US3000/US5000/
 * UP2500/UP5000/Force L2, Pytes and BlauHoff batteries (RJ11 or RJ45 "Console" port),
 * 115200 8N1, plain text.
 *
 *   pwr      one row per pack position: Volt (mV), Curr (mA), Tempr (m°C), Coulomb (%),
 *            Base.St (Charge/Dischg/Idle/Absent), Volt.St/Curr.St/Temp.St …
 *   bat <n>  one row per cell of pack n: Volt (mV), Tempr (m°C), SOC, Coulomb (mAH) …
 *   stat <n> counters, incl. "CYCLE Times"
 *   info <n> device name, firmware, barcode
 * Each reply echoes the command, prints the table, "Command completed successfully", "$$"
 * and the prompt ("pylon>", "pytes>" …). Columns are found by header name, so the order and
 * extra columns of different firmwares don't matter.
 *
 * Older RJ11 units start in RS232 "protocol" mode at 1200 baud and need a wake-up frame
 * before the console answers at 115200.
 */
import { logger } from '../../core/log.ts';
import type { Metrics } from '../../core/metrics.ts';
import type { BmsDriver, BmsDriverDescriptor } from '../types.ts';
import { MultiPortBms, packMetrics, type PackReading, type PortReader } from './pack.ts';
import { AdaptiveLink, maxPackCount, withInverterCurrent } from './serial-ascii.ts';
import { serialLinkFactory, type FrameReader, type LinkFactory } from './serial.ts';

const log = logger('devices');

export const CONSOLE_BAUD = 115200;
/** Sent at 1200 baud to switch an older pack from RS232 protocol mode to the console. */
export const WAKE_FRAME = '~20014682C0048520FCC3\r';
const TIMEOUT_MS = 2500;

// ---- Table parsing ------------------------------------------------------------------------

/** Normalised column key: lowercase letters/digits only ("Base.St" → "basest"). */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header tokens; two-word names like "Base State" / "Volt. State" are joined first. */
export function headerTokens(line: string): string[] {
  return line
    .replace(/(\w)\.?\s(State|St)\b/g, '$1.$2')
    .trim()
    .split(/\s+/)
    .map(key);
}

/** Row tokens; "2019-12-31 23:59:59" and "36088 mAH" / "72 %" stay one value each. */
export function rowTokens(line: string): string[] {
  const raw = line.trim().split(/\s+/);
  const out: string[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t) && /^\d{2,4}-\d{1,2}-\d{1,2}$/.test(prev)) out[out.length - 1] = `${prev} ${t}`;
    else if (prev !== undefined && /^(%|m?ah|mv|ma|v|a)$/i.test(t) && /^-?\d+(\.\d+)?$/.test(prev)) out[out.length - 1] = `${prev}${t}`;
    else out.push(t);
  }
  return out;
}

export type Row = Record<string, string>;

/**
 * Finds the table whose header's first column is one of `firstColumns` and returns its rows
 * keyed by normalised column name. Stops at the completion line / prompt.
 */
export function parseTable(text: string, firstColumns: string[]): Row[] {
  const lines = text.split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => {
    const h = headerTokens(l);
    return firstColumns.includes(h[0]) && h.includes('volt');
  });
  if (at < 0) return [];
  const header = headerTokens(lines[at]);
  const rows: Row[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/command completed|\$\$|>\s*$/i.test(line)) break;
    const t = rowTokens(line);
    if (!t.length || !/^\d+$/.test(t[0])) continue;
    const row: Row = {};
    header.forEach((h, i) => {
      if (t[i] !== undefined && !(h in row)) row[h] = t[i];
    });
    rows.push(row);
  }
  return rows;
}

const pick = (row: Row, names: string[]) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== '-') return row[n];
  return undefined;
};

const num = (s: string | undefined) => {
  if (s === undefined) return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
};

/** mV (integer) or V (decimal) → V. */
const volts = (s: string | undefined) => {
  const v = num(s);
  if (v === undefined) return undefined;
  return s!.includes('.') || Math.abs(v) < 100 ? v : v / 1000;
};
/** mA (integer) or A (decimal) → A. */
const amps = (s: string | undefined) => {
  const v = num(s);
  if (v === undefined) return undefined;
  return s!.includes('.') ? v : v / 1000;
};
/** m°C (25000), 0.1 °C (250) or °C → °C. */
const celsius = (s: string | undefined) => {
  const v = num(s);
  if (v === undefined) return undefined;
  if (s!.includes('.')) return v;
  return Math.abs(v) >= 1000 ? v / 1000 : Math.abs(v) >= 150 ? v / 10 : v;
};

const COL = {
  pack: ['power', 'battery', 'bat'],
  volt: ['volt', 'voltage'],
  curr: ['curr', 'current'],
  temp: ['tempr', 'temp', 'temperature'],
  soc: ['coulomb', 'soc'],
  status: ['basest', 'basestate', 'status'],
  cycles: ['cycle', 'cycles', 'cycletimes'],
  mosTemp: ['mostempr', 'mostemp'],
  remaining: ['coulomb', 'remain'],
};

const STATUS_COLUMNS: [string[], string][] = [
  [['voltst', 'voltstate'], 'Voltage'],
  [['currst', 'currstate'], 'Current'],
  [['tempst', 'tempstate'], 'Temperature'],
  [['bvst'], 'Battery voltage'],
  [['btst'], 'Battery temperature'],
  [['mtst'], 'MOSFET temperature'],
];

export interface ConsolePack {
  /** Pack position (1-based) from the first column. */
  index: number;
  status: string;
  reading: PackReading;
}

/** `pwr` output → present packs (rows marked Absent or without a voltage are skipped). */
export function parsePwr(text: string): ConsolePack[] {
  const out: ConsolePack[] = [];
  for (const row of parseTable(text, COL.pack)) {
    const status = pick(row, COL.status) ?? '';
    const voltage = volts(pick(row, COL.volt));
    if (/absent/i.test(status) || voltage === undefined) continue;
    const reading: PackReading = {
      voltage,
      current: amps(pick(row, COL.curr)),
      temperature: celsius(pick(row, COL.temp)),
      temperatureMos: celsius(pick(row, COL.mosTemp)),
      soc: num(pick(row, COL.soc)),
      cycles: num(pick(row, COL.cycles)),
    };
    const alarms: string[] = [];
    for (const [names, label] of STATUS_COLUMNS) {
      const st = pick(row, names);
      if (st && !/^(normal|-)$/i.test(st)) alarms.push(`${label} ${st.toLowerCase()}`);
    }
    reading.alarms = alarms;
    out.push({ index: Number(row[Object.keys(row)[0]]), status, reading });
  }
  return out;
}

/** `bat <n>` output → per-cell voltages/temperatures and the pack's remaining charge. */
export function parseBat(text: string): Pick<PackReading, 'cells' | 'cellTemperatures' | 'remainingAh'> {
  const rows = parseTable(text, ['battery', 'bat', 'cell']);
  const cells = rows.map((r) => volts(pick(r, COL.volt))).filter((v): v is number => v !== undefined && v > 0.5 && v < 6);
  const temps = rows.map((r) => celsius(pick(r, COL.temp))).filter((v): v is number => v !== undefined);
  const out: Pick<PackReading, 'cells' | 'cellTemperatures' | 'remainingAh'> = {};
  if (cells.length) out.cells = cells;
  if (temps.length) out.cellTemperatures = temps;
  // Cells are in series: every row shows the same pack charge, e.g. "36088 mAH".
  const mah = rows.map((r) => pick(r, COL.remaining)).find((s) => s && /m?ah$/i.test(s));
  if (mah) out.remainingAh = /mah$/i.test(mah) ? num(mah)! / 1000 : num(mah);
  return out;
}

/** `stat <n>` → cycle count. */
export function parseStat(text: string): number | undefined {
  const m = /cycle\s*times?\s*:\s*(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** `info <n>` → model, firmware, serial. */
export function parseInfo(text: string): Pick<PackReading, 'model' | 'firmware' | 'serial'> {
  const field = (re: RegExp) => re.exec(text)?.[1]?.trim() || undefined;
  return {
    model: field(/device name\s*:\s*(.+)/i),
    firmware: field(/main soft version\s*:\s*(.+)/i) ?? field(/soft(?:ware)?\s*version\s*:\s*(.+)/i),
    serial: field(/barcode\s*:\s*(\S+)/i),
  };
}

// ---- Link ------------------------------------------------------------------------------------

/**
 * A command reply is complete at the "$$" end marker once the line after it (blank line or
 * prompt) has started arriving; a bare prompt also ends it.
 */
export const consoleReader: FrameReader = (buf) => {
  const s = buf.toString('latin1');
  const end = s.indexOf('$$');
  if (end >= 0) {
    const rest = s.slice(end + 2);
    const prompt = rest.indexOf('>');
    if (prompt >= 0) return end + 2 + prompt + 1;
    const blank = /^\s*?\r?\n\s*?\r?\n/.exec(rest) ?? /^\r\r/.exec(rest);
    if (blank) return end + 2 + blank[0].length;
    return 0;
  }
  if (s.length > 1 << 16) return -s.length;
  return 0;
};

const promptReader: FrameReader = (buf) => {
  const i = buf.indexOf(0x3e); // '>'
  return i >= 0 ? i + 1 : buf.length > 4096 ? -buf.length : 0;
};

export class ConsolePort implements PortReader {
  private link: AdaptiveLink;
  private maxPacks: () => number;
  private packs: number[] = [];
  private identity = new Map<number, Partial<PackReading>>();
  private polls = 0;

  constructor(link: AdaptiveLink, maxPacks: () => number = maxPackCount) {
    this.link = link;
    this.maxPacks = maxPacks;
  }

  async run(command: string, timeoutMs = TIMEOUT_MS) {
    const reply = await this.link.request(Buffer.from(`${command}\r`, 'latin1'), consoleReader, { timeoutMs, partial: true });
    return reply.toString('latin1');
  }

  private async awake() {
    try {
      const r = await this.link.request(Buffer.from('\r'), promptReader, { timeoutMs: 800, partial: true });
      return /[>$]/.test(r.toString('latin1'));
    } catch {
      return false;
    }
  }

  async init() {
    await this.link.setBaud(CONSOLE_BAUD);
    if (!(await this.awake())) {
      // Older RJ11 units: protocol mode at 1200 baud until woken.
      log.info(`Pylontech console ${this.link.name}: no prompt, sending wake-up sequence`);
      await this.link.setBaud(1200);
      await this.link.request(Buffer.from(WAKE_FRAME, 'latin1'), promptReader, { timeoutMs: 1000, partial: true }).catch(() => {});
      await this.link.setBaud(CONSOLE_BAUD);
      await this.awake();
    }
    const packs = parsePwr(await this.run('pwr'));
    if (!packs.length) throw new Error(`${this.link.name}: no packs in Pylontech console "pwr" output`);
    this.packs = packs.slice(0, this.maxPacks()).map((p) => p.index);
    for (const n of this.packs) {
      try {
        const id = parseInfo(await this.run(`info ${n}`));
        const cycles = parseStat(await this.run(`stat ${n}`));
        this.identity.set(n, { ...id, cycles });
      } catch {}
    }
    log.info(`Pylontech console ${this.link.name}: ${this.packs.length} pack${this.packs.length === 1 ? '' : 's'} (${this.packs.join(', ')})`);
  }

  async read(): Promise<(Metrics | undefined)[]> {
    const rows = new Map(parsePwr(await this.run('pwr')).map((p) => [p.index, p]));
    const refreshCycles = ++this.polls % 300 === 0;
    const out: (Metrics | undefined)[] = [];
    for (const [i, n] of this.packs.entries()) {
      const p = rows.get(n);
      if (!p) continue;
      const id = this.identity.get(n) ?? {};
      if (refreshCycles) {
        try {
          const c = parseStat(await this.run(`stat ${n}`));
          if (c !== undefined) id.cycles = c;
        } catch {}
      }
      let cells: ReturnType<typeof parseBat> = {};
      try {
        cells = parseBat(await this.run(`bat ${n}`));
      } catch {}
      const r: PackReading = { ...id, ...p.reading, ...cells };
      if (r.cycles === undefined) r.cycles = id.cycles;
      out[i] = packMetrics(r);
    }
    if (out.every((m) => !m)) throw new Error(`${this.link.name}: no packs in "pwr" output`);
    return out;
  }
}

export function createPylontechConsole(connection: string[], factory: LinkFactory = serialLinkFactory, maxPacks?: () => number): BmsDriver {
  const bms = new MultiPortBms(
    connection.slice(0, 1),
    CONSOLE_BAUD,
    (path, baud) => new AdaptiveLink(path, baud, factory),
    (link) => new ConsolePort(link as AdaptiveLink, maxPacks),
  );
  return withInverterCurrent(bms);
}

export const pylontechConsoleDriver: BmsDriverDescriptor = {
  id: 'pylontech',
  name: 'USB PylonTech/Pytes console',
  transport: 'serial',
  defaultBaudRate: CONSOLE_BAUD,
  multiConnection: false,
  create: ({ connections }) => createPylontechConsole(connections),
};
