// Configuration › System: localization (time zone, internet time, temperature unit, local password),
// HDMI kiosk, web access, Bluetooth, SSH, and power actions with the countdown screens.
// Each group is its own card with a small form (Cancel/Save once changed).
import { api, appSettings, fmtTemp, html, loadSettings, saveSettings, useEffect, useQuery, useRef, useState, useStore } from '../lib/core.js';
import { Badge, Ic, Row, Toggle, toast } from '../lib/ui.js';
import {
  Btns, ConfigPage, F, Hint, Perform, Section, Val, diskUsage, fmtBytes, fmtDuration, injectCss, underVoltageText,
  usePoll, usePowerAction,
} from './configuration.js';

function timeZones(current) {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = ['UTC'];
  }
  if (!list.includes('UTC')) list = ['UTC', ...list];
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

const pad = (n) => String(n).padStart(2, '0');
/** Date and time parts ("YYYY-MM-DD", "HH:MM") of now in a time zone. */
function nowIn(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${pad(Number(parts.hour))}:${parts.minute}` };
}

/** Shows a failed OS change; when it needs root, the command the user can run instead. */
function ErrorBox({ error }) {
  if (!error) return null;
  return html`<div class="notice notice-bad cfg-err sa-cmd">
    <div>${error.message}</div>
    ${error.command && html`<code>${error.command}</code>`}
  </div>`;
}

/** POST helper that keeps `command` from 403 responses. */
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { command: data.command });
  return data;
}

/** One group: draft state, dirty → Cancel/Save, error box. */
function useGroup(initial, deps) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const base = initial();
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // When the underlying state changes (e.g. OS state loads), follow it unless the user edited.
  const last = useRef(JSON.stringify(base));
  useEffect(() => {
    const next = JSON.stringify(initial());
    setDraft((d) => (JSON.stringify(d) === last.current ? JSON.parse(next) : d));
    last.current = next;
  }, deps);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError({ message: err.message, command: err.command });
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => (setDraft(initial()), setError(null));
  return { draft, set: (patch) => setDraft((d) => ({ ...d, ...patch })), dirty, error, busy, run, cancel, reset: () => setDraft(initial()) };
}

/** Cancel (once changed) and Save. */
const SaveButtons = ({ g, onSave }) =>
  html`<${Btns}>
    ${g.dirty && html`<button type="button" class="btn" onClick=${g.cancel}>Cancel</button>`}
    <button type="button" class="btn btn-primary" disabled=${!g.dirty || g.busy} onClick=${onSave}>${g.busy ? 'Saving…' : 'Save'}</button>
  <//>`;

function PasswordModal({ s, onClose }) {
  const [clear, setClear] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    if (!clear && pw !== confirm) return setError('Passwords and confirmation does not match.');
    if (!clear && pw.length < 4) return setError('Password must be at least 4 characters.');
    try {
      await api.post('/api/password', { password: clear ? null : pw });
      await loadSettings();
      toast(clear ? 'Password cleared' : 'Password updated');
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };
  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="modal" role="dialog" aria-modal="true" aria-label="Set local password" onSubmit=${save}>
      <header class="modal-head"><h2>Set local password</h2><button type="button" class="icon-btn" aria-label="Close" onClick=${onClose}><${Ic} name="x" size="sm" /></button></header>
      <div class="modal-body">
      <p class="muted small" style="margin:0 0 6px">Required to sign in from other devices and before turning on remote access.</p>
      ${s['auth.password_set'] && html`<${F} label="Clear password"><${Toggle} checked=${clear} onChange=${setClear} /><//>`}
      <${F} label="New password" htmlFor="password">
        <input id="password" type="password" minlength="4" required=${!clear} disabled=${clear} autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} />
      <//>
      <${F} label="Confirm password" htmlFor="password_confirmation">
        <input id="password_confirmation" type="password" minlength="4" required=${!clear} disabled=${clear} autocomplete="new-password" value=${confirm} onInput=${(e) => setConfirm(e.target.value)} />
      <//>
      ${error && html`<div class="notice notice-bad cfg-err">${error}</div>`}
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </footer>
    </form>
  </div>`;
}

function Localization({ s, access, reloadAccess }) {
  const query = useQuery();
  const [showLocale, setShowLocale] = useState(false);
  const [pwOpen, setPwOpen] = useState(query.password === 'true');
  const t = access?.time;
  const init = () => ({ locale: s.locale, timezone: s.timezone, unit: s.temperature_unit, internet: t?.internetTime !== false });
  const g = useGroup(init, [s, t?.internetTime]);
  const d = g.draft;
  // Manual date/time: prefilled with the current time, counts as a change once edited.
  const [manual, setManual] = useState(() => ({ ...nowIn(s.timezone), edited: false }));
  const editManual = (patch) => setManual((m) => ({ ...m, ...patch, edited: true }));
  const dirty = g.dirty || (!d.internet && manual.edited);
  const save = () =>
    g.run(async () => {
      const ntpChanged = d.internet !== (t?.internetTime !== false);
      if (t?.supported && (d.timezone !== s.timezone || ntpChanged || (!d.internet && manual.edited))) {
        await post('/api/system/time', {
          timezone: d.timezone !== s.timezone ? d.timezone : undefined,
          internetTime: d.internet,
          manual: d.internet ? undefined : `${manual.date} ${manual.time}`,
        });
        reloadAccess();
      }
      await saveSettings({ locale: d.locale, timezone: d.timezone, temperature_unit: d.unit });
      setManual({ ...nowIn(d.timezone), edited: false });
      g.reset();
    });
  const cancel = () => (g.cancel(), setManual({ ...nowIn(s.timezone), edited: false }));
  return html`<${Section} icon="languages" tone="accent" title="Localization" desc="Language, time zone, clock and temperature unit"
    actions=${!showLocale && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setShowLocale(true)}>Language</button>`}>
    ${showLocale &&
    html`<${F} label="Language" htmlFor="locale">
      <select id="locale" onChange=${(e) => g.set({ locale: e.target.value })}><option value="en" selected>English</option></select>
    <//>`}
    <${F} label="Time zone" htmlFor="timezone">
      <select id="timezone" onChange=${(e) => g.set({ timezone: e.target.value })}>
        ${timeZones(d.timezone).map((z) => html`<option value=${z} selected=${z === d.timezone}>${z}</option>`)}
      </select>
    <//>
    <${F} label="Internet time" help=${t?.supported && (d.internet ? 'Synchronised automatically' : 'Set the date and time manually')}>
      ${t?.supported
        ? html`<div class="cfg-inline">
            <${Toggle} checked=${d.internet} onChange=${(on) => g.set({ internet: on })} />
            ${!d.internet &&
            html`<input id="date" type="date" aria-label="Date" class="sys-dt" value=${manual.date} onInput=${(e) => editManual({ date: e.target.value })} />
              <input id="time" type="time" aria-label="Time" class="sys-dt" value=${manual.time} onInput=${(e) => editManual({ time: e.target.value })} />`}
          </div>`
        : html`<span class="muted">${t ? 'Managed by the operating system' : 'Loading…'}</span>`}
    <//>
    <${F} label="Temperature unit" htmlFor="temperature_unit">
      <select id="temperature_unit" class="sys-narrow" onChange=${(e) => g.set({ unit: e.target.value })}>
        <option value="°C" selected=${d.unit === '°C'}>°Celsius</option>
        <option value="°F" selected=${d.unit === '°F'}>°Fahrenheit</option>
      </select>
    <//>
    <${F} label="Local password">
      <${Val} action=${html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setPwOpen(true)}>Change</button>`}>
        ${s['auth.password_set'] ? html`<${Badge} kind="ok">Updated<//>` : html`<${Badge} kind="warn">Default<//>`}
      <//>
    <//>
    <${ErrorBox} error=${g.error} />
    <${SaveButtons} g=${{ ...g, dirty, cancel }} onSave=${save} />
    ${pwOpen && html`<${PasswordModal} s=${s} onClose=${() => setPwOpen(false)} />`}
  <//>`;
}

