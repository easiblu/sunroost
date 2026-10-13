// Remote access: put the app on your own domain (built-in HTTPS), via Cloudflare Tunnel, or behind your own reverse proxy.
import { api, fmtDateTime, html, loadSettings, useEffect, useState } from '../lib/core.js';
import { Badge, Button, Ic, IconChip, LogPanel, Row, toast } from '../lib/ui.js';
import { Btns, ConfigPage, F, Hint, Section, Sub } from './configuration.js';

const MODES = [
  { id: 'domain', icon: 'globe', label: 'Own domain', desc: 'Your own domain name. Add one DNS record at your domain provider; the device handles HTTPS automatically.' },
  { id: 'cloudflare', icon: 'cloud', label: 'Cloudflare Tunnel', desc: 'No router changes, free HTTPS, works behind any internet connection (also behind carrier-grade NAT).' },
  { id: 'proxy', icon: 'route', label: 'Own reverse proxy', desc: 'You run Caddy or nginx with port forwarding and your own certificate.' },
  { id: 'off', icon: 'house', label: 'Off', desc: 'Only reachable on your local network.' },
];

const DDNS = [
  { id: 'none', label: 'None (fixed IP)' },
  { id: 'duckdns', label: 'DuckDNS', token: 'DuckDNS token', hint: 'The token shown at the top of duckdns.org after signing in.' },
  { id: 'cloudflare', label: 'Cloudflare DNS', token: 'API token', hint: 'A Cloudflare API token with Zone › DNS › Edit permission for this domain.' },
  { id: 'namecheap', label: 'Namecheap', token: 'Dynamic DNS password', hint: 'Domain List › Manage › Advanced DNS › Dynamic DNS (turn it on to see the password).' },
  { id: 'url', label: 'Custom update URL', token: 'Update URL', hint: 'Called with GET whenever the IP changes. {ip} and {domain} are replaced, e.g. https://example.net/update?host={domain}&ip={ip}' },
];

function useRemote() {
  const [data, setData] = useState(null);
  const load = () => api.get('/api/remote').then(setData, () => {});
  const fast = data?.mode === 'domain';
  useEffect(() => {
    load();
    // The own-domain checklist is live: poll faster while it's on screen.
    const t = setInterval(load, fast ? 3000 : 5000);
    return () => clearInterval(t);
  }, [fast]);
  return [data, load, setData];
}

const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'bad'));
const CopyBtn = ({ text }) => html`<button type="button" class="btn btn-sm copy" onClick=${() => copy(text)} disabled=${!text}>Copy</button>`;
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Overall own-domain state for the Status row. */
function domainSummary(d) {
  if (!d?.active) return ['grey', 'Not running'];
  if (d.cert.state === 'ok' && d.https.listening && d.reachable.state === 'ok') return ['positive', 'Online'];
  if (d.cert.state === 'ok' && d.https.listening) return ['forward', 'HTTPS active'];
  if (d.cgnat) return ['negative', 'Blocked by carrier-grade NAT'];
  return ['caution', 'Setting up...'];
}

function RecordBox({ d, domain }) {
  const rec = d.record;
  const value = rec?.value ?? '';
  return html`<div class="notice notice-info dom-record">
    <p class="dom-lead">At the company where you bought <b>${rec?.root ?? domain}</b>, open its DNS settings and add this record:</p>
    <div class="dom-rec">
      <span class="k">Type</span><code>A</code><${CopyBtn} text="A" />
      <span class="k">Name</span><code>${rec?.name ?? '@'}</code><${CopyBtn} text=${rec?.name ?? '@'} />
      <span class="k">Value</span><code>${value || 'detecting…'}</code><${CopyBtn} text=${value} />
      <span class="k">TTL</span><code>Auto</code><span></span>
    </div>
    <p class="cfg-hint">${rec?.name === '@' ? 'Use @ (or leave Name empty) for the domain itself.' : html`Some providers want the full name instead: <code>${domain}</code>.`} Replace any existing A record for this name.</p>
  </div>`;
}

