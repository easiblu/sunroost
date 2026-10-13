// Totals: energy per day / week / month / year. KPIs for the selected period (with the change vs the
// period before), a bar chart (click a bar to select that period), a table and CSV download.
import { html, useApi, useEffect, useState } from '../lib/core.js';
import { BarChart } from '../lib/chart.js';
import { Ic, IconChip, Kpi, Page, Segmented } from '../lib/ui.js';

const PERIODS = {
  day: { label: 'Day', count: 30, title: 'Last 30 days', prev: 'yesterday', vs: 'vs previous day', now: 'Today' },
  week: { label: 'Week', count: 52, title: 'Last 52 weeks', prev: 'last week', vs: 'vs previous week', now: 'This week' },
  month: { label: 'Month', count: 12, title: 'Last 12 months', prev: 'last month', vs: 'vs previous month', now: 'This month' },
  year: { label: 'Year', count: 5, title: 'Last 5 years', prev: 'last year', vs: 'vs previous year', now: 'This year' },
};

const COLUMNS = [
  ['load', 'Consumption'], ['pv', 'Solar'], ['batteryCharge', 'Battery charged'], ['batteryDischarge', 'Battery discharged'],
  ['gridImport', 'Grid used'], ['gridExport', 'Grid exported'],
];

const GROUPS = [['pv', 'Solar', '--solar'], ['load', 'Consumption', '--load'], ['gridImport', 'Grid used', '--grid']];

const f1 = (v) => (v == null || !Number.isFinite(v) ? '–' : (+v).toFixed(1));
const change = (cur, prev) => (cur == null || prev == null || !(prev > 0) ? null : Math.round(((cur - prev) / prev) * 100));
const rowLabel = (period, r) => (period === 'week' ? `Week of ${r.label}` : r.label);

function Kpis({ period, rows, index, tariff }) {
  const p = PERIODS[period];
  const cur = rows[index];
  const prev = rows[index - 1];
  const current = index === rows.length - 1;
  const withCost = Boolean(tariff?.importPrice || tariff?.exportPrice) && cur?.cost !== undefined;
  // The running period is incomplete, so show the previous value instead of a misleading change.
  const kpi = (key, props, digits = 1, unit = 'kWh') => {
    const v = cur?.[key];
    const pv = prev?.[key];
    const fmt = (x) => (x == null ? '–' : (+x).toFixed(digits));
    return current || !prev
      ? { ...props, value: fmt(v), unit, sub: prev ? `${p.prev[0].toUpperCase() + p.prev.slice(1)} ${fmt(pv)} ${unit}` : '' }
      : { ...props, value: fmt(v), unit, delta: change(v, pv), deltaLabel: p.vs };
  };
  const ss = cur?.selfSufficiency;
  const ssPrev = prev?.selfSufficiency;
  const ssDiff = ss != null && ssPrev != null ? Math.round(ss - ssPrev) : null;
  const items = [
    kpi('pv', { icon: 'sun', tone: 'solar', label: 'Solar' }),
    kpi('load', { icon: 'house', tone: 'load', label: 'Consumption' }),
    kpi('gridImport', { icon: 'arrow-down-to-line', tone: 'grid', label: 'Grid used', invert: true }),
    kpi('gridExport', { icon: 'arrow-up-from-line', tone: 'battery', label: 'Grid exported' }),
    {
      icon: 'sprout', tone: 'accent', label: 'Self-sufficiency', value: ss == null ? '–' : Math.round(ss), unit: '%',
      sub: current || ssDiff === null
        ? (ssPrev == null ? 'Usage covered without the grid' : `${p.prev[0].toUpperCase() + p.prev.slice(1)} ${Math.round(ssPrev)} %`)
        : html`<b class=${ssDiff >= 0 ? 'text-ok' : 'text-bad'}>${ssDiff >= 0 ? '+' : ''}${ssDiff} pts</b> ${p.vs}`,
    },
    ...(withCost ? [{ ...kpi('cost', { icon: 'wallet', tone: 'bad', label: 'Cost', invert: true }, 2, tariff.currency ?? '') }] : []),
  ];
  return html`<div class=${`tot-kpis n${items.length}`}>${items.map((k) => html`<${Kpi} ...${k} />`)}</div>`;
}

