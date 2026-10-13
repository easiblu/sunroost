// Automations: overview (KPIs, upcoming 24 h timeline, recent activity), rules (general rules and the
// classic rule table / SOC control / battery protection types), the rule builder (?edit=<id>|new),
// templates, scenes, run history and notification settings. Tabs are kept in the URL (?tab=).
// Contract: docs/AUTOMATIONS.md.
import {
  api, appSettings, fmtDateTime, html, live, navigate, onLog, pad2, saveSettings, useEffect, useMemo, useQuery, useRef, useState, useStore,
} from '../lib/core.js';
import { Badge, displaySetting, Ic, IconChip, Kpi, Modal, Page, Segmented, Select, SettingInput, toast, Toggle } from '../lib/ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${pad2(h)}:00` }));
const DURATIONS = [30, 60, 120, 240, 360, 480, 720, 1440];

const socOptions = (from, to, current) => {
  const list = [];
  for (let v = from; v <= to; v += 5) list.push(v);
  if (current !== undefined && current !== null && !list.includes(Number(current))) list.push(Number(current));
  return list.sort((a, b) => a - b).map((v) => ({ value: v, label: `${v}%` }));
};

const isNone = (v) => v === null || v === undefined || v === '';
const fmtValue = (def, v) => (isNone(v) ? 'None' : def ? displaySetting(def, v) : String(v));
const num = (n) => String(Math.round(n * 100) / 100);
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const durLabel = (m) => (m < 60 ? `${m}m` : `${m / 60}h`);
const durLong = (m) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "in 2 h 5 min" / "5 min ago". */
function rel(ts, now = Date.now()) {
  const d = Math.round((ts - now) / 60000);
  const a = Math.abs(d);
  const t = a < 1 ? 'less than a minute' : a < 60 ? `${a} min` : a < 1440 ? `${Math.floor(a / 60)} h${a % 60 ? ` ${a % 60} min` : ''}` : `${Math.round(a / 1440)} d`;
  if (a < 1) return d >= 0 ? 'now' : 'just now';
  return d > 0 ? `in ${t}` : `${t} ago`;
}
function whenText(ts) {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const day = d.toDateString() === today.toDateString() ? '' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow ' : `${DAYS[d.getDay()]} `;
  return `${day}${hhmm(ts)}`;
}

/** Re-renders every `ms` (countdowns). */
function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Card head: icon chip, title, one-line description, actions on the right. */
const Head = ({ icon, tone, title, sub, actions }) => html`<header class="card-head au-head">
  <div class="au-head-main">${icon && html`<${IconChip} name=${icon} tone=${tone} small />`}
    <div><h2>${title}</h2>${sub && html`<p class="muted small">${sub}</p>`}</div></div>
  ${actions && html`<div class="card-actions">${actions}</div>`}
</header>`;

const EmptyState = ({ icon, title, children, action }) => html`<div class="empty au-empty">
  <span class="au-big-ic"><${Ic} name=${icon} size="lg" /></span>
  ${title && html`<b>${title}</b>`}
  ${children && html`<span>${children}</span>`}
  ${action}
</div>`;

const RESULT_BADGE = { ok: ['ok', 'OK'], partial: ['warn', 'Partial'], failed: ['bad', 'Failed'], skipped: ['muted', 'Skipped'] };
const ResultBadge = ({ result, dry }) => {
  const [k, l] = RESULT_BADGE[result] ?? ['muted', result];
  return html`<span class=${`badge badge-${k}`}>${l}${dry ? ' · dry' : ''}</span>`;
};

