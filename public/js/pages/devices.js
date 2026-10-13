// Smart devices: discovered devices, rooms, groups, energy roles and live controls (docs/SMART_HOME.md).
import { api, appSettings, html, live, navigate, onHomeStates, saveSettings, useEffect, useMemo, useRef, useState, useStore } from '../lib/core.js';
import { Badge, Button, Card, Empty, Ic, IconChip, Kpi, Modal, Page, Segmented, Select, Toggle, confirmAction, toast } from '../lib/ui.js';
import { CatalogueModal, DiscoveredList, FlowModal, HomeAssistantManage, HomeAssistantRow, IntegrationsCard, integrationsCss } from './devices-integrations.js';
import { TimeChart } from '../lib/chart.js';

const ROLES = [
  { value: 'critical', label: 'Critical', badge: 'bad', help: 'Never switched off by automations' },
  { value: 'essential', label: 'Essential', badge: 'info', help: 'Only switched off in an emergency' },
  { value: 'deferrable', label: 'Deferrable', badge: 'ok', help: 'Runs when there is spare solar' },
  { value: 'sheddable', label: 'Sheddable', badge: 'warn', help: 'First to switch off when energy is short' },
  { value: 'protected', label: 'Protected', badge: 'accent', help: 'Automations need your permission (transfer switch, charger)' },
];
const roleOf = (v) => ROLES.find((r) => r.value === v);

const DOMAIN = {
  switch: { icon: 'toggle-right', label: 'Switches' },
  light: { icon: 'lightbulb', label: 'Lights' },
  fan: { icon: 'fan', label: 'Fans' },
  climate: { icon: 'air-vent', label: 'Climate' },
  cover: { icon: 'blinds', label: 'Covers' },
  lock: { icon: 'lock', label: 'Locks' },
  media_player: { icon: 'tv', label: 'Media' },
  number: { icon: 'sliders-horizontal', label: 'Controls' },
  select: { icon: 'list', label: 'Controls' },
  button: { icon: 'circle-dot', label: 'Buttons' },
  sensor: { icon: 'gauge', label: 'Sensors' },
  binary_sensor: { icon: 'radar', label: 'Sensors' },
  group: { icon: 'boxes', label: 'Groups' },
};
const ROOM_ICONS = ['house', 'sofa', 'bed-double', 'cooking-pot', 'bath', 'monitor', 'door-open', 'car', 'warehouse', 'trees', 'sun-medium', 'cpu'];
const GROUP_ICONS = ['boxes', 'droplets', 'flame', 'snowflake', 'plug-zap', 'lightbulb', 'fan', 'battery-charging', 'car', 'house'];
const GROUPABLE = ['switch', 'light', 'fan', 'climate', 'media_player'];
/** Commands without input, offered as buttons on types with no dedicated control. */
const SIMPLE_SERVICES = ['start', 'pause', 'stop', 'return_to_base', 'open_valve', 'close_valve', 'turn_on', 'turn_off', 'locate'];
/** Controls that need a full row under their label. */
const WIDE = ['climate', 'number', 'cover'];

