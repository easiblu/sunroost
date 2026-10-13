// Home Assistant integrations for the Smart devices page (full engine): catalogue, setup flows,
// discovered devices, configured integrations, and linking a Home Assistant on the network.
import { api, html, useEffect, useMemo, useState } from '../lib/core.js';
import { Badge, Button, Card, Ic, IconChip, Modal, Select, Toggle, confirmAction, toast } from '../lib/ui.js';

const SOURCES = { zeroconf: 'network', ssdp: 'network', dhcp: 'network', bluetooth: 'Bluetooth', usb: 'USB', mqtt: 'MQTT', homekit: 'HomeKit' };

/** Starting values for a form: the field defaults, nested for sections. */
function initial(fields) {
  const out = {};
  for (const f of fields) {
    if (f.kind === 'section') out[f.name] = initial(f.fields ?? []);
    else if (f.default !== undefined) out[f.name] = f.default;
  }
  return out;
}

/** Drops empty optional values (Home Assistant treats a missing optional field as "not set"). */
function clean(fields, values) {
  const out = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.kind === 'section') out[f.name] = clean(f.fields ?? [], v ?? {});
    else if (v === undefined || (v === '' && !f.required)) continue;
    else out[f.name] = f.kind === 'number' && v !== '' ? Number(v) : v;
  }
  return out;
}

function FlowField({ f, value, onChange }) {
  const label = html`<span>${f.label}${f.required ? '' : html` <small class="muted">(optional)</small>`}</span>`;
  const help = f.help && html`<small class="muted dv-flow-help">${f.help}</small>`;
  switch (f.kind) {
    case 'section':
      return html`<details class="dv-flow-section" open=${!f.collapsed}>
        <summary>${f.label}</summary>${help}
        ${(f.fields ?? []).map((sf) => html`<${FlowField} key=${sf.name} f=${sf} value=${value?.[sf.name]} onChange=${(v) => onChange({ ...(value ?? {}), [sf.name]: v })} />`)}
      </details>`;
    case 'boolean':
      return html`<div class="dv-field dv-flow-bool"><${Toggle} checked=${!!value} onChange=${onChange} label=${f.label} />${help}</div>`;
    case 'select':
      return html`<label class="dv-field">${label}
        <${Select} value=${value ?? ''} onChange=${onChange} options=${[...(f.required && value !== undefined ? [] : [{ value: '', label: 'Choose…' }]), ...f.options]} />${help}</label>`;
    case 'multiselect':
      return html`<div class="dv-field">${label}<div class="dv-members">${f.options.map((o) => html`<label class="dv-member">
        <input type="checkbox" checked=${(value ?? []).includes(o.value)}
          onChange=${(ev) => onChange(ev.target.checked ? [...(value ?? []), o.value] : (value ?? []).filter((x) => x !== o.value))} />
        <span>${o.label}</span></label>`)}</div>${help}</div>`;
    case 'number':
      return html`<label class="dv-field">${label}<span class="input-unit">
        <input type="number" value=${value ?? ''} min=${f.min} max=${f.max} step=${f.step ?? 'any'} onInput=${(ev) => onChange(ev.target.value)} />
        ${f.unit && html`<span>${f.unit}</span>`}</span>${help}</label>`;
    case 'unsupported':
      return html`<div class="dv-field">${label}<small class="muted">${f.help ?? "This kind of field can't be shown in Sunroost yet; the default is used."}</small></div>`;
    default:
      return html`<label class="dv-field">${label}
        ${f.multiline
          ? html`<textarea rows="4" value=${value ?? ''} onInput=${(ev) => onChange(ev.target.value)}></textarea>`
          : html`<input type=${f.kind === 'password' ? 'password' : 'text'} autocomplete="off" value=${value ?? ''} onInput=${(ev) => onChange(ev.target.value)} />`}
        ${help}</label>`;
  }
}

