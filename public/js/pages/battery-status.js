// Battery status: the bank (SOC ring, headline KPIs and the inverter-negotiated values), a pack
// comparison card (per-pack bars for power, state of charge, voltage and temperature) and one card
// per BMS pack: SOC bar, voltage/current/power/temperature, cycles, cell lowest/average/highest with
// the spread, a coloured per-cell voltage grid, alarms and every other reading under "All readings".
import { appSettings, fmtMetric, html, live, num, useStore } from '../lib/core.js';
import { Badge, Ic, IconChip, Page, Ring, useWidth } from '../lib/ui.js';
import { display, has, injectCss, MetricRows } from './inverter-status.js';

/** Bank values read from the inverter (the full list, used without a BMS). */
const BANK_FULL = [
  ['Power', 'Battery power'], ['Voltage', 'Battery voltage'], ['Current', 'Battery current'], ['Capacity', 'Battery capacity'],
  ['Temperature', 'Battery temperature'], ['State of charge', 'Battery state of charge'], ['State of health', 'Battery state of health'],
  ['Recommended charge voltage', 'Battery recommended charge voltage'], ['Recommended charge current', 'Battery recommended charge current'],
  ['Recommended discharge current', 'Battery recommended discharge current'], ['Protocol version', 'Battery protocol version'],
];
/** With a BMS the packs carry the details; the bank list keeps only what the inverter negotiates. */
const BANK_SHORT = BANK_FULL.slice(7);

/** Pack rows: [label, metric, mode]. */
const PACK = [
  ['Model name'], ['PCB number'], ['Serial number'], ['Firmware', 'Firmware version'], ['Capacity'], ['Design capacity'],
  ['Device mode'], ['State of charge'], ['State of health'], ['Power'], ['Current'], ['Voltage'], ['Temperature'],
  ['Temperature MOS'], ['Temperature ENV'], ['Temperature 1'], ['Temperature 2'], ['Temperature 3'], ['Temperature 4'],
  ['Cycles'], ['Charge capacity'], ['Last full charge'], ['Discharge - Last'], ['Discharge - Average'], ['Discharge - Deepest'],
  ['Discharge - Total'], ['Cell voltage', 'Cell voltage', 'lha'], ['Cell temperature', 'Cell temperature', 'lha'],
  ['Max current', 'Max current', 'charging'], ['Board number'], ['Address'],
];

const AH = new Set(['Capacity', 'Design capacity', 'Charge capacity']);
const fmt = (name, value) => (AH.has(name) && typeof value === 'number' ? `${value} Ah` : name === 'Battery capacity' && typeof value === 'number' ? `${value} kWh` : fmtMetric(name, value));
const plain = (m, name) => (has(m, name) ? [{ text: fmt(name, m[name]), label: '', color: '' }] : []);

function packValues(m, metric, mode) {
  if (mode === 'charging') {
    const v = display(m, metric, 'charging');
    return v.length ? v : plain(m, 'Max current');
  }
  if (mode === 'lha' && metric === 'Cell voltage') {
    // Cell voltages need millivolt resolution.
    const key = { lowest: 'Lowest', average: 'Average', highest: 'Highest' };
    return display(m, metric, mode).map((x) => {
      const v = num(m[`Cell voltage - ${key[x.label]}`]);
      return v === null ? x : { ...x, text: `${v.toFixed(3)} V` };
    });
  }
  if (mode) return display(m, metric, mode);
  return plain(m, metric);
}

const alarmsOf = (m) => (Array.isArray(m.Alarms) ? m.Alarms : has(m, 'Alarms') ? String(m.Alarms).split(/\s*[,;]\s*/) : []).filter(Boolean);
const socColor = (soc) => (soc === null ? 'var(--surface-3)' : soc < 20 ? 'var(--bad)' : soc < 40 ? 'var(--warn)' : 'var(--battery)');
const modeKind = (mode) => (!mode ? 'muted' : /fault|alarm|protect/i.test(mode) ? 'bad' : /charg/i.test(mode) && !/dis/i.test(mode) ? 'ok' : /dis/i.test(mode) ? 'info' : 'muted');
const powerText = (w) => (num(w) === null ? '–' : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);

