// Shared UI components. Styling lives in /css/app.css; class names here are the contract.
import { api, createStore, fmtTime, html, onLog, useEffect, useRef, useState } from './core.js';

/** Current page's title + breadcrumbs, shown in the app's top bar. */
export const pageMeta = createStore({ title: '', crumbs: [] });

export function Page({ title, crumbs = [], actions, wide, narrow, children }) {
  useEffect(() => {
    document.title = title ? `${title} · Sunroost` : 'Sunroost';
    pageMeta.set({ title: title ?? '', crumbs });
  }, [title, crumbs.map((c) => c[0]).join('|')]);
  return html`
    <div class=${`page ${wide ? 'page-wide' : ''}`}>
      <div class=${narrow ? 'narrow-page' : ''}>
        ${actions && html`<div class="page-head"><div></div><div class="page-actions">${actions}</div></div>`}
        ${children}
      </div>
    </div>
  `;
}

export function Card({ title, subtitle, actions, class: cls = '', span, children }) {
  return html`
    <section class=${`card ${cls} ${span ? 'span-' + span : ''}`}>
      ${(title || actions) &&
      html`<header class="card-head">
        <div>
          ${title && html`<h2>${title}</h2>`}
          ${subtitle && html`<p class="muted small">${subtitle}</p>`}
        </div>
        ${actions && html`<div class="card-actions">${actions}</div>`}
      </header>`}
      ${children}
    </section>
  `;
}

/** A responsive grid of cards. cols = max columns on wide screens. */
export const Grid = ({ cols = 2, children }) => html`<div class=${`grid cols-${cols}`}>${children}</div>`;

/** Label/value row for read-only data. */
export const Row = ({ label, children, hint }) => html`
  <div class="row">
    <div class="row-label">${label}${hint && html`<span class="hint">${hint}</span>`}</div>
    <div class="row-value">${children}</div>
  </div>
`;

/** Form field: label on the left, control on the right; stacks on phones. */
export const Field = ({ label, help, children }) => html`
  <label class="field">
    <span class="field-label">${label}</span>
    <span class="field-control">${children}${help && html`<small class="help">${help}</small>`}</span>
  </label>
`;

export function Button({ kind = 'default', small, children, ...props }) {
  return html`<button type="button" class=${`btn btn-${kind} ${small ? 'btn-sm' : ''}`} ...${props}>${children}</button>`;
}

export function Select({ value, options, onChange, ...props }) {
  return html`<select value=${value} onChange=${(e) => onChange?.(e.target.value)} ...${props}>
    ${options.map((o) =>
      typeof o === 'string'
        ? html`<option value=${o} selected=${o === value}>${o}</option>`
        : html`<option value=${o.value} selected=${String(o.value) === String(value)}>${o.label}</option>`,
    )}
  </select>`;
}

export function Toggle({ checked, onChange, label, disabled }) {
  return html`<label class="toggle">
    <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(e) => onChange?.(e.target.checked)} />
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
    ${label && html`<span>${label}</span>`}
  </label>`;
}

/** Colored status pill. kind: ok | warn | bad | info | muted. */
export const Badge = ({ kind = 'muted', children }) => html`<span class=${`badge badge-${kind}`}>${children}</span>`;

/** Status pill for a device status object { name, message }. */
export function DeviceStatus({ status }) {
  if (!status) return null;
  const kind = { connected: 'ok', connecting: 'info', error: 'bad', disconnected: 'muted' }[status.name] ?? 'muted';
  return html`<${Badge} kind=${kind}>${status.message}<//>`;
}

export const Notice = ({ kind = 'info', children }) => html`<div class=${`notice notice-${kind}`}>${children}</div>`;

export const Empty = ({ children }) => html`<div class="empty">${children}</div>`;

export function Modal({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return html`
    <div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
        <header class="modal-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}>✕</button></header>
        <div class="modal-body">${children}</div>
        ${footer && html`<footer class="modal-foot">${footer}</footer>`}
      </div>
    </div>
  `;
}

/** Simple promise-based confirm that uses the native dialog (kiosk-safe, no custom modal state). */
export const confirmAction = (message) => window.confirm(message);

/** Transient toast messages. */
const toastListeners = new Set();
export function toast(message, kind = 'ok') {
  toastListeners.forEach((fn) => fn({ id: Math.random(), message, kind }));
}
export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const fn = (t) => {
      setItems((list) => [...list, t]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), 4000);
    };
    toastListeners.add(fn);
    return () => toastListeners.delete(fn);
  }, []);
  return html`<div class="toasts">${items.map((t) => html`<div class=${`toast toast-${t.kind}`}>${t.message}</div>`)}</div>`;
}

