// Power management: an automation status strip (running / suspended, suspend for…, resume, last action), then two
// columns: "Quick controls" (the primary control setting as a one-tap segmented control, and every setting
// automations control as list rows with inline edit) and a compact "Automations" summary linking to the
// Automations page (/automations, where rules are listed and edited); the work-mode slot schedule (24-hour
// timeline + slot rows) and the automation log sit in the side column.
import { api, html, live, navigate, onInverterSettings, onLog, pad2, useEffect, useMemo, useRef, useState, useStore } from '../lib/core.js';
import { displaySetting, Ic, IconChip, LogPanel, Page, Segmented, Select, SettingInput, toast, Toggle } from '../lib/ui.js';

const DURATIONS = [30, 60, 120, 240, 360, 480, 720, 1440];
const REFRESH_AFTER_MS = 2500;

const isNone = (v) => v === null || v === undefined || v === '';
const fmtValue = (def, v) => (isNone(v) ? 'None' : def ? displaySetting(def, v) : String(v));
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const same = (a, b) => String(a ?? '') === String(b ?? '');
const durLabel = (m) => (m < 60 ? `${m}m` : `${m / 60}h`);
const durLong = (m) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`);

/** Setting result next to a control ("Saved. Reading it back…" / the rejection). */
const Result = ({ r }) => (r ? html`<span class=${`setting-result ${r.cls === 'positive' ? 'ok' : 'bad'}`}>${r.message}</span>` : null);

/** Card head: icon chip, title, one-line description, actions on the right. */
const Head = ({ icon, tone, title, sub, actions }) => html`<header class="card-head pm-head">
  <div class="pm-head-main"><${IconChip} name=${icon} tone=${tone} small />
    <div><h2>${title}</h2>${sub && html`<p class="muted small">${sub}</p>`}</div></div>
  ${actions && html`<div class="card-actions">${actions}</div>`}