const NotSupported = () => html`<span class="muted">Not supported on this device</span>`;

function Hdmi({ access, reload }) {
  const h = access?.hdmi;
  const g = useGroup(() => ({ mode: h?.mode ?? 'console' }), [h?.mode]);
  const save = () => g.run(async () => (await post('/api/system/hdmi', { mode: g.draft.mode }), reload()));
  return html`<${Section} icon="monitor" tone="load" title="HDMI, keyboard, mouse" desc="What a screen connected to the device shows">
    <${F} label="Mode" htmlFor="hdmi_mode">
      ${!access ? '-' : !h.supported
        ? NotSupported()
        : html`<select id="hdmi_mode" onChange=${(e) => g.set({ mode: e.target.value })}>
            <option value="kiosk" selected=${g.draft.mode === 'kiosk'}>Interactive kiosk (resource intensive)</option>
            <option value="console" selected=${g.draft.mode === 'console'}>Text based console</option>
          </select>`}
    <//>
    ${h?.supported && html`<${F} label="Service"><code class="muted">${h.unit}</code><//>`}
    <${ErrorBox} error=${g.error} />
    ${h?.supported && html`<${SaveButtons} g=${g} onSave=${save} />`}
  <//>`;
}

function WebAccess({ ip }) {
  const { data: remote } = usePoll('/api/remote', 0);
  const port = location.port && location.port !== '80' ? `:${location.port}` : '';
  return html`<${Section} icon="globe" tone="load" title="Web access" desc="Addresses this dashboard is reachable at">
    <${F} label="Remote access">
      <${Val} action=${html`<a href="/configuration/remote" class="btn btn-sm btn-ghost">Configure</a>`}>
        ${remote?.mode && remote.mode !== 'off'
          ? html`<a href=${remote.publicUrl} target="_blank" rel="noopener">${remote.publicUrl}</a>`
          : html`<span class="muted">Off</span>`}
      <//>
    <//>
    <${F} label="Local network">
      ${ip ? html`<a href=${`http://${ip}${port}`} target="_blank">http://${ip}${port}</a>` : html`<span class="muted">–</span>`}
    <//>
  <//>`;
}

