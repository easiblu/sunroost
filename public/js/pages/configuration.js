// Configuration hub: status cards (devices, network, MQTT, remote access, storage, system) that
// link to their section or page, then the Devices form, General, Network, System and Tools cards.
// Also exports the helpers and the shared configuration styles/components used by the sub-pages.
import {
  api, appSettings, fmtTemp, html, live, saveSettings, useEffect, useMemo, useRef, useState, useStore,
} from '../lib/core.js';
import { Badge, DeviceStatus, Ic, IconChip, Page, Ring, Row, confirmAction, toast } from '../lib/ui.js';
import { AutoDetect, BrandPicker, EybondAdd, INVERTER_CSS, isNet, LuxDongleAdd, SolarmanFinder } from './config-inverter.js';

// ---------- Helpers shared by the configuration/status pages ----------

/** Injects page CSS once. */
export function injectCss(id, css) {
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

/**
 * Polls a JSON endpoint. Returns { data, error, missing, reload }. `missing` is true on 404,
 * for endpoints other modules may not have shipped yet.
 */
export function usePoll(url, ms = 5000) {
  const [state, setState] = useState({ data: null, error: null, missing: false, loading: true });
  const alive = useRef(true);
  const load = () =>
    api.get(url).then(
      (data) => alive.current && setState({ data, error: null, missing: false, loading: false }),
      (err) => alive.current && setState((s) => ({ ...s, error: err.message, missing: /not found/i.test(err.message), loading: false })),
    );
  useEffect(() => {
    alive.current = true;
    load();
    const t = ms ? setInterval(load, ms) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [url, ms]);
  return { ...state, reload: load };
}

export function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Disk sizes like `df -h`: 486G. */
export function fmtDf(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

/** "3% of 486G" for a { total, used } disk. */
export function diskUsage(total, used) {
  if (!total) return '-';
  return `${Math.round((used / total) * 100)}% of ${fmtDf(total)}`;
}

export function fmtDuration(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '–';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

/** Number of voltage dips since boot (0 when none or unknown). */
export function voltageDips(sys) {
  const uv = sys?.underVoltage;
  if (!uv) return 0;
  if (uv.count) return uv.count;
  return uv.throttled?.underVoltageNow || uv.throttled?.underVoltageOccurred ? 1 : 0;
}

/** Under-voltage banner text, or null. */
export function underVoltageText(sys) {
  const n = voltageDips(sys);
  if (!n) return null;
  return `Device experienced ${n} voltage dip${n === 1 ? '' : 's'} since boot. Use a 5 V / 3 A power supply: brown-outs make USB devices drop out.`;
}

/** Like ui.js Field but a <div>, for controls that contain their own labels/buttons (no nested <label>). */
export const FieldBox = ({ label, help, children }) => html`
  <div class="field">
    <span class="field-label">${label}</span>
    <span class="field-control">${children}${help && html`<small class="help">${help}</small>`}</span>
  </div>
`;

// ---------- Configuration building blocks (design-system cards and field rows) ----------

const CRUMBS = [['Configuration', '/configuration']];

/** A configuration sub-page: top-bar title with "Configuration" crumb, cards stacked. */
export const ConfigPage = ({ title, wide, children }) => html`<${Page} title=${title} crumbs=${CRUMBS}>
  <div class=${`cfg-page ${wide ? 'cfg-wide' : ''}`}>${children}</div>
<//>`;

/** Section card: icon chip + title + one-line description in the head, optional actions. */
export const Section = ({ id, icon, tone = '', title, desc, actions, class: cls = '', children }) => html`
  <section class=${`card cfg-sec ${cls}`} id=${id}>
    ${title &&
    html`<header class="cfg-head">
      ${icon && html`<${IconChip} name=${icon} tone=${tone} />`}
      <div class="cfg-head-text"><h2>${title}</h2>${desc && html`<p>${desc}</p>`}</div>
      ${actions && html`<div class="card-actions">${actions}</div>`}
    </header>`}
    ${children}
  </section>`;

/** Sub-heading inside a section card. */
export const Sub = ({ icon, children, extra }) => html`<h3 class="cfg-sub">${icon && html`<${Ic} name=${icon} size="sm" />`}<span>${children}</span>${extra && html`<span class="cfg-sub-extra">${extra}</span>`}</h3>`;

/** Value with an action pushed to the right (for read-only rows with "Edit"/"Change"). */
export const Val = ({ children, action }) => html`<span class="cfg-val"><span class="cfg-val-main">${children}</span>${action && html`<span class="cfg-val-act">${action}</span>`}</span>`;

/** Inline hint/note under a control. */
export const Hint = ({ children }) => html`<div class="cfg-hint">${children}</div>`;

/** Legacy wrapper (one big card); kept for pages that still use it. */
export const SaCard = ({ width = 800, wide, children }) =>
  html`<div class="page sa-page"><div class=${`sa-card ${wide ? 'sa-wide' : ''}`} style=${width ? `max-width:${width}px` : ''}>${children}</div></div>`;

export const Sec = ({ children, id, class: cls = '' }) => html`<div class=${`sa-sec ${cls}`} id=${id}>${children}</div>`;

/** Legacy "Configuration › Title" heading (the top bar shows crumbs now). */
export const Crumb = ({ title, extra }) => html`<h3 class="sa-crumb"><a href="/configuration">Configuration</a> › ${title}${extra}</h3>`;

const cleanLabel = (l) => (typeof l === 'string' ? l.replace(/:\s*$/, '') : l);

/** Form row: label left, control right (stacks on phones). */
export const F = ({ label, children, class: cls = '', htmlFor, help }) => html`
  <div class=${`field cfg-f ${cls}`}>
    <label class="field-label" for=${htmlFor}>${cleanLabel(label)}${help && html`<span class="hint">${help}</span>`}</label>
    <div class="cfg-fc">${children}</div>
  </div>
`;

export const Btns = ({ children }) => html`<div class="form-actions cfg-actions">${children}</div>`;

/** Inline text action ("Edit", "Change", "View detail"). */
export const ActionLink = ({ onClick, children }) =>
  html`<a href="#" class="cfg-link" onClick=${(e) => (e.preventDefault(), onClick())}>${children}</a>`;

/** "View detail" style link with a chevron. */
export const MoreLink = ({ href, children }) => html`<a href=${href} class="cfg-more">${children}<${Ic} name="chevron-right" size="sm" /></a>`;

// ---------- Reboot / shutdown / restart "perform" screen ----------

const PERFORM = {
  reboot: { title: 'is rebooting', icon: 'rotate-ccw', reconnect: true },
  shutdown: { title: 'is shutting down', icon: 'power', reconnect: false },
  'restart-app': { title: 'is restarting', icon: 'refresh-cw', reconnect: true },
};

/** Full-screen countdown (ring progress), then reconnect or "disconnect power". */
export function Perform({ action, seconds, name = 'Sunroost' }) {
  const a = PERFORM[action];
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left > 0 || !a.reconnect) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch('/api/auth/status', { cache: 'no-store' });
        if (r.ok) location.href = '/configuration';
      } catch {
        // Still down; keep trying.
      }
    }, 2000);
    return () => clearInterval(t);
  }, [left > 0]);
  const done = left <= 0;
  const what = action === 'restart-app' ? `${name} application` : `${name} device`;
  return html`<div class="cfg-perform" role="alertdialog" aria-live="polite">
    <div class="card cfg-perform-card">
      <${Ring} value=${done ? 100 : ((seconds - left) / seconds) * 100} size=${168} stroke=${12}
        color=${done && !a.reconnect ? 'var(--ok)' : 'var(--accent)'}
        label=${done ? html`<span class=${`cfg-perform-ic ${a.reconnect ? 'spin' : ''}`}><${Ic} name=${a.reconnect ? 'refresh-cw' : 'power'} /></span>` : left}
        sub=${done ? (a.reconnect ? 'Reconnecting' : 'Done') : 'seconds'} />
      <h2>${what} ${a.title}</h2>
      <p class="muted">
        ${!done
          ? a.reconnect ? 'Please wait, this page reconnects automatically.' : 'Please wait before disconnecting device power.'
          : a.reconnect ? 'Waiting for Sunroost to come back…' : 'It is now safe to unplug the board.'}
      </p>
    </div>
  </div>`;
}

