// Dashboard: KPI cards, live power flow, energy usage, weather, battery, live power gauges,
// insights and the last 24 hours. Layout follows the redesign inspirations.
import {
  api, appSettings, batteryRate, fmtPower, fmtTemp, html, live, num, useEffect, useState, useStore,
} from '../lib/core.js';
import { TimeChart } from '../lib/chart.js';
import { Arc, Card, Empty, Ic, IconChip, Kpi, Live, Page, Ring, Segmented, useWidth } from '../lib/ui.js';

const ACTIVE_W = 15;

function usePoll(url, every) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const load = () => api.get(url).then((d) => alive && setData(d), () => {});
    load();
    const t = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);
  return data;
}

const kw = (w) => (num(w) === null ? '–' : Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) : Math.round(w));
const kwUnit = (w) => (num(w) !== null && Math.abs(w) >= 1000 ? 'kW' : 'W');
const kwh = (v, d = 1) => (num(v) === null || !Number.isFinite(v) ? '–' : v.toFixed(d));

// ---------- Power flow (curved lines, animated when power flows) ----------

function FlowPath({ d, watts, toward, cls }) {
  const active = Math.abs(watts ?? 0) >= ACTIVE_W;
  const dur = active ? Math.max(0.5, 2.6 - Math.log10(Math.abs(watts)) * 0.55) : 0;
  return html`<g>
    <path d=${d} class="pf-base" />
    <path d=${d} class=${`pf-line ${cls} ${active ? 'on' : ''} ${active && !toward ? 'rev' : ''}`} style=${active ? `animation-duration:${dur}s` : ''} />
  </g>`;
}

function FlowNode({ x, y, icon, tone, label, value, sub, href }) {
  return html`<foreignObject x=${x - 68} y=${y - 38} width="136" height="76">
    <a href=${href} class="pf-node" xmlns="http://www.w3.org/1999/xhtml">
      <span class=${`chip-ic sm ${tone}`}><${Ic} name=${icon} size="sm" /></span>
      <span class="pf-text"><span class="pf-label">${label}</span><b>${value}</b>${sub && html`<small>${sub}</small>`}</span>
    </a>
  </foreignObject>`;
}

function PowerFlow({ t }) {
  const [ref, width] = useWidth();
  // Narrow cards (phones) get a tighter canvas so labels stay readable instead of shrinking.
  const W = width && width < 520 ? 340 : 460;
  const lx = W === 340 ? 70 : 86;
  const rx = W - lx;
  const cx = W / 2;
  const pv = num(t['PV power']) ?? 0;
  const load = num(t['Load power']) ?? 0;
  const grid = num(t['Grid power']) ?? 0;
  const batt = num(t['Battery power']) ?? 0;
  const soc = num(t['Battery state of charge']);
  const fmt = (w) => `${kw(Math.abs(w))} ${kwUnit(w)}`;
  const state = (w, pos, neg) => (Math.abs(w) < ACTIVE_W ? 'Idle' : w > 0 ? pos : neg);
  const curve = (x0, y0, x1, y1) => `M${x0} ${y0} C ${(x0 + x1) / 2} ${y0}, ${(x0 + x1) / 2} ${y1}, ${x1} ${y1}`;
  return html`<div ref=${ref}><svg viewBox=${`0 0 ${W} 300`} class="pf" role="img" aria-label="Power flow">
    <${FlowPath} d=${curve(lx + 30, 70, cx, 150)} watts=${pv} toward=${true} cls="solar" />
    <${FlowPath} d=${curve(rx - 30, 70, cx, 150)} watts=${grid} toward=${grid > 0} cls="grid" />
    <${FlowPath} d=${curve(cx, 150, lx + 30, 230)} watts=${batt} toward=${batt < 0} cls="battery" />
    <${FlowPath} d=${curve(cx, 150, rx - 30, 230)} watts=${load} toward=${false} cls="load" />
    <g transform=${`translate(${cx} 150)`}>
      <circle r="28" class="pf-hub" />
      <foreignObject x="-12" y="-12" width="24" height="24"><span xmlns="http://www.w3.org/1999/xhtml" class="pf-hub-ic"><${Ic} name="zap" /></span></foreignObject>
    </g>
    <${FlowNode} x=${lx} y=${62} icon="sun" tone="solar" label="Solar" value=${fmt(pv)} href="/inverter/status" />
    <${FlowNode} x=${rx} y=${62} icon="utility-pole" tone="grid" label="Grid" value=${fmt(grid)} sub=${state(grid, 'Importing', 'Exporting')} href="/grid/status" />
    <${FlowNode} x=${lx} y=${238} icon="battery-charging" tone="battery" label=${soc === null ? 'Battery' : `Battery ${Math.round(soc)}%`}
      value=${fmt(batt)} sub=${state(batt, 'Charging', 'Discharging')} href="/battery/status" />
    <${FlowNode} x=${rx} y=${238} icon="house" tone="load" label="Home" value=${fmt(load)} href="/inverter/status" />
  </svg></div>`;
}

