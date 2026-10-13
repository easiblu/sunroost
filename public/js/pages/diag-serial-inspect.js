// Serial inspection console: two endpoints (serial device or TRACE), pipes between them, frame
// splitting by silence, manual send, decoded side-by-side log and trace CSV load/save/replay.
// Also exports the helpers the other developer-tool pages share (live stream, port select, log,
// connection card, status badge, segmented control with disabled state and the dev-tool CSS).
import { api, html, useEffect, useRef, useState } from '../lib/core.js';
import { Button, Ic, IconChip, Page, Toggle, toast } from '../lib/ui.js';

export const BAUDS = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200'];
export const CONFIG_CRUMBS = [['Configuration', '/configuration']];

/** Subscribes to GET /api/diagnostics/stream?topic=… (Server-Sent Events). handlers: { type: fn(data) }. */
export function useDiagStream(topic, handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const es = new EventSource(`/api/diagnostics/stream?topic=${topic}`);
    const on = (type) => es.addEventListener(type, (ev) => ref.current[type]?.(JSON.parse(ev.data)));
    ['snapshot', 'state', 'log'].forEach(on);
    return () => es.close();
  }, [topic]);
}

/** Serial ports with a busy flag; reload() re-lists. */
export function usePorts() {
  const [ports, setPorts] = useState(null);
  const load = () => api.get('/api/diagnostics/ports').then(setPorts, () => setPorts([]));
  useEffect(() => {
    load();
  }, []);
  return { ports, reload: load };
}

/** Device select. extra: [{ value, label }] prepended (e.g. TRACE). */
export function PortSelect({ value, ports, onChange, extra = [], disabled, cls = '' }) {
  const list = [...extra, ...(ports ?? []).map((p) => ({ value: p.path, label: p.label + (p.busy ? ` (${p.busy})` : '') }))];
  if (value && !list.some((o) => o.value === value)) list.push({ value, label: value });
  return html`<select class=${cls} value=${value} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>
    ${!value && html`<option value="" selected>${ports === null ? 'Loading…' : list.length ? 'Choose a device' : 'No serial devices'}</option>`}
    ${list.map((o) => html`<option value=${o.value} selected=${o.value === value}>${o.label}</option>`)}
  </select>`;
}

export function BaudSelect({ value, onChange, disabled, cls = '' }) {
  return html`<select class=${cls} value=${value} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>
    ${BAUDS.map((b) => html`<option value=${b} selected=${String(value) === b}>${b}</option>`)}
  </select>`;
}

/** Spaced hex: "0103…" → "01 03 …". */
export const spacedHex = (hex) => (hex || '').replace(/(..)(?=.)/g, '$1 ');

// ---------- Shared developer-tool layout pieces ----------

/** Two-column tool layout: narrow connection column on the left, workspace on the right. */
export const ToolLayout = ({ side, children }) => html`<div class="dt-layout">
  <div class="dt-side">${side}</div>
  <div class="dt-main">${children}</div>
</div>`;

/** Card with an icon chip + title + one-line description in its head. */
export function ToolCard({ icon, tone = 'accent', title, sub, actions, cls = '', children }) {
  return html`<section class=${`card dt-card ${cls}`}>
    <header class="dt-head">
      ${icon && html`<${IconChip} name=${icon} tone=${tone} small />`}
      <div class="dt-head-text"><h2>${title}</h2>${sub && html`<p>${sub}</p>`}</div>
      ${actions && html`<div class="dt-head-actions">${actions}</div>`}
    </header>
    ${children}
  </section>`;
}

/** Connected / Disconnected pill with a status dot. */
export function ConnBadge({ connected, busy, error, on = 'Connected', off = 'Disconnected' }) {
  const kind = busy ? 'info' : error ? 'bad' : connected ? 'ok' : 'muted';
  const text = busy ? 'Working…' : error ? 'Error' : connected ? on : off;
  return html`<span class=${`badge badge-${kind} dt-badge`}><span class="dt-dot"></span>${text}</span>`;
}

/** Stacked label + control (used inside the narrow connection cards and toolbars). */
export const Fld = ({ label, help, cls = '', children }) => html`<label class=${`dt-f ${cls}`}>
  <span class="dt-f-label">${label}</span>${children}${help && html`<small class="help">${help}</small>`}
</label>`;