const ASK = {
  reboot: 'Are you sure you want to reboot the device?',
  shutdown: 'Are you sure you want to shutdown the device?',
  'restart-app': 'Are you sure you want to restart the application?',
};

/** [performing, run(action)] for the Reboot / Shutdown / Restart buttons. */
export function usePowerAction() {
  const [performing, setPerforming] = useState(null);
  const run = async (action) => {
    if (!confirmAction(ASK[action])) return;
    try {
      const r = await api.post(`/api/system/${action}`, { confirm: true });
      setPerforming({ action, seconds: r.seconds ?? 15 });
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return [performing, run];
}

// ---------- General ----------

/** Place search (Open-Meteo geocoding via the server) that saves the site's coordinates. */
function LocationPicker({ s }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || q.trim().length < 2) return setRes(null);
    setRes('loading');
    const t = setTimeout(
      () => api.get(`/api/weather/places?q=${encodeURIComponent(q.trim())}`).then(setRes, (e) => setRes({ error: e.message })),
      400,
    );
    return () => clearTimeout(t);
  }, [q, open]);
  const save = async (values, msg) => {
    setBusy(true);
    try {
      await saveSettings(values);
      toast(msg);
      setOpen(false);
      setQ('');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const pick = (p) => save({ 'site.latitude': Number(p.latitude), 'site.longitude': Number(p.longitude), 'site.location_name': p.name }, `Location set to ${p.name}`);
  const clear = () => confirmAction('Clear the site location? The dashboard weather needs a location.') &&
    save({ 'site.latitude': null, 'site.longitude': null, 'site.location_name': '' }, 'Location cleared');
  const lat = s['site.latitude'];
  const lon = s['site.longitude'];
  const set = typeof lat === 'number' && typeof lon === 'number';
  const fmtC = (v, p, n) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? p : n}`;
  return html`<div class="cfg-loc">
    <${Val} action=${!open && html`
      <button type="button" class="btn btn-sm btn-ghost" onClick=${() => setOpen(true)}>${set ? 'Change' : 'Set location'}</button>
      ${set && html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${clear}>Clear</button>`}`}>
      ${set
        ? html`<span class="cfg-loc-now"><${Ic} name="map-pin" size="sm" /><span><b>${s['site.location_name'] || 'Custom location'}</b>
            <small class="muted">${fmtC(lat, 'N', 'S')}, ${fmtC(lon, 'E', 'W')}</small></span></span>`
        : html`<span class="muted">Not set</span>`}
    <//>
    ${open &&
    html`<div class="cfg-loc-search">
      <div class="cfg-search">
        <${Ic} name="search" size="sm" />
        <input type="search" placeholder="Search a city or town" aria-label="Search location" autofocus value=${q}
          onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === 'Escape' && setOpen(false)} />
        <button type="button" class="btn btn-sm" onClick=${() => (setOpen(false), setQ(''))}>Cancel</button>
      </div>
      ${res === 'loading' && html`<div class="cfg-loc-msg muted">Searching…</div>`}
      ${res?.error && html`<div class="cfg-loc-msg text-bad">${res.error}</div>`}
      ${Array.isArray(res) && res.length === 0 && html`<div class="cfg-loc-msg muted">No places found.</div>`}
      ${Array.isArray(res) && res.length > 0 &&
      html`<div class="cfg-loc-list" role="listbox">
        ${res.map((p) => html`<button type="button" class="cfg-loc-item" disabled=${busy} onClick=${() => pick(p)}>
          <${Ic} name="map-pin" size="sm" /><span class="list-main"><span class="list-title">${p.name}</span>
          <span class="list-sub">${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}</span></span>
        </button>`)}
      </div>`}
      ${res === null && html`<div class="cfg-loc-msg muted">Used for the weather forecast on the dashboard.</div>`}
    </div>`}
  </div>`;
}