</header>`;


/** Icon + tone for a setting, guessed from its key/type. */
function settingIcon(d) {
  const k = `${d.key} ${d.label}`.toLowerCase();
  if (/priority|work.?mode|mode/.test(k)) return ['sliders-horizontal', 'accent'];
  if (/grid|export|utility|feed/.test(k)) return ['utility-pole', 'grid'];
  if (/battery|charge|soc|capacity|discharge/.test(k)) return ['battery-charging', 'battery'];
  if (/solar|pv/.test(k)) return ['sun', 'solar'];
  if (d.type === 'checkbox') return ['toggle-right', 'load'];
  if (d.type === 'slot' || d.type === 'time') return ['clock', 'load'];
  return ['settings-2', ''];
}

// ---------- Setting writes (quick controls and schedule) ----------

/** Writes changed settings for several inverters; results keyed "<index>:<key>". Re-reads afterwards. */
function useMultiWriter(onValues) {
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = async (byInverter) => {
    setBusy(true);
    const out = {};
    for (const [index, values] of Object.entries(byInverter)) {
      if (!Object.keys(values).length) continue;
      try {
        const res = await api.post('/api/inverter/settings', { index: Number(index), values });
        for (const [k, r] of Object.entries(res.results)) {
          out[`${index}:${k}`] = r.ok ? { cls: 'positive', message: 'Saved. Reading it back…' } : { cls: 'negative', message: r.message || 'Rejected' };
        }
        onValues(Number(index), res.values);
      } catch (err) {
        for (const k of Object.keys(values)) out[`${index}:${k}`] = { cls: 'negative', message: err.message };
      }
    }
    setResults(out);
    setBusy(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      for (const index of Object.keys(byInverter)) {
        try {
          const r = await api.post('/api/inverter/settings/refresh', { index: Number(index) });
          onValues(Number(index), r.values);
        } catch {
          // Live updates cover a failed re-read.
        }
      }
      setResults({});
    }, REFRESH_AFTER_MS);
  };
  return { results, save, busy };
}

// ---------- Automation status strip ----------

function StatusStrip({ opts, data, reload }) {
  const durations = opts.override?.durations?.length ? opts.override.durations : DURATIONS;
  const [minutes, setMinutes] = useState(durations.includes(60) ? 60 : durations[0]);
  const [busy, setBusy] = useState(false);
  const suspended = data.overrideUntil > 0;
  const enabled = data.automations.filter((a) => a.enabled).length;
  const last = data.automations
    .map((a) => (a.type === 'rule'
      ? a.view?.lastRun && { ts: a.view.lastRun.ts, text: `${a.name || `Rule #${a.id}`} (${a.view.lastRun.result})` }
      : a.status.lastActionAt && { ts: a.status.lastActionAt, text: a.status.lastAction }))
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)[0];
  const activate = async () => {
    setBusy(true);
    try {
      await api.post('/api/automations/suspend', { minutes: Number(minutes) });
      toast(`Automations suspended for ${durLong(minutes)}`);
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
    reload();
  };
  const cancel = async () => {
    setBusy(true);
    await api.del('/api/automations/suspend').then(() => toast('Automations resumed'), (err) => toast(err.message, 'bad'));
    setBusy(false);
    reload();
  };
  const [pill, pillText] = suspended ? ['warn', 'Suspended']
    : !opts.connected ? ['muted', 'Offline']
    : enabled ? ['ok', 'Running'] : ['muted', 'Idle'];
  return html`<section class="card pm-strip" id="header">
    <div class="pm-strip-main">
      <${IconChip} name=${suspended ? 'circle-pause' : 'workflow'} tone=${suspended ? 'solar' : 'accent'} />
      <div class="pm-strip-text">
        <div class="pm-strip-title">
          <h2>Automation status</h2>
          <span class=${`badge badge-${pill}`}>${pill === 'ok' && html`<span class="live-dot" style="width:6px;height:6px;box-shadow:none"></span>`}${pillText}</span>
        </div>
        <p class="muted small">
          ${suspended
            ? html`Automations are paused until <b class="pm-strong">${hhmm(data.overrideUntil)}</b>. Settings stay as they are until then.`
            : html`${enabled} of ${data.automations.length} automation${data.automations.length === 1 ? '' : 's'} enabled`}
          ${last && html`<span class="pm-last"> · Last action <b class="pm-strong">${hhmm(last.ts)}</b>${last.text && html`: ${last.text}`}</span>`}
        </p>
      </div>
    </div>
    <div class="pm-strip-actions">
      ${suspended
        ? html`<button type="button" class="btn btn-primary" disabled=${busy} onClick=${cancel}><${Ic} name="play" size="sm" />Resume now</button>`
        : html`<span class="muted small pm-strip-label">Suspend for</span>
          <div class="pm-seg-scroll"><${Segmented} value=${Number(minutes)} options=${durations.map((m) => ({ value: m, label: durLabel(m) }))} onChange=${setMinutes} /></div>
          <button type="button" class="btn" disabled=${busy} onClick=${activate}><${Ic} name="pause" size="sm" />Suspend</button>`}
    </div>
  </section>`;
}

// ---------- Quick controls ----------

function QuickRow({ inv, d, controlledBy, result, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const value = inv.values?.[d.key];
  const [icon, tone] = settingIcon(d);
  const submit = async (e) => {
    e.preventDefault();
    if (draft !== null && !same(draft, value)) await onSave(inv.index, d.key, draft);
    setEditing(false);
    setDraft(null);
  };
  return html`<form class=${`list-item pm-qrow ${editing ? 'editing' : ''}`} id=${`header-${d.key}`} novalidate onSubmit=${submit}>
    <${IconChip} name=${icon} tone=${tone} small />
    <div class="list-main">
      <div class="list-title">${d.label}</div>
      <div class="list-sub">${controlledBy[d.key] ? html`<span class="pm-by"><${Ic} name="workflow" size="sm" />Automation ${controlledBy[d.key]}</span>` : 'Manual'}${d.readOnly ? ' · read only' : ''}</div>
    </div>
    <div class="pm-qside">
      ${editing
        ? html`<span class=${`pm-qinput ${draft !== null && !same(draft, value) ? 'dirty' : ''}`}><${SettingInput} def=${d} value=${draft ?? value} onChange=${setDraft} /></span>
          <button type="submit" class="icon-btn pm-ibtn ok" aria-label=${`Save ${d.label}`} disabled=${busy}><${Ic} name="check" size="sm" /></button>
          <button type="button" class="icon-btn pm-ibtn" aria-label="Cancel" onClick=${(e) => { e.preventDefault(); setEditing(false); setDraft(null); }}><${Ic} name="x" size="sm" /></button>`
        : html`<span class="pm-val">${fmtValue(d, value)}</span>
          ${!d.readOnly && html`<button type="button" class="icon-btn pm-ibtn" aria-label=${`Edit ${d.label}`} title="Edit" onClick=${(e) => { e.preventDefault(); setDraft(null); setEditing(true); }}><${Ic} name="pencil" size="sm" /></button>`}`}
      <${Result} r=${result} />
    </div>
  </form>`;
}

function PrimaryControl({ inv, def, controlledBy, result, pending, onTap, busy }) {
  const value = pending ?? inv.values?.[def.key];
  const opts = def.options ?? [];
  const seg = opts.length > 0 && opts.length <= 4;
  return html`<div class="pm-primary" id=${`header-${def.key}`}>
    <div class="pm-primary-head">
      <div>
        <div class="pm-primary-label">${def.label}</div>
        <div class="muted small">${controlledBy[def.key]
          ? html`Automation ${controlledBy[def.key]} controls this, so it may change it back`
          : 'Tap to change it now'}</div>
      </div>
      <${Result} r=${result} />
    </div>
    ${seg
      ? html`<div class=${`pm-primary-seg ${busy ? 'busy' : ''}`}><${Segmented} value=${value} options=${opts} onChange=${(v) => !busy && !same(v, inv.values?.[def.key]) && onTap(inv.index, def.key, v)} /></div>`
      : html`<${Select} value=${value} options=${opts} disabled=${busy} onChange=${(v) => onTap(inv.index, def.key, v)} />`}
  </div>`;
}

function QuickControls({ opts, defs, controlledBy, onValues }) {
  const { results, save, busy } = useMultiWriter(onValues);
  const [pending, setPending] = useState({});
  const primary = opts.settings.find((d) => d.key === opts.primarySetting && d.type === 'select' && !d.readOnly);
  const rows = defs.filter((d) => d !== primary);
  const write = async (index, key, v) => {
    setPending({ [`${index}:${key}`]: v });
    await save({ [index]: { [key]: v } });
    setPending({});
  };
  const multi = opts.inverters.length > 1;
  return html`<section class="card pm-quick">
    <${Head} icon="sliders-horizontal" tone="accent" title="Quick controls"
      sub="The settings your automations control, as the inverter reports them now" />
    ${opts.inverters.map((inv) => html`<div class="pm-inv-block">
      ${multi && html`<div class="pm-inv"><${Ic} name="cpu" size="sm" />${inv.label}</div>`}
      ${primary && html`<${PrimaryControl} inv=${inv} def=${primary} controlledBy=${controlledBy} busy=${busy}
        result=${results[`${inv.index}:${primary.key}`]} pending=${pending[`${inv.index}:${primary.key}`]} onTap=${write} />`}
      ${rows.length > 0 && html`<div class="list">${rows.map((d) => html`<${QuickRow} key=${d.key} inv=${inv} d=${d} controlledBy=${controlledBy}
        busy=${busy} result=${results[`${inv.index}:${d.key}`]} onSave=${write} />`)}</div>`}
    </div>`)}
    ${!primary && rows.length === 0 && html`<div class="empty pm-empty-sm"><${Ic} name="sliders-horizontal" /><div>No settings are automated yet. Add an automation to see its setting here.</div></div>`}
  </section>`;
}

// ---------- Work mode schedule (time slots stored in the inverter) ----------

function slotParts(def, value) {
  const parts = String(value ?? '00:00,00:00,false').split(',');
  const prio = def.slotPriorities?.length ? parts[2] : null;
  return { start: parts[0] || '00:00', end: parts[1] || '00:00', prio, enabled: parts[parts.length - 1] === 'true' };
}
const joinSlot = (def, p) => [p.start, p.end, ...(def.slotPriorities?.length ? [p.prio ?? def.slotPriorities[0]] : []), String(p.enabled)].join(',');
const mins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const PALETTE = ['var(--accent)', 'var(--load)', 'var(--solar)', 'var(--grid)', 'var(--battery)'];
function colorFor(name, i) {
  if (/battery/i.test(name)) return 'var(--battery)';
  if (/grid|utility/i.test(name)) return 'var(--grid)';
  if (/load/i.test(name)) return 'var(--load)';
  if (/solar|pv/i.test(name)) return 'var(--solar)';
  return PALETTE[i % PALETTE.length];
}

/** 24-hour bar with one coloured segment per slot (wrapping past midnight), hour ticks and a "now" marker. */
function Timeline({ items }) {
  const now = new Date();
  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  const segs = [];
  for (const it of items) {
    const s = mins(it.start);
    const e = mins(it.end);
    if (s === e) continue;
    const parts = s < e ? [[s, e]] : [[s, 1440], [0, e]];
    for (const [a, b] of parts) segs.push({ ...it, a, b });
  }
  return html`<div class="pm-tl" role="img" aria-label="Schedule over 24 hours">
    <div class="pm-tl-bar">
      ${[6, 12, 18].map((h) => html`<span class="pm-tl-grid" style=${`left:${(h / 24) * 100}%`}></span>`)}
      ${segs.map((s) => html`<span class=${`pm-tl-seg ${s.enabled ? '' : 'off'}`} title=${`${s.label}: ${s.start}–${s.end}${s.enabled ? '' : ' (disabled)'}`}
        style=${`left:${(s.a / 1440) * 100}%;width:${((s.b - s.a) / 1440) * 100}%;--c:${s.color}`}></span>`)}
      <span class="pm-tl-now" style=${`left:${nowPct}%`} title=${`Now ${hhmm(now)}`}></span>
    </div>
    <div class="pm-tl-axis">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => html`<span class=${h % 6 ? 'minor' : ''} style=${`left:${(h / 24) * 100}%`}>${pad2(h)}</span>`)}</div>
  </div>`;
}

function Schedule({ opts, defs, onValues }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [index, setIndex] = useState(0);
  const { results, save, busy } = useMultiWriter(onValues);
  const values = opts.inverters[index]?.values ?? {};
  const hasPrio = defs.some((d) => d.slotPriorities?.length);
  const groups = useMemo(() => {
    const g = new Map();
    for (const d of defs) {
      const name = d.label.replace(/\s*slot\s*\d+$/i, '') || 'Schedule';
      if (!g.has(name)) g.set(name, []);
      g.get(name).push(d);
    }
    return [...g.entries()];
  }, [defs]);
  const prioColors = useMemo(() => {
    const all = [...new Set(defs.flatMap((d) => d.slotPriorities ?? []))];
    return Object.fromEntries(all.map((p, i) => [p, colorFor(p, i)]));
  }, [defs]);
  const val = (d) => (d.key in draft ? draft[d.key] : values[d.key]);
  const setSlot = (d, patch) => {
    setDraft((x) => ({ ...x, [d.key]: joinSlot(d, { ...slotParts(d, d.key in x ? x[d.key] : values[d.key]), ...patch }) }));
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setDraft({}); };
  const submit = async (e) => {
    e.preventDefault();
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => !same(v, values[k])));
    if (Object.keys(changed).length) await save({ [index]: changed });
    setTimeout(cancel, 600);
  };
  const items = [];
  const legend = new Map();
  groups.forEach(([name, list], gi) => list.forEach((d) => {
    const p = slotParts(d, val(d));
    const color = hasPrio && p.prio ? prioColors[p.prio] ?? colorFor(name, gi) : colorFor(name, gi);
    legend.set(hasPrio && p.prio ? p.prio : name, color);
    items.push({ ...p, color, label: hasPrio && p.prio ? `${d.label} · ${p.prio}` : d.label });
  }));
  if (!hasPrio) groups.forEach(([name], gi) => legend.set(name, colorFor(name, gi)));
  const dirtyCount = Object.entries(draft).filter(([k, v]) => !same(v, values[k])).length;

  return html`<form class="card pm-sched" id="schedule" novalidate onSubmit=${submit}>
    <${Head} icon="calendar-clock" tone="load" title="Work mode schedule" sub="Time slots stored in the inverter"
      actions=${html`${opts.inverterCount > 1 && html`<select class="pm-inv-select" aria-label="Inverter" value=${index} disabled=${editing} onChange=${(e) => setIndex(Number(e.target.value))}>
          ${opts.inverters.map((i) => html`<option value=${i.index} selected=${i.index === index}>Inverter ${i.index + 1}</option>`)}
        </select>`}
        ${!editing && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => { setDraft({}); setEditing(true); }}><${Ic} name="pencil" size="sm" />Edit</button>`}`} />
    <${Timeline} items=${items} />
    <div class="legend-dots pm-legend">${[...legend.entries()].map(([name, c]) => html`<span style=${`--c:${c}`}>${name}</span>`)}<span class="pm-legend-now">Now</span></div>
    ${groups.map(([name, list], gi) => html`<div class="table-wrap pm-slots-wrap"><table class=${`table pm-slots ${editing ? 'editing' : ''}`}>
      <thead><tr>
        <th><span class="pm-dot" style=${`--c:${colorFor(name, gi)}`}></span>${name}</th>
        <th>From</th><th>To</th>${hasPrio && html`<th>Priority</th>`}<th>Enabled</th>
      </tr></thead>
      <tbody>${list.map((d, i) => {
        const p = slotParts(d, val(d));
        const n = d.label.match(/(\d+)$/)?.[1] ?? i + 1;
        const dirty = d.key in draft && !same(draft[d.key], values[d.key]);
        return html`<tr class=${`${dirty ? 'dirty' : ''} ${p.enabled ? '' : 'off'}`}>
          <td><span class="pm-slot-n">Slot ${n}</span><${Result} r=${results[`${index}:${d.key}`]} /></td>
          ${editing
            ? html`<td><input type="time" aria-label=${`${d.label} from`} value=${p.start} onInput=${(e) => setSlot(d, { start: e.target.value })} /></td>
              <td><input type="time" aria-label=${`${d.label} to`} value=${p.end} onInput=${(e) => setSlot(d, { end: e.target.value })} /></td>
              ${hasPrio && html`<td>${d.slotPriorities?.length ? html`<${Select} value=${p.prio} options=${d.slotPriorities} onChange=${(v) => setSlot(d, { prio: v })} />` : ''}</td>`}`
            : html`<td class="tabular">${p.start}</td><td class="tabular">${p.end}</td>${hasPrio && html`<td>${p.prio ?? ''}</td>`}`}
          <td><span class="pm-slot-toggle"><${Toggle} checked=${p.enabled} onChange=${(on) => setSlot(d, { enabled: on })} /></span></td>
        </tr>`;
      })}</tbody>
    </table></div>`)}
    ${editing && html`<div class="form-actions">
      <span class="muted small pm-dirty">${dirtyCount ? `${dirtyCount} slot${dirtyCount === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
      <button type="button" class="btn" onClick=${cancel}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? 'Saving…' : 'Save schedule'}</button>
    </div>`}
    ${!hasPrio && html`<p class="muted small pm-foot"><${Ic} name="info" size="sm" />Work mode detail is maintained on the <a href="/inverter/settings">inverter settings</a> page.</p>`}
  </form>`;
}


function NotConnected() {
  return html`<section class="card pm-notconn">
    <div class="pm-notconn-in">
      <span class="pm-big-ic"><${Ic} name="unplug" size="lg" /></span>
      <div>
        <h2>Inverter not connected</h2>
        <p class="muted">Quick controls and the work mode schedule appear once the inverter is connected. Automations stay saved and resume automatically.</p>
      </div>
      <a href="/configuration" class="btn btn-primary"><${Ic} name="settings" size="sm" />Go to Configuration</a>
    </div>
  </section>`;
}

// ---------- Page ----------

/** Compact automations card: counts, next scheduled action, the enabled automations, link to /automations. */
const STATE_BADGE = {
  active: ['ok', 'Active'], idle: ['info', 'Standby'], suspended: ['warn', 'Suspended'], unavailable: ['bad', 'Not supported'],
  not_connected: ['muted', 'Offline'], disabled: ['muted', 'Disabled'],
};
const TYPE_ICON = { table: ['table-2', 'load'], 'battery-soc': ['battery-charging', 'battery'], 'battery-protection': ['shield-check', 'bad'] };
const TRIGGER_ICON = {
  time: ['clock', 'load'], sun: ['sunrise', 'solar'], metric: ['gauge', 'battery'], grid: ['utility-pole', 'grid'], price: ['piggy-bank', 'accent'],
  forecast: ['cloud-sun', 'solar'], alert: ['bell-ring', 'bad'], interval: ['repeat', 'load'], manual: ['hand', 'accent'],
};
const iconOf = (a) => (a.type === 'rule' ? TRIGGER_ICON[a.config.triggers?.[0]?.kind] ?? ['workflow', 'accent'] : TYPE_ICON[a.type] ?? ['workflow', 'accent']);
function relTime(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (m < 1) return 'now';
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function AutomationsSummary({ list }) {
  const [next, setNext] = useState(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/automations/upcoming?hours=24').then((u) => alive && setNext(u.find((x) => x.at && x.at >= Date.now() - 60_000) ?? null), () => alive && setNext(null));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [list.length]);
  const enabled = list.filter((a) => a.enabled);
  const rules = list.filter((a) => a.type === 'rule').length;
  const runsToday = list.reduce((n, a) => n + (a.view?.runsToday ?? 0), 0);
  const shown = enabled.slice(0, 4);
  return html`<section class="card pm-autos">
    <${Head} icon="workflow" tone="accent" title="Automations" sub="Rules, templates, scenes and history live on the Automations page"
      actions=${html`<a class="btn btn-sm btn-ghost" href="/automations">Open<${Ic} name="chevron-right" size="sm" /></a>`} />
    <div class="pm-auto-stats">
      <a href="/automations?tab=rules"><b>${enabled.length}<small>/${list.length}</small></b><span>Enabled</span></a>
      <a href="/automations?tab=rules"><b>${rules}</b><span>Rules</span></a>
      <a href="/automations?tab=history"><b>${runsToday}</b><span>Rule runs today</span></a>
    </div>
    <a class=${`pm-next ${next ? '' : 'none'}`} href=${next ? `/automations?edit=${next.automationId}` : '/automations'}>
      <span class="chip-ic sm load"><${Ic} name="clock" size="sm" /></span>
      <span class="list-main"><span class="list-sub">Next scheduled action</span>
        <span class="list-title">${next === undefined ? 'Loading…' : next ? `${hhmm(next.at)} · ${next.name}` : 'Nothing scheduled in the next 24 hours'}</span></span>
      ${next && html`<span class="pm-next-rel">${relTime(next.at)}</span>`}
    </a>
    ${list.length === 0
      ? html`<div class="empty pm-empty">
          <span class="pm-big-ic"><${Ic} name="sparkles" size="lg" /></span>
          <b>No automations yet</b>
          <span>Switch work modes on a schedule, charge in the cheapest hours, get notified on grid outages or protect the battery.</span>
          <a class="btn btn-primary" href="/automations?tab=templates"><${Ic} name="plus" size="sm" />Create an automation</a>
        </div>`
      : html`<div class="list">${shown.map((a) => {
          const [icon, tone] = iconOf(a);
          const state = a.view?.status ?? a.status?.state;
          const [bk, bl] = STATE_BADGE[state] ?? ['muted', state];
          return html`<a class="list-item pm-auto-li" href=${`/automations?edit=${a.id}`}>
            <${IconChip} name=${icon} tone=${tone} small />
            <span class="list-main"><span class="list-title">${a.name || a.typeName}</span><span class="list-sub pm-auto-sub">${a.view?.summary ?? a.typeName}</span></span>
            <span class=${`badge badge-${bk}`}>${bl}</span>
          </a>`;
        })}
        ${enabled.length === 0 && html`<p class="muted small pm-center">All automations are disabled.</p>`}
        ${enabled.length > shown.length && html`<a class="pm-center small pm-showall" href="/automations?tab=rules">+ ${enabled.length - shown.length} more enabled</a>`}
      </div>`}
  </section>`;
}

export default function Power() {
  const snap = useStore(live);
  const [opts, setOpts] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const pending = useRef(null);

  const reload = async () => {
    try {
      const [o, l] = await Promise.all([api.get('/api/automations/options'), api.get('/api/automations')]);
      setOpts(o);
      setData(l);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };
  const reloadSoon = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      reload();
    }, 400);
  };
  const setValues = (index, values) => setOpts((o) => (o ? { ...o, inverters: o.inverters.map((i) => (i.index === index ? { ...i, values } : i)) } : o));

  useEffect(() => {
    // Old deep links (/power?edit=<id>) now open the automation on the Automations page.
    const id = new URLSearchParams(location.search).get('edit');
    if (id) {
      navigate(`/automations?edit=${id}`, { replace: true });
      return undefined;
    }
    reload();
    const timer = setInterval(reload, 10_000);
    const offLog = onLog((line) => line.tag === 'automation' && reloadSoon());
    const offSettings = onInverterSettings(setValues);
    return () => {
      clearInterval(timer);
      offLog();
      offSettings();
      clearTimeout(pending.current);
    };
  }, []);
  const linkState = snap?.status?.inverter?.name;
  useEffect(() => { if (linkState) reloadSoon(); }, [linkState]);

  if (!opts || !data) {
    return html`<${Page} title="Power management">${error
      ? html`<section class="card"><div class="empty pm-empty-sm"><${Ic} name="triangle-alert" /><div>Couldn't load automations: ${error}</div>
          <button type="button" class="btn btn-sm" onClick=${reload}><${Ic} name="rotate-ccw" size="sm" />Retry</button></div></section>`
      : html`<div class="loading">Loading…</div>`}<//>`;
  }

  const controlledBy = {};
  for (const a of data.automations) {
    if (!a.enabled) continue;
    if (a.type !== 'rule') controlledBy[a.config.setting] = `#${a.id}`;
    else for (const x of [...a.config.actions, ...a.config.elseActions]) if (x.kind === 'set_setting') controlledBy[x.setting] ??= `#${a.id}`;
  }
  const headerKeys = [...new Set([opts.primarySetting, ...data.affectedSettings].filter(Boolean))];
  const headerDefs = headerKeys.map((k) => opts.settings.find((d) => d.key === k)).filter(Boolean);
  const slotDefs = opts.settings.filter((d) => d.type === 'slot' && d.section === 'Schedule');

  return html`<${Page} title="Power management">
    <div class="pm-page">
      <${StatusStrip} opts=${opts} data=${data} reload=${reload} />
      <div class="pm-cols">
        <div class="pm-col pm-col-main">
          ${opts.connected ? html`<${QuickControls} opts=${opts} defs=${headerDefs} controlledBy=${controlledBy} onValues=${setValues} />` : html`<${NotConnected} />`}
          <${AutomationsSummary} list=${data.automations} />
        </div>
        <div class="pm-col pm-col-side">
          ${opts.connected && slotDefs.length > 0 && html`<${Schedule} opts=${opts} defs=${slotDefs} onValues=${setValues} />`}
          <section class="card pm-log">
            <${Head} icon="scroll-text" tone="" title="Automation log" sub="What automations changed and why, newest first" />
            <${LogPanel} tag="automation" height=${560} />
          </section>
        </div>
      </div>
    </div>
  <//>`;
}