function Bluetooth({ access, reload }) {
  const bt = access?.bluetooth;
  const g = useGroup(() => ({ mode: bt?.mode ?? 'disabled' }), [bt?.mode]);
  const save = () => g.run(async () => (await post('/api/system/bluetooth', { mode: g.draft.mode }), reload()));
  return html`<${Section} icon="bluetooth" tone="load" title="Bluetooth access" desc="Connect from the companion app without WiFi">
    <${F} label="Connectivity" htmlFor="bluetooth">
      ${!access ? '-' : !bt.supported
        ? NotSupported()
        : html`<select id="bluetooth" onChange=${(e) => g.set({ mode: e.target.value })}>
            <option value="auto-pair" selected=${g.draft.mode === 'auto-pair'}>Discoverable with auto pairing</option>
            <option value="no-pair" selected=${g.draft.mode === 'no-pair'}>Hidden with pairing disabled</option>
            <option value="disabled" selected=${g.draft.mode === 'disabled'}>Disabled</option>
          </select>`}
    <//>
    ${bt?.supported && html`<${F} label="Device name">${bt.name}<//>`}
    <${ErrorBox} error=${g.error} />
    ${bt?.supported && html`<${SaveButtons} g=${g} onSave=${save} />`}
  <//>`;
}

function Ssh({ access, reload, ip }) {
  const ssh = access?.ssh;
  const g = useGroup(() => ({ mode: ssh?.mode ?? 'disabled' }), [ssh?.mode]);
  const save = () => g.run(async () => (await post('/api/system/ssh', { mode: g.draft.mode }), reload()));
  return html`<${Section} icon="terminal" tone="load" title="SSH access" desc="Remote shell for maintenance">
    <${F} label="Connectivity" htmlFor="ssh_access">
      ${!access ? '-' : !ssh.supported
        ? NotSupported()
        : html`<select id="ssh_access" onChange=${(e) => g.set({ mode: e.target.value })}>
            <option value="key,password" selected=${g.draft.mode === 'key,password'}>Key and password authentication</option>
            <option value="key" selected=${g.draft.mode === 'key'}>Key authentication only</option>
            <option value="disabled" selected=${g.draft.mode === 'disabled'}>Disabled</option>
          </select>`}
    <//>
    ${ssh?.supported &&
    html`<${F} label="Configuration"><code class="muted">${ssh.file}</code><//>
      <${F} label="Connect with"><code>ssh ${ssh.user}@${ip || 'device'}</code><//>`}
    <${ErrorBox} error=${g.error} />
    ${ssh?.supported && html`<${SaveButtons} g=${g} onSave=${save} />`}
  <//>`;
}