/** Segmented control that can be disabled. options: [{ value, label, icon? }] or strings. */
export function Seg({ value, options, onChange, disabled, label }) {
  return html`<div class=${`seg dt-seg ${disabled ? 'is-disabled' : ''}`} role="radiogroup" aria-label=${label}>
    ${options.map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const l = typeof o === 'string' ? o : o.label;
      return html`<button type="button" role="radio" aria-checked=${v === value} class=${v === value ? 'on' : ''} disabled=${disabled}
        onClick=${() => v !== value && onChange(v)}>${o.icon && html`<${Ic} name=${o.icon} size="sm" />`}${l}</button>`;
    })}
  </div>`;
}

/** Small subheading inside a workspace card, with optional right-side tools. */
export const SubHead = ({ title, children }) => html`<div class="dt-subhead"><h3>${title}</h3>${children && html`<div class="dt-tools">${children}</div>`}</div>`;

/** Empty state with an icon. */
export const ToolEmpty = ({ icon = 'inbox', title, children }) => html`<div class="empty dt-empty">
  <${Ic} name=${icon} size="lg" />${title && html`<b>${title}</b>`}${children && html`<span>${children}</span>`}
</div>`;

/** Inline error line. */
export const ErrorLine = ({ children }) => html`<div class="notice notice-bad dt-error"><${Ic} name="circle-alert" size="sm" /><span>${children}</span></div>`;

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const ARROW = { rx: 'arrow-down-left', tx: 'arrow-up-right', info: 'dot', error: 'circle-alert', miss: 'circle-help' };
const DIR_TITLE = { rx: 'Received', tx: 'Sent', info: 'Info', error: 'Error', miss: 'Unmatched' };

/** One log line (decoded text + optional hex). */
export function LogLine({ e, showHex, onPick }) {
  const kind = e.dir === 'error' || e.dir === 'miss' ? 'bad' : e.dir === 'info' ? 'muted' : e.type || 'string';
  return html`<div class=${`dg-line dg-${kind} dg-${e.dir}`} title=${e.hex ? 'Click to copy into Data' : ''} onClick=${() => e.hex && onPick?.(e)}>
    <span class="dg-time">${clock(e.ts)}</span>
    <span class="dg-dir" title=${DIR_TITLE[e.dir]}><${Ic} name=${ARROW[e.dir] ?? 'dot'} size="sm" /></span>
    <span class="dg-text">${e.text}</span>
    ${showHex && e.hex && html`<span class="dg-hex">${spacedHex(e.hex)}</span>`}
  </div>`;
}

/** Two-column log (left/right sides), rows in arrival order. */
export function SideLog({ entries, left, right, leftLabel, rightLabel, showHex, onPick, height = 460 }) {
  const box = useRef(null);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return html`<div class="dg-log" style=${`max-height:${height}px`} ref=${box}>
    <div class="dg-row dg-head"><div>${leftLabel}</div><div>${rightLabel}</div></div>
    ${entries.length === 0 && html`<div class="dg-empty"><${Ic} name="activity" /><span>No traffic yet</span></div>`}
    ${entries.map((e) => html`<div class="dg-row" key=${e.side + e.seq}>
      <div>${e.side === left && html`<${LogLine} e=${e} showHex=${showHex} onPick=${onPick} />`}</div>
      <div>${e.side === right && html`<${LogLine} e=${e} showHex=${showHex} onPick=${onPick} />`}</div>
    </div>`)}
  </div>`;
}

const run = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  }
};