/** Small dropdown menu behind a kebab button. items: [{ icon, label, onClick, danger, disabled }]. */
function Menu({ items, label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', off);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return html`<div class="au-menu" ref=${ref}>
    <button type="button" class="icon-btn au-ibtn" aria-label=${label} aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Ic} name="ellipsis-vertical" size="sm" /></button>
    ${open && html`<div class="au-menu-pop" role="menu">${items.filter(Boolean).map((it) => html`<button type="button" role="menuitem"
      class=${it.danger ? 'danger' : ''} disabled=${it.disabled} onClick=${() => { setOpen(false); it.onClick(); }}><${Ic} name=${it.icon} size="sm" />${it.label}</button>`)}</div>`}
  </div>`;
}

/** Day-of-week chips (Mon first). */
function DayChips({ value = [], onChange, label = 'Days' }) {
  return html`<span class="au-days" role="group" aria-label=${label}>${DAY_ORDER.map((d) => {
    const on = value.includes(d);
    return html`<button type="button" class=${`au-day ${on ? 'on' : ''}`} aria-pressed=${on}
      onClick=${() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}>${DAYS[d].slice(0, 2)}</button>`;
  })}</span>`;
}

// ---------- Classic automations (rule table, SOC control, battery protection) ----------

function condText(cond, c) {
  if (c === null || c === undefined) return 'Any';
  const unit = cond?.unit && cond.unit !== '%' ? ` ${cond.unit}` : cond?.unit ?? '';
  switch (cond?.type) {
    case 'time': return c.from === c.to ? 'All day' : `${c.from} to ${c.to}`;
    case 'days': {
      const d = c.days ?? [];
      if (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x))) return 'Weekdays';
      if (d.length === 2 && d.includes(0) && d.includes(6)) return 'Weekends';
      return DAY_ORDER.filter((x) => d.includes(x)).map((x) => DAYS[x]).join(', ');
    }
    case 'bool': return c.value ? 'Yes' : 'No';
    case 'date': return c.from && c.to ? `${c.from} to ${c.to}` : c.from ? `From ${c.from}` : `Until ${c.to}`;
    case 'range':
      if (c.from !== null && c.to !== null) return `${num(c.from)}${unit} to ${num(c.to)}${unit}`;
      return c.from !== null ? `${num(c.from)}${unit} or more` : `${num(c.to)}${unit} or less`;
    default: return JSON.stringify(c);
  }
}
// ---------- Inputs for automation editors ----------

/** Value picker for an action, with an optional "None" (leave unchanged). */
function ValueInput({ def, value, onChange, allowNone = true }) {
  const v = isNone(value) ? '' : String(value);
  if (def?.type === 'select') {
    const opts = [...(allowNone ? [{ value: '', label: 'None' }] : []), ...(def.options ?? []).map((o) => ({ value: o, label: o }))];
    return html`<${Select} value=${v} options=${opts} onChange=${onChange} />`;
  }
  if (def?.type === 'checkbox') {
    const opts = [...(allowNone ? [{ value: '', label: 'None' }] : []), { value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }];
    return html`<${Select} value=${v} options=${opts} onChange=${onChange} />`;
  }
  const placeholder = def?.type === 'slot' ? (def.slotPriorities?.length ? 'HH:MM,HH:MM,Priority,true' : 'HH:MM,HH:MM,true') : def?.type === 'time' ? 'HH:MM' : allowNone ? 'None' : '';
  return html`<span class="input-unit"><input class="au-value" value=${v} placeholder=${placeholder}
    onInput=${(e) => onChange(e.target.value)} />${def?.unit && html`<span class="muted">${def.unit}</span>`}</span>`;
}

function emptyDraft(cond) {
  if (cond?.type === 'days') return { days: [] };
  if (cond?.type === 'bool') return { value: '' };
  return { from: '', to: '' };
}
function toDraft(cond, c) {
  if (c === null || c === undefined) return emptyDraft(cond);
  if (cond?.type === 'days') return { days: [...c.days] };
  if (cond?.type === 'bool') return { value: c.value ? 'yes' : 'no' };
  return { from: c.from ?? '', to: c.to ?? '' };
}
function fromDraft(cond, d) {
  if (cond?.type === 'days') return d.days.length ? { days: d.days } : null;
  if (cond?.type === 'bool') return d.value === '' ? null : { value: d.value === 'yes' };
  const from = String(d.from ?? '').trim();
  const to = String(d.to ?? '').trim();
  if (!from && !to) return null;
  if (cond?.type === 'time') return { from, to };
  return { from: from || null, to: to || null };
}

function CondInput({ cond, draft, onChange }) {
  const set = (patch) => onChange({ ...draft, ...patch });
  switch (cond?.type) {
    case 'time':
      return html`<span class="au-range"><input type="time" aria-label="From" value=${draft.from} onInput=${(e) => set({ from: e.target.value })} />
        <span class="muted">to</span><input type="time" aria-label="To" value=${draft.to} onInput=${(e) => set({ to: e.target.value })} /></span>`;
    case 'days':
      return html`<span class="au-days">${DAY_ORDER.map((d) => {
        const on = draft.days.includes(d);
        return html`<button type="button" class=${`au-day ${on ? 'on' : ''}`} aria-pressed=${on}
          onClick=${() => set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}>${DAYS[d].slice(0, 2)}</button>`;
      })}</span>`;
    case 'bool':
      return html`<${Select} value=${draft.value} options=${[{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange=${(v) => set({ value: v })} />`;
    case 'date':
      return html`<span class="au-range"><input class="au-date" aria-label="From" placeholder="YYYY-MM-DD" value=${draft.from} onInput=${(e) => set({ from: e.target.value })} />
        <span class="muted">to</span><input class="au-date" aria-label="To" placeholder="YYYY-MM-DD" value=${draft.to} onInput=${(e) => set({ to: e.target.value })} /></span>`;
    default:
      return html`<span class="au-range"><input class="au-num" aria-label="From" placeholder="Any" inputmode="decimal" value=${draft.from} onInput=${(e) => set({ from: e.target.value })} />
        <span class="muted">to</span><input class="au-num" aria-label="To" placeholder="Any" inputmode="decimal" value=${draft.to} onInput=${(e) => set({ to: e.target.value })} />
        ${cond?.unit && html`<span class="muted">${cond.unit}</span>`}</span>`;
  }
}

/** Saves an automation's name/config; optionally enables it. */
async function saveAutomation(a, body, enable) {
  await api.put(`/api/automations/${a.id}`, body);
  if (enable) await api.post(`/api/automations/${a.id}/enable`);
}

function EditButtons({ a, saving, onCancel, onSave }) {
  return html`<div class="form-actions">
    <button type="button" class="btn" onClick=${onCancel}>Cancel</button>
    ${!a.enabled && html`<button type="button" class="btn btn-ok" disabled=${saving} onClick=${() => onSave(true)}>Save and enable</button>`}
    <button type="submit" class="btn btn-primary" disabled=${saving}>${saving ? 'Saving…' : 'Save'}</button>
  </div>`;
}

const ErrorNote = ({ error }) => error && html`<div class="notice notice-bad small au-note"><${Ic} name="triangle-alert" size="sm" />${error}</div>`;

function useSaver(a, onSaved) {
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const run = async (body, enable) => {
    setSaving(true);
    setError(null);
    try {
      await saveAutomation(a, body, enable);
      toast('Automation saved');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return { error, saving, run };
}

// ---------- Rule table ----------

/** Rowspans for the first condition column: equal consecutive cells merge, so related rows read as one group. */
function spansOf(rows, dims) {
  const spans = rows.map(() => 1);
  if (dims < 2) return spans;
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && JSON.stringify(rows[j].when[0]) === JSON.stringify(rows[i].when[0])) spans[j++] = 0;
    spans[i] = j - i;
    i = j;
  }
  return spans;
}

const Th = ({ kind, label, set }) => html`<th class=${set ? 'au-set' : ''}><span class="au-th-kind">${kind}</span>${label}</th>`;

function TableShow({ a, conds }) {
  const cfg = a.config;
  const kinds = cfg.conditions.map((k) => conds[k] ?? { kind: k, label: k });
  const active = a.enabled ? a.status.decision.activeRow : null;
  const spans = spansOf(cfg.rows, kinds.length);
  return html`<div class="table-wrap"><table class="table au-rules">
    <thead><tr>
      ${kinds.map((k, j) => html`<${Th} kind=${j ? 'And when' : 'When'} label=${k.label} />`)}
      <${Th} kind="Set" label=${a.settingLabel} set />
    </tr></thead>
    <tbody>${cfg.rows.map((row, i) => html`<tr class=${`${i === active ? 'active' : ''} ${spans[i] > 0 && i > 0 ? 'row-start' : ''}`}>
      ${kinds.map((k, j) => (j === 0 && spans[i] === 0 ? null : html`<td rowspan=${j === 0 ? spans[i] : 1} class=${j === 0 && spans[i] > 1 ? 'au-span' : ''}>${condText(k, row.when[j])}</td>`))}
      <td class="au-set">${i === active && html`<${Ic} name="arrow-right" size="sm" />`}<b>${fmtValue(a.settingDef, row.value)}</b></td>
    </tr>`)}</tbody>
  </table></div>
  ${cfg.rows.length === 0 && html`<p class="small muted au-center">No rows yet. Edit the table to add conditions.</p>`}`;
}

function TableEdit({ a, opts, conds, onCancel, onSaved }) {
  const cfg = a.config;
  const [setting, setSetting] = useState(cfg.setting);
  const [inverter, setInverter] = useState(cfg.inverter ?? '');
  const [kinds, setKinds] = useState(cfg.conditions);
  const [rows, setRows] = useState(() =>
    cfg.rows.map((r) => ({ when: cfg.conditions.map((k, j) => toDraft(conds[k], r.when[j])), value: isNone(r.value) ? '' : String(r.value) })),
  );
  const [name, setName] = useState(a.name);
  const { error, saving, run } = useSaver(a, onSaved);
  const def = opts.settings.find((d) => d.key === setting);
  const available = Object.values(conds).filter((c) => c.available || kinds.includes(c.kind));

  const changeKind = (j, kind) => {
    const next = [...kinds];
    if (!kind) next.splice(j, 1);
    else next[j] = kind;
    setKinds(next);
    setRows(rows.map((r) => {
      const when = [...r.when];
      if (!kind) when.splice(j, 1);
      else when[j] = emptyDraft(conds[kind]);
      return { ...r, when };
    }));
  };
  const setRow = (i, patch) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  // "+" adds a sibling row below, keeping the first condition (a new branch under the same parent).
  const addAfter = (i) => {
    const base = rows[i];
    const row = { when: kinds.map((k, j) => (j === 0 && base && kinds.length > 1 ? JSON.parse(JSON.stringify(base.when[0])) : emptyDraft(conds[k]))), value: '' };
    setRows([...rows.slice(0, i + 1), row, ...rows.slice(i + 1)]);
  };
  const submit = (e, enable = false) => {
    e?.preventDefault();
    run({
      name,
      config: {
        setting,
        inverter: inverter === '' ? null : Number(inverter),
        conditions: kinds,
        rows: rows.map((r) => ({ when: kinds.map((k, j) => fromDraft(conds[k], r.when[j])), value: r.value === '' ? null : r.value })),
      },
    }, enable);
  };
  const spans = spansOf(rows.map((r) => ({ when: r.when })), kinds.length);
  return html`<form novalidate class="au-editor" onSubmit=${submit}>
    <div class="au-fields">
      <label><span>Name</span><input value=${name} maxlength="80" placeholder="Optional" onInput=${(e) => setName(e.target.value)} /></label>
      <label><span>Setting</span><${Select} value=${setting} options=${opts.settings.map((d) => ({ value: d.key, label: d.label }))}
        onChange=${(v) => { setSetting(v); setRows(rows.map((r) => ({ ...r, value: '' }))); }} /></label>
      ${opts.inverterCount > 1 && html`<label><span>Inverter</span><${Select} value=${inverter}
        options=${[{ value: '', label: 'All inverters' }, ...opts.inverters.map((i) => ({ value: i.index, label: i.label }))]} onChange=${setInverter} /></label>`}
      <label><span>When</span><${Select} value=${kinds[0]} options=${available.map((c) => ({ value: c.kind, label: c.label }))} onChange=${(v) => changeKind(0, v)} /></label>
      <label><span>And when</span><${Select} value=${kinds[1] ?? ''}
        options=${[{ value: '', label: '--- Optional ---' }, ...available.filter((c) => c.kind !== kinds[0]).map((c) => ({ value: c.kind, label: c.label }))]}
        onChange=${(v) => changeKind(1, v)} /></label>
    </div>
    ${kinds.some((k) => conds[k]?.note) && html`<p class="small muted">${kinds.map((k) => conds[k]?.note).filter(Boolean).join(' ')}</p>`}
    <div class="table-wrap"><table class="table au-rules au-edit">
      <thead><tr>
        ${kinds.map((k, j) => html`<${Th} kind=${j ? 'And when' : 'When'} label=${conds[k]?.label ?? k} />`)}
        <${Th} kind="Set" label=${def?.label ?? setting} set />
        <th class="au-rowbtns-h"><span class="au-sr">Rows</span></th>
      </tr></thead>
      <tbody>${rows.map((r, i) => html`<tr class=${spans[i] > 0 && i > 0 ? 'row-start' : ''}>
        ${kinds.map((k, j) => html`<td>
          <${CondInput} cond=${conds[k]} draft=${r.when[j]} onChange=${(d) => setRow(i, { when: r.when.map((w, x) => (x === j ? d : w)) })} />
        </td>`)}
        <td class="au-set"><${ValueInput} def=${def} value=${r.value} onChange=${(v) => setRow(i, { value: v })} /></td>
        <td class="au-rowbtns">
          <button type="button" class="au-cellbtn add" title="Add a row below" aria-label="Add a row below" onClick=${() => addAfter(i)}><${Ic} name="plus" size="sm" /></button>
          <button type="button" class="au-cellbtn del" title="Remove this row" aria-label="Remove this row" onClick=${() => setRows(rows.filter((_, k) => k !== i))}><${Ic} name="minus" size="sm" /></button>
        </td>
      </tr>`)}</tbody>
    </table></div>
    ${rows.length === 0 && html`<p class="au-center"><button type="button" class="btn btn-sm btn-ghost" onClick=${() => addAfter(-1)}><${Ic} name="plus" size="sm" />Add a row</button></p>`}
    <p class="small muted au-help"><${Ic} name="info" size="sm" />Rows are checked from the top; the first row whose conditions all match sets the value. An empty condition means "Any"; "None" leaves the setting unchanged.</p>
    <${ErrorNote} error=${error} />
    <${EditButtons} a=${a} saving=${saving} onCancel=${onCancel} onSave=${(enable) => submit(null, enable)} />
  </form>`;
}

// ---------- Battery state of charge control ----------

function socThresholds(c, hour) {
  const lerp = (a, b, f) => a + (b - a) * f;
  if (c.hourA === c.hourB) return { low: c.lowA, high: c.highA };
  const spanAB = (c.hourB - c.hourA + 24) % 24;
  const t = (((hour - c.hourA) % 24) + 24) % 24;
  if (t <= spanAB) return { low: lerp(c.lowA, c.lowB, t / spanAB), high: lerp(c.highA, c.highB, t / spanAB) };
  const f = (t - spanAB) / (24 - spanAB);
  return { low: lerp(c.lowB, c.lowA, f), high: lerp(c.highB, c.highA, f) };
}

/** SOC thresholds over the day: x 40→400 (15 per hour), y 170→20 (SOC 0→100). */
function SocDiagram({ config, soc, gridLabel, batteryLabel }) {
  const x = (h) => 40 + h * 15;
  const y = (s) => 170 - s * 1.5;
  const line = (k) => Array.from({ length: 25 }, (_, h) => [x(h), y(socThresholds(config, h % 24)[k])]);
  const pts = (l) => l.map(([px, py]) => `${px},${py.toFixed(1)}`).join(' ');
  const low = line('low');
  const high = line('high');
  const now = new Date();
  const hNow = now.getHours() + now.getMinutes() / 60;
  return html`<div class="au-soc-chart">
    <svg viewBox="0 0 410 196" class="soc" role="img" aria-label="State of charge thresholds by hour of day">
      ${[0, 25, 50, 75, 100].map((s) => html`<line x1="40" x2="400" y1=${y(s)} y2=${y(s)} class="soc-grid" />
        <text x="34" y=${y(s) + 3.5} text-anchor="end" class="soc-axis">${s}%</text>`)}
      ${Array.from({ length: 9 }, (_, i) => i * 3).map((h) => html`<text x=${x(h)} y="186" text-anchor="middle" class="soc-axis">${pad2(h)}</text>`)}
      <polygon points=${`${pts(low)} 400,170 40,170`} class="soc-fill-grid" />
      <polygon points=${`${pts(high)} 400,20 40,20`} class="soc-fill-batt" />
      <polyline points=${pts(low)} class="soc-low" />
      <polyline points=${pts(high)} class="soc-high" />
      <line x1=${x(hNow)} x2=${x(hNow)} y1="16" y2="170" class="soc-now" />
      ${typeof soc === 'number' && html`<circle cx=${x(hNow)} cy=${y(soc)} r="4.5" class="soc-dot"><title>Battery ${Math.round(soc)}% now</title></circle>`}
    </svg>
    <div class="legend-dots au-soc-legend">
      <span style="--c:var(--battery)">${batteryLabel} over this level</span>
      <span style="--c:var(--grid)">${gridLabel} below this line</span>
      ${typeof soc === 'number' && html`<span style="--c:var(--accent)">Battery now ${Math.round(soc)}%</span>`}
    </div>
  </div>`;
}

const SocHead = ({ label }) => html`<thead><tr><th></th><th>Time of day</th><th>Battery capacity</th><th>${label}</th></tr></thead>`;

function SocShow({ a, soc }) {
  const c = a.config;
  const g = fmtValue(a.settingDef, c.gridValue);
  const b = fmtValue(a.settingDef, c.batteryValue);
  const point = (p, hour, low, high) => html`
    <tr class="row-start"><td rowspan="2" class="au-point"><span class="au-pt">${p}</span></td><td rowspan="2" class="tabular">${pad2(hour)}:00</td><td>${low}% or lower</td><td><span class="au-dot" style="--c:var(--grid)"></span><b>${g}</b></td></tr>
    <tr><td>${high}% or higher</td><td><span class="au-dot" style="--c:var(--battery)"></span><b>${b}</b></td></tr>`;
  return html`<div class="battery-soc">
    <div class="table-wrap"><table class="table au-rules au-soc">
      <${SocHead} label=${a.settingLabel} />
      <tbody>${point('A', c.hourA, c.lowA, c.highA)}${point('B', c.hourB, c.lowB, c.highB)}</tbody>
    </table></div>
    <${SocDiagram} config=${c} soc=${soc} gridLabel=${g} batteryLabel=${b} />
  </div>`;
}

function SocEdit({ a, soc, onCancel, onSaved }) {
  const [c, setC] = useState({ ...a.config });
  const { error, saving, run } = useSaver(a, onSaved);
  const def = a.settingDef;
  const set = (k) => (v) => setC({ ...c, [k]: /^(hour|low|high)/.test(k) ? Number(v) : v });
  const submit = (e, enable = false) => {
    e?.preventDefault();
    run({ config: c }, enable);
  };
  const point = (p) => html`
    <tr class="row-start">
      <td rowspan="2" class="au-point"><span class="au-pt">${p}</span></td>
      <td rowspan="2"><${Select} value=${c[`hour${p}`]} options=${HOURS} onChange=${set(`hour${p}`)} /></td>
      <td><span class="au-inline"><${Select} value=${c[`low${p}`]} options=${socOptions(5, 95, c[`low${p}`]).filter((o) => o.value < c[`high${p}`])} onChange=${set(`low${p}`)} /> or lower</span></td>
      <td>${p === 'A' ? html`<span class="au-inline">Use <${ValueInput} def=${def} value=${c.gridValue} allowNone=${false} onChange=${set('gridValue')} /></span>` : html`<span class="muted">${fmtValue(def, c.gridValue)}</span>`}</td>
    </tr>
    <tr>
      <td><span class="au-inline"><${Select} value=${c[`high${p}`]} options=${socOptions(5, 95, c[`high${p}`]).filter((o) => o.value > c[`low${p}`])} onChange=${set(`high${p}`)} /> or higher</span></td>
      <td>${p === 'A' ? html`<span class="au-inline">Use <${ValueInput} def=${def} value=${c.batteryValue} allowNone=${false} onChange=${set('batteryValue')} /></span>` : html`<span class="muted">${fmtValue(def, c.batteryValue)}</span>`}</td>
    </tr>`;
  return html`<form novalidate class="au-editor" onSubmit=${submit}><div class="battery-soc">
    <div class="table-wrap"><table class="table au-rules au-soc au-edit">
      <${SocHead} label=${a.settingLabel} />
      <tbody>${point('A')}${point('B')}</tbody>
    </table></div>
    <${SocDiagram} config=${c} soc=${soc} gridLabel=${fmtValue(def, c.gridValue)} batteryLabel=${fmtValue(def, c.batteryValue)} />
  </div>
  <${ErrorNote} error=${error} />
  <${EditButtons} a=${a} saving=${saving} onCancel=${onCancel} onSave=${(enable) => submit(null, enable)} /></form>`;
}

// ---------- Battery protection ----------

const SettingLink = ({ label }) => html`<a href="/inverter/settings">${label}</a>`;

function ProtectionShow({ a }) {
  const c = a.config;
  return html`<div class="au-protection">
    <div class="au-step"><span class="chip-ic sm bad"><${Ic} name="battery-warning" size="sm" /></span>
      <div>When the battery reaches <b>${c.soc}%</b> or less, shut down inverter output via the <${SettingLink} label=${a.settingLabel} /> setting (set to <b>${fmtValue(a.settingDef, c.shutdownValue)}</b>)</div></div>
    <div class="au-step"><span class="chip-ic sm battery"><${Ic} name="rotate-ccw" size="sm" /></span>
      <div>When state of charge has recovered (<b>${c.soc + c.hysteresis}%</b>), restore the setting to <b>${fmtValue(a.settingDef, c.restoreValue)}</b></div></div>
    ${a.status.decision.tripped && html`<div class="notice notice-bad small au-note"><${Ic} name="shield-alert" size="sm" />Protection in effect</div>`}
  </div>`;
}

function ProtectionEdit({ a, opts, onCancel, onSaved }) {
  const [c, setC] = useState({ ...a.config });
  const { error, saving, run } = useSaver(a, onSaved);
  const def = opts.settings.find((d) => d.key === c.setting);
  const submit = (e, enable = false) => {
    e?.preventDefault();
    run({ config: c }, enable);
  };
  return html`<form novalidate class="au-protection au-editor" onSubmit=${submit}>
    <div class="au-step"><span class="chip-ic sm bad"><${Ic} name="battery-warning" size="sm" /></span>
      <div class="au-inline">When the battery reaches <${Select} value=${c.soc} options=${socOptions(5, 50, c.soc)} onChange=${(v) => setC({ ...c, soc: Number(v) })} /> or lower,
        shut down inverter output via <${Select} value=${c.setting} options=${opts.settings.map((d) => ({ value: d.key, label: d.label }))}
        onChange=${(v) => setC({ ...c, setting: v, shutdownValue: '', restoreValue: '' })} /> setting, set to
        <${ValueInput} def=${def} value=${c.shutdownValue} allowNone=${false} onChange=${(v) => setC({ ...c, shutdownValue: v })} /></div></div>
    <div class="au-step"><span class="chip-ic sm battery"><${Ic} name="rotate-ccw" size="sm" /></span>
      <div class="au-inline">When state of charge has recovered by <${Select} value=${c.hysteresis}
        options=${[1, 2, 3, 5, 10, 15, 20, c.hysteresis].filter((v, i, l) => l.indexOf(v) === i).sort((x, y) => x - y).map((v) => ({ value: v, label: `${v}%` }))}
        onChange=${(v) => setC({ ...c, hysteresis: Number(v) })} /> (${c.soc + Number(c.hysteresis)}%), restore the setting to
        <${ValueInput} def=${def} value=${c.restoreValue} allowNone=${false} onChange=${(v) => setC({ ...c, restoreValue: v })} /></div></div>
    <${ErrorNote} error=${error} />
    <${EditButtons} a=${a} saving=${saving} onCancel=${onCancel} onSave=${(enable) => submit(null, enable)} />
  </form>`;
}

// ---------- Automations ----------

const CONFIRM_NAME = { table: 'this automation', 'battery-soc': 'battery state of charge control', 'battery-protection': 'battery protection' };
const TYPE_ICON = { table: ['table-2', 'load'], 'battery-soc': ['battery-charging', 'battery'], 'battery-protection': ['shield-check', 'bad'] };
const TYPE_HELP = {
  table: 'Set any setting from a table of conditions: time of day, day of week, battery, grid, price or PV power.',
  'battery-soc': 'Keep the battery between thresholds that change over the day by switching the work mode.',
  'battery-protection': 'Protect the battery when its state of charge gets too low, and restore once it recovers.',
};
const STATE_BADGE = {
  active: ['ok', 'Active'],
  idle: ['info', 'Standby'],
  suspended: ['warn', 'Suspended'],
  unavailable: ['bad', 'Not supported'],
  not_connected: ['muted', 'Offline'],
  disabled: ['muted', 'Disabled'],
};

function summaryOf(a, conds, opts) {
  const c = a.config;
  const v = (x) => fmtValue(a.settingDef, x);
  if (a.type === 'table') {
    const by = c.conditions.map((k) => conds[k]?.label ?? k).join(' and ').toLowerCase();
    const inv = c.inverter !== null && opts.inverterCount > 1 ? ` · Inverter ${c.inverter + 1} only` : '';
    return `Sets ${a.settingLabel} by ${by} · ${c.rows.length} row${c.rows.length === 1 ? '' : 's'}${inv}`;
  }
  if (a.type === 'battery-soc') return `${v(c.gridValue)} at ${c.lowA}–${c.lowB}% or lower, ${v(c.batteryValue)} at ${c.highA}–${c.highB}% or higher`;
  return `${a.settingLabel} → ${v(c.shutdownValue)} at ${c.soc}% or lower, back to ${v(c.restoreValue)} at ${c.soc + c.hysteresis}%`;
}

function AddModal({ open, opts, conds, onClose, onCreated }) {
  const [type, setType] = useState(null);
  const [setting, setSetting] = useState('');
  const [c0, setC0] = useState('time');
  const [c1, setC1] = useState('');
  const [inverter, setInverter] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setType(null);
    setSetting(opts?.primarySetting ?? opts?.settings[0]?.key ?? '');
    setC0('time');
    setC1('');
    setInverter('');
  }, [open]);
  if (!opts) return null;
  const create = async (t, config) => {
    setBusy(true);
    try {
      const res = await api.post('/api/automations', { type: t, enabled: false, config });
      if (res.warning) window.alert(res.warning);
      onCreated(res.automation.id);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (t) => {
    if (t === 'table') return setType('table');
    if (t === 'battery-soc') return create(t, {});
    // Protection defaults: the driver's shutdown setting, else the primary control setting.
    const p = opts.protection;
    const key = p.setting ?? opts.primarySetting ?? opts.settings.find((d) => d.type === 'select')?.key;
    const def = opts.settings.find((d) => d.key === key);
    const current = opts.inverters[0]?.values?.[key];
    const sc = opts.socControl?.setting === key ? opts.socControl : null;
    const shutdown = p.setting === key ? p.shutdownValue : sc?.gridValue ?? def?.options?.[0];
    let restore = sc?.batteryValue ?? current;
    if (restore === undefined || String(restore) === String(shutdown)) restore = def?.options?.find((o) => o !== shutdown) ?? '';
    create(t, { setting: key, soc: 10, hysteresis: 5, shutdownValue: shutdown, restoreValue: restore });
  };
  const condOpts = Object.values(conds).filter((c) => c.available).map((c) => ({ value: c.kind, label: c.label }));
  const add = (e) => {
    e.preventDefault();
    create('table', { setting, inverter: inverter === '' ? null : Number(inverter), conditions: [c0, c1].filter(Boolean), rows: [{ when: c1 ? [null, null] : [null], value: null }] });
  };
  return html`<${Modal} open=${open} title=${type === 'table' ? 'New rule table' : 'Add automation'} onClose=${onClose}>
    ${type === 'table'
      ? html`<form id="type-form" class="au-new" onSubmit=${add}>
          <label class="field"><span class="field-label">Setting to control</span><span class="field-control">
            <${Select} name="setting" value=${setting} options=${opts.settings.map((d) => ({ value: d.key, label: d.label }))} onChange=${setSetting} /></span></label>
          ${opts.inverterCount > 1 && html`<label class="field"><span class="field-label">Inverter</span><span class="field-control">
            <${Select} value=${inverter} options=${[{ value: '', label: 'All inverters' }, ...opts.inverters.map((i) => ({ value: i.index, label: i.label }))]} onChange=${setInverter} /></span></label>`}
          <label class="field"><span class="field-label">Based on</span><span class="field-control">
            <${Select} name="condition_0" value=${c0} options=${condOpts} onChange=${(v) => { setC0(v); if (v === c1) setC1(''); }} /></span></label>
          <label class="field"><span class="field-label">And on</span><span class="field-control">
            <${Select} name="condition_1" value=${c1} options=${[{ value: '', label: '--- Optional ---' }, ...condOpts.filter((o) => o.value !== c0)]} onChange=${setC1} /></span></label>
          ${!opts.settings.length && html`<div class="notice notice-warn small">Connect to the inverter to choose a setting.</div>`}
          <div class="form-actions">
            <button type="button" class="btn" onClick=${() => setType(null)}><${Ic} name="chevron-left" size="sm" />Back</button>
            <button type="submit" class="btn btn-primary" disabled=${busy || !setting}>Add automation</button>
          </div>
        </form>`
      : html`<p class="muted small au-modal-lead">What should the new automation do? It is created disabled, so you can review it first.</p>
        <div class="au-types">${opts.types.map((t) => {
          const [icon, tone] = TYPE_ICON[t.type] ?? ['workflow', 'accent'];
          return html`<button type="button" class="au-type automation-type-button" disabled=${!t.available || busy} onClick=${() => pick(t.type)}>
            <${IconChip} name=${icon} tone=${tone} />
            <span class="au-type-text"><b>${t.name}</b><span>${TYPE_HELP[t.type]}</span>${t.reason && html`<em>${t.reason}</em>`}</span>
            <${Ic} name="chevron-right" size="sm" class="au-type-chev" />
          </button>`;
        })}</div>
        <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button></div>`}
  <//>`;
}

// ---------- Rule vocabulary (labels, icons, defaults) ----------

const TRIGGERS = {
  time: { label: 'Time of day', icon: 'clock', tone: 'load', help: 'At a fixed time, optionally on chosen days' },
  sun: { label: 'Sunrise or sunset', icon: 'sunrise', tone: 'solar', help: 'Relative to sunrise or sunset at your site' },
  metric: { label: 'Measurement', icon: 'gauge', tone: 'battery', help: 'When a value crosses a threshold (incl. device power, temperature)' },
  device: { label: 'Device state', icon: 'plug-zap', tone: 'accent', help: 'When a smart device turns on or off, changes mode …' },
  grid: { label: 'Grid lost or restored', icon: 'utility-pole', tone: 'grid', help: 'When the grid goes down or comes back' },
  price: { label: 'Electricity price', icon: 'piggy-bank', tone: 'accent', help: 'Cheapest or dearest hours, or a price threshold', needs: 'price' },
  forecast: { label: 'Solar forecast', icon: 'cloud-sun', tone: 'solar', help: 'Checks the radiation forecast at a set time', needs: 'forecast' },
  alert: { label: 'Alert raised', icon: 'bell-ring', tone: 'bad', help: 'When a matching alert is raised' },
  interval: { label: 'Every few minutes', icon: 'repeat', tone: 'load', help: 'Periodically, aligned to midnight' },
  manual: { label: 'Manual only', icon: 'hand', tone: '', help: 'Only via Run now or another rule' },
};
const CONDS = {
  time_between: { label: 'Time between', icon: 'clock' },
  days: { label: 'Day of week', icon: 'calendar-days' },
  metric: { label: 'Measurement', icon: 'gauge' },
  device: { label: 'Device state', icon: 'plug-zap' },
  grid: { label: 'Grid availability', icon: 'utility-pole' },
  price: { label: 'Electricity price', icon: 'piggy-bank', needs: 'price' },
  sun: { label: 'Sun up or down', icon: 'sun' },
  forecast: { label: 'Solar forecast', icon: 'cloud-sun', needs: 'forecast' },
  setting: { label: 'Inverter setting', icon: 'cpu' },
  automation: { label: 'Automation state', icon: 'workflow' },
  date_between: { label: 'Date between', icon: 'calendar-range' },
};
const ACTIONS = {
  set_setting: { label: 'Set a setting', icon: 'sliders-horizontal', tone: 'accent' },
  device: { label: 'Control a device', icon: 'plug-zap', tone: 'accent' },
  scene: { label: 'Apply a scene', icon: 'layers', tone: 'grid' },
  notify: { label: 'Send a notification', icon: 'bell', tone: 'solar' },
  mqtt: { label: 'Publish to MQTT', icon: 'radio-tower', tone: 'load' },
  delay: { label: 'Wait', icon: 'hourglass', tone: '' },
  automation: { label: 'Enable or disable an automation', icon: 'toggle-right', tone: 'battery' },
};
const NOTIFY_VARS = ['{soc}', '{pv}', '{load}', '{grid}', '{battery}', '{price}', '{time}', '{rule}'];
const SCENE_ICONS = ['moon', 'sun', 'sunrise', 'sunset', 'zap', 'battery-charging', 'battery-full', 'utility-pole', 'house', 'plug',
  'leaf', 'flame', 'snowflake', 'shield-check', 'piggy-bank', 'car', 'coffee', 'umbrella', 'power', 'rocket'];
const TONES = ['accent', 'solar', 'load', 'grid', 'battery'];
const TONE_LABEL = { accent: 'Orange', solar: 'Yellow', load: 'Blue', grid: 'Purple', battery: 'Green' };
const REQUIRES = {
  price: { icon: 'piggy-bank', label: 'Price data', ok: (o) => o.ruleOptions.priceAvailable },
  forecast: { icon: 'cloud-sun', label: 'Forecast', ok: (o) => o.ruleOptions.forecastAvailable },
  sun: { icon: 'sun', label: 'Site location', ok: (o) => !o.ruleOptions.sunWarning },
  grid: { icon: 'utility-pole', label: 'Grid', ok: () => true },
  battery: { icon: 'battery-charging', label: 'Battery', ok: () => true },
  devices: { icon: 'plug-zap', label: 'Smart devices', ok: (o) => (o.ruleOptions.devices?.entities ?? []).some((e) => e.services.length) },
};
const STATE_BADGE_RULE = {
  active: ['ok', 'Active'], idle: ['info', 'Standby'], suspended: ['warn', 'Suspended'], unavailable: ['bad', 'Not supported'],
  not_connected: ['muted', 'Offline'], disabled: ['muted', 'Disabled'],
};

const writable = (opts) => opts.settings.filter((d) => !d.readOnly);
const defOf = (opts, key) => opts.settings.find((d) => d.key === key);

function defaultValue(def) {
  if (!def) return '';
  switch (def.type) {
    case 'select': return def.options?.[0] ?? '';
    case 'checkbox': return true;
    case 'number': return def.min ?? 0;
    case 'time': return '00:00';
    case 'slot': return ['00:00', '00:00', ...(def.slotPriorities?.length ? [def.slotPriorities[0]] : []), 'true'].join(',');
    default: return '';
  }
}

function newTrigger(kind, opts) {
  const dev = devOpts(opts).entities.find((e) => !e.numeric);
  return {
    device: { kind, entity: dev?.id ?? '', to: statesOf(dev)[0] ?? 'on', forMinutes: 0 },
    time: { kind, at: '07:00' },
    sun: { kind, event: 'sunrise', offsetMinutes: 0 },
    metric: { kind, metric: 'Battery state of charge', op: 'below', value: 20, forMinutes: 0 },
    grid: { kind, event: 'lost' },
    price: { kind, mode: 'cheapest', hours: 3 },
    forecast: { kind, at: '20:00', metric: 'tomorrow_sun', op: 'below', value: 10 },
    alert: { kind, alert: 'battery-low' },
    interval: { kind, everyMinutes: 15 },
    manual: { kind },
  }[kind];
}

function newCondition(kind, opts, list) {
  const d = writable(opts).find((x) => x.type === 'select') ?? writable(opts)[0];
  return {
    time_between: { kind, from: '22:00', to: '06:00' },
    days: { kind, days: [1, 2, 3, 4, 5] },
    metric: { kind, metric: 'Battery state of charge', op: 'below', value: 50 },
    grid: { kind, available: true },
    price: { kind, cheapest_hours: 4 },
    sun: { kind, is: 'up' },
    forecast: { kind, metric: 'tomorrow_sun', op: 'below', value: 10 },
    setting: { kind, inverter: 'all', setting: d?.key ?? '', equals: defaultValue(d) },
    automation: { kind, id: list[0]?.id ?? '', enabled: true },
    date_between: { kind, from: '04-01', to: '09-30' },
    device: (() => {
      const dev = devOpts(opts).entities.find((e) => !e.numeric);
      return { kind, entity: dev?.id ?? '', is: statesOf(dev)[0] ?? 'on' };
    })(),
  }[kind];
}

function newAction(kind, opts, scenes, list) {
  const d = defOf(opts, opts.primarySetting) ?? writable(opts)[0];
  return {
    set_setting: { kind, inverter: 'all', setting: d?.key ?? '', value: defaultValue(d) },
    scene: { kind, scene: scenes[0]?.id ?? '' },
    notify: { kind, channel: 'app', title: 'Sunroost', message: 'Battery at {soc}, solar {pv}.' },
    mqtt: { kind, topic: 'solar/automation', payload: '', retain: false },
    delay: { kind, minutes: 10 },
    automation: { kind, id: list[0]?.id ?? '', enabled: false },
    device: (() => {
      const dev = devOpts(opts).entities.find((e) => e.services.length);
      return { kind, target: dev?.id ?? '', service: dev?.services.includes('turn_on') ? 'turn_on' : dev?.services[0] ?? 'turn_on', data: {} };
    })(),
  }[kind];
}

const blankRule = () => ({
  type: 'rule',
  name: '',
  enabled: false,
  config: {
    description: '',
    priority: 50,
    triggers: [{ kind: 'time', at: '07:00' }],
    conditions: { op: 'and', items: [] },
    actions: [],
    elseActions: [],
    options: { cooldownMinutes: 5, maxRunsPerDay: 0, revertAfterMinutes: 0 },
  },
});

// ---------- Human sentence (mirrors src/automation/rules.ts summarize) ----------

function makeDescriber(opts, scenes, list) {
  const ro = opts.ruleOptions;
  const unitOf = (m) => metricUnit(opts, m);
  const f = (n) => (n === '' || n === null || n === undefined || Number.isNaN(Number(n)) ? '…' : `${Math.round(Number(n) * 100) / 100}`);
  const wu = (n, m) => {
    const u = unitOf(m);
    return `${f(n)}${u === '%' ? '%' : u ? ' ' + u : ''}`;
  };
  const dayList = (d = []) => {
    const s = [...d].sort().join();
    return d.length === 7 ? 'every day' : s === '1,2,3,4,5' ? 'on weekdays' : s === '0,6' ? 'at weekends' : d.length ? `on ${DAY_ORDER.filter((x) => d.includes(x)).map((x) => DAYS[x]).join(', ')}` : 'on no days';
  };
  const offset = (m) => (Number(m) === 0 ? 'at' : `${Math.abs(m)} min ${m < 0 ? 'before' : 'after'}`);
  const metricL = (m) => (isEntity(m) ? devName(opts, m) : String(m || 'a measurement').toLowerCase());
  const alertTitle = (id) => ro.alerts.find((a) => a.id === id)?.title ?? id;
  const autoName = (id) => {
    const a = list.find((x) => x.id === Number(id));
    return a ? `"${a.name || a.typeName}"` : `#${id}`;
  };
  const trigger = (t) => {
    switch (t.kind) {
      case 'time': return `at ${t.at || '…'}${t.days?.length ? ' ' + dayList(t.days) : ''}`;
      case 'sun': return `${offset(t.offsetMinutes)} ${t.event}`;
      case 'metric': return `when ${metricL(t.metric)} ${t.op === 'above' ? 'rises above' : 'drops below'} ${wu(t.value, t.metric)}${Number(t.forMinutes) ? ` for ${t.forMinutes} min` : ''}`;
      case 'grid': return t.event === 'lost' ? 'when the grid is lost' : 'when the grid is restored';
      case 'price': return t.mode
        ? `at the start of each of the ${t.hours} ${t.mode === 'cheapest' ? 'cheapest' : 'most expensive'} hours of the day`
        : `when the price ${t.op === 'above' ? 'rises above' : 'drops below'} ${f(t.value)}`;
      case 'forecast': return `at ${t.at} if ${t.metric === 'today_sun' ? "today's" : "tomorrow's"} solar forecast is ${t.op} ${f(t.value)} MJ/m²`;
      case 'alert': return t.alert ? `when the "${alertTitle(t.alert)}" alert is raised` : `when a ${t.level === 'bad' ? 'critical' : 'warning'} alert is raised`;
      case 'interval': return `every ${t.everyMinutes} min`;
      case 'manual': return 'when run manually';
      case 'device': {
        const change = t.to ? `${t.from ? `changes from ${human(t.from)} to` : 'turns'} ${human(t.to)}` : `changes${t.from ? ` from ${human(t.from)}` : ''}`;
        return `when ${devName(opts, t.entity)} ${change}${t.to && Number(t.forMinutes) ? ` for ${t.forMinutes} min` : ''}`;
      }
      default: return t.kind;
    }
  };
  const condition = (c) => {
    switch (c.kind) {
      case 'time_between': return `between ${c.from} and ${c.to}`;
      case 'days': return dayList(c.days);
      case 'date_between': return `between ${c.from} and ${c.to} (date)`;
      case 'metric': return c.op === 'between'
        ? `${metricL(c.metric)} is between ${wu(c.value, c.metric)} and ${wu(c.value2, c.metric)}`
        : `${metricL(c.metric)} is ${c.op} ${wu(c.value, c.metric)}`;
      case 'grid': return c.available ? 'the grid is available' : 'the grid is down';
      case 'price': return !isNone(c.cheapest_hours) ? `now is among the ${c.cheapest_hours} cheapest hours` : `the price is ${c.op} ${f(c.value)}`;
      case 'sun': return `the sun is ${c.is}`;
      case 'forecast': return `${c.metric === 'today_sun' ? "today's" : "tomorrow's"} solar forecast is ${c.op} ${f(c.value)} MJ/m²`;
      case 'setting': {
        const d = defOf(opts, c.setting);
        return `${d?.label ?? (c.setting || 'a setting')} is ${fmtValue(d, c.equals)}`;
      }
      case 'automation': return `automation ${autoName(c.id)} is ${c.enabled ? 'enabled' : 'disabled'}`;
      case 'device': return `${devName(opts, c.entity)} is ${c.not ? 'not ' : ''}${human(c.is || '…')}`;
      default: return c.kind;
    }
  };
  const group = (g, nested) => {
    const parts = g.items.map((it) => (it.items ? group(it, true) : condition(it)));
    const j = parts.join(g.op === 'and' ? ' and ' : ' or ');
    return nested && parts.length > 1 ? `(${j})` : j;
  };
  const action = (a) => {
    switch (a.kind) {
      case 'set_setting': {
        const d = defOf(opts, a.setting);
        return `set ${d?.label ?? (a.setting || 'a setting')} to ${fmtValue(d, a.value)}${a.inverter === 'all' || isNone(a.inverter) ? '' : ` on inverter ${Number(a.inverter) + 1}`}`;
      }
      case 'scene': return `apply scene "${scenes.find((s) => s.id === Number(a.scene))?.name ?? `#${a.scene}`}"`;
      case 'notify': return a.channel === 'app' ? 'send an app notification' : `notify via ${a.channel}`;
      case 'mqtt': return `publish to MQTT ${a.topic || '…'}`;
      case 'delay': return `wait ${a.minutes} min`;
      case 'automation': return `${a.enabled ? 'enable' : 'disable'} automation ${autoName(a.id)}`;
      case 'device': return describeDevice(a, devName(opts, a.target));
      default: return a.kind;
    }
  };
  const join = (p) => (p.length <= 1 ? p.join('') : `${p.slice(0, -1).join(', ')} and ${p.at(-1)}`);
  const summary = (cfg) => {
    const when = cfg.triggers.map(trigger).join(' or ') || 'never (add a trigger)';
    const cond = cfg.conditions.items.length ? `, if ${group(cfg.conditions)}` : '';
    const acts = join(cfg.actions.map(action));
    const otherwise = cfg.elseActions.length ? `; otherwise ${join(cfg.elseActions.map(action))}` : '';
    const revert = Number(cfg.options.revertAfterMinutes) ? `, reverting after ${cfg.options.revertAfterMinutes} min` : '';
    const s = `${when}${cond}, ${acts || 'do nothing'}${revert}${otherwise}.`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  return { trigger, condition, action, summary };
}

/** Icon + tone for a rule, from its first trigger. */
const ruleIcon = (a) => {
  const t = TRIGGERS[a.config?.triggers?.[0]?.kind] ?? { icon: 'workflow', tone: 'accent' };
  return [t.icon, t.tone || 'accent'];
};

// ---------- Rule builder: inputs ----------

/** Labelled control inside a builder card (label above, stacks naturally on phones). */
const F = ({ label, wide, children }) => html`<label class=${`au-f ${wide ? 'wide' : ''}`}><span>${label}</span>${children}</label>`;

const numIn = (v) => (v === '' || v === null || v === undefined ? '' : v);
const toNum = (s) => (s === '' ? '' : Number(s));

function NumInput({ value, onChange, unit, min, max, step = 'any', label }) {
  return html`<span class="au-unit"><input type="number" inputmode="decimal" aria-label=${label} value=${numIn(value)} min=${min} max=${max} step=${step}
    onInput=${(e) => onChange(toNum(e.target.value))} />${unit && html`<span>${unit}</span>`}</span>`;
}

function MetricSelect({ opts, value, onChange }) {
  const ro = opts.ruleOptions;
  const list = [...ro.metrics.map((m) => ({ value: m.name, label: m.unit ? `${m.name} (${m.unit})` : m.name }))];
  if (ro.priceAvailable) list.push({ value: 'Price', label: `Price (${ro.priceUnit})` });
  if (ro.outageAvailable) list.push({ value: 'Planned outage in', label: 'Planned outage in (min)' });
  // Device readings (plug power, room temperature …) by entity id.
  for (const e of devOpts(opts).entities.filter((x) => x.numeric)) list.push({ value: e.id, label: `Device: ${e.name}${e.unit ? ` (${e.unit})` : ''}` });
  if (value && !list.some((o) => o.value === value)) list.push({ value, label: value });
  return html`<${Select} value=${value} options=${list} onChange=${onChange} />`;
}
const metricUnit = (opts, m) => (m === 'Planned outage in' ? 'min' : m === 'Price' ? opts.ruleOptions.priceUnit
  : isEntity(m) ? devOf(opts, m)?.unit ?? '' : opts.ruleOptions.metrics.find((x) => x.name === m)?.unit ?? '');

const OPS = [{ value: 'above', label: 'Above' }, { value: 'below', label: 'Below' }];

/** Value input that matches a SettingDef (select / number / checkbox / time / slot). */
function ValueField({ def, value, onChange }) {
  if (!def) return html`<input value=${value ?? ''} placeholder="Value" onInput=${(e) => onChange(e.target.value)} />`;
  switch (def.type) {
    case 'select':
      return html`<${Select} value=${value ?? ''} options=${[...(isNone(value) ? [{ value: '', label: 'Choose…' }] : []), ...(def.options ?? [])]} onChange=${onChange} />`;
    case 'checkbox':
      return html`<${Select} value=${String(value === true || value === 'true')} options=${[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }]}
        onChange=${(v) => onChange(v === 'true')} />`;
    case 'number':
      return html`<${NumInput} value=${value} unit=${def.unit} min=${def.min} max=${def.max} step=${def.step ?? 'any'} onChange=${onChange} />`;
    case 'time':
      return html`<input type="time" value=${value ?? ''} onInput=${(e) => onChange(e.target.value)} />`;
    case 'slot':
      return html`<span class="au-slot"><${SettingInput} def=${def} value=${value || defaultValue(def)} onChange=${onChange} /></span>`;
    default:
      return html`<input value=${value ?? ''} onInput=${(e) => onChange(e.target.value)} />`;
  }
}

function InverterSelect({ opts, value, onChange }) {
  if (opts.inverterCount <= 1) return null;
  return html`<${F} label="Inverter"><${Select} value=${isNone(value) ? 'all' : String(value)}
    options=${[{ value: 'all', label: 'All inverters' }, ...opts.inverters.map((i) => ({ value: String(i.index), label: i.label }))]}
    onChange=${(v) => onChange(v === 'all' ? 'all' : Number(v))} /><//>`;
}

function SettingPick({ opts, value, onChange }) {
  const list = writable(opts);
  if (!list.length) return html`<input value=${value ?? ''} placeholder="Setting key" onInput=${(e) => onChange(e.target.value)} />`;
  const o = list.map((d) => ({ value: d.key, label: d.label }));
  if (value && !o.some((x) => x.value === value)) o.unshift({ value, label: value });
  return html`<${Select} value=${value} options=${o} onChange=${onChange} />`;
}

function AutomationPick({ list, selfId, value, onChange }) {
  const o = list.filter((a) => a.id !== selfId).map((a) => ({ value: String(a.id), label: `#${a.id} ${a.name || a.typeName}` }));
  if (!o.length) return html`<span class="muted small">No other automations yet</span>`;
  return html`<${Select} value=${String(value ?? '')} options=${[...(isNone(value) ? [{ value: '', label: 'Choose…' }] : []), ...o]} onChange=${(v) => onChange(Number(v))} />`;
}

// ---------- Rule builder: smart devices ----------

const isEntity = (m) => /^[a-z0-9_]+\.[a-z0-9_]+$/.test(String(m ?? ''));
const devOpts = (opts) => opts.ruleOptions.devices ?? { entities: [], areas: [], roles: [] };
const devOf = (opts, id) => devOpts(opts).entities.find((e) => e.id === id);
const human = (s) => String(s ?? '').replace(/_/g, ' ');
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Name of a device, room or role target, like the server's summaries. */
function devName(opts, t) {
  if (!t) return 'a device';
  if (t.startsWith('role:')) return `every ${t.slice(5)} device`;
  if (t.startsWith('area:')) return `everything in ${devOpts(opts).areas.find((a) => a.id === t.slice(5))?.name ?? t.slice(5)}`;
  return devOf(opts, t)?.name ?? t;
}

/** Mirrors describeDeviceAction in src/automation/rules.ts. */
function describeDevice(a, name) {
  const v = (k) => human(a.data?.[k] ?? '…');
  switch (a.service) {
    case 'turn_on': return `turn on ${name}${a.data?.brightness !== undefined ? ` at ${Math.round((Number(a.data.brightness) / 255) * 100)}%` : ''}${a.autoOffMinutes ? ` for ${a.autoOffMinutes} min` : ''}`;
    case 'turn_off': return `turn off ${name}`;
    case 'toggle': return `toggle ${name}`;
    case 'set_temperature': return `set ${name} to ${v('temperature')}°${a.data?.hvac_mode ? ` (${v('hvac_mode')})` : ''}`;
    case 'set_hvac_mode': return `set ${name} to ${v('hvac_mode')}`;
    case 'set_value': return `set ${name} to ${v('value')}`;
    case 'select_option': return `set ${name} to ${v('option')}`;
    case 'set_percentage': return `set ${name} to ${v('percentage')}%`;
    default: return `${human(a.service || 'control')} ${name}`;
  }
}

/** States a device can be in (for triggers and conditions). */
function statesOf(e) {
  if (!e) return [];
  const a = e.attributes ?? {};
  const base = {
    switch: ['on', 'off'], light: ['on', 'off'], fan: ['on', 'off'], group: ['on', 'off'], binary_sensor: ['on', 'off'],
    lock: ['locked', 'unlocked', 'jammed'], cover: ['open', 'closed', 'opening', 'closing'],
    media_player: ['on', 'off', 'playing', 'paused', 'idle'], vacuum: ['cleaning', 'docked', 'returning', 'idle', 'paused', 'error'],
    climate: a.hvac_modes ?? ['off', 'heat', 'cool', 'auto'], select: a.options ?? [],
  }[e.domain] ?? (e.state && !e.numeric ? [e.state] : []);
  return [...new Set([...base, 'unavailable'])];
}

const SERVICE_LABEL = {
  turn_on: 'Turn on', turn_off: 'Turn off', toggle: 'Toggle', set_temperature: 'Set temperature', set_hvac_mode: 'Set mode',
  set_fan_mode: 'Set fan mode', set_value: 'Set value', select_option: 'Choose option', set_percentage: 'Set speed',
  open_cover: 'Open', close_cover: 'Close', stop_cover: 'Stop', set_cover_position: 'Set position', lock: 'Lock', unlock: 'Unlock',
  press: 'Press', start: 'Start', stop: 'Stop', pause: 'Pause', return_to_base: 'Return to dock', open_valve: 'Open', close_valve: 'Close',
};
const GENERIC = ['turn_on', 'turn_off', 'toggle'];

function DevicePick({ opts, value, onChange, filter = () => true }) {
  const o = devOpts(opts).entities.filter(filter).map((e) => ({ value: e.id, label: e.device && !e.name.startsWith(e.device) ? `${e.device} · ${e.name}` : e.name }));
  if (value && !o.some((x) => x.value === value)) o.unshift({ value, label: value });
  return html`<${Select} value=${value ?? ''} options=${[...(value ? [] : [{ value: '', label: 'Choose a device…' }]), ...o]} onChange=${onChange} />`;
}

function StatePick({ entity, value, onChange, anyLabel }) {
  const o = statesOf(entity).map((st) => ({ value: st, label: capFirst(human(st)) }));
  if (anyLabel) o.unshift({ value: '', label: anyLabel });
  if (value && !o.some((x) => x.value === value)) o.push({ value, label: capFirst(human(value)) });
  return o.length > (anyLabel ? 1 : 0)
    ? html`<${Select} value=${value ?? ''} options=${o} onChange=${onChange} />`
    : html`<input value=${value ?? ''} placeholder="State, e.g. on" onInput=${(e) => onChange(e.target.value)} />`;
}

function DeviceTriggerFields({ t, set, opts }) {
  const e = devOf(opts, t.entity);
  return html`<${F} label="Device" wide><${DevicePick} opts=${opts} value=${t.entity} filter=${(x) => !x.numeric}
      onChange=${(v) => set({ entity: v, to: statesOf(devOf(opts, v))[0] ?? 'on', from: undefined })} /><//>
    <${F} label="Turns"><${StatePick} entity=${e} value=${t.to ?? ''} anyLabel="Any change" onChange=${(v) => set({ to: v || undefined })} /><//>
    <${F} label="From"><${StatePick} entity=${e} value=${t.from ?? ''} anyLabel="Any state" onChange=${(v) => set({ from: v || undefined })} /><//>
    ${t.to && html`<${F} label="For at least"><${NumInput} value=${t.forMinutes} unit="min" min="0" max="1440" step="1" onChange=${(v) => set({ forMinutes: v })} /><//>`}
    <p class="au-fnote muted small"><${Ic} name="info" size="sm" />For a device's power or temperature, use a Measurement trigger: device readings are listed there.</p>`;
}

function DeviceConditionFields({ c, set, opts }) {
  const e = devOf(opts, c.entity);
  return html`<${F} label="Device" wide><${DevicePick} opts=${opts} value=${c.entity} filter=${(x) => !x.numeric}
      onChange=${(v) => set({ entity: v, is: statesOf(devOf(opts, v))[0] ?? 'on' })} /><//>
    <${F} label="Is"><${Select} value=${c.not ? 'not' : 'is'} options=${[{ value: 'is', label: 'Is' }, { value: 'not', label: 'Is not' }]}
      onChange=${(v) => set({ not: v === 'not' ? true : undefined })} /><//>
    <${F} label="State"><${StatePick} entity=${e} value=${c.is} onChange=${(v) => set({ is: v })} /><//>`;
}

/** The input a command needs: a mode, a temperature, a value … */
function ServiceData({ a, e, set }) {
  const at = e?.attributes ?? {};
  const data = a.data ?? {};
  const put = (k, v) => set({ data: { ...data, [k]: v === '' || v === undefined ? undefined : v } });
  switch (a.service) {
    case 'set_temperature':
      return html`<${F} label="Temperature"><${NumInput} value=${data.temperature} unit="°" min=${at.min_temp} max=${at.max_temp} step=${at.target_temp_step ?? 0.5} onChange=${(v) => put('temperature', v)} /><//>`;
    case 'set_hvac_mode':
      return html`<${F} label="Mode"><${Select} value=${data.hvac_mode ?? ''} options=${[{ value: '', label: 'Choose…' }, ...(at.hvac_modes ?? ['off', 'heat', 'cool', 'auto']).map((m) => ({ value: m, label: capFirst(human(m)) }))]} onChange=${(v) => put('hvac_mode', v)} /><//>`;
    case 'set_fan_mode':
      return html`<${F} label="Fan mode"><${Select} value=${data.fan_mode ?? ''} options=${[{ value: '', label: 'Choose…' }, ...(at.fan_modes ?? []).map((m) => ({ value: m, label: capFirst(human(m)) }))]} onChange=${(v) => put('fan_mode', v)} /><//>`;
    case 'set_value':
      return html`<${F} label="Value"><${NumInput} value=${data.value} unit=${e?.unit ?? ''} min=${at.min} max=${at.max} step=${at.step ?? 'any'} onChange=${(v) => put('value', v)} /><//>`;
    case 'select_option':
      return html`<${F} label="Option"><${Select} value=${data.option ?? ''} options=${[{ value: '', label: 'Choose…' }, ...(at.options ?? [])]} onChange=${(v) => put('option', v)} /><//>`;
    case 'set_percentage':
      return html`<${F} label="Speed"><${NumInput} value=${data.percentage} unit="%" min="0" max="100" step="1" onChange=${(v) => put('percentage', v)} /><//>`;
    case 'set_cover_position':
      return html`<${F} label="Position"><${NumInput} value=${data.position} unit="%" min="0" max="100" step="1" onChange=${(v) => put('position', v)} /><//>`;
    case 'turn_on':
      return e?.domain === 'light' && at.supports_brightness
        ? html`<${F} label="Brightness (optional)"><${NumInput} value=${data.brightness === undefined ? '' : Math.round((data.brightness / 255) * 100)} unit="%" min="1" max="100" step="1"
            onChange=${(v) => put('brightness', v === '' ? undefined : Math.round((Number(v) / 100) * 255))} /><//>`
        : null;
    default:
      return null;
  }
}

function DeviceActionFields({ a, set, opts }) {
  const d = devOpts(opts);
  const controllable = d.entities.filter((e) => e.services.length);
  const isGroupTarget = a.target?.startsWith('role:') || a.target?.startsWith('area:');
  const e = isGroupTarget ? null : devOf(opts, a.target);
  const members = a.target?.startsWith('role:') ? controllable.filter((x) => x.role === a.target.slice(5))
    : a.target?.startsWith('area:') ? controllable.filter((x) => x.areaId === a.target.slice(5)) : e ? [e] : [];
  const services = isGroupTarget ? GENERIC : e?.services ?? [];
  const targets = [
    ...(a.target ? [] : [{ value: '', label: 'Choose…' }]),
    ...controllable.map((x) => ({ value: x.id, label: x.device && !x.name.startsWith(x.device) ? `${x.device} · ${x.name}` : x.name })),
    ...d.areas.map((r) => ({ value: `area:${r.id}`, label: `Room: everything in ${r.name}` })),
    ...d.roles.map((r) => ({ value: `role:${r}`, label: `Energy role: every ${r} device` })),
  ];
  const pickTarget = (t) => {
    const next = t.startsWith('role:') || t.startsWith('area:') ? GENERIC : devOf(opts, t)?.services ?? [];
    set({ target: t, service: next.includes(a.service) ? a.service : next.includes('turn_on') ? 'turn_on' : next[0] ?? 'turn_on', data: {} });
  };
  const hasProtected = members.some((x) => x.role === 'protected') || a.target === 'role:protected';
  const critical = members.some((x) => x.role === 'critical') && ['turn_off', 'toggle', 'close_valve', 'close_cover', 'stop'].includes(a.service);
  return html`<${F} label="Device, room or energy role" wide><${Select} value=${a.target ?? ''} options=${targets} onChange=${pickTarget} /><//>
    <${F} label="Do"><${Select} value=${a.service} options=${services.map((sv) => ({ value: sv, label: SERVICE_LABEL[sv] ?? capFirst(human(sv)) }))}
      onChange=${(v) => set({ service: v, data: {} })} /><//>
    <${ServiceData} a=${a} e=${e} set=${set} />
    ${a.service === 'turn_on' && html`<${F} label="Switch off again after (optional)"><${NumInput} value=${a.autoOffMinutes ?? ''} unit="min" min="1" max="1440" step="1"
      onChange=${(v) => set({ autoOffMinutes: v === '' ? undefined : v })} /><//>
      ${a.autoOffMinutes && html`<p class="au-fnote muted small"><${Ic} name="timer" size="sm" />${members.some((x) => x.attributes?.supports_auto_off)
        ? 'Timed by the device itself where it can, so it switches off even if Sunroost is down.'
        : 'Sunroost switches it off when the time is up.'}</p>`}`}
    ${isGroupTarget && html`<p class="au-fnote muted small"><${Ic} name="info" size="sm" />${members.length
      ? `Now: ${members.map((x) => x.name).join(', ')}. Devices you add to it later are included automatically.`
      : 'No device matches yet; give devices a room or an energy role on the Smart devices page.'}</p>`}
    ${hasProtected && html`<div class="au-f wide"><span>Protected devices</span>
      <${Toggle} checked=${a.allowProtected === true} onChange=${(v) => set({ allowProtected: v || undefined })} label="Allow this action to switch protected devices (transfer switch, charger)" /></div>`}
    ${critical && html`<p class="au-fnote text-warn small"><${Ic} name="shield" size="sm" />Critical devices are never switched off by automations; they will be skipped.</p>`}`;
}

// ---------- Rule builder: cards ----------

/** One editable item (trigger / condition / action): icon chip, label, tools, fields, inline error. */
function ItemCard({ icon, tone, title, index, error, tools, onRemove, children }) {
  return html`<div class=${`au-item ${error ? 'has-err' : ''}`}>
    <div class="au-item-head">
      ${index !== undefined && html`<span class="au-ord">${index}</span>`}
      <${IconChip} name=${icon} tone=${tone} small />
      <b class="au-item-title">${title}</b>
      <span class="au-item-tools">${tools}
        ${onRemove && html`<button type="button" class="icon-btn au-ibtn" aria-label=${`Remove ${title}`} title="Remove" onClick=${onRemove}><${Ic} name="x" size="sm" /></button>`}</span>
    </div>
    <div class="au-fields">${children}</div>
    ${error && html`<div class="au-item-err"><${Ic} name="circle-alert" size="sm" />${error}</div>`}
  </div>`;
}

/** "+ Add …" button that opens a menu of kinds. */
function AddMenu({ label, kinds, meta, onPick, available = () => true }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  return html`<div class="au-add" ref=${ref}>
    <button type="button" class="btn btn-sm au-add-btn" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Ic} name="plus" size="sm" />${label}</button>
    ${open && html`<div class="au-menu-pop au-add-pop" role="menu">${kinds.map((k) => {
      const why = available(k);
      return html`<button type="button" role="menuitem" disabled=${why !== true} title=${why === true ? '' : why} onClick=${() => { setOpen(false); onPick(k); }}>
        <${Ic} name=${meta[k].icon} size="sm" /><span><b>${meta[k].label}</b>${why !== true ? html`<small>${why}</small>` : meta[k].help && html`<small>${meta[k].help}</small>`}</span></button>`;
    })}</div>`}
  </div>`;
}

function TriggerFields({ t, set, opts }) {
  const ro = opts.ruleOptions;
  switch (t.kind) {
    case 'time':
      return html`<${F} label="At"><input type="time" value=${t.at} onInput=${(e) => set({ at: e.target.value })} /><//>
        <${F} label="Days (none = every day)" wide><${DayChips} value=${t.days ?? []} onChange=${(d) => set({ days: d })} /><//>`;
    case 'sun': {
      const off = Number(t.offsetMinutes) || 0;
      const lim = Math.max(180, Math.abs(off));
      return html`<${F} label="Event"><${Select} value=${t.event} options=${[{ value: 'sunrise', label: 'Sunrise' }, { value: 'sunset', label: 'Sunset' }]} onChange=${(v) => set({ event: v })} /><//>
        <${F} label=${`Offset: ${off === 0 ? 'exactly at' : `${Math.abs(off)} min ${off < 0 ? 'before' : 'after'}`}`} wide>
          <span class="au-range"><input type="range" min=${-lim} max=${lim} step="5" value=${off} onInput=${(e) => set({ offsetMinutes: Number(e.target.value) })} />
          <${NumInput} value=${off} unit="min" min="-720" max="720" step="1" label="Offset minutes" onChange=${(v) => set({ offsetMinutes: v })} /></span><//>
        ${ro.sun ? html`<p class="au-fnote muted small"><${Ic} name="sun" size="sm" />Today: sunrise ${ro.sun.sunrise}, sunset ${ro.sun.sunset}</p>`
          : ro.sunWarning && html`<p class="au-fnote text-warn small"><${Ic} name="triangle-alert" size="sm" />${ro.sunWarning}</p>`}`;
    }
    case 'metric':
      return html`<${F} label="Measurement" wide><${MetricSelect} opts=${opts} value=${t.metric} onChange=${(v) => set({ metric: v })} /><//>
        <${F} label="Crosses"><${Select} value=${t.op} options=${[{ value: 'above', label: 'Rises above' }, { value: 'below', label: 'Drops below' }]} onChange=${(v) => set({ op: v })} /><//>
        <${F} label="Value"><${NumInput} value=${t.value} unit=${metricUnit(opts, t.metric)} onChange=${(v) => set({ value: v })} /><//>
        <${F} label="For at least"><${NumInput} value=${t.forMinutes} unit="min" min="0" max="1440" step="1" onChange=${(v) => set({ forMinutes: v })} /><//>`;
    case 'grid':
      return html`<${F} label="When the grid is"><${Select} value=${t.event} options=${[{ value: 'lost', label: 'Lost' }, { value: 'restored', label: 'Restored' }]} onChange=${(v) => set({ event: v })} /><//>`;
    case 'price': {
      const mode = t.mode || t.op || 'cheapest';
      const pick = (m) => set(m === 'cheapest' || m === 'most_expensive' ? { mode: m, hours: t.hours || 3, op: undefined, value: undefined } : { mode: undefined, hours: undefined, op: m, value: t.value ?? 0 });
      return html`<${F} label="Fire"><${Select} value=${mode} onChange=${pick} options=${[
          { value: 'cheapest', label: 'In the cheapest hours' }, { value: 'most_expensive', label: 'In the most expensive hours' },
          { value: 'below', label: 'When the price drops below' }, { value: 'above', label: 'When the price rises above' }]} /><//>
        ${t.mode ? html`<${F} label="Hours per day"><${NumInput} value=${t.hours} unit="h" min="1" max="23" step="1" onChange=${(v) => set({ hours: v })} /><//>`
          : html`<${F} label="Price"><${NumInput} value=${t.value} unit=${ro.priceUnit} onChange=${(v) => set({ value: v })} /><//>`}
        ${!ro.priceAvailable && html`<p class="au-fnote text-warn small"><${Ic} name="triangle-alert" size="sm" />No day-ahead price provider is configured, so this trigger never fires.</p>`}`;
    }
    case 'forecast':
      return html`<${F} label="Check at"><input type="time" value=${t.at} onInput=${(e) => set({ at: e.target.value })} /><//>
        <${F} label="Forecast"><${Select} value=${t.metric} options=${[{ value: 'tomorrow_sun', label: "Tomorrow's sun" }, { value: 'today_sun', label: "Today's sun" }]} onChange=${(v) => set({ metric: v })} /><//>
        <${F} label="Is"><${Select} value=${t.op} options=${OPS} onChange=${(v) => set({ op: v })} /><//>
        <${F} label="Radiation"><${NumInput} value=${t.value} unit="MJ/m²" min="0" max="100" onChange=${(v) => set({ value: v })} /><//>
        ${ro.forecastAvailable
          ? html`<p class="au-fnote muted small"><${Ic} name="cloud-sun" size="sm" />Now: today ${ro.forecast?.today_sun ?? '–'}, tomorrow ${ro.forecast?.tomorrow_sun ?? '–'} MJ/m²</p>`
          : html`<p class="au-fnote text-warn small"><${Ic} name="triangle-alert" size="sm" />No weather forecast is available yet (site location needed).</p>`}`;
    case 'alert': {
      const v = t.alert ? `alert:${t.alert}` : `level:${t.level ?? 'bad'}`;
      const o = [{ value: 'level:bad', label: 'Any critical alert' }, { value: 'level:warn', label: 'Any warning' },
        ...ro.alerts.map((a) => ({ value: `alert:${a.id}`, label: a.title }))];
      if (t.alert && !ro.alerts.some((a) => a.id === t.alert)) o.push({ value: v, label: t.alert });
      return html`<${F} label="Alert" wide><${Select} value=${v} options=${o} onChange=${(x) => {
        const [k, id] = x.split(':');
        set(k === 'alert' ? { alert: id, level: undefined } : { level: id, alert: undefined });
      }} /><//>`;
    }
    case 'interval':
      return html`<${F} label="Every"><${NumInput} value=${t.everyMinutes} unit="min" min="5" max="1440" step="1" onChange=${(v) => set({ everyMinutes: v })} /><//>
        <p class="au-fnote muted small"><${Ic} name="info" size="sm" />Runs at multiples from midnight (every 15 → :00, :15, :30, :45).</p>`;
    case 'manual':
      return html`<p class="au-fnote muted small"><${Ic} name="info" size="sm" />Only runs with Run now, or when another rule enables it.</p>`;
    case 'device':
      return html`<${DeviceTriggerFields} t=${t} set=${set} opts=${opts} />`;
    default:
      return null;
  }
}

function ConditionFields({ c, set, opts, list, selfId }) {
  const ro = opts.ruleOptions;
  switch (c.kind) {
    case 'time_between':
      return html`<${F} label="From"><input type="time" value=${c.from} onInput=${(e) => set({ from: e.target.value })} /><//>
        <${F} label="To"><input type="time" value=${c.to} onInput=${(e) => set({ to: e.target.value })} /><//>`;
    case 'days':
      return html`<${F} label="Days" wide><${DayChips} value=${c.days ?? []} onChange=${(d) => set({ days: d })} /><//>`;
    case 'date_between':
      return html`<${F} label="From (MM-DD)"><input value=${c.from} placeholder="04-01" maxlength="5" onInput=${(e) => set({ from: e.target.value })} /><//>
        <${F} label="To (MM-DD)"><input value=${c.to} placeholder="09-30" maxlength="5" onInput=${(e) => set({ to: e.target.value })} /><//>`;
    case 'metric': {
      const u = metricUnit(opts, c.metric);
      return html`<${F} label="Measurement" wide><${MetricSelect} opts=${opts} value=${c.metric} onChange=${(v) => set({ metric: v })} /><//>
        <${F} label="Is"><${Select} value=${c.op} options=${[...OPS, { value: 'between', label: 'Between' }]} onChange=${(v) => set({ op: v, value2: v === 'between' ? c.value2 ?? c.value : undefined })} /><//>
        <${F} label=${c.op === 'between' ? 'From' : 'Value'}><${NumInput} value=${c.value} unit=${u} onChange=${(v) => set({ value: v })} /><//>
        ${c.op === 'between' && html`<${F} label="To"><${NumInput} value=${c.value2} unit=${u} onChange=${(v) => set({ value2: v })} /><//>`}`;
    }
    case 'grid':
      return html`<${F} label="Grid is"><${Select} value=${String(c.available)} options=${[{ value: 'true', label: 'Available' }, { value: 'false', label: 'Down' }]} onChange=${(v) => set({ available: v === 'true' })} /><//>`;
    case 'price': {
      const mode = !isNone(c.cheapest_hours) ? 'cheapest' : c.op ?? 'below';
      return html`<${F} label="Price"><${Select} value=${mode} options=${[{ value: 'cheapest', label: 'Now is among the cheapest hours' }, { value: 'below', label: 'Below' }, { value: 'above', label: 'Above' }]}
          onChange=${(m) => set(m === 'cheapest' ? { cheapest_hours: c.cheapest_hours || 4, op: undefined, value: undefined } : { cheapest_hours: undefined, op: m, value: c.value ?? 0 })} /><//>
        ${mode === 'cheapest' ? html`<${F} label="Cheapest hours"><${NumInput} value=${c.cheapest_hours} unit="h" min="1" max="23" step="1" onChange=${(v) => set({ cheapest_hours: v })} /><//>`
          : html`<${F} label="Value"><${NumInput} value=${c.value} unit=${ro.priceUnit} onChange=${(v) => set({ value: v })} /><//>`}`;
    }
    case 'sun':
      return html`<${F} label="The sun is"><${Select} value=${c.is} options=${[{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }]} onChange=${(v) => set({ is: v })} /><//>`;
    case 'forecast':
      return html`<${F} label="Forecast"><${Select} value=${c.metric} options=${[{ value: 'tomorrow_sun', label: "Tomorrow's sun" }, { value: 'today_sun', label: "Today's sun" }]} onChange=${(v) => set({ metric: v })} /><//>
        <${F} label="Is"><${Select} value=${c.op} options=${OPS} onChange=${(v) => set({ op: v })} /><//>
        <${F} label="Radiation"><${NumInput} value=${c.value} unit="MJ/m²" min="0" max="100" onChange=${(v) => set({ value: v })} /><//>`;
    case 'setting':
      return html`<${InverterSelect} opts=${opts} value=${c.inverter} onChange=${(v) => set({ inverter: v })} />
        <${F} label="Setting"><${SettingPick} opts=${opts} value=${c.setting} onChange=${(k) => set({ setting: k, equals: defaultValue(defOf(opts, k)) })} /><//>
        <${F} label="Equals"><${ValueField} def=${defOf(opts, c.setting)} value=${c.equals} onChange=${(v) => set({ equals: v })} /><//>`;
    case 'automation':
      return html`<${F} label="Automation" wide><${AutomationPick} list=${list} selfId=${selfId} value=${c.id} onChange=${(v) => set({ id: v })} /><//>
        <${F} label="Is"><${Select} value=${String(c.enabled)} options=${[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }]} onChange=${(v) => set({ enabled: v === 'true' })} /><//>`;
    case 'device':
      return html`<${DeviceConditionFields} c=${c} set=${set} opts=${opts} />`;
    default:
      return null;
  }
}

/** Message textarea with clickable template chips inserted at the cursor. */
function MessageField({ value, onChange }) {
  const ref = useRef(null);
  const insert = (v) => {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const next = value.slice(0, s) + v + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + v.length, s + v.length);
    });
  };
  return html`<div class="au-f wide"><span>Message</span>
    <textarea ref=${ref} rows="2" value=${value} maxlength="1000" onInput=${(e) => onChange(e.target.value)}></textarea>
    <span class="au-vars">${NOTIFY_VARS.map((v) => html`<button type="button" class="au-var" onClick=${() => insert(v)}>${v}</button>`)}</span>
  </div>`;
}

