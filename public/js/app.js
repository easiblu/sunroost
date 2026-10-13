// App shell: header navigation, client-side routing, sign-in.
import {
  api, appSettings, connection, connectLive, html, live, loadSettings, navigate, onNotification, render, route,
  useEffect, useRef, useState, useStore,
} from './lib/core.js';
import { Button, Ic, pageMeta, Segmented, Toasts } from './lib/ui.js';

/** Path → page module in /js/pages. Longest prefix wins for nested paths. */
const ROUTES = {
  '/': 'dashboard',
  '/charts': 'charts',
  '/totals': 'totals',
  '/power': 'power',
  '/automations': 'automations',
  '/devices': 'devices',
  '/inverter/status': 'inverter-status',
  '/inverter/settings': 'inverter-settings',
  '/battery/status': 'battery-status',
  '/grid/status': 'grid-status',
  '/configuration': 'configuration',
  '/configuration/advanced': 'config-advanced',
  '/configuration/mqtt': 'config-mqtt',
  '/configuration/storage': 'config-storage',
  '/configuration/system': 'config-system',
  '/configuration/remote': 'config-remote',
  '/tools/modbus': 'tools-modbus',
  '/tools/logs': 'tools-logs',
  '/tools/command': 'tools-command',
  '/system/kernel': 'system-kernel',
  '/modbus/console': 'tools-modbus',
  '/inverter/console': 'tools-command',
  '/battery/serial/console': 'battery-console',
  '/diagnostic/serial/test': 'diag-serial-test',
  '/diagnostic/serial/inspect': 'diag-serial-inspect',
  '/diagnostic/broker': 'diag-broker',
};

/** Sidebar navigation. `match` decides which entry is highlighted for nested pages. */
const NAV = [
  { section: 'Overview' },
  { href: '/', label: 'Dashboard', icon: 'layout-dashboard', match: (p) => p === '/' },
  { href: '/charts', label: 'Charts', icon: 'chart-spline' },
  { href: '/totals', label: 'Totals', icon: 'chart-column' },
  { href: '/power', label: 'Power', icon: 'zap', match: (p) => p === '/power' },
  { href: '/automations', label: 'Automations', icon: 'workflow', match: (p) => p.startsWith('/automations') },
  { section: 'Devices' },
  { href: '/inverter/status', label: 'Inverter', icon: 'cpu', match: (p) => p === '/inverter/status' || p === '/inverter/settings' },
  { href: '/battery/status', label: 'Battery', icon: 'battery-charging', match: (p) => p.startsWith('/battery') },
  { href: '/grid/status', label: 'Grid', icon: 'utility-pole' },
  { href: '/devices', label: 'Smart devices', icon: 'plug-zap' },
  { section: 'System' },
  { href: '/configuration', label: 'Configuration', icon: 'settings',
    match: (p) => p.startsWith('/configuration') || /^\/(system|modbus|diagnostic|tools)/.test(p) || p === '/inverter/console' },
];
const BOTTOM = ['/', '/charts', '/totals', '/power', '/configuration'];
const isActive = (item, p) => (item.match ? item.match(p) : p.startsWith(item.href));

function pageFor(path) {
  const p = path.split('?')[0].replace(/\/$/, '') || '/';
  return ROUTES[p] ?? null;
}

function Sidebar() {
  const path = useStore(route).split('?')[0];
  const s = useStore(appSettings);
  return html`<aside class="sidebar" aria-label="Main navigation">
    <a href="/" class="brand"><img src="/img/icon.svg" alt="" /><div><b>${s?.['site.name'] || 'Sunroost'}</b><span>Energy monitor</span></div></a>
    ${NAV.map((n) =>
      n.section
        ? html`<div class="nav-label">${n.section}</div>`
        : html`<a href=${n.href} class=${`nav-item ${isActive(n, path) ? 'active' : ''}`} aria-current=${isActive(n, path) ? 'page' : undefined} title=${n.label}>
            <${Ic} name=${n.icon} /><span>${n.label}</span>
          </a>`,
    )}
    <div class="sidebar-foot">
      <a href="/tools/logs" class=${`nav-item ${path === '/tools/logs' ? 'active' : ''}`} title="Logs"><${Ic} name="scroll-text" /><span>Logs</span></a>
    </div>
  </aside>`;
}

