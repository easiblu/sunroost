// Inverter status: a header card (inverter chip, model / serial, device-mode badge, headline numbers
// and the general readings) followed by metric group cards for Load, Solar PV, Grid, Battery and
// Auxiliary. Values reported per MPPT / phase / sensor fold into one row with small coloured pills
// ("mppt 1", "phase 2", "total", "AC"…). With more than one inverter the page shows the cluster
// table: a Total column (from the combined totals) and one column per inverter.
//
// This module also exports the shared status-page building blocks (display aggregation, metric rows,
// edit link and layout CSS) used by the battery, grid, settings and power pages.
import { api, fmtMetric, html, live, num, useEffect, useState, useStore } from '../lib/core.js';
import { Badge, Ic, IconChip, Page } from '../lib/ui.js';

// ---------- Shared helpers ----------

export function injectCss(id, css) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export const has = (m, k) => m != null && m[k] !== undefined && m[k] !== null && m[k] !== '';

const v = (m, name, label = '', color = '') => ({ text: fmtMetric(name, m[name]), label, color });

const TEMP_VARIANTS = [['Temperature AC', 'AC'], ['Temperature DC', 'DC'], ['Temperature TR', 'transformer']];
const LHA = [['Lowest', 'lowest', 'red'], ['Average', 'average', 'blue'], ['Highest', 'highest', 'green']];

/**
 * Display aggregation (put_mppt / put_phases / put_lha / put_charging_info / put_inverter_temps).
 * Returns the values for one row: [{ text, label, color }], or [] when absent.
 *  - 'mppt'  : "X 1..4" → yellow "mppt N"; X itself → "total"
 *  - 'phase' : "X 1..3" → yellow "phase N"; X itself → "total"
 *  - 'temp'  : Temperature + Temperature AC/DC/TR → AC / DC / transformer
 *  - 'lha'   : "X - Lowest/Average/Highest" → lowest (red) / average / highest (green)
 *  - 'lh'    : as 'lha' without the average
 *  - 'charging': Max charge / discharge current → green "charge", red "discharge"
 */
export function display(m, name, mode) {
  if (!m) return [];
  if (mode === 'mppt' || mode === 'phase') {
    const variants = [];
    for (let i = 1; i <= (mode === 'mppt' ? 4 : 3); i++) {
      if (has(m, `${name} ${i}`)) variants.push(v(m, `${name} ${i}`, `${mode} ${i}`, 'yellow'));
    }
    const base = has(m, name) ? [v(m, name, variants.length ? 'total' : '')] : [];
    return [...base, ...variants];
  }
  if (mode === 'temp') {
    const variants = TEMP_VARIANTS.filter(([k]) => has(m, k)).map(([k, label]) => v(m, k, label));
    return [...(has(m, name) ? [v(m, name)] : []), ...variants];
  }
  if (mode === 'lha' || mode === 'lh') {
    const out = LHA.filter(([s]) => (mode === 'lh' ? s !== 'Average' : true) && has(m, `${name} - ${s}`))
      .map(([s, label, color]) => v(m, `${name} - ${s}`, label, color));
    return out.length ? out : has(m, name) ? [v(m, name)] : [];
  }
  if (mode === 'charging') {
    return [
      ...(has(m, 'Max charge current') ? [v(m, 'Max charge current', 'charge', 'green')] : []),
      ...(has(m, 'Max discharge current') ? [v(m, 'Max discharge current', 'discharge', 'red')] : []),
    ];
  }
  return has(m, name) ? [v(m, name)] : [];
}

/** The values of one metric cell: one line per value with its label pill aligned in a column. */
export function Values({ values }) {
  return html`${values.map((x) => html`<span class=${`dv ${x.label ? '' : 'no-label'}`}>
    <span class="dv-v">${x.text}</span>${x.label && html`<span class=${`display-label ${x.color}`}>${x.label}</span>`}
  </span>`)}`;
}