function ActionFields({ a, set, opts, scenes, list, selfId }) {
  const ro = opts.ruleOptions;
  switch (a.kind) {
    case 'set_setting':
      return html`<${InverterSelect} opts=${opts} value=${a.inverter} onChange=${(v) => set({ inverter: v })} />
        <${F} label="Setting"><${SettingPick} opts=${opts} value=${a.setting} onChange=${(k) => set({ setting: k, value: defaultValue(defOf(opts, k)) })} /><//>
        <${F} label="Value"><${ValueField} def=${defOf(opts, a.setting)} value=${a.value} onChange=${(v) => set({ value: v })} /><//>`;
    case 'scene':
      return scenes.length
        ? html`<${F} label="Scene" wide><${Select} value=${String(a.scene ?? '')} options=${[...(isNone(a.scene) ? [{ value: '', label: 'Choose…' }] : []), ...scenes.map((s) => ({ value: String(s.id), label: s.name }))]}
            onChange=${(v) => set({ scene: Number(v) })} /><//>`
        : html`<p class="au-fnote muted small"><${Ic} name="info" size="sm" />No scenes yet. Create one on the <a href="/automations?tab=scenes">Scenes</a> tab.</p>`;
    case 'notify': {
      const off = a.channel !== 'app' && !ro.notify?.[a.channel];
      return html`<${F} label="Channel" wide><${Segmented} value=${a.channel} onChange=${(v) => set({ channel: v })}
          options=${[{ value: 'app', label: 'In app' }, { value: 'ntfy', label: 'ntfy' }, { value: 'webhook', label: 'Webhook' }]} /><//>
        ${off && html`<p class="au-fnote text-warn small"><${Ic} name="triangle-alert" size="sm" />No ${a.channel} URL yet. Add it on the <a href="/automations?tab=settings">Settings</a> tab.</p>`}
        <${F} label="Title" wide><input value=${a.title} maxlength="120" onInput=${(e) => set({ title: e.target.value })} /><//>
        <${MessageField} value=${a.message ?? ''} onChange=${(v) => set({ message: v })} />`;
    }
    case 'mqtt':
      return html`<${F} label="Topic" wide><input value=${a.topic} placeholder="solar/automation" onInput=${(e) => set({ topic: e.target.value })} /><//>
        <${F} label="Payload" wide><textarea rows="2" value=${a.payload} onInput=${(e) => set({ payload: e.target.value })}></textarea><//>
        <div class="au-f"><span>Retain</span><${Toggle} checked=${a.retain} onChange=${(v) => set({ retain: v })} /></div>`;
    case 'delay':
      return html`<${F} label="Wait for"><${NumInput} value=${a.minutes} unit="min" min="1" max="240" step="1" onChange=${(v) => set({ minutes: v })} /><//>
        <p class="au-fnote muted small"><${Ic} name="info" size="sm" />Later actions run after the wait. A new run of this rule cancels pending ones.</p>`;
    case 'automation':
      return html`<${F} label="Automation" wide><${AutomationPick} list=${list} selfId=${selfId} value=${a.id} onChange=${(v) => set({ id: v })} /><//>
        <${F} label="Make it"><${Select} value=${String(a.enabled)} options=${[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }]} onChange=${(v) => set({ enabled: v === 'true' })} /><//>`;
    case 'device':
      return html`<${DeviceActionFields} a=${a} set=${set} opts=${opts} />`;
    default:
      return null;
  }
}