/** One checklist line: state is ok | wait | bad | muted. */
const CHECK_ICON = { ok: 'check', bad: 'x', wait: 'loader', muted: 'minus' };
const Check = ({ state, title, children }) => html`<li class=${`dom-${state}`}>
  <span class="dom-ic"><${Ic} name=${CHECK_ICON[state]} size="sm" /></span>
  <div class="dom-body"><b>${title}</b>${children && html`<div class="dom-detail">${children}</div>`}</div>
</li>`;

function PortRules({ d, r }) {
  const lan = d.upnp.lanIp ?? 'this device';
  return html`<div class="notice notice-warn dom-rules">
    In your router's <b>port forwarding</b> page, add:
    <table class="dom-ports"><tbody>
      ${d.upnp.rules.map((x) => html`<tr><td>External <b>${x.external}</b> (TCP)</td><td>→</td><td><code>${lan}:${x.internal}</code></td></tr>`)}
      ${!d.upnp.rules.length && html`<tr><td>External <b>80</b> → <code>${lan}:${r.localPort}</code>, <b>443</b> → <code>${lan}:${r.httpsPort}</code></td></tr>`}
    </tbody></table>
    Give this device a fixed address (DHCP reservation) so the rule keeps working.
  </div>`;
}

function Checklist({ d, r, onCloudflare }) {
  const ip = d.publicIp;
  const dns = d.dns;
  const up = d.upnp;
  const cert = d.cert;

  const dnsCheck =
    dns.state === 'ok' ? html`<${Check} state="ok" title="DNS record">${r.domain} → ${dns.seen.join(', ')}${dns.note && html`<br /><span class="caution">${dns.note}</span>`}<//>`
    : dns.state === 'mismatch' ? html`<${Check} state="bad" title="DNS record">Points at <b>${dns.seen.join(', ')}</b>; it should be <b>${ip ?? 'your public IP'}</b>.${dns.note && html` ${dns.note}`}<//>`
    : html`<${Check} state="wait" title="DNS record">
        ${dns.error ?? (dns.seen.length ? `Resolves to ${dns.seen.join(', ')}` : 'Not found yet.')}
        ${' '}Changes usually show within a few minutes${dns.checkedAt ? ` (checked ${fmtClock(dns.checkedAt)})` : ''}.${dns.note && html`<br />${dns.note}`}
      <//>`;

  const portsCheck =
    up.state === 'mapped' ? html`<${Check} state="ok" title="Router ports">Opened automatically on ${up.router} (UPnP): 80 and 443 → ${up.lanIp}<//>`
    : up.state === 'searching' ? html`<${Check} state="wait" title="Router ports">Looking for your router...<//>`
    : up.state === 'found' ? html`<${Check} state="wait" title="Router ports">Found ${up.router}${up.error ? `: ${up.error}` : ' (read-only mode, ports not opened)'}<${PortRules} d=${d} r=${r} /><//>`
    : html`<${Check} state=${up.state === 'off' ? 'muted' : 'bad'} title="Router ports">
        ${up.state === 'off' ? 'Automatic port opening (UPnP) is off.' : up.error}
        <${PortRules} d=${d} r=${r} />
      <//>`;

  const cgnatCheck =
    d.cgnat === false ? html`<${Check} state="ok" title="Not behind carrier-grade NAT">Your router has the public address ${up.externalIp}.<//>`
    : d.cgnat ? html`<${Check} state="bad" title="Behind carrier-grade NAT">${d.cgnatReason} Connections from the internet can't reach this device, whatever the router settings.
        <div class="notice notice-bad">Use <a href="#" onClick=${(e) => (e.preventDefault(), onCloudflare())}>Cloudflare Tunnel</a> instead: it connects outwards and works behind any NAT. Or ask your provider for a public IP address.</div><//>`
    : html`<${Check} state="muted" title="Carrier-grade NAT">Can't tell without UPnP. If the steps below never turn green, your provider may share your IP with others.<//>`;

  const certCheck =
    cert.state === 'ok' ? html`<${Check} state="ok" title="HTTPS certificate">${cert.issuer || "Let's Encrypt"}${cert.staging ? ' (staging)' : ''}, expires ${fmtDate(cert.expires)}. Renews automatically.
        ${cert.error && html`<br /><span class="caution">Last renewal attempt failed: ${cert.error}</span>`}
        ${d.https.error && html`<br /><span class="negative">${d.https.error}</span>`}<//>`
    : cert.state === 'ordering' ? html`<${Check} state="wait" title="HTTPS certificate">Requesting a certificate from Let's Encrypt...<//>`
    : cert.state === 'error' ? html`<${Check} state="bad" title="HTTPS certificate">${cert.error}${cert.nextAttemptAt && html`<br />Next attempt ${fmtDateTime(cert.nextAttemptAt)}, or press Check again.`}<//>`
    : html`<${Check} state="wait" title="HTTPS certificate">${cert.error ?? (dns.state === 'ok' ? 'Starting...' : 'Waiting for the DNS record.')}
        ${cert.error && html`<br /><span class="cfg-hint">If the ports are forwarded and your router can't reach its own public address, press Check again to request the certificate anyway.</span>`}<//>`;

  const reach = d.reachable;
  const reachCheck =
    reach.state === 'ok' ? html`<${Check} state="ok" title="Reachable from the internet"><a href=${r.publicUrl} target="_blank" rel="noopener">${r.publicUrl}</a> (${reach.ms} ms, checked ${fmtClock(reach.checkedAt)})<//>`
    : reach.state === 'failed' ? html`<${Check} state="bad" title="Reachable from the internet">${reach.error}<br /><span class="cfg-hint">Some routers can't open their own public address from inside the network. Try ${r.publicUrl} from a phone on mobile data.</span><//>`
    : reach.state === 'checking' ? html`<${Check} state="wait" title="Reachable from the internet">Testing...<//>`
    : html`<${Check} state="wait" title="Reachable from the internet">Tested once the certificate is in place.<//>`;

  return html`<ul class="dom-check">
    ${ip ? html`<${Check} state="ok" title="Public IP">${ip}<//>` : html`<${Check} state=${d.publicIpError ? 'bad' : 'wait'} title="Public IP">${d.publicIpError ?? 'Detecting...'}<//>`}
    ${dnsCheck}${portsCheck}${cgnatCheck}${certCheck}${reachCheck}
  </ul>`;
}

function DdnsSection({ r, reload }) {
  const d = r.domainMode;
  const [provider, setProvider] = useState(d.ddns.provider);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setProvider(d.ddns.provider), [d.ddns.provider]);
  const p = DDNS.find((x) => x.id === provider) ?? DDNS[0];
  const dirty = provider !== d.ddns.provider || token !== '';
  const changed = d.publicIpChangedAt;

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/remote/ddns', { provider, token: token || undefined });
      setToken('');
      toast(provider === 'none' ? 'Dynamic DNS off' : 'Dynamic DNS saved');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm('Remove the saved dynamic DNS token?')) return;
    await api.del('/api/remote/ddns');
    setProvider('none');
    reload();
  };
  const st = d.ddns;
  return html`
    <${Sub} icon="refresh-cw">Keep the record updated<//>
    ${changed
      ? html`<div class="notice notice-warn">Your public IP changed at ${fmtDateTime(changed)}: it's dynamic. Without automatic updates the record goes stale and the domain stops working until you edit it.</div>`
      : html`<p class="cfg-hint dom-p">Most home connections get a new public IP now and then. If yours does, choose your DNS provider and the device updates the record whenever the IP changes.</p>`}
    <${F} label="Provider" htmlFor="ddns_provider">
      <select id="ddns_provider" value=${provider} onChange=${(e) => setProvider(e.target.value)}>
        ${DDNS.map((x) => html`<option value=${x.id}>${x.label}</option>`)}
      </select>
    <//>
    ${provider !== 'none' &&
    html`<${F} label=${p.token} htmlFor="ddns_token">
      <input id="ddns_token" type=${provider === 'url' ? 'text' : 'password'} value=${token} autocomplete="off" spellcheck="false"
        placeholder=${r.ddnsTokenSet && provider === d.ddns.provider ? '•••••••• saved' : ''} onInput=${(e) => setToken(e.target.value)} />
      <${Hint}>${p.hint}${r.ddnsTokenSet && html` · <a href="#" onClick=${(e) => (e.preventDefault(), remove())}>Remove saved token</a>`}<//>
    <//>`}
    ${d.ddns.provider !== 'none' &&
    html`<${F} label="Last update">
      ${st.state === 'ok' ? html`<${Badge} kind="ok">${st.ip} at ${fmtDateTime(st.lastUpdate)}<//>`
        : st.state === 'error' ? html`<${Badge} kind="bad">${st.error}<//>`
        : html`<span class="muted">${st.state === 'pending' ? 'Updating…' : 'Waiting for the public IP'}</span>`}
    <//>`}
    <${Btns}>
      <button type="button" class="btn btn-primary" disabled=${!dirty || busy} onClick=${save}>${busy ? 'Saving…' : 'Save'}</button>
    <//>
  `;
}

const KIND = { positive: 'ok', forward: 'info', negative: 'bad', caution: 'warn', grey: 'muted' };

function StatusSection({ r, onTest, testing, test }) {
  const tunnelUp = r.mode === 'cloudflare' && r.connections.length > 0;
  const [dCls, dLabel] = domainSummary(r.domainMode);
  const cls = r.mode === 'off' ? 'grey' : r.mode === 'domain' ? dCls : r.mode === 'proxy' ? 'forward' : tunnelUp ? 'positive' : r.running ? 'caution' : 'negative';
  const label =
    r.mode === 'off' ? 'Off'
    : r.mode === 'domain' ? dLabel
    : r.mode === 'proxy' ? 'Reverse proxy'
    : tunnelUp ? `Connected (${r.connections.join(', ')})`
    : r.running ? 'Connecting...'
    : 'Not running';
  return html`<${Section} icon="globe" tone="load" title="Status" desc="How this dashboard is reached from outside your network"
    actions=${html`<${Badge} kind=${KIND[cls]}>${label}<//>`}>
    <${Row} label="Address">
      ${r.publicUrl ? html`<a href=${r.publicUrl} target="_blank" rel="noopener">${r.publicUrl}</a>` : html`<span class="muted">Local network only</span>`}
    <//>
    ${r.mode === 'cloudflare' && r.since && html`<${Row} label="Running since">${fmtDateTime(r.since)}<//>`}
    ${r.lastError && r.mode === 'cloudflare' && html`<${Row} label="Error"><span class="text-bad">${r.lastError}</span><//>`}
    ${r.mode !== 'off' &&
    html`<${Row} label="Test">
      <span class="cluster" style="justify-content:flex-end">
        ${test ? (test.ok ? html`<${Badge} kind="ok">Reachable (${test.ms} ms)<//>` : html`<${Badge} kind="bad">${test.error}<//>`) : html`<span class="muted">Not tested yet</span>`}
        <button type="button" class="btn btn-sm" disabled=${testing} onClick=${onTest}>${testing ? 'Testing…' : 'Test from the internet'}</button>
      </span>
    <//>`}
  <//>`;
}

function CloudflareSteps({ r, domain }) {
  const host = domain || 'solar.example.com';
  return html`<ol class="steps">
    <li>Add your domain to <a href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare</a> (the free plan is enough) and point your registrar's nameservers to Cloudflare.</li>
    <li>In Cloudflare, open <b>Zero Trust → Networks → Tunnels</b>, choose <b>Create a tunnel → Cloudflared</b>, and name it (e.g. "solar").</li>
    <li>On the install step, copy the long token after <code>--token</code> and paste it into the Tunnel token field above. You don't need to run their install command.</li>
    <li>Under <b>Public hostname</b>, add <code>${host}</code> with service type <b>HTTP</b> and URL <code>localhost:${r.localPort}</code>.</li>
    <li>Save here, then press <b>Test from the internet</b>. DNS can take a minute or two.</li>
  </ol>
  <p class="muted small">Optional extra protection: add a Cloudflare Access application for the hostname so Cloudflare asks for an email code before anyone reaches the sign-in page.</p>`;
}

function ProxySteps({ r, domain }) {
  const host = domain || 'solar.example.com';
  const caddy = `${host} {\n  reverse_proxy localhost:${r.localPort}\n}`;
  return html`<ol class="steps">
    <li>Create a DNS <b>A record</b> for <code>${host}</code> pointing at your public IP address (use dynamic DNS if it changes).</li>
    <li>Forward ports <b>80</b> and <b>443</b> on your router to this device.</li>
    <li>Install <a href="https://caddyserver.com/docs/install#debian-ubuntu-raspbian" target="_blank" rel="noopener">Caddy</a> on this device and use this Caddyfile. It gets an HTTPS certificate automatically:
      <pre class="code">${caddy}</pre>
      <${Button} small onClick=${() => navigator.clipboard?.writeText(caddy).then(() => toast('Copied'))}>Copy<//>
    </li>
  </ol>
  <p class="muted small">Run the proxy on this device: forwarded client addresses and HTTPS are only trusted from localhost.</p>`;
}

export default function RemoteAccess() {
  const [r, reload, setR] = useRemote();
  const [mode, setMode] = useState(null);
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);

  useEffect(() => {
    if (r && mode === null) {
      setMode(r.mode);
      setDomain(r.domain);
      setEmail(r.acmeEmail ?? '');
    }
  }, [r]);

  if (!r || mode === null) return html`<div class="page"><div class="loading">Loading…</div></div>`;

  const dirty = mode !== r.mode || domain !== r.domain || token !== '' || (mode === 'domain' && email !== (r.acmeEmail ?? ''));
  const needsPassword = mode !== 'off' && !r.passwordSet;

  const save = async () => {
    setSaving(true);
    setTest(null);
    try {
      const next = await api.post('/api/remote', { mode, domain, token: token || undefined, ...(mode === 'domain' ? { acmeEmail: email } : {}) });
      setR({ ...next });
      setToken('');
      setDomain(next.domain);
      setEmail(next.acmeEmail ?? '');
      await loadSettings();
      toast(mode === 'off' ? 'Remote access turned off' : 'Remote access saved');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.post('/api/remote/test'));
    } finally {
      setTesting(false);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      setR(await api.post('/api/remote/domain/retry'));
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setChecking(false);
    }
  };

  const domainLive = mode === 'domain' && r.mode === 'domain' && r.domain && r.domainMode?.active;

  const removeToken = async () => {
    if (!confirm('Remove the saved tunnel token? Remote access via Cloudflare will stop.')) return;
    await api.del('/api/remote/token');
    setMode('off');
    reload();
  };

  return html`<${ConfigPage} title="Remote access">
    <${StatusSection} r=${r} onTest=${runTest} testing=${testing} test=${test} />
    <${Section} icon="settings-2" tone="accent" title="Setup" desc="Choose how the dashboard is published">
      <div class="mode-pick" role="radiogroup" aria-label="Remote access mode">
        ${MODES.map(
          (m) => html`<label class=${`mode ${mode === m.id ? 'on' : ''}`}>
            <input type="radio" name="mode" checked=${mode === m.id} onChange=${() => setMode(m.id)} />
            <${IconChip} name=${m.icon} tone=${mode === m.id ? 'accent' : ''} small />
            <span><b>${m.label}</b><small>${m.desc}</small></span>
          </label>`,
        )}
      </div>
      ${needsPassword && html`<div class="notice notice-warn">Set a <a href="/configuration/system?password=true">local password</a> first. The dashboard can change inverter settings, so it must not be public without one.</div>`}
      ${mode !== 'off' &&
      html`<${F} label="Domain" htmlFor="remote_domain">
        <input id="remote_domain" type="text" value=${domain} placeholder="solar.example.com" autocomplete="off" spellcheck="false" onInput=${(e) => setDomain(e.target.value)} />
      <//>`}
      ${mode === 'domain' &&
      html`<${F} label="Email (optional)" htmlFor="remote_email">
        <input id="remote_email" type="email" value=${email} placeholder="you@example.com" autocomplete="email" spellcheck="false" onInput=${(e) => setEmail(e.target.value)} />
        <${Hint}>Let's Encrypt emails you if the certificate ever fails to renew.<//>
      <//>`}
      ${mode === 'cloudflare' &&
      html`
        <${F} label="Tunnel token" htmlFor="remote_token">
          <textarea id="remote_token" rows="3" class="mono" value=${token} placeholder=${r.tokenSet ? '•••••••• saved' : 'eyJhIjoi…'} spellcheck="false"
            onInput=${(e) => setToken(e.target.value.replace(/^.*--token\s+/, '').trim())}></textarea>
          <${Hint}>${r.tokenSet ? 'A token is saved. Paste a new one to replace it.' : 'From the tunnel’s install command, after --token'}
            ${r.tokenSet && html` · <a href="#" onClick=${(e) => (e.preventDefault(), removeToken())}>Remove saved token</a>`}<//>
        <//>
        <${F} label="cloudflared">
          ${r.binary
            ? html`<${Badge} kind="ok">Installed<//> <code class="small">${r.binary}</code>`
            : html`<span class="small"><${Badge} kind="bad">Not installed<//> On the Pi run <code>sudo deploy/install.sh</code> again, or see <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener">Cloudflare's downloads</a>.</span>`}
        <//>
      `}
      <${Btns}>
        ${dirty && html`<button type="button" class="btn" onClick=${() => { setMode(r.mode); setDomain(r.domain); setToken(''); setEmail(r.acmeEmail ?? ''); }}>Cancel</button>`}
        <button type="button" class="btn btn-primary" disabled=${!dirty || saving || needsPassword} onClick=${save}>${saving ? 'Saving…' : 'Save'}</button>
      <//>
      ${mode === 'domain' && !domainLive && html`<p class="cfg-hint dom-p" style="margin-top:12px">Enter the domain (or a subdomain like solar.yourname.com) and press Save. You'll get the one DNS record to add, and a checklist that turns green as each step completes.</p>`}
      ${mode === 'cloudflare' && html`<${Sub} icon="list-checks">How to set it up<//><${CloudflareSteps} r=${r} domain=${domain} />`}
      ${mode === 'proxy' && html`<${Sub} icon="list-checks">How to set it up<//><${ProxySteps} r=${r} domain=${domain} />`}
    <//>
    ${domainLive &&
    html`<${Section} icon="list-checks" tone="battery" title="Own domain setup" desc=${r.domain}
      actions=${html`<button type="button" class="btn btn-sm" disabled=${checking} onClick=${checkAgain}><${Ic} name="refresh-cw" size="sm" />${checking ? 'Checking…' : 'Check again'}</button>`}>
      <${Sub} icon="globe">Step 1: add the DNS record<//>
      <${RecordBox} d=${r.domainMode} domain=${r.domain} />
      <${Sub} icon="list-checks">Step 2: wait for the checks<//>
      <${Checklist} d=${r.domainMode} r=${r} onCloudflare=${() => setMode('cloudflare')} />
      <${DdnsSection} r=${r} reload=${reload} />
    <//>`}
    <${Section} icon="shield-check" tone="battery" title="Security" desc="Protections that apply when the dashboard is public">
      <ul class="checklist">
        <li class=${r.passwordSet ? 'ok' : 'bad'}>
          ${r.passwordSet ? 'Local password is set' : html`No local password. <a href="/configuration/system?password=true">Set one</a> before going public.`}
        </li>
        <li class="ok">Sign-in attempts are rate-limited per address; 20 failures in an hour block the address for 24 hours (never on your local network)</li>
        <li class="ok">Sessions use Secure, HttpOnly cookies over HTTPS</li>
        <li class="ok">Cross-site requests are rejected</li>
        <li class="muted">MQTT (port 1883) stays on your local network</li>
      </ul>
    <//>
    <${Section} icon="scroll-text" title="Remote access log" desc="Tunnel, certificate and DNS messages">
      <${LogPanel} tag="remote" height=${260} />
    <//>
  <//>`;
}