/** Live log viewer for one tag (or all). Loads recent lines, then streams new ones. */
export function LogPanel({ tag, height = 320 }) {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    let active = true;
    api.get(`/api/logs?limit=200${tag ? `&tag=${tag}` : ''}`).then((l) => active && setLines(l));
    const off = onLog((line) => {
      if (!tag || line.tag === tag) setLines((l) => [line, ...l].slice(0, 500));
    });
    return () => {
      active = false;
      off();
    };
  }, [tag]);
  return html`<div class="log" style=${`max-height:${height}px`}>
    ${lines.length === 0 && html`<div class="muted small">No log entries yet.</div>`}
    ${lines.map(
      (l) => html`<div class=${`log-line log-${l.level}`}>
        <span class="log-time">${fmtTime(l.ts)}</span>${!tag && html`<span class="log-tag">${l.tag}</span>`}<span>${l.message}</span>
      </div>`,
    )}
  </div>`;
}

/** Semicircle gauge (thick arc, value and label inside). pct 0–100. */
export function Gauge({ pct, color, label, value }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const len = Math.PI * 50;
  return html`<div class="gauge">
    <svg viewBox="0 0 124 68" aria-hidden="true">
      <path d="M12 62 A50 50 0 0 1 112 62" class="gauge-track" />
      <path d="M12 62 A50 50 0 0 1 112 62" class="gauge-fill" style=${`stroke:${color};stroke-dasharray:${len};stroke-dashoffset:${len * (1 - p / 100)}`} />
    </svg>
    <div class="gauge-value">${value}</div>
    <div class="gauge-label">${label}</div>
  </div>`;
}

/**
 * Editor for driver settings (inverter settings page, power page headers).
 * defs: SettingDef[]; values: { key: value }. Groups by section; one section is editable at a time.
 * Only changed fields are sent. onSaved(values) receives the new values.
 */
export function SettingsForm({ defs, values, index = 0, sections, readOnly, onSaved }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [results, setResults] = useState({});
  const [saving, setSaving] = useState(false);
  const groups = {};
  for (const d of defs) {
    if (sections && !sections.includes(d.section)) continue;
    (groups[d.section] ??= []).push(d);
  }
  const startEdit = (section) => {
    setEditing(section);
    setDraft({});
    setResults({});
  };
  const save = async () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => String(v) !== String(values[k])));
    if (!Object.keys(changed).length) return setEditing(null);
    setSaving(true);
    try {
      const res = await api.post('/api/inverter/settings', { index, values: changed });
      setResults(res.results);
      const failed = Object.values(res.results).some((r) => !r.ok);
      if (!failed) {
        setEditing(null);
        toast('Settings saved');
      }
      onSaved?.(res.values);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  };
  return html`${Object.entries(groups).map(
    ([section, list]) => html`
      <div class="settings-section">
        <div class="settings-head">
          <h3>${section}</h3>
          ${!readOnly && editing !== section && html`<${Button} small kind="ghost" onClick=${() => startEdit(section)}>Edit<//>`}
        </div>
        ${list.map((d) => {
          const current = values[d.key];
          const v = d.key in draft ? draft[d.key] : current;
          const dirty = d.key in draft && String(draft[d.key]) !== String(current);
          const result = results[d.key];
          return html`<div class=${`setting ${dirty ? 'dirty' : ''}`}>
            <div class="setting-label">${d.label}${d.help && html`<small class="help">${d.help}</small>`}</div>
            <div class="setting-value">
              ${editing === section && !d.readOnly
                ? html`<${SettingInput} def=${d} value=${v} onChange=${(nv) => setDraft({ ...draft, [d.key]: nv })} />`
                : html`<span>${displaySetting(d, current)}</span>`}
              ${result && html`<span class=${`setting-result ${result.ok ? 'ok' : 'bad'}`}>${result.ok ? 'Saved' : result.message}</span>`}
            </div>
          </div>`;
        })}
        ${editing === section &&
        html`<div class="form-actions">
          <${Button} onClick=${() => setEditing(null)}>Cancel<//>
          <${Button} kind="primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>
        </div>`}
      </div>
    `,
  )}`;
}

export function displaySetting(def, value) {
  if (value === undefined || value === null || value === '') return '–';
  if (def.type === 'checkbox') return value === true || value === 'true' ? 'Enabled' : 'Disabled';
  if (def.type === 'slot') {
    const parts = String(value).split(',');
    const enabled = parts[parts.length - 1] === 'true';
    return `${parts[0]}–${parts[1]}${parts.length === 4 ? ` · ${parts[2]}` : ''}${enabled ? '' : ' (off)'}`;
  }
  return `${value}${def.unit ? ' ' + def.unit : ''}`;
}