function General({ s, remote }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const save = async (e) => {
    e.preventDefault();
    try {
      await saveSettings({ 'site.name': name.trim() || 'Sunroost' });
      setEditing(false);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return html`<${Section} id="general" icon="settings" tone="accent" title="General" desc="Site name, location, localization and access" class="cfg-o-general">
    ${editing
      ? html`<form onSubmit=${save}>
          <${F} label="Site name" htmlFor="site_name">
            <div class="cfg-inline">
              <input id="site_name" type="text" maxlength="60" autofocus value=${name} onInput=${(e) => setName(e.target.value)} />
              <button type="button" class="btn btn-sm" onClick=${() => setEditing(false)}>Cancel</button>
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
            </div>
          <//>
        </form>`
      : html`<${F} label="Site name">
          <${Val} action=${html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => (setName(s['site.name'] || ''), setEditing(true))}>Edit</button>`}><b>${s['site.name'] || 'Sunroost'}</b><//>
        <//>`}
    <${F} label="Location" help="For the dashboard weather"><${LocationPicker} s=${s} /><//>
    <${F} label="Localization">
      <${Val} action=${html`<a href="/configuration/system" class="btn btn-sm btn-ghost">Configure</a>`}>English · ${s.timezone} · ${s.temperature_unit}<//>
    <//>
    <${F} label="Local password">
      <${Val} action=${html`<a href="/configuration/system?password=true" class="btn btn-sm btn-ghost">Change</a>`}>
        ${s['auth.password_set'] ? html`<${Badge} kind="ok">Updated<//>` : html`<${Badge} kind="warn">Default<//>`}
      <//>
    <//>
    <${F} label="Remote access">
      <${Val} action=${html`<a href="/configuration/remote" class="btn btn-sm btn-ghost">Configure</a>`}>
        ${!remote
          ? html`<span class="muted">–</span>`
          : remote.mode === 'off'
            ? html`<span class="muted">Local network only</span>`
            : html`<a href=${remote.publicUrl} target="_blank" rel="noopener">${remote.domain}</a>`}
      <//>
    <//>
  <//>`;
}

// ---------- WiFi network ----------

/** ISO 3166 alpha-2 country codes for the WiFi regulatory domain. */
const COUNTRIES = [
  ['DZ', 'Algeria'], ['AR', 'Argentina'], ['AU', 'Australia'], ['AT', 'Austria'], ['BH', 'Bahrain'], ['BD', 'Bangladesh'],
  ['BE', 'Belgium'], ['BO', 'Bolivia'], ['BW', 'Botswana'], ['BR', 'Brazil'], ['BG', 'Bulgaria'], ['KH', 'Cambodia'],
  ['CM', 'Cameroon'], ['CA', 'Canada'], ['CL', 'Chile'], ['CN', 'China'], ['CO', 'Colombia'], ['CR', 'Costa Rica'],
  ['HR', 'Croatia'], ['CY', 'Cyprus'], ['CZ', 'Czech Republic'], ['DK', 'Denmark'], ['DO', 'Dominican Republic'],
  ['EC', 'Ecuador'], ['EG', 'Egypt'], ['SV', 'El Salvador'], ['EE', 'Estonia'], ['ET', 'Ethiopia'], ['FI', 'Finland'],
  ['FR', 'France'], ['DE', 'Germany'], ['GH', 'Ghana'], ['GR', 'Greece'], ['GT', 'Guatemala'], ['HN', 'Honduras'],
  ['HK', 'Hong Kong'], ['HU', 'Hungary'], ['IS', 'Iceland'], ['IN', 'India'], ['ID', 'Indonesia'], ['IE', 'Ireland'],
  ['IL', 'Israel'], ['IT', 'Italy'], ['JM', 'Jamaica'], ['JP', 'Japan'], ['JO', 'Jordan'], ['KZ', 'Kazakhstan'],
  ['KE', 'Kenya'], ['KW', 'Kuwait'], ['LV', 'Latvia'], ['LB', 'Lebanon'], ['LS', 'Lesotho'], ['LI', 'Liechtenstein'],
  ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MW', 'Malawi'], ['MY', 'Malaysia'], ['MT', 'Malta'], ['MU', 'Mauritius'],
  ['MX', 'Mexico'], ['MA', 'Morocco'], ['MZ', 'Mozambique'], ['NA', 'Namibia'], ['NL', 'Netherlands'], ['NZ', 'New Zealand'],
  ['NG', 'Nigeria'], ['NO', 'Norway'], ['OM', 'Oman'], ['PK', 'Pakistan'], ['PA', 'Panama'], ['PE', 'Peru'],
  ['PH', 'Philippines'], ['PL', 'Poland'], ['PT', 'Portugal'], ['PR', 'Puerto Rico'], ['QA', 'Qatar'], ['RO', 'Romania'],
  ['RW', 'Rwanda'], ['SA', 'Saudi Arabia'], ['RS', 'Serbia'], ['SG', 'Singapore'], ['SK', 'Slovakia'], ['SI', 'Slovenia'],
  ['ZA', 'South Africa'], ['KR', 'South Korea'], ['ES', 'Spain'], ['LK', 'Sri Lanka'], ['SZ', 'Eswatini'], ['SE', 'Sweden'],
  ['CH', 'Switzerland'], ['TW', 'Taiwan'], ['TZ', 'Tanzania'], ['TH', 'Thailand'], ['TT', 'Trinidad and Tobago'],
  ['TN', 'Tunisia'], ['TR', 'Turkey'], ['UG', 'Uganda'], ['UA', 'Ukraine'], ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'], ['US', 'United States'], ['UY', 'Uruguay'], ['VE', 'Venezuela'], ['VN', 'Vietnam'],
  ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
];

/** 1–6 rising signal bars: red at 1–2, orange at 3–4, green at 5–6; the rest dimmed. */
function SignalBars({ signal }) {
  if (typeof signal !== 'number') return null;
  const bars = signal <= 0 ? 0 : Math.max(1, Math.min(6, Math.ceil(signal / (100 / 6))));
  const color = bars <= 2 ? 'red' : bars <= 4 ? 'orange' : 'green';
  return html`<span class="cfg-signal" title=${`Signal ${signal}%`} aria-label=${`Signal ${bars} of 6`}>
    ${[1, 2, 3, 4, 5, 6].map((i) => html`<i class=${i <= bars ? color : ''} style=${`height:${3 + i * 2}px`}></i>`)}
  </span>`;
}

const OTHER = '';

function WifiConnectModal({ ssid, site, host, onClose }) {
  const [phase, setPhase] = useState('connecting');
  useEffect(() => {
    const t = setTimeout(() => setPhase('steps'), 3000);
    return () => clearTimeout(t);
  }, []);
  const kiosk = location.hostname === '127.0.0.1';
  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Next steps">
      <header class="modal-head"><h2>${phase === 'connecting' ? 'Connecting…' : 'Next steps'}</h2></header>
      <div class="modal-body">
        ${phase === 'connecting'
          ? html`<div class="cfg-connecting"><span class="cfg-perform-ic spin"><${Ic} name="wifi" size="lg" /></span><span class="muted">Connecting to ${ssid}…</span></div>`
          : html`<div class="cfg-appear">
              <div class="notice notice-info">
                <p>1) Connect to ${ssid} WiFi network.</p>
                ${!kiosk && html`<p style="margin:0">2) Open: <a href=${`http://${host}`}>http://${host}</a></p>`}
              </div>
              <p class="text-bad small" style="margin:0">If you still see a ${site} WiFi hotspot, then it was unable to connect to the WiFi network.</p>
            </div>`}
      </div>
      <footer class="modal-foot"><button type="button" class="btn" onClick=${onClose}>Close</button></footer>
    </div>
  </div>`;
}

const NET_STATUS = {
  connected: ['ok', 'Connected'],
  disconnected: ['warn', 'Disconnected'],
  'disconnected-hotspot': ['warn', 'Disconnected, Hotspot started'],
  hotspot: ['info', 'Hotspot'],
};

function Wifi({ s, net, reload }) {
  const [editing, setEditing] = useState(null); // null = decide from status
  const [networks, setNetworks] = useState([]);
  const [form, setForm] = useState({ selected: OTHER, ssid: '', password: '', country: 'US' });
  const [connecting, setConnecting] = useState(null);
  const [host, setHost] = useState(location.host);

  const supported = net?.supported;
  const edit = editing ?? (supported && !net?.ssid);
  useEffect(() => {
    if (!edit || !supported) return;
    setForm((f) => ({ ...f, country: net.country || 'US' }));
    api.get('/api/network/wifi/scan').then((r) => {
      setNetworks(r.networks ?? []);
      if (r.networks?.length) setForm((f) => ({ ...f, selected: f.selected || r.networks[0].ssid }));
    }, () => {});
  }, [edit, supported]);
  useEffect(() => {
    api.get('/api/system').then((sys) => setHost(`${sys.hostname.replace(/\.local$/, '')}.local${location.port ? `:${location.port}` : ''}`), () => {});
  }, []);

  const ssid = form.selected || form.ssid.trim();
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/network/wifi', { ssid, password: form.password, country: form.country });
      setConnecting(ssid);
      setEditing(false);
      setForm((f) => ({ ...f, password: '' }));
      setTimeout(reload, 5000);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const [kind, label] = NET_STATUS[net?.status] ?? ['muted', net?.status];
  return html`<${Section} id="network" icon="wifi" tone="load" title="Network" desc="WiFi connection and network interfaces" class="cfg-o-network"
    actions=${net && html`<${Badge} kind=${net.internet ? 'ok' : 'bad'}>Internet ${net.internet ? 'up' : 'down'}<//>`}>
    ${!net
      ? html`<div class="muted">Loading…</div>`
      : !supported
        ? html`<div class="cfg-unsupported"><${Ic} name="wifi-off" size="sm" />${net.reason || 'WiFi management is not supported on this OS.'}</div>`
        : edit
          ? html`<form onSubmit=${submit}>
              <${F} label="Country" htmlFor="country_code">
                <select id="country_code" value=${form.country} onChange=${(e) => setForm({ ...form, country: e.target.value })}>
                  ${COUNTRIES.map(([c, n]) => html`<option value=${c} selected=${c === form.country}>${n} (${c})</option>`)}
                </select>
              <//>
              ${networks.length > 0 &&
              html`<${F} label="Network" htmlFor="selected_ssid">
                <select id="selected_ssid" value=${form.selected} onChange=${(e) => setForm({ ...form, selected: e.target.value })}>
                  ${networks.map((n) => html`<option value=${n.ssid} selected=${n.ssid === form.selected}>${n.ssid} ${'▮'.repeat(Math.max(1, Math.ceil(n.signal / (100 / 6))))}</option>`)}
                  <option value=${OTHER} selected=${form.selected === OTHER}>Other network…</option>
                </select>
              <//>`}
              ${(networks.length === 0 || form.selected === OTHER) &&
              html`<${F} label="SSID" htmlFor="ssid"><input id="ssid" type="text" maxlength="32" value=${form.ssid} onInput=${(e) => setForm({ ...form, ssid: e.target.value })} /><//>`}
              <${F} label="Password" htmlFor="ssid_password">
                <input id="ssid_password" type="password" minlength="8" maxlength="64" autocomplete="new-password" value=${form.password}
                  onInput=${(e) => setForm({ ...form, password: e.target.value })} />
              <//>
              <${Btns}>
                <button type="button" class="btn" onClick=${() => setEditing(false)}>Cancel</button>
                <button type="submit" class="btn btn-primary" disabled=${!ssid}>Connect</button>
              <//>
            </form>`
          : html`
              <${F} label="WiFi network">
                <${Val} action=${html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setEditing(true)}>Edit</button>`}>
                  <b>${net.ssid || '–'}</b><${SignalBars} signal=${net.signal} />
                <//>
              <//>
              <${F} label="Status"><${Badge} kind=${kind}>${label}<//><//>
              ${net.hotspot?.active && html`<${F} label="Hotspot">${net.hotspot.ssid} · <a href=${`http://${net.hotspot.ip}`}>http://${net.hotspot.ip}</a><//>`}
              ${net.lastConnect?.ok === false && Date.now() - net.lastConnect.at < 10 * 60_000 &&
              html`<${F} label="Last attempt"><span class="text-bad">${net.lastConnect.message}</span><//>`}`}
    ${net &&
    html`<${Sub} icon="network">Interfaces<//>
      <div class="list">
        ${net.interfaces.map(
          (i) => html`<div class="list-item">
            <${IconChip} name=${/^w/.test(i.name) ? 'wifi' : 'ethernet-port'} tone=${i.up ? 'load' : ''} small />
            <div class="list-main">
              <div class="list-title">${i.name}</div>
              <div class="list-sub">${i.addresses.length
                ? i.addresses.map((a, n) => html`${n ? ' · ' : ''}<a href=${`http://${a}${location.port && location.port !== '80' ? `:${location.port}` : ''}`}>${a}</a>`)
                : 'No address'}</div>
            </div>
            <${Badge} kind=${i.up ? 'ok' : 'bad'}>${i.up ? 'Up' : 'Down'}<//>
          </div>`,
        )}
        ${net.interfaces.length === 0 && html`<div class="empty">No network interfaces found.</div>`}
      </div>`}
    ${connecting && html`<${WifiConnectModal} ssid=${connecting} site=${s['site.name'] || 'Sunroost'} host=${host} onClose=${() => setConnecting(null)} />`}
  <//>`;
}

// ---------- Inverter + Battery ----------

const pick = (s) => ({
  driver: s['inverter.driver_id'],
  model: s['inverter.model_id'],
  connections: s['inverter.connection_ids'] ?? [],
  address: s['inverter.modbus_address'] ?? 0,
  baud: s['inverter.baud_rate'] ?? 0,
  bms: s['bms.driver_id'],
  bmsModel: s['bms.model_id'],
  bmsConnections: s['bms.connection_ids'] ?? [],
  bmsBaud: s['bms.baud_rate'],
  capacity: s['bms.capacity'],
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BAUD_RATES = [2400, 4800, 9600, 19200, 38400, 57600, 115200];

/** Multi-select of serial ports ("* /dev/ttyUSB0"), keeping configured paths that aren't detected now. */
function PortSelect({ id, ports, value, onChange, multiple, disabled }) {
  const paths = [...new Set([...ports.map((p) => p.path), ...value])];
  if (!paths.length) return html`<span class="cfg-unsupported"><${Ic} name="unplug" size="sm" />Nothing plugged in.</span>`;
  const label = (p) => {
    const port = ports.find((x) => x.path === p);
    const extra = port ? port.label.split(' · ').slice(1).join(' · ') : 'not detected';
    return `${p}${extra ? ` (${extra})` : ''}`;
  };
  if (!multiple) {
    return html`<select id=${id} disabled=${disabled} onChange=${(e) => onChange(e.target.value ? [e.target.value] : [])}>
      <option value="" selected=${!value.length}></option>
      ${paths.map((p) => html`<option value=${p} selected=${value.includes(p)}>${label(p)}</option>`)}
    </select>`;
  }
  return html`<select id=${id} multiple disabled=${disabled} size=${Math.min(Math.max(paths.length, 2), 6)}
    onChange=${(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
    ${paths.map((p) => html`<option value=${p} selected=${value.includes(p)}>${label(p)}</option>`)}
  </select>`;
}

/** Editable list of network connections: Modbus TCP host:port, or solarman://ip/serial loggers. */
function HostList({ value, onChange, disabled }) {
  const [text, setText] = useState('');
  const valid = isNet(text.trim());
  const add = () => {
    if (!valid || value.includes(text.trim())) return;
    onChange([...value, text.trim()]);
    setText('');
  };
  return html`<div class="cfg-hosts">
    ${value.length > 0 &&
    html`<div class="cluster">${value.map((h) => html`<span class="cfg-host"><${Ic} name="network" size="sm" />${h}
      ${!disabled && html`<button type="button" aria-label=${`Remove ${h}`} onClick=${() => onChange(value.filter((x) => x !== h))}><${Ic} name="x" size="sm" /></button>`}</span>`)}</div>`}
    ${!disabled &&
    html`<div class="cfg-inline">
      <input type="text" placeholder="192.168.1.50:502" aria-label="Add host:port" value=${text} onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
      <button type="button" class="btn btn-sm" disabled=${!valid} onClick=${add}>Add</button>
    </div>`}
    ${disabled && value.length === 0 && html`<span class="muted">–</span>`}
  </div>`;
}

function Devices({ s, status, started: startedProp, onChanged }) {
  const [drivers, setDrivers] = useState(null);
  const [ports, setPorts] = useState([]);
  const [startedLocal, setStartedLocal] = useState(null);
  const [draft, setDraft] = useState(() => pick(s));
  const [busy, setBusy] = useState(false);
  const saved = useMemo(() => pick(s), [s]);
  const dirty = !same(draft, saved);
  const started = startedLocal ?? startedProp;

  useEffect(() => {
    injectCss('cfg-inverter-css', INVERTER_CSS);
    api.get('/api/devices/drivers').then(setDrivers, (e) => toast(e.message, 'bad'));
    const loadPorts = () => api.get('/api/devices/ports').then((p) => setPorts(p.filter((x) => x.path)), () => setPorts([]));
    loadPorts();
    const t = setInterval(loadPorts, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setStartedLocal(null), [startedProp]);
  useEffect(() => {
    if (!dirty) setDraft(pick(s));
  }, [s]);

  const inv = drivers?.inverters.find((d) => d.id === draft.driver);
  const bms = drivers?.batteries.find((d) => d.id === draft.bms);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const clash = draft.connections.some((c) => c && draft.bmsConnections.includes(c));
  const locked = Boolean(started);

  const save = async (e) => {
    e.preventDefault();
    if (clash) return;
    setBusy(true);
    try {
      await saveSettings({
        'inverter.driver_id': draft.driver,
        'inverter.model_id': draft.model ?? '',
        'inverter.connection_ids': draft.connections,
        'inverter.modbus_address': Number(draft.address) || 0,
        'inverter.baud_rate': Number(draft.baud) || 0,
        'bms.driver_id': draft.bms,
        'bms.model_id': draft.bmsModel ?? '',
        'bms.connection_ids': draft.bmsConnections,
        'bms.baud_rate': Number(draft.bmsBaud) || 0,
        'bms.capacity': Number(draft.capacity),
      });
      toast('Devices saved');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const connect = async (on) => {
    setBusy(true);
    try {
      const r = await api.post(on ? '/api/devices/start' : '/api/devices/stop');
      setStartedLocal(r.started);
      onChanged?.();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const head = {
    id: 'devices', icon: 'plug-zap', tone: 'accent', title: 'Devices', desc: 'Inverter and battery connection', class: 'cfg-o-devices',
    actions: started === null || started === undefined ? null : started ? html`<${Badge} kind="ok">Connected<//>` : html`<${Badge} kind="muted">Disconnected<//>`,
  };
  if (!drivers) return html`<${Section} ...${head}><div class="muted">Loading…</div><//>`;
  const simCount = Math.max(1, draft.connections.length);
  const bmsLabel = (d) => (d.id === 'inverter' ? 'Use inverter values' : d.name);
  return html`<${Section} ...${head}>
    ${locked && html`<div class="notice notice-info cfg-lock"><${Ic} name="lock" size="sm" />Disconnect to change the devices below.</div>`}
    <form onSubmit=${save}>
      <${Sub} icon="cpu" extra=${started && html`<span class="cluster"><${DeviceStatus} status=${status?.inverter} />
        ${status?.inverter?.name === 'connected' && html`<a href="/inverter/settings" class="cfg-link">Settings</a>`}</span>`}>Inverter<//>
      <${F} label="Brand" help="Find your inverter by brand and series">
        <${BrandPicker} driver=${draft.driver} model=${draft.model} disabled=${locked}
          onPick=${(p) => set(p.driver === draft.driver ? { model: p.model } : { driver: p.driver, model: p.model, connections: [], address: 0, baud: 0 })} />
      <//>
      <${F} label="Driver" htmlFor="inverter_driver_id">
        <select id="inverter_driver_id" disabled=${locked}
          onChange=${(e) => {
            const d = drivers.inverters.find((x) => x.id === e.target.value);
            set({ driver: e.target.value, model: d?.models?.[0]?.id ?? '', connections: [], address: 0, baud: 0 });
          }}>
          <option value="" selected=${!draft.driver}></option>
          ${drivers.inverters.map((d) => html`<option value=${d.id} selected=${d.id === draft.driver}>${d.name}</option>`)}
        </select>
      <//>
      ${inv?.models?.length > 0 &&
      html`<${F} label="Model" htmlFor="inverter_model_id">
        <select id="inverter_model_id" disabled=${locked} onChange=${(e) => set({ model: e.target.value })}>
          ${inv.models.map((m) => html`<option value=${m.id} selected=${m.id === (draft.model || inv.models[0].id)}>${m.name}</option>`)}
        </select>
      <//>`}
      ${inv && (inv.readOnly || inv.readOnlyModels.includes(draft.model || inv.models?.[0]?.id)) &&
      html`<div class="notice notice-info cfg-err"><${Ic} name="eye" size="sm" /> Read-only: readings work, but settings can't be changed from Sunroost until this model has been verified on real hardware.</div>`}
      ${(!inv || inv.transport === 'serial') &&
      html`<${F} label="USB ports" htmlFor="inverter_connection_ids">
          <${PortSelect} id="inverter_connection_ids" multiple ports=${ports} disabled=${locked}
            value=${draft.connections.filter((c) => !isNet(c))}
            onChange=${(v) => set({ connections: [...v, ...draft.connections.filter(isNet)] })} />
          ${ports.length > 1 && html`<${Hint}>More than one connection can be selected.<//>`}
        <//>
        <${F} label="Network" help="Modbus TCP host:port, or a Solarman WiFi logger">
          <${HostList} disabled=${locked} value=${draft.connections.filter(isNet)}
            onChange=${(v) => set({ connections: [...draft.connections.filter((c) => !isNet(c)), ...v] })} />
          <${SolarmanFinder} disabled=${locked} value=${draft.connections}
            onAdd=${(c) => set({ connections: [...draft.connections, c] })} />
          ${draft.driver === 'goodwe' && html`<span class="cfg-hint">GoodWe WiFi/LAN dongle: add <code>goodwe://</code> and its IP, e.g. goodwe://192.168.1.50 (UDP 8899).</span>`}
          ${['sumry', 'srne', 'voltronic', 'must'].includes(draft.driver) &&
          html`<${EybondAdd} disabled=${locked} value=${draft.connections} onAdd=${(c) => set({ connections: [...draft.connections, c] })} />`}
          ${draft.driver === 'luxpower' && html`<${LuxDongleAdd} disabled=${locked} onAdd=${(c) => set({ connections: [...draft.connections, c] })} />`}
        <//>`}
      ${(!inv || inv.transport !== 'none') &&
      html`<${F} label="Auto-detect" help="Probe the first connection (read-only)">
        <${AutoDetect} disabled=${locked} connections=${draft.connections}
          onUse=${(p) => {
            const d = drivers.inverters.find((x) => x.id === p.driver);
            // Keep 0 (= driver default) unless the probe answered at another rate.
            set({ driver: p.driver, model: p.model || (d?.models?.[0]?.id ?? ''), address: p.address, baud: p.baud && p.baud !== d?.defaultBaudRate ? p.baud : 0 });
          }} />
      <//>`}
      ${inv?.transport === 'tcp' &&
      html`<${F} label="Connections" help="host:port"><${HostList} disabled=${locked} value=${draft.connections} onChange=${(v) => set({ connections: v })} /><//>`}
      ${inv?.transport === 'none' &&
      html`<${F} label="Inverters" htmlFor="sim_count">
        <input id="sim_count" type="number" min="1" max="6" disabled=${locked} value=${simCount} style="max-width:120px"
          onInput=${(e) => {
            const n = Math.max(1, Math.min(6, Number(e.target.value) || 1));
            set({ connections: n > 1 ? Array.from({ length: n }, (_, i) => `sim${i + 1}`) : [] });
          }} />
      <//>`}

      <${Sub} icon="battery-charging" extra=${started && draft.bms !== 'inverter' && html`<${DeviceStatus} status=${status?.battery} />`}>Battery<//>
      <${F} label="Battery" htmlFor="bms_driver_id">
        <select id="bms_driver_id" disabled=${locked}
          onChange=${(e) => {
            const d = drivers.batteries.find((x) => x.id === e.target.value);
            set({ bms: e.target.value, bmsModel: d?.models?.[0]?.id ?? '', bmsConnections: [], bmsBaud: 0 });
          }}>
          ${drivers.batteries.map((d) => html`<option value=${d.id} selected=${d.id === draft.bms}>${bmsLabel(d)}</option>`)}
        </select>
      <//>
      ${bms?.models?.length > 0 &&
      html`<${F} label="Model" htmlFor="bms_model_id">
        <select id="bms_model_id" disabled=${locked} onChange=${(e) => set({ bmsModel: e.target.value })}>
          ${bms.models.map((m) => html`<option value=${m.id} selected=${m.id === (draft.bmsModel || bms.models[0].id)}>${m.name}</option>`)}
        </select>
      <//>`}
      ${bms?.transport === 'serial' &&
      html`<${F} label=${bms.multiConnection ? 'USB ports' : 'USB port'} htmlFor="bms_connection_ids">
          <${PortSelect} id="bms_connection_ids" multiple=${bms.multiConnection} ports=${ports} disabled=${locked}
            value=${draft.bmsConnections} onChange=${(v) => set({ bmsConnections: v })} />
          ${bms.multiConnection && ports.length > 1 && html`<${Hint}>More than one USB port can be selected.<//>`}
        <//>
        <${F} label="Baud rate" htmlFor="bms_baud_rate">
          <select id="bms_baud_rate" disabled=${locked} onChange=${(e) => set({ bmsBaud: Number(e.target.value) })}>
            <option value="0" selected=${!draft.bmsBaud}>Default${bms.defaultBaudRate ? ` (${bms.defaultBaudRate})` : ''}</option>
            ${[...new Set([...BAUD_RATES, draft.bmsBaud].filter(Boolean))].sort((a, b) => a - b).map((b) => html`<option value=${b} selected=${b === draft.bmsBaud}>${b}</option>`)}
          </select>
        <//>`}
      ${draft.bms === 'emulated' &&
      html`<${F} label="Capacity" htmlFor="bms_capacity">
        <span class="input-unit"><input id="bms_capacity" type="number" min="0.1" max="100000" step=".1" disabled=${locked} value=${draft.capacity}
          onInput=${(e) => set({ capacity: Number(e.target.value) })} /><span class="muted">kWh</span></span>
      <//>`}
      ${clash && html`<div class="notice notice-bad cfg-err">The inverter and the battery can't share a USB port.</div>`}
      <${Btns}>
        ${dirty
          ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => setDraft(saved)}>Cancel</button>
              <button type="submit" class="btn btn-primary" disabled=${busy || clash}>Save</button>`
          : html`<a href="/configuration/advanced" class="btn"><${Ic} name="sliders-horizontal" size="sm" />Advanced</a>
              ${started
                ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => connect(false)}><${Ic} name="unplug" size="sm" />Disconnect</button>`
                : draft.driver && html`<button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => connect(true)}><${Ic} name="plug" size="sm" />Connect</button>`}`}
      <//>
    </form>
  <//>`;
}

// ---------- System summary ----------

/** "Raspberry Pi 4 Model B" + os codename → "2.0.0 (bookworm)". */
const codename = (osText) => osText?.match(/\(([^)]+)\)\s*$/)?.[1] ?? null;

export function fmtShortTime(ts, tz) {
  try {
    const d = new Date(ts);
    const day = d.toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
    const time = d.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    return `${day}, ${time}`;
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/** Services: Web always, then Bluetooth / Kiosk / SSH when enabled. */
export function servicesList(access) {
  const list = ['Web'];
  if (access?.bluetooth?.supported && access.bluetooth.mode && access.bluetooth.mode !== 'disabled') list.push('Bluetooth');
  if (access?.hdmi?.mode === 'kiosk') list.push('Kiosk');
  if (access?.ssh?.supported && access.ssh.mode && access.ssh.mode !== 'disabled') list.push('SSH');
  return list.join(', ');
}

function SystemSummary({ s, sys, access, onPower }) {
  const dips = voltageDips(sys);
  const v = (x) => (sys ? x() : '–');
  return html`<${Section} id="system" icon="monitor-cog" tone="grid" title="System" desc="Device, software and power" class="cfg-o-system"
    actions=${html`<a href="/configuration/system" class="btn btn-sm">Configure</a>`}>
    ${dips > 0 &&
    html`<div class="notice notice-bad">
      <p><strong>Device experienced ${dips} voltage dip${dips === 1 ? '' : 's'} since boot.</strong></p>
      <p>Use a 5 V / 3 A power supply.</p>
      <p style="margin:0">Brown-outs make USB devices drop out, which interrupts the inverter and battery links.</p>
    </div>`}
    <${Row} label="Localization">English, ${s.timezone}<//>
    <${Row} label="Time">${v(() => fmtShortTime(sys.time, s.timezone))}${access?.time?.internetTime === false ? ' (manual)' : ''}<//>
    <${Row} label="Services">${servicesList(access)}<//>
    <${Row} label="CPU temperature">${v(() => (sys.cpuTemp === null ? '–' : fmtTemp(sys.cpuTemp)))}<//>
    <${Row} label="USB devices">${v(() => html`${sys.usbDevices.length} <a href="/system/kernel" class="cfg-link">View detail</a>`)}<//>
    <${Row} label="Storage">${v(() => html`${sys.disk ? diskUsage(sys.disk.total, sys.disk.used) : '–'} <a href="/configuration/storage" class="cfg-link">View detail</a>`)}<//>
    <${Row} label="Device board">${v(() => sys.board || 'Unknown')}<//>
    <${Row} label="Software version">${v(() => `${sys.version}${codename(sys.os) ? ` (${codename(sys.os)})` : ''}`)}<//>
    <${Btns}>
      <button type="button" class="btn btn-danger" onClick=${() => onPower('reboot')}><${Ic} name="rotate-ccw" size="sm" />Reboot</button>
      <button type="button" class="btn btn-danger" onClick=${() => onPower('shutdown')}><${Ic} name="power" size="sm" />Shutdown</button>
    <//>
  <//>`;
}

// ---------- MQTT start/stop ----------

function useMqttToggle() {
  const [busy, setBusy] = useState(false);
  const toggle = async (on) => {
    if (!confirmAction(on ? 'Start the MQTT broker?' : 'Stop the MQTT broker? Home Assistant and other clients lose their data feed.')) return;
    setBusy(true);
    try {
      await api.post(on ? '/api/mqtt/start' : '/api/mqtt/stop');
      await saveSettings({});
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return [busy, toggle];
}

/** Links to the tool and diagnostic pages. */
const TOOLS = [
  ['/inverter/settings', 'sliders-horizontal', 'Inverter settings'],
  ['/inverter/console', 'terminal', 'Inverter console'],
  ['/modbus/console', 'binary', 'Modbus console'],
  ['/battery/serial/console', 'battery-charging', 'Battery serial console'],
  ['/diagnostic/serial/test', 'activity', 'Serial test'],
  ['/diagnostic/serial/inspect', 'scan-search', 'Serial inspect'],
  ['/diagnostic/broker', 'radio-tower', 'Brokers'],
  ['/tools/logs', 'scroll-text', 'Logs'],
  ['/system/kernel', 'usb', 'USB devices & kernel log'],
];

function Tools() {
  return html`<${Section} id="tools" icon="wrench" title="Tools & diagnostics" desc="Consoles, serial diagnostics and logs" class="cfg-o-tools">
    <div class="cfg-tools">
      ${TOOLS.map(([href, icon, label]) => html`<a href=${href} class="cfg-tool"><${Ic} name=${icon} size="sm" /><span>${label}</span><${Ic} name="chevron-right" size="sm" class="cfg-tool-go" /></a>`)}
    </div>
  <//>`;
}

// ---------- Status cards ----------

function StatCard({ icon, tone, title, badge, value, sub, href, more = 'Configure', action, children, wide }) {
  return html`<div class=${`card cfg-stat ${wide ? 'wide' : ''}`}>
    <div class="cfg-stat-head">
      <${IconChip} name=${icon} tone=${tone} />
      <h2><a href=${href}>${title}</a></h2>
      ${badge}
    </div>
    ${children ?? html`<div class="cfg-stat-body"><b class="cfg-stat-value">${value}</b>${sub && html`<span class="cfg-stat-sub">${sub}</span>`}</div>`}
    <div class="cfg-stat-foot"><${MoreLink} href=${href}>${more}<//>${action}</div>
  </div>`;
}

const Dot = ({ kind }) => html`<i class=${`cfg-dot ${kind}`}></i>`;

function StatusCards({ s, dev, status, net, remote, sys }) {
  const [mqttBusy, mqttToggle] = useMqttToggle();
  const started = dev?.started;
  const st = status ?? dev?.status;
  const mqttOn = Boolean(s.publish_mqtt);
  const external = s['mqtt.broker'] === 'external';
  const wifi = net?.supported && net.ssid;
  const addr = net?.interfaces?.find((i) => i.up && i.addresses.length)?.addresses[0];
  const pct = sys?.disk?.total ? Math.round((sys.disk.used / sys.disk.total) * 100) : null;
  const remoteLabel = { domain: 'Own domain', cloudflare: 'Cloudflare Tunnel', proxy: 'Reverse proxy' }[remote?.mode];
  return html`<div class="cfg-stats">
    <${StatCard} icon="plug-zap" tone="accent" title="Devices" href="#devices"
      badge=${started === undefined ? null : started ? html`<${Badge} kind="ok">Connected<//>` : html`<${Badge} kind="muted">Disconnected<//>`}
      more="Devices" action=${html`<${MoreLink} href="/configuration/advanced">Advanced<//>`}>
      <div class="list cfg-stat-body">
        <div class="list-item">
          <${IconChip} name="cpu" tone="solar" small />
          <div class="list-main"><div class="list-title">Inverter</div><div class="list-sub">${dev?.driver || s['inverter.driver_id'] || 'Not configured'}</div></div>
          ${started && st?.inverter ? html`<${DeviceStatus} status=${st.inverter} />` : html`<${Badge}>Off<//>`}
        </div>
        <div class="list-item">
          <${IconChip} name="battery-charging" tone="battery" small />
          <div class="list-main"><div class="list-title">Battery</div><div class="list-sub">${s['bms.driver_id'] === 'inverter' ? 'Values from inverter' : s['bms.driver_id']}</div></div>
          ${started && st?.battery && s['bms.driver_id'] !== 'inverter' ? html`<${DeviceStatus} status=${st.battery} />` : html`<${Badge}>${s['bms.driver_id'] === 'inverter' ? 'Inverter' : 'Off'}<//>`}
        </div>
      </div>
    <//>
    <${StatCard} icon="wifi" tone="load" title="Network" href="#network"
      value=${!net ? '–' : wifi ? html`${net.ssid}<${SignalBars} signal=${net.signal} />` : addr ?? 'No address'}
      sub=${net && html`<${Dot} kind=${net.internet ? 'ok' : 'bad'} />Internet ${net.internet ? 'up' : 'down'}${wifi ? '' : addr ? ' · wired/local' : ''}`} />
    <${StatCard} icon="radio-tower" tone="grid" title="MQTT" href="/configuration/mqtt"
      value=${html`<${Dot} kind=${mqttOn ? 'ok' : 'muted'} />${mqttOn ? 'Running' : 'Stopped'}`}
      sub=${external ? s['mqtt.url'] || 'External broker' : `Built-in broker · port ${s['mqtt.port']}`}
      action=${mqttOn
        ? html`<button type="button" class="btn btn-sm btn-danger" disabled=${mqttBusy} onClick=${() => mqttToggle(false)}>Stop</button>`
        : html`<button type="button" class="btn btn-sm btn-ok" disabled=${mqttBusy} onClick=${() => mqttToggle(true)}>Start</button>`} />
    <${StatCard} icon="globe" tone="load" title="Remote access" href="/configuration/remote"
      value=${!remote ? '–' : remote.mode === 'off' ? 'Local network only' : remote.domain || remoteLabel}
      sub=${remote && (remote.mode === 'off' ? html`<${Dot} kind="muted" />Off` : html`<${Dot} kind=${remote.running || remote.mode === 'proxy' || remote.domainMode?.active ? 'ok' : 'warn'} />${remoteLabel}`)} />
    <${StatCard} icon="database" tone="battery" title="Storage" href="/configuration/storage" more="Details"
      value=${pct === null ? '–' : `${pct}% used`}
      sub=${pct !== null && html`<span class="cfg-bar"><i style=${`width:${pct}%`} class=${pct > 90 ? 'bad' : ''}></i></span><span>of ${fmtDf(sys.disk.total)}</span>`} />
    <${StatCard} wide icon="monitor-cog" tone="grid" title="System" href="/configuration/system"
      value=${sys ? `Version ${sys.version}` : '–'}
      sub=${sys && html`${voltageDips(sys) > 0 ? html`<${Dot} kind="bad" />Voltage dips · ` : ''}${sys.board || 'Unknown board'}${sys.cpuTemp != null ? ` · ${fmtTemp(sys.cpuTemp)}` : ''}`} />
  </div>`;
}

// ---------- Page ----------

export default function Configuration() {
  const s = useStore(appSettings);
  const [performing, power] = usePowerAction();
  const status = useStore(liveStatus);
  const dev = usePoll('/api/devices/status', 5000);
  const net = usePoll('/api/network', 10000);
  const remote = usePoll('/api/remote', 30000);
  const sys = usePoll('/api/system', 15000);
  const access = usePoll('/api/system/access', 60000);
  if (performing) return html`<${Perform} ...${performing} name=${s?.['site.name'] || 'Sunroost'} />`;
  if (!s) return html`<${Page} title="Configuration"><div class="loading">Loading…</div><//>`;
  return html`<${Page} title="Configuration">
    <${StatusCards} s=${s} dev=${dev.data} status=${status} net=${net.data} remote=${remote.data} sys=${sys.data} />
    <div class="cfg-cols">
      <div class="cfg-stack">
        <${Devices} s=${s} status=${status} started=${dev.data?.started} onChanged=${dev.reload} />
        <${SystemSummary} s=${s} sys=${sys.data} access=${access.data} onPower=${power} />
      </div>
      <div class="cfg-stack">
        <${General} s=${s} remote=${remote.data} />
        <${Wifi} s=${s} net=${net.data} reload=${net.reload} />
        <${Tools} />
      </div>
    </div>
  <//>`;
}

// Device status from the live snapshot, as a tiny derived store.
const liveStatus = {
  get: () => live.get()?.status ?? null,
  subscribe: (fn) => live.subscribe((v) => fn(v?.status ?? null)),
};

injectCss('css-cfg', `
/* ----- Configuration hub ----- */
.cfg-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.cfg-stat { display: flex; flex-direction: column; gap: 12px; padding: 18px; min-width: 0; }
.cfg-stat-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.cfg-stat-head h2 { flex: 1; min-width: 0; font-size: 14.5px; }
.cfg-stat-head h2 a { color: inherit; }
.cfg-stat-body { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cfg-stat-value { font-size: 17px; font-weight: 700; color: var(--heading); letter-spacing: -0.01em; display: flex; align-items: center; gap: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cfg-stat-sub { font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cfg-stat .list.cfg-stat-body { gap: 0; }
.cfg-stat .list-item { padding: 7px 0; }
.cfg-stat-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-top: 1px solid var(--grid-line); padding-top: 10px; margin-top: auto; }
.cfg-more { display: inline-flex; align-items: center; gap: 2px; font-size: 13px; font-weight: 600; color: var(--accent-text); }
.cfg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; margin-right: 6px; }
.cfg-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.cfg-dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.cfg-dot.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.cfg-stat-sub .cfg-dot { margin-right: 0; }
.cfg-bar { flex: 1; max-width: 120px; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
.cfg-bar i { display: block; height: 100%; border-radius: 3px; background: var(--battery); }
.cfg-bar i.bad { background: var(--bad); }
@media (max-width: 1100px) { .cfg-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) {
  .cfg-stats { gap: 12px; }
  .cfg-stat:first-child, .cfg-stat.wide { grid-column: span 2; }
  .cfg-stat { padding: 14px; gap: 10px; }
  .cfg-stat:not(.wide) .chip-ic { width: 32px; height: 32px; border-radius: 10px; }
  .cfg-stat-value { font-size: 15px; }
  .cfg-stat:not(.wide) .cfg-stat-foot .btn { padding: 0 8px; }
}
.cfg-cols { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.cfg-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@media (max-width: 1200px) {
  .cfg-cols { display: flex; flex-direction: column; }
  .cfg-cols > .cfg-stack { display: contents; }
  .cfg-o-devices { order: 1; } .cfg-o-general { order: 2; } .cfg-o-network { order: 3; } .cfg-o-system { order: 4; } .cfg-o-tools { order: 5; }
}
.cfg-tools { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.cfg-tool { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); color: var(--text); font-weight: 550; font-size: 13px; min-width: 0; }
.cfg-tool span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cfg-tool .ic { color: var(--muted); }
.cfg-tool:hover { background: var(--accent-soft); color: var(--accent-text); text-decoration: none; }
.cfg-tool:hover .ic { color: var(--accent); }
@media (max-width: 560px) { .cfg-tools { grid-template-columns: 1fr; } }

/* .chip-ic.grid also matches the layout class .grid; undo its grid template. */
.chip-ic.grid { grid-template-columns: none; gap: 0; align-items: center; }

/* ----- Section cards, field rows (shared by the sub-pages) ----- */
.cfg-page { display: flex; flex-direction: column; gap: 16px; max-width: 920px; }
.cfg-page.cfg-wide { max-width: none; }
.cfg-sec { scroll-margin-top: 84px; min-width: 0; }
.cfg-head { display: flex; align-items: center; gap: 10px 14px; margin-bottom: 12px; flex-wrap: wrap; }
.cfg-head-text { flex: 1 1 160px; min-width: 0; }
.cfg-head .card-actions { margin-left: auto; }
.cfg-head h2 { font-size: 15.5px; }
.cfg-head p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.cfg-sub { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  margin: 18px 0 2px; padding-top: 16px; border-top: 1px solid var(--border); }
.cfg-sub > span:first-of-type { flex: 1; }
.cfg-sub-extra { text-transform: none; letter-spacing: 0; font-size: 13px; font-weight: 500; }
.cfg-head + .cfg-sub, .cfg-head + form > .cfg-sub:first-child, .cfg-sec > .cfg-sub:first-child, form > .cfg-sub:first-child,
.cfg-lock + form > .cfg-sub:first-child { margin-top: 10px; padding-top: 0; border-top: 0; }
.cfg-f { padding: 10px 0; }
.cfg-f + .cfg-f { border-top: 1px solid var(--grid-line); }
.cfg-f.sa-top { align-items: start; }
.cfg-f > .field-label { color: var(--text); font-weight: 550; }
.cfg-f > .field-label .hint { margin-top: 1px; }
.cfg-fc { min-width: 0; overflow-wrap: anywhere; }
.cfg-fc > * + .cfg-hint, .cfg-fc > * + .notice { margin-top: 6px; }
.cfg-fc .notice { margin-bottom: 0; }
.cfg-hint { font-size: 12px; color: var(--muted); }
.cfg-val { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px; flex-wrap: wrap; }
.cfg-val-main { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.cfg-val-act { display: inline-flex; gap: 6px; margin-left: auto; }
.cfg-fc .input-unit input { width: 130px; flex: none; }
.cfg-fc .input-unit > span { white-space: nowrap; }
.cfg-sec > .cfg-hint { margin-top: 8px; }
.cfg-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cfg-inline input { flex: 1 1 180px; }
.cfg-actions { margin-top: 14px; }
.cfg-actions .btn .ic { margin-left: -2px; }
.cfg-link { font-weight: 600; font-size: 13px; }
.cfg-lock { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 10px 14px; }
.cfg-err { margin: 12px 0 0; padding: 10px 14px; }
.cfg-unsupported { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); }
.cfg-signal { display: inline-flex; align-items: flex-end; gap: 2px; margin: 0 6px; height: 15px; }
.cfg-signal i { width: 4px; border-radius: 1.5px; background: var(--surface-3); }
.cfg-signal i.red { background: var(--bad); }
.cfg-signal i.orange { background: var(--warn); }
.cfg-signal i.green { background: var(--ok); }
.cfg-hosts { display: flex; flex-direction: column; gap: 8px; }
.cfg-host { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border);
  font-family: var(--mono); font-size: 12.5px; }
.cfg-host .ic { color: var(--muted); }
.cfg-host button { border: 0; background: none; color: var(--muted); cursor: pointer; display: grid; place-items: center; padding: 2px; border-radius: 50%; }
.cfg-host button:hover { background: var(--bad-soft); color: var(--bad); }
.cfg-loc-now { display: inline-flex; align-items: flex-start; gap: 8px; }
.cfg-loc-now .ic { color: var(--accent); margin-top: 2px; }
.cfg-loc-now > span { display: flex; flex-direction: column; line-height: 1.35; }
.cfg-loc-now small { font-size: 12px; font-variant-numeric: tabular-nums; }
.cfg-loc-search { margin-top: 10px; }
.cfg-search { display: flex; align-items: center; gap: 8px; position: relative; }
.cfg-search > .ic { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
.cfg-search input { padding-left: 36px; max-width: none; flex: 1; }
.cfg-loc-list { margin-top: 8px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; max-height: 280px; overflow-y: auto; }
.cfg-loc-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border: 0; border-bottom: 1px solid var(--grid-line); background: var(--surface);
  font: inherit; text-align: left; cursor: pointer; color: var(--text); }
.cfg-loc-item:last-child { border-bottom: 0; }
.cfg-loc-item:hover, .cfg-loc-item:focus-visible { background: var(--accent-soft); }
.cfg-loc-item > .ic { color: var(--muted); }
.cfg-loc-item .list-main { display: flex; flex-direction: column; }
.cfg-loc-msg { font-size: 12.5px; padding: 8px 2px 0; }
.cfg-sec .empty .ic { display: block; margin: 0 auto 8px; width: 22px; height: 22px; }
.cfg-pre { margin: 0; background: var(--surface-2); border-radius: 12px; padding: 12px 14px; overflow: auto; max-height: 360px; font-size: 12px; line-height: 1.55; }
.cfg-sec .log { font-size: 12px; }
.cfg-connecting { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0; color: var(--accent); }
.cfg-appear { animation: cfg-in .6s ease; }
@keyframes cfg-in { from { opacity: 0; } to { opacity: 1; } }

/* ----- Countdown screen ----- */
.cfg-perform { position: fixed; inset: 0; z-index: 300; background: var(--canvas); overflow: auto; display: grid; place-items: center; padding: 16px; }
.cfg-perform-card { width: min(440px, 100%); text-align: center; padding: 36px 28px 30px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.cfg-perform-card h2 { font-size: 19px; margin-top: 6px; }
.cfg-perform-card p { margin: 0; }
.cfg-perform-card .ring-center b { font-size: 40px; }
.cfg-perform-ic { display: inline-grid; place-items: center; color: var(--accent); }
.cfg-perform-ic .ic { width: 34px; height: 34px; }
.cfg-perform-ic.spin { animation: cfg-spin 1.4s linear infinite; }
@keyframes cfg-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cfg-perform-ic.spin { animation: none; } }

/* ----- Status text helpers (legacy names) ----- */
.positive { color: var(--ok-text); }
.negative { color: var(--bad); }
.caution { color: #a86f00; }
.forward { color: var(--info); }
.grey { color: var(--muted); }
.sa-small { font-size: 12.5px; }
.sa-hint { font-size: 12px; color: var(--muted); }
.sa-error { margin: 10px 0 0; text-align: right; }
a.btn { color: var(--text); text-decoration: none; }
a.btn-primary { color: #fff; }
a.btn-ghost { color: var(--accent-text); }

/* ----- Legacy one-card layout (pages not yet migrated) ----- */
.sa-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); margin-bottom: 16px; min-width: 0; }
.sa-sec { padding: 22px; min-width: 0; }
.sa-sec + .sa-sec { border-top: 1px solid var(--border); }
.sa-sec h3 { font-size: 15.5px; font-weight: 650; color: var(--heading); margin: 0 0 12px; }
.sa-sec h3.sa-crumb { margin: 0; }
.sa-sec h3.sa-crumb > a:first-child { color: var(--muted); font-weight: 500; }
.sa-sec h3.sa-pt, .sa-sec .sa-pt { padding-top: 12px; }
.sa-sec h2 { font-size: 19px; margin: 0 0 12px; }
.sa-btns { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 14px; }
.sa-accent { margin: 0; }
.sa-accent p { margin: 0; }
.sa-accent.narrow { padding: 10px 14px; font-size: 12.5px; }
.sa-log { font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 600px; overflow: auto; }
.sa-log .w { color: #a86f00; }
.sa-log .e { color: var(--bad); }
.sa-log .t { color: var(--muted); }
.sa-log .g { color: #b8860b; }
@media (max-width: 560px) { .sa-sec { padding: 18px; } }
`);