/** Name/value list rows, skipping rows without values. rows: [[name, values]]. */
export function MetricRows({ rows }) {
  const list = rows.filter(([, values]) => values && !(Array.isArray(values) && !values.length));
  if (!list.length) return null;
  return html`<div class="sa-rows">${list.map(([name, values]) => html`
    <div class="sa-mn">${name}</div>
    <div class="sa-mv">${Array.isArray(values) ? html`<${Values} values=${values} />` : values}</div>`)}</div>`;
}

/** Former "Dashboard › X" heading. The top bar now shows the title and crumbs, so it only renders children. */
export const Crumb = ({ children }) => (children ? html`<span class="sa-crumb-extra">${children}</span>` : null);

/** "Edit" ghost button next to a heading. */
export const EditLink = ({ onClick, label = 'edit' }) => html`<button type="button" class="btn btn-ghost btn-sm action-text"
  onClick=${(e) => { e.preventDefault(); onClick(); }}><${Ic} name="pencil" size="sm" />${label[0].toUpperCase() + label.slice(1)}</button>`;

/** Inverter drawing (kept for pages that show it): cabinet, display, status LED and cooling fins. */
export const InverterIcon = ({ size = 80, mode }) => {
  const led = mode && /fault/i.test(mode) ? 'var(--bad)' : mode && /standby|off|idle/i.test(mode) ? 'var(--warn)' : 'var(--ok)';
  return html`<svg class="inverter-icon" width=${size} height=${size} viewBox="0 0 80 80" role="img" aria-label="Inverter">
    <rect x="16" y="6" width="48" height="68" rx="8" fill="var(--surface)" stroke="var(--muted)" stroke-width="2" />
    <rect x="24" y="14" width="32" height="16" rx="3" fill="var(--load-soft)" stroke="var(--muted)" stroke-width="1.5" />
    <path d="M28 25 l5 -6 l5 4 l5 -6 l5 3" fill="none" stroke="var(--load)" stroke-width="1.5" stroke-linejoin="round" />
    <circle cx="40" cy="38" r="2.6" fill=${led} />
    ${[46, 51, 56, 61].map((y) => html`<line x1="26" x2="54" y1=${y} y2=${y} stroke="var(--faint)" stroke-width="2" stroke-linecap="round" />`)}
  </svg>`;
};

/** Badge kind for a device mode string. */
export const modeKind = (mode) => (!mode ? 'muted' : /fault|error/i.test(mode) ? 'bad' : /standby|off|idle|power ?saving/i.test(mode) ? 'warn' : 'ok');

// ---------- Inverter metrics ----------

const GENERAL = [
  ['Device mode'], ['Fault code'], ['Temperature', 'temp'], ['Bus voltage'], ['System power'],
  ['AC output power', 'phase'], ['AC output voltage', 'phase'], ['AC output frequency', 'phase'],
];
const LOAD = [
  ['Load percentage', 'phase'], ['Load power', 'phase'], ['Load power essential', 'phase'],
  ['Load power non-essential', 'phase'], ['Load apparent power', 'phase'],
];
const PV = [['PV power', 'mppt'], ['PV voltage', 'mppt'], ['PV current', 'mppt']];
const GRID = [
  ['Grid power', 'phase'], ['Grid power LD', 'phase'], ['Grid power CT', 'phase'], ['Grid current', 'phase'],
  ['Grid voltage', 'phase'], ['Grid frequency', 'phase'],
];
const BATTERY = [
  ['Battery power'], ['Battery charge power from PV'], ['Battery charge power from AC'], ['Battery voltage'],
  ['Battery current'], ['Battery temperature'],
];
const AUX = [
  ['Auxiliary load power', 'phase'], ['Auxiliary load voltage', 'phase'], ['Auxiliary load current', 'phase'],
  ['Generator power', 'phase'], ['Generator voltage', 'phase'], ['Generator current', 'phase'],
  ['Auxiliary PV power', 'phase'], ['Auxiliary PV voltage', 'phase'], ['Auxiliary PV current', 'phase'],
];
/** [title, icon, tone, rows, link] */
const SINGLE_CARDS = [
  ['Load', 'house', 'load', LOAD], ['Solar PV', 'sun', 'solar', PV], ['Grid', 'utility-pole', 'grid', GRID, '/grid/status'],
  ['Battery', 'battery-charging', 'battery', BATTERY, '/battery/status'], ['Auxiliary', 'plug', 'accent', AUX],
];