export function SettingInput({ def, value, onChange }) {
  switch (def.type) {
    case 'select':
      return html`<${Select} value=${value} options=${def.options ?? []} onChange=${onChange} />`;
    case 'number':
      return html`<span class="input-unit"><input type="number" value=${value} min=${def.min} max=${def.max} step=${def.step ?? 'any'}
        onInput=${(e) => onChange(e.target.value)} />${def.unit && html`<span>${def.unit}</span>`}</span>`;
    case 'checkbox':
      return html`<${Toggle} checked=${value === true || value === 'true'} onChange=${onChange} />`;
    case 'time':
      return html`<input type="time" value=${value} onInput=${(e) => onChange(e.target.value)} />`;
    case 'slot': {
      const parts = String(value ?? '00:00,00:00,false').split(',');
      const hasPrio = Boolean(def.slotPriorities?.length);
      const [start, end] = parts;
      const prio = hasPrio ? parts[2] : null;
      const enabled = parts[parts.length - 1] === 'true';
      const emit = (s, e, p, en) => onChange([s, e, ...(hasPrio ? [p] : []), String(en)].join(','));
      return html`<span class="slot-input">
        <input type="time" value=${start} onInput=${(e) => emit(e.target.value, end, prio, enabled)} />
        <span>to</span>
        <input type="time" value=${end} onInput=${(e) => emit(start, e.target.value, prio, enabled)} />
        ${hasPrio && html`<${Select} value=${prio} options=${def.slotPriorities} onChange=${(p) => emit(start, end, p, enabled)} />`}
        <${Toggle} checked=${enabled} onChange=${(en) => emit(start, end, prio, en)} />
      </span>`;
    }
    default:
      return html`<input value=${value} onInput=${(e) => onChange(e.target.value)} />`;
  }
}

/** Hook: a ref'd element's width, updated on resize (for charts). */
export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// ---------- Design-system components (dashboard style) ----------

/** Lucide icon by name, coloured by currentColor. */
export const Ic = ({ name, size = '', class: cls = '' }) =>
  html`<i class=${`ic ${size ? 'ic-' + size : ''} ${cls}`} style=${`--i:url(/vendor/lucide/${name}.svg)`} aria-hidden="true"></i>`;

/** Rounded tinted square with an icon. tone: solar | load | grid | battery | accent | bad. */
export const IconChip = ({ name, tone = '', small }) => html`<span class=${`chip-ic ${tone} ${small ? 'sm' : ''}`}><${Ic} name=${name} /></span>`;

/**
 * KPI card: icon chip, label, big value + unit, optional delta ("↑ 12% vs yesterday").
 * delta: number (percent) — positive is good unless `invert` (e.g. cost, grid import).
 */
export function Kpi({ icon, tone, label, value, unit, delta, deltaLabel = 'vs yesterday', invert, sub, href }) {
  const good = delta === null || delta === undefined ? null : invert ? delta <= 0 : delta >= 0;
  const body = html`<div class="kpi">
    <${IconChip} name=${icon} tone=${tone} />
    <div class="kpi-body">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}${unit && html`<small>${unit}</small>`}</span>
      ${delta !== null && delta !== undefined
        ? html`<span class=${`kpi-delta ${good ? 'up' : 'down'}`}><${Ic} name=${delta >= 0 ? 'trending-up' : 'trending-down'} size="sm" />${Math.abs(delta)}% <span>${deltaLabel}</span></span>`
        : sub && html`<span class="kpi-delta">${sub}</span>`}
    </div>
  </div>`;
  return href ? html`<a href=${href} class="card card-link">${body}</a>` : html`<div class="card">${body}</div>`;
}

/** Segmented control. options: [{ value, label }] or strings. */
export function Segmented({ value, options, onChange }) {
  return html`<div class="seg" role="tablist">
    ${options.map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const l = typeof o === 'string' ? o : o.label;
      return html`<button type="button" role="tab" aria-selected=${v === value} class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${l}</button>`;
    })}
  </div>`;
}

/** Ring gauge (battery %): value 0–100, big centred label. */
export function Ring({ value, color = 'var(--battery)', size = 170, stroke = 14, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, value ?? 0));
  return html`<div class="ring" style=${`width:${size}px;height:${size}px`}>
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--surface-3)" stroke-width=${stroke} />
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke=${color} stroke-width=${stroke} stroke-linecap="round"
        stroke-dasharray=${c} stroke-dashoffset=${c * (1 - p / 100)} transform=${`rotate(-90 ${size / 2} ${size / 2})`} style="transition: stroke-dashoffset .8s ease" />
    </svg>
    <div class="ring-center"><b>${label}</b>${sub && html`<span>${sub}</span>`}</div>
  </div>`;
}

/** Semicircle arc gauge with a value inside; colour stops for SOC-like gauges. */
export function Arc({ pct, color = 'var(--accent)', value, label, width = 180 }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const len = Math.PI * 80;
  return html`<div class="arc" style=${`max-width:${width}px`}>
    <svg viewBox="0 0 200 112" aria-hidden="true">
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--surface-3)" stroke-width="16" stroke-linecap="round" />
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke=${color} stroke-width="16" stroke-linecap="round"
        stroke-dasharray=${len} stroke-dashoffset=${len * (1 - p / 100)} style="transition: stroke-dashoffset .8s ease" />
    </svg>
    <div class="arc-value">${value}</div>
    ${label && html`<div class="arc-label">${label}</div>`}
  </div>`;
}

/** "● Live" indicator. */
export const Live = ({ ok = true, children = 'Live' }) =>
  html`<span class=${`badge ${ok ? 'badge-ok' : 'badge-warn'}`}><span class=${`live-dot ${ok ? '' : 'warn'}`} style="width:6px;height:6px;box-shadow:none"></span>${children}</span>`;