const short = (path) => (path === 'TRACE' ? 'TRACE' : (path || '').replace(/^\/dev\//, '') || '–');

function Endpoint({ dev, st, ports, otherPath, onState, onPath }) {
  const [path, setPath] = useState(st.path);
  const [baud, setBaud] = useState(String(st.baud));
  const [busy, setBusy] = useState(false);
  useEffect(() => onPath(path), [path]);
  useEffect(() => {
    if (st.connected) {
      setPath(st.path);
      setBaud(String(st.baud));
    }
  }, [st.connected, st.path, st.baud]);
  useEffect(() => {
    if (!path && ports?.length && dev === 'dev1') setPath(ports.find((p) => !p.busy)?.path ?? ports[0].path);
  }, [ports]);
  const act = async (url, body) => {
    setBusy(true);
    const res = await run(() => api.post(url, body));
    setBusy(false);
    if (res) onState(res);
  };
  return html`<div class="card-section dt-end">
    <div class="dt-end-head">
      <span class="dt-end-name"><${Ic} name=${path === 'TRACE' ? 'file-text' : 'usb'} size="sm" />${dev === 'dev1' ? 'Device 1' : 'Device 2'}</span>
      <${ConnBadge} connected=${st.connected} busy=${busy} error=${st.error} />
    </div>
    <div class="dt-fgrid">
      <${Fld} label="Device" cls="dt-grow">
        <${PortSelect} value=${path} ports=${ports} disabled=${st.connected} onChange=${setPath}
          extra=${[{ value: 'TRACE', label: 'TRACE - Saved trace file' }]} />
      <//>
      <${Fld} label="Baud"><${BaudSelect} value=${baud} disabled=${st.connected || path === 'TRACE'} onChange=${setBaud} /><//>
    </div>
    <div class="dt-btns">
      ${st.connected
        ? html`<${Button} small kind="danger" disabled=${busy} onClick=${() => act('/api/diagnostics/inspect/disconnect', { dev })}><${Ic} name="unplug" size="sm" />Disconnect<//>`
        : html`<${Button} small kind="primary" disabled=${busy || !path} onClick=${() => act('/api/diagnostics/inspect/connect', { dev, path, baud: Number(baud) })}><${Ic} name="plug" size="sm" />${busy ? 'Connecting…' : 'Connect'}<//>`}
      ${st.pipe
        ? html`<${Button} small kind="danger" onClick=${() => act('/api/diagnostics/inspect/pipe', { dev, on: false })}><${Ic} name="square" size="sm" />Stop pipe to ${short(otherPath)}<//>`
        : html`<${Button} small onClick=${() => act('/api/diagnostics/inspect/pipe', { dev, on: true })}><${Ic} name="arrow-right-left" size="sm" />Pipe to ${short(otherPath)}<//>`}
    </div>
    ${st.error && html`<div class="text-bad small dt-end-err">${st.error}</div>`}
  </div>`;
}

export default function DiagSerialInspect() {
  const [st, setSt] = useState(null);
  const [log, setLog] = useState([]);
  const { ports } = usePorts();
  const [data, setData] = useState('');
  const [format, setFormat] = useState('auto');
  const [target, setTarget] = useState('dev1');
  const [split, setSplit] = useState('50');
  const [traceName, setTraceName] = useState('new.csv');
  const [traces, setTraces] = useState([]);
  const [showHex, setShowHex] = useState(true);
  const [sel, setSel] = useState({ dev1: '', dev2: 'TRACE' });

  const apply = (s) => {
    setSt((prev) => ({ ...prev, ...s }));
    if (s.log) setLog(s.log);
  };
  useDiagStream('inspect', {
    snapshot: (s) => {
      apply(s);
      setSplit(String(s.splitMs));
      setTraceName(s.trace.name);
    },
    state: (s) => setSt((prev) => ({ ...prev, ...s })),
    log: (e) => setLog((l) => (l.length && l[l.length - 1].seq >= e.seq ? l : [...l, e].slice(-500))),
  });
  const loadTraces = () => api.get('/api/diagnostics/inspect/traces').then(setTraces, () => {});
  useEffect(() => {
    loadTraces();
  }, []);

  if (!st) return html`<${Page} title="Serial inspector" crumbs=${CONFIG_CRUMBS}><div class="loading">Loading…</div><//>`;

  const send = async () => {
    const res = await run(() => api.post('/api/diagnostics/inspect/send', { dev: target, data, format }));
    if (res) toast(`Sent ${res.bytes} byte${res.bytes === 1 ? '' : 's'}`);
  };
  const setSplitMs = async (v) => {
    setSplit(v);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 10000) await run(() => api.post('/api/diagnostics/inspect/split', { ms: n }));
  };
  const trace = async (action) => {
    const res = await run(() => api.post(`/api/diagnostics/inspect/trace/${action}`, { name: traceName }));
    if (res) {
      apply(res);
      toast(action === 'save' ? 'Trace saved' : action === 'load' ? `Loaded ${res.trace.rows} rows` : 'Trace closed');
      loadTraces();
    }
  };
  const pick = (e) => {
    setData(spacedHex(e.hex));
    setFormat('hex');
    if (e.side === 'dev1' || e.side === 'dev2') setTarget(e.side);
  };
  const devLabel = (d) => short(st[d].connected ? st[d].path : sel[d]);
  const anyConnected = st.dev1.connected || st.dev2.connected;

  const side = html`
    <${ToolCard} icon="cable" title="Endpoints" sub="Two serial devices or the TRACE replay device" cls="dt-conn">
      <${Endpoint} dev="dev1" st=${st.dev1} ports=${ports} otherPath=${sel.dev2} onState=${apply} onPath=${(p) => setSel((x) => ({ ...x, dev1: p }))} />
      <${Endpoint} dev="dev2" st=${st.dev2} ports=${ports} otherPath=${sel.dev1} onState=${apply} onPath=${(p) => setSel((x) => ({ ...x, dev2: p }))} />
    <//>
    <${ToolCard} icon="file-text" tone="load" title="Trace" sub="Record traffic to CSV, or load one to replay through TRACE">
      <${Fld} label="File name">
        <input class="mono" list="dg-traces" value=${traceName} spellcheck="false" onInput=${(e) => setTraceName(e.target.value)} />
        <datalist id="dg-traces">${traces.map((t) => html`<option value=${t} />`)}</datalist>
      <//>
      <div class="dt-btns">
        <${Button} small kind="primary" disabled=${!traceName} onClick=${() => trace('load')}><${Ic} name="folder-open" size="sm" />Load<//>
        <${Button} small disabled=${!traceName || !st.trace.rows} onClick=${() => trace('save')}><${Ic} name="save" size="sm" />Save<//>
        ${(st.trace.loaded || st.trace.rows > 0) && html`<${Button} small kind="ghost" onClick=${() => trace('close')}>Close<//>`}
      </div>
      <div class="dt-meta">
        <span class=${`badge ${st.trace.loaded ? 'badge-info' : 'badge-muted'}`}>${st.trace.loaded ? 'Loaded' : 'Recording'}</span>
        <span class="num">${st.trace.rows} request${st.trace.rows === 1 ? '' : 's'}</span>${st.trace.loaded && html`<span class="mono">${st.trace.name}</span>`}
      </div>
    <//>`;

  return html`<${Page} title="Serial inspector" crumbs=${CONFIG_CRUMBS}>
    <${ToolLayout} side=${side}>
      <${ToolCard} icon="send" title="Send" sub="Type hex bytes or text; click a logged frame to copy it here">
        <div class="dt-sendbar">
          <div class="dt-input-ic dt-grow">
            <${Ic} name="terminal" size="sm" />
            <input id="dg-data" class="mono" aria-label="Data" value=${data} spellcheck="false" autocomplete="off"
              placeholder=${format === 'text' ? 'QPIGS\\r' : '01 03 00 00 00 0A'}
              onInput=${(e) => setData(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && data && st[target].connected && send()} />
          </div>
          <${Button} kind="primary" disabled=${!data || !st[target].connected} onClick=${send}><${Ic} name="send" size="sm" />Send<//>
        </div>
        <div class="dt-toolbar">
          <${Fld} label="To"><${Seg} label="Target" value=${target} onChange=${setTarget}
            options=${[{ value: 'dev1', label: devLabel('dev1') }, { value: 'dev2', label: devLabel('dev2') }]} /><//>
          <${Fld} label="Format"><${Seg} label="Format" value=${format} onChange=${setFormat}
            options=${[{ value: 'auto', label: 'Auto' }, { value: 'hex', label: 'Hex' }, { value: 'text', label: 'Text' }]} /><//>
          <${Fld} label="Split after" help="Silence that ends a frame">
            <span class="input-unit"><input id="dg-split" class="dt-num" type="number" min="1" max="10000" value=${split} onChange=${(e) => setSplitMs(e.target.value)} /><span class="muted small">ms</span></span>
          <//>
        </div>
        ${!st[target].connected && html`<p class="muted small dt-hint">${devLabel(target)} is not connected — connect it on the left to send.</p>`}
      <//>

      <${ToolCard} icon="activity" tone="battery" title="Traffic" sub=${anyConnected ? 'Live frames from both endpoints' : 'Connect an endpoint to see traffic'}
        actions=${html`<${Toggle} checked=${showHex} onChange=${setShowHex} label="Hex" />
          <${Button} small onClick=${() => run(() => api.post('/api/diagnostics/inspect/clear').then(apply))}><${Ic} name="eraser" size="sm" />Clear<//>`}>
        <${SideLog} entries=${log} left="dev1" right="dev2"
          leftLabel=${html`<span class="dg-side"><b>Device 1</b> ${short(st.dev1.connected ? st.dev1.path : sel.dev1)}</span>`}
          rightLabel=${html`<span class="dg-side"><b>Device 2</b> ${short(st.dev2.connected ? st.dev2.path : sel.dev2)}</span>`}
          showHex=${showHex} onPick=${pick} />
        ${st.misses?.length > 0 &&
        html`<div class="dt-sub-block">
          <${SubHead} title="Unmatched requests" />
          <div class="log dg-misses">${st.misses.slice(-30).map((m) => html`<div>${m}</div>`)}</div>
        </div>`}
      <//>
    <//>
  <//>`;
}

