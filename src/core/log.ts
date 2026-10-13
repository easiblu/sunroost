/**
 * Tagged application log. Lines go to stdout, a ring buffer the UI can read,
 * and an append-only file. Tags group lines per subsystem ("mqtt", "automation", "devices", "db" …)
 * so pages can show only the lines relevant to them.
 */
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Level = 'info' | 'warn' | 'error';

export interface LogLine {
  ts: number;
  tag: string;
  level: Level;
  message: string;
}

const MAX_LINES = 2000;

class Log extends EventEmitter {
  private lines: LogLine[] = [];
  private file: string | null = null;

  setFile(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.file = path;
  }

  write(tag: string, level: Level, message: string) {
    const line: LogLine = { ts: Date.now(), tag, level, message };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    const text = `${new Date(line.ts).toISOString()} [${tag}] ${level === 'info' ? '' : level.toUpperCase() + ': '}${message}`;
    (level === 'error' ? console.error : console.log)(text);
    if (this.file) {
      try {
        appendFileSync(this.file, text + '\n');
      } catch {
        // A full or read-only disk must not take the app down.
      }
    }
    this.emit('line', line);
  }

  /** Most recent lines first, optionally filtered by tag. */
  recent(opts: { tag?: string; limit?: number } = {}): LogLine[] {
    const out: LogLine[] = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < (opts.limit ?? 200); i--) {
      if (!opts.tag || this.lines[i].tag === opts.tag) out.push(this.lines[i]);
    }
    return out;
  }
}

export const log = new Log();

/** Returns a logger bound to one tag: `const l = logger('mqtt'); l.info('connected')`. */
export type Logger = ReturnType<typeof logger>;

export function logger(tag: string) {
  return {
    info: (m: string) => log.write(tag, 'info', m),
    warn: (m: string) => log.write(tag, 'warn', m),
    error: (m: string) => log.write(tag, 'error', m),
  };
}
