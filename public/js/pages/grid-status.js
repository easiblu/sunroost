// Grid status: KPI cards (power, voltage, frequency, provider), the grid provider's readings, and
// either the day-ahead price chart + table (price providers) or the planned outage timeline
// (Eskom load-shedding via eskom-calendar).
import { api, appSettings, html, live, num, useEffect, useState, useStore } from '../lib/core.js';
import '../lib/chart.js'; // tooltip styles (.ch-tip)
import { Badge, Ic, IconChip, Kpi, Page, useWidth } from '../lib/ui.js';
import { display, has, injectCss, MetricRows } from './inverter-status.js';

/** Combined grid readings: lowest/average/highest when reported, phases otherwise. */
function gridValues(t, name) {
  const lha = display(t, name, 'lha');
  return lha.length > 1 ? lha : display(t, name, 'phase');
}

const text = (s) => (s === null || s === undefined || s === '' ? [] : [{ text: String(s), label: '', color: '' }]);

function fmtPrice(v, digits) {
  if (num(v) === null) return '–';
  return v.toFixed(digits ?? (Math.abs(v) < 1 ? 4 : 2));
}

const tzFmt = (tz, opts) => {
  try {
    return new Intl.DateTimeFormat([], { timeZone: tz, ...opts });
  } catch {
    return new Intl.DateTimeFormat([], opts);
  }
};

/** Date / day / time formatters in the configured time zone. */
function formatters(tz) {
  const date = tzFmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const ymd = (ts) => {
    const p = Object.fromEntries(date.formatToParts(ts).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  return {
    ymd,
    day: tzFmt(tz, { weekday: 'long' }),
    short: tzFmt(tz, { weekday: 'short' }),
    time: tzFmt(tz, { hour: '2-digit', minute: '2-digit', hour12: false }),
    hour: tzFmt(tz, { hour: '2-digit', hour12: false }),
  };
}

/** Price tier by thirds of the visible price range. */
function tierOf(prices) {
  const vals = prices.map((p) => p.price);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  return (p) => ((p - lo) / span < 1 / 3 ? 'cheap' : (p - lo) / span > 2 / 3 ? 'dear' : 'mid');
}
const TIER_COLOR = { cheap: 'var(--ok)', mid: 'var(--solar)', dear: 'var(--bad)' };

/** Day-ahead price bars, coloured cheap / mid / expensive, with a "now" marker and hover tooltip. */
function PriceChart({ prices, unit, dg, f }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 230;
  if (!width) return html`<div class="pc" ref=${ref} style=${`height:${H}px`}></div>`;
  const pad = { l: 46, r: 6, t: 22, b: 34 };
  const vals = prices.map((p) => p.price);
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => pad.t + ((max - v) / span) * (H - pad.t - pad.b);
  const n = prices.length;
  const slot = (width - pad.l - pad.r) / n;
  const bw = Math.max(2, slot * 0.72);
  const x = (i) => pad.l + slot * i;
  const tier = tierOf(prices);
  const now = Date.now();
  const nowIdx = prices.findIndex((p) => p.start <= now && now < p.end);
  const nowX = nowIdx >= 0 ? x(nowIdx) + ((now - prices[nowIdx].start) / (prices[nowIdx].end - prices[nowIdx].start)) * slot : null;
  const ticks = [max, (max + min) / 2, min].filter((v, i, a) => a.indexOf(v) === i);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(width / 46))));
  const hourly = prices.length > 1 ? Math.round((prices[1].start - prices[0].start) / 3_600_000 * 4) / 4 : 1;
  const step = Math.max(labelEvery, Math.round(3 / (hourly || 1)));
  const hp = hover === null ? null : prices[hover];
  const tipX = hover === null ? 0 : x(hover) + slot / 2;
  return html`<div class="pc" ref=${ref} onMouseLeave=${() => setHover(null)}>
    <svg width=${width} height=${H} role="img" aria-label="Day-ahead prices">
      ${ticks.map((t) => html`<line x1=${pad.l} x2=${width - pad.r} y1=${y(t)} y2=${y(t)} class="pc-grid" />
        <text x=${pad.l - 8} y=${y(t) + 4} text-anchor="end" class="pc-axis">${fmtPrice(t, dg)}</text>`)}
      ${min < 0 && html`<line x1=${pad.l} x2=${width - pad.r} y1=${y(0)} y2=${y(0)} class="pc-zero" />`}
      ${prices.map((p, i) => {
        const top = Math.min(y(p.price), y(0));
        const h = Math.max(1.5, Math.abs(y(p.price) - y(0)));
        const past = p.end <= now;
        return html`<rect x=${x(i) + (slot - bw) / 2} y=${top} width=${bw} height=${h} rx=${Math.min(4, bw / 2)}
          fill=${TIER_COLOR[tier(p.price)]} opacity=${hover !== null ? (hover === i ? 1 : 0.45) : past ? 0.35 : i === nowIdx ? 1 : 0.8} />`;
      })}
      ${prices.map((p, i) => {
        const newDay = i > 0 && f.ymd(p.start) !== f.ymd(prices[i - 1].start);
        return html`${newDay && html`<line x1=${x(i)} x2=${x(i)} y1=${pad.t - 10} y2=${H - pad.b + 4} class="pc-day" />
            <text x=${x(i) + 4} y=${pad.t - 10} class="pc-axis pc-dayname">${f.short.format(p.start)}</text>`}
          ${i % step === 0 && html`<text x=${x(i) + slot / 2} y=${H - pad.b + 18} text-anchor="middle" class="pc-axis">${f.time.format(p.start)}</text>`}`;
      })}
      ${i0DayLabel(prices, f, x, pad)}
      ${nowX !== null && html`<line x1=${nowX} x2=${nowX} y1=${pad.t - 4} y2=${H - pad.b} class="pc-now" />
        <rect x=${nowX - 18} y=${H - pad.b + 24} width="36" height="16" rx="8" class="pc-now-pill" />
        <text x=${nowX} y=${H - pad.b + 35.5} text-anchor="middle" class="pc-now-text">Now</text>`}
      ${prices.map((_, i) => html`<rect x=${x(i)} y="0" width=${slot} height=${H} fill="transparent" onMouseEnter=${() => setHover(i)} />`)}
    </svg>
    ${hp && html`<div class="ch-tip ch-tip-svg" style=${`left:${tipX}px;transform:translateX(${tipX > width * 0.6 ? 'calc(-100% - 12px)' : '12px'})`}>
      <div class="ch-tip-head">${f.short.format(hp.start)} ${f.time.format(hp.start)}–${f.time.format(hp.end)}</div>
      <div class="ch-tip-row"><i style=${`background:${TIER_COLOR[tier(hp.price)]}`}></i><span>Price</span><b>${fmtPrice(hp.price, dg)} ${unit}</b></div>
      <div class="ch-tip-row"><i style="background:transparent"></i><span>Premium</span><b>${hp.premium > 0 ? '+' : ''}${fmtPrice(hp.premium, dg)}</b></div>
    </div>`}
  </div>`;
}

