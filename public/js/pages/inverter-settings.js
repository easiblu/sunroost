// Inverter settings: an info card (driver and specification) followed by one card per settings
// section. Each section has an "Edit" button; in edit mode the values become inputs, changed ones are highlighted, and Save
// sends only the changed settings. Every result shows inline next to its setting ("Saved. Please
// wait..." or the inverter's error), then the page leaves edit mode and re-reads the inverter.
import { api, fmtMetric, html, live, onInverterSettings, useEffect, useRef, useState, useStore } from '../lib/core.js';
import { Badge, displaySetting, Ic, IconChip, Page, SettingInput } from '../lib/ui.js';
import { has, injectCss, MetricRows } from './inverter-status.js';

const INFO_KEYS = [
  'Serial number', 'Firmware version', 'Secondary firmware version', 'Protocol version', 'Model name', 'Model number',
  'Machine type', 'Topology', 'Max parallel units', 'Nominal battery voltage', 'Expected AC input voltage',
  'Max AC input current', 'Max AC output current', 'Max AC output power', 'Max AC output apparent power',
];
/** Delay before re-reading the inverter after a write, so the inverter has committed it. */
const REFRESH_AFTER_MS = 2500;

const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * Saves changed settings and re-reads them shortly after. Returns { results, save(changed), busy }.
 * results: { key: { cls: 'positive'|'negative', message } } shown next to each setting.
 */
export function useSettingWriter(index, onValues) {
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = async (changed) => {
    if (!Object.keys(changed).length) return true;
    setBusy(true);
    try {
      const res = await api.post('/api/inverter/settings', { index, values: changed });
      setResults(Object.fromEntries(Object.entries(res.results).map(([k, r]) => [k, r.ok
        ? { cls: 'positive', message: 'Saved. Reading it back…' }
        : { cls: 'negative', message: r.message || 'Rejected' }])));
      onValues?.(res.values);
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const r = await api.post('/api/inverter/settings/refresh', { index });
          onValues?.(r.values);
        } catch {
          // The live update over the WebSocket covers us when the refresh fails.
        }
        setResults({});
      }, REFRESH_AFTER_MS);
      return Object.values(res.results).every((r) => r.ok);
    } catch (err) {
      setResults(Object.fromEntries(Object.keys(changed).map((k) => [k, { cls: 'negative', message: err.message }])));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { results, save, busy };
}

/** Inline save result as a pill badge. */
export const Result = ({ r }) => r ? html`<span class=${`setting-result ${r.cls}`}><${Ic} name=${r.cls === 'positive' ? 'check' : 'circle-alert'} size="sm" />${r.message}</span>` : null;

/** Icon for a settings section by its name. */
const sectionIcon = (s) => {
  const n = s.toLowerCase();
  if (/battery|charg/.test(n)) return ['battery-charging', 'battery'];
  if (/grid|utility|export/.test(n)) return ['utility-pole', 'grid'];
  if (/input|output|ac\b|load/.test(n)) return ['plug-zap', 'load'];
  if (/pv|solar/.test(n)) return ['sun', 'solar'];
  if (/time|slot|schedule|priority|work mode/.test(n)) return ['clock', 'accent'];
  return ['sliders-horizontal', 'accent'];
};

/**
 * One settings section: heading with an Edit button, name/value rows, Cancel/Save in edit mode.
 * title: heading; defs: SettingDef[]; values: current values; editable: show the edit button.
 */