function BottomNav() {
  const path = useStore(route).split('?')[0];
  return html`<nav class="bottom-nav" aria-label="Main">
    ${NAV.filter((n) => BOTTOM.includes(n.href)).map(
      (n) => html`<a href=${n.href} class=${isActive(n, path) ? 'active' : ''}><${Ic} name=${n.icon} size="lg" />${n.label === 'Configuration' ? 'Settings' : n.label}</a>`,
    )}
  </nav>`;
}

function useJson(url, every) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get(url).then((d) => alive && setData(d), () => {});
    load();
    const t = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);
  return data;
}

function LiveStatus() {
  const conn = useStore(connection);
  const snap = useStore(live);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const inv = snap?.status?.inverter;
  const stale = !snap?.ts || Date.now() - snap.ts > 30_000;
  const tone = conn !== 'open' ? 'bad' : inv?.name === 'connected' && !stale ? '' : inv?.name === 'error' ? 'bad' : 'warn';
  const text =
    conn !== 'open' ? 'Reconnecting…'
    : inv?.name !== 'connected' ? inv?.message ?? 'Not connected'
    : `Updated ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return html`<span class="pill hide-sm" title=${inv?.message ?? ''}><span class=${`live-dot ${tone}`}></span>${text}</span>`;
}

function WeatherPill() {
  const w = useJson('/api/weather', 10 * 60_000);
  if (!w?.weather) return null;
  const unit = appSettings.get()?.temperature_unit ?? '°C';
  const t = w.weather.current.temperature;
  const temp = unit === '°F' ? Math.round(t * 1.8 + 32) : Math.round(t);
  return html`<span class="pill hide-sm" title=${`${w.weather.current.text} · ${w.weather.location}`}><${Ic} name=${w.icon} />${temp}${unit} · ${w.weather.current.text}</span>`;
}

/** "14:05" today, otherwise "12 Oct 14:05". */
const feedTime = (ts) => {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
};

/**
 * Top-bar bell: one panel with two tabs, "Alerts" (active + recently resolved) and "Notifications"
 * (the in-app feed written by automation Notify actions). Badge = active alerts + unread notifications.
 * The unread count arrives live over the WebSocket (`notification` push), with a slow poll as fallback.
 */
function AlertsButton() {
  const data = useJson('/api/alerts', 30_000);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('alerts');
  const [unread, setUnread] = useState(0);
  const [notes, setNotes] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const activeAlerts = data?.active ?? [];
  const tone = { bad: 'bad', warn: 'accent', info: 'battery' };
  const icon = { bad: 'triangle-alert', warn: 'circle-alert', info: 'circle-check' };

  useEffect(() => {
    let alive = true;
    const poll = () => api.get('/api/notifications/unread').then((r) => alive && setUnread(r.unread ?? 0), () => {});
    poll();
    // Live push over the WebSocket; the slow poll only catches up after reconnects.
    const off = onNotification((_item, count) => alive && setUnread(count ?? 0));
    const t = setInterval(poll, 120_000);
    return () => {
      off();
      alive = false;
      clearInterval(t);
    };
  }, []);
  const loadNotes = () => api.get('/api/notifications?limit=30').then((n) => {
    setNotes(n);
    setUnread(n.filter((x) => !x.read).length);
  }, () => setNotes((x) => x ?? []));
  useEffect(() => {
    if (open && tab === 'notifications') loadNotes();
  }, [open, tab]);
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

  const toggle = () => {
    if (!open) setTab(activeAlerts.length === 0 && unread > 0 ? 'notifications' : tab);
    setOpen(!open);
  };
  const markRead = async () => {
    setBusy(true);
    try {
      await api.post('/api/notifications/read');
      setUnread(0);
      setNotes((n) => n?.map((x) => ({ ...x, read: true })) ?? n);
    } catch {
      // The next poll shows the real count.
    }
    setBusy(false);
  };
  const count = activeAlerts.length + unread;
  const alertItems = [...activeAlerts, ...(data?.recent ?? []).slice(0, 6)];
  return html`<div class="alerts-wrap" ref=${ref}>
    <style>${`
      .ab-tabs { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .ab-tabs .seg { flex: 1; display: flex; }
      .ab-tabs .seg button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
      .ab-n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--bad); color: #fff; font-size: 10.5px; font-weight: 700; display: inline-grid; place-items: center; }
      .ab-n.muted { background: var(--surface-3); color: var(--muted); }
      .ab-list { max-height: min(420px, 60vh); overflow-y: auto; margin: 0 -6px; padding: 0 6px; }
      .ab-note .list-title { white-space: normal; }
      .ab-note .list-sub { white-space: normal; line-height: 1.45; }
      .ab-note.unread .list-title::after { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: 7px; vertical-align: 2px; }
      .ab-time { flex: none; align-self: flex-start; font-size: 11.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .ab-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
      .ab-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .ab-empty .ic { width: 24px; height: 24px; color: var(--faint); }
      .alerts-pop .card-head { margin-bottom: 10px; }
    `}</style>
    <button class="icon-btn" aria-label=${`Alerts (${activeAlerts.length}) and notifications (${unread} unread)`} aria-expanded=${open} onClick=${toggle}>
      <${Ic} name="bell" />${count > 0 && html`<span class="count">${count > 99 ? '99+' : count}</span>`}
    </button>
    ${open &&
    html`<div class="alerts-pop card" role="dialog" aria-label="Alerts and notifications">
      <div class="card-head"><h2>${tab === 'alerts' ? 'Alerts' : 'Notifications'}</h2><button class="btn btn-sm" onClick=${() => setOpen(false)}>Close</button></div>
      <div class="ab-tabs"><${Segmented} value=${tab} onChange=${setTab} options=${[
        { value: 'alerts', label: html`Alerts${activeAlerts.length > 0 && html`<span class="ab-n">${activeAlerts.length}</span>`}` },
        { value: 'notifications', label: html`Notifications${unread > 0 && html`<span class="ab-n">${unread}</span>`}` },
      ]} /></div>
      ${tab === 'alerts'
        ? html`${alertItems.length === 0 && html`<div class="empty ab-empty"><${Ic} name="shield-check" />All good. No alerts.</div>`}
          <div class="list ab-list">
            ${alertItems.map(
              (a) => html`<div class="list-item" style=${a.resolvedAt ? 'opacity:.55' : ''}>
                <span class=${`chip-ic sm ${tone[a.level]}`}><${Ic} name=${icon[a.level]} size="sm" /></span>
                <div class="list-main"><div class="list-title">${a.title}</div><div class="list-sub">${a.detail}</div></div>
                <div class="list-sub">${a.resolvedAt ? 'resolved' : new Date(a.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>`,
            )}
          </div>`
        : html`${notes === null ? html`<div class="loading" style="padding:24px 0">Loading…</div>`
            : notes.length === 0 ? html`<div class="empty ab-empty"><${Ic} name="bell-off" />No notifications yet.<span class="small">Automation rules with a Notify action post here.</span></div>`
            : html`<div class="list ab-list">${notes.map((n) => html`<div class=${`list-item ab-note ${n.read ? '' : 'unread'}`}>
                <span class=${`chip-ic sm ${n.read ? '' : 'accent'}`}><${Ic} name="bell-ring" size="sm" /></span>
                <div class="list-main"><div class="list-title">${n.title}</div><div class="list-sub">${n.message}</div></div>
                <span class="ab-time">${feedTime(n.ts)}</span>
              </div>`)}</div>`}
          <div class="ab-foot">
            <a class="small" href="/automations?tab=settings" onClick=${() => setOpen(false)}>Notification settings</a>
            <button class="btn btn-sm btn-ghost" disabled=${busy || unread === 0} onClick=${markRead}><${Ic} name="check-check" size="sm" />Mark all read</button>
          </div>`}
    </div>`}
  </div>`;
}

function TopBar() {
  const meta = useStore(pageMeta);
  return html`<header class="topbar">
    <div class="topbar-title">
      ${meta.crumbs?.length > 0 &&
      html`<div class="crumbs">${meta.crumbs.map(([label, href]) => html`<a href=${href}>${label}</a><span>/</span>`)}</div>`}
      <h1>${meta.title || ' '}</h1>
    </div>
    <${WeatherPill} />
    <${LiveStatus} />
    <${AlertsButton} />
  </header>`;
}

function SignIn() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { password });
      await loadSettings();
      connectLive();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="signin">
    <style>${`
      .si-card { width: min(400px, 100%); padding: 36px 32px 30px; text-align: center; display: flex; flex-direction: column; gap: 6px; }
      .si-logo { width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 14px; box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 25%, transparent); }
      .si-card h1 { font-size: 24px; margin: 0; }
      .si-card .si-sub { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
      .si-label { text-align: left; font-size: 12.5px; font-weight: 600; color: var(--muted); margin-bottom: 2px; }
      .si-input { position: relative; display: flex; align-items: center; }
      .si-input .ic { position: absolute; left: 13px; color: var(--muted); pointer-events: none; }
      .si-input input { max-width: none; height: 44px; padding-left: 40px; padding-right: 44px; }
      .si-eye { position: absolute; right: 6px; width: 32px; height: 32px; border: 0; background: none; border-radius: 8px; color: var(--muted); cursor: pointer; display: grid; place-items: center; }
      .si-eye:hover { background: var(--surface-2); color: var(--text); }
      .si-err { display: flex; gap: 8px; align-items: center; text-align: left; margin: 8px 0 0; padding: 9px 12px; font-size: 13px; }
      .si-btn { width: 100%; height: 44px; margin-top: 16px; font-size: 14px; }
      .si-foot { margin: 16px 0 0; font-size: 12px; color: var(--faint); }
    `}</style>
    <form class="card si-card" onSubmit=${submit}>
      <img class="si-logo" src="/img/icon.svg" alt="Sunroost" />
      <h1>Welcome back</h1>
      <p class="si-sub">Sign in to your Sunroost energy monitor</p>
      <label class="si-label" for="si-pw">Password</label>
      <div class="si-input">
        <${Ic} name="lock-keyhole" size="sm" />
        <input id="si-pw" type=${show ? 'text' : 'password'} autocomplete="current-password" autofocus placeholder="Enter your password"
          value=${password} onInput=${(e) => setPassword(e.target.value)} />
        <button type="button" class="si-eye" aria-label=${show ? 'Hide password' : 'Show password'} onClick=${() => setShow(!show)}>
          <${Ic} name=${show ? 'eye-off' : 'eye'} size="sm" />
        </button>
      </div>
      ${error && html`<div class="notice notice-bad si-err"><${Ic} name="circle-alert" size="sm" />${error}</div>`}
      <${Button} kind="primary" type="submit" class="btn btn-primary si-btn" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}<//>
      <p class="si-foot">The local password is set on the System configuration page.</p>
    </form>
  </div>`;
}