// ---------- Smooth area / bar chart (usage) ----------

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

function AreaChart({ labels, series, height = 210, unit = 'kWh', bars }) {
  const [hover, setHover] = useState(null);
  const [ref, width] = useWidth();
  const W = width || 600;
  const H = height;
  const pad = { l: 34, r: 10, t: 12, b: 24 };
  const max = Math.max(0.1, ...series.flatMap((s) => s.values));
  const n = labels.length;
  const x = (i) => pad.l + (n <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(n / 7);
  const slot = (W - pad.l - pad.r) / Math.max(n, 1);
  const bw = Math.max(3, Math.min(22, slot * 0.55));
  return html`<div class="area-wrap" ref=${ref} onMouseLeave=${() => setHover(null)}>
    <svg viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} class="area">
      <defs>${series.map((s) => html`<linearGradient id=${`g-${s.key}`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color=${`var(${s.color})`} stop-opacity="0.3" /><stop offset="1" stop-color=${`var(${s.color})`} stop-opacity="0" /></linearGradient>`)}</defs>
      ${ticks.map((t) => html`<line x1=${pad.l} x2=${W - pad.r} y1=${y(t)} y2=${y(t)} class="area-grid" /><text x=${pad.l - 6} y=${y(t) + 4} class="area-axis" text-anchor="end">${t >= 10 ? Math.round(t) : t.toFixed(1)}</text>`)}
      ${series.map((s) => {
        const pts = s.values.map((v, i) => [x(i), y(v)]);
        if (bars) {
          return pts.map(([px, py], i) => html`<rect x=${px - bw / 2} y=${py} width=${bw} height=${Math.max(0, H - pad.b - py)} rx="5" fill=${`var(${s.color})`} opacity=${hover === null || hover === i ? 1 : 0.45} />`);
        }
        const line = smoothPath(pts);
        return html`<path d=${`${line} L${x(n - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`} fill=${`url(#g-${s.key})`} />
          <path d=${line} fill="none" stroke=${`var(${s.color})`} stroke-width="2.4" />`;
      })}
      ${labels.map((l, i) => i % every === 0 && html`<text x=${x(i)} y=${H - 6} class="area-axis" text-anchor="middle">${l}</text>`)}
      ${!bars && hover !== null && html`<line x1=${x(hover)} x2=${x(hover)} y1=${pad.t} y2=${H - pad.b} class="area-cursor" />
        ${series.map((s) => html`<circle cx=${x(hover)} cy=${y(s.values[hover])} r="4.5" fill="#fff" stroke=${`var(${s.color})`} stroke-width="2.5" />`)}`}
      ${labels.map((_, i) => html`<rect x=${x(i) - slot / 2} y="0" width=${slot} height=${H} fill="transparent" onMouseEnter=${() => setHover(i)} />`)}
    </svg>
    ${hover !== null &&
    html`<div class="area-tip" style=${`left:${Math.min(85, Math.max(15, (x(hover) / W) * 100))}%`}>
      <b>${labels[hover]}</b>${series.map((s) => html`<span><i style=${`background:var(${s.color})`}></i>${s.label} ${s.values[hover].toFixed(2)} ${unit}</span>`)}
    </div>`}
  </div>`;
}

// ---------- Cards ----------

function UsageCard() {
  const [range, setRange] = useState('day');
  const data = usePoll(`/api/dashboard/usage?range=${range}`, 5 * 60_000);
  const total = data ? data.load.reduce((a, b) => a + b, 0) : null;
  const done = data ? data.load.slice(0, range === 'day' ? Math.max(1, data.load.length - 1) : data.load.length) : [];
  const peakIdx = done.length ? done.indexOf(Math.max(...done)) : -1;
  const lowIdx = done.length ? done.indexOf(Math.min(...done)) : -1;
  return html`<${Card} class="dash-usage" title="Energy usage" actions=${html`<${Segmented} value=${range} onChange=${setRange}
      options=${[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />`}>
    <div class="usage-head">
      <div>
        <span class="kpi-value">${kwh(total)}<small>kWh</small></span>
        <div class="muted small">Total consumption ${range === 'day' ? 'today' : range === 'week' ? 'last 7 days' : 'last 30 days'}</div>
      </div>
      <div class="legend-dots"><span style="--c:var(--load)">Consumption</span>${range === 'day' && html`<span style="--c:var(--solar)">Solar</span>`}</div>
    </div>
    ${data
      ? html`<${AreaChart} labels=${data.labels} bars=${range !== 'day'} series=${[
          { key: 'load', label: 'Consumption', color: '--load', values: data.load },
          ...(range === 'day' ? [{ key: 'pv', label: 'Solar', color: '--solar', values: data.pv }] : []),
        ]} />`
      : html`<div class="loading">Loading…</div>`}
    ${data && done.length > 0 &&
    html`<div class="mini-stats">
      <div><span>Average</span><b>${kwh(total / Math.max(1, data.load.length), 2)} kWh</b><small>per ${range === 'day' ? 'hour' : 'day'}</small></div>
      <div><span>Peak</span><b>${kwh(done[peakIdx], 2)} kWh</b><small>${data.labels[peakIdx] ?? ''}</small></div>
      <div><span>Lowest</span><b>${kwh(done[lowIdx], 2)} kWh</b><small>${data.labels[lowIdx] ?? ''}</small></div>
    </div>`}
  <//>`;
}

function WeatherCard() {
  const w = usePoll('/api/weather', 10 * 60_000);
  const unit = appSettings.get()?.temperature_unit ?? '°C';
  const deg = (c) => (unit === '°F' ? Math.round(c * 1.8 + 32) : Math.round(c));
  if (!w) return html`<${Card} class="dash-weather" title="Weather"><div class="loading">Loading…</div><//>`;
  if (!w.configured) {
    return html`<${Card} class="dash-weather" title="Weather">
      <div class="wx-empty"><span class="wx-icon"><${Ic} name="cloud-sun" /></span>
        <p>Set your location to see the forecast and tomorrow's solar outlook.</p>
        <a class="btn btn-sm" href="/configuration">Set location</a></div>
    <//>`;
  }
  if (!w.weather) return html`<${Card} class="dash-weather" title="Weather"><${Empty}>${w.error ?? 'Weather unavailable right now.'}<//><//>`;
  const cur = w.weather.current;
  const today = w.weather.daily[0];
  const tomorrow = w.weather.daily[1];
  const outlook = tomorrow && today?.radiationMj > 0 ? Math.round((tomorrow.radiationMj / today.radiationMj - 1) * 100) : null;
  return html`<${Card} class="dash-weather">
    <div class="wx-top">
      <span class="wx-icon"><${Ic} name=${w.icon} /></span>
      <div class="wx-now"><b>${cur.text}</b><span class="muted small">${w.weather.location || 'Forecast'}</span></div>
      <div class="wx-temp"><b>${deg(cur.temperature)}°</b><span class="muted small">${deg(today.min)}° / ${deg(today.max)}°</span></div>
    </div>
    <div class="wx-hours">
      ${w.weather.hourly.filter((_, i) => i % 2 === 0).slice(0, 6).map(
        (h, i) => html`<div><span>${h.time.slice(11, 16)}</span><${Ic} name=${w.hourlyIcons[i * 2]} /><b>${deg(h.temperature)}°</b></div>`,
      )}
    </div>
    ${outlook !== null &&
    html`<div class="wx-outlook"><${Ic} name=${outlook >= -10 ? 'sun' : 'cloud-sun'} size="sm" />${
      outlook > 50 ? 'Tomorrow looks much sunnier than today' : outlook > 10 ? 'Tomorrow looks sunnier than today'
      : outlook < -50 ? 'Tomorrow looks much cloudier than today' : outlook < -10 ? 'Tomorrow looks cloudier than today'
      : 'Similar sunshine expected tomorrow'}</div>`}
  <//>`;
}

function BatteryCard({ t, s }) {
  const soc = num(t['Battery state of charge']);
  const w = num(t['Battery power']);
  const v = num(t['Battery voltage']);
  const capacity = s['bms.capacity'];
  const rate = batteryRate(w, capacity);
  const remaining = soc !== null && capacity ? (soc / 100) * capacity : null;
  let eta = null;
  if (soc !== null && w !== null && capacity && Math.abs(w) > 50) {
    const h = w > 0 ? (((100 - soc) / 100) * capacity * 1000) / w : ((soc / 100) * capacity * 1000) / -w;
    if (h < 48) eta = `${Math.floor(h)} h ${Math.round((h % 1) * 60)} m`;
  }
  const charging = (w ?? 0) > ACTIVE_W;
  const discharging = (w ?? 0) < -ACTIVE_W;
  const color = soc === null ? 'var(--surface-3)' : soc < 20 ? 'var(--bad)' : soc < 40 ? 'var(--warn)' : 'var(--battery)';
  const row = (icon, label, value) =>
    html`<div class="list-item"><${IconChip} name=${icon} tone="battery" small /><div class="list-main"><div class="list-sub">${label}</div><div class="list-title">${value}</div></div></div>`;
  return html`<${Card} class="dash-battery" title="Battery status" actions=${html`<a href="/battery/status" class="small">Details</a>`}>
    <div class="batt">
      <${Ring} value=${soc ?? 0} color=${color} label=${soc === null ? '–' : `${Math.round(soc)}%`} sub=${rate === null || Math.abs(rate) < 0.2 ? (charging ? 'Charging' : discharging ? 'Discharging' : 'Idle') : `${rate > 0 ? '+' : ''}${rate.toFixed(1)} %/h`} />
      <div class="list">
        ${row('zap', charging ? 'Charging' : discharging ? 'Discharging' : 'Power', w === null ? '–' : fmtPower(Math.abs(w)))}
        ${row('battery-medium', 'Remaining', remaining === null ? '–' : `${remaining.toFixed(1)} kWh`)}
        ${row('timer', charging ? 'Time to full' : 'Time to empty', eta ?? '–')}
        ${row('gauge', 'Voltage', v === null ? '–' : `${v.toFixed(1)} V`)}
      </div>
    </div>
  <//>`;
}

function LivePowerCard({ t, s, inv }) {
  const pct = (v, max) => (num(v) === null || !max ? 0 : (Math.abs(v) / max) * 100);
  const loadMax = Number(inv['Max AC output power']) || s.max_grid_power;
  const loadPct = num(t['Load percentage']) ?? pct(t['Load power'], loadMax);
  const battW = num(t['Battery power']);
  const items = [
    ['Load', loadPct, 'var(--load)', t['Load power']],
    ['Solar', pct(t['PV power'], s.max_pv_power), 'var(--solar)', t['PV power']],
    ['Grid', pct(t['Grid power'], s.max_grid_power), 'var(--grid)', t['Grid power']],
    ['Battery', pct(battW, s.max_battery_power), battW < 0 ? 'var(--bad)' : 'var(--battery)', battW],
  ];
  return html`<${Card} class="dash-live" title="Live power" actions=${html`<${Live} />`}>
    <div class="live-arcs">
      ${items.map(([label, p, color, w]) => html`<${Arc} pct=${p} color=${color} value=${html`${kw(w)}<small> ${kwUnit(w)}</small>`} label=${label} />`)}
    </div>
  <//>`;
}

function InsightsCard({ summary }) {
  const tone = { ok: 'battery', info: 'load', warn: 'accent' };
  return html`<${Card} class="dash-insights" title="Insights" subtitle="From your system's own data">
    ${!summary
      ? html`<div class="loading">Loading…</div>`
      : summary.insights.length === 0
        ? html`<${Empty}>Insights appear once there's some history.<//>`
        : html`<div class="list">${summary.insights.map(
            (i) => html`<div class="list-item"><${IconChip} name=${i.icon} tone=${tone[i.tone]} small /><div class="list-main insight-text">${i.text}</div></div>`,
          )}</div>`}
  <//>`;
}

function HistoryCard() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const metrics = ['PV power', 'Load power', 'Grid power', 'Battery state of charge'];
    const load = () =>
      api.get(`/api/history?hours=24&metrics=${encodeURIComponent(metrics.join(','))}`).then(
        (d) => alive && setData(d),
        () => alive && setData({ xs: [], series: {} }),
      );
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const ser = data?.series ?? {};
  return html`<${Card} class="dash-history" title="Power & energy" subtitle="Last 24 hours" actions=${html`<a href="/charts" class="small">All charts</a>`}>
    ${data?.xs?.length
      ? html`<${TimeChart} xs=${data.xs} height=${260} scales=${{ '%': { range: [0, 100] } }} series=${[
          { label: 'Solar', values: ser['PV power'] ?? [], color: '--solar', fill: '30' },
          { label: 'Consumption', values: ser['Load power'] ?? [], color: '--load' },
          { label: 'Grid', values: ser['Grid power'] ?? [], color: '--grid' },
          { label: 'Battery', values: ser['Battery state of charge'] ?? [], color: '--battery', scale: '%', unit: '%', dash: [5, 4] },
        ]} />`
      : html`<${Empty}>History builds up as data is collected.<//>`}
  <//>`;
}

/** Device power readings now and today (smart plugs and meters), plus the rest of the house. */
function LoadsCard() {
  const d = usePoll('/api/home/loads', 30_000);
  const loads = (d?.loads ?? []).filter((l) => l.w !== null || l.kwhToday > 0);
  if (!loads.length) return null;
  const known = loads.reduce((s, l) => s + Math.max(0, l.w ?? 0), 0);
  const rest = num(d.loadW) === null ? null : Math.max(0, d.loadW - known);
  const total = Math.max(1, d.loadW ?? known);
  const rows = [...loads.slice(0, 6).map((l) => ({ name: l.device && !l.name.startsWith(l.device) ? `${l.device}` : l.name.replace(/ power$/i, ''), w: l.w ?? 0, kwh: l.kwhToday })),
    ...(rest !== null ? [{ name: 'Rest of the house', w: rest, kwh: null, rest: true }] : [])];
  return html`<${Card} class="dash-loads" title="Where your power goes" subtitle="Devices that report their power" actions=${html`<a href="/devices" class="small">Devices</a>`}>
    <div class="loads">${rows.map((r) => html`<div class=${`load-row ${r.rest ? 'rest' : ''}`}>
      <div class="load-top"><span>${r.name}</span><b>${fmtPower(r.w)}</b></div>
      <div class="load-bar"><i style=${`width:${Math.min(100, (r.w / total) * 100)}%`}></i></div>
      ${r.kwh !== null && html`<small class="muted">${r.kwh.toFixed(2)} kWh today</small>`}
    </div>`)}</div>
  <//>`;
}

export default function Dashboard() {
  const snap = useStore(live);
  const s = useStore(appSettings) ?? {};
  const summary = usePoll('/api/dashboard/summary', 60_000);
  if (!snap) return html`<${Page} title="Dashboard"><div class="loading">Connecting…</div><//>`;
  const t = snap.totals ?? {};
  const inv = snap.inverters?.[0] ?? {};
  const soc = num(t['Battery state of charge']);
  const battW = num(t['Battery power']);
  const today = summary?.today ?? snap.energy;
  const chg = summary?.change ?? {};
  const statusOk = snap.status.inverter.name === 'connected';

  return html`<${Page} title="Dashboard" wide>
    ${Object.keys(t).length === 0 &&
    html`<div class="notice notice-info">No live data yet: ${snap.status.inverter.message}. Check <a href="/configuration">Configuration</a>.</div>`}
    <div class="kpis">
      <${Kpi} icon="zap" tone="load" label="Current consumption" value=${kw(t['Load power'])} unit=${kwUnit(t['Load power'])}
        sub=${summary?.load ? `Avg ${summary.load.avgKw.toFixed(2)} kW today` : ''} href="/inverter/status" />
      <${Kpi} icon="sun" tone="solar" label="Solar today" value=${kwh(today?.pv)} unit="kWh" delta=${chg.pv} href="/totals" />
      <${Kpi} icon="battery-charging" tone="battery" label="Battery" value=${soc === null ? '–' : Math.round(soc)} unit="%"
        sub=${battW === null ? '' : Math.abs(battW) < ACTIVE_W ? 'Idle' : `${battW > 0 ? 'Charging' : 'Discharging'} ${fmtPower(Math.abs(battW))}`} href="/battery/status" />
      <${Kpi} icon="utility-pole" tone="grid" label="Grid used today" value=${kwh(today?.gridImport)} unit="kWh" delta=${chg.gridImport} invert href="/grid/status" />
      ${summary?.cost
        ? html`<${Kpi} icon="wallet" tone="accent" label="Today's cost" value=${summary.cost.today.toFixed(2)} unit=${summary.cost.currency} delta=${chg.cost} invert href="/totals" />`
        : html`<${Kpi} icon="house" tone="accent" label="Self-sufficiency" value=${summary?.selfSufficiency ?? '–'} unit="%" sub="Usage covered without the grid" href="/totals" />`}
      <${Kpi} icon="leaf" tone="battery" label="CO₂ saved today" value=${summary ? summary.co2SavedKg.toFixed(1) : '–'} unit="kg" sub="vs grid electricity" />
    </div>

    <div class="dash-grid">
      <${Card} class="dash-flow" title="Energy flow" actions=${html`<${Live} ok=${statusOk}>${statusOk ? (t['Device mode'] ?? 'Live') : snap.status.inverter.message}<//>`}>
        <${PowerFlow} t=${t} />
        <div class="flow-foot">
          <span><${Ic} name="sprout" size="sm" />${summary?.selfSufficiency !== null && summary?.selfSufficiency !== undefined ? `${summary.selfSufficiency}% self-powered today` : 'Live view of where your power goes'}</span>
          <span class="muted">Inverter ${fmtTemp(num(t['Temperature']))}</span>
        </div>
      <//>
      <${UsageCard} />
      <${WeatherCard} />
      <${BatteryCard} t=${t} s=${s} />
      <${LivePowerCard} t=${t} s=${s} inv=${inv} />
      <${InsightsCard} summary=${summary} />
      <${HistoryCard} />
      <${LoadsCard} />
    </div>
  <//>`;
}

const css = `
.kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.kpis .card { padding: 18px; }
@media (max-width: 1560px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .kpis .card { padding: 14px; } .kpis .kpi { flex-direction: column; gap: 10px; } .kpis .kpi-value { font-size: 22px; }
}
.dash-grid { display: grid; gap: 16px; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-template-areas:
  "flow flow flow flow flow usage usage usage usage weather weather weather"
  "batt batt batt batt live live live live ins ins ins ins"
  "hist hist hist hist hist hist hist hist hist hist hist hist"; }
.dash-flow { grid-area: flow; } .dash-usage { grid-area: usage; } .dash-weather { grid-area: weather; }
.dash-battery { grid-area: batt; } .dash-live { grid-area: live; } .dash-insights { grid-area: ins; } .dash-history { grid-area: hist; }
@media (max-width: 1400px) { .dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: "flow usage" "weather batt" "live ins" "hist hist"; } }
@media (max-width: 860px) { .dash-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "flow" "batt" "usage" "live" "weather" "ins" "hist"; } }

.pf { width: 100%; display: block; max-height: 340px; }
.pf-base { fill: none; stroke: var(--surface-3); stroke-width: 6; stroke-linecap: round; }
.pf-line { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-dasharray: 2 11; opacity: 0; }
.pf-line.on { opacity: 1; animation: pfflow 1s linear infinite; }
.pf-line.on.rev { animation-direction: reverse; }
.pf-line.solar { stroke: var(--solar); } .pf-line.grid { stroke: var(--grid); } .pf-line.battery { stroke: var(--battery); } .pf-line.load { stroke: var(--load); }
@keyframes pfflow { to { stroke-dashoffset: -26; } }
@media (prefers-reduced-motion: reduce) { .pf-line.on { animation: none; } }
body.kiosk .pf-line.on { animation: none; }
.pf-hub { fill: var(--heading); }
.pf-hub-ic { display: grid; place-items: center; width: 24px; height: 24px; color: #fff; }
.pf-node { display: flex; align-items: center; gap: 8px; height: 100%; padding: 10px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border);
  box-shadow: var(--shadow); color: var(--text); text-decoration: none; font-family: var(--font); box-sizing: border-box; }
.pf-node:hover { box-shadow: var(--shadow-lift); text-decoration: none; }
.pf-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.pf-label { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-text b { font-size: 14px; color: var(--heading); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pf-text small { font-size: 10.5px; color: var(--muted); }
.flow-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; font-size: 12.5px; color: var(--ok-text); font-weight: 600; flex-wrap: wrap; }
.flow-foot span { display: inline-flex; align-items: center; gap: 6px; }

.usage-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.area-wrap { position: relative; }
.area { width: 100%; height: auto; display: block; overflow: visible; }
.area-grid { stroke: var(--grid-line); }
.area-axis { fill: var(--muted); font-size: 11px; font-family: var(--font); }
.area-cursor { stroke: var(--faint); stroke-dasharray: 3 3; }
.area-tip { position: absolute; top: -6px; transform: translateX(-50%); background: var(--heading); color: #fff; font-size: 11.5px; padding: 7px 10px; border-radius: 10px;
  pointer-events: none; display: flex; flex-direction: column; gap: 2px; white-space: nowrap; box-shadow: var(--shadow-lift); }
.area-tip i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.mini-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 12px; }
.mini-stats div { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
.mini-stats span { font-size: 11.5px; color: var(--muted); }
.mini-stats b { font-size: 15px; color: var(--heading); font-variant-numeric: tabular-nums; }
.mini-stats small { font-size: 11px; color: var(--muted); }

.wx-top { display: flex; align-items: center; gap: 12px; }
.wx-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 16px; background: var(--accent-soft); color: var(--accent); flex: none; }
.wx-icon .ic { width: 28px; height: 28px; }
.wx-now { flex: 1; display: flex; flex-direction: column; min-width: 0; } .wx-now b { font-size: 17px; color: var(--heading); }
.wx-temp { text-align: right; display: flex; flex-direction: column; } .wx-temp b { font-size: 32px; font-weight: 750; color: var(--heading); letter-spacing: -0.03em; line-height: 1; }
.wx-hours { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-top: 18px; }
.wx-hours div { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0; border-radius: 12px; background: var(--surface-2); color: var(--muted); font-size: 11.5px; }
.wx-hours b { color: var(--heading); font-size: 13.5px; }
.wx-outlook { margin-top: 14px; display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--accent-text); background: var(--accent-soft); padding: 9px 12px; border-radius: 12px; }
.wx-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 12px 0; color: var(--muted); }

.batt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px; align-items: center; }
.batt .list-item { padding: 7px 0; }
@media (max-width: 460px) { .batt { grid-template-columns: 1fr; justify-items: center; } .batt .list { width: 100%; } }
.live-arcs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; }
.live-arcs .arc-value { font-size: 22px; } .live-arcs .arc-value small { font-size: 12px; color: var(--muted); font-weight: 600; }
.dash-loads { grid-column: 1 / -1; }
.loads { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px 20px; }
.load-row { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.load-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.load-top span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--heading); font-weight: 600; }
.load-top b { font-variant-numeric: tabular-nums; color: var(--heading); }
.load-bar { height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
.load-bar i { display: block; height: 100%; background: var(--load); border-radius: 4px; }
.load-row.rest .load-bar i { background: var(--faint); }
.insight-text { white-space: normal; font-size: 13.5px; line-height: 1.45; }
`;
let styleEl = document.getElementById('css-dashboard');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-dashboard';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css;