function Table({ period, rows, index, onSelect, withCost, currency }) {
  const list = rows.map((r, i) => ({ r, i })).reverse(); // newest first
  return html`<div class="table-wrap tot-table">
    <table class="table">
      <thead><tr><th>${PERIODS[period].label}</th>${COLUMNS.map(([, l]) => html`<th>${l}</th>`)}<th>Self-sufficiency</th>${withCost && html`<th>Cost</th>`}</tr></thead>
      <tbody>
        ${list.map(({ r, i }) => html`<tr class=${i === index ? 'active' : ''} onClick=${() => onSelect(i)}>
          <td><span class="tot-period">${r.label}${i === rows.length - 1 && html`<span class="badge badge-accent">${PERIODS[period].now}</span>`}</span></td>
          ${COLUMNS.map(([k]) => html`<td>${f1(r[k])}<small> kWh</small></td>`)}
          <td>${r.selfSufficiency == null ? '–' : `${Math.round(r.selfSufficiency)} %`}</td>
          ${withCost && html`<td>${r.cost == null ? '–' : `${r.cost.toFixed(2)} ${currency ?? ''}`}</td>`}
        </tr>`)}
      </tbody>
    </table>
  </div>`;
}

export default function Totals() {
  const [period, setPeriod] = useState(() => {
    const q = new URLSearchParams(location.search).get('period');
    return PERIODS[q] ? q : 'day';
  });
  const p = PERIODS[period];
  const report = useApi(`/api/totals?period=${period}&count=${p.count}`);
  const rows = report.data?.period === period ? report.data.rows : [];
  const [index, setIndex] = useState(null);
  useEffect(() => setIndex(null), [period]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    q.set('period', period);
    history.replaceState(history.state, '', `${location.pathname}?${q}`);
  }, [period]);
  const sel = index ?? rows.length - 1;
  const tariff = report.data?.tariff;
  const withCost = rows.some((r) => r.cost !== undefined) && Boolean(tariff?.importPrice || tariff?.exportPrice);
  const sum = report.data?.summary;

  const seg = html`<${Segmented} value=${period} onChange=${setPeriod} options=${Object.entries(PERIODS).map(([value, x]) => ({ value, label: x.label }))} />`;
  const csv = html`<a class="btn" href=${`/api/totals.csv?period=${period}&count=${p.count}`} download><${Ic} name="download" size="sm" />Download CSV</a>`;

  return html`<${Page} title="Totals" wide>
    <div class="tot-bar">
      ${seg}
      <div class="tot-sel">
        ${rows.length > 0 && html`<span class="muted small">Showing</span><b>${rowLabel(period, rows[sel])}</b>
          ${sel !== rows.length - 1 && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setIndex(null)}>Back to ${p.now.toLowerCase()}</button>`}`}
      </div>
    </div>
    ${report.error && html`<div class="notice notice-bad">Couldn't load totals: ${report.error}</div>`}
    ${rows.length > 0 && html`<${Kpis} period=${period} rows=${rows} index=${sel} tariff=${tariff} />`}

    <section class="card tot-chart">
      <header class="card-head">
        <div class="tot-head"><${IconChip} name="chart-column" tone="accent" small /><div><h2>${p.title}</h2>
          <p class="muted small">Click a bar to see that ${p.label.toLowerCase()} above</p></div></div>
        ${sum && html`<div class="tot-sum">
          <span><i style="--c:var(--solar)"></i>Solar <b>${f1(sum.pv)} kWh</b></span>
          <span><i style="--c:var(--load)"></i>Consumption <b>${f1(sum.load)} kWh</b></span>
          <span><i style="--c:var(--grid)"></i>Grid used <b>${f1(sum.gridImport)} kWh</b></span>
        </div>`}
      </header>
      ${report.loading && !rows.length
        ? html`<div class="loading">Loading…</div>`
        : rows.length
          ? html`<${BarChart} legend=${false} height=${300} labels=${rows.map((r) => (period === 'month' ? r.label.split(' ')[0] : r.label))} selected=${sel} onSelect=${setIndex}
              groups=${GROUPS.map(([k, label, color]) => ({ label, color, values: rows.map((r) => r[k]) }))} />`
          : html`<div class="empty"><${Ic} name="chart-column" /><p>No totals yet. They build up as data is collected.</p></div>`}
    </section>

    <section class="card tot-card">
      <header class="card-head">
        <div class="tot-head"><${IconChip} name="table" tone="load" small /><div><h2>${p.title}</h2><p class="muted small">Newest first · all values in kWh</p></div></div>
        ${csv}
      </header>
      ${rows.length > 0 && html`<${Table} period=${period} rows=${rows} index=${sel} onSelect=${setIndex} withCost=${withCost} currency=${tariff?.currency} />`}
    </section>

    <section class="card tinted tot-notes">
      <span class="chip-ic sm"><${Ic} name="info" size="sm" /></span>
      <div>
        <h3>Reading these numbers</h3>
        <ul>
          <li>What the inverter itself consumes isn't counted as load. That energy still comes from the grid or from solar PV.</li>
          <li>Batteries give back less energy than was put into them, because charging and discharging lose some along the way.</li>
          <li>Accuracy depends on how well your inverter measures power, and that varies a lot from model to model.</li>
        </ul>
        <p class="muted small">CSV for other periods:
          ${[['day', 30, 'days'], ['week', 52, 'weeks'], ['month', 12, 'months'], ['year', 5, 'years']].map(
            ([pp, n, l], i) => html`${i ? ' · ' : ' '}<a href=${`/api/totals.csv?period=${pp}&count=${n}`} download>${l}</a>`,
          )}
        </p>
      </div>
    </section>
  <//>`;
}

