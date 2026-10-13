/**
 * Traces: recorded request/response pairs, saved as CSV with the header "Request,Response,Notes".
 * Request and Response cells are hex (spaces allowed); a cell that isn't hex is read as text with
 * \r \n \xNN escapes, so hand-written Voltronic traces like "QPIGS\r" also work.
 *
 * A loaded trace can play a device: `TracePort` answers each request frame it is written with the
 * recorded response, and reports requests it has no answer for as misses.
 */
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseHex, parseText, Splitter, toHex } from './frames.ts';
import type { DiagPort } from './port.ts';

export interface TraceRow {
  request: Buffer;
  response: Buffer;
  notes: string;
}

function csvCell(v: string) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Splits CSV text into rows of cells (RFC 4180 quoting). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const cellBytes = (cell: string) => {
  const t = cell.trim();
  if (!t) return Buffer.alloc(0);
  try {
    return parseHex(t);
  } catch {
    return parseText(t);
  }
};

export function traceFromCsv(text: string): TraceRow[] {
  const rows = parseCsv(text);
  if (rows.length && /^request$/i.test(rows[0][0]?.trim() ?? '')) rows.shift();
  return rows.map((r) => ({ request: cellBytes(r[0] ?? ''), response: cellBytes(r[1] ?? ''), notes: (r[2] ?? '').trim() }));
}

export function traceToCsv(rows: TraceRow[]): string {
  const lines = ['Request,Response,Notes'];
  for (const r of rows) lines.push([toHex(r.request), toHex(r.response), csvCell(r.notes)].join(','));
  return lines.join('\n') + '\n';
}

/** Only plain file names inside the traces directory: "new.csv", "deye-run_2.csv". */
export function safeTraceName(name: string): string {
  const n = basename(String(name ?? '').trim());
  if (!/^[\w.-]{1,80}$/.test(n) || n.startsWith('.')) throw new Error('Use a plain file name (letters, digits, . _ -)');
  return n.endsWith('.csv') ? n : `${n}.csv`;
}

export async function listTraces(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.csv')).sort();
  } catch {
    return [];
  }
}

export async function loadTrace(dir: string, name: string): Promise<TraceRow[]> {
  return traceFromCsv(await readFile(join(dir, safeTraceName(name)), 'utf8'));
}

export async function saveTrace(dir: string, name: string, rows: TraceRow[]) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, safeTraceName(name)), traceToCsv(rows));
}

/** Finds the recorded response for a request (exact bytes first, then ignoring surrounding whitespace). */
export function lookup(rows: TraceRow[], request: Buffer): TraceRow | undefined {
  return (
    rows.find((r) => r.request.equals(request)) ??
    rows.find((r) => r.request.toString('latin1').trim() === request.toString('latin1').trim() && r.request.length > 0)
  );
}

/**
 * The "TRACE - Saved trace file" pseudo-device. Bytes written to it are split into frames by
 * silence (`splitMs`); each frame is looked up and the recorded response comes back as 'data'.
 * Unanswered frames emit 'miss'.
 */
export class TracePort extends EventEmitter implements DiagPort {
  readonly path = 'TRACE';
  isOpen = true;
  rows: () => TraceRow[];
  private splitter: Splitter;

  constructor(rows: () => TraceRow[], splitMs: number) {
    super();
    this.rows = rows;
    this.splitter = new Splitter(splitMs, (frame) => this.answer(frame));
  }

  set splitMs(ms: number) {
    this.splitter.ms = ms;
  }

  async write(data: Buffer) {
    if (!this.isOpen) throw new Error('TRACE: not connected');
    this.splitter.push(Buffer.from(data));
  }

  private answer(frame: Buffer) {
    const row = lookup(this.rows(), frame);
    if (row && row.response.length) setImmediate(() => this.isOpen && this.emit('data', Buffer.from(row.response)));
    else this.emit('miss', frame);
  }

  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.splitter.dispose();
    this.emit('close');
  }
}