/** First day's name at the left edge. */
const i0DayLabel = (prices, f, x, pad) => (prices.length ? html`<text x=${x(0) + 2} y=${pad.t - 10} class="pc-axis pc-dayname">${f.short.format(prices[0].start)}</text>` : null);

function Prices({ data, tz }) {
  const f = formatters(tz);
  const prices = data.prices;
  const dg = prices.length && Math.max(...prices.map((p) => Math.abs(p.price))) < 1 ? 4 : 2;
  const now = Date.now();
  const cur = prices.find((p) => p.start <= now && now < p.end);
  const upcoming = prices.filter((p) => p.end > now);
  const pick = (list, cmp) => (list.length ? list.reduce((a, b) => (cmp(b.price, a.price) ? b : a)) : null);
  const low = pick(upcoming, (a, b) => a < b);
  const high = pick(upcoming, (a, b) => a > b);
  const avg = prices.length ? prices.reduce((a, p) => a + p.price, 0) / prices.length : null;
  const when = (p) => (p ? `${f.short.format(p.start)} ${f.time.format(p.start)}` : '');
  return html`<section class="card gs-prices">
    <header class="card-head">
      <div class="sa-title"><${IconChip} name="coins" tone="accent" small /><div><h2>Day-ahead prices</h2>
        <p class="muted small">${data.providerName ?? ''}${data.area ? ` · ${data.area}` : ''} · ${data.unit}</p></div></div>
      <div class="legend-dots"><span style="--c:var(--ok)">Cheap</span><span style="--c:var(--solar)">Average</span><span style="--c:var(--bad)">Expensive</span></div>
    </header>
    ${data.error && html`<div class="notice notice-warn">${data.error}</div>`}
    ${prices.length > 0
      ? html`<div class="mini-stats gs-stats">
          <div class="now"><span>Now</span><b>${cur ? fmtPrice(cur.price, dg) : '–'}</b><small>${cur ? `${f.time.format(cur.start)}–${f.time.format(cur.end)}` : 'No price for this hour'}</small></div>
          <div><span>Lowest ahead</span><b class="text-ok">${low ? fmtPrice(low.price, dg) : '–'}</b><small>${when(low)}</small></div>
          <div><span>Highest ahead</span><b class="text-bad">${high ? fmtPrice(high.price, dg) : '–'}</b><small>${when(high)}</small></div>
          <div><span>Average</span><b>${avg === null ? '–' : fmtPrice(avg, dg)}</b><small>${prices.length} slots</small></div>
        </div>
        <${PriceChart} prices=${prices} unit=${data.unit} dg=${dg} f=${f} />
        <details class="gs-more">
          <summary><${Ic} name="chevron-down" size="sm" />Price table</summary>
          <div class="table-wrap gs-table">
            <table class="table">
              <thead><tr><th class="hide-sm">Date</th><th>Day</th><th>Start</th><th class="hide-sm">End</th><th>Price</th><th>Premium</th></tr></thead>
              <tbody>${prices.map((p) => html`<tr class=${p.start <= now && now < p.end ? 'active' : p.end <= now ? 'gs-past' : ''}>
                <td class="hide-sm">${f.ymd(p.start)}</td>
                <td>${f.day.format(p.start)}</td>
                <td>${f.time.format(p.start)}</td>
                <td class="hide-sm">${f.time.format(p.end)}</td>
                <td>${fmtPrice(p.price, dg)} <small class="muted">${data.unit}</small></td>
                <td><span class=${`badge ${p.premium <= 0 ? 'badge-ok' : 'badge-bad'}`}>${p.premium > 0 ? '+' : ''}${fmtPrice(p.premium, dg)}</span></td>
              </tr>`)}</tbody>
            </table>
          </div>
        </details>`
      : html`<div class="empty"><${Ic} name="coins" /><p>${data.error ? 'No cached prices yet.' : 'Fetching prices…'}</p></div>`}
    <p class="muted small gs-foot">Premium = how far each hour's price is from the day's average.${data.source ? ` Source: ${data.source}.` : ''}</p>
  </section>`;
}