const getGroup = (root, path) => path.reduce((g, i) => g.items[i], root);

function GroupEditor({ group, path, edit, opts, list, selfId, errOf, depth = 0 }) {
  const setOp = (op) => edit((n) => { getGroup(n.config.conditions, path).op = op; });
  const add = (kind) => edit((n) => { getGroup(n.config.conditions, path).items.push(newCondition(kind, opts, list.filter((a) => a.id !== selfId))); });
  const addGroup = () => edit((n) => { getGroup(n.config.conditions, path).items.push({ op: 'or', items: [newCondition('time_between', opts, list)] }); });
  const avail = (k) => (CONDS[k].needs === 'price' && !opts.ruleOptions.priceAvailable ? 'Needs a day-ahead price provider'
    : CONDS[k].needs === 'forecast' && !opts.ruleOptions.forecastAvailable ? 'Needs a weather forecast (site location)'
    : k === 'automation' && !list.some((a) => a.id !== selfId) ? 'No other automations yet'
    : k === 'device' && !devOpts(opts).entities.some((e) => !e.numeric) ? 'No smart devices yet' : true);
  const label = (i) => `Condition ${[...path.map((p) => p + 1), i + 1].join('.')}`;
  return html`<div class=${`au-group ${depth ? 'nested' : ''}`}>
    ${group.items.length > 1 && html`<div class="au-group-op"><span class="muted small">${depth ? 'Inside this group, match' : 'Match'}</span>
      <${Segmented} value=${group.op} onChange=${setOp} options=${[{ value: 'and', label: 'All (AND)' }, { value: 'or', label: 'Any (OR)' }]} /></div>`}
    ${group.items.map((it, i) => html`
      ${i > 0 && html`<div class="au-join"><span>${group.op === 'and' ? 'and' : 'or'}</span></div>`}
      ${it.items
        ? html`<div class="au-subgroup">
            <div class="au-subgroup-head"><${Ic} name="brackets" size="sm" /><b>Group</b>
              <button type="button" class="icon-btn au-ibtn" aria-label="Remove group" title="Remove group" onClick=${() => edit((n) => { getGroup(n.config.conditions, path).items.splice(i, 1); })}><${Ic} name="x" size="sm" /></button></div>
            <${GroupEditor} group=${it} path=${[...path, i]} edit=${edit} opts=${opts} list=${list} selfId=${selfId} errOf=${errOf} depth=${depth + 1} />
          </div>`
        : html`<${ItemCard} icon=${CONDS[it.kind]?.icon ?? 'filter'} tone="" title=${CONDS[it.kind]?.label ?? it.kind} error=${errOf(label(i))}
            onRemove=${() => edit((n) => { getGroup(n.config.conditions, path).items.splice(i, 1); })}>
            <${ConditionFields} c=${it} opts=${opts} list=${list} selfId=${selfId}
              set=${(p) => edit((n) => { Object.assign(getGroup(n.config.conditions, path).items[i], p); })} />
          <//>`}`)}
    <div class="au-adds">
      <${AddMenu} label=${depth ? 'Add to group' : 'Add condition'} kinds=${opts.ruleOptions.conditionKinds.filter((k) => CONDS[k])} meta=${CONDS} onPick=${add} available=${avail} />
      ${depth === 0 && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${addGroup}><${Ic} name="brackets" size="sm" />Add group</button>`}
    </div>
  </div>`;
}

function ActionList({ field, actions, edit, opts, scenes, list, selfId, errOf, prefix }) {
  const move = (i, d) => edit((n) => {
    const l = n.config[field];
    const [x] = l.splice(i, 1);
    l.splice(i + d, 0, x);
  });
  const avail = (k) => (k === 'scene' && !scenes.length ? 'Create a scene first' : k === 'automation' && !list.some((a) => a.id !== selfId) ? 'No other automations yet'
    : k === 'set_setting' && !writable(opts).length && opts.connected ? 'No writable settings'
    : k === 'device' && !devOpts(opts).entities.some((e) => e.services.length) ? 'No controllable smart devices yet' : true);
  return html`<div class="au-actions">
    ${actions.map((a, i) => html`<${ItemCard} key=${i} index=${i + 1} icon=${ACTIONS[a.kind]?.icon ?? 'play'} tone=${ACTIONS[a.kind]?.tone ?? ''} title=${ACTIONS[a.kind]?.label ?? a.kind}
      error=${errOf(`${prefix} ${i + 1}`)}
      tools=${html`<button type="button" class="icon-btn au-ibtn" aria-label="Move up" title="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}><${Ic} name="arrow-up" size="sm" /></button>
        <button type="button" class="icon-btn au-ibtn" aria-label="Move down" title="Move down" disabled=${i === actions.length - 1} onClick=${() => move(i, 1)}><${Ic} name="arrow-down" size="sm" /></button>`}
      onRemove=${() => edit((n) => { n.config[field].splice(i, 1); })}>
      <${ActionFields} a=${a} opts=${opts} scenes=${scenes} list=${list} selfId=${selfId} set=${(p) => edit((n) => { Object.assign(n.config[field][i], p); })} />
    <//>`)}
    <div class="au-adds"><${AddMenu} label="Add action" kinds=${opts.ruleOptions.actionKinds.filter((k) => ACTIONS[k])} meta=${ACTIONS} available=${avail}
      onPick=${(k) => edit((n) => { n.config[field].push(newAction(k, opts, scenes, list.filter((x) => x.id !== selfId))); })} /></div>
  </div>`;
}

/** Section card in the builder: big step label ("When"), title, description. */
const Section = ({ step, icon, tone, title, sub, children, error, actions }) => html`<section class=${`card au-sec ${error ? 'has-err' : ''}`}>
  <header class="au-sec-head">
    <span class="au-sec-step">${step}</span>
    <${IconChip} name=${icon} tone=${tone} small />
    <div class="au-sec-title"><h2>${title}</h2>${sub && html`<p class="muted small">${sub}</p>`}</div>
    ${actions && html`<div class="card-actions">${actions}</div>`}
  </header>
  ${error && html`<div class="notice notice-bad small au-note"><${Ic} name="circle-alert" size="sm" />${error}</div>`}
  ${children}