/** Parallel groups (AC output rows move into the load group, battery voltage first). */
const PARALLEL_GROUPS = [
  ['load', 'Load', 'house', 'load', [...LOAD, ['AC output power', 'phase'], ['AC output voltage', 'phase'], ['AC output frequency', 'phase']]],
  ['pv', 'Solar PV', 'sun', 'solar', PV],
  ['battery', 'Battery', 'battery-charging', 'battery', [['Battery voltage'], ['Battery current'], ['Battery power'], ['Battery charge power from PV'], ['Battery charge power from AC'], ['Battery temperature']]],
  ['grid', 'Grid', 'utility-pole', 'grid', [['Grid power', 'phase'], ['Grid power LD', 'phase'], ['Grid power CT', 'phase'], ['Grid voltage', 'phase'], ['Grid frequency', 'phase']]],
  ['aux', 'Auxiliary', 'plug', 'accent', AUX],
];
const TRAILING = [['System power'], ['Bus voltage'], ['Temperature', 'temp'], ['Fault code'], ['Serial number']];

const rowsOf = (m, list) => list.map(([name, mode]) => [name, display(m, name, mode)]);

/** Driver info (model, serial, firmware) from the settings endpoint; the live snapshot doesn't carry it. */
function useInverterInfo() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/api/inverter/settings').then((d) => alive && setInfo(d), () => {});
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

const kwOrW = (w) => (num(w) === null ? ['–', ''] : Math.abs(w) >= 1000 ? [(w / 1000).toFixed(2), 'kW'] : [String(Math.round(w)), 'W']);

function Stat({ icon, tone, label, value, unit }) {
  return html`<div class="inv-stat"><span class=${`inv-stat-ic ${tone}`}><${Ic} name=${icon} size="sm" /></span>
    <div><span>${label}</span><b>${value}${unit && html`<small>${unit}</small>`}</b></div></div>`;
}

const halves = (rows) => [rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))];