function Outages({ data, tz }) {
  const f = formatters(tz);
  const now = Date.now();
  const head = html`<header class="card-head">
    <div class="sa-title"><${IconChip} name="zap-off" tone="bad" small /><div><h2>Planned grid outages</h2>
      <p class="muted small">${data.areaName ?? 'Eskom load-shedding'}</p></div></div>
  </header>`;
  if (!data.area) {
    return html`<section class="card gs-prices">${head}
      <div class="notice notice-info">No load-shedding area selected. Choose one on the <a href="/configuration/advanced">Advanced</a> page.</div>
    </section>`;
  }
  let lastDay = '';
  return html`<section class="card gs-prices">
    ${head}
    ${data.error && html`<div class="notice notice-warn">${data.error}</div>`}
    ${data.outages.length === 0
      ? html`<div class="empty"><${Ic} name="calendar-check" /><p>No planned outages for ${data.areaName}.</p></div>`
      : html`<div class="gs-timeline">${data.outages.map((o) => {
          const day = f.ymd(o.start);
          const showDay = day !== lastDay;
          lastDay = day;
          const active = o.start <= now && now < o.end;
          const past = o.end <= now;
          const hours = (o.end - o.start) / 3_600_000;
          return html`${showDay && html`<div class="gs-day">${f.day.format(o.start)}<span>${day}</span></div>`}
            <div class=${`gs-out ${active ? 'now' : ''} ${past ? 'past' : ''}`}>
              <span class="gs-dot"></span>
              <div class="list-main">
                <div class="list-title">${f.time.format(o.start)} – ${f.time.format(o.end)}</div>
                <div class="list-sub">${hours % 1 === 0 ? hours : hours.toFixed(1)} h${active ? ' · in progress' : ''}</div>
              </div>
              <${Badge} kind=${active ? 'bad' : 'warn'}>Stage ${o.stage}<//>
              ${o.source ? html`<a class="btn btn-ghost btn-sm gs-src" href=${o.source} target="_blank" rel="noopener" aria-label="Source" title="Source"><${Ic} name="external-link" size="sm" /></a>` : html`<span class="gs-src"></span>`}
            </div>`;
        })}</div>`}
    <p class="muted small gs-foot">Schedules sourced from <a href=${data.sourceUrl} target="_blank" rel="noopener">eskom-calendar</a>.</p>
  </section>`;
}