const css = `
.pm-page { display: flex; flex-direction: column; gap: 16px; }
.pm-cols { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.pm-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@media (max-width: 1200px) { .pm-cols { display: flex; flex-direction: column; align-items: stretch; } .pm-col { display: contents; } .pm-quick, .pm-notconn { order: -2; } .pm-sched { order: -1; } }
.pm-head { align-items: flex-start; flex-wrap: wrap; }
.pm-head .card-actions { margin-left: auto; }
.pm-page .chip-ic.accent, .modal .chip-ic.accent { padding: 0; margin: 0; border: 0; } /* app.css '.accent' (legacy notice) also matches the accent chip tone */
.pm-page .chip-ic.grid { display: inline-grid; grid-template-columns: none; gap: 0; place-items: center; } /* app.css '.grid' layout also matches the grid chip tone */
.pm-head-main { display: flex; gap: 12px; align-items: center; min-width: 0; flex: 1 1 280px; }
.pm-head-main p { margin: 2px 0 0; }
.pm-strong { color: var(--heading); font-weight: 650; }
.pm-center { text-align: center; }
.pm-note { display: flex; gap: 8px; align-items: center; margin: 0 0 12px; }
.pm-note .ic { flex: none; }
.pm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.pm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); margin-right: 8px; vertical-align: 1px; }

/* Status strip */
.pm-strip { display: flex; align-items: center; justify-content: space-between; gap: 16px 24px; padding: 16px 22px; flex-wrap: wrap; }
.pm-strip-main { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1 1 320px; }
.pm-strip-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pm-strip-title h2 { font-size: 15.5px; }
.pm-strip-text p { margin: 3px 0 0; }
.pm-strip-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.pm-seg-scroll { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.pm-seg-scroll .seg button { padding: 6px 11px; }
@media (max-width: 560px) {
  .pm-strip { padding: 16px; }
  .pm-strip-actions { width: 100%; }
  .pm-strip-label { width: 100%; }
  .pm-seg-scroll { flex: 1 1 100%; }
  .pm-seg-scroll .seg { display: flex; width: max-content; min-width: 100%; }
  .pm-seg-scroll .seg button { flex: 1; padding: 6px 9px; }
  .pm-strip-actions .btn { width: 100%; }
}

/* Quick controls */
.pm-inv { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 4px 0 8px; }
.pm-inv-block + .pm-inv-block { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.pm-primary { background: var(--surface-2); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 6px; }
.pm-primary-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.pm-primary-label { font-weight: 650; color: var(--heading); }
.pm-primary-seg .seg { display: flex; flex-wrap: wrap; background: var(--surface); width: 100%; }
.pm-primary-seg .seg button { flex: 1 1 auto; padding: 9px 12px; font-size: 13px; }
.pm-primary-seg .seg button.on { background: var(--accent); color: #fff; box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 30%, transparent); }
.pm-primary-seg.busy { opacity: .7; pointer-events: none; }
.pm-qrow { margin: 0; flex-wrap: wrap; }
.pm-qrow .list-main { flex: 1 1 160px; }
.pm-qside { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin-left: auto; }
.pm-qrow.editing .pm-qside { flex: 1 1 260px; }
.pm-qinput select, .pm-qinput input { max-width: 240px; }
.pm-qinput.dirty select, .pm-qinput.dirty input { border-color: var(--accent); background-color: var(--accent-soft); }
.pm-val { display: inline-flex; padding: 5px 12px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-weight: 650; font-size: 13px; color: var(--heading); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pm-by { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-text); font-weight: 600; }
.icon-btn.pm-ibtn { width: 32px; height: 32px; color: var(--muted); }
.icon-btn.pm-ibtn:hover { color: var(--text); }
.icon-btn.pm-ibtn.ok { background: var(--accent); border-color: var(--accent); color: #fff; }
.icon-btn.pm-ibtn:disabled { opacity: .4; cursor: default; }
.pm-empty-sm { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.pm-empty-sm .ic { width: 24px; height: 24px; color: var(--faint); }

/* Schedule */
.pm-inv-select { width: auto; padding-top: 5px; padding-bottom: 5px; }
.pm-tl { margin: 4px 0 6px; }
.pm-tl-bar { position: relative; height: 34px; border-radius: 10px; background: var(--surface-3); overflow: hidden; }
.pm-tl-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--surface) 80%, transparent); }
.pm-tl-seg { position: absolute; top: 4px; bottom: 4px; border-radius: 7px; background: var(--c); min-width: 3px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.04); }
.pm-tl-seg.off { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) 25%, transparent) 0 5px, transparent 5px 10px); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--c) 55%, transparent); }
.pm-tl-now { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--heading); }
.pm-tl-now::before { content: ""; position: absolute; top: -1px; left: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--heading); }
.pm-tl-axis { position: relative; height: 18px; margin-top: 4px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.pm-tl-axis span { position: absolute; transform: translateX(-50%); }
.pm-tl-axis span:first-child { transform: none; }
.pm-tl-axis span:last-child { transform: translateX(-100%); }
@media (max-width: 560px) { .pm-tl-axis .minor { display: none; } }
.pm-legend { margin: 6px 0 14px; }
.pm-legend .pm-legend-now::before { background: var(--heading); width: 2px; border-radius: 1px; height: 10px; vertical-align: -1px; }
.pm-slots-wrap + .pm-slots-wrap { margin-top: 12px; }
.pm-slots th, .pm-slots td { text-align: left; padding: 8px 10px; }
.pm-slots th:last-child, .pm-slots td:last-child { text-align: right; width: 1%; }
.pm-slots tr.dirty td { background: var(--accent-soft); }
.pm-slots tr.off:not(.dirty) td { color: var(--muted); }
.pm-slots input[type="time"] { width: auto; max-width: 9em; padding: 5px 6px; }
.pm-slots.editing th, .pm-slots.editing td { padding: 8px 6px; }
.pm-slots select { width: auto; padding-top: 6px; padding-bottom: 6px; }
.pm-slot-n { font-weight: 600; color: var(--heading); margin-right: 8px; }
.pm-slot-toggle { display: inline-flex; vertical-align: middle; }
.pm-page .table-wrap, .pm-page .toggle { position: relative; } /* keep the hidden toggle checkbox (position: absolute) inside its scroller */
.pm-dirty { margin-right: auto; align-self: center; }
.pm-foot { margin: 14px 0 0; }
.pm-foot .ic { margin-right: 6px; vertical-align: -3px; }

/* Automations summary */
.pm-auto-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.pm-auto-stats a { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 14px; background: var(--surface-2); color: inherit; text-decoration: none; transition: background .15s; }
.pm-auto-stats a:hover { background: var(--surface-3); text-decoration: none; }
.pm-auto-stats b { font-size: 22px; font-weight: 700; letter-spacing: -.02em; color: var(--heading); font-variant-numeric: tabular-nums; line-height: 1.15; }
.pm-auto-stats b small { font-size: 13px; color: var(--muted); font-weight: 600; margin-left: 1px; }
.pm-auto-stats span { font-size: 12px; color: var(--muted); font-weight: 550; }
.pm-next { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin-bottom: 6px; border-radius: 14px; border: 1px solid var(--border); color: inherit; text-decoration: none; }
.pm-next:hover { text-decoration: none; border-color: var(--load); }
.pm-next .list-main { display: flex; flex-direction: column; }
.pm-next.none .list-title { color: var(--muted); font-weight: 550; }
.pm-next-rel { flex: none; font-size: 12px; font-weight: 650; color: var(--load); background: var(--load-soft); padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.pm-auto-li { color: inherit; text-decoration: none; }
.pm-auto-li:hover { text-decoration: none; }
.pm-auto-li:hover .list-title { color: var(--accent-text); }
.pm-auto-li .list-main { display: flex; flex-direction: column; }
.pm-auto-sub { white-space: normal; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pm-showall { display: block; margin-top: 8px; }
.pm-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 30px 16px; }
.pm-empty b { color: var(--heading); font-size: 15px; }
.pm-empty span:not(.pm-big-ic) { max-width: 420px; margin-bottom: 8px; }
.pm-big-ic { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 18px; background: var(--accent-soft); color: var(--accent); flex: none; }
@media (max-width: 560px) { .pm-auto-stats { gap: 8px; } .pm-auto-stats a { padding: 10px; } .pm-auto-stats b { font-size: 19px; } }

/* Not connected */
.pm-notconn-in { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.pm-notconn-in > div { flex: 1 1 260px; }
.pm-notconn-in h2 { margin-bottom: 4px; }
.pm-notconn-in p { margin: 0; }
.pm-notconn .pm-big-ic { background: var(--warn-soft); color: var(--warn); }

/* Log */
.pm-log .log { border: 0; }
`;
let styleEl = document.getElementById('css-power');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-power';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css;