const css = `
.tot-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.tot-sel { display: flex; align-items: center; gap: 8px; }
.tot-sel b { color: var(--heading); font-size: 15px; }
.tot-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.tot-kpis.n5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.tot-kpis .card { padding: 18px; }
.tot-kpis .kpi-value { font-size: 24px; }
@media (max-width: 1560px) { .tot-kpis, .tot-kpis.n5 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .tot-kpis, .tot-kpis.n5 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .tot-kpis .card { padding: 14px; } .tot-kpis .kpi { flex-direction: column; gap: 10px; } .tot-kpis .kpi-value { font-size: 21px; }
}
.tot-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.tot-head p { margin: 0; }
.tot-chart .card-head, .tot-card .card-head { flex-wrap: wrap; }
.tot-sum { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.tot-sum span { display: inline-flex; align-items: center; gap: 6px; }
.tot-sum i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.tot-sum b { color: var(--heading); font-variant-numeric: tabular-nums; }
.tot-chart, .tot-card { margin-bottom: 16px; }
.tot-table { max-height: 520px; overflow-y: auto; }
.tot-table tbody tr { cursor: pointer; }
.tot-table td small { color: var(--muted); font-size: 11px; }
.tot-period { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--heading); }
.tot-period .badge { padding: 1px 8px; font-size: 11px; }
.tot-notes { display: flex; gap: 14px; align-items: flex-start; }
.tot-notes h3 { margin-bottom: 6px; }
.tot-notes ul { margin: 0 0 10px; padding-left: 18px; color: var(--text); font-size: 13px; }
.tot-notes li { margin: 3px 0; }
.tot-notes p { margin: 0; }
.empty .ic { width: 26px; height: 26px; color: var(--faint); margin-bottom: 6px; }
@media (max-width: 560px) { .tot-sel { width: 100%; } .tot-bar .seg { width: 100%; } .tot-bar .seg button { flex: 1; } }
`;
let styleEl = document.getElementById('css-totals');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-totals';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css;
