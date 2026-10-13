// Charts: the history dashboard. A toolbar card (quick ranges, a day picker, custom/absolute ranges,
// zoom out and auto refresh) above a grid of chart cards: Overview full width, the rest two per row.
// Drag across any chart to zoom every chart to that window; the range lives in the URL (?from=&to=).
import { appSettings, html, useEffect, useMemo, useRef, useState, useStore } from '../lib/core.js';
import { fmtUnit } from '../lib/chart.js';
import { GraphPanel, fmtStamp, useHistoryWindow } from '../lib/grafana.js';
import { Ic, IconChip, Page, Segmented } from '../lib/ui.js';

const SIGN = [{ op: 'lt', value: 0, level: 'critical' }, { op: 'gt', value: 0, level: 'ok' }];
const temp = (warn, crit) => [{ op: 'lt', value: warn, level: 'ok' }, { op: 'gt', value: warn, level: 'warning' }, { op: 'gt', value: crit, level: 'critical' }];
const one = (metric, color, unit, label = metric) => [{ metric, label, color, unit }];

/** Chart cards. `full` spans the width; the rest pair up in two columns. */
const PANELS = [
  { title: 'Overview', sub: 'Consumption, grid and solar power', icon: 'activity', tone: 'accent', full: true, legend: true, series: [
    { metric: 'Load power', label: 'Consumption', color: '--load', unit: 'W' },
    { metric: 'Grid power', label: 'Grid', color: '--grid', unit: 'W' },
    { metric: 'PV power', label: 'Solar', color: '--solar', unit: 'W' },
  ] },
  { title: 'Battery power', sub: 'Charging above zero', icon: 'battery-charging', tone: 'battery', series: one('Battery power', '--battery', 'W'), thresholds: SIGN },
  { title: 'Battery state of charge', icon: 'battery-medium', tone: 'battery', series: one('Battery state of charge', '--battery', '%', 'State of charge'), yMin: 0, yMax: 100 },
  { title: 'PV voltage', icon: 'sun', tone: 'solar', series: one('PV voltage 1', '--solar', 'V', 'PV voltage') },
  { title: 'Battery voltage', icon: 'gauge', tone: 'battery', series: one('Battery voltage', '--battery', 'V') },
  { title: 'PV current', icon: 'sun', tone: 'solar', series: one('PV current 1', '--solar', 'A', 'PV current') },
  { title: 'Battery current', icon: 'gauge', tone: 'battery', series: one('Battery current', '--battery', 'A'), thresholds: SIGN },
  { title: 'PV power', icon: 'sun', tone: 'solar', series: one('PV power', '--solar', 'W') },
  { title: 'Battery temperature', icon: 'thermometer', tone: 'battery', series: one('Battery temperature', '--battery', '°C'), thresholds: temp(30, 40), celsius: true },
  { title: 'Inverter temperature', icon: 'thermometer', tone: 'accent', series: one('Temperature', '--accent', '°C', 'Inverter temperature'), thresholds: temp(55, 70), celsius: true },
  { title: 'Grid voltage', icon: 'utility-pole', tone: 'grid', series: one('Grid voltage', '--grid', 'V') },
  { title: 'AC output voltage', icon: 'plug-zap', tone: 'load', series: one('AC output voltage', '--load', 'V') },
  { title: 'Grid frequency', icon: 'audio-waveform', tone: 'grid', series: one('Grid frequency', '--grid', 'Hz') },
  { title: 'Load power', icon: 'house', tone: 'load', series: one('Load power', '--load', 'W') },
  { title: 'Bus voltage', icon: 'cpu', tone: 'accent', series: one('Bus voltage', '--accent', 'V') },
];

/** Model-dependent panels, shown only when the inverter reports them. */
const MPPTS = [1, 2, 3, 4];
const EXTRA = [
  ...MPPTS.flatMap((n) => [
    { title: `MPPT ${n} power`, icon: 'sun', tone: 'solar', series: one(`PV power ${n}`, '--solar', 'W', `MPPT ${n} power`), mppt: true },
    { title: `MPPT ${n} voltage`, icon: 'sun', tone: 'solar', series: one(`PV voltage ${n}`, '--solar', 'V', `MPPT ${n} voltage`), mppt: true },
    { title: `MPPT ${n} current`, icon: 'sun', tone: 'solar', series: one(`PV current ${n}`, '--solar', 'A', `MPPT ${n} current`), mppt: true },
  ]),
  { title: 'Load power essential', icon: 'house', tone: 'load', series: one('Load power essential', '--load', 'W') },
  { title: 'Load power non-essential', icon: 'house', tone: 'load', series: one('Load power non-essential', '--load', 'W') },
  { title: 'Generator power', icon: 'fuel', tone: 'solar', series: one('Generator power', '--solar', 'W') },
  { title: 'Auxiliary load power', icon: 'plug', tone: 'load', series: one('Auxiliary load power', '--load', 'W') },
];