</section>`;

/** Strips empty optional fields before saving. */
function cleanRule(d) {
  const r = clone(d);
  const c = r.config;
  for (const t of c.triggers) if (t.kind === 'time' && !t.days?.length) delete t.days;
  const o = c.options;
  if (o.activeDays && (o.activeDays.length === 0 || o.activeDays.length === 7)) delete o.activeDays;
  if (!o.activeFrom && !o.activeTo) { delete o.activeFrom; delete o.activeTo; }
  return r;
}

/** Maps an API validation message ("Action 2: …") to the card it belongs to. */
function errorTarget(msg) {
  const m = /^(Trigger|Condition|Else action|Action) (\d+(?:\.\d+)*)/.exec(msg ?? '');
  if (m) return `${m[1]} ${m[2]}`;
  if (/^Add at least one trigger|^A rule can have at most \d+ triggers/.test(msg)) return 'when';
  if (/^Add at least one action|^At most \d+ action/i.test(msg)) return 'then';
  if (/Cooldown|Maximum runs|Revert after|Active days|Active from|Active to|Seasonal|Priority|Description/.test(msg)) return 'options';
  return null;
}

// ---------- Rule builder: page ----------

function ConditionTree({ node, depth = 0 }) {
  if (!node) return null;
  if (node.kind === 'group') {
    if (!node.items?.length) return html`<div class="au-tree-row ok"><${Ic} name="circle-check" size="sm" />No conditions: always runs</div>`;
    return html`<div class=${`au-tree ${depth ? 'nested' : ''}`}>
      ${depth > 0 && html`<div class=${`au-tree-row ${node.match ? 'ok' : 'no'}`}><${Ic} name=${node.match ? 'circle-check' : 'circle-x'} size="sm" />${node.text}</div>`}
      ${node.items.map((n) => html`<${ConditionTree} node=${n} depth=${depth + 1} />`)}
    </div>`;
  }
  return html`<div class=${`au-tree-row ${node.match ? 'ok' : 'no'}`}><${Ic} name=${node.match ? 'circle-check' : 'circle-x'} size="sm" />${node.text}</div>`;
}

function DryResult({ r }) {
  if (!r) return null;
  const branch = { actions: ['ok', 'Would run its actions'], elseActions: ['warn', 'Would run the "Otherwise" actions'], none: ['muted', 'Would do nothing'] }[r.branch] ?? ['muted', r.branch];
  const txt = (x) => (typeof x === 'string' ? x : x?.message ?? x?.reason ?? JSON.stringify(x));
  return html`<div class="au-dry">
    <div class=${`au-verdict ${branch[0]}`}><${Ic} name=${r.branch === 'actions' ? 'circle-check' : r.branch === 'none' ? 'circle-slash' : 'git-branch'} />${branch[1]}</div>
    ${r.blocked && html`<div class="notice notice-warn small au-note"><${Ic} name="shield-alert" size="sm" />${txt(r.blocked)}</div>`}
    ${r.limits && html`<div class="notice notice-info small au-note"><${Ic} name="timer" size="sm" />${txt(r.limits)}</div>`}
    <div class="au-dry-h">Conditions now</div>
    <${ConditionTree} node=${r.conditions} />
    ${(r.wouldRun ?? []).length > 0 && html`<div class="au-dry-h">Actions</div>
      <div class="au-dry-acts">${r.wouldRun.map((w) => html`<div class="au-dry-act">
        <${Ic} name=${ACTIONS[w.kind]?.icon ?? 'play'} size="sm" />
        <div><b>${w.text}</b><span class="muted small">${w.outcome}${w.current !== undefined && w.current !== null ? ` · now ${w.current}` : ''}</span></div>
      </div>`)}</div>`}
    ${(r.arbitration ?? []).length > 0 && html`<div class="au-dry-h">Conflicts</div>
      ${r.arbitration.map((x) => html`<p class="small muted au-arb"><${Ic} name="swords" size="sm" />${x.setting}: ${x.competitors.map((c) => `${c.name} (P${c.priority})`).join(' vs ')} → ${x.wins ? 'this rule wins' : 'another rule wins'}</p>`)}`}
  </div>`;
}

/**
 * A starting rule for one device. Something you switch: run it on spare solar (the classic energy
 * use) and switch it off again in the evening. Something that reports: notify when it changes.
 */
function deviceStarter(opts, id) {
  const e = devOf(opts, id);
  const r = blankRule();
  if (!e) return r;
  r.name = `${e.name}`;
  if (e.services.includes('turn_on')) {
    r.config.triggers = [{ kind: 'metric', metric: 'PV power', op: 'above', value: 1500, forMinutes: 10 }];
    r.config.conditions = { op: 'and', items: [{ kind: 'metric', metric: 'Battery state of charge', op: 'above', value: 80 }] };
    r.config.actions = [{ kind: 'device', target: id, service: 'turn_on', data: {} }];
    r.name = `Run ${e.name} on spare solar`;
  } else if (e.numeric) {
    r.config.triggers = [{ kind: 'metric', metric: id, op: 'above', value: 0, forMinutes: 0 }];
    r.config.actions = [{ kind: 'notify', channel: 'app', title: 'Sunroost', message: `${e.name} is high.` }];
  } else {
    r.config.triggers = [{ kind: 'device', entity: id, to: statesOf(e)[0] ?? 'on', forMinutes: 0 }];
    r.config.actions = [{ kind: 'notify', channel: 'app', title: 'Sunroost', message: `${e.name} changed.` }];
  }
  return r;
}

function Builder({ data, editId, templateId, deviceId, reload }) {
  const { opts, list, scenes } = data;
  const existing = editId !== 'new' ? list.find((a) => String(a.id) === String(editId)) : null;
  const [draft, setDraft] = useState(null);
  const [initial, setInitial] = useState('');
  const [errors, setErrors] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dry, setDry] = useState(null);
  const [dryBusy, setDryBusy] = useState(false);
  const [showElse, setShowElse] = useState(false);
  const [season, setSeason] = useState(false);

  // Initialise from the saved rule, a template, or a blank rule.
  useEffect(() => {
    let alive = true;
    const init = (r) => {
      if (!alive) return;
      const d = { type: 'rule', name: r.name ?? '', enabled: Boolean(r.enabled), config: { ...blankRule().config, ...clone(r.config) } };
      d.config.options = { ...blankRule().config.options, ...d.config.options };
      d.config.conditions ??= { op: 'and', items: [] };
      d.config.elseActions ??= [];
      setDraft(d);
      setInitial(JSON.stringify(d));
      setShowElse(d.config.elseActions.length > 0);
      setSeason(Boolean(d.config.options.activeFrom));
    };
    if (existing) init(existing);
    else if (deviceId) init(deviceStarter(opts, deviceId));
    else if (templateId) {
      api.get('/api/automations/templates').then((ts) => {
        const t = ts.find((x) => x.id === templateId);
        init(t ? { ...t.rule, enabled: false } : blankRule());
      }, () => init(blankRule()));
    } else init(blankRule());
    return () => { alive = false; };
  }, [editId, templateId, deviceId, Boolean(existing)]);

  const runDry = async (id = existing?.id) => {
    if (!id) return;
    setDryBusy(true);
    try {
      setDry(await api.post(`/api/automations/${id}/run?dry=1`));
    } catch (err) {
      setDry({ error: err.message });
    }
    setDryBusy(false);
  };
  useEffect(() => { if (existing) runDry(); }, [existing?.id]);

  const d = useMemo(() => makeDescriber(opts, scenes, list), [opts, scenes, list]);
  if (!draft) return html`<div class="loading">Loading…</div>`;
  if (editId !== 'new' && !existing) {
    return html`<section class="card"><${EmptyState} icon="search-x" title="Rule not found" action=${html`<a class="btn" href="/automations?tab=rules">Back to rules</a>`}>
      Automation #${editId} doesn't exist any more.<//></section>`;
  }

  const c = draft.config;
  const dirty = JSON.stringify(draft) !== initial;
  const edit = (fn) => {
    setDraft((x) => {
      const n = clone(x);
      fn(n);
      return n;
    });
  };
  const setCfg = (p) => edit((n) => Object.assign(n.config, p));
  const setOpt = (p) => edit((n) => Object.assign(n.config.options, p));
  const errMsg = errors;
  const target = errorTarget(errMsg);
  const errOf = (label) => (target === label ? errMsg : null);
  const selfId = existing?.id;
  const trigAvail = (k) => (TRIGGERS[k].needs === 'price' && !opts.ruleOptions.priceAvailable ? 'Needs a day-ahead price provider'
    : TRIGGERS[k].needs === 'forecast' && !opts.ruleOptions.forecastAvailable ? 'Needs a weather forecast (site location)'
    : k === 'device' && !devOpts(opts).entities.some((e) => !e.numeric) ? 'No smart devices yet' : true);

  const save = async ({ enable = false, test = false } = {}) => {
    setSaving(true);
    setErrors(null);
    const body = cleanRule(draft);
    if (!body.name.trim()) body.name = d.summary(body.config).slice(0, 60).replace(/\.$/, '');
    try {
      let id = existing?.id;
      if (id) {
        await api.put(`/api/automations/${id}`, { name: body.name, config: body.config });
        if (enable && !existing.enabled) await api.post(`/api/automations/${id}/enable`);
      } else {
        const res = await api.post('/api/automations', { type: 'rule', name: body.name, enabled: enable, config: body.config });
        id = res.automation.id;
        if (res.warning) toast(res.warning, 'bad');
      }
      toast(enable ? 'Rule saved and enabled' : 'Rule saved');
      await reload();
      if (!test) navigate('/automations?tab=rules');
      else if (!existing) navigate(`/automations?edit=${id}`, { replace: true });
      else {
        edit((n) => { n.name = body.name; });
        setInitial(JSON.stringify({ ...draft, name: body.name }));
        runDry(id);
      }
    } catch (err) {
      setErrors(err.message);
      const t = errorTarget(err.message);
      requestAnimationFrame(() => document.querySelector(t ? '.au-item.has-err, .au-sec.has-err' : '.au-build-err')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
    setSaving(false);
  };
  const cancel = () => {
    if (dirty && !window.confirm('Discard your changes?')) return;
    navigate('/automations?tab=rules');
  };
  const o = c.options;

  return html`<div class="au-build">
    <div class="au-build-main">
      <section class="card au-ident">
        <div class="au-ident-row">
          <${IconChip} name=${ruleIcon(draft)[0]} tone=${ruleIcon(draft)[1]} />
          <div class="au-ident-fields">
            <input class="au-name" value=${draft.name} maxlength="80" placeholder="Name this rule" aria-label="Rule name" onInput=${(e) => edit((n) => { n.name = e.target.value; })} />
            <textarea class="au-desc" rows="1" value=${c.description} maxlength="500" placeholder="Add a description (optional)" aria-label="Description" onInput=${(e) => setCfg({ description: e.target.value })}></textarea>
          </div>
          ${existing && html`<span class=${`badge badge-${existing.enabled ? 'ok' : 'muted'}`}>${existing.enabled ? 'Enabled' : 'Disabled'}</span>`}
        </div>
      </section>
      ${errMsg && !target && html`<div class="notice notice-bad au-note au-build-err"><${Ic} name="circle-alert" size="sm" />${errMsg}</div>`}

      <${Section} step="When" icon="zap" tone="accent" title="Triggers" sub="Any one of these starts the rule" error=${target === 'when' ? errMsg : null}>
        <div class="au-items">
          ${c.triggers.map((t, i) => html`${i > 0 && html`<div class="au-join"><span>or</span></div>`}
            <${ItemCard} icon=${TRIGGERS[t.kind]?.icon ?? 'zap'} tone=${TRIGGERS[t.kind]?.tone ?? ''} title=${TRIGGERS[t.kind]?.label ?? t.kind} error=${errOf(`Trigger ${i + 1}`)}
              onRemove=${() => edit((n) => { n.config.triggers.splice(i, 1); })}>
              <${TriggerFields} t=${t} opts=${opts} set=${(p) => edit((n) => {
                const x = n.config.triggers[i];
                Object.assign(x, p);
                for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k];
              })} />
            <//>`)}
          ${c.triggers.length === 0 && html`<p class="muted small au-none">No trigger yet. The rule can only run when you press Run now.</p>`}
        </div>
        <div class="au-adds"><${AddMenu} label="Add trigger" kinds=${opts.ruleOptions.triggerKinds.filter((k) => TRIGGERS[k])} meta=${TRIGGERS} available=${trigAvail}
          onPick=${(k) => edit((n) => { n.config.triggers.push(newTrigger(k, opts)); })} /></div>
      <//>

      <${Section} step="If" icon="filter" tone="load" title="Conditions" sub="Optional checks when a trigger fires. Leave empty to always run.">
        <${GroupEditor} group=${c.conditions} path=${[]} edit=${edit} opts=${opts} list=${list} selfId=${selfId} errOf=${errOf} />
      <//>

      <${Section} step="Then" icon="play" tone="battery" title="Actions" sub="Run in order, top to bottom" error=${target === 'then' ? errMsg : null}>
        <${ActionList} field="actions" prefix="Action" actions=${c.actions} edit=${edit} opts=${opts} scenes=${scenes} list=${list} selfId=${selfId} errOf=${errOf} />
      <//>

      ${showElse || c.elseActions.length
        ? html`<${Section} step="Else" icon="git-branch" tone="grid" title="Otherwise" sub="Run when a trigger fires but the conditions are not met"
            actions=${c.elseActions.length === 0 && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setShowElse(false)}>Hide</button>`}>
            <${ActionList} field="elseActions" prefix="Else action" actions=${c.elseActions} edit=${edit} opts=${opts} scenes=${scenes} list=${list} selfId=${selfId} errOf=${errOf} />
          <//>`
        : html`<button type="button" class="au-else-add" onClick=${() => setShowElse(true)}><${Ic} name="git-branch" size="sm" />Add "Otherwise" actions for when the conditions are not met</button>`}

      <${Section} step="Options" icon="settings-2" tone="" title="Options" sub="Priority, limits and when the rule may run" error=${target === 'options' ? errMsg : null}>
        <div class="au-opts">
          <div class="au-opt wide">
            <div class="au-opt-l"><b>Priority</b><span class="muted small">Higher wins when two rules set the same setting at the same time</span></div>
            <div class="au-prio"><input type="range" min="1" max="100" value=${c.priority} aria-label="Priority" onInput=${(e) => setCfg({ priority: Number(e.target.value) })} /><span class="au-pill">${c.priority}</span></div>
          </div>
          <div class="au-opt">
            <div class="au-opt-l"><b>Cooldown</b><span class="muted small">Minimum time between runs</span></div>
            <${NumInput} value=${o.cooldownMinutes} unit="min" min="0" max="10080" step="1" label="Cooldown" onChange=${(v) => setOpt({ cooldownMinutes: v })} />
          </div>
          <div class="au-opt">
            <div class="au-opt-l"><b>Max runs per day</b><span class="muted small">0 = unlimited</span></div>
            <${NumInput} value=${o.maxRunsPerDay} min="0" max="1440" step="1" label="Max runs per day" onChange=${(v) => setOpt({ maxRunsPerDay: v })} />
          </div>
          <div class="au-opt">
            <div class="au-opt-l"><b>Revert after</b><span class="muted small">Restore previous setting values; 0 = never</span></div>
            <${NumInput} value=${o.revertAfterMinutes} unit="min" min="0" max="10080" step="1" label="Revert after" onChange=${(v) => setOpt({ revertAfterMinutes: v })} />
          </div>
          <div class="au-opt wide">
            <div class="au-opt-l"><b>Active days</b><span class="muted small">${!o.activeDays?.length || o.activeDays.length === 7 ? 'Every day' : 'Only on the selected days'}</span></div>
            <${DayChips} label="Active days" value=${o.activeDays?.length ? o.activeDays : [0, 1, 2, 3, 4, 5, 6]} onChange=${(v) => setOpt({ activeDays: v })} />
          </div>
          <div class="au-opt wide">
            <div class="au-opt-l"><b>Seasonal window</b><span class="muted small">Only between two dates each year (wraps the year end)</span></div>
            <div class="au-season">
              <${Toggle} checked=${season} onChange=${(on) => { setSeason(on); setOpt(on ? { activeFrom: o.activeFrom || '04-01', activeTo: o.activeTo || '09-30' } : { activeFrom: undefined, activeTo: undefined }); }} />
              ${season && html`<input value=${o.activeFrom ?? ''} placeholder="MM-DD" maxlength="5" aria-label="Active from" onInput=${(e) => setOpt({ activeFrom: e.target.value })} />
                <span class="muted">to</span><input value=${o.activeTo ?? ''} placeholder="MM-DD" maxlength="5" aria-label="Active to" onInput=${(e) => setOpt({ activeTo: e.target.value })} />`}
            </div>
          </div>
        </div>
      <//>

      <div class="au-build-actions">
        ${errMsg && html`<span class="au-save-err"><${Ic} name="circle-alert" size="sm" />Can't save yet: ${errMsg}</span>`}
        <button type="button" class="btn" onClick=${cancel}>Cancel</button>
        <button type="button" class="btn" disabled=${saving} onClick=${() => save()}>${saving ? 'Saving…' : 'Save'}</button>
        ${!existing?.enabled && html`<button type="button" class="btn btn-primary" disabled=${saving} onClick=${() => save({ enable: true })}><${Ic} name="power" size="sm" />Save & enable</button>`}
        ${existing?.enabled && html`<button type="button" class="btn btn-primary" disabled=${saving || !dirty} onClick=${() => save({ test: true })}><${Ic} name="check" size="sm" />Save changes</button>`}
      </div>
    </div>

    <aside class="au-build-side">
      <section class="card au-preview">
        <${Head} icon="message-square-text" tone="accent" title="Preview" sub=${dirty ? 'Unsaved changes' : existing ? 'Saved' : 'Not saved yet'} />
        <p class="au-sentence">${d.summary(c)}</p>
        <div class="au-meta-row">
          <span class="au-pill" title="Priority">P${c.priority}</span>
          ${Number(o.cooldownMinutes) > 0 && html`<span class="au-chip"><${Ic} name="timer" size="sm" />${o.cooldownMinutes} min cooldown</span>`}
          ${Number(o.maxRunsPerDay) > 0 && html`<span class="au-chip"><${Ic} name="list-checks" size="sm" />max ${o.maxRunsPerDay}/day</span>`}
          ${o.activeDays?.length > 0 && o.activeDays.length < 7 && html`<span class="au-chip"><${Ic} name="calendar-days" size="sm" />${DAY_ORDER.filter((x) => o.activeDays.includes(x)).map((x) => DAYS[x].slice(0, 2)).join(' ')}</span>`}
          ${season && html`<span class="au-chip"><${Ic} name="calendar-range" size="sm" />${o.activeFrom}–${o.activeTo}</span>`}
        </div>
        <div class="au-wouldrun">
          <div class="au-wr-head"><b>Would it run now?</b>
            ${existing && html`<button type="button" class="btn btn-sm btn-ghost" disabled=${dryBusy} onClick=${() => runDry()}><${Ic} name="rotate-ccw" size="sm" />${dryBusy ? 'Checking…' : 'Re-check'}</button>`}</div>
          ${!existing
            ? html`<p class="muted small">Save the rule to test it against the live values. Nothing is written during a test.</p>
              <button type="button" class="btn btn-sm au-wr-btn" disabled=${saving} onClick=${() => save({ test: true })}><${Ic} name="flask-conical" size="sm" />Save & test</button>`
            : html`${dirty && html`<p class="small text-warn au-wr-note"><${Ic} name="info" size="sm" />Showing the saved version.
                <button type="button" class="au-link" disabled=${saving} onClick=${() => save({ test: true })}>Save & test</button> to check your changes.</p>`}
              ${dry?.error ? html`<div class="notice notice-bad small au-note">${dry.error}</div>` : dry ? html`<${DryResult} r=${dry} />` : html`<p class="muted small">Checking…</p>`}`}
        </div>
      </section>
    </aside>
  </div>`;
}

// ---------- Rules list ----------

/** Result of Run now / Dry run shown under a rule row. */
function RunResult({ r, onClose }) {
  if (!r) return null;
  if (r.error) return html`<div class="au-run-res bad"><${Ic} name="circle-alert" size="sm" /><span>${r.error}</span><button type="button" class="icon-btn au-ibtn" aria-label="Dismiss" onClick=${onClose}><${Ic} name="x" size="sm" /></button></div>`;
  return html`<div class="au-run-res">
    <div class="au-run-top"><${ResultBadge} result=${r.result} dry=${r.dryRun} /><b>${r.dryRun ? 'Dry run' : 'Ran now'}</b>
      ${r.branch && html`<span class="muted small">${r.branch === 'actions' ? 'Conditions met' : r.branch === 'elseActions' ? 'Conditions not met: otherwise branch' : 'Nothing to do'}</span>`}
      <button type="button" class="icon-btn au-ibtn" aria-label="Dismiss" onClick=${onClose}><${Ic} name="x" size="sm" /></button></div>
    <${ActionResults} actions=${r.actions} />
  </div>`;
}

function ActionResults({ actions }) {
  if (!actions?.length) return html`<p class="muted small au-none">No actions.</p>`;
  return html`<ul class="au-ares">${actions.map((x) => html`<li class=${x.skipped ? 'skip' : x.ok ? 'ok' : 'bad'}>
    <${Ic} name=${x.skipped ? 'circle-slash' : x.ok ? 'circle-check' : 'circle-x'} size="sm" />
    <span><b>${x.text}</b>${x.message && html`<span class="muted"> · ${x.message}</span>`}</span></li>`)}</ul>`;
}

function RuleRow({ a, reload }) {
  const v = a.view ?? {};
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [icon, tone] = ruleIcon(a);
  const [bk, bl] = STATE_BADGE_RULE[v.status ?? a.status?.state] ?? ['muted', v.status];
  const toggle = async (on) => {
    setBusy(true);
    try {
      await api.post(`/api/automations/${a.id}/${on ? 'enable' : 'disable'}`);
      toast(on ? 'Rule enabled' : 'Rule disabled');
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
    reload();
  };
  const run = async (dry) => {
    setBusy(true);
    try {
      setRes(await api.post(`/api/automations/${a.id}/run${dry ? '?dry=1' : ''}`));
    } catch (err) {
      setRes({ error: err.message });
    }
    setBusy(false);
    if (!dry) reload();
  };
  const duplicate = async () => {
    try {
      const r = await api.post('/api/automations', { type: 'rule', name: `${a.name || 'Rule'} (copy)`.slice(0, 80), enabled: false, config: a.config });
      toast('Duplicated (disabled)');
      reload();
      navigate(`/automations?edit=${r.automation.id}`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const del = async () => {
    if (!window.confirm(`Delete "${a.name || `Rule #${a.id}`}"?`)) return;
    await api.del(`/api/automations/${a.id}`).then(() => toast('Rule deleted'), (err) => toast(err.message, 'bad'));
    reload();
  };
  const editHref = `/automations?edit=${a.id}`;
  return html`<div class=${`au-row ${a.enabled ? '' : 'off'}`} id=${`automation-${a.id}`}>
    <div class="au-row-main">
      <a class="au-row-hit" href=${editHref}>
        <${IconChip} name=${icon} tone=${tone} />
        <span class="au-row-text">
          <span class="au-row-title">${a.name || `Rule #${a.id}`}<span class="au-id">#${a.id}</span></span>
          <span class="au-row-sum">${v.summary}</span>
          <span class="au-row-meta">
            ${v.lastRun ? html`<span title=${fmtDateTime(v.lastRun.ts)}><${Ic} name="history" size="sm" />Last ${whenText(v.lastRun.ts)} <${ResultBadge} result=${v.lastRun.result} /></span>` : html`<span><${Ic} name="history" size="sm" />Never run</span>`}
            ${v.nextRun ? html`<span title=${fmtDateTime(v.nextRun)}><${Ic} name="clock" size="sm" />Next ${whenText(v.nextRun)}</span>` : v.onCondition && a.enabled && html`<span><${Ic} name="radar" size="sm" />Watching</span>`}
            <span><${Ic} name="activity" size="sm" />${plural(v.runsToday ?? 0, 'run')} today</span>
            ${v.pendingDelay && html`<span class="au-warnc"><${Ic} name="hourglass" size="sm" />Delayed actions pending</span>`}
            ${v.pendingRevert && html`<span class="au-warnc"><${Ic} name="undo-2" size="sm" />Revert pending</span>`}
          </span>
          ${(v.statusMessage || a.status?.disableMessage) && html`<span class="au-row-msg"><${Ic} name="info" size="sm" />${v.statusMessage || a.status.disableMessage}</span>`}
        </span>
      </a>
      <div class="au-row-side">
        <span class=${`badge badge-${bk}`}>${bl}</span>
        <span class="au-pill" title="Priority">P${a.config.priority}</span>
        <${Toggle} checked=${a.enabled} disabled=${busy} onChange=${toggle} />
        <${Menu} label=${`Actions for ${a.name || `rule #${a.id}`}`} items=${[
          { icon: 'play', label: 'Run now', onClick: () => run(false), disabled: busy },
          { icon: 'flask-conical', label: 'Dry run', onClick: () => run(true), disabled: busy },
          { icon: 'pencil', label: 'Edit', onClick: () => navigate(editHref) },
          { icon: 'copy', label: 'Duplicate', onClick: duplicate },
          { icon: 'trash-2', label: 'Delete', onClick: del, danger: true },
        ]} />
      </div>
    </div>
    <${RunResult} r=${res} onClose=${() => setRes(null)} />
  </div>`;
}

/** Classic automation (rule table / SOC control / protection): expandable, with its own viewer and editor. */
function LegacyRow({ a, opts, conds, soc, editing, setEditing, reload }) {
  const st = a.status;
  const dcs = st.decision ?? {};
  const [open, setOpen] = useState(editing);
  useEffect(() => { if (editing) setOpen(true); }, [editing]);
  const ref = useRef(null);
  useEffect(() => {
    if (editing && new URLSearchParams(location.search).get('edit') === String(a.id)) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const toggle = async () => {
    const on = !a.enabled;
    if (!window.confirm(`Are you sure you want to ${on ? 'enable' : 'disable'} ${CONFIRM_NAME[a.type]}?`)) return;
    try {
      await api.post(`/api/automations/${a.id}/${on ? 'enable' : 'disable'}`);
      toast(on ? 'Automation enabled' : 'Automation disabled');
    } catch (err) {
      window.alert(err.message);
    }
    reload();
  };
  const del = async () => {
    if (!window.confirm('Delete this automation? This cannot be undone.')) return;
    await api.del(`/api/automations/${a.id}`).then(() => toast('Automation deleted'), (err) => toast(err.message, 'bad'));
    reload();
  };
  const duplicate = async () => {
    try {
      const r = await api.post('/api/automations', { type: a.type, name: a.name ? `${a.name} (copy)`.slice(0, 80) : '', enabled: false, config: a.config });
      if (r.warning) window.alert(r.warning);
      toast('Duplicated (disabled)');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const done = () => {
    setEditing(false);
    reload();
  };
  const Edit = { table: TableEdit, 'battery-soc': SocEdit, 'battery-protection': ProtectionEdit }[a.type];
  const Show = { table: TableShow, 'battery-soc': SocShow, 'battery-protection': ProtectionShow }[a.type];
  const [icon, tone] = TYPE_ICON[a.type] ?? ['workflow', 'accent'];
  const [bk, bl] = STATE_BADGE[st.state] ?? ['muted', st.state];
  const canEnable = a.enabled || !st.disableReason;
  return html`<div class=${`au-row ${a.enabled ? '' : 'off'} ${open ? 'open' : ''}`} id=${`automation-${a.id}`} ref=${ref}>
    <div class="au-row-main">
      <button type="button" class="au-row-hit" aria-expanded=${open} onClick=${() => !editing && setOpen(!open)}>
        <${IconChip} name=${icon} tone=${tone} />
        <span class="au-row-text">
          <span class="au-row-title">${a.name || a.typeName}<span class="au-id">#${a.id}</span><span class="badge badge-accent au-classic">Classic</span></span>
          <span class="au-row-sum">${a.name ? `${a.typeName} · ` : ''}${summaryOf(a, conds, opts)}</span>
          <span class="au-row-meta">
            <span><${Ic} name=${a.enabled ? 'activity' : 'eye'} size="sm" />${a.enabled ? (st.state === 'suspended' ? 'Suspended. ' : 'Now: ') : 'Disabled. Would now: '}${dcs.reason}${!isNone(dcs.value) && html` → <b>${fmtValue(a.settingDef, dcs.value)}</b>`}
              ${st.plan?.some((p) => p.action === 'unchanged') && html` (already set)`}${a.enabled && st.heldUntil && html` (held until ${hhmm(st.heldUntil)})`}</span>
            ${st.lastActionAt && html`<span title=${st.lastAction ?? ''}><${Ic} name="history" size="sm" />Last ${hhmm(st.lastActionAt)}</span>`}
          </span>
          ${st.lastError && html`<span class="au-row-msg bad"><${Ic} name="triangle-alert" size="sm" />${hhmm(st.lastErrorAt)}: ${st.lastError.replace(/^[^:]+: /, '')}</span>`}
        </span>
      </button>
      <div class="au-row-side">
        <span class=${`badge badge-${bk}`}>${bl}</span>
        <label class="toggle" title=${canEnable ? (a.enabled ? 'Disable' : 'Enable') : st.disableMessage ?? ''}>
          <input type="checkbox" aria-label=${`${a.enabled ? 'Disable' : 'Enable'} automation #${a.id}`} checked=${a.enabled} disabled=${!canEnable}
            onClick=${(e) => { e.preventDefault(); toggle(); }} />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
        <${Menu} label=${`Actions for automation #${a.id}`} items=${[
          { icon: 'pencil', label: 'Edit', onClick: () => { setOpen(true); setEditing(true); } },
          { icon: open ? 'chevron-up' : 'chevron-down', label: open ? 'Collapse' : 'Show details', onClick: () => setOpen(!open), disabled: editing },
          { icon: 'copy', label: 'Duplicate', onClick: duplicate },
          { icon: 'trash-2', label: 'Delete', onClick: del, danger: true },
        ]} />
      </div>
    </div>
    ${open && html`<div class="au-row-body">
      ${st.disableMessage && html`<div class="notice notice-warn small au-note"><${Ic} name="info" size="sm" />${st.disableMessage}</div>`}
      ${st.lastAction && html`<p class="small muted au-lastline">Last action${st.lastActionAt ? ` at ${hhmm(st.lastActionAt)}` : ''}: ${st.lastAction}</p>`}
      ${editing
        ? html`<${Edit} a=${a} opts=${opts} conds=${conds} soc=${soc} onCancel=${() => setEditing(false)} onSaved=${done} />`
        : html`<${Show} a=${a} conds=${conds} soc=${soc} />
          <div class="form-actions">
            <button type="button" class="btn btn-danger" onClick=${del}><${Ic} name="trash-2" size="sm" />Delete</button>
            <button type="button" class="btn" onClick=${() => setEditing(true)}><${Ic} name="pencil" size="sm" />Edit</button>
          </div>`}
    </div>`}
  </div>`;
}

function NewRuleModal({ open, onClose, onClassic }) {
  const go = (to) => {
    onClose();
    navigate(to);
  };
  const Opt = ({ icon, tone, title, text, onClick }) => html`<button type="button" class="au-type" onClick=${onClick}>
    <${IconChip} name=${icon} tone=${tone} />
    <span class="au-type-text"><b>${title}</b><span>${text}</span></span>
    <${Ic} name="chevron-right" size="sm" class="au-type-chev" />
  </button>`;
  return html`<${Modal} open=${open} title="New rule" onClose=${onClose}>
    <p class="muted small au-modal-lead">How do you want to start? New rules are saved disabled unless you choose Save & enable.</p>
    <div class="au-types">
      <${Opt} icon="layout-template" tone="accent" title="Start from a template" text="Ready-made rules for cheap hours, outages, cloudy days, notifications and more." onClick=${() => go('/automations?tab=templates')} />
      <${Opt} icon="wand-sparkles" tone="load" title="Blank rule" text="Build your own: triggers, conditions, actions and options." onClick=${() => go('/automations?edit=new')} />
      <${Opt} icon="table-2" tone="battery" title="Classic types" text="Rule table, battery state of charge control or battery protection." onClick=${() => { onClose(); onClassic(); }} />
    </div>
  <//>`;
}