function useProvider() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/grid?resolution=hour').then((d) => alive && setData(d), () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return data;
}

export default function GridStatus() {
  const snap = useStore(live);
  const s = useStore(appSettings);
  const provider = useProvider();
  const t = snap?.totals ?? {};
  const g = snap?.grid ?? {};
  const currency = s?.['grid.currency'] ?? '';
  const price = (k) => (num(g[k]) === null ? [] : text(`${fmtPrice(g[k])} ${currency}/kWh`));
  const rows = [
    ['Power', gridValues(t, 'Grid power')],
    ['Voltage', gridValues(t, 'Grid voltage')],
    ['Frequency', gridValues(t, 'Grid frequency')],
    ['Provider', has(g, 'Provider') && g.Provider !== 'None' ? text(g.Provider) : []],
    ['Provider connection', text(g['Provider connection'])],
    ['Provider area', text(g['Provider area'])],
    ['Price', price('Price')],
    ['Price premium', price('Price premium')],
    ['Day ahead price', price('Day ahead price')],
    ['Next cheapest hour', text(g['Next cheapest hour'])],
    ['Planned outage start', text(g['Next planned outage start'])],
    ['Planned outage end', text(g['Next planned outage end'])],
    ['Planned outage in', text(g['Next planned outage in'])],
    ['Planned outage stage', text(g['Next planned outage stage'])],
  ];
  const w = num(t['Grid power']);
  const kwv = w === null ? '–' : Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) : String(Math.round(w));
  const multi = (name) => {
    const v = gridValues(t, name);
    return v.length > 1 ? v.map((x) => `${x.text} ${x.label}`).join(' · ') : '';
  };
  const volt = num(t['Grid voltage']);
  const freq = num(t['Grid frequency']);
  const hasProvider = provider && provider.provider !== 'default';
  const providerName = has(g, 'Provider') && g.Provider !== 'None' ? g.Provider : hasProvider ? provider.providerName : 'None';
  const providerSub = num(g.Price) !== null ? `Now ${fmtPrice(g.Price)} ${currency}/kWh` : g['Next planned outage in'] ? `Next outage in ${g['Next planned outage in']}` : g['Provider area'] ?? 'No price or outage feed';

  return html`<${Page} title="Grid" wide>
    <div class="gs-kpis">
      <${Kpi} icon="utility-pole" tone="grid" label="Grid power" value=${kwv} unit=${w !== null && Math.abs(w) >= 1000 ? 'kW' : 'W'}
        sub=${multi('Grid power') || (w === null ? 'No reading' : Math.abs(w) < 15 ? 'Idle' : w > 0 ? 'Importing from the grid' : 'Exporting to the grid')} />
      <${Kpi} icon="gauge" tone="load" label="Voltage" value=${volt === null ? '–' : volt.toFixed(1)} unit="V" sub=${multi('Grid voltage') || (volt === null ? 'No reading' : volt < 207 || volt > 253 ? 'Outside the normal range' : 'Within the normal range')} />
      <${Kpi} icon="audio-waveform" tone="battery" label="Frequency" value=${freq === null ? '–' : freq.toFixed(2)} unit="Hz" sub=${multi('Grid frequency') || (freq === null ? 'No reading' : 'Mains frequency')} />
      <${Kpi} icon=${provider?.provider === 'eskom' ? 'zap-off' : 'coins'} tone="accent" label="Provider" value=${html`<span class="gs-prov">${providerName}</span>`} sub=${providerSub} />
    </div>
    <div class=${`gs-grid ${hasProvider ? '' : 'solo'}`}>
      ${hasProvider && (provider.provider === 'eskom' ? html`<${Outages} data=${provider} tz=${s?.timezone} />` : html`<${Prices} data=${provider} tz=${s?.timezone} />`)}
      <section class="card gs-details">
        <header class="card-head"><div class="sa-title"><${IconChip} name="utility-pole" tone="grid" small /><div><h2>Grid readings</h2><p class="muted small">Live from the inverter and provider</p></div></div></header>
        <${MetricRows} rows=${rows} />
      </section>
      ${provider && !hasProvider && html`<section class="card tinted gs-noprov"><span class="chip-ic sm"><${Ic} name="info" size="sm" /></span>
        <div><h3>No grid provider</h3><p class="muted small">Add day-ahead prices or an Eskom load-shedding schedule on the <a href="/configuration/advanced">Advanced</a> page.</p></div></section>`}
    </div>
  <//>`;
}