const METRICS = [...new Set([...PANELS, ...EXTRA].flatMap((p) => p.series.map((s) => s.metric)))];

// ---------- Time ranges ("now-24h" expressions) ----------

const PRESETS = [
  { value: 'now-6h', label: '6h' }, { value: 'now-24h', label: '24h' }, { value: 'now-3d', label: '3d' },
  { value: 'now-7d', label: '7d' }, { value: 'now-30d', label: '30d' },
];
const QUICK = [
  ['now-5m', 'now', 'Last 5 minutes'], ['now-15m', 'now', 'Last 15 minutes'], ['now-30m', 'now', 'Last 30 minutes'],
  ['now-1h', 'now', 'Last 1 hour'], ['now-3h', 'now', 'Last 3 hours'], ['now-6h', 'now', 'Last 6 hours'],
  ['now-12h', 'now', 'Last 12 hours'], ['now-24h', 'now', 'Last 24 hours'], ['now-2d', 'now', 'Last 2 days'],
  ['now-3d', 'now', 'Last 3 days'], ['now-7d', 'now', 'Last 7 days'], ['now-30d', 'now', 'Last 30 days'], ['now-90d', 'now', 'Last 90 days'],
  ['now/d', 'now/d', 'Today'], ['now/d', 'now', 'Today so far'], ['now-1d/d', 'now-1d/d', 'Yesterday'],
  ['now/w', 'now', 'This week so far'], ['now/M', 'now', 'This month so far'],
];
const REFRESH = ['Off', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '1d'];
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

function startOf(d, unit) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  if (unit === 'w') x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  if (unit === 'M') x.setDate(1);
  return x;
}
function endOf(d, unit) {
  const s = startOf(d, unit);
  if (unit === 'd') s.setDate(s.getDate() + 1);
  else if (unit === 'w') s.setDate(s.getDate() + 7);
  else s.setMonth(s.getMonth() + 1);
  return new Date(s.getTime() - 1);
}

/** Parses "now", "now-6h", "now/d", "now-1d/d" or "YYYY-MM-DD HH:mm:ss" to ms. Returns null if invalid. */
function parseTime(expr, now, roundUp) {
  const e = String(expr).trim();
  const m = /^now(?:-(\d+)([smhdwM]))?(?:\/([dwM]))?$/.exec(e);
  if (m) {
    let d = new Date(now);
    if (m[1]) {
      if (m[2] === 'M') d.setMonth(d.getMonth() - Number(m[1]));
      else d = new Date(d.getTime() - Number(m[1]) * UNIT_MS[m[2]]);
    }
    if (m[3]) d = roundUp ? endOf(d, m[3]) : startOf(d, m[3]);
    return d.getTime();
  }
  const a = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(e);
  if (a) return new Date(+a[1], +a[2] - 1, +a[3], +(a[4] ?? 0), +(a[5] ?? 0), +(a[6] ?? 0)).getTime();
  if (/^\d{12,}$/.test(e)) return Number(e);
  return null;
}