/** Device details and power actions. */
function Device({ sys, onPower }) {
  const uv = underVoltageText(sys);
  const v = (fn) => (sys ? fn() : '–');
  return html`<${Section} icon="monitor-cog" tone="grid" title="Device" desc="Hardware, software and power">
    ${uv && html`<div class="notice notice-bad">${uv}</div>`}
    <${Row} label="Hostname">${v(() => sys.hostname)}<//>
    <${Row} label="Operating system">${v(() => `${sys.os} (${sys.arch})`)}<//>
    <${Row} label="Software version">${v(() => `Sunroost ${sys.version}, Node ${sys.node}`)}<//>
    <${Row} label="Uptime">${v(() => `${fmtDuration(sys.uptime)} (application ${fmtDuration(sys.appUptime)})`)}<//>
    <${Row} label="CPU temperature">${sys?.cpuTemp == null ? '–' : fmtTemp(sys.cpuTemp)}<//>
    <${Row} label="Load average">${v(() => `${sys.loadavg.join(', ')} (${sys.cpus} CPUs)`)}<//>
    <${Row} label="Memory">${v(() => `${fmtBytes(sys.memory.used)} of ${fmtBytes(sys.memory.total)}`)}<//>
    <${Row} label="Storage">${sys?.disk ? html`${diskUsage(sys.disk.total, sys.disk.used)} <a href="/configuration/storage" class="cfg-link">View detail</a>` : '–'}<//>
    <${Row} label="USB devices">${v(() => html`${sys.usbDevices.length} <a href="/system/kernel" class="cfg-link">View detail</a>`)}<//>
    ${sys && !sys.canPower && html`<${Hint}>Reboot and shutdown need Linux with systemd.<//>`}
    <${Btns}>
      <button type="button" class="btn" onClick=${() => onPower('restart-app')}><${Ic} name="refresh-cw" size="sm" />Restart application</button>
      <button type="button" class="btn btn-danger" disabled=${!sys?.canPower} onClick=${() => onPower('reboot')}><${Ic} name="rotate-ccw" size="sm" />Reboot</button>
      <button type="button" class="btn btn-danger" disabled=${!sys?.canPower} onClick=${() => onPower('shutdown')}><${Ic} name="power" size="sm" />Shutdown</button>
    <//>
  <//>`;
}

export default function SystemPage() {
  const s = useStore(appSettings);
  const { data: sys } = usePoll('/api/system', 15000);
  const { data: access, reload } = usePoll('/api/system/access', 0);
  const [performing, power] = usePowerAction();
  if (performing) return html`<${Perform} ...${performing} name=${s?.['site.name'] || 'Sunroost'} />`;
  if (!s) return html`<${ConfigPage} title="System"><div class="loading">Loading…</div><//>`;
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const ip = local ? sys?.ip?.find((a) => a.family === 'IPv4')?.address : location.hostname;
  return html`<${ConfigPage} title="System">
    <${Localization} s=${s} access=${access} reloadAccess=${reload} />
    <${WebAccess} ip=${ip} />
    <${Hdmi} access=${access} reload=${reload} />
    <${Bluetooth} access=${access} reload=${reload} />
    <${Ssh} access=${access} reload=${reload} ip=${ip} />
    <${Device} sys=${sys} onPower=${power} />
  <//>`;
}

injectCss('css-config-system', `
select.sys-narrow { max-width: 200px; }
input.sys-dt { width: auto; max-width: 170px; font-variant-numeric: tabular-nums; }
.sa-cmd code { display: block; margin-top: 6px; white-space: pre-wrap; word-break: break-all; user-select: all; }
`);