const css = `
.dom-p { margin: 0 0 8px; }
.dom-record { margin: 4px 0 0; }
.dom-record .dom-lead { margin: 0 0 12px; }
.dom-rec { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; max-width: 480px; margin: 0 0 12px; }
.dom-rec .k { font-size: 12.5px; opacity: .8; }
.dom-rec code { font-size: 13.5px; background: var(--surface); color: var(--text); border-radius: 8px; padding: 5px 10px; overflow-wrap: anywhere; }
.dom-record .cfg-hint { margin: 0; color: inherit; opacity: .85; }
.dom-check { list-style: none; padding: 0; margin: 4px 0 0; display: flex; flex-direction: column; }
.dom-check li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--grid-line); line-height: 1.5; }
.dom-check li:last-child { border-bottom: 0; }
.dom-ic { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--surface-2); color: var(--muted); }
.dom-ok .dom-ic { background: var(--ok-soft); color: var(--ok); }
.dom-bad .dom-ic { background: var(--bad-soft); color: var(--bad); }
.dom-wait .dom-ic { background: var(--warn-soft); color: var(--warn); }
.dom-body { min-width: 0; flex: 1; }
.dom-body b { color: var(--heading); font-weight: 600; }
.dom-detail { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.dom-detail .notice { margin: 8px 0 0; font-size: 12.5px; }
.dom-ports { border-collapse: collapse; margin: 6px 0; }
.dom-ports td { padding: 2px 6px 2px 0; }
.dom-ports code { white-space: nowrap; }
.dom-detail code, .steps code, .checklist code { background: var(--surface-2); padding: 1px 6px; border-radius: 6px; }
.btn.copy { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 9px; }
.mode-pick { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 8px; }
@media (max-width: 640px) { .mode-pick { grid-template-columns: 1fr; } }
.mode { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border: 1.5px solid var(--border); border-radius: 14px; cursor: pointer; background: var(--surface); }
.mode:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.mode.on { border-color: var(--accent); background: var(--accent-soft); }
.mode input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.mode:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.mode span { display: flex; flex-direction: column; min-width: 0; }
.mode b { color: var(--heading); font-weight: 650; }
.mode small { color: var(--muted); font-size: 12px; line-height: 1.4; }
.steps { padding-left: 20px; margin: 4px 0 0; display: grid; gap: 8px; }
.steps li::marker { color: var(--accent); font-weight: 700; }
pre.code { background: var(--surface-2); padding: 10px 12px; border-radius: var(--radius-sm); overflow-x: auto; margin: 8px 0; }
.checklist { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.checklist li { position: relative; padding-left: 30px; line-height: 1.5; }
.checklist li::before { content: ''; position: absolute; left: 0; top: 1px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--ok-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231fb46b' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 12px no-repeat; }
.checklist li.bad::before { background: var(--bad-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ef4444' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M12 7v6M12 17h.01'/%3E%3C/svg%3E") center / 12px no-repeat; }
.checklist li.muted::before { background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a909d' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M7 12h10'/%3E%3C/svg%3E") center / 12px no-repeat; }
`;
if (!document.getElementById('css-remote')) {
  const el = document.createElement('style');
  el.id = 'css-remote';
  el.textContent = css;
  document.head.appendChild(el);
}