const cache = {};
function Router() {
  const path = useStore(route);
  const name = path.startsWith('/sign-in') ? 'sign-in' : pageFor(path);
  const [Page, setPage] = useState(() => cache[name] ?? null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    if (name === 'sign-in' || !name) return;
    if (cache[name]) return setPage(() => cache[name]);
    setPage(null);
    import(`./pages/${name}.js`).then(
      (m) => {
        cache[name] = m.default;
        setPage(() => m.default);
      },
      (err) => setError(err.message),
    );
  }, [name]);
  if (name === 'sign-in') return html`<${SignIn} />`;
  if (!name) return html`<div class="page"><h1>Not found</h1><p><a href="/">Back to dashboard</a></p></div>`;
  if (error) return html`<div class="page"><h1>Page failed to load</h1><pre class="muted">${error}</pre></div>`;
  if (!Page) return html`<div class="page"><div class="loading">Loading…</div></div>`;
  return html`<${Page} key=${name} />`;
}

function App() {
  const path = useStore(route);
  const signIn = path.startsWith('/sign-in');
  if (signIn) return html`<main id="main" class="main bare"><${Router} /></main><${Toasts} />`;
  return html`
    <div class="shell">
      <${Sidebar} />
      <div class="main-col">
        <${TopBar} />
        <main id="main" class="main"><${Router} /></main>
      </div>
    </div>
    <${BottomNav} />
    <${Toasts} />
  `;
}

async function boot() {
  const auth = await api.get('/api/auth/status').catch(() => ({ authenticated: true }));
  if (!auth.authenticated) {
    if (!route.get().startsWith('/sign-in')) navigate('/sign-in', { replace: true });
  } else {
    await loadSettings().catch(() => {});
    connectLive();
  }
  if (location.hostname === '127.0.0.1') document.body.classList.add('kiosk');
  render(html`<${App} />`, document.getElementById('app'));
}

boot();