const stamp = (ms) => fmtStamp(Math.floor(ms / 1000));
const isRelative = (r) => r.to.startsWith('now');
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shortStamp = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function rangeLabel(r) {
  const q = QUICK.find(([f, t]) => f === r.from && t === r.to);
  if (q) return q[2];
  const day = singleDay(r);
  if (day) return new Date(`${day}T00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const show = (x, up) => (x.startsWith('now') ? x : shortStamp(parseTime(x, Date.now(), up)));
  return `${show(r.from, false)} – ${show(r.to, true)}`;
}

/** 'YYYY-MM-DD' when the range is exactly one calendar day, else ''. */
function singleDay(r) {
  if (r.from.startsWith('now') || r.to.startsWith('now')) return '';
  const f = parseTime(r.from, Date.now());
  const t = parseTime(r.to, Date.now(), true);
  if (f === null || t === null) return '';
  const s = startOf(new Date(f), 'd');
  return s.getTime() === f && endOf(s, 'd').getTime() === t ? ymd(s) : '';
}

function initialRange() {
  const q = new URLSearchParams(location.search);
  const from = q.get('from');
  const to = q.get('to');
  if (from && to && parseTime(from, Date.now()) !== null && parseTime(to, Date.now(), true) !== null) return { from, to };
  return { from: 'now-24h', to: 'now' };
}

/** Dropdown: closes on outside click or Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return [open, setOpen, ref];
}

/** Custom range: absolute from/to inputs plus a searchable list of quick ranges. */
function RangePicker({ range, onChange, custom }) {
  const [open, setOpen, ref] = useDropdown();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');
  const toggle = () => {
    if (!open) {
      // Fill the inputs from the current range when the picker opens.
      const show = (x, up) => (x.startsWith('now') ? x : stamp(parseTime(x, Date.now(), up)));
      setFrom(show(range.from, false));
      setTo(show(range.to, true));
      setErr('');
    }
    setOpen(!open);
  };
  const apply = (e) => {
    e.preventDefault();
    const now = Date.now();
    const f = parseTime(from, now);
    const t = parseTime(to, now, true);
    if (f === null || t === null) return setErr('Use "now-6h" or "YYYY-MM-DD HH:mm:ss".');
    if (t <= f) return setErr('"From" must be before "To".');
    const norm = (x, ms) => (x.trim().startsWith('now') ? x.trim() : String(ms));
    onChange({ from: norm(from, f), to: norm(to, t) });
    setOpen(false);
  };
  const quick = QUICK.filter(([, , l]) => l.toLowerCase().includes(search.toLowerCase()));
  return html`<div class="ct-picker" ref=${ref}>
    <button type="button" class=${`btn ct-range ${custom ? 'on' : ''} ${open ? 'open' : ''}`} onClick=${toggle} aria-expanded=${open} title="Custom time range">
      <${Ic} name="calendar-range" size="sm" /><span class="ct-range-text">${rangeLabel(range)}</span><${Ic} name="chevron-down" size="sm" />
    </button>
    ${open &&
    html`<div class="ct-pop card">
      <form class="ct-abs" onSubmit=${apply}>
        <div class="ct-pop-title">Absolute range</div>
        <label class="ct-label">From<input value=${from} onInput=${(e) => setFrom(e.target.value)} /></label>
        <label class="ct-label">To<input value=${to} onInput=${(e) => setTo(e.target.value)} /></label>
        <small class="help">e.g. now-6h, now/d or 2026-10-01 08:00:00</small>
        ${err && html`<div class="ct-err">${err}</div>`}
        <button type="submit" class="btn btn-primary btn-sm ct-apply">Apply range</button>
      </form>
      <div class="ct-quick">
        <input class="ct-search" placeholder="Search quick ranges" value=${search} onInput=${(e) => setSearch(e.target.value)} />
        <ul>
          ${quick.map(([f, t, label]) => html`<li>
            <button type="button" class=${range.from === f && range.to === t ? 'on' : ''} onClick=${() => (onChange({ from: f, to: t }), setOpen(false))}>${label}</button>
          </li>`)}
        </ul>
      </div>
    </div>`}
  </div>`;
}

const hasData = (v) => Array.isArray(v) && v.some((x) => x !== null);
const intervalMs = (r) => (r === 'Off' ? 0 : Number(r.slice(0, -1)) * UNIT_MS[r.slice(-1)]);
const lastValue = (values) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i];
  return null;
};

function ChartCard({ p, xs, from, to, onZoom }) {
  const single = p.series.length === 1 ? p.series[0] : null;
  const last = single ? lastValue(single.values) : null;
  return html`<section class=${`card ct-card ${p.full ? 'ct-full' : ''}`}>
    <header class="ct-head">
      <${IconChip} name=${p.icon} tone=${p.tone} small />
      <div class="ct-title"><h2>${p.title}</h2>${p.sub && html`<p class="muted small">${p.sub}</p>`}</div>
      ${single && last !== null && html`<div class="ct-last"><b>${fmtUnit(last, single.unit)}</b><span>latest</span></div>`}
    </header>
    <div class="ct-plot">
      <${GraphPanel} xs=${xs} from=${from} to=${to} series=${p.series} legend=${p.legend}
        thresholds=${p.thresholds ?? []} yMin=${p.yMin} yMax=${p.yMax} onZoom=${onZoom} />
    </div>
  </section>`;
}

export default function Charts() {
  const settings = useStore(appSettings) ?? {};
  const fahrenheit = settings.temperature_unit === '°F';
  const [range, setRange] = useState(initialRange);
  const [refresh, setRefresh] = useState('1m');
  const [tick, setTick] = useState(0);
  const [spin, setSpin] = useState(false);

  // Keep the range in the URL so a view can be bookmarked.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    q.set('from', range.from);
    q.set('to', range.to);
    history.replaceState(history.state, '', `${location.pathname}?${q}`);
  }, [range.from, range.to]);

  // Auto refresh only moves relative ("now") ranges.
  useEffect(() => {
    const ms = intervalMs(refresh);
    if (!ms || !isRelative(range)) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [refresh, range.from, range.to]);

  const win = useMemo(() => {
    const now = Date.now();
    return { from: parseTime(range.from, now), to: parseTime(range.to, now, true) };
  }, [range.from, range.to, tick]);
  const { data, error } = useHistoryWindow(win, METRICS);

  const zoomOut = () => {
    const span = win.to - win.from;
    const center = win.from + span / 2;
    const to = Math.min(Date.now(), center + span);
    setRange({ from: String(Math.round(to - span * 2)), to: String(Math.round(to)) });
  };
  const onZoom = (fromSec, toSec) => toSec - fromSec >= 10 && setRange({ from: String(fromSec * 1000), to: String(toSec * 1000) });
  const doRefresh = () => {
    setTick((n) => n + 1);
    setSpin(true);
    setTimeout(() => setSpin(false), 700);
  };
  const pickDay = (value) => {
    const f = parseTime(value, Date.now());
    if (f === null) return;
    setRange({ from: String(f), to: String(endOf(new Date(f), 'd').getTime()) });
  };

  const panels = useMemo(() => {
    const series = data?.series ?? {};
    const toF = (v) => (v === null ? null : Math.round((v * 1.8 + 32) * 10) / 10);
    const multiMppt = hasData(series['PV power 2']);
    const extras = EXTRA.filter((p) => (p.mppt ? multiMppt : true) && p.series.some((s) => hasData(series[s.metric])));
    return [...PANELS, ...extras].map((p) => ({
      ...p,
      thresholds: p.thresholds && p.celsius && fahrenheit ? p.thresholds.map((t) => ({ ...t, value: t.value * 1.8 + 32 })) : p.thresholds,
      series: p.series.map((s) => {
        const values = series[s.metric] ?? [];
        return {
          label: s.label, color: s.color, unit: p.celsius && fahrenheit ? '°F' : s.unit,
          values: p.celsius && fahrenheit ? values.map(toF) : values,
        };
      }),
    }));
  }, [data, fahrenheit]);

  const xs = data?.xs ?? [];
  const from = Math.floor(win.from / 1000);
  const to = Math.ceil(win.to / 1000);
  const preset = range.to === 'now' && PRESETS.some((p) => p.value === range.from) ? range.from : null;
  const day = singleDay(range);

  return html`<${Page} title="Charts" wide>
    <div class="card ct-bar">
      <div class="ct-group">
        <${Segmented} value=${preset} options=${PRESETS} onChange=${(v) => setRange({ from: v, to: 'now' })} />
        <label class=${`ct-date ${day ? 'on' : ''}`} title="Show one day">
          <${Ic} name="calendar" size="sm" />
          <input type="date" value=${day} max=${ymd(new Date())} aria-label="Day" onChange=${(e) => e.target.value && pickDay(e.target.value)} />
        </label>
      </div>
      <div class="ct-group ct-right">
        <${RangePicker} range=${range} onChange=${setRange} custom=${!preset && !day} />
        <button type="button" class="btn ct-icon" title="Zoom out" aria-label="Zoom out time range" onClick=${zoomOut}><${Ic} name="zoom-out" size="sm" /></button>
        <div class="ct-refresh">
          <button type="button" class=${`btn ct-icon ${spin ? 'spin' : ''}`} title="Refresh now" aria-label="Refresh charts" onClick=${doRefresh}><${Ic} name="refresh-cw" size="sm" /></button>
          <select aria-label="Auto refresh interval" title="Auto refresh" value=${refresh} onChange=${(e) => setRefresh(e.target.value)}>
            ${REFRESH.map((r) => html`<option value=${r} selected=${r === refresh}>${r === 'Off' ? 'Auto off' : `Every ${r}`}</option>`)}
          </select>
        </div>
      </div>
      <p class="ct-hint muted small"><${Ic} name="info" size="sm" />Drag across a chart to zoom in. Data resolution: ${data?.resolution ? `${data.resolution} s` : '–'}</p>
    </div>
    ${error && html`<div class="notice notice-bad">Couldn't load history: ${error}</div>`}
    <div class="ct-grid">
      ${panels.map((p) => html`<${ChartCard} key=${p.title} p=${p} xs=${xs} from=${from} to=${to} onZoom=${onZoom} />`)}
    </div>
  <//>`;
}

const css = `
.ct-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; padding: 14px 16px; margin-bottom: 16px; position: relative; z-index: 5; }
.ct-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.ct-right { gap: 8px; }
.ct-bar .seg button { padding: 7px 14px; }
.ct-date { display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 4px 0 12px; border-radius: 12px; border: 1px solid #e1e4ea; background: var(--surface); color: var(--muted); cursor: pointer; }
.ct-date.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
.ct-date input { border: 0; background: transparent; padding: 6px 6px 6px 0; width: 140px; box-shadow: none; font-size: 13px; color: var(--text); }
.ct-date input:focus { box-shadow: none; }
.ct-picker { position: relative; min-width: 0; }
.ct-range { max-width: 340px; font-weight: 600; color: var(--text); }
.ct-range .ic { color: var(--muted); }
.ct-range.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
.ct-range.on .ic { color: var(--accent); }
.ct-range-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ct-icon { width: 38px; padding: 0; }
.ct-icon.spin .ic { animation: ctspin .7s ease; }
@keyframes ctspin { to { transform: rotate(360deg); } }
.ct-refresh { display: flex; align-items: center; gap: 6px; }
.ct-refresh select { width: auto; height: 38px; padding-top: 0; padding-bottom: 0; font-size: 13px; font-weight: 600; border-radius: 12px; }
.ct-hint { flex-basis: 100%; margin: -2px 0 0; display: flex; align-items: center; gap: 6px; }
.ct-hint .ic { color: var(--faint); }
.ct-pop { position: absolute; right: 0; top: 46px; z-index: 30; display: flex; width: 560px; max-width: calc(100vw - 32px); padding: 0; box-shadow: var(--shadow-lift); overflow: hidden; }
.ct-abs { flex: 1; padding: 18px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
.ct-pop-title { font-weight: 650; color: var(--heading); }
.ct-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.ct-label input { max-width: none; }
.ct-apply { align-self: flex-start; margin-top: 4px; }
.ct-err { color: var(--bad); font-size: 12px; font-weight: 600; }
.ct-quick { width: 220px; padding: 12px 0 8px; display: flex; flex-direction: column; background: var(--surface-2); }
.ct-search { margin: 0 12px 6px; width: calc(100% - 24px); font-size: 13px; padding: 7px 10px; }
.ct-quick ul { list-style: none; margin: 0; padding: 0 6px; max-height: 330px; overflow-y: auto; }
.ct-quick li button { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.ct-quick li button:hover { background: var(--surface); }
.ct-quick li button.on { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.ct-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ct-card { padding: 18px 18px 14px; display: flex; flex-direction: column; min-width: 0; }
.ct-full { grid-column: 1 / -1; }
.ct-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; min-width: 0; }
.ct-title { flex: 1; min-width: 0; }
.ct-title h2 { font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-title p { margin: 0; }
.ct-last { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; }
.ct-last b { font-size: 15px; color: var(--heading); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct-last span { font-size: 11px; color: var(--muted); }
.ct-plot { height: 230px; min-width: 0; }
.ct-full .ct-plot { height: 360px; }
@media (max-width: 1100px) { .ct-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .ct-bar { padding: 12px; }
  .ct-group, .ct-right { width: 100%; }
  .ct-group .seg { flex: 1 1 100%; } .ct-group .seg button { flex: 1; padding: 7px 0; }
  .ct-date { flex: 1 1 100%; } .ct-date input { width: 100%; }
  .ct-picker { flex: 1 1 100%; } .ct-range { width: 100%; max-width: none; justify-content: flex-start; } .ct-range-text { flex: 1; text-align: left; }
  .ct-refresh { flex: 1; } .ct-refresh select { flex: 1; max-width: none; }
  .ct-pop { position: fixed; left: 16px; right: 16px; top: 120px; width: auto; flex-direction: column-reverse; max-height: calc(100vh - 220px); overflow-y: auto; }
  .ct-quick { width: auto; } .ct-quick ul { max-height: 180px; }
  .ct-abs { border-right: 0; border-top: 1px solid var(--border); }
  .ct-plot { height: 200px; } .ct-full .ct-plot { height: 280px; }
}
`;
let styleEl = document.getElementById('css-charts');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-charts';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css;