/** Per-cell voltages, coloured from the lowest (red) to the highest (green) cell. */
function Cells({ m }) {
  const cells = [];
  for (let i = 1; i <= 32 && has(m, `Cell voltage ${i}`); i++) cells.push(num(m[`Cell voltage ${i}`]));
  if (cells.length < 2) return null;
  const valid = cells.filter((c) => c !== null);
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const tone = (c) => {
    if (c === null || hi === lo) return '';
    if (c === lo) return 'low';
    if (c === hi) return 'high';
    return c < avg - (avg - lo) / 2 ? 'below' : c > avg + (hi - avg) / 2 ? 'above' : '';
  };
  return html`<div class="bat-cells-wrap">
    <div class="bat-sub">Cell voltages<span class="legend-dots"><span style="--c:var(--bad)">Lowest</span><span style="--c:var(--ok)">Highest</span></span></div>
    <div class="bat-cells" role="list" aria-label="Cell voltages">
      ${cells.map((c, i) => html`<span role="listitem" class=${`bat-cell ${tone(c)}`} title=${`Cell ${i + 1}: ${c?.toFixed(3)} V`}>
        <i>${i + 1}</i><b>${c === null ? '–' : c.toFixed(3)}</b></span>`)}
    </div>
  </div>`;
}

function Pack({ m, n }) {
  const rows = PACK.map(([label, metric = label, mode]) => [label, packValues(m, metric, mode)]);
  const alarms = alarmsOf(m);
  const lo = num(m['Cell voltage - Lowest']);
  const hi = num(m['Cell voltage - Highest']);
  const avg = num(m['Cell voltage - Average']);
  const diff = num(m['Cell voltage - Difference']) ?? (hi !== null && lo !== null ? hi - lo : null);
  if (alarms.length) rows.push(['Alarms', html`${alarms.map((a) => html`<span class="badge badge-bad">${a}</span> `)}`]);
  if (diff !== null) rows.push(['Cell voltage - Difference', [{ text: `${Math.round(diff * 1000)} mV`, label: '', color: '' }]]);
  const soc = num(m['State of charge']);
  const sub = [m['Model name'], m['Serial number'] && `S/N ${m['Serial number']}`].filter(Boolean).join(' · ');
  const stat = (label, value) => html`<div><span>${label}</span><b>${value}</b></div>`;
  const diffKind = diff === null ? 'muted' : diff * 1000 < 30 ? 'ok' : diff * 1000 < 80 ? 'warn' : 'bad';
  return html`<section class="card bat-pack">
    <header class="card-head">
      <div class="sa-title"><${IconChip} name="battery-medium" tone="battery" small /><div><h2>Battery ${n}</h2>${sub && html`<p class="muted small">${sub}</p>`}</div></div>
      ${has(m, 'Device mode') && html`<${Badge} kind=${modeKind(m['Device mode'])}>${m['Device mode']}<//>`}
    </header>
    ${alarms.length > 0 && html`<div class="notice notice-bad bat-alarms"><${Ic} name="triangle-alert" size="sm" />${alarms.join(', ')}</div>`}
    <div class="bat-soc">
      <div class="bat-soc-top"><b>${soc === null ? '–' : `${Math.round(soc)}%`}</b>
        <span class="muted small">${[has(m, 'State of health') && `Health ${fmtMetric('State of health', m['State of health'])}`, has(m, 'Charge capacity') && `${fmt('Charge capacity', m['Charge capacity'])} of ${fmt('Capacity', m.Capacity ?? m['Design capacity'])}`].filter(Boolean).join(' · ')}</span></div>
      <div class="bat-bar"><i style=${`width:${Math.max(0, Math.min(100, soc ?? 0))}%;background:${socColor(soc)}`}></i></div>
    </div>
    <div class="bat-stats">
      ${stat('Voltage', fmtMetric('Voltage', m.Voltage))}
      ${stat('Current', fmtMetric('Current', m.Current))}
      ${stat('Power', powerText(num(m.Power)))}
      ${stat('Temperature', fmtMetric('Temperature', m.Temperature ?? m['Cell temperature - Average']))}
      ${stat('Cycles', has(m, 'Cycles') ? m.Cycles : '–')}
    </div>
    ${(lo !== null || hi !== null) && html`<div class="bat-lha">
      <div class="lo"><span>Lowest cell</span><b>${lo === null ? '–' : `${lo.toFixed(3)} V`}</b></div>
      <div><span>Average</span><b>${avg === null ? '–' : `${avg.toFixed(3)} V`}</b></div>
      <div class="hi"><span>Highest cell</span><b>${hi === null ? '–' : `${hi.toFixed(3)} V`}</b></div>
      <div><span>Spread</span><b><${Badge} kind=${diffKind}>${diff === null ? '–' : `${Math.round(diff * 1000)} mV`}<//></b></div>
    </div>`}
    <${Cells} m=${m} />
    <details class="bat-more">
      <summary><${Ic} name="chevron-down" size="sm" />All readings</summary>
      <${MetricRows} rows=${rows} />
    </details>
  </section>`;
}

// ---------- Horizontal pack bars ----------

const SERIES = ['--battery', '--load', '--solar', '--grid', '--accent', '--info', '--warn', '--bad', '--muted'];

function niceNum(v) {
  if (!Number.isFinite(v)) return '–';
  return Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
}

/** Horizontal bars, one per pack, on a fixed min..max scale (zero line for signed values). */
export function PackBars({ caption, unit, min = 0, max, values }) {
  const [ref, width] = useWidth();
  const n = Math.max(1, values.length);
  const bar = 14;
  const gap = 8;
  const pad = { l: 64, r: 70, t: 4, b: 18 };
  const height = pad.t + pad.b + n * bar + (n - 1) * gap;
  const head = html`<div class="bc-head"><span>${caption}</span><span class="muted">${niceNum(min)} – ${niceNum(max)} ${unit}</span></div>`;
  if (!width) return html`<div class="bat-chart" ref=${ref}>${head}<div style=${`height:${height}px`}></div></div>`;
  const w = Math.max(10, width - pad.l - pad.r);
  const lo = Math.min(min, ...values.map((v) => v.value ?? 0));
  const hi = Math.max(max, ...values.map((v) => v.value ?? 0));
  const x = (v) => pad.l + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * w;
  const zero = x(Math.max(lo, Math.min(hi, 0)));
  return html`<div class="bat-chart" ref=${ref}>
    ${head}
    <svg width=${width} height=${height} role="img" aria-label=${`${caption} per battery pack`}>
      ${values.map((v, i) => {
        const y = pad.t + i * (bar + gap);
        const val = v.value;
        const x0 = val === null ? zero : Math.min(zero, x(val));
        const x1 = val === null ? zero : Math.max(zero, x(val));
        return html`<g>
          <text x="0" y=${y + bar / 2 + 4} class="bc-name">${v.name}</text>
          <rect x=${pad.l} y=${y} width=${w} height=${bar} rx=${bar / 2} class="bc-bg" />
          <rect x=${x0} y=${y} width=${Math.max(val === null ? 0 : 3, x1 - x0)} height=${bar} rx=${bar / 2} fill=${`var(${SERIES[i % SERIES.length]})`}>
            <title>${v.name}: ${val === null ? '–' : `${niceNum(val)} ${unit}`}</title>
          </rect>
          <text x=${width} y=${y + bar / 2 + 4} text-anchor="end" class="bc-label">${val === null ? '–' : `${niceNum(val)} ${unit}`}</text>
        </g>`;
      })}
      ${lo < 0 && html`<line x1=${zero} x2=${zero} y1="0" y2=${height - pad.b + 4} class="bc-axisline" />`}
    </svg>
  </div>`;
}

function Compare({ packs, s }) {
  const fahrenheit = s?.temperature_unit === '°F';
  const toUnit = (c) => (c === null ? null : fahrenheit ? c * 1.8 + 32 : c);
  const maxPower = Math.max(100, num(s?.max_battery_power) ?? 5000);
  const tempMetric = packs.some((p) => has(p, 'Temperature')) ? 'Temperature' : 'Cell temperature - Average';
  const series = (metric, f = (x) => x) => packs.map((p, i) => ({ name: packs.single ? 'Bank' : `Pack ${i + 1}`, value: num(p[metric]) === null ? null : f(num(p[metric])) }));
  const vmax = Math.max(60, ...packs.map((p) => num(p.Voltage) ?? 0));
  return html`<div class="bat-compare">
    <${PackBars} caption="Power" unit="W" min=${-maxPower} max=${maxPower} values=${series('Power', Math.round)} />
    <${PackBars} caption="State of charge" unit="%" min=${0} max=${100} values=${series('State of charge')} />
    <${PackBars} caption="Voltage" unit="V" min=${0} max=${vmax} values=${series('Voltage')} />
    <${PackBars} caption="Temperature" unit=${fahrenheit ? '°F' : '°C'} min=${toUnit(0)} max=${toUnit(50)} values=${series(tempMetric, toUnit)} />
  </div>`;
}

function BankCard({ t, s, packs }) {
  const soc = num(t['Battery state of charge']);
  const w = num(t['Battery power']);
  const capacity = num(s?.['bms.capacity']) ?? num(t['Battery capacity']);
  const remaining = soc !== null && capacity ? (soc / 100) * capacity : null;
  const state = w === null ? 'No data' : Math.abs(w) < 15 ? 'Idle' : w > 0 ? 'Charging' : 'Discharging';
  const bank = (packs.length ? BANK_SHORT : BANK_FULL).map(([label, metric]) => [label, plain(t, metric)]);
  const kpi = (icon, label, value) => html`<div class="list-item"><${IconChip} name=${icon} tone="battery" small />
    <div class="list-main"><div class="list-sub">${label}</div><div class="list-title">${value}</div></div></div>`;
  return html`<section class="card bat-bank">
    <header class="card-head">
      <div class="sa-title"><${IconChip} name="battery-charging" tone="battery" small /><div><h2>Battery bank</h2>
        <p class="muted small">${packs.length ? `${packs.length} pack${packs.length === 1 ? '' : 's'} via BMS` : 'Read from the inverter'}</p></div></div>
      <${Badge} kind=${state === 'Charging' ? 'ok' : state === 'Discharging' ? 'info' : 'muted'}>${state}<//>
    </header>
    <div class="bat-bank-body">
      <${Ring} value=${soc ?? 0} color=${socColor(soc)} size=${160} label=${soc === null ? '–' : `${Math.round(soc)}%`} sub="State of charge" />
      <div class="list bat-kpis">
        ${kpi('zap', 'Power', powerText(w))}
        ${kpi('gauge', 'Voltage', fmtMetric('Battery voltage', t['Battery voltage']))}
        ${kpi('activity', 'Current', fmtMetric('Battery current', t['Battery current']))}
        ${kpi('thermometer', 'Temperature', fmtMetric('Battery temperature', t['Battery temperature']))}
        ${remaining !== null && kpi('battery-medium', 'Remaining', `${remaining.toFixed(1)} of ${capacity} kWh`)}
        ${has(t, 'Battery state of health') && kpi('heart-pulse', 'State of health', fmtMetric('Battery state of health', t['Battery state of health']))}
      </div>
    </div>
    ${bank.some(([, v]) => v.length) && html`<div class="bat-bank-rows"><div class="bat-sub">${packs.length ? 'Negotiated with the inverter' : 'All bank readings'}</div><${MetricRows} rows=${bank} /></div>`}
  </section>`;
}

export default function BatteryStatus() {
  const snap = useStore(live);
  const s = useStore(appSettings);
  const t = snap?.totals ?? {};
  const packs = (snap?.batteries ?? []).filter(Boolean);
  // Without a BMS, chart the bank as a single pack from the inverter's readings.
  const chartPacks = packs.length ? packs : has(t, 'Battery power') || has(t, 'Battery state of charge')
    ? Object.assign([{ Power: t['Battery power'], 'State of charge': t['Battery state of charge'], Voltage: t['Battery voltage'], Temperature: t['Battery temperature'] }], { single: true })
    : [];
  return html`<${Page} title="Battery" wide>
    ${!snap
      ? html`<div class="loading">Connecting…</div>`
      : html`<div class="bat-page">
        <div class="bat-top">
          <${BankCard} t=${t} s=${s} packs=${packs} />
          <section class="card">
            <header class="card-head"><div class="sa-title"><${IconChip} name="chart-bar" tone="load" small /><div><h2>${packs.length > 1 ? 'Pack comparison' : 'Bank at a glance'}</h2>
              <p class="muted small">${packs.length > 1 ? 'Each pack side by side' : 'Live values on their full scale'}</p></div></div></header>
            ${chartPacks.length > 0 ? html`<${Compare} packs=${chartPacks} s=${s} />` : html`<div class="empty"><${Ic} name="battery-warning" /><p>No battery readings yet.</p></div>`}
          </section>
        </div>
        ${packs.length > 0 && html`<div class="bat-packs">${packs.map((p, i) => html`<${Pack} m=${p} n=${i + 1} key=${i} />`)}</div>`}
      </div>`}
  <//>`;
}