function RulesTab({ data, editingMap, setEditing, reload, onNew }) {
  const { opts, list } = data;
  const snap = useStore(live);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const conds = useMemo(() => Object.fromEntries((opts.conditions ?? []).map((c) => [c.kind, c])), [opts]);
  const soc = typeof snap?.totals?.['Battery state of charge'] === 'number' ? snap.totals['Battery state of charge'] : null;
  const ql = q.trim().toLowerCase();
  const shown = list.filter((a) => {
    if (filter === 'enabled' && !a.enabled) return false;
    if (filter === 'disabled' && a.enabled) return false;
    if (filter === 'classic' && a.type === 'rule') return false;
    if (!ql) return true;
    return `${a.name} ${a.typeName} ${a.view?.summary ?? ''} #${a.id}`.toLowerCase().includes(ql);
  });
  const sorted = [...shown].sort((x, y) => Number(y.enabled) - Number(x.enabled) || (y.config.priority ?? 0) - (x.config.priority ?? 0) || x.id - y.id);
  if (!list.length) {
    return html`<section class="card"><${EmptyState} icon="sparkles" title="No automations yet"
      action=${html`<div class="cluster au-center-c"><a class="btn" href="/automations?tab=templates"><${Ic} name="layout-template" size="sm" />Browse templates</a>
        <button type="button" class="btn btn-primary" onClick=${onNew}><${Ic} name="plus" size="sm" />New rule</button></div>`}>
      Switch work modes on a schedule, charge in the cheapest hours, get notified when the grid goes down or protect the battery.<//></section>`;
  }
  return html`<section class="card au-rules">
    <div class="au-toolbar">
      <span class="au-search"><${Ic} name="search" size="sm" /><input type="search" placeholder="Search rules" aria-label="Search rules" value=${q} onInput=${(e) => setQ(e.target.value)} /></span>
      <div class="au-seg-scroll"><${Segmented} value=${filter} onChange=${setFilter} options=${[
        { value: 'all', label: `All ${list.length}` }, { value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }, { value: 'classic', label: 'Classic' }]} /></div>
    </div>
    <div class="au-list">
      ${sorted.map((a) => (a.type === 'rule'
        ? html`<${RuleRow} key=${a.id} a=${a} reload=${reload} />`
        : html`<${LegacyRow} key=${a.id} a=${a} opts=${opts} conds=${conds} soc=${soc} editing=${Boolean(editingMap[a.id])} setEditing=${setEditing(a.id)} reload=${reload} />`))}
      ${sorted.length === 0 && html`<${EmptyState} icon="search-x" title="No matching rules">Try another search or filter.<//>`}
    </div>
  </section>`;
}

// ---------- Overview ----------

function useLoad(url, deps = [], every = 0) {
  const [state, setState] = useState({ data: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.get(url).then((d) => alive && setState({ data: d, error: null }), (e) => alive && setState((s) => ({ data: s.data, error: e.message })));
    load();
    const t = every ? setInterval(load, every) : null;
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url, version, ...deps]);
  return { ...state, reload: () => setVersion((v) => v + 1) };
}

const PALETTE = ['var(--accent)', 'var(--load)', 'var(--grid)', 'var(--battery)', 'var(--solar)', 'var(--bad)'];
const colorFor = (id) => PALETTE[(Number(id) || 0) % PALETTE.length];

function SuspendKpi({ data, reload }) {
  const durations = data.opts.override?.durations?.length ? data.opts.override.durations : DURATIONS;
  const [minutes, setMinutes] = useState(durations.includes(60) ? 60 : durations[0]);
  const [busy, setBusy] = useState(false);
  const until = data.overrideUntil;
  const suspended = until > 0;
  const act = async () => {
    setBusy(true);
    try {
      if (suspended) {
        await api.del('/api/automations/suspend');
        toast('Automations resumed');
      } else {
        await api.post('/api/automations/suspend', { minutes: Number(minutes) });
        toast(`Automations suspended for ${durLong(minutes)}`);
      }
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
    reload();
  };
  return html`<div class=${`card au-kpi-suspend ${suspended ? 'on' : ''}`}>
    <div class="kpi">
      <${IconChip} name=${suspended ? 'circle-pause' : 'circle-play'} tone=${suspended ? 'solar' : 'battery'} />
      <div class="kpi-body">
        <span class="kpi-label">Automations</span>
        <span class="kpi-value">${suspended ? 'Suspended' : 'Running'}</span>
        <span class="kpi-delta">${suspended ? `Until ${hhmm(until)} (${rel(until)})` : data.connected ? 'Rules may change settings' : 'Inverter offline'}</span>
      </div>
    </div>
    <div class="au-susp-ctl">
      ${suspended
        ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${act}><${Ic} name="play" size="sm" />Resume now</button>`
        : html`<select aria-label="Suspend for" value=${minutes} onChange=${(e) => setMinutes(Number(e.target.value))}>
            ${durations.map((m) => html`<option value=${m} selected=${m === Number(minutes)}>${durLong(m)}</option>`)}</select>
          <button type="button" class="btn btn-sm" disabled=${busy} onClick=${act}><${Ic} name="pause" size="sm" />Suspend</button>`}
    </div>
  </div>`;
}

function UpcomingCard({ items, list }) {
  useTick(60_000);
  const [all, setAll] = useState(false);
  const now = Date.now();
  const span = 24 * 3600_000;
  const timed = (items ?? []).filter((x) => x.at && x.at >= now - 60_000 && x.at <= now + span);
  const onCond = (items ?? []).filter((x) => x.onCondition);
  const startH = new Date(now);
  const ticks = [];
  for (let i = 1; i <= 24; i++) {
    const t = new Date(startH);
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() + i);
    if (t.getHours() % 3) continue;
    const x = (t - now) / span;
    if (x > 0.05 && x < 0.93) ticks.push({ x, label: `${pad2(t.getHours())}:00` });
  }
  const iconOf = (id) => ruleIcon(list.find((a) => a.id === id) ?? {})[0];
  const visible = all ? timed : timed.slice(0, 6);
  return html`<section class="card au-up">
    <${Head} icon="calendar-clock" tone="load" title="Upcoming" sub="Scheduled rule runs in the next 24 hours"
      actions=${html`<a class="btn btn-sm btn-ghost" href="/automations?tab=rules">All rules</a>`} />
    <div class="au-track" role="img" aria-label=${`${timed.length} scheduled runs in the next 24 hours`}>
      <div class="au-track-bar">
        ${ticks.map((t) => html`<span class="au-track-grid" style=${`left:${t.x * 100}%`}></span>`)}
        ${timed.map((x) => {
          const p = Math.max(0, Math.min(1, (x.at - now) / span)) * 100;
          return html`<span class="au-mark" tabindex="0" style=${`left:${p}%;--c:${colorFor(x.automationId)}`}
            data-tip=${`${hhmm(x.at)} · ${x.name}`} aria-label=${`${hhmm(x.at)} ${x.name}: ${x.summary}`}>
            <span class="au-tip"><b>${hhmm(x.at)} · ${x.name}</b><span>${x.summary}</span></span></span>`;
        })}
        <span class="au-track-now"></span>
      </div>
      <div class="au-track-axis"><span style="left:0">Now</span>${ticks.map((t, i) => html`<span class=${i % 2 ? 'minor' : ''} style=${`left:${t.x * 100}%`}>${t.label}</span>`)}<span style="left:100%">+24 h</span></div>
    </div>
    ${timed.length === 0
      ? html`<div class="empty au-empty-sm"><${Ic} name="calendar-x" /><div>Nothing scheduled in the next 24 hours.</div></div>`
      : html`<div class="list au-up-list">${visible.map((x) => html`<a class="list-item au-li" href=${`/automations?edit=${x.automationId}`}>
          <span class="au-time"><b>${hhmm(x.at)}</b><small>${rel(x.at, now)}</small></span>
          <span class="au-dotc" style=${`--c:${colorFor(x.automationId)}`}><${Ic} name=${iconOf(x.automationId)} size="sm" /></span>
          <div class="list-main"><div class="list-title">${x.name}</div><div class="list-sub">${x.trigger}</div></div>
          <${Ic} name="chevron-right" size="sm" class="au-chev" />
        </a>`)}</div>
        ${timed.length > 6 && html`<div class="au-more"><button type="button" class="btn btn-sm btn-ghost" onClick=${() => setAll(!all)}>${all ? 'Show less' : `Show all ${timed.length}`}</button></div>`}`}
    ${onCond.length > 0 && html`<div class="au-sub-h"><${Ic} name="radar" size="sm" />Watching for a condition</div>
      <div class="list">${onCond.map((x) => html`<a class="list-item au-li" href=${`/automations?edit=${x.automationId}`}>
        <span class="au-dotc" style=${`--c:${colorFor(x.automationId)}`}><${Ic} name=${iconOf(x.automationId)} size="sm" /></span>
        <div class="list-main"><div class="list-title">${x.name}</div><div class="list-sub">${x.trigger.replace(/^On condition: /, '')}</div></div>
        <${Ic} name="chevron-right" size="sm" class="au-chev" />
      </a>`)}</div>`}
  </section>`;
}

const sourceOf = (r, list, scenes) => {
  if (!r.sceneId && !r.automationId) return { name: 'Spare solar', icon: 'sun', tone: 'solar', href: '/automations?tab=solar', kind: 'Spare solar' };
  if (r.sceneId) {
    const s = scenes.find((x) => x.id === r.sceneId);
    return { name: s?.name ?? `Scene #${r.sceneId}`, icon: s?.icon ?? 'layers', tone: s?.color ?? 'grid', href: '/automations?tab=scenes', kind: 'Scene' };
  }
  const a = list.find((x) => x.id === r.automationId);
  const [icon, tone] = a ? (a.type === 'rule' ? ruleIcon(a) : TYPE_ICON[a.type] ?? ['workflow', 'accent']) : ['workflow', 'accent'];
  return { name: a ? a.name || a.typeName : `Automation #${r.automationId}`, icon, tone, href: a ? `/automations?edit=${a.id}` : null, kind: 'Rule' };
};

function ActivityCard({ runs, data }) {
  const [open, setOpen] = useState(null);
  const items = (runs ?? []).slice(0, 8);
  return html`<section class="card au-act">
    <${Head} icon="history" tone="grid" title="Recent activity" sub="Latest rule runs and scenes"
      actions=${html`<a class="btn btn-sm btn-ghost" href="/automations?tab=history">History</a>`} />
    ${runs === null ? html`<div class="loading">Loading…</div>`
      : items.length === 0 ? html`<div class="empty au-empty-sm"><${Ic} name="inbox" /><div>No runs yet. Use Run now on a rule to try it.</div></div>`
      : html`<div class="list">${items.map((r) => {
          const s = sourceOf(r, data.list, data.scenes);
          const isOpen = open === r.id;
          return html`<div class=${`au-run ${isOpen ? 'open' : ''}`}>
            <button type="button" class="list-item au-li au-run-hit" aria-expanded=${isOpen} onClick=${() => setOpen(isOpen ? null : r.id)}>
              <${IconChip} name=${s.icon} tone=${s.tone} small />
              <div class="list-main"><div class="list-title">${s.name}</div><div class="list-sub">${r.trigger} · ${plural(r.actions.length, 'action')}</div></div>
              <span class="au-run-side"><${ResultBadge} result=${r.result} dry=${r.dryRun} /><small title=${fmtDateTime(r.ts)}>${whenText(r.ts)}</small></span>
              <${Ic} name="chevron-down" size="sm" class="au-chev au-rot" />
            </button>
            ${isOpen && html`<div class="au-run-body"><${ActionResults} actions=${r.actions} /></div>`}
          </div>`;
        })}</div>`}
  </section>`;
}

function OverviewTab({ data, reload, version }) {
  useTick(30_000);
  const up = useLoad('/api/automations/upcoming?hours=24', [version], 60_000);
  const runs = useLoad('/api/automations/runs?limit=100', [version], 30_000);
  const { list } = data;
  const enabled = list.filter((a) => a.enabled);
  const rules = list.filter((a) => a.type === 'rule');
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = (runs.data ?? []).filter((r) => r.ts >= dayStart && !r.dryRun);
  const done = today.filter((r) => r.result !== 'skipped');
  const failed = today.filter((r) => r.result === 'failed' || r.result === 'partial').length;
  const next = (up.data ?? []).find((x) => x.at && x.at >= Date.now() - 60_000);
  return html`<div class="au-ov">
    <div class="au-kpis">
      <${Kpi} icon="workflow" tone="accent" label="Active rules" value=${enabled.length} unit=${`of ${list.length}`}
        sub=${`${rules.length} rule${rules.length === 1 ? '' : 's'}, ${list.length - rules.length} classic`} href="/automations?tab=rules" />
      <${Kpi} icon="activity" tone="battery" label="Runs today" value=${runs.data ? done.length : '–'}
        sub=${runs.data ? `${today.length - done.length} skipped${failed ? ` · ${failed} with errors` : ''}` : 'Loading…'} href="/automations?tab=history" />
      <${Kpi} icon="clock" tone="load" label="Next action" value=${next ? hhmm(next.at) : '–'} unit=${next ? rel(next.at) : ''}
        sub=${next ? next.name : 'Nothing scheduled in 24 h'} href=${next ? `/automations?edit=${next.automationId}` : undefined} />
      <${SuspendKpi} data=${data} reload=${reload} />
    </div>
    <div class="au-ov-grid">
      <${UpcomingCard} items=${up.data} list=${list} />
      <${ActivityCard} runs=${runs.data} data=${data} />
    </div>
  </div>`;
}

// ---------- Spare solar ----------

const STATUS_BADGE = {
  running: ['ok', 'Running'], next: ['info', 'Next'], waiting: ['muted', 'Waiting'], unavailable: ['bad', 'Unavailable'],
  held: ['warn', 'Held'], manual: ['muted', 'On by hand'],
};
const SOURCE_TEXT = { learned: (d) => `learned from ${d} days of your own data`, array: () => 'from your array size', estimate: () => 'rough: set your array size, or wait about a week while Sunroost learns' };
const kw = (w) => (w === null || w === undefined ? '–' : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);

function SpareSolarTab() {
  const st = useLoad('/api/surplus', [], 10_000);
  const out = useLoad('/api/energy/outlook', [], 60_000);
  const s = useStore(appSettings) ?? {};
  const [busy, setBusy] = useState(false);
  const put = async (body) => {
    setBusy(true);
    try {
      await api.put('/api/surplus', body);
      st.reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
  };
  const setPower = async (d, v) => {
    const n = v === '' ? null : Number(v);
    try {
      await api.patch(`/api/home/entities/${d.entityId}`, { powerW: n });
      st.reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const move = (i, dir) => {
    const ids = st.data.devices.map((d) => d.entityId);
    const [x] = ids.splice(i, 1);
    ids.splice(i + dir, 0, x);
    put({ order: ids });
  };
  if (!st.data) return html`<div class="loading">Loading…</div>`;
  const d = st.data;
  const f = out.data?.forecast;
  const cfg = d.settings;
  return html`<div class="au-ss">
    <section class="card au-ss-main">
      <${Head} icon="sun" tone="solar" title="Run flexible devices on spare solar"
        sub="Devices with the Deferrable role start one at a time, in this order, when there's solar to spare, and stop in reverse when there isn't."
        actions=${html`<${Toggle} checked=${d.enabled} disabled=${busy} onChange=${(v) => put({ enabled: v })} label=${d.enabled ? 'On' : 'Off'} />`} />
      <div class="au-ss-now">
        <div><span>Spare solar now</span><b>${kw(d.surplusW)}</b>
          <small class="muted">${d.shortfall ? 'Importing or using the battery' : d.surplusW > 0 ? 'Available for flexible devices' : 'Nothing spare right now'}</small></div>
        ${d.startInS !== null && html`<div><span>Next start in</span><b>${Math.ceil(d.startInS / 60)} min</b><small class="muted">if the surplus holds</small></div>`}
        ${d.stopInS !== null && html`<div><span>Next stop in</span><b>${Math.ceil(d.stopInS / 60)} min</b><small class="muted">if the shortfall continues</small></div>`}
      </div>
      ${d.devices.length === 0
        ? html`<div class="empty au-empty"><${Ic} name="plug-zap" />No flexible devices yet.
            <span class="small">On the <a href="/devices">Smart devices</a> page, give devices such as a water heater, pool pump or EV charger the <b>Deferrable</b> role.</span></div>`
        : html`<div class="list au-ss-list">${d.devices.map((x, i) => html`<div class="list-item" key=${x.entityId}>
            <span class="au-ord">${i + 1}</span>
            <div class="list-main">
              <div class="list-title">${x.name} <${Badge} kind=${STATUS_BADGE[x.status][0]}>${STATUS_BADGE[x.status][1]}<//></div>
              <div class="list-sub">${[x.note, x.powerSource === 'measured' ? `Drawing ${kw(x.powerW)} now` : null].filter(Boolean).join(' · ')}</div>
            </div>
            <label class="au-ss-power" title="What it draws when on"><input type="number" min="1" max="50000" step="50" placeholder="Power"
              value=${x.setW ?? ''} onChange=${(e) => setPower(x, e.target.value)} /><span>W</span></label>
            <button type="button" class="icon-btn au-ibtn" aria-label="Move up" disabled=${i === 0 || busy} onClick=${() => move(i, -1)}><${Ic} name="arrow-up" size="sm" /></button>
            <button type="button" class="icon-btn au-ibtn" aria-label="Move down" disabled=${i === d.devices.length - 1 || busy} onClick=${() => move(i, 1)}><${Ic} name="arrow-down" size="sm" /></button>
          </div>`)}</div>`}
      <details class="au-ss-more">
        <summary>Timing and battery</summary>
        <div class="au-ss-grid">
          ${[
            ['batterySoc', 'Battery charges first, up to', '%', 0, 100],
            ['startMarginW', 'Headroom before starting', 'W', 0, 10000],
            ['startMinutes', 'Surplus must last', 'min', 0, 120],
            ['stopMinutes', 'Shortfall must last', 'min', 0, 120],
            ['minOnMinutes', 'Minimum run time', 'min', 0, 1440],
          ].map(([k, label, unit, min, max]) => html`<label class="au-f"><span>${label}</span>
            <span class="au-unit"><input type="number" min=${min} max=${max} value=${cfg[k]} onChange=${(e) => put({ [k]: Number(e.target.value) })} /><span>${unit}</span></span></label>`)}
        </div>
        <p class="muted small">Below the battery level, only power that would otherwise be exported counts as spare. Sunroost stops only devices it started itself, and never switches a device again within 2 minutes.</p>
      </details>
    </section>
    <section class="card au-ss-fc">
      <${Head} icon="cloud-sun" tone="solar" title="Expected solar" sub=${f ? `Estimate ${SOURCE_TEXT[f.factor.source](f.factor.days)}` : 'Needs your location (Configuration › General)'} />
      ${f && html`<div class="au-ss-now">
        <div><span>Today</span><b>${f.todayKwh ?? '–'} kWh</b><small class="muted">${f.restOfTodayKwh ?? '–'} kWh still to come</small></div>
        <div><span>Tomorrow</span><b>${f.tomorrowKwh ?? '–'} kWh</b></div>
      </div>
      <div class="au-ss-bars" aria-label="Expected solar, next 24 hours">${f.hourly.map((h) => html`<span title=${`${h.time.slice(11, 16)}: ${kw(h.w)}`}
        style=${`height:${Math.max(2, Math.round((h.w / Math.max(1, ...f.hourly.map((x) => x.w))) * 100))}%`}></span>`)}</div>
      <div class="au-ss-axis muted small"><span>${f.hourly[0]?.time.slice(11, 16)}</span><span>next 24 h</span></div>`}
      <label class="au-f"><span>Solar array size</span><span class="au-unit"><input type="number" min="0" max="1000" step="0.1" value=${s['site.pv_kwp'] || ''} placeholder="e.g. 5.4"
        onChange=${(e) => saveSettings({ 'site.pv_kwp': Number(e.target.value) || 0 }).then(() => out.reload(), (err) => toast(err.message, 'bad'))} /><span>kWp</span></span></label>
      <p class="muted small">Used until Sunroost has learned from about a week of its own data. In rules, use the measurements "Solar surplus", "PV forecast today", "PV forecast tomorrow" and "PV forecast rest of today".</p>
    </section>
  </div>`;
}

// ---------- Templates ----------

function TemplatesTab({ data }) {
  const { data: tpls, error } = useLoad('/api/automations/templates');
  const { opts, list } = data;
  if (error && !tpls) return html`<section class="card"><${EmptyState} icon="triangle-alert" title="Couldn't load templates">${error}<//></section>`;
  if (!tpls) return html`<div class="loading">Loading…</div>`;
  const used = new Set(list.map((a) => a.name));
  return html`<div class="au-tpl-grid">${tpls.map((t) => {
    const tone = t.requires.includes('price') ? 'accent' : t.requires.includes('sun') || t.requires.includes('forecast') ? 'solar'
      : t.requires.includes('grid') ? 'grid' : t.requires.includes('battery') ? 'battery' : 'load';
    return html`<article class=${`card au-tpl ${t.available ? '' : 'na'}`}>
      <div class="au-tpl-head"><${IconChip} name=${t.icon} tone=${tone} />${used.has(t.rule.name) && html`<span class="badge badge-ok">Added</span>`}</div>
      <h3>${t.name}</h3>
      <p class="muted small">${t.description}</p>
      <div class="au-req">${t.requires.map((r) => {
        const q = REQUIRES[r];
        const ok = q ? q.ok(opts) : true;
        return html`<span class=${`au-chip ${ok ? '' : 'warn'}`} title=${ok ? '' : `${q?.label ?? r} not configured`}><${Ic} name=${q?.icon ?? 'check'} size="sm" />${q?.label ?? r}</span>`;
      })}${t.requires.length === 0 && html`<span class="au-chip"><${Ic} name="check" size="sm" />Works everywhere</span>`}</div>
      ${!t.available && t.reason && html`<p class="au-tpl-why"><${Ic} name="circle-alert" size="sm" />${t.reason}</p>`}
      <div class="au-tpl-foot">
        <button type="button" class="btn btn-sm btn-primary" disabled=${!t.available} onClick=${() => navigate(`/automations?edit=new&template=${encodeURIComponent(t.id)}`)}>
          <${Ic} name="wand-sparkles" size="sm" />Use template</button>
      </div>
    </article>`;
  })}</div>`;
}

// ---------- Scenes ----------

function SceneModal({ open, scene, opts, onClose, onSaved }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    const d = defOf(opts, opts.primarySetting) ?? writable(opts)[0];
    setS(scene ? clone(scene) : { name: '', icon: 'moon', color: 'accent', settings: [{ inverter: 'all', setting: d?.key ?? '', value: defaultValue(d) }] });
  }, [open, scene?.id]);
  if (!open || !s) return null;
  const set = (p) => setS({ ...s, ...p });
  const setRow = (i, p) => set({ settings: s.settings.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: s.name, icon: s.icon, color: s.color, settings: s.settings };
      if (scene) await api.put(`/api/scenes/${scene.id}`, body);
      else await api.post('/api/scenes', body);
      toast('Scene saved');
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  return html`<${Modal} open=${open} title=${scene ? 'Edit scene' : 'New scene'} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : 'Save scene'}</button>`}>
    <div class="au-scene-form">
      <div class="au-scene-top">
        <span class=${`chip-ic ${s.color}`}><${Ic} name=${s.icon} /></span>
        <input value=${s.name} maxlength="60" placeholder="Scene name, e.g. Evening" aria-label="Scene name" onInput=${(e) => set({ name: e.target.value })} />
      </div>
      <div class="au-f wide"><span>Icon</span><div class="au-icons" role="radiogroup" aria-label="Icon">${SCENE_ICONS.map((i) => html`<button type="button" role="radio" aria-checked=${s.icon === i} aria-label=${i}
        class=${`au-icon-opt ${s.icon === i ? 'on' : ''}`} onClick=${() => set({ icon: i })}><${Ic} name=${i} size="sm" /></button>`)}</div></div>
      <div class="au-f wide"><span>Colour</span><div class="au-colors" role="radiogroup" aria-label="Colour">${TONES.map((t) => html`<button type="button" role="radio" aria-checked=${s.color === t}
        aria-label=${TONE_LABEL[t]} title=${TONE_LABEL[t]} class=${`au-color ${s.color === t ? 'on' : ''}`} style=${`--c:var(--${t})`} onClick=${() => set({ color: t })}></button>`)}</div></div>
      <div class="au-f wide"><span>Settings</span>
        <div class="au-scene-rows">${s.settings.map((r, i) => html`<div class="au-scene-row">
          <div class="au-fields">
            <${InverterSelect} opts=${opts} value=${r.inverter} onChange=${(v) => setRow(i, { inverter: v })} />
            <${F} label="Setting"><${SettingPick} opts=${opts} value=${r.setting} onChange=${(k) => setRow(i, { setting: k, value: defaultValue(defOf(opts, k)) })} /><//>
            <${F} label="Value"><${ValueField} def=${defOf(opts, r.setting)} value=${r.value} onChange=${(v) => setRow(i, { value: v })} /><//>
          </div>
          <button type="button" class="icon-btn au-ibtn" aria-label="Remove setting" title="Remove" onClick=${() => set({ settings: s.settings.filter((_, k) => k !== i) })}><${Ic} name="x" size="sm" /></button>
        </div>`)}
        <button type="button" class="btn btn-sm au-add-btn" onClick=${() => {
          const d = writable(opts).find((x) => !s.settings.some((r) => r.setting === x.key)) ?? writable(opts)[0];
          set({ settings: [...s.settings, { inverter: 'all', setting: d?.key ?? '', value: defaultValue(d) }] });
        }}><${Ic} name="plus" size="sm" />Add setting</button></div>
      </div>
      ${error && html`<div class="notice notice-bad small au-note"><${Ic} name="circle-alert" size="sm" />${error}</div>`}
    </div>
  <//>`;
}

function SceneCard({ s, opts, onEdit, reload }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/scenes/${s.id}/apply`);
      setRes(r);
      toast(r.result === 'ok' ? `Scene "${s.name}" applied` : `Scene "${s.name}": ${RESULT_BADGE[r.result]?.[1] ?? r.result}`, r.result === 'failed' ? 'bad' : 'ok');
    } catch (err) {
      setRes({ error: err.message });
    }
    setBusy(false);
  };
  const del = async () => {
    if (!window.confirm(`Delete scene "${s.name}"?`)) return;
    await api.del(`/api/scenes/${s.id}`).then(() => toast('Scene deleted'), (err) => toast(err.message, 'bad'));
    reload();
  };
  const inv = (i) => (i === 'all' || isNone(i) ? '' : ` · Inverter ${Number(i) + 1}`);
  return html`<article class="card au-scene">
    <div class="au-scene-head">
      <span class=${`chip-ic ${s.color}`}><${Ic} name=${s.icon} /></span>
      <div class="au-scene-name"><h3>${s.name}</h3><span class="muted small">${plural(s.settings.length, 'setting')}</span></div>
      <${Menu} label=${`Actions for scene ${s.name}`} items=${[
        { icon: 'pencil', label: 'Edit', onClick: onEdit },
        { icon: 'trash-2', label: 'Delete', onClick: del, danger: true },
      ]} />
    </div>
    <div class="au-scene-list">${s.settings.map((r) => {
      const d = defOf(opts, r.setting);
      return html`<div class="au-scene-set"><span class="muted">${d?.label ?? r.setting}${inv(r.inverter)}</span><b>${fmtValue(d, r.value)}</b></div>`;
    })}</div>
    ${res && (res.error ? html`<div class="notice notice-bad small au-note">${res.error}</div>` : html`<div class="au-scene-res"><${ActionResults} actions=${res.actions} /></div>`)}
    <button type="button" class=${`btn au-apply ${s.color}`} disabled=${busy} onClick=${apply}><${Ic} name="play" size="sm" />${busy ? 'Applying…' : 'Apply'}</button>
  </article>`;
}

function ScenesTab({ data, reload, modal, setModal }) {
  const { scenes, opts } = data;
  return html`<div>
    ${scenes.length === 0
      ? html`<section class="card"><${EmptyState} icon="layers" title="No scenes yet"
          action=${html`<button type="button" class="btn btn-primary" onClick=${() => setModal({ scene: null })}><${Ic} name="plus" size="sm" />New scene</button>`}>
          A scene is a named set of settings, like "Evening" or "Holiday", that you apply with one tap or from a rule.<//></section>`
      : html`<div class="au-scene-grid">
          ${scenes.map((s) => html`<${SceneCard} key=${s.id} s=${s} opts=${opts} reload=${reload} onEdit=${() => setModal({ scene: s })} />`)}
          <button type="button" class="au-scene-new" onClick=${() => setModal({ scene: null })}><span class="au-big-ic"><${Ic} name="plus" size="lg" /></span><b>New scene</b><span class="muted small">Group settings you change together</span></button>
        </div>`}
    <${SceneModal} open=${Boolean(modal)} scene=${modal?.scene} opts=${opts} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />
  </div>`;
}

// ---------- History ----------

function HistoryTab({ data, version }) {
  const [limit, setLimit] = useState(200);
  const { data: runs, error } = useLoad(`/api/automations/runs?limit=${limit}`, [version], 30_000);
  const [src, setSrc] = useState('');
  const [result, setResult] = useState('');
  const [dry, setDry] = useState(true);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const { list, scenes } = data;
  const ql = q.trim().toLowerCase();
  const rows = (runs ?? []).filter((r) => {
    if (src && src !== (r.sceneId ? `s${r.sceneId}` : `a${r.automationId}`)) return false;
    if (result && r.result !== result) return false;
    if (!dry && r.dryRun) return false;
    if (ql) {
      const s = sourceOf(r, list, scenes);
      if (!`${s.name} ${r.trigger} ${r.actions.map((x) => `${x.text} ${x.message}`).join(' ')}`.toLowerCase().includes(ql)) return false;
    }
    return true;
  });
  const toggle = (id) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const srcOpts = [{ value: '', label: 'All rules and scenes' }, ...list.map((a) => ({ value: `a${a.id}`, label: a.name || a.typeName })),
    ...scenes.map((s) => ({ value: `s${s.id}`, label: `Scene: ${s.name}` }))];
  return html`<section class="card au-hist">
    <div class="au-toolbar">
      <span class="au-search"><${Ic} name="search" size="sm" /><input type="search" placeholder="Search runs" aria-label="Search runs" value=${q} onInput=${(e) => setQ(e.target.value)} /></span>
      <${Select} value=${src} options=${srcOpts} onChange=${setSrc} aria-label="Rule or scene" />
      <${Select} value=${result} options=${[{ value: '', label: 'Any result' }, { value: 'ok', label: 'OK' }, { value: 'partial', label: 'Partial' }, { value: 'failed', label: 'Failed' }, { value: 'skipped', label: 'Skipped' }]}
        onChange=${setResult} aria-label="Result" />
      <${Toggle} checked=${dry} onChange=${setDry} label="Dry runs" />
    </div>
    ${error && !runs ? html`<${EmptyState} icon="triangle-alert" title="Couldn't load history">${error}<//>`
      : !runs ? html`<div class="loading">Loading…</div>`
      : rows.length === 0 ? html`<${EmptyState} icon="inbox" title=${runs.length ? 'No matching runs' : 'No runs yet'}>${runs.length ? 'Try other filters.' : 'Runs of rules and scenes show up here for 30 days.'}<//>`
      : html`<div class="table-wrap"><table class="table au-htable">
          <thead><tr><th>Time</th><th>Rule or scene</th><th>Trigger</th><th>Result</th><th>Actions</th><th><span class="au-sr">Details</span></th></tr></thead>
          <tbody>${rows.map((r) => {
            const s = sourceOf(r, list, scenes);
            const isOpen = open.has(r.id);
            return html`<tr class=${`au-hrow ${isOpen ? 'open' : ''}`} onClick=${() => toggle(r.id)}>
                <td class="tabular" title=${fmtDateTime(r.ts)}>${whenText(r.ts)}</td>
                <td><span class="au-hsrc"><${IconChip} name=${s.icon} tone=${s.tone} small /><span><b>${s.name}</b><small class="muted">${s.kind}</small></span></span></td>
                <td class="au-htrig">${r.trigger}</td>
                <td><${ResultBadge} result=${r.result} dry=${r.dryRun} /></td>
                <td class="tabular">${r.actions.length}</td>
                <td><button type="button" class="icon-btn au-ibtn" aria-expanded=${isOpen} aria-label="Details" onClick=${(e) => { e.stopPropagation(); toggle(r.id); }}><${Ic} name="chevron-down" size="sm" class="au-rot" /></button></td>
              </tr>
              ${isOpen && html`<tr class="au-hdetail"><td colspan="6"><${ActionResults} actions=${r.actions} />${s.href && html`<a class="small" href=${s.href}>Open ${s.kind.toLowerCase()}</a>`}</td></tr>`}`;
          })}</tbody>
        </table></div>
        <div class="au-hfoot muted small"><span>${rows.length} of ${runs.length} runs</span>
          ${runs.length >= limit && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setLimit(limit + 200)}>Load more</button>`}</div>`}
  </section>`;
}

// ---------- Settings ----------

function SettingsTab({ data, reload }) {
  const s = useStore(appSettings);
  const [ntfy, setNtfy] = useState(s?.['notify.ntfy_url'] ?? '');
  const [hook, setHook] = useState(s?.['notify.webhook_url'] ?? '');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState({});
  useEffect(() => {
    setNtfy(s?.['notify.ntfy_url'] ?? '');
    setHook(s?.['notify.webhook_url'] ?? '');
  }, [s?.['notify.ntfy_url'], s?.['notify.webhook_url']]);
  const dirty = ntfy !== (s?.['notify.ntfy_url'] ?? '') || hook !== (s?.['notify.webhook_url'] ?? '');
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await saveSettings({ 'notify.ntfy_url': ntfy.trim(), 'notify.webhook_url': hook.trim() });
      toast('Notification settings saved');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
  };
  const test = async (channel) => {
    setTests((t) => ({ ...t, [channel]: { busy: true } }));
    try {
      const r = await api.post('/api/notify/test', { channel });
      setTests((t) => ({ ...t, [channel]: r.ok ? { ok: true, message: 'Sent' } : { ok: false, message: r.error } }));
    } catch (err) {
      setTests((t) => ({ ...t, [channel]: { ok: false, message: err.message } }));
    }
  };
  const TestBtn = ({ channel, disabled }) => {
    const t = tests[channel];
    return html`<span class="au-test"><button type="button" class="btn btn-sm" disabled=${disabled || t?.busy} title=${disabled ? 'Save first' : ''} onClick=${() => test(channel)}>
      <${Ic} name="send" size="sm" />${t?.busy ? 'Sending…' : 'Send test'}</button>
      ${t && !t.busy && html`<span class=${`setting-result ${t.ok ? 'ok' : 'bad'}`}>${t.message}</span>`}</span>`;
  };
  const Explain = ({ icon, tone, title, children }) => html`<div class="list-item au-explain"><${IconChip} name=${icon} tone=${tone} small />
    <div class="list-main"><div class="list-title">${title}</div><div class="au-explain-text">${children}</div></div></div>`;
  const limit = (key, v, label) => saveSettings({ [key]: Math.max(0, Math.round(Number(v) || 0)) })
    .then(() => toast(`${label} saved`), (err) => toast(err.message, 'bad'));
  return html`<div class="au-set-grid">
    <section class="card">
      <${Head} icon="shield" tone="battery" title="Device safety" sub="Limits on what automations do to smart devices" />
      <label class="field"><span class="field-label">Switches per device per hour</span><span class="field-control">
        <span class="au-unit"><input type="number" min="0" max="120" value=${s?.['automation.device_max_switches_per_hour'] ?? 12}
          onChange=${(e) => limit('automation.device_max_switches_per_hour', e.target.value, 'Switch limit')} /><span>max</span></span>
        <small class="help">Automations and spare solar won't switch one device more often than this (0 = no limit). Protects compressors and relays.</small></span></label>
      <label class="field"><span class="field-label">Loop protection</span><span class="field-control">
        <span class="au-unit"><input type="number" min="0" max="200" value=${s?.['automation.max_runs_per_10min'] ?? 12}
          onChange=${(e) => limit('automation.max_runs_per_10min', e.target.value, 'Loop protection')} /><span>runs / 10 min</span></span>
        <small class="help">A rule that runs this often in 10 minutes is paused until things calm down (0 = off). Catches rules that trigger each other.</small></span></label>
      <p class="muted small">Always on: a device isn't switched again within 2 minutes; critical devices are never switched off; protected devices only by rules that allow it, and only when their interlock holds.</p>
    </section>
    <form class="card" onSubmit=${save}>
      <${Head} icon="bell-ring" tone="solar" title="Notification channels" sub="Where Notify actions send their messages" />
      <div class="field"><span class="field-label">In-app feed</span><span class="field-control"><span class="au-ctl-row">
        <span class="muted small">Always on. Shown under the bell in the top bar.</span><${TestBtn} channel="app" /></span></span></div>
      <label class="field"><span class="field-label">ntfy topic URL</span><span class="field-control">
        <span class="au-ctl-row"><input type="url" value=${ntfy} placeholder="https://ntfy.sh/my-solar-xyz" onInput=${(e) => setNtfy(e.target.value)} /><${TestBtn} channel="ntfy" disabled=${dirty || !s?.['notify.ntfy_url']} /></span>
        <small class="help">Push notifications to your phone with the free ntfy app. Use a hard-to-guess topic name.</small></span></label>
      <label class="field"><span class="field-label">Webhook URL</span><span class="field-control">
        <span class="au-ctl-row"><input type="url" value=${hook} placeholder="https://example.com/hooks/solar" onInput=${(e) => setHook(e.target.value)} /><${TestBtn} channel="webhook" disabled=${dirty || !s?.['notify.webhook_url']} /></span>
        <small class="help">Receives a POST with JSON <code>{"title", "message", "ts"}</code> (Home Assistant, Node-RED, Slack…).</small></span></label>
      <div class="form-actions">${dirty && html`<span class="muted small au-grow">Save before testing a changed URL.</span>`}
        <button type="submit" class="btn btn-primary" disabled=${busy || !dirty}>${busy ? 'Saving…' : 'Save'}</button></div>
    </form>
    <section class="card">
      <${Head} icon="book-open" tone="load" title="How automations work" sub="Priorities, safety limits and suspend" />
      <div class="list">
        <${Explain} icon="trophy" tone="accent" title="Priority and conflicts">When two rules want to change the same setting at the same moment, the higher priority wins; on a tie, the most recently triggered rule wins. The losing rule's run records the action as skipped. A rule can't control a setting owned by an enabled classic automation.<//>
        <${Explain} icon="shield-check" tone="battery" title="Write protection">Every write is validated against the inverter's setting limits and passes through the rate limiter. Writes held back show as "Held by write protection". Settings already at the wanted value are skipped.<//>
        <${Explain} icon="timer" tone="load" title="Cooldown and daily limits">A rule waits for its cooldown between runs and stops at its daily maximum. Only runs that did something count. Run now ignores triggers, cooldown and limits.<//>
        <${Explain} icon="circle-pause" tone="solar" title="Suspend">Suspending stops all setting writes from rules and classic automations until the time is up or you resume. Notifications and MQTT actions still run. Scenes applied by hand still work.<//>
        <${Explain} icon="undo-2" tone="grid" title="Delays and revert">Waits keep running in the background; a restart or a new run cancels them. Revert restores the previous values after the set time, but only if nothing else changed the setting meanwhile.<//>
        <${Explain} icon="history" tone="" title="History">Runs, including skipped ones with their reason, are kept for 30 days on the History tab.<//>
      </div>
    </section>
  </div>`;
}

