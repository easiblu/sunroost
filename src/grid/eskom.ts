/**
 * Eskom load-shedding schedules from the community-maintained eskom-calendar project
 * (https://github.com/beyarkay/eskom-calendar). Pure parsing and schedule math only, so it can
 * be unit tested; fetching and caching live in ./index.ts.
 *
 * Two public files are used:
 * - machine_friendly.csv (release asset "latest"): every announced outage, one row per area/slot:
 *   `area_name,start,finsh,stage,source` with ISO-8601 times including the SA offset.
 * - area_metadata.yaml (repo root): which suburbs/municipalities belong to which calendar
 *   ("area"). Used for the area search. Only the few fields we need are parsed.
 */

export const ESKOM_CSV_URL = 'https://github.com/beyarkay/eskom-calendar/releases/download/latest/machine_friendly.csv';
export const ESKOM_AREAS_URL = 'https://raw.githubusercontent.com/beyarkay/eskom-calendar/main/area_metadata.yaml';
export const ESKOM_SOURCE_URL = 'https://github.com/beyarkay/eskom-calendar';

/** One planned outage for an area. Times in ms since epoch. */
export interface Outage {
  area: string;
  start: number;
  end: number;
  stage: number;
  source: string;
}

/** One searchable place: a suburb (name) in a municipality, served by a calendar (area id). */
export interface AreaEntry {
  area: string;
  name: string;
  municipality: string;
  province: string;
}

/** Splits one CSV line, honouring double-quoted fields with "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parses machine_friendly.csv. Rows with unparseable times are skipped. */
export function parseOutagesCsv(text: string): Outage[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iArea = col('area_name', 'area');
  const iStart = col('start');
  const iEnd = col('finsh', 'finish', 'end');
  const iStage = col('stage');
  const iSource = col('source');
  if (iArea < 0 || iStart < 0 || iEnd < 0) throw new Error('Unexpected eskom-calendar CSV header');
  const out: Outage[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const start = Date.parse(f[iStart] ?? '');
    const end = Date.parse(f[iEnd] ?? '');
    const area = (f[iArea] ?? '').trim();
    if (!area || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const stage = Number(f[iStage]);
    out.push({ area, start, end, stage: Number.isFinite(stage) ? stage : 0, source: iSource >= 0 ? (f[iSource] ?? '').trim() : '' });
  }
  return out.sort((a, b) => a.start - b.start);
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** Parses an inline YAML list (`["a","b"]`) or scalar into strings. */
function inlineList(raw: string): string[] {
  const v = raw.trim();
  if (!v.startsWith('[')) return v ? [unquote(v)] : [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Not valid JSON (single quotes etc.): fall back to a plain split.
  }
  return v.slice(1, -1).split(',').map(unquote).filter(Boolean);
}

/**
 * Parses the parts of area_metadata.yaml we need: for every `calendar_name` its `areas` items
 * (province, municipality, name list). Line based, as the file has a fixed, simple layout.
 */
export function parseAreaMetadata(yaml: string): AreaEntry[] {
  const out: AreaEntry[] = [];
  let area = '';
  let province = '';
  let municipality = '';
  // Every calendar is also searchable by its own name ("City of Cape Town Area 12").
  let self: AreaEntry | null = null;
  const flush = (names: string[]) => {
    if (!area) return;
    for (const n of names) if (n) out.push({ area, name: n, municipality, province });
  };
  for (const line of yaml.split(/\r?\n/)) {
    let m = line.match(/^\s*-?\s*calendar_name:\s*(.+?)\s*$/);
    if (m) {
      area = unquote(m[1]).replace(/\.ics$/i, '');
      province = municipality = '';
      self = { area, name: humanName(area), municipality: '', province: '' };
      out.push(self);
      continue;
    }
    // Calendar-level keys are indented without a dash; area items start with "- ".
    const calendarLevel = !/^\s*-/.test(line);
    m = line.match(/^\s*-?\s*province:\s*(.+?)\s*$/);
    if (m) {
      province = unquote(m[1]);
      municipality = '';
      if (calendarLevel && self) self.province = province;
      continue;
    }
    m = line.match(/^\s*-?\s*municipality:\s*(.+?)\s*$/);
    if (m) {
      municipality = unquote(m[1]);
      if (calendarLevel && self) self.municipality = municipality;
      continue;
    }
    // `areas: [{name: a}, {name: "b c"}]` on one line.
    m = line.match(/^\s*areas:\s*\[(.*)\]\s*$/);
    if (m) {
      flush([...m[1].matchAll(/name:\s*("[^"]*"|'[^']*'|[^,}]+)/g)].map((x) => unquote(x[1])));
      continue;
    }
    // Either `name: [list]` / `name: x`, or a flow item `- {name: x}`.
    m = line.match(/^\s*-\s*\{\s*name:\s*(.+?)\s*\}\s*$/) ?? line.match(/^\s*-?\s*name:\s*(.+?)\s*$/);
    if (m) flush(inlineList(m[1]));
  }
  return out;
}

const SMALL = new Set(['of', 'and', 'the', 'in', 'on', 'de', 'van', 'der']);

/** "city-of-cape-town-area-1" → "City of Cape Town Area 1". */
export function humanName(slug: string): string {
  return slug
    .replace(/\.ics$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The outage in progress at `now`, else the next one (for the area's sorted list). */
export function nextOutage(outages: Outage[], now: number): Outage | null {
  let best: Outage | null = null;
  for (const o of outages) {
    if (o.end <= now) continue;
    if (o.start <= now) return o;
    if (!best || o.start < best.start) best = o;
  }
  return best;
}

/** Merges back-to-back slots of the same stage (some schedules split one outage in two). */
export function mergeAdjacent(outages: Outage[]): Outage[] {
  const out: Outage[] = [];
  for (const o of [...outages].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.area === o.area && last.stage === o.stage && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else out.push({ ...o });
  }
  return out;
}

/** Minutes until an outage → "2h 05m", "45m", "now". */
export function fmtIn(ms: number): string {
  if (ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