export function SettingsSection({ title, defs, values, index = 0, editable = true, onValues, saveLabel = 'Save', id, icon, tone }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const { results, save, busy } = useSettingWriter(index, onValues);
  const val = (d) => (d.key in draft ? draft[d.key] : values?.[d.key]);
  const submit = async (e) => {
    e?.preventDefault();
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => !same(v, values?.[k])));
    if (!Object.keys(changed).length) return setEditing(false);
    await save(changed);
    // Leave edit mode once the results are shown; the re-read refreshes the values.
    setTimeout(() => {
      setEditing(false);
      setDraft({});
    }, 600);
  };
  const shown = defs.filter((d) => editing || has(values, d.key) || d.readOnly);
  const [ic, tn] = icon ? [icon, tone] : sectionIcon(title);
  const changedCount = Object.entries(draft).filter(([k, v]) => !same(v, values?.[k])).length;
  return html`<form class=${`sa-settings ${editing ? 'editing' : ''}`} id=${id} novalidate onSubmit=${submit}>
    <header class="card-head">
      <div class="sa-title"><${IconChip} name=${ic} tone=${tn} small /><div><h2>${title}</h2>
        <p class="muted small">${editing ? 'Changed values are highlighted' : `${shown.length} setting${shown.length === 1 ? '' : 's'}`}</p></div></div>
      ${editable && !editing && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setDraft({}); setEditing(true); }}><${Ic} name="pencil" size="sm" />Edit</button>`}
      ${editing && html`<span class="badge badge-accent">Editing</span>`}
    </header>
    <div class="sa-rows">
      ${shown.map((d) => {
        const dirty = editing && d.key in draft && !same(draft[d.key], values?.[d.key]);
        return html`
          <div class="sa-mn">${d.label}${d.help && html`<small class="help">${d.help}</small>`}</div>
          <div class=${`sa-mv sa-set ${dirty ? 'dirty' : ''}`} id=${`setting-${d.key}`}>
            ${editing && !d.readOnly
              ? html`<${SettingInput} def=${d} value=${val(d)} onChange=${(v) => setDraft((x) => ({ ...x, [d.key]: v }))} />`
              : html`<span>${displaySetting(d, values?.[d.key])}</span>`}
            <${Result} r=${results[d.key]} />
          </div>`;
      })}
    </div>
    ${shown.length === 0 && html`<p class="muted small">No values read from the inverter yet.</p>`}
    ${editing && html`<div class="form-actions">
      <button type="button" class="btn" onClick=${() => { setEditing(false); setDraft({}); }}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? 'Saving…' : changedCount > 1 ? `${saveLabel} ${changedCount} changes` : saveLabel}</button>
    </div>`}
  </form>`;
}

export default function InverterSettings() {
  const snap = useStore(live);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [index, setIndex] = useState(0);

  const load = () => api.get('/api/inverter/settings').then((d) => { setData(d); setError(null); }, (e) => setError(e.message));
  const setValues = (i) => (values) => setData((d) => {
    if (!d?.inverters?.[i]) return d;
    const inverters = d.inverters.slice();
    inverters[i] = { ...inverters[i], values };
    return { ...d, inverters };
  });

  useEffect(() => {
    load();
    return onInverterSettings((i, values) => setValues(i)(values));
  }, []);
  // Re-read the definitions when the link comes up or drops (driver restarted, inverter reconnected).
  const link = snap?.status?.inverter?.name;
  useEffect(() => { if (link) load(); }, [link]);

  const inverters = data?.inverters ?? [];
  const i = Math.min(index, Math.max(0, inverters.length - 1));
  const inv = inverters[i];
  const m = snap?.inverters?.[i] ?? {};
  const info = { ...m, ...(inv?.info ?? {}) };
  const sections = [...new Set((inv?.defs ?? []).map((d) => d.section))];
  const connected = Boolean(data?.connected);

  const rows = [
    ['Driver', data?.driver ?? '–'],
    ...(data?.model ? [['Model', data.model]] : []),
    ['Monitoring connection', html`<${Badge} kind=${connected ? 'ok' : 'muted'}>${connected ? 'Direct cable' : 'Not connected'}<//>`],
    ...INFO_KEYS.filter((k) => has(info, k) && k !== 'Model name' && k !== 'Serial number').map((k) => [k, fmtMetric(k, info[k])]),
  ];

  return html`<${Page} title="Settings" crumbs=${[['Inverter', '/inverter/status']]} wide>
    <div class="invset">
      <section class="card invset-info">
        <header class="card-head">
          <div class="sa-title"><span class="chip-ic accent invset-chip"><${Ic} name="cpu" size="lg" /></span>
            <div><h2>${info['Model name'] ?? data?.model ?? 'Inverter'}</h2>
              <p class="muted small">${has(info, 'Serial number') ? `S/N ${info['Serial number']}` : 'Specification'}</p></div></div>
          ${inverters.length > 1 && html`<select id="inverter_number" aria-label="Inverter" value=${i} onChange=${(e) => setIndex(Number(e.target.value))}>
            ${inverters.map((_, n) => html`<option value=${n} selected=${n === i}>Inverter ${n + 1}</option>`)}
          </select>`}
        </header>
        ${error && html`<div class="notice notice-bad">${error}</div>`}
        ${data && !connected && html`<div class="notice notice-info">Not connected, so settings can't be changed. See the <a href="/configuration">Configuration</a> page.</div>`}
        ${!data && !error && html`<div class="loading">Loading…</div>`}
        <${MetricRows} rows=${rows} />
      </section>
      ${inv && sections.map((section) => html`<section class="card" key=${`${i}-${section}`}>
        <${SettingsSection} title=${section} defs=${inv.defs.filter((d) => d.section === section)} values=${inv.values ?? {}}
          index=${i} editable=${connected} onValues=${setValues(i)} id=${`settings-${section.toLowerCase().replace(/\W+/g, '-')}`} />
      </section>`)}
      ${inv && connected && sections.length === 0 && html`<section class="card"><div class="empty"><${Ic} name="sliders-horizontal" /><p>This inverter has no settings that can be changed.</p></div></section>`}
    </div>
  <//>`;
}

injectCss('css-inverter-settings', `
.invset { column-count: 2; column-gap: 16px; }
.invset > .card { break-inside: avoid; margin-bottom: 16px; display: block; }
.invset-chip { width: 52px; height: 52px; border-radius: 16px; }
.invset .card-head { flex-wrap: wrap; }
.invset .card-head p { margin: 0; }
.invset-info select { width: auto; }
.sa-settings .sa-rows > .sa-mn { display: flex; flex-direction: column; justify-content: center; }
.sa-settings .help { display: block; }
.sa-set { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.sa-set input:not([type="checkbox"]), .sa-set select { min-width: 0; width: auto; max-width: 100%; padding-top: 7px; padding-bottom: 7px; }
.sa-set input[type="number"] { width: 7em; }
.sa-set.dirty input:not([type="checkbox"]), .sa-set.dirty select { border-color: var(--accent); background: var(--accent-soft); }
.sa-set.dirty .toggle-track { box-shadow: 0 0 0 3px var(--accent-soft); }
.sa-settings.editing .sa-rows > .sa-mn, .sa-settings.editing .sa-rows > .sa-mv { padding: 7px 0; }
.setting-result .ic { width: 13px; height: 13px; margin-right: 3px; }
@media (max-width: 1000px) { .invset { column-count: 1; } }
@media (max-width: 560px) {
  .sa-settings .sa-rows { grid-template-columns: minmax(0, 1fr); }
  .sa-settings .sa-rows > .sa-mn { border-bottom: 0; padding-bottom: 2px; }
  .sa-settings .sa-rows > .sa-mv { justify-content: flex-start; padding-top: 0; }
}
`);