function HeaderCard({ m, meta, info, title = 'Inverter' }) {
  const mode = m['Device mode'];
  const model = info?.['Model name'] ?? m['Model name'] ?? meta?.model ?? meta?.driver;
  const serial = info?.['Serial number'] ?? m['Serial number'];
  const fw = info?.['Firmware version'] ?? m['Firmware version'];
  const temp = num(m.Temperature);
  const [lv, lu] = kwOrW(m['Load power']);
  const [pv, pu] = kwOrW(m['PV power']);
  const [gv, gu] = kwOrW(m['Grid power']);
  const [bv, bu] = kwOrW(m['Battery power']);
  return html`<section class="card inv-head">
    <div class="inv-id">
      <span class="chip-ic accent inv-chip"><${Ic} name="cpu" size="lg" /></span>
      <div class="inv-name">
        <h2>${model || title}</h2>
        <p class="muted small">${[serial && `S/N ${serial}`, fw && `Firmware ${fw}`, meta?.driver && model !== meta.driver && meta.driver].filter(Boolean).join(' · ') || 'Live readings'}</p>
      </div>
      ${mode ? html`<${Badge} kind=${modeKind(mode)}><span class="live-dot" style="width:6px;height:6px;box-shadow:none;background:currentColor"></span>${mode}<//>` : html`<${Badge}>No data<//>`}
    </div>
    <div class="inv-stats">
      <${Stat} icon="house" tone="load" label="Load" value=${lv} unit=${lu} />
      <${Stat} icon="sun" tone="solar" label="Solar" value=${pv} unit=${pu} />
      <${Stat} icon="utility-pole" tone="grid" label="Grid" value=${gv} unit=${gu} />
      <${Stat} icon="battery-charging" tone="battery" label="Battery" value=${bv} unit=${bu} />
      <${Stat} icon="thermometer" tone="accent" label="Temperature" value=${temp === null ? '–' : fmtMetric('Temperature', temp)} />
    </div>
    <div class="inv-general">${halves(rowsOf(m, GENERAL).filter(([, vals]) => vals.length)).map((rows) => html`<${MetricRows} rows=${rows} />`)}</div>
  </section>`;
}

function Single({ m, meta }) {
  const info = { ...(meta?.inverters?.[0]?.info ?? {}) };
  const cards = SINGLE_CARDS.map(([title, icon, tone, list, href]) => [title, icon, tone, rowsOf(m, list).filter(([, vals]) => vals.length), href])
    .filter(([, , , rows]) => rows.length);
  return html`<div class="inv-page">
    <${HeaderCard} m=${m} meta=${meta} info=${info} />
    ${Object.keys(m).length === 0 && html`<div class="empty"><${Ic} name="plug-zap" /><p>No readings from the inverter yet. Check the connection on the <a href="/configuration">Configuration</a> page.</p></div>`}
    <div class="inv-grid">
      ${cards.map(([title, icon, tone, rows, href]) => html`<section class="card">
        <header class="card-head">
          <div class="sa-title"><${IconChip} name=${icon} tone=${tone} small /><h2>${title}</h2></div>
          ${href && html`<a class="small" href=${href}>Details</a>`}
        </header>
        <${MetricRows} rows=${rows} />
      </section>`)}
    </div>
  </div>`;
}

function Parallel({ inverters, totals }) {
  const n = inverters.length;
  const any = (name, mode) => inverters.some((m) => display(m, name, mode).length);
  const cell = (m, name, mode) => html`<td class="sa-mv"><${Values} values=${display(m, name, mode)} /></td>`;
  const trailing = TRAILING.filter(([name, mode]) => name === 'Fault code' || any(name, mode));
  const head = (label) => html`<thead><tr><th>${label}</th><th>Total</th>${inverters.map((_, i) => html`<th>#${i + 1}</th>`)}</tr></thead>`;
  return html`<div class="inv-page parallel" data-count=${n}>
    <div class="par-units">
      ${inverters.map((m, i) => html`<div class="card par-unit">
        <span class="chip-ic accent sm"><${Ic} name="cpu" size="sm" /></span>
        <div class="par-unit-name"><b>Inverter ${i + 1}</b><span class="muted small">${has(m, 'Serial number') ? m['Serial number'] : fmtMetric('Load power', m['Load power'])}</span></div>
        <${Badge} kind=${modeKind(m['Device mode'])}>${m['Device mode'] ?? '–'}<//>
      </div>`)}
    </div>
    ${PARALLEL_GROUPS.map(([id, title, icon, tone, list]) => {
      const rows = list.filter(([name, mode]) => any(name, mode));
      return rows.length > 0 && html`<section class="card par-card" id=${`par-${id}`}>
        <header class="card-head"><div class="sa-title"><${IconChip} name=${icon} tone=${tone} small /><h2>${title}</h2></div></header>
        <div class="table-wrap"><table class="table par-table">
          ${head('Metric')}
          <tbody>${rows.map(([name, mode]) => html`<tr>
            <td class="sa-mn">${name}</td>
            ${cell(totals, name, mode)}
            ${inverters.map((m) => cell(m, name, mode))}
          </tr>`)}</tbody>
        </table></div>
      </section>`;
    })}
    <section class="card par-card">
      <header class="card-head"><div class="sa-title"><${IconChip} name="cpu" tone="accent" small /><h2>System</h2></div></header>
      <div class="table-wrap"><table class="table par-table">
        <thead><tr><th>Metric</th><th></th>${inverters.map((_, i) => html`<th>#${i + 1}</th>`)}</tr></thead>
        <tbody>
          <tr><td class="sa-mn">Device mode</td><td></td>${inverters.map((m) => cell(m, 'Device mode'))}</tr>
          ${trailing.map(([name, mode]) => html`<tr>
            <td class="sa-mn">${name}</td><td></td>
            ${inverters.map((m) => (name === 'Fault code' && !has(m, name)
              ? html`<td class="sa-mv"><span class="dv no-label"><span class="dv-v">None</span></span></td>`
              : cell(m, name, mode)))}
          </tr>`)}
        </tbody>
      </table></div>
    </section>
  </div>`;
}

export default function InverterStatus() {
  const snap = useStore(live);
  const meta = useInverterInfo();
  const inverters = (snap?.inverters ?? []).filter(Boolean);
  const parallel = inverters.length > 1;
  return html`<${Page} title=${parallel ? 'Inverter cluster' : 'Inverter'} wide>
    ${!snap
      ? html`<div class="loading">Connecting…</div>`
      : parallel
        ? html`<${Parallel} inverters=${inverters} totals=${snap.totals ?? {}} />`
        : html`<${Single} m=${inverters[0] ?? {}} meta=${meta} />`}
  <//>`;
}