// ---------- Page ----------

const TABS = [
  { value: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { value: 'solar', label: 'Spare solar', icon: 'sun' },
  { value: 'rules', label: 'Rules', icon: 'workflow' },
  { value: 'templates', label: 'Templates', icon: 'layout-template' },
  { value: 'scenes', label: 'Scenes', icon: 'layers' },
  { value: 'history', label: 'History', icon: 'history' },
  { value: 'settings', label: 'Settings', icon: 'settings' },
];

export default function Automations() {
  const q = useQuery();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [classicOpen, setClassicOpen] = useState(false);
  const [sceneModal, setSceneModal] = useState(null);
  const [editingMap, setEditingMap] = useState({});
  const pending = useRef(null);

  const reload = async () => {
    try {
      const [opts, l, scenes] = await Promise.all([api.get('/api/automations/options'), api.get('/api/automations'), api.get('/api/scenes')]);
      setData({ opts, list: l.automations, scenes, overrideUntil: l.overrideUntil, connected: l.connected, affectedSettings: l.affectedSettings });
      setError(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    }
  };
  const reloadSoon = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      reload();
    }, 600);
  };
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    const off = onLog((line) => line.tag === 'automation' && reloadSoon());
    return () => {
      clearInterval(t);
      off();
      clearTimeout(pending.current);
    };
  }, []);

  // ?edit=<id> of a classic automation opens its inline editor on the Rules tab.
  const editParam = q.edit;
  const editTarget = data && editParam && editParam !== 'new' ? data.list.find((a) => String(a.id) === editParam) : null;
  useEffect(() => {
    if (editTarget && editTarget.type !== 'rule') {
      setEditingMap((m) => ({ ...m, [editTarget.id]: true }));
      navigate(`/automations?tab=rules&edit=${editTarget.id}`, { replace: true });
    }
  }, [editTarget?.id]);

  const tab = TABS.some((t) => t.value === q.tab) ? q.tab : 'overview';
  const building = editParam && (editParam === 'new' || editTarget?.type === 'rule' || (data && !editTarget));
  const setTab = (t) => navigate(`/automations${t === 'overview' ? '' : `?tab=${t}`}`, { replace: true });

  if (!data) {
    return html`<${Page} title="Automations">${error
      ? html`<section class="card"><${EmptyState} icon="triangle-alert" title="Couldn't load automations"
          action=${html`<button type="button" class="btn btn-sm" onClick=${reload}><${Ic} name="rotate-ccw" size="sm" />Retry</button>`}>${error}<//></section>`
      : html`<div class="loading">Loading…</div>`}<//>`;
  }

  if (building && q.tab !== 'rules') {
    const title = editParam === 'new' ? (q.template ? 'New rule from template' : 'New rule') : `Edit rule`;
    return html`<${Page} title=${title} crumbs=${[['Automations', '/automations?tab=rules']]}>
      <${Builder} key=${`${editParam}-${q.template ?? ''}-${q.device ?? ''}`} data=${data} editId=${editParam} templateId=${q.template} deviceId=${q.device} reload=${reload} />
    <//>`;
  }

  const setEditing = (id) => (on) => setEditingMap((m) => ({ ...m, [id]: on }));
  const action = tab === 'scenes'
    ? html`<button type="button" class="btn btn-primary" onClick=${() => setSceneModal({ scene: null })} aria-label="New scene"><${Ic} name="plus" size="sm" /><span class="au-btxt">New scene</span></button>`
    : tab === 'overview' || tab === 'rules' || tab === 'templates'
      ? html`<button type="button" class="btn btn-primary" onClick=${() => setNewOpen(true)} aria-label="New rule"><${Ic} name="plus" size="sm" /><span class="au-btxt">New rule</span></button>` : null;
  const suspended = data.overrideUntil > 0;

  return html`<${Page} title="Automations">
    <div class="au-page">
      <div class="au-top">
        <div class="au-tabs"><${Segmented} value=${tab} onChange=${setTab}
          options=${TABS.map((t) => ({ value: t.value, label: html`<${Ic} name=${t.icon} size="sm" /><span>${t.label}</span>` }))} /></div>
        ${action && html`<div class="au-top-act">${action}</div>`}
      </div>
      ${suspended && tab !== 'overview' && html`<div class="notice notice-warn au-note"><${Ic} name="circle-pause" size="sm" />Automations are paused until ${hhmm(data.overrideUntil)}. <a href="/automations">Resume on the overview</a></div>`}
      ${!data.connected && html`<div class="notice notice-info au-note"><${Ic} name="unplug" size="sm" />The inverter is not connected. Rules stay saved; setting writes resume once it reconnects.</div>`}
      ${tab === 'overview' && html`<${OverviewTab} data=${data} reload=${reload} version=${version} />`}
      ${tab === 'solar' && html`<${SpareSolarTab} />`}
      ${tab === 'rules' && html`<${RulesTab} data=${data} editingMap=${editingMap} setEditing=${setEditing} reload=${reload} onNew=${() => setNewOpen(true)} />`}
      ${tab === 'templates' && html`<${TemplatesTab} data=${data} />`}
      ${tab === 'scenes' && html`<${ScenesTab} data=${data} reload=${reload} modal=${sceneModal} setModal=${setSceneModal} />`}
      ${tab === 'history' && html`<${HistoryTab} data=${data} version=${version} />`}
      ${tab === 'settings' && html`<${SettingsTab} data=${data} reload=${reload} />`}
    </div>
    <${NewRuleModal} open=${newOpen} onClose=${() => setNewOpen(false)} onClassic=${() => setClassicOpen(true)} />
    <${AddModal} open=${classicOpen} opts=${data.opts} conds=${Object.fromEntries((data.opts.conditions ?? []).map((c) => [c.kind, c]))}
      onClose=${() => setClassicOpen(false)}
      onCreated=${(id) => { setClassicOpen(false); setEditingMap((m) => ({ ...m, [id]: true })); reload(); navigate(`/automations?tab=rules&edit=${id}`, { replace: true }); }} />
  <//>`;
}