injectCss('css-grid-status', `
.gs-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.gs-kpis .card { padding: 18px; }
.gs-prov { font-size: 17px; letter-spacing: -0.01em; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-kpis .card { min-width: 0; overflow: hidden; }
.gs-kpis .kpi-body { min-width: 0; flex: 1; max-width: 100%; }
.gs-kpis .kpi-value { max-width: 100%; }
@media (max-width: 1200px) { .gs-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) {
  .gs-kpis { gap: 12px; } .gs-kpis .card { padding: 14px; } .gs-kpis .kpi { flex-direction: column; gap: 10px; } .gs-kpis .kpi-body { width: 100%; } .gs-prov { font-size: 15px; } .gs-kpis .kpi-value { font-size: 21px; }
}
.gs-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.gs-grid.solo { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
@media (max-width: 1200px) { .gs-grid, .gs-grid.solo { grid-template-columns: minmax(0, 1fr); } }
.gs-grid .card-head { flex-wrap: wrap; }
.gs-grid .card-head p { margin: 0; }
.gs-noprov { display: flex; gap: 14px; align-items: flex-start; }
.gs-noprov p { margin: 4px 0 0; }
.gs-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0 0 14px; }
.gs-stats .now { background: var(--accent-soft); } .gs-stats .now b { color: var(--accent-text); }
@media (max-width: 560px) { .gs-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.mini-stats { display: grid; gap: 10px; }
.mini-stats div { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
.mini-stats span { font-size: 11.5px; color: var(--muted); }
.mini-stats b { font-size: 16px; color: var(--heading); font-variant-numeric: tabular-nums; }
.mini-stats small { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc { position: relative; }
.pc svg { display: block; overflow: visible; }
.pc-grid { stroke: var(--grid-line); }
.pc-zero { stroke: var(--faint); }
.pc-day { stroke: var(--border); stroke-dasharray: 3 3; }
.pc-axis { fill: var(--muted); font: 500 11px var(--font); }
.pc-dayname { fill: var(--heading); font-weight: 650; }
.pc-now { stroke: var(--heading); stroke-width: 1.5; stroke-dasharray: 3 3; }
.pc-now-pill { fill: var(--heading); }
.pc-now-text { fill: #fff; font: 650 10.5px var(--font); }
.gs-more { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.gs-more summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; color: var(--accent-text); }
.gs-more summary::-webkit-details-marker { display: none; }
.gs-more summary .ic { transition: transform .2s; }
.gs-more[open] summary .ic { transform: rotate(180deg); }
.gs-table { margin-top: 10px; max-height: 420px; overflow-y: auto; }
.gs-table tr.gs-past td { color: var(--muted); }
.gs-table .badge { padding: 1px 8px; font-size: 11.5px; }
.gs-foot { margin: 12px 0 0; }
.gs-prices .empty .ic { width: 26px; height: 26px; color: var(--faint); }
.gs-timeline { display: flex; flex-direction: column; }
.gs-day { display: flex; align-items: baseline; gap: 8px; font-weight: 650; color: var(--heading); margin: 14px 0 4px; }
.gs-day:first-child { margin-top: 0; }
.gs-day span { font-size: 12px; font-weight: 500; color: var(--muted); }
.gs-out { position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 0 10px 22px; border-bottom: 1px solid var(--grid-line); }
.gs-out::before { content: ""; position: absolute; left: 5px; top: 0; bottom: 0; width: 2px; background: var(--surface-3); }
.gs-dot { position: absolute; left: 0; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; background: var(--surface); border: 3px solid var(--warn); }
.gs-out.now .gs-dot { border-color: var(--bad); box-shadow: 0 0 0 4px var(--bad-soft); }
.gs-out.now .list-title { color: var(--bad); }
.gs-out.past { opacity: .55; }
.gs-src { width: 30px; padding: 0; flex: none; }
`);