// ---------- Shared status-page styles ----------

injectCss('css-sa-status', `
/* Legacy layout helpers still used by some pages */
.sa-content { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
.sa-content > div { min-width: 0; }
.sa-half { flex: 1 1 calc(50% - 8px); }
.sa-full { flex: 0 0 100%; }
.sa-content > div > .card { height: 100%; }
@media (max-width: 62em) { .sa-content > .sa-full-md, .sa-content > .sa-full-lg, .sa-content > .sa-full-xl { flex-basis: 100%; } }
.card.sa-card { padding: 0; }
.sa-section { padding: 22px; }
.sa-section + .sa-section { border-top: 1px solid var(--border); }
.sa-pad-bottom { padding-bottom: 22px; }
@media (max-width: 560px) { .sa-section { padding: 18px; } }
.sa-h3 { display: flex; align-items: center; gap: 8px; font-size: 15.5px; font-weight: 650; margin: 0 0 12px; line-height: 1.4; color: var(--heading); }
.sa-h3 a { color: var(--link); }
.sa-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sa-title h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.action-text.btn { margin-left: auto; font-size: 12.5px; }
.heading { padding: 1em 0 .5em; font-weight: 650; font-size: 15px; line-height: 1.4; color: var(--heading); }
.heading:first-child { padding-top: 0; }

/* Metric rows: label left, values right, one row per metric */
.sa-rows { display: grid; grid-template-columns: fit-content(58%) minmax(0, 1fr); }
.sa-rows > .sa-mn, .sa-rows > .sa-mv { padding: 9px 0; border-bottom: 1px solid var(--grid-line); }
.sa-rows > .sa-mn:nth-last-child(2), .sa-rows > .sa-mv:last-child { border-bottom: 0; }
.sa-rows > .sa-mn { color: var(--muted); padding-right: 12px; }
.sa-mv { font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; min-width: 0; color: var(--heading); }
.sa-rows > .sa-mv { text-align: right; }
.sa-mv .dv { display: flex; align-items: center; justify-content: flex-end; gap: 8px; line-height: 1.5; }
.sa-mv .dv + .dv { margin-top: 3px; }
.sa-mv .dv-v { white-space: nowrap; }
.sa-mv .display-label { margin: 0; min-width: 64px; text-align: center; white-space: nowrap; }
.sa-rows .sa-mv:not(:has(.display-label)) .dv-v { white-space: normal; }

.accent-block { border-radius: var(--radius); padding: 14px 16px; background: var(--surface-2); border: 1px solid var(--border); text-align: left; }
.accent-block.narrow { padding: 10px 14px; }
.accent-block.forward, .accent-block.light-forward { background: var(--info-soft); border-color: transparent; color: #2c4fb8; }
.accent-block.caution { background: var(--warn-soft); border-color: transparent; color: #8a5a00; }
.accent-block a { color: inherit; text-decoration: underline; }
.font-small { font-size: 12.5px; }
.sa-table { width: 100%; border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums; }
.sa-table td, .sa-table th { padding: 9px 10px; text-align: right; font-weight: inherit; border-bottom: 1px solid var(--grid-line); white-space: nowrap; }
.sa-table td:first-child, .sa-table th:first-child { text-align: left; }
.sa-table thead td, .sa-table thead th { font-size: 12px; font-weight: 600; color: var(--muted); background: var(--surface-2); }
.sa-table thead td:first-child, .sa-table thead th:first-child { border-top-left-radius: var(--radius-xs); }
.sa-table thead td:last-child, .sa-table thead th:last-child { border-top-right-radius: var(--radius-xs); }
.sa-table tbody tr:hover td { background: #fafbfc; }
.sa-table td.positive { color: var(--ok-text); }
.sa-table td.negative { color: var(--bad); }
@media (max-width: 46em) { .hide-sm { display: none; } }
.sa-buttons { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.setting-result { margin-left: .5em; }
.setting-result.positive, .setting-result.negative { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.setting-result.positive { background: var(--ok-soft); color: var(--ok-text); }
.setting-result.negative { background: var(--bad-soft); color: var(--bad); }
`);