/** Runs one Home Assistant config flow to the end. `start` is a promise of the first step. */
export function FlowModal({ start, onClose, onDone }) {
  const [view, setView] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const show = (v) => {
    setView(v);
    if (v.type === 'form') setValues(initial(v.fields));
  };
  useEffect(() => {
    start.then(show, (err) => setError(err.message));
  }, []);
  // External steps (sign in on another site) and progress steps finish on Home Assistant's side: poll.
  useEffect(() => {
    if (!view || (view.type !== 'progress' && view.type !== 'external')) return;
    const t = setInterval(() => api.get(`/api/home/flows/${view.flowId}`).then((v) => v.type !== view.type && show(v), () => {}), 2500);
    return () => clearInterval(t);
  }, [view]);
  const submit = async (input) => {
    setBusy(true);
    setError(null);
    try {
      show(await api.post(`/api/home/flows/${view.flowId}`, { input }));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  const cancel = async () => {
    if (view?.flowId && view.type !== 'create_entry' && view.type !== 'abort') await api.del(`/api/home/flows/${view.flowId}`).catch(() => {});
    onClose();
  };
  const finished = view && (view.type === 'create_entry' || view.type === 'abort');
  const footer = finished
    ? html`<${Button} kind="primary" onClick=${() => (view.type === 'create_entry' ? onDone() : onClose())}>Done<//>`
    : html`<${Button} onClick=${cancel}>Cancel<//>
        ${view?.type === 'form' && html`<${Button} kind="primary" disabled=${busy} onClick=${() => submit(clean(view.fields, values))}>${busy ? 'Working…' : view.lastStep === false ? 'Next' : 'Submit'}<//>`}`;
  return html`<${Modal} open title=${view?.title ?? 'Add integration'} onClose=${cancel} footer=${footer}>
    <div class="dv-form">
      ${!view && !error && html`<div class="loading">Starting…</div>`}
      ${error && html`<div class="notice notice-bad">${error}</div>`}
      ${view?.description && view.type !== 'abort' && html`<p class="dv-flow-desc">${view.description}</p>`}
      ${view?.type === 'form' &&
      html`${view.errors.base && html`<div class="notice notice-bad">${view.errors.base}</div>`}
        ${view.fields.map((f) => html`<div key=${f.name}>
          <${FlowField} f=${f} value=${values[f.name]} onChange=${(v) => setValues((x) => ({ ...x, [f.name]: v }))} />
          ${view.errors[f.name] && html`<small class="text-bad">${view.errors[f.name]}</small>`}
        </div>`)}
        ${view.fields.length === 0 && html`<p class="muted">Press Submit to continue.</p>`}`}
      ${view?.type === 'menu' &&
      html`<div class="dv-flow-menu">${view.options.map((o) => html`<button class="btn" disabled=${busy} onClick=${() => submit({ next_step_id: o.value })}>${o.label}<${Ic} name="chevron-right" size="sm" /></button>`)}</div>`}
      ${view?.type === 'external' &&
      html`<p>Finish this step on the provider's site, then come back here.</p>
        <a class="btn btn-primary" href=${view.url} target="_blank" rel="noopener">Open sign-in page<${Ic} name="external-link" size="sm" /></a>
        <p class="muted small">Some providers only accept sign-ins started from Home Assistant's own address; if this one refuses, it isn't supported from Sunroost yet.</p>`}
      ${view?.type === 'progress' && html`<div class="loading">Working… this can take a minute.</div>`}
      ${view?.type === 'create_entry' && html`<div class="notice notice-ok"><${Ic} name="circle-check" size="sm" /> ${view.title} is set up. Its devices appear on this page in a moment.</div>`}
      ${view?.type === 'abort' && html`<div class="notice notice-warn">${view.reason}</div>`}
    </div>
  <//>`;
}

/** Picks an integration from Home Assistant's catalogue. */
export function CatalogueModal({ onClose, onPick }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.get('/api/home/integrations').then(setList, (err) => {
      toast(err.message, 'bad');
      onClose();
    });
  }, []);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list ?? []).filter((i) => !t || i.name.toLowerCase().includes(t) || i.domain.includes(t) || i.brand?.toLowerCase().includes(t)).slice(0, 80);
  }, [list, q]);
  const local = (c) => c?.startsWith('local');
  return html`<${Modal} open title="Add integration" onClose=${onClose}>
    <div class="dv-form">
      <label class="dv-search dv-search-wide"><${Ic} name="search" size="sm" />
        <input type="search" autofocus placeholder=${list ? `Search ${list.length} integrations, e.g. Shelly, Tuya, Hue` : 'Loading…'} value=${q} onInput=${(ev) => setQ(ev.target.value)} />
      </label>
      ${!list && html`<div class="loading">Loading…</div>`}
      <div class="dv-cat">
        ${shown.map((i) => html`<button class="dv-cat-item" onClick=${() => onPick(i)}>
          <span class="dv-cat-name">${i.name}${i.brand && i.brand.toLowerCase() !== i.name.toLowerCase() && html`<small class="muted"> · ${i.brand}</small>`}</span>
          ${i.iotClass && html`<${Badge} kind=${local(i.iotClass) ? 'ok' : 'muted'}>${local(i.iotClass) ? 'Local' : 'Cloud'}<//>`}
        </button>`)}
        ${list && shown.length === 0 && html`<p class="muted">No integration matches "${q}".</p>`}
      </div>
      ${list && html`<small class="muted">"Local" integrations talk to your devices directly and keep working without internet.</small>`}
    </div>
  <//>`;
}