const offline = (e) => !e || e.state === 'unavailable';
const isActive = (e) => !offline(e) && (['on', 'open', 'unlocked', 'playing'].includes(e.state) || (e.domain === 'climate' && e.state !== 'off' && e.state !== 'unknown'));
const controllable = (e) => e.services.length > 0;
const iconFor = (e) => e.icon || (e.deviceClass === 'power' ? 'zap' : e.deviceClass === 'temperature' ? 'thermometer' : DOMAIN[e.domain]?.icon ?? 'circle-dot');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** A state for display, with its unit. */
function fmtState(e) {
  if (offline(e)) return 'Offline';
  if (e.state === 'unknown' || e.state === '') return '–';
  const n = Number(e.state);
  if (e.unit && Number.isFinite(n)) {
    if (e.unit === 'W') return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(2)} kW` : `${Math.round(n)} W`;
    if (e.unit === '°C') {
      const f = appSettings.get()?.temperature_unit === '°F';
      return f ? `${(n * 1.8 + 32).toFixed(1)} °F` : `${n.toFixed(1)} °C`;
    }
    return `${Number.isInteger(n) ? n : n.toFixed(1)} ${e.unit}`;
  }
  if (e.domain === 'button') return 'Ready';
  return cap(e.state);
}

/** Loads everything once, then applies live state pushes; reloads when unknown entities appear. */
function useHome() {
  const [data, setData] = useState(null);
  const reloadTimer = useRef(null);
  const load = async () => {
    try {
      const [status, entities, devices, areas, groups] = await Promise.all([
        api.get('/api/home/status'), api.get('/api/home/entities'), api.get('/api/home/devices'), api.get('/api/home/areas'), api.get('/api/home/groups'),
      ]);
      // With the full engine, also what Home Assistant discovered and which integrations are set up.
      const [discovered, entries] = status.integrations
        ? await Promise.all([api.get('/api/home/integrations/discovered').catch(() => []), api.get('/api/home/integrations/entries').catch(() => [])])
        : [[], []];
      setData({ status, entities: Object.fromEntries(entities.map((e) => [e.entityId, e])), devices, areas, groups, discovered, entries });
    } catch (err) {
      setData((d) => d ?? { error: err.message });
    }
  };
  const reloadSoon = () => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 400);
  };
  useEffect(() => {
    let alive = true;
    load();
    const off = onHomeStates((list, removed) => {
      let unknown = removed.length > 0;
      setData((d) => {
        if (!d?.entities) return d;
        const entities = { ...d.entities };
        for (const s of list) {
          if (entities[s.entityId]) entities[s.entityId] = { ...entities[s.entityId], ...s };
          else unknown = true;
        }
        return { ...d, entities };
      });
      if (unknown) reloadSoon();
    });
    // Status every 10 s; with the full engine, discovered devices too (Home Assistant finds them over time).
    const t = setInterval(() => {
      api.get('/api/home/status').then((status) => alive && setData((d) => (d?.entities ? { ...d, status } : d)), () => {});
      api.get('/api/home/integrations/discovered').then((discovered) => alive && setData((d) => (d?.entities ? { ...d, discovered } : d)), () => {});
    }, 10_000);
    return () => {
      alive = false;
      off();
      clearInterval(t);
      clearTimeout(reloadTimer.current);
    };
  }, []);
  const patchEntity = (view) => setData((d) => (d?.entities ? { ...d, entities: { ...d.entities, [view.entityId]: view } } : d));
  return { data, load, patchEntity };
}

/** Sends a service call; shows the outcome as a toast. Returns the result. */
async function call(domain, service, entityId, data = {}) {
  try {
    const res = await api.post(`/api/home/services/${domain}/${service}`, { entity_id: entityId, ...data });
    const r = res.results[entityId];
    if (!r.ok) toast(r.message ?? 'The device refused the command', 'bad');
    else if (r.confirmed === false) toast('Sent, but the device has not confirmed it yet', 'bad');
    else if (r.message) toast(r.message);
    return r;
  } catch (err) {
    toast(err.message, 'bad');
    return { ok: false };
  }
}

// ---------- Controls ----------

function useCall(e, refresh) {
  const [busy, setBusy] = useState(false);
  const run = async (service, data, domain = e.domain) => {
    setBusy(true);
    await call(domain, service, e.entityId, data);
    // The push is batched; fetch this entity now so the control settles immediately.
    await api.get(`/api/home/entities/${e.entityId}`).then(refresh, () => {});
    setBusy(false);
  };
  return [busy, run];
}

/** Range input that only sends on release. */
function Slider({ value, min, max, step = 1, disabled, onCommit, format = (v) => v }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return html`<div class="dv-slider">
    <input type="range" min=${min} max=${max} step=${step} value=${v} disabled=${disabled}
      onInput=${(ev) => setV(Number(ev.target.value))} onChange=${(ev) => onCommit(Number(ev.target.value))} />
    <span class="tabular">${format(v)}</span>
  </div>`;
}

function Climate({ e, busy, run }) {
  const a = e.attributes;
  const step = a.target_temp_step ?? 0.5;
  const [target, setTarget] = useState(a.temperature ?? null);
  const timer = useRef(null);
  useEffect(() => setTarget(a.temperature ?? null), [a.temperature]);
  const nudge = (d) => {
    const next = Math.min(a.max_temp ?? 35, Math.max(a.min_temp ?? 7, (target ?? 24) + d));
    setTarget(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run('set_temperature', { temperature: next }), 700);
  };
  const can = (s) => e.services.includes(s);
  return html`<div class="dv-climate">
    ${can('set_hvac_mode') &&
    html`<${Select} value=${e.state} disabled=${busy || offline(e)} aria-label="Mode"
      options=${(a.hvac_modes ?? []).map((m) => ({ value: m, label: cap(m) }))} onChange=${(m) => run('set_hvac_mode', { hvac_mode: m })} />`}
    ${can('set_temperature') &&
    html`<div class="dv-stepper">
      <button class="icon-btn" aria-label="Lower" disabled=${offline(e)} onClick=${() => nudge(-step)}><${Ic} name="minus" size="sm" /></button>
      <b class="tabular">${target === null ? '–' : `${target}°`}</b>
      <button class="icon-btn" aria-label="Raise" disabled=${offline(e)} onClick=${() => nudge(step)}><${Ic} name="plus" size="sm" /></button>
    </div>`}
    ${a.current_temperature !== undefined && html`<span class="muted small">Room ${a.current_temperature}°</span>`}
  </div>`;
}

function Control({ e, refresh }) {
  const [busy, run] = useCall(e, refresh);
  const dis = busy || offline(e);
  const a = e.attributes;
  switch (e.domain) {
    case 'switch':
    case 'fan':
    case 'light':
    case 'group':
    case 'media_player':
      return html`<div class="dv-ctl-stack">
        <${Toggle} checked=${e.state === 'on'} disabled=${dis} onChange=${(on) => run(on ? 'turn_on' : 'turn_off')} />
        ${e.domain === 'light' && a.supports_brightness && e.state === 'on' &&
        html`<${Slider} value=${a.brightness ?? 255} min=${1} max=${255} disabled=${dis} format=${(v) => `${Math.round((v / 255) * 100)}%`}
          onCommit=${(v) => run('turn_on', { brightness: v })} />`}
        ${e.domain === 'fan' && e.services.includes('set_percentage') && e.state === 'on' &&
        html`<${Slider} value=${a.percentage ?? 100} min=${0} max=${100} disabled=${dis} format=${(v) => `${v}%`}
          onCommit=${(v) => run('set_percentage', { percentage: v })} />`}
      </div>`;
    case 'climate':
      return html`<${Climate} e=${e} busy=${busy} run=${run} />`;
    case 'number':
      return html`<${Slider} value=${Number(e.state) || a.min} min=${a.min} max=${a.max} step=${a.step} disabled=${dis}
        format=${(v) => `${v}${e.unit ? ' ' + e.unit : ''}`} onCommit=${(v) => run('set_value', { value: v })} />`;
    case 'select':
      return html`<${Select} value=${e.state} disabled=${dis} options=${a.options ?? []} onChange=${(o) => run('select_option', { option: o })} />`;
    case 'button':
      return html`<${Button} small disabled=${dis} onClick=${() => run('press')}>Press<//>`;
    case 'lock':
      return html`<${Button} small disabled=${dis} onClick=${() => run(e.state === 'locked' ? 'unlock' : 'lock')}>
        <${Ic} name=${e.state === 'locked' ? 'lock-open' : 'lock'} size="sm" />${e.state === 'locked' ? 'Unlock' : 'Lock'}<//>`;
    case 'cover':
      return html`<div class="dv-cover">
        ${e.services.includes('open_cover') && html`<button class="btn btn-sm" disabled=${dis} onClick=${() => run('open_cover')}>Open</button>`}
        ${e.services.includes('stop_cover') && html`<button class="btn btn-sm" disabled=${dis} onClick=${() => run('stop_cover')}>Stop</button>`}
        ${e.services.includes('close_cover') && html`<button class="btn btn-sm" disabled=${dis} onClick=${() => run('close_cover')}>Close</button>`}
        ${a.current_position !== undefined && html`<span class="muted small">${a.current_position}%</span>`}
      </div>`;
    default: {
      // Other Home Assistant types (vacuum, valve, siren …): buttons for the commands that need no input.
      const simple = SIMPLE_SERVICES.filter((sv) => e.services.includes(sv)).slice(0, 3);
      return simple.length
        ? html`<div class="dv-cover">${simple.map((sv) => html`<button class="btn btn-sm" disabled=${dis} onClick=${() => run(sv)}>${cap(sv.replace(/_(valve|cover)$/, ''))}</button>`)}</div>`
        : null;
    }
  }
}

// ---------- Device card ----------