injectCss('css-inverter-status', `
.inv-page { display: flex; flex-direction: column; gap: 16px; }
.inv-head { display: flex; flex-direction: column; gap: 18px; }
.inv-id { display: flex; align-items: center; gap: 14px; min-width: 0; }
.inv-chip { width: 56px; height: 56px; border-radius: 16px; }
.inv-name { flex: 1; min-width: 0; }
.inv-name h2 { font-size: 19px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inv-name p { margin: 2px 0 0; }
.inv-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.inv-stat { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 14px; background: var(--surface-2); min-width: 0; }
.inv-stat > div { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.inv-stat span { font-size: 12px; color: var(--muted); }
.inv-stat b { font-size: 19px; color: var(--heading); font-variant-numeric: tabular-nums; white-space: nowrap; letter-spacing: -0.01em; }
.inv-stat b small { font-size: 12px; color: var(--muted); margin-left: 3px; font-weight: 600; }
.inv-stat-ic { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; flex: none; }
.inv-stat-ic.load { background: var(--load-soft); color: var(--load); } .inv-stat-ic.solar { background: var(--solar-soft); color: var(--solar); }
.inv-stat-ic.grid { background: var(--grid-soft); color: var(--grid); } .inv-stat-ic.battery { background: var(--battery-soft); color: var(--battery); }
.inv-stat-ic.accent { background: var(--accent-soft); color: var(--accent); }
.inv-general { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 40px; }
@media (max-width: 1100px) {
  .inv-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .inv-general { grid-template-columns: minmax(0, 1fr); }
  .inv-general .sa-rows + .sa-rows { border-top: 1px solid var(--grid-line); }
}
@media (max-width: 860px) { .inv-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) {
  .inv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .inv-stat { padding: 11px; gap: 10px; } .inv-stat b { font-size: 17px; }
  .inv-id { flex-wrap: wrap; } .inv-chip { width: 48px; height: 48px; }
  .inv-name h2 { white-space: normal; font-size: 17px; } .inv-stat:last-child { grid-column: 1 / -1; }
}

/* Parallel inverter tables */
.par-units { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.par-unit { display: flex; align-items: center; gap: 12px; padding: 16px; }
.par-unit-name { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.par-unit-name b { color: var(--heading); }
.par-table { table-layout: fixed; min-width: calc(220px + (var(--n, 3)) * 150px); }
.parallel[data-count="2"] .par-table { --n: 3; } .parallel[data-count="3"] .par-table { --n: 4; }
.parallel[data-count="4"] .par-table { --n: 5; } .parallel[data-count="5"] .par-table { --n: 6; }
.par-table td { vertical-align: top; }
.par-table td.sa-mn { color: var(--muted); font-weight: 500; width: 220px; white-space: normal; }
.par-table td:first-child, .par-table th:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.par-table th:first-child { background: var(--surface-2); z-index: 2; }
@media (max-width: 560px) { .par-table td.sa-mn { width: 128px; } .par-table { min-width: calc(128px + (var(--n, 3)) * 130px); } }
.par-table td:nth-child(2) { background: var(--surface-2); }
.par-table td.sa-mv { color: var(--heading); }
.par-table td.sa-mv .dv { justify-content: flex-end; }
.par-table td.sa-mv .display-label { min-width: 56px; }
`);