/** Devices Home Assistant found on the network, waiting for confirmation. Rendered inside the "New devices" card. */
export function DiscoveredList({ items, onSetUp, onDismiss }) {
  return items.map((d) => html`<div class="list-item" key=${d.flowId}>
    <${IconChip} name="radar" tone="accent" small />
    <div class="list-main"><div class="list-title">${d.title}</div>
      <div class="list-sub">${d.name} · found ${SOURCES[d.source] ? `on the ${SOURCES[d.source]}` : `by ${d.source}`}</div></div>
    <${Button} small kind="ghost" onClick=${() => onDismiss(d)}>Dismiss<//>
    <${Button} small kind="primary" onClick=${() => onSetUp(d)}>Set up<//>
  </div>`);
}

/** Integrations configured in Home Assistant, with removal. */
export function IntegrationsCard({ entries, engine, onAdd, onChanged }) {
  const remove = async (e) => {
    if (!confirmAction(`Remove ${e.name} (${e.title})? Its devices are removed from Sunroost too.`)) return;
    try {
      await api.del(`/api/home/integrations/entries/${e.entryId}`);
      toast(`${e.name} removed`);
      onChanged();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return html`<${Card} class="dv-integrations" title="Integrations" subtitle=${engine === 'full' ? 'Brands and services connected through Home Assistant' : "Brands connected with Sunroost's built-in drivers"}
    actions=${html`<${Button} small kind="primary" onClick=${onAdd}><${Ic} name="plus" size="sm" />Add integration<//>`}>
    ${entries.length === 0
      ? html`<p class="muted small">None yet. Add one to connect devices that don't announce themselves.</p>`
      : html`<div class="list">${entries.map((e) => html`<div class="list-item" key=${e.entryId}>
          <${IconChip} name="blocks" small />
          <div class="list-main"><div class="list-title">${e.name}</div><div class="list-sub">${e.title}</div></div>
          ${e.state !== 'loaded' && html`<${Badge} kind="bad">${e.state.replace(/_/g, ' ')}<//>`}
          <button class="icon-btn" aria-label=${`Remove ${e.name}`} onClick=${() => remove(e)}><${Ic} name="trash-2" size="sm" /></button>
        </div>`)}</div>`}
  <//>`;
}

/** Restart, back up and update the Home Assistant Sunroost runs (full engine, connected). */
export function HomeAssistantManage() {
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    api.get('/api/home/full/version').then(setV, () => {});
  }, []);
  const act = async (what, path, body, confirmText) => {
    if (confirmText && !confirmAction(confirmText)) return;
    setBusy(what);
    try {
      const r = await api.post(path, body ?? {});
      toast(what === 'backup' ? `Backup "${r.name}" made` : r.message ?? 'Done');
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(null);
  };
  if (!v) return null;
  const newer = v.latest && v.current && v.latest !== v.current && v.latest.localeCompare(v.current, undefined, { numeric: true }) > 0;
  return html`<div class="dv-set-row">
    <div><b>Home Assistant ${v.current}</b><small class="muted">${newer ? `Version ${v.latest} is available.` : v.latest ? 'Up to date.' : 'Could not check for updates (offline?).'}${v.local ? ' Updating makes a backup first.' : ''}</small></div>
    <div class="dv-ha-btns">
      <${Button} small disabled=${!!busy} onClick=${() => act('backup', '/api/home/full/backup')}>${busy === 'backup' ? 'Backing up…' : 'Back up'}<//>
      <${Button} small disabled=${!!busy} onClick=${() => act('restart', '/api/home/full/restart', {}, 'Restart Home Assistant? Devices are unavailable for about a minute.')}>Restart<//>
      ${v.local && newer && html`<${Button} small kind="primary" disabled=${!!busy}
        onClick=${() => act('update', '/api/home/full/update', { version: v.latest }, `Update Home Assistant to ${v.latest}? A backup is made first; devices are unavailable for a few minutes.`)}>${busy === 'update' ? 'Updating…' : `Update to ${v.latest}`}<//>`}
      ${v.local && html`<${Button} small kind="ghost" disabled=${!!busy}
        onClick=${() => act('rollback', '/api/home/full/update', { version: 'rollback' }, 'Go back to the Home Assistant version used before the last update?')}>Roll back<//>`}
    </div>
  </div>`;
}

/** Status of the full engine plus linking a Home Assistant elsewhere on the network. */
export function HomeAssistantRow({ status, onChanged }) {
  const full = status.engines.find((e) => e.id === 'full');
  const info = full?.info;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(info && !info.local ? info.url : 'http://homeassistant.local:8123');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const canLocal = status.board.engine.full !== 'no';
  const link = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/home/full/link', { url, token });
      toast(`Linked to Home Assistant ${r.version}`);
      setOpen(false);
      setToken('');
      setTimeout(onChanged, 1500);
    } catch (err) {
      toast(err.message, 'bad');
    }
    setBusy(false);
  };
  const unlink = async () => {
    if (!confirmAction('Stop using this Home Assistant? Its devices become unavailable in Sunroost.')) return;
    await api.post('/api/home/full/unlink').then(() => setTimeout(onChanged, 1200), (err) => toast(err.message, 'bad'));
  };
  const text = !full?.running
    ? canLocal ? "Not running. Sunroost uses it as soon as it's reachable (sudo deploy/install.sh installs it)." : 'Not available on this board on its own. Link one running elsewhere to use every integration.'
    : info.state === 'connected' ? `Home Assistant ${info.version} ${info.local ? 'on this board' : `at ${info.url}`} · ${info.entities} entities`
    : info.message ?? 'Connecting…';
  return html`<div class="dv-set-row">
      <div><b>Home Assistant</b><small class=${full?.running && info.state !== 'connected' ? 'text-bad' : 'muted'}>${text}</small></div>
      ${full?.running && info && !info.local
        ? html`<${Button} small onClick=${unlink}>Unlink<//>`
        : html`<${Button} small onClick=${() => setOpen(!open)}>${open ? 'Close' : 'Link another'}<//>`}
    </div>
    ${(open || info?.state === 'setup') &&
    html`<div class="dv-link">
      <p class="muted small">Use a Home Assistant already running on your network: create a long-lived access token on its profile page (Security tab) and paste it here.</p>
      <div class="dv-link-row">
        <input value=${url} placeholder="http://homeassistant.local:8123" aria-label="Home Assistant address" onInput=${(ev) => setUrl(ev.target.value)} />
        <input type="password" value=${token} placeholder="Access token" aria-label="Access token" autocomplete="off" onInput=${(ev) => setToken(ev.target.value)} />
        <${Button} kind="primary" disabled=${busy || !url || token.length < 20} onClick=${link}>${busy ? 'Checking…' : 'Link'}<//>
      </div>
    </div>`}`;
}

export const integrationsCss = `
.dv-integrations { margin-bottom: 16px; }
.dv-cat { display: flex; flex-direction: column; max-height: 52vh; overflow-y: auto; border: 1px solid var(--border); border-radius: 12px; }
.dv-cat-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; border: 0; border-bottom: 1px solid var(--grid-line);
  background: none; text-align: left; font: inherit; color: var(--heading); cursor: pointer; }
.dv-cat-item:last-child { border-bottom: 0; }
.dv-cat-item:hover { background: var(--surface-2); }
.dv-cat-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-search-wide { max-width: none; }
.dv-flow-desc { margin: 0; color: var(--text); white-space: pre-wrap; line-height: 1.5; }
.dv-flow-help { font-weight: 400; }
.dv-flow-bool { flex-direction: column; align-items: flex-start; }
.dv-flow-section { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.dv-flow-section[open] { padding-bottom: 14px; }
.dv-flow-section summary { cursor: pointer; font-weight: 600; color: var(--heading); }
.dv-flow-section > .dv-field, .dv-flow-section > div { margin-top: 10px; }
.dv-flow-menu { display: flex; flex-direction: column; gap: 8px; }
.dv-flow-menu .btn { justify-content: space-between; width: 100%; }
.dv-ha-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.dv-link { padding: 4px 0 12px; border-bottom: 1px solid var(--grid-line); }
.dv-link p { margin: 0 0 8px; }
.dv-link-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; }
.dv-link-row input { max-width: none; }
@media (max-width: 640px) { .dv-link-row { grid-template-columns: 1fr; } }
`;