function DeviceCard({ device, entities, room, onEdit, onHistory, refresh }) {
  const ctl = entities.filter(controllable);
  const readings = entities.filter((e) => !controllable(e)).slice(0, 4);
  const main = ctl[0] ?? entities[0];
  const active = ctl.some(isActive);
  const roles = [...new Set(ctl.map((e) => e.role).filter(Boolean))];
  return html`<div class=${`card dv-card ${device.available ? '' : 'is-off'} ${device.hidden ? 'is-hidden' : ''}`}>
    <div class="dv-head">
      <${IconChip} name=${main ? iconFor(main) : 'plug'} tone=${active ? 'accent' : ''} />
      <div class="dv-title">
        <b title=${device.name}>${device.name}</b>
        <span>${[room?.name, device.model, device.manufacturer].filter(Boolean).join(' · ') || 'Device'}</span>
      </div>
      ${!device.reviewed && !device.hidden && html`<${Badge} kind="accent">New<//>`}
      ${!device.available && html`<${Badge} kind="muted"><${Ic} name="wifi-off" size="sm" />Offline<//>`}
      <button class="icon-btn" aria-label=${`History of ${device.name}`} title="History" onClick=${onHistory}><${Ic} name="chart-line" size="sm" /></button>
      <button class="icon-btn" aria-label=${`Automate ${device.name}`} title="Create an automation for this device"
        onClick=${() => navigate(`/automations?edit=new&device=${encodeURIComponent((ctl[0] ?? entities[0])?.entityId ?? '')}`)}><${Ic} name="workflow" size="sm" /></button>
      <button class="icon-btn" aria-label=${`Edit ${device.name}`} onClick=${onEdit}><${Ic} name="pencil" size="sm" /></button>
    </div>
    ${ctl.length > 0 &&
    html`<div class="dv-ctls">
      ${ctl.map((e) => html`<div class=${`dv-ctl ${WIDE.includes(e.domain) ? 'wide' : ''}`}>
        <div class="dv-ctl-name">
          <span>${ctl.length === 1 ? fmtState(e) : e.name.replace(device.name, '').trim() || e.name}</span>
          ${ctl.length > 1 && html`<small>${fmtState(e)}</small>`}
        </div>
        <${Control} e=${e} refresh=${refresh} />
      </div>`)}
    </div>`}
    ${readings.length > 0 &&
    html`<div class="dv-readings">
      ${readings.map((e) => html`<span title=${e.name}><${Ic} name=${iconFor(e)} size="sm" />${fmtState(e)}</span>`)}
    </div>`}
    ${roles.length > 0 && html`<div class="dv-roles">${roles.map((r) => html`<${Badge} kind=${roleOf(r)?.badge}>${roleOf(r)?.label}<//>`)}</div>`}
  </div>`;
}

// ---------- History ----------

const STATE_TONE = { on: 'var(--battery)', off: 'var(--surface-3)', unavailable: 'var(--bad)', unknown: 'var(--faint)' };

/** Coloured strip of states over time, with a legend. */
function StateTimeline({ points, from, to }) {
  if (!points.length) return html`<p class="muted small">No changes recorded yet.</p>`;
  const span = to - from;
  const segs = points.map((p, i) => ({ state: p.state, a: Math.max(p.ts, from), b: i + 1 < points.length ? points[i + 1].ts : to }));
  const colors = {};
  const palette = ['var(--load)', 'var(--solar)', 'var(--grid)', 'var(--accent)'];
  for (const sg of segs) colors[sg.state] ??= STATE_TONE[sg.state] ?? palette[Object.keys(colors).filter((k) => !STATE_TONE[k]).length % palette.length];
  return html`<div class="dv-tl">${segs.map((sg) => html`<span title=${`${cap(sg.state)} from ${new Date(sg.a).toLocaleString()}`}
      style=${`left:${((sg.a - from) / span) * 100}%;width:${((sg.b - sg.a) / span) * 100}%;background:${colors[sg.state]}`}></span>`)}</div>
    <div class="dv-tl-legend">${Object.entries(colors).map(([st, c]) => html`<span><i style=${`background:${c}`}></i>${cap(st)}</span>`)}</div>`;
}

function HistoryModal({ device, entities, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    Promise.all(entities.map((e) => api.get(`/api/home/history?entity=${encodeURIComponent(e.entityId)}&hours=${hours}`).catch(() => null)))
      .then((list) => alive && setData(list.filter(Boolean)));
    return () => {
      alive = false;
    };
  }, [hours]);
  return html`<${Modal} open title=${`${device.name}: history`} onClose=${onClose}>
    <div class="dv-form">
      <${Segmented} value=${hours} onChange=${setHours} options=${[{ value: 6, label: '6 h' }, { value: 24, label: '24 h' }, { value: 168, label: '7 days' }]} />
      ${!data && html`<div class="loading">Loading…</div>`}
      ${data?.map((h) => {
        const e = entities.find((x) => x.entityId === h.entityId);
        const numeric = h.points.some((p) => p.num !== null);
        return html`<div class="dv-hist" key=${h.entityId}>
          <b>${e?.name ?? h.entityId}${e?.unit ? html` <span class="muted small">(${e.unit})</span>` : ''}</b>
          ${numeric
            ? html`<${TimeChart} height=${160} legend=${false} unit=${e?.unit ?? ''}
                xs=${[h.from / 1000, ...h.points.map((p) => p.ts / 1000), h.to / 1000]}
                series=${[{ label: e?.name ?? '', values: [h.points[0]?.ts === h.from ? h.points[0].num : null, ...h.points.map((p) => p.num), h.points.at(-1)?.num ?? null], color: '--accent', fill: '20' }]} />`
            : html`<${StateTimeline} points=${h.points} from=${h.from} to=${h.to} />`}
        </div>`;
      })}
      ${data && data.every((h) => !h.points.length) && html`<p class="muted small">History is recorded from now on; check back later.</p>`}
    </div>
  <//>`;
}

// ---------- Modals ----------

function DeviceModal({ device, entities, areas, onClose, onSaved, onAddRoom }) {
  const [name, setName] = useState(device.name);
  const [areaId, setAreaId] = useState(device.areaId ?? '');
  const [hidden, setHidden] = useState(device.hidden);
  const [ents, setEnts] = useState(() => Object.fromEntries(entities.map((e) => [e.entityId, {
    name: e.name, role: e.role ?? '', hidden: e.hidden, powerW: e.powerW ?? '',
    il: { maxLoadW: e.interlock?.maxLoadW ?? '', grid: e.interlock?.gridAvailable === undefined ? '' : String(e.interlock.gridAvailable), minSoc: e.interlock?.minBatterySoc ?? '' },
  }])));
  const [saving, setSaving] = useState(false);
  const setEnt = (id, patch) => setEnts((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/home/devices/${device.id}`, {
        name: name.trim() && name.trim() !== device.originalName ? name.trim() : null,
        areaId: areaId || null,
        hidden,
        reviewed: true,
      });
      for (const e of entities) {
        const d = ents[e.entityId];
        const body = {};
        const n = d.name.trim();
        if (n !== e.name) body.name = n && n !== e.originalName ? n : null;
        if ((d.role || null) !== e.role) body.role = d.role || null;
        if (d.hidden !== e.hidden) body.hidden = d.hidden;
        const pw = d.powerW === '' ? null : Number(d.powerW);
        if (pw !== (e.powerW ?? null)) body.powerW = pw;
        const il = {};
        if (d.il.maxLoadW !== '') il.maxLoadW = Number(d.il.maxLoadW);
        if (d.il.grid !== '') il.gridAvailable = d.il.grid === 'true';
        if (d.il.minSoc !== '') il.minBatterySoc = Number(d.il.minSoc);
        const next = Object.keys(il).length ? il : null;
        if (JSON.stringify(next) !== JSON.stringify(e.interlock ?? null)) body.interlock = next;
        if (Object.keys(body).length) await api.patch(`/api/home/entities/${e.entityId}`, body);
      }
      toast('Device saved');
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
    }
    setSaving(false);
  };
  const remove = async () => {
    if (!confirmAction(`Remove ${device.name}? If it comes back online it is added again.`)) return;
    try {
      await api.del(`/api/home/devices/${device.id}`);
      toast('Device removed');
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const addRoom = async () => {
    const id = await onAddRoom();
    if (id) setAreaId(id);
  };
  return html`<${Modal} open title=${device.reviewed ? 'Edit device' : 'Set up new device'} onClose=${onClose} footer=${html`
    ${!device.available && html`<${Button} kind="danger" onClick=${remove}><${Ic} name="trash-2" size="sm" />Remove<//>`}
    <span style="flex:1"></span>
    <${Button} onClick=${onClose}>Cancel<//>
    <${Button} kind="primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>`}>
    <div class="dv-form">
      <label class="dv-field"><span>Name</span><input value=${name} maxlength="100" placeholder=${device.originalName} onInput=${(ev) => setName(ev.target.value)} /></label>
      <div class="dv-field"><span>Room</span>
        <div class="dv-inline">
          <${Select} value=${areaId} onChange=${setAreaId} options=${[{ value: '', label: 'No room' }, ...areas.map((a) => ({ value: a.id, label: a.name }))]} />
          <${Button} small onClick=${addRoom}><${Ic} name="plus" size="sm" />New room<//>
        </div>
      </div>
      <p class="muted small dv-meta">${[device.manufacturer, device.model, device.swVersion && `firmware ${device.swVersion}`].filter(Boolean).join(' · ') || 'No device details reported'} · ${device.engine === 'lite' ? 'Built-in drivers' : device.engine}</p>
      <h3 class="dv-sub">Entities</h3>
      ${entities.map((e) => {
        const d = ents[e.entityId];
        return html`<div class="dv-ent">
          <div class="dv-ent-head"><${IconChip} name=${iconFor(e)} small /><code>${e.entityId}</code><span class="muted small">${fmtState(e)}</span></div>
          <div class="dv-ent-row">
            <input value=${d.name} maxlength="100" placeholder=${e.originalName} aria-label="Entity name" onInput=${(ev) => setEnt(e.entityId, { name: ev.target.value })} />
            ${controllable(e)
              ? html`<${Select} value=${d.role} aria-label="Energy role" onChange=${(r) => setEnt(e.entityId, { role: r })}
                  options=${[{ value: '', label: 'No energy role' }, ...ROLES.map((r) => ({ value: r.value, label: r.label }))]} />`
              : html`<span></span>`}
            <${Toggle} checked=${!d.hidden} label="Show" onChange=${(v) => setEnt(e.entityId, { hidden: !v })} />
          </div>
          ${d.role && html`<small class="muted">${roleOf(d.role)?.help}</small>`}
          ${d.role === 'protected' && html`<div class="dv-interlock">
            <b>Interlock</b><small class="muted">Every command to this device, by hand or by an automation, is refused unless these hold.</small>
            <div class="dv-il-row">
              <label><span>Max house load</span><span class="input-unit"><input type="number" min="0" step="100" placeholder="no limit" value=${d.il.maxLoadW}
                onInput=${(ev) => setEnt(e.entityId, { il: { ...d.il, maxLoadW: ev.target.value } })} /><span>W</span></span></label>
              <label><span>Grid must be</span><${Select} value=${d.il.grid} onChange=${(v) => setEnt(e.entityId, { il: { ...d.il, grid: v } })}
                options=${[{ value: '', label: 'Either' }, { value: 'true', label: 'Available' }, { value: 'false', label: 'Down' }]} /></label>
              <label><span>Battery at least</span><span class="input-unit"><input type="number" min="0" max="100" placeholder="any" value=${d.il.minSoc}
                onInput=${(ev) => setEnt(e.entityId, { il: { ...d.il, minSoc: ev.target.value } })} /><span>%</span></span></label>
            </div>
          </div>`}
          ${d.role === 'deferrable' && html`<label class="dv-power"><span>Power when on</span>
            <span class="input-unit"><input type="number" min="1" max="50000" step="50" value=${d.powerW} placeholder="e.g. 2000"
              onInput=${(ev) => setEnt(e.entityId, { powerW: ev.target.value })} /><span>W</span></span>
            <small class="muted">Spare solar starts it once this much is free (its own power reading is used while it runs).</small></label>`}
        </div>`;
      })}
      <div class="dv-ignore"><${Toggle} checked=${hidden} onChange=${setHidden} label="Ignore this device" /><small class="muted">Ignored devices are kept but hidden from this page.</small></div>
    </div>
  <//>`;
}

function RoomsModal({ areas, onClose, onChanged }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('house');
  const add = async () => {
    if (!name.trim()) return;
    try {
      await api.post('/api/home/areas', { name: name.trim(), icon });
      setName('');
      onChanged();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const patch = (a, body) => api.patch(`/api/home/areas/${a.id}`, body).then(onChanged, (err) => toast(err.message, 'bad'));
  const del = async (a) => {
    if (!confirmAction(`Delete the room "${a.name}"? Its devices move to "No room".`)) return;
    await api.del(`/api/home/areas/${a.id}`).then(onChanged, (err) => toast(err.message, 'bad'));
  };
  return html`<${Modal} open title="Rooms" onClose=${onClose} footer=${html`<${Button} kind="primary" onClick=${onClose}>Done<//>`}>
    <div class="dv-form">
      ${areas.length === 0 && html`<p class="muted small">No rooms yet. Rooms group devices on this page and in automations.</p>`}
      ${areas.map((a) => html`<div class="dv-room" key=${a.id}>
        <${Select} value=${a.icon} aria-label="Icon" options=${ROOM_ICONS.map((i) => ({ value: i, label: cap(i.replace(/-/g, ' ')) }))} onChange=${(i) => patch(a, { icon: i })} />
        <input value=${a.name} maxlength="60" aria-label="Room name" onChange=${(ev) => ev.target.value.trim() && patch(a, { name: ev.target.value.trim() })} />
        <button class="icon-btn" aria-label=${`Delete ${a.name}`} onClick=${() => del(a)}><${Ic} name="trash-2" size="sm" /></button>
      </div>`)}
      <div class="dv-room">
        <${Select} value=${icon} aria-label="Icon" options=${ROOM_ICONS.map((i) => ({ value: i, label: cap(i.replace(/-/g, ' ')) }))} onChange=${setIcon} />
        <input value=${name} maxlength="60" placeholder="New room, e.g. Kitchen" onInput=${(ev) => setName(ev.target.value)} onKeyDown=${(ev) => ev.key === 'Enter' && add()} />
        <${Button} small kind="primary" disabled=${!name.trim()} onClick=${add}>Add<//>
      </div>
    </div>
  <//>`;
}

function GroupModal({ group, entities, devices, onClose, onSaved }) {
  const [name, setName] = useState(group?.name ?? '');
  const [icon, setIcon] = useState(group?.icon ?? 'boxes');
  const [mode, setMode] = useState(group?.mode ?? 'any');
  const [members, setMembers] = useState(new Set(group?.members ?? []));
  const [saving, setSaving] = useState(false);
  const devName = Object.fromEntries(devices.map((d) => [d.id, d.name]));
  const options = Object.values(entities)
    .filter((e) => GROUPABLE.includes(e.domain) && !e.hidden && e.engine !== 'energy')
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (id, on) => setMembers((m) => {
    const n = new Set(m);
    on ? n.add(id) : n.delete(id);
    return n;
  });
  const save = async () => {
    setSaving(true);
    const body = { name: name.trim(), icon, mode, members: [...members] };
    try {
      if (group) await api.put(`/api/home/groups/${group.id}`, body);
      else await api.post('/api/home/groups', body);
      toast(group ? 'Group saved' : 'Group created');
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
    }
    setSaving(false);
  };
  const del = async () => {
    if (!confirmAction(`Delete the group "${group.name}"? Its devices are not affected.`)) return;
    await api.del(`/api/home/groups/${group.id}`).then(onSaved, (err) => toast(err.message, 'bad'));
  };
  return html`<${Modal} open title=${group ? 'Edit group' : 'New group'} onClose=${onClose} footer=${html`
    ${group && html`<${Button} kind="danger" onClick=${del}><${Ic} name="trash-2" size="sm" />Delete<//>`}
    <span style="flex:1"></span>
    <${Button} onClick=${onClose}>Cancel<//>
    <${Button} kind="primary" disabled=${saving || !name.trim() || members.size === 0} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>`}>
    <div class="dv-form">
      <label class="dv-field"><span>Name</span><input value=${name} maxlength="100" placeholder="e.g. Pool and water heater" onInput=${(ev) => setName(ev.target.value)} /></label>
      <div class="dv-field"><span>Icon</span><${Select} value=${icon} onChange=${setIcon} options=${GROUP_ICONS.map((i) => ({ value: i, label: cap(i.replace(/-/g, ' ')) }))} /></div>
      <div class="dv-field"><span>Shows as on when</span>
        <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: 'any', label: 'Any member is on' }, { value: 'all', label: 'All members are on' }]} />
      </div>
      <h3 class="dv-sub">Members <span class="muted small">${members.size} selected</span></h3>
      ${options.length === 0
        ? html`<p class="muted small">No switchable devices yet.</p>`
        : html`<div class="dv-members">${options.map((e) => html`<label class="dv-member">
            <input type="checkbox" checked=${members.has(e.entityId)} onChange=${(ev) => toggle(e.entityId, ev.target.checked)} />
            <${Ic} name=${iconFor(e)} size="sm" /><span>${e.name}</span><small class="muted">${e.deviceId ? devName[e.deviceId] ?? '' : ''}</small>
          </label>`)}</div>`}
    </div>
  <//>`;
}

// ---------- Settings ----------

function EngineCard({ status, onChanged }) {
  const liteActive = status.active === 'lite';
  const s = useStore(appSettings) ?? {};
  const b = status.board;
  const lite = status.engines.find((e) => e.id === 'lite');
  const mqtt = lite?.info?.drivers?.find((d) => d.id === 'mqtt');
  const save = async (values) => {
    try {
      await saveSettings(values);
      setTimeout(onChanged, 1200);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const recommended = status.recommended === 'full' ? 'all Home Assistant integrations' : 'built-in drivers';
  return html`<${Card} class="dv-settings" title="Device settings" subtitle=${`${b.name} · ${b.ramMb} MB RAM`}>
    <div class="dv-set-row">
      <div><b>Device engine</b><small class="muted">Auto picks ${recommended} for this board.</small></div>
      <${Select} value=${status.setting} onChange=${(v) => save({ 'home.engine': v })} options=${[
        { value: 'auto', label: `Auto (${status.recommended === 'full' ? 'Full' : 'Lite'})` },
        { value: 'lite', label: 'Lite: built-in drivers' },
        { value: 'full', label: b.engine.full === 'no' ? 'Full: not available on this board' : 'Full: all Home Assistant integrations' },
      ]} />
    </div>
    ${b.engine.reason && html`<p class="muted small dv-note"><${Ic} name="info" size="sm" />${b.engine.reason}</p>`}
    ${status.selected === 'full' && status.active === 'lite' &&
    html`<p class="muted small dv-note"><${Ic} name="info" size="sm" />The full engine isn't installed yet, so the built-in drivers run in its place.</p>`}
    <${HomeAssistantRow} status=${status} onChanged=${onChanged} />
    ${status.active === 'full' && status.engines.find((e) => e.id === 'full')?.info?.state === 'connected' && html`<${HomeAssistantManage} />`}
    ${status.leftovers > 0 && html`<div class="dv-set-row">
      <div><b>Leftover devices</b><small class="muted">${status.leftovers} device${status.leftovers === 1 ? '' : 's'} from an engine no longer in use, all offline.</small></div>
      <${Button} small onClick=${async () => {
        if (!confirmAction(`Remove ${status.leftovers} offline leftover device${status.leftovers === 1 ? '' : 's'}?`)) return;
        const r = await api.post('/api/home/cleanup').catch((err) => toast(err.message, 'bad'));
        if (r) toast(`Removed ${r.removed}`);
        onChanged();
      }}>Remove them<//>
    </div>`}
    <div class="dv-set-row">
      <div><b>MQTT devices</b><small class="muted">${mqtt ? (mqtt.state === 'connected' ? `Connected to ${mqtt.details?.broker}` : mqtt.message ?? cap(mqtt.state))
        : status.active === 'full' ? "Handled by Home Assistant's MQTT integration, connected to Sunroost's broker" : 'Not running'}</small></div>
      <a class="btn btn-sm" href="/configuration/mqtt">MQTT settings</a>
    </div>
    <div class="dv-set-row">
      <div><b>Demo devices</b><small class="muted">${liteActive ? 'A simulated plug, bulb, air conditioner and EV charger, for trying things out.' : 'Available with the built-in drivers (Lite engine).'}</small></div>
      <${Toggle} checked=${!!s['home.demo_devices']} disabled=${!liteActive} onChange=${(v) => save({ 'home.demo_devices': v })} />
    </div>
    ${mqtt?.details?.ignored?.length > 0 &&
    html`<details class="dv-ignored"><summary>${mqtt.details.ignored.length} announcement${mqtt.details.ignored.length === 1 ? '' : 's'} not supported</summary>
      ${mqtt.details.ignored.map((i) => html`<div class="small"><code>${i.topic}</code><span class="muted"> ${i.reason}</span></div>`)}
    </details>`}
  <//>`;
}

function GettingStarted({ full, onAdd }) {
  if (full) {
    return html`<div class="dv-start">
      <span class="wx-icon"><${Ic} name="plug-zap" /></span>
      <h3>No smart devices yet</h3>
      <p class="muted">Devices Home Assistant finds on your network show up under "New devices". Anything else, add it by brand:</p>
      <${Button} kind="primary" onClick=${onAdd}><${Ic} name="blocks" size="sm" />Add integration<//>
    </div>`;
  }
  return html`<div class="dv-start">
    <span class="wx-icon"><${Ic} name="plug-zap" /></span>
    <h3>No smart devices yet</h3>
    <p class="muted">Devices on your network that announce themselves over MQTT appear here automatically:</p>
    <ul class="muted small">
      <li><b>ESPHome</b> with the MQTT component, <b>Zigbee2MQTT</b>, <b>OpenBeken</b>: point them at Sunroost's MQTT broker.</li>
      <li><b>Tasmota</b>: point it at Sunroost's broker and run <code>SetOption19 1</code>.</li>
    </ul>
    <p class="muted small">No hardware yet? Turn on <b>Demo devices</b> below.</p>
  </div>`;
}

// ---------- Page ----------

export default function Devices() {
  const { data, load, patchEntity } = useHome();
  const snap = useStore(live);
  const [groupBy, setGroupBy] = useState('room');
  const [query, setQuery] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  const [editing, setEditing] = useState(null);
  const [rooms, setRooms] = useState(false);
  const [groupEdit, setGroupEdit] = useState(null);
  const [flow, setFlow] = useState(null);
  const [historyOf, setHistoryOf] = useState(null);
  const [catalogue, setCatalogue] = useState(false);

  const view = useMemo(() => {
    if (!data?.entities) return null;
    const ents = Object.values(data.entities);
    const byDevice = {};
    for (const e of ents) if (e.deviceId) (byDevice[e.deviceId] ??= []).push(e);
    const devices = data.devices.filter((d) => d.engine !== 'energy');
    const deviceEntities = ents.filter((e) => e.engine !== 'energy' && e.engine !== 'group');
    const power = deviceEntities.filter((e) => e.unit === 'W' && !offline(e)).reduce((sum, e) => sum + (Number(e.state) || 0), 0);
    const online = devices.filter((d) => d.available).length;
    const on = deviceEntities.filter((e) => controllable(e) && isActive(e)).length;
    return { byDevice, devices, power, online, on };
  }, [data]);

  if (!data) return html`<${Page} title="Smart devices"><div class="loading">Loading…</div><//>`;
  if (data.error) return html`<${Page} title="Smart devices"><div class="notice notice-bad">${data.error}</div><//>`;

  const { status, areas, groups, discovered = [], entries = [] } = data;
  const fullInfo = status.engines.find((e) => e.id === 'full')?.info;
  // "Add integration" works with either engine: Home Assistant's integrations, or the built-in drivers.
  const fullReady = status.integrations;
  const startFlow = (promise) => {
    setCatalogue(false);
    setFlow({ start: promise });
  };
  const dismiss = (d) => api.del(`/api/home/flows/${d.flowId}`).then(load, (err) => toast(err.message, 'bad'));
  const areaById = Object.fromEntries(areas.map((a) => [a.id, a]));
  const lite = status.engines.find((e) => e.id === 'lite');
  const mqtt = lite?.info?.drivers?.find((d) => d.id === 'mqtt');
  const q = query.trim().toLowerCase();
  const entitiesOf = (d) => (view.byDevice[d.id] ?? []).filter((e) => showIgnored || !e.hidden);
  const matches = (d) =>
    !q || [d.name, d.model, d.manufacturer, ...(view.byDevice[d.id] ?? []).map((e) => e.name)].some((t) => t?.toLowerCase().includes(q));
  const fresh = view.devices.filter((d) => !d.reviewed && !d.hidden);
  // New devices show in the grid too (with a "New" badge), so they can be used before they're set up.
  const shown = view.devices.filter((d) => (showIgnored || !d.hidden) && matches(d));
  const ignoredCount = view.devices.filter((d) => d.hidden).length;

  const keyOf = (d) => {
    if (groupBy === 'room') return d.areaId && areaById[d.areaId] ? `a:${d.areaId}` : 'z:none';
    const main = entitiesOf(d).find(controllable) ?? entitiesOf(d)[0];
    if (groupBy === 'type') return `t:${DOMAIN[main?.domain]?.label ?? 'Other'}`;
    return `r:${main?.role ?? 'zz'}`;
  };
  const sections = {};
  for (const d of shown) (sections[keyOf(d)] ??= []).push(d);
  const title = (k) => {
    const [kind, v] = [k[0], k.slice(2)];
    if (kind === 'a') return { label: areaById[v].name, icon: areaById[v].icon };
    if (kind === 'z') return { label: 'No room', icon: 'circle-dashed' };
    if (kind === 't') return { label: v, icon: Object.values(DOMAIN).find((x) => x.label === v)?.icon ?? 'circle-dot' };
    const r = roleOf(v);
    return { label: r ? r.label : 'No energy role', icon: r ? 'shield' : 'circle-dashed', help: r?.help };
  };
  // Alphabetical, with "No room" / "No energy role" last; roles in their defined order.
  const rank = (k) => (k === 'z:none' || k === 'r:zz' ? 2 : k.startsWith('r:') ? 1 : 0);
  const roleIdx = (k) => ROLES.findIndex((r) => r.value === k.slice(2));
  const order = Object.keys(sections).sort((a, b) =>
    rank(a) - rank(b) || (a.startsWith('r:') && b.startsWith('r:') ? roleIdx(a) - roleIdx(b) : title(a).label.localeCompare(title(b).label)));

  const loadW = Number(snap?.totals?.['Load power']);
  // Only meaningful when device readings fit inside the measured load (they come from different meters).
  const share = view.power > 0 && loadW > 0 && view.power <= loadW ? Math.round((view.power / loadW) * 100) : null;
  const addRoom = async () => {
    const name = window.prompt('Name of the new room');
    if (!name?.trim()) return null;
    try {
      const a = await api.post('/api/home/areas', { name: name.trim() });
      await load();
      return a.id;
    } catch (err) {
      toast(err.message, 'bad');
      return null;
    }
  };
  const quickReview = async (d, body) => {
    await api.patch(`/api/home/devices/${d.id}`, { reviewed: true, ...body }).then(load, (err) => toast(err.message, 'bad'));
  };
  const editingDevice = editing && data.devices.find((d) => d.id === editing);
  const groupEntities = groups.map((g) => data.entities[g.entityId]).filter(Boolean);

  return html`<${Page} title="Smart devices" wide actions=${html`
      ${status.active === 'lite' && html`<${Button} title="Look for devices on the network now" onClick=${async () => {
        await api.post('/api/home/scan').catch(() => {});
        toast('Scanning the network…');
        setTimeout(load, 4000);
      }}><${Ic} name="radar" size="sm" />Scan<//>`}
      ${fullReady && html`<${Button} onClick=${() => setCatalogue(true)}><${Ic} name="blocks" size="sm" />Add integration<//>`}
      <${Button} onClick=${() => setRooms(true)}><${Ic} name="house" size="sm" />Rooms<//>
      <${Button} kind="primary" onClick=${() => setGroupEdit({})}><${Ic} name="plus" size="sm" />New group<//>`}>
    <div class="dv-kpis">
      <${Kpi} icon="plug-zap" tone="accent" label="Devices online" value=${`${view.online}`} unit=${`/ ${view.devices.length}`}
        sub=${view.devices.length - view.online > 0 ? `${view.devices.length - view.online} offline` : 'All reachable'} />
      <${Kpi} icon="power" tone="load" label="Switched on" value=${view.on} unit=${view.on === 1 ? 'device' : 'devices'} sub="Switches, lights, climate" />
      <${Kpi} icon="zap" tone="solar" label="Device power now" value=${view.power >= 1000 ? (view.power / 1000).toFixed(2) : Math.round(view.power)}
        unit=${view.power >= 1000 ? 'kW' : 'W'} sub=${share !== null ? `${share}% of the home's load` : 'From devices that report power'} />
      <${Kpi} icon="cpu" tone="grid" label="Device engine" value=${status.active === 'full' ? 'Full' : status.active === 'lite' ? 'Lite' : 'Off'}
        sub=${status.active === 'lite' ? 'Built-in drivers' : status.active === 'full' ? (fullInfo?.version ? `Home Assistant ${fullInfo.version}` : 'Home Assistant') : 'Not running'} />
    </div>

    ${mqtt && mqtt.state !== 'connected' &&
    html`<div class=${`notice ${mqtt.state === 'error' ? 'notice-bad' : 'notice-warn'} dv-notice`}>
      <${Ic} name="circle-alert" size="sm" /><span>${mqtt.message ?? 'Connecting to the MQTT broker…'}</span>
      <a href="/configuration/mqtt">MQTT settings</a>
    </div>`}

    ${status.active === 'full' && fullInfo && fullInfo.state !== 'connected' &&
    html`<div class=${`notice ${fullInfo.state === 'setup' ? 'notice-warn' : 'notice-bad'} dv-notice`}>
      <${Ic} name="circle-alert" size="sm" /><span>${fullInfo.message ?? 'Connecting to Home Assistant…'}</span>
    </div>`}

    ${fresh.length + discovered.length > 0 &&
    html`<${Card} class="dv-new" title=${`New devices (${fresh.length + discovered.length})`} subtitle="Found on your network. Set them up, give them a room and energy role, or ignore them.">
      <div class="list">
        <${DiscoveredList} items=${discovered} onSetUp=${(d) => startFlow(api.get(`/api/home/flows/${d.flowId}`))} onDismiss=${dismiss} />
        ${fresh.map((d) => {
          const ents = view.byDevice[d.id] ?? [];
          const main = ents.find(controllable) ?? ents[0];
          return html`<div class="list-item">
            <${IconChip} name=${main ? iconFor(main) : 'plug'} tone="accent" small />
            <div class="list-main"><div class="list-title">${d.name}</div>
              <div class="list-sub">${[d.manufacturer, d.model, `${ents.length} ${ents.length === 1 ? 'entity' : 'entities'}`].filter(Boolean).join(' · ')}</div></div>
            <${Button} small kind="ghost" onClick=${() => quickReview(d, { hidden: true })}>Ignore<//>
            <${Button} small kind="primary" onClick=${() => setEditing(d.id)}>Set up<//>
          </div>`;
        })}
      </div>
    <//>`}

    ${view.devices.length === 0
      ? html`<${Card}><${GettingStarted} full=${fullReady} onAdd=${() => setCatalogue(true)} /><//>`
      : html`
        <div class="dv-toolbar">
          <${Segmented} value=${groupBy} onChange=${setGroupBy} options=${[{ value: 'room', label: 'Rooms' }, { value: 'type', label: 'Type' }, { value: 'role', label: 'Energy role' }]} />
          <label class="dv-search"><${Ic} name="search" size="sm" /><input type="search" placeholder="Search devices" value=${query} onInput=${(ev) => setQuery(ev.target.value)} /></label>
          ${ignoredCount > 0 && html`<${Toggle} checked=${showIgnored} onChange=${setShowIgnored} label=${`Show ignored (${ignoredCount})`} />`}
        </div>

        ${groupEntities.length > 0 && !q &&
        html`<div class="dv-section"><h2><${Ic} name="boxes" size="sm" />Groups</h2>
          <div class="dv-grid">${groups.map((g) => {
            const e = data.entities[g.entityId];
            if (!e) return null;
            return html`<div class="card dv-card dv-group">
              <div class="dv-head">
                <${IconChip} name=${g.icon} tone=${isActive(e) ? 'accent' : ''} />
                <div class="dv-title"><b>${g.name}</b><span>${e.attributes.members_on ?? 0} of ${g.members.length} on · ${g.mode === 'all' ? 'all must be on' : 'any on'}</span></div>
                <button class="icon-btn" aria-label=${`Edit ${g.name}`} onClick=${() => setGroupEdit(g)}><${Ic} name="pencil" size="sm" /></button>
              </div>
              <div class="dv-ctls"><div class="dv-ctl"><div class="dv-ctl-name"><span>${fmtState(e)}</span></div><${Control} e=${e} refresh=${patchEntity} /></div></div>
            </div>`;
          })}</div>
        </div>`}

        ${order.length === 0 && q && html`<${Empty}>No devices match "${query}".<//>`}
        ${order.map((k) => {
          const t = title(k);
          return html`<div class="dv-section" key=${k}>
            <h2><${Ic} name=${t.icon} size="sm" />${t.label}<span class="muted small">${sections[k].length}</span>${t.help && html`<small class="muted dv-help">${t.help}</small>`}</h2>
            <div class="dv-grid">
              ${sections[k].map((d) => html`<${DeviceCard} key=${d.id} device=${d} entities=${entitiesOf(d)} room=${groupBy === 'room' ? null : areaById[d.areaId]}
                onEdit=${() => setEditing(d.id)} onHistory=${() => setHistoryOf(d.id)} refresh=${patchEntity} />`)}
            </div>
          </div>`;
        })}`}

    ${fullReady && html`<${IntegrationsCard} entries=${entries} engine=${status.active} onAdd=${() => setCatalogue(true)} onChanged=${load} />`}
    <${EngineCard} status=${status} onChanged=${load} />
    ${catalogue && html`<${CatalogueModal} onClose=${() => setCatalogue(false)} onPick=${(i) => startFlow(api.post('/api/home/flows', { handler: i.domain }))} />`}
    ${flow && html`<${FlowModal} start=${flow.start} onClose=${() => {
      setFlow(null);
      load();
    }} onDone=${() => {
      setFlow(null);
      setTimeout(load, 1500);
    }} />`}

    ${editingDevice &&
    html`<${DeviceModal} key=${editingDevice.id} device=${editingDevice} entities=${view.byDevice[editingDevice.id] ?? []} areas=${areas}
      onAddRoom=${addRoom} onClose=${() => setEditing(null)} onSaved=${() => {
        setEditing(null);
        load();
      }} />`}
    ${historyOf && html`<${HistoryModal} device=${data.devices.find((d) => d.id === historyOf)} entities=${view.byDevice[historyOf] ?? []} onClose=${() => setHistoryOf(null)} />`}
    ${rooms && html`<${RoomsModal} areas=${areas} onClose=${() => setRooms(false)} onChanged=${load} />`}
    ${groupEdit &&
    html`<${GroupModal} group=${groupEdit.id ? groupEdit : null} entities=${data.entities} devices=${data.devices}
      onClose=${() => setGroupEdit(null)} onSaved=${() => {
        setGroupEdit(null);
        load();
      }} />`}
  <//>`;
}

const css = `
.dv-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.dv-kpis .card { padding: 18px; }
@media (max-width: 1100px) { .dv-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .dv-kpis { gap: 12px; } .dv-kpis .card { padding: 14px; } .dv-kpis .kpi { flex-direction: column; gap: 10px; } .dv-kpis .kpi-value { font-size: 22px; }
}
.dv-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.dv-notice span { flex: 1; }
.dv-new { margin-bottom: 16px; }
.dv-new .list-item .btn { flex: none; }
.dv-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 16px; }
.dv-search { position: relative; display: flex; align-items: center; flex: 1; min-width: 180px; max-width: 320px; }
.dv-search .ic { position: absolute; left: 11px; color: var(--muted); pointer-events: none; }
.dv-search input { max-width: none; width: 100%; padding-left: 34px; }
.dv-section { margin-bottom: 22px; }
.dv-section h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; margin: 0 0 10px; color: var(--heading); flex-wrap: wrap; }
.dv-section h2 .ic { color: var(--muted); }
.dv-section h2 > .muted { font-weight: 500; }
.dv-help { font-weight: 400; }
.dv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap: 14px; }
.dv-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; min-width: 0; }
.dv-card.is-off .dv-ctls, .dv-card.is-off .dv-readings { opacity: .55; }
.dv-card.is-hidden { opacity: .6; }
.dv-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dv-title { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.dv-title b { color: var(--heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dv-title span { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dv-head .badge { flex: none; display: inline-flex; align-items: center; gap: 4px; }
.dv-ctls { display: flex; flex-direction: column; gap: 10px; }
.dv-ctl { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.dv-ctl.wide { flex-direction: column; align-items: stretch; gap: 8px; }
.dv-ctl.wide .dv-climate, .dv-ctl.wide .dv-cover { justify-content: flex-start; }
.dv-ctl.wide .dv-slider input[type="range"] { flex: 1; width: auto; }
.dv-ctl-name { display: flex; flex-direction: column; min-width: 0; font-weight: 600; color: var(--heading); }
.dv-ctl-name span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dv-ctl-name small { font-weight: 500; color: var(--muted); font-size: 12px; }
.dv-ctl-stack { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
.dv-slider { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dv-slider input[type="range"] { width: 130px; max-width: 100%; accent-color: var(--accent); padding: 0; height: auto; border: 0; background: none; }
.dv-slider span { font-size: 12.5px; color: var(--muted); min-width: 44px; text-align: right; }
.dv-climate { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.dv-climate select { width: auto; }
.dv-stepper { display: inline-flex; align-items: center; gap: 4px; background: var(--surface-2); border-radius: 12px; padding: 2px; }
.dv-stepper b { min-width: 44px; text-align: center; color: var(--heading); }
.dv-stepper .icon-btn { width: 30px; height: 30px; }
.dv-cover { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.dv-readings { display: flex; flex-wrap: wrap; gap: 6px; }
.dv-readings span { display: inline-flex; align-items: center; gap: 6px; background: var(--surface-2); border-radius: 10px; padding: 5px 9px; font-size: 12.5px;
  color: var(--heading); font-weight: 600; font-variant-numeric: tabular-nums; }
.dv-readings .ic { color: var(--muted); }
.dv-roles { display: flex; gap: 6px; flex-wrap: wrap; }
.dv-group .dv-ctl-name span { font-weight: 600; }
.dv-settings { margin-top: 8px; }
.dv-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--grid-line); flex-wrap: wrap; }
.dv-set-row:last-of-type { border-bottom: 0; }
.dv-set-row > div { display: flex; flex-direction: column; min-width: 0; flex: 1 1 260px; }
.dv-set-row b { color: var(--heading); }
.dv-set-row select { width: auto; max-width: 100%; }
.dv-note { display: flex; gap: 6px; align-items: flex-start; margin: 0 0 6px; }
.dv-note .ic { flex: none; margin-top: 2px; }
.dv-ignored { margin-top: 8px; font-size: 13px; }
.dv-ignored summary { cursor: pointer; color: var(--muted); }
.dv-ignored div { padding: 4px 0; overflow-wrap: anywhere; }
.dv-start { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 18px 8px; }
.dv-start h3 { margin: 6px 0 0; }
.dv-start p { margin: 0; max-width: 520px; }
.dv-start ul { text-align: left; max-width: 520px; margin: 4px 0; padding-left: 20px; line-height: 1.7; }
.dv-form { display: flex; flex-direction: column; gap: 12px; }
.dv-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.dv-field input, .dv-field select { max-width: none; }
.dv-inline { display: flex; gap: 8px; align-items: center; }
.dv-inline select { flex: 1; max-width: none; }
.dv-meta { margin: -4px 0 0; }
.dv-sub { font-size: 14px; margin: 6px 0 0; display: flex; gap: 8px; align-items: baseline; }
.dv-ent { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dv-ent-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dv-ent-head code { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-ent-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 170px) auto; gap: 8px; align-items: center; }
.dv-ent-row input, .dv-ent-row select { max-width: none; width: 100%; }
@media (max-width: 560px) { .dv-ent-row { grid-template-columns: 1fr; } }
.dv-hist { display: flex; flex-direction: column; gap: 6px; }
.dv-tl { position: relative; height: 22px; border-radius: 6px; overflow: hidden; background: var(--surface-2); }
.dv-tl span { position: absolute; top: 0; bottom: 0; }
.dv-tl-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.dv-tl-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.dv-interlock { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: 13px; }
.dv-interlock b { color: var(--heading); }
.dv-il-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dv-il-row label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; color: var(--muted); }
.dv-il-row input, .dv-il-row select { max-width: none; width: 100%; }
@media (max-width: 560px) { .dv-il-row { grid-template-columns: 1fr; } }
.dv-power { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; color: var(--muted); }
.dv-power .input-unit input { max-width: 140px; }
.dv-ignore { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
.dv-room { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.dv-room input, .dv-room select { max-width: none; width: 100%; }
.dv-members { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: 12px; }
.dv-member { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--grid-line); cursor: pointer; font-size: 13.5px; }
.dv-member:last-child { border-bottom: 0; }
.dv-member span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--heading); }
.dv-member small { flex: none; }
`;
let styleEl = document.getElementById('css-devices');
if (!styleEl) {
  styleEl = document.createElement('style');
  styleEl.id = 'css-devices';
  document.head.appendChild(styleEl);
}
styleEl.textContent = css + integrationsCss;