const css = `

/* Page frame */
.au-page { display: flex; flex-direction: column; gap: 16px; }
.au-page .chip-ic.accent, .modal .chip-ic.accent, .au-build .chip-ic.accent { padding: 0; margin: 0; border: 0; } /* app.css '.accent' (legacy notice) also matches the accent chip tone */
.au-page .chip-ic.grid, .modal .chip-ic.grid, .au-build .chip-ic.grid { display: inline-grid; grid-template-columns: none; gap: 0; place-items: center; } /* app.css '.grid' layout */
.au-top { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
.au-tabs { min-width: 0; overflow-x: auto; scrollbar-width: none; flex: 0 1 auto; }
.au-tabs::-webkit-scrollbar { display: none; }
.au-tabs .seg { display: flex; width: max-content; background: var(--surface); box-shadow: var(--shadow); }
.au-tabs .seg button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; font-size: 13px; }
.au-tabs .seg button.on { background: var(--accent-soft); color: var(--accent-text); box-shadow: none; }
.au-tabs .seg button.on .ic { color: var(--accent); }
.au-top-act { flex: none; }
@media (max-width: 560px) { .au-btxt { display: none; } .au-top-act .btn { width: 40px; padding: 0; } }
.au-head { align-items: flex-start; flex-wrap: wrap; }
.au-head .card-actions { margin-left: auto; }
.au-head-main { display: flex; gap: 12px; align-items: center; min-width: 0; flex: 1 1 220px; }
.au-head-main p { margin: 2px 0 0; }
.au-note { display: flex; gap: 8px; align-items: center; margin: 0; }
.au-note .ic { flex: none; }
.au-page .au-note + .au-note { margin-top: -6px; }
.au-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.au-center { text-align: center; }
.au-center-c { justify-content: center; }
.au-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); margin-right: 8px; vertical-align: 1px; }
.au-grow { flex: 1; margin-right: auto; align-self: center; }
.au-none { margin: 4px 0; }
.au-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px 16px; }
.au-empty b { color: var(--heading); font-size: 15px; }
.au-empty > span:not(.au-big-ic) { max-width: 460px; margin-bottom: 8px; }
.au-empty-sm { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 12px; }
.au-empty-sm .ic { width: 24px; height: 24px; color: var(--faint); }
.au-big-ic { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 18px; background: var(--accent-soft); color: var(--accent); flex: none; }
.icon-btn.au-ibtn { width: 32px; height: 32px; color: var(--muted); flex: none; }
.icon-btn.au-ibtn:hover { color: var(--text); }
.icon-btn.au-ibtn:disabled { opacity: .35; cursor: default; }
.au-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 38px; height: 24px; padding: 0 8px; border-radius: 999px; background: var(--surface-3); color: var(--heading); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.au-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; font-weight: 550; color: var(--text); }
.au-chip .ic { color: var(--muted); width: 13px; height: 13px; }
.au-chip.warn { background: var(--warn-soft); border-color: transparent; color: #8a5a00; }
.au-chip.warn .ic { color: var(--warn); }
.au-chev { color: var(--faint); }
.au-rot { transition: transform .2s; }
.open > * > .au-rot, .open .au-run-hit .au-rot, button[aria-expanded="true"] > .au-rot { transform: rotate(180deg); }
.au-link { font: inherit; background: none; border: 0; padding: 0; color: var(--link); cursor: pointer; font-weight: 600; }
.au-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.au-toolbar select { width: auto; max-width: 240px; }
.au-search { position: relative; display: flex; align-items: center; flex: 1 1 220px; max-width: 360px; }
.au-search .ic { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
.au-search input { padding-left: 36px; max-width: none; }
.au-seg-scroll { max-width: 100%; overflow-x: auto; scrollbar-width: none; }

/* Kebab / add menus */
.au-menu, .au-add { position: relative; }
.au-menu-pop { position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; min-width: 190px; padding: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-lift); display: flex; flex-direction: column; }
.au-menu-pop button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font: inherit; font-size: 13px; font-weight: 550; color: var(--text); background: none; border: 0; border-radius: 9px; padding: 8px 10px; cursor: pointer; }
.au-menu-pop button:hover:not(:disabled) { background: var(--surface-2); }
.au-menu-pop button:disabled { opacity: .45; cursor: not-allowed; }
.au-menu-pop button .ic { color: var(--muted); }
.au-menu-pop button.danger, .au-menu-pop button.danger .ic { color: var(--bad); }
.au-add-pop { left: 0; right: auto; width: min(320px, calc(100vw - 48px)); max-height: 360px; overflow-y: auto; }
.au-add-pop button { align-items: flex-start; }
.au-add-pop button .ic { margin-top: 2px; }
.au-add-pop button span { display: flex; flex-direction: column; }
.au-add-pop small { color: var(--muted); font-weight: 450; font-size: 11.5px; line-height: 1.35; }
.au-add-btn { border-style: dashed; color: var(--accent-text); }

/* Overview */
.au-ov { display: flex; flex-direction: column; gap: 16px; }
.au-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.au-kpis .kpi-value small { font-size: 13px; }
.au-kpis .kpi-delta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; display: block; }
.au-kpis .kpi-body { min-width: 0; flex: 1; }
.au-kpi-suspend { display: flex; flex-direction: column; gap: 12px; }
.au-kpi-suspend.on { background: linear-gradient(135deg, var(--warn-soft), var(--surface) 70%); }
.au-susp-ctl { display: flex; gap: 8px; align-items: center; margin-top: auto; }
.au-susp-ctl select { padding-top: 5px; padding-bottom: 5px; height: 30px; font-size: 12.5px; flex: 1; min-width: 0; }
@media (max-width: 1200px) { .au-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .au-kpis { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
.au-ss { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .au-ss { grid-template-columns: minmax(0, 1fr); } }
.au-ss-now { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 4px 0 14px; }
.au-ss-now > div { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
.au-ss-now span { font-size: 11.5px; color: var(--muted); }
.au-ss-now b { font-size: 20px; color: var(--heading); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.au-ss-list .list-item { gap: 10px; }
.au-ss-list .list-title { display: flex; align-items: center; gap: 8px; white-space: normal; }
.au-ss-list .list-sub { white-space: normal; }
@media (max-width: 560px) {
  .au-ss-list .list-item { flex-wrap: wrap; }
  .au-ss-list .list-main { flex: 1 1 calc(100% - 40px); }
  .au-ss-list .au-ss-power { margin-left: 32px; }
}
.au-ss-power { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.au-ss-power input { width: 86px; max-width: 86px; padding: 6px 8px; }
.au-ss-power span { font-size: 12px; color: var(--muted); }
.au-ss-more { margin-top: 12px; }
.au-ss-more summary { cursor: pointer; font-weight: 600; color: var(--heading); font-size: 13.5px; }
.au-ss-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 10px 0 6px; }
.au-ss-bars { display: flex; align-items: flex-end; gap: 3px; height: 70px; margin: 2px 0 4px; }
.au-ss-bars span { flex: 1; background: var(--solar); border-radius: 3px 3px 0 0; opacity: .85; min-width: 0; }
.au-ss-axis { display: flex; justify-content: space-between; margin-bottom: 12px; }
.au-ss-fc .au-f { margin-top: 4px; }
.au-ov-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .au-ov-grid { grid-template-columns: minmax(0, 1fr); } }
.au-track { margin: 4px 0 8px; }
.au-track-bar { position: relative; height: 40px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--border); }
.au-track-grid { position: absolute; top: 6px; bottom: 6px; width: 1px; background: var(--border); }
.au-track-now { position: absolute; left: 0; top: -3px; bottom: -3px; width: 3px; border-radius: 2px; background: var(--heading); }
.au-mark { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: var(--c); border: 2.5px solid var(--surface); box-shadow: 0 1px 4px rgba(17, 24, 39, .25); cursor: pointer; transition: transform .15s; }
.au-mark:hover, .au-mark:focus-visible { transform: scale(1.35); z-index: 3; outline: none; }
.au-tip { display: none; position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); width: 240px; padding: 10px 12px; border-radius: 12px; background: var(--heading); color: #fff; font-size: 12px; line-height: 1.4; box-shadow: var(--shadow-lift); pointer-events: none; z-index: 5; }
.au-tip b { display: block; margin-bottom: 2px; }
.au-tip span { color: #c9ced8; }
.au-mark:hover .au-tip, .au-mark:focus-visible .au-tip { display: block; }
.au-track-axis { position: relative; height: 18px; margin-top: 6px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.au-track-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.au-track-axis span:first-child { transform: none; font-weight: 650; color: var(--heading); }
.au-track-axis span:last-child { transform: translateX(-100%); }
@media (max-width: 560px) { .au-track-axis .minor { display: none; } .au-tip { width: 200px; } }
.au-li { color: inherit; text-decoration: none; }
a.au-li:hover, button.au-li:hover { text-decoration: none; background: var(--surface-2); }
.au-up-list .list-item, .au-up .list .list-item, .au-act .list-item { padding-left: 6px; padding-right: 6px; border-radius: 10px; }
.au-time { display: flex; flex-direction: column; width: 64px; flex: none; font-variant-numeric: tabular-nums; }
.au-time b { color: var(--heading); font-size: 14px; }
.au-time small { color: var(--muted); font-size: 11px; white-space: nowrap; }
.au-dotc { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; flex: none; background: color-mix(in srgb, var(--c) 14%, var(--surface)); color: var(--c); }
.au-sub-h { display: flex; align-items: center; gap: 6px; margin: 16px 0 4px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.au-more { text-align: center; margin-top: 6px; }
.au-run-hit { width: 100%; font: inherit; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--grid-line); cursor: pointer; }
.au-run:last-child .au-run-hit { border-bottom: 0; }
.au-run-side { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.au-run-side small { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.au-run-body { padding: 4px 8px 12px 50px; }
@media (max-width: 560px) { .au-run-body { padding-left: 8px; } }

/* Action results */
.au-ares { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.au-ares li { display: flex; gap: 8px; align-items: flex-start; }
.au-ares li .ic { margin-top: 1px; }
.au-ares li.ok .ic { color: var(--ok); }
.au-ares li.bad .ic { color: var(--bad); }
.au-ares li.skip .ic { color: var(--faint); }
.au-ares b { font-weight: 600; color: var(--heading); }

/* Rules list */
.au-list { display: flex; flex-direction: column; gap: 10px; }
.au-row { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); transition: box-shadow .15s, border-color .15s; scroll-margin-top: 90px; }
.au-row:hover { border-color: #e2e5eb; box-shadow: var(--shadow); }
.au-row.open { box-shadow: var(--shadow); }
.au-row.off .au-row-main > .au-row-hit .chip-ic { filter: grayscale(.8); opacity: .6; }
.au-row.off .au-row-title { color: var(--muted); }
.au-row-main { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.au-row-hit { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 12px; text-align: left; font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: none; }
.au-row-hit:hover { text-decoration: none; }
.au-row-hit:hover .au-row-title { color: var(--accent-text); }
.au-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.au-row-title { font-weight: 650; color: var(--heading); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.au-id { color: var(--faint); font-weight: 550; font-size: 12.5px; }
.au-classic { padding: 1px 8px; font-size: 11px; }
.au-row-sum { font-size: 13px; color: var(--text); line-height: 1.45; }
.au-row-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--muted); }
.au-row-meta > span { display: inline-flex; align-items: center; gap: 5px; }
.au-row-meta .ic { width: 13px; height: 13px; color: var(--faint); }
.au-row-meta b { color: var(--heading); }
.au-row-meta .badge { padding: 1px 7px; font-size: 11px; }
.au-warnc { color: #a86f00; }
.au-warnc .ic { color: var(--warn) !important; }
.au-row-msg { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #8a5a00; }
.au-row-msg.bad { color: var(--bad); }
.au-row-side { display: flex; align-items: center; gap: 10px; flex: none; }
.au-row-body { border-top: 1px solid var(--border); padding: 16px; }
.au-lastline { margin: 0 0 12px; }
.au-run-res { margin: 0 14px 12px 66px; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); display: flex; flex-direction: column; gap: 8px; }
.au-run-res.bad { flex-direction: row; align-items: center; gap: 8px; color: var(--bad); font-size: 12.5px; }
.au-run-res.bad span { flex: 1; }
.au-run-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.au-run-top b { color: var(--heading); font-size: 13px; }
.au-run-top .au-ibtn, .au-run-res.bad .au-ibtn { margin-left: auto; width: 26px; height: 26px; }
@media (max-width: 760px) {
  .au-row-main { flex-wrap: wrap; padding: 12px; }
  .au-row-hit { flex: 1 1 100%; }
  .au-row-side { flex: 1 1 100%; justify-content: flex-end; padding-top: 8px; border-top: 1px dashed var(--border); }
  .au-row-side .badge { margin-right: auto; }
  .au-run-res { margin: 0 12px 12px; }
  .au-row-body { padding: 14px 12px; }
  .au-search { max-width: none; flex-basis: 100%; }
}

/* New rule modal */
.au-modal-lead { margin: 0 0 14px; }
.au-types { display: flex; flex-direction: column; gap: 10px; }
.au-type { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); transition: border-color .15s, box-shadow .15s, transform .15s; }
.au-type:hover:not(:disabled) { border-color: var(--accent); box-shadow: var(--shadow-lift); transform: translateY(-1px); }
.au-type:disabled { opacity: .55; cursor: not-allowed; }
.au-type .chip-ic { width: 46px; height: 46px; border-radius: 14px; }
.au-type-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.au-type-text b { color: var(--heading); font-size: 14.5px; }
.au-type-text span { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
.au-type-text em { font-style: normal; font-size: 12px; color: var(--bad); font-weight: 550; }
.au-type-chev { color: var(--faint); }
.au-new select { max-width: none; }

/* Builder */
.au-build { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
.au-build-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.au-build-side { position: sticky; top: 84px; min-width: 0; }
@media (max-width: 1100px) { .au-build { grid-template-columns: minmax(0, 1fr); } .au-build-side { position: static; } }
.au-ident { padding: 18px 22px; }
.au-ident-row { display: flex; align-items: flex-start; gap: 14px; }
.au-ident-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.au-name { font-size: 20px; font-weight: 700; letter-spacing: -.01em; color: var(--heading); border-color: transparent; padding: 4px 8px; margin-left: -8px; max-width: none; }
.au-desc { font-size: 13px; color: var(--muted); border-color: transparent; padding: 4px 8px; margin-left: -8px; resize: vertical; min-height: 30px; }
.au-name:hover, .au-desc:hover { border-color: #e1e4ea; }
.au-sec { padding: 20px 22px; }
.au-sec.has-err { border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); }
.au-sec-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.au-sec-step { font-size: 11px; font-weight: 750; text-transform: uppercase; letter-spacing: .08em; color: var(--accent-text); background: var(--accent-soft); padding: 4px 10px; border-radius: 8px; min-width: 64px; text-align: center; }
.au-sec-title { flex: 1 1 200px; min-width: 0; }
.au-sec-title p { margin: 2px 0 0; }
.au-sec .au-note { margin-bottom: 12px; }
.au-items { display: flex; flex-direction: column; }
.au-item { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 12px 14px 14px; }
.au-item.has-err { border-color: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.au-item-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.au-item-head .chip-ic.sm { width: 30px; height: 30px; }
.au-item-title { flex: 1; min-width: 0; color: var(--heading); font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-item-tools { display: flex; gap: 4px; flex: none; }
.au-item-tools .au-ibtn { width: 28px; height: 28px; }
.au-ord { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; background: var(--heading); color: #fff; font-size: 11.5px; font-weight: 700; flex: none; }
.au-item .au-fields { margin: 0; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
.au-f.wide { grid-column: 1 / -1; }
.au-f textarea { max-width: none; font-size: 13.5px; }
.au-item-err { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: var(--bad); font-size: 12.5px; font-weight: 550; }
.au-fnote { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; margin: 0; }
.au-fnote .ic { flex: none; }
.au-unit { display: flex; align-items: center; gap: 6px; min-width: 0; }
.au-unit input { min-width: 0; flex: 1; }
.au-unit span { color: var(--muted); font-size: 12.5px; font-weight: 550; white-space: nowrap; }
.au-range { display: flex; align-items: center; gap: 12px; }
.au-range input[type="range"] { flex: 1; padding: 0; border: 0; accent-color: var(--accent); box-shadow: none; max-width: none; }
.au-range .au-unit { flex: 0 0 120px; }
.au-slot .slot-input { flex-wrap: wrap; }
.au-join { display: flex; align-items: center; justify-content: center; position: relative; height: 26px; }
.au-join::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: var(--border); }
.au-join span { position: relative; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); background: var(--surface); padding: 0 8px; }
.au-adds { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.au-group { display: flex; flex-direction: column; }
.au-group-op { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.au-group.nested .au-group-op { margin-bottom: 8px; }
.au-subgroup { border: 1.5px dashed #d8dce4; border-radius: 16px; padding: 10px 12px 12px; background: var(--surface-2); }
.au-subgroup-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--muted); font-size: 12.5px; }
.au-subgroup-head b { flex: 1; color: var(--heading); }
.au-subgroup .au-join span { background: var(--surface-2); }
.au-actions { display: flex; flex-direction: column; gap: 10px; }
.au-actions .au-adds { margin-top: 2px; }
.au-vars { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.au-var { font: inherit; font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--surface-2); color: var(--accent-text); cursor: pointer; }
.au-var:hover { border-color: var(--accent); background: var(--accent-soft); }
.au-f .seg { align-self: flex-start; }
.au-else-add { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px; font: inherit; font-size: 13px; font-weight: 600; color: var(--muted); background: transparent; border: 1.5px dashed #d5d9e0; border-radius: var(--radius-lg); cursor: pointer; }
.au-else-add:hover { color: var(--accent-text); border-color: var(--accent); background: var(--accent-soft); }
.au-opts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.au-opt { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px; background: var(--surface-2); min-width: 0; }
.au-opt.wide { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.au-opt-l { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.au-opt-l b { color: var(--heading); font-size: 13px; }
.au-opt .au-unit input { max-width: 140px; background: var(--surface); }
@media (max-width: 760px) { .au-opts { grid-template-columns: minmax(0, 1fr); } }
.au-prio { display: flex; align-items: center; gap: 12px; flex: 1 1 260px; max-width: 420px; }
.au-prio input { flex: 1; padding: 0; border: 0; accent-color: var(--accent); max-width: none; box-shadow: none; background: transparent; }
.au-season { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.au-season input { width: 84px; background: var(--surface); }
.au-build-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; position: sticky; bottom: 12px; z-index: 10; padding: 12px 14px; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow-lift); }
.au-save-err { margin-right: auto; display: flex; gap: 6px; align-items: center; color: var(--bad); font-size: 12.5px; font-weight: 550; min-width: 0; flex: 1 1 240px; }
@media (max-width: 860px) { .au-build-actions { bottom: 80px; } }
@media (max-width: 560px) {
  .au-sec, .au-ident { padding: 16px; }
  .au-item { padding: 10px 12px 12px; }
  .au-build-actions .btn { flex: 1 1 auto; }
  .au-range { flex-wrap: wrap; }
  .au-range .au-unit { flex: 1 1 100%; }
}

/* Preview */
.au-preview .card-head { margin-bottom: 12px; }
.au-sentence { font-size: 14.5px; line-height: 1.6; color: var(--heading); font-weight: 550; padding: 14px 16px; margin: 0 0 12px; border-radius: 14px; background: var(--accent-soft); border-left: 3px solid var(--accent); }
.au-meta-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.au-wouldrun { border-top: 1px solid var(--border); padding-top: 14px; }
.au-wr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.au-wr-head b { color: var(--heading); }
.au-wr-btn { width: 100%; }
.au-wr-note { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; margin: 0 0 10px; }
.au-verdict { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 12px; font-weight: 650; font-size: 13.5px; }
.au-verdict.ok { background: var(--ok-soft); color: var(--ok-text); }
.au-verdict.warn { background: var(--warn-soft); color: #8a5a00; }
.au-verdict.muted { background: var(--surface-2); color: var(--muted); }
.au-dry { display: flex; flex-direction: column; gap: 8px; }
.au-dry-h { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-top: 6px; }
.au-tree { display: flex; flex-direction: column; gap: 4px; }
.au-tree.nested { padding-left: 14px; border-left: 2px solid var(--border); margin-left: 6px; }
.au-tree-row { display: flex; gap: 7px; align-items: flex-start; font-size: 12.5px; line-height: 1.4; }
.au-tree-row .ic { margin-top: 1px; }
.au-tree-row.ok .ic { color: var(--ok); }
.au-tree-row.no .ic { color: var(--bad); }
.au-dry-acts { display: flex; flex-direction: column; gap: 6px; }
.au-dry-act { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; background: var(--surface-2); font-size: 12.5px; }
.au-dry-act .ic { color: var(--accent); margin-top: 1px; }
.au-dry-act div { display: flex; flex-direction: column; min-width: 0; }
.au-dry-act b { color: var(--heading); font-weight: 600; }
.au-arb { display: flex; gap: 6px; align-items: center; margin: 0; }

/* Templates */
.au-tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.au-tpl { display: flex; flex-direction: column; gap: 8px; transition: box-shadow .15s, transform .15s; }
.au-tpl:hover { box-shadow: var(--shadow-lift); transform: translateY(-1px); }
.au-tpl.na { opacity: .7; }
.au-tpl.na:hover { transform: none; box-shadow: var(--shadow); }
.au-tpl-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
.au-tpl-head .chip-ic { width: 46px; height: 46px; border-radius: 14px; }
.au-tpl h3 { font-size: 15px; }
.au-tpl p { margin: 0; line-height: 1.5; }
.au-req { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.au-tpl-why { display: flex; gap: 6px; align-items: flex-start; color: var(--bad); font-size: 12px; font-weight: 550; }
.au-tpl-why .ic { margin-top: 1px; }
.au-tpl-foot { margin-top: auto; padding-top: 8px; display: flex; justify-content: flex-end; }

/* Scenes */
.au-scene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.au-scene { display: flex; flex-direction: column; gap: 12px; }
.au-scene-head { display: flex; align-items: center; gap: 12px; }
.au-scene-head .chip-ic { width: 46px; height: 46px; border-radius: 14px; }
.au-scene-name { flex: 1; min-width: 0; }
.au-scene-name h3 { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-scene-list { display: flex; flex-direction: column; }
.au-scene-set { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--grid-line); font-size: 13px; }
.au-scene-set:last-child { border-bottom: 0; }
.au-scene-set b { color: var(--heading); text-align: right; font-variant-numeric: tabular-nums; }
.au-scene-res { padding: 10px 12px; border-radius: 12px; background: var(--surface-2); }
.au-apply { margin-top: auto; width: 100%; }
.au-apply.accent { background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }
.au-apply.solar { background: var(--solar-soft); color: #8a5a00; border-color: transparent; }
.au-apply.load { background: var(--load-soft); color: var(--load); border-color: transparent; }
.btn.au-apply.grid { background: var(--grid-soft); color: var(--grid); border-color: transparent; display: inline-flex; grid-template-columns: none; }
.au-apply.battery { background: var(--battery-soft); color: var(--ok-text); border-color: transparent; }
.au-apply:hover { filter: brightness(.97); }
.au-scene-new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 200px; font: inherit; color: inherit; background: transparent; border: 1.5px dashed #d5d9e0; border-radius: var(--radius-lg); cursor: pointer; }
.au-scene-new:hover { border-color: var(--accent); background: var(--accent-soft); }
.au-scene-new b { color: var(--heading); }
.au-scene-form { display: flex; flex-direction: column; gap: 14px; }
.au-scene-top { display: flex; gap: 12px; align-items: center; }
.au-scene-top input { max-width: none; font-size: 15px; font-weight: 600; }
.au-icons { display: flex; flex-wrap: wrap; gap: 6px; }
.au-icon-opt { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
.au-icon-opt:hover { color: var(--text); background: var(--surface-2); }
.au-icon-opt.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.au-colors { display: flex; gap: 8px; }
.au-color { width: 30px; height: 30px; border-radius: 50%; background: var(--c); border: 3px solid var(--surface); box-shadow: 0 0 0 1px var(--border); cursor: pointer; }
.au-color.on { box-shadow: 0 0 0 2px var(--heading); }
.au-scene-rows { display: flex; flex-direction: column; gap: 8px; }
.au-scene-row { display: flex; gap: 8px; align-items: flex-start; padding: 10px 10px 10px 12px; border-radius: 12px; background: var(--surface-2); }
.au-scene-row .au-fields { flex: 1; margin: 0; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.au-scene-row .au-ibtn { margin-top: 18px; }
.au-scene-rows .au-add-btn { align-self: flex-start; }

/* History */
.au-htable td { vertical-align: middle; }
.au-htable th:nth-child(3), .au-htable td:nth-child(3), .au-htable th:nth-child(2), .au-htable td:nth-child(2), .au-htable th:nth-child(4), .au-htable td:nth-child(4) { text-align: left; }
.au-htable th:last-child, .au-htable td:last-child { width: 1%; }
.au-hrow { cursor: pointer; }
.au-hrow.open td { background: var(--surface-2); }
.au-hsrc { display: flex; align-items: center; gap: 10px; }
.au-hsrc .chip-ic.sm { width: 28px; height: 28px; border-radius: 9px; }
.au-hsrc span { display: flex; flex-direction: column; line-height: 1.3; }
.au-hsrc b { color: var(--heading); font-weight: 600; }
.au-hsrc small { font-size: 11px; }
.au-htrig { max-width: 320px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.au-hdetail td { white-space: normal; text-align: left !important; background: var(--surface-2); padding: 4px 16px 14px 52px; }
.au-hdetail a { display: inline-block; margin-top: 8px; }
.au-hfoot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
@media (max-width: 560px) { .au-toolbar select { max-width: none; flex: 1 1 140px; } .au-hdetail td { padding-left: 12px; } }

/* Settings */
.au-set-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .au-set-grid { grid-template-columns: minmax(0, 1fr); } }
.au-ctl-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.au-ctl-row input { flex: 1 1 220px; }
.au-test { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.au-explain { align-items: flex-start; }
.au-explain .list-title { white-space: normal; }
.au-explain-text { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin-top: 2px; }

/* Classic automation editors */
/* Rule tables */
.au-rules th, .au-rules td { text-align: left; white-space: normal; vertical-align: middle; }
.au-rules th { line-height: 1.3; font-size: 12.5px; color: var(--heading); }
.au-th-kind { display: block; font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.au-rules th.au-set { background: var(--accent-soft); }
.au-rules th.au-set .au-th-kind { color: var(--accent-text); }
.au-rules td.au-set { white-space: nowrap; }
.au-rules td.au-set .ic { color: var(--accent); margin-right: 6px; vertical-align: -3px; }
.au-rules tr.row-start td { border-top: 1px solid var(--border); }
.au-rules td.au-span { background: var(--surface-2); font-weight: 550; border-right: 1px solid var(--grid-line); }
.au-rules tbody tr:hover td.au-span { background: var(--surface-2); }
.au-rules tr.active td.au-set, .au-rules tr.active td:not(.au-span) { background: var(--accent-soft); }
.au-rules tr.active td.au-set b { color: var(--accent-text); }
.au-edit td { white-space: nowrap; padding: 8px 8px; }
.au-edit select, .au-edit input { width: auto; max-width: 100%; padding: 6px 8px; }
.au-edit select { padding-right: 30px; }
.au-edit .au-num { width: 5.5em; }
.au-edit .au-date { width: 8em; }
.au-value { width: 8em; }
.au-range { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.au-range input[type="time"] { max-width: 8.5em; }
.au-rowbtns-h { width: 1%; }
.au-rowbtns { width: 1%; }
.au-cellbtn { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; border: 1px dashed #d5d9e0; background: var(--surface); color: var(--muted); cursor: pointer; margin-left: 4px; }
.au-cellbtn.add:hover { border-color: var(--ok); color: var(--ok-text); background: var(--ok-soft); }
.au-cellbtn.del:hover { border-color: var(--bad); color: var(--bad); background: var(--bad-soft); }
.au-days { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.au-edit .au-days { flex-wrap: nowrap; }
@media (max-width: 560px) { .au-edit .au-day { min-width: 28px; padding: 4px 3px; } }
.au-day { font: inherit; font-size: 12px; font-weight: 600; border: 1px solid #e1e4ea; background: var(--surface); color: var(--muted); border-radius: 8px; padding: 4px 6px; cursor: pointer; min-width: 32px; }
.au-day.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text); }
.au-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 14px; margin-bottom: 14px; }
.au-fields > label, .au-f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 600; color: var(--muted); min-width: 0; }
.au-fields input, .au-fields select { max-width: none; }
.au-help { margin: 10px 0 0; }
.au-help .ic { margin-right: 6px; vertical-align: -3px; }
.au-editor .form-actions { margin-top: 14px; }

/* SOC control */
.au-soc td { white-space: nowrap; }
.au-point { width: 1%; }
.au-pt { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--heading); color: #fff; font-weight: 700; font-size: 12px; }
.au-inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.au-inline select, .au-inline input { width: auto; padding: 6px 30px 6px 8px; }
.au-inline input { padding-right: 8px; }
.au-soc-chart { margin-top: 14px; background: var(--surface-2); border-radius: var(--radius); padding: 14px 14px 10px; }
.au-soc-chart svg.soc { display: block; width: 100%; max-width: 640px; margin: 0 auto; }
.soc-grid { stroke: var(--border); stroke-width: 1; }
.soc-axis { fill: var(--muted); font-size: 10px; font-family: var(--font); }
.soc-low { fill: none; stroke: var(--grid); stroke-width: 2.4; stroke-linejoin: round; }
.soc-high { fill: none; stroke: var(--battery); stroke-width: 2.4; stroke-linejoin: round; }
.soc-fill-grid { fill: var(--grid); opacity: .08; }
.soc-fill-batt { fill: var(--battery); opacity: .08; }
.soc-now { stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 3 3; }
.soc-dot { fill: var(--accent); stroke: #fff; stroke-width: 2; }
.au-soc-legend { justify-content: center; margin-top: 6px; }

/* Protection */
.au-protection { display: flex; flex-direction: column; gap: 10px; }
.au-step { display: flex; gap: 12px; align-items: flex-start; background: var(--surface-2); border-radius: 12px; padding: 12px; line-height: 1.6; }
.au-step b { color: var(--heading); }
.au-step .au-inline select, .au-step .au-inline input { max-width: 220px; }

/* Add modal */
.au-modal-lead { margin: 0 0 14px; }
.au-types { display: flex; flex-direction: column; gap: 10px; }
.au-type { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); transition: border-color .15s, box-shadow .15s, transform .15s; }
.au-type:hover:not(:disabled) { border-color: var(--accent); box-shadow: var(--shadow-lift); transform: translateY(-1px); }
.au-type:disabled { opacity: .55; cursor: not-allowed; }
.au-type .chip-ic { width: 46px; height: 46px; border-radius: 14px; }
.au-type-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.au-type-text b { color: var(--heading); font-size: 14.5px; }
.au-type-text span { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
.au-type-text em { font-style: normal; font-size: 12px; color: var(--bad); font-weight: 550; }
.au-type-chev { color: var(--faint); }
.au-new select { max-width: none; }
`;
let styleEl = document.getElementById('css-automations');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-automations';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css;