// ---------- Shared developer-tool CSS (injected once by whichever tool page loads first) ----------
const css = `
.dt-layout { display: grid; grid-template-columns: minmax(300px, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
.dt-side, .dt-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@media (max-width: 1100px) { .dt-layout { grid-template-columns: minmax(0, 1fr); } }
.dt-card { display: flex; flex-direction: column; gap: 14px; }
.dt-card > .card-section { margin: 0 -22px; padding: 16px 22px; border-top: 1px solid var(--border); }
.dt-card > .card-section:last-child { margin-bottom: -22px; }
.dt-card > .card-section + .card-section { margin-top: 0; }
@media (max-width: 560px) { .dt-card > .card-section { margin: 0 -18px; padding: 16px 18px; } .dt-card > .card-section:last-child { margin-bottom: -18px; } }
.dt-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* .chip-ic.accent also matches the legacy .accent notice rule in app.css; undo its box styles. */
.chip-ic.accent { padding: 0; margin: 0; border: 0; }
.dt-head-text { flex: 1; min-width: 0; }
.dt-head-text h2 { font-size: 15.5px; }
.dt-head-text p { margin: 1px 0 0; font-size: 12.5px; color: var(--muted); }
.dt-head-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 560px) { .dt-head { flex-wrap: wrap; } .dt-head-actions { width: 100%; justify-content: flex-start; } }
.dt-badge { gap: 6px; }
.dt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-ok .dt-dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.dt-f { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dt-f-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.dt-f input, .dt-f select { max-width: none; }
.dt-f .help { margin-top: -2px; }
.dt-fgrid { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 10px; }
.dt-fgrid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.dt-fgrid.one { grid-template-columns: minmax(0, 1fr); }
.dt-grow { flex: 1 1 auto; min-width: 0; }
.dt-btns { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dt-btns.end { justify-content: flex-end; }
.dt-btns .btn .ic, .dt-head-actions .btn .ic, .dt-sendbar .btn .ic, .dt-toolbar .btn .ic { margin-left: -3px; }
.dt-conn .dt-btns .btn-primary { box-shadow: none; }
.dt-end-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
.dt-end-name { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; color: var(--heading); }
.dt-end-name .ic { color: var(--muted); }
.dt-end .dt-btns { margin-top: 12px; }
.dt-end-err { margin-top: 8px; word-break: break-word; }
.dt-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12.5px; color: var(--muted); }
.dt-meta .mono { color: var(--text); word-break: break-all; }
.dt-toolbar { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: flex-start; }
.dt-toolbar .dt-f { flex: 0 1 auto; }
.dt-toolbar input:not([type=checkbox]), .dt-toolbar select { height: 36px; padding-top: 6px; padding-bottom: 6px; }
.dt-toolbar .dt-f select { width: auto; min-width: 140px; }
.dt-num { width: 96px; }
.dt-sendbar { display: flex; gap: 10px; align-items: center; }
.dt-input-ic { position: relative; display: flex; align-items: center; }
.dt-input-ic > .ic { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
.dt-input-ic input { padding-left: 36px; max-width: none; height: 40px; }
.dt-seg { flex-wrap: wrap; }
.dt-seg button { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dt-seg button:disabled { cursor: not-allowed; }
.dt-seg.is-disabled { opacity: .6; }
.dt-subhead { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.dt-subhead h3 { font-size: 13px; font-weight: 650; color: var(--heading); }
.dt-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dt-sub-block + .dt-sub-block { margin-top: 18px; }
.dt-out { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; word-break: break-all; white-space: pre-wrap; color: var(--text); min-height: 40px; }
.dt-out.placeholder { color: var(--faint); font-family: var(--font); font-size: 12.5px; }
.dt-out .badge { font-family: var(--font); margin-left: 6px; vertical-align: 1px; }
.dt-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 16px; }
.dt-empty .ic { color: var(--faint); }
.dt-empty b { color: var(--heading); font-weight: 650; }
.dt-empty span { font-size: 12.5px; max-width: 420px; }
.dt-error { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 13px; padding: 10px 12px; }
.dt-error .ic { margin-top: 2px; }
.dt-hint { margin: 0; }
.dt-scroll { max-height: 520px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.dt-scroll .table th { z-index: 1; }
.dt-table td.mono, .dt-table th.mono { font-family: var(--mono); font-size: 12.5px; }
.dt-table td.hex { font-family: var(--mono); font-size: 12.5px; color: var(--accent-text); }
.dt-table td.idx { color: var(--muted); }
.dt-table td.l, .dt-table th.l { text-align: left; }
.dt-table td { padding-top: 8px; padding-bottom: 8px; }
.dt-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1280px) { .dt-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) {
  .dt-sendbar { flex-direction: column; align-items: stretch; }
  .dt-toolbar { gap: 12px; }
  .dt-toolbar .dt-f { flex: 1 1 100%; }
}

/* Side-by-side traffic log */
.dg-log { overflow: auto; font-family: var(--mono); font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.dg-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.dg-row > div { padding: 0 10px; min-width: 0; }
.dg-row > div:first-child { border-right: 1px solid var(--border); }
.dg-head { position: sticky; top: 0; z-index: 1; background: var(--surface-3); font-family: var(--font); font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); }
.dg-head > div { padding: 8px 10px; }
.dg-side b { color: var(--heading); font-weight: 650; margin-right: 4px; }
.dg-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 10px; color: var(--muted); font-family: var(--font); font-size: 12.5px; }
.dg-empty .ic { color: var(--faint); }
.dg-line { display: flex; flex-wrap: wrap; gap: 0 8px; padding: 3px 4px; margin: 0 -4px; border-radius: 6px; cursor: default; word-break: break-all; align-items: center; }
.dg-line[title^="Click"] { cursor: pointer; }
.dg-line:hover { background: var(--surface); }
.dg-time { color: var(--faint); }
.dg-dir { display: inline-flex; color: var(--muted); }
.dg-tx .dg-dir { color: var(--accent); }
.dg-rx .dg-dir { color: var(--battery); }
.dg-dir .ic { width: 13px; height: 13px; }
.dg-text { flex: 1; min-width: 0; color: var(--text); }
.dg-hex { flex-basis: 100%; color: var(--muted); padding-left: 82px; }
.dg-modbus .dg-text { color: #2c4fb8; }
.dg-voltronic .dg-text { color: #8a5a00; }
.dg-bad .dg-text, .dg-bad .dg-dir { color: var(--bad); }
.dg-muted .dg-text { color: var(--muted); font-style: italic; }
.dg-misses { max-height: 160px; color: var(--bad); }
@media (max-width: 560px) { .dg-hex { padding-left: 0; } .dg-time { display: none; } }
`;
if (!document.getElementById('css-dev-tools')) {
  const el = document.createElement('style');
  el.id = 'css-dev-tools';
  el.textContent = css;
  document.head.appendChild(el);
}