injectCss('css-battery-status', `
.bat-page { display: flex; flex-direction: column; gap: 16px; }
.bat-top { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.bat-packs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 1200px) { .bat-top, .bat-packs { grid-template-columns: minmax(0, 1fr); } }
.bat-page .card-head p { margin: 0; }
.bat-bank-body { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 24px; align-items: center; }
.bat-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; }
.bat-kpis .list-item { padding: 8px 0; border-bottom: 1px solid var(--grid-line); }
.bat-bank-rows { margin-top: 16px; padding-top: 4px; }
.bat-sub { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); margin: 8px 0 4px; }
.bat-sub .legend-dots { text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 11.5px; }
@media (max-width: 640px) {
  .bat-bank-body { grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .bat-kpis { width: 100%; }
}
@media (max-width: 340px) { .bat-kpis { grid-template-columns: minmax(0, 1fr); } }

.bat-compare { display: flex; flex-direction: column; gap: 18px; }
.bat-chart { width: 100%; }
.bat-chart svg { display: block; overflow: visible; }
.bc-head { display: flex; justify-content: space-between; font-size: 12.5px; font-weight: 600; color: var(--heading); margin-bottom: 8px; }
.bc-head .muted { font-weight: 500; font-size: 11.5px; }
.bc-bg { fill: var(--surface-3); }
.bc-axisline { stroke: var(--faint); stroke-width: 1.5; stroke-dasharray: 2 3; }
.bc-name { fill: var(--muted); font: 500 12px var(--font); }
.bc-label { fill: var(--heading); font: 600 12px var(--font); font-variant-numeric: tabular-nums; }

.bat-alarms { display: flex; align-items: center; gap: 8px; }
.bat-soc { margin-bottom: 14px; }
.bat-soc-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.bat-soc-top b { font-size: 28px; font-weight: 750; letter-spacing: -0.02em; color: var(--heading); font-variant-numeric: tabular-nums; line-height: 1; }
.bat-bar { height: 10px; border-radius: 6px; background: var(--surface-3); overflow: hidden; }
.bat-bar i { display: block; height: 100%; border-radius: 6px; transition: width .8s ease; }
.bat-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.bat-stats div, .bat-lha div { display: flex; flex-direction: column; min-width: 0; padding: 9px 10px; border-radius: 12px; background: var(--surface-2); }
.bat-stats span, .bat-lha span { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bat-stats b, .bat-lha b { font-size: 14px; color: var(--heading); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bat-lha { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.bat-lha .lo { background: var(--bad-soft); } .bat-lha .lo b { color: var(--bad); }
.bat-lha .hi { background: var(--ok-soft); } .bat-lha .hi b { color: var(--ok-text); }
.bat-lha .badge { padding: 1px 8px; }
@media (max-width: 760px) { .bat-cells { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 560px) { .bat-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } .bat-lha { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.bat-cells-wrap { margin-top: 10px; }
.bat-cells { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 6px; font-variant-numeric: tabular-nums; }
.bat-cell { display: flex; flex-direction: column; align-items: center; padding: 6px 4px; border-radius: 10px; background: var(--surface-2); border: 1px solid transparent; line-height: 1.2; }
.bat-cell i { font-style: normal; color: var(--muted); font-size: 10.5px; }
.bat-cell b { font-size: 12.5px; color: var(--heading); font-weight: 600; }
.bat-cell.low { background: var(--bad-soft); border-color: color-mix(in srgb, var(--bad) 35%, transparent); } .bat-cell.low b { color: var(--bad); }
.bat-cell.below { background: color-mix(in srgb, var(--bad-soft) 55%, var(--surface-2)); }
.bat-cell.high { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, transparent); } .bat-cell.high b { color: var(--ok-text); }
.bat-cell.above { background: color-mix(in srgb, var(--ok-soft) 55%, var(--surface-2)); }
.bat-more { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.bat-more summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; color: var(--accent-text); }
.bat-more summary::-webkit-details-marker { display: none; }
.bat-more summary .ic { transition: transform .2s; }
.bat-more[open] summary .ic { transform: rotate(180deg); }
.bat-more .sa-rows { margin-top: 6px; }
.bat-page .empty .ic { width: 26px; height: 26px; color: var(--faint); }
`);
