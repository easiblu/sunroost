// Protocol broker: emulate a Modbus / Voltronic / Narada device (or proxy and rewrite a real one).
// Left: pick a saved broker or a new one, Start, connect the From (master) and To (slave) ports.
// Right: edit the register grids or response tables live, watch the traffic, and Save.
import { api, html, useEffect, useRef, useState } from '../lib/core.js';
import { Button, confirmAction, Ic, Page, Toggle, toast } from '../lib/ui.js';
import {
  BaudSelect, CONFIG_CRUMBS, ConnBadge, Fld, PortSelect, SideLog, ToolCard, ToolEmpty, ToolLayout, useDiagStream, usePorts,
} from './diag-serial-inspect.js';

const NEW = [
  { value: 'new:modbus', label: '--- New modbus ---' },
  { value: 'new:voltronic', label: '--- New Voltronic ---' },
  { value: 'new:narada', label: '--- New Narada ---' },
];
const FN_NAME = { 4: 'input', 3: 'holding' };

const run = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  }
};

function PortControls({ title, side, cfg, st, ports, onState, extra }) {
  const [path, setPath] = useState(cfg.path);
  const [baud, setBaud] = useState(String(cfg.baud));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPath(cfg.path);
    setBaud(String(cfg.baud));
  }, [cfg.path, cfg.baud]);
  const act = async (url, body) => {
    setBusy(true);
    const res = await run(() => api.post(url, body));
    setBusy(false);
    if (res) onState(res);
  };
  return html`<div class="card-section dt-end">
    <div class="dt-end-head">
      <span class="dt-end-name"><${Ic} name=${side === 'from' ? 'arrow-down-left' : 'arrow-up-right'} size="sm" />${title}</span>
      <${ConnBadge} connected=${st.connected} busy=${busy} error=${st.error} />
    </div>
    <div class="dt-fgrid">
      <${Fld} label="Device"><${PortSelect} value=${path} ports=${ports} disabled=${st.connected} onChange=${setPath} /><//>
      <${Fld} label="Baud"><${BaudSelect} value=${baud} disabled=${st.connected} onChange=${setBaud} /><//>
    </div>
    <div class="dt-btns">
      ${st.connected
        ? html`<${Button} small kind="danger" disabled=${busy} onClick=${() => act('/api/diagnostics/broker/disconnect', { side })}><${Ic} name="unplug" size="sm" />Disconnect<//>`
        : html`<${Button} small kind="primary" disabled=${busy || !path} onClick=${() => act('/api/diagnostics/broker/connect', { side, path, baud: Number(baud) })}><${Ic} name="plug" size="sm" />${busy ? 'Connecting…' : 'Connect'}<//>`}
      ${extra}
    </div>
    ${st.error && html`<div class="text-bad small dt-end-err">${st.error}</div>`}
  </div>`;
}

const toCell = (v, hex) => (v === null || v === undefined ? '' : hex ? '0x' + ((v < 0 ? v + 0x10000 : v) & 0xffff).toString(16).toUpperCase().padStart(4, '0') : String(v));
function fromCell(text) {
  const t = text.trim();
  if (!t) return null;
  const n = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : Number(t);
  return Number.isInteger(n) ? n : undefined;
}

function RegisterGrid({ table, index, hex, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...table, [k]: v });
  const resize = (n) => {
    const count = Math.max(1, Math.min(1000, Number(n) || 1));
    const values = table.values.slice(0, count);
    while (values.length < count) values.push(null);
    set('values', values);
  };
  const rows = [];
  for (let i = 0; i < table.values.length; i += 10) rows.push(i);
  return html`<div class="bk-table">
    <div class="bk-table-head">
      <div class="bk-table-title">
        <span class="badge badge-accent num">${table.address}</span>
        <h3>${FN_NAME[table.fn] === 'input' ? 'Input' : 'Holding'} registers</h3>
        <span class="muted small num">${table.start}–${table.start + table.values.length - 1}${table.respondAddress !== null && table.respondAddress !== undefined ? ` · responds as ${table.respondAddress}` : ''}</span>
      </div>
      <${Button} small kind="ghost" onClick=${onRemove}><${Ic} name="trash-2" size="sm" />Remove<//>
    </div>
    <div class="dt-toolbar bk-meta">
      <${Fld} label="Address"><input class="num" type="number" min="0" max="255" value=${table.address} onChange=${(e) => set('address', Number(e.target.value))} /><//>
      <${Fld} label="Function"><select value=${table.fn} onChange=${(e) => set('fn', Number(e.target.value))}>
        <option value="4" selected=${table.fn === 4}>Input register (4)</option>
        <option value="3" selected=${table.fn === 3}>Holding register (3)</option>
      </select><//>
      <${Fld} label="Start"><input class="num" type="number" min="0" max="65535" value=${table.start} onChange=${(e) => set('start', Number(e.target.value))} /><//>
      <${Fld} label="Count"><input class="num" type="number" min="1" max="1000" value=${table.values.length} onChange=${(e) => resize(e.target.value)} /><//>
      <${Fld} label="Respond address"><input class="num" type="number" min="0" max="255" placeholder="same" value=${table.respondAddress ?? ''}
        onChange=${(e) => set('respondAddress', e.target.value === '' ? null : Number(e.target.value))} /><//>
    </div>
    <div class="table-wrap bk-grid-wrap"><table class="bk-grid">
      <thead><tr><th></th>${Array.from({ length: Math.min(10, table.values.length) }, (_, j) => html`<th>+${j}</th>`)}</tr></thead>
      <tbody>
        ${rows.map((r) => html`<tr>
          <th>${table.start + r}</th>
          ${table.values.slice(r, r + 10).map((v, j) => html`<td>
            <input class=${`mono ${v === null ? 'bk-empty' : ''}`} value=${toCell(v, hex)} placeholder="–" title=${`Register ${table.start + r + j}`}
              onChange=${(e) => {
                const n = fromCell(e.target.value);
                if (n === undefined || (n !== null && (n < -32768 || n > 100000))) {
                  toast('Enter a whole number (or empty to pass through)', 'bad');
                  e.target.value = toCell(v, hex);
                  return;
                }
                const values = [...table.values];
                values[r + j] = n;
                set('values', values);
              }} />
          </td>`)}
        </tr>`)}
      </tbody>
    </table></div>
  </div>`;
}

function Responses({ rows, onChange }) {
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div>
    <div class="table-wrap"><table class="table dt-table bk-resp">
      <thead><tr><th>Request</th><th class="l">Response</th><th></th></tr></thead>
      <tbody>
        ${rows.length === 0 && html`<tr><td colspan="3" class="bk-none">No responses yet. Unknown requests are forwarded to the To device and learned here.</td></tr>`}
        ${rows.map((r, i) => html`<tr>
          <td><input class="mono" value=${r.request} placeholder="QPIGS" onChange=${(e) => set(i, 'request', e.target.value)} /></td>
          <td class="l"><input class="mono" value=${r.response} onChange=${(e) => set(i, 'response', e.target.value)} /></td>
          <td><button type="button" class="icon-btn bk-x" aria-label="Remove response" title="Remove" onClick=${() => onChange(rows.filter((_, j) => j !== i))}><${Ic} name="trash-2" size="sm" /></button></td>
        </tr>`)}
      </tbody>
    </table></div>
    <div class="form-actions"><${Button} small onClick=${() => onChange([...rows, { request: '', response: '' }])}><${Ic} name="plus" size="sm" />Add response<//></div>
  </div>`;
}

export default function DiagBroker() {
  const [list, setList] = useState([]);
  const [choice, setChoice] = useState('new:modbus');
  const [st, setSt] = useState(null);
  const [draft, setDraft] = useState(null);
  const [log, setLog] = useState([]);
  const [hex, setHex] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ports } = usePorts();
  const editedAt = useRef(0);
  const pushTimer = useRef(null);

  const loadList = () => api.get('/api/diagnostics/brokers').then(setList, () => {});
  useEffect(() => {
    loadList();
  }, []);

  const adopt = (s) => {
    setSt((prev) => ({ ...prev, ...s }));
    // Don't clobber what the user is typing; take server data (learned rows, writes) once idle.
    if (s.config && Date.now() - editedAt.current > 1500) setDraft(s.config);
    if (!s.config) setDraft(null);
    if (s.master || s.slave) setLog([...(s.master ?? []), ...(s.slave ?? [])].sort((a, b) => a.ts - b.ts || a.seq - b.seq));
    if (s.config?.id) setChoice(String(s.config.id));
  };
  useDiagStream('broker', {
    snapshot: adopt,
    state: adopt,
    log: (e) => setLog((l) => [...l, e].slice(-600)),
  });

  const edit = (partial) => {
    editedAt.current = Date.now();
    const next = { ...draft, ...partial };
    setDraft(next);
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      run(() => api.put('/api/diagnostics/broker/data', { name: next.name, tables: next.tables, responses: next.responses }));
    }, 300);
  };

  const start = async () => {
    setBusy(true);
    const body = choice.startsWith('new:') ? { type: choice.slice(4) } : { id: Number(choice) };
    const res = await run(() => api.post('/api/diagnostics/broker/start', body));
    setBusy(false);
    if (res) {
      editedAt.current = 0;
      adopt(res);
    }
  };
  const stop = async () => {
    const res = await run(() => api.post('/api/diagnostics/broker/stop'));
    if (res) adopt(res);
  };
  const save = async () => {
    if (!draft?.name) return toast('Enter a name first', 'bad');
    clearTimeout(pushTimer.current);
    await run(() => api.put('/api/diagnostics/broker/data', { name: draft.name, tables: draft.tables, responses: draft.responses }));
    const res = await run(() => api.post('/api/diagnostics/broker/save'));
    if (res) {
      toast('Broker saved');
      editedAt.current = 0;
      adopt(res);
      setChoice(String(res.saved.id));
      loadList();
    }
  };
  const remove = async () => {
    if (!draft?.id || !confirmAction(`Delete broker "${draft.name}"?`)) return;
    if (await run(() => api.del(`/api/diagnostics/brokers/${draft.id}`))) {
      toast('Broker deleted');
      setChoice('new:modbus');
      loadList();
    }
  };

  const running = Boolean(st?.running && draft);
  const options = [...list.map((b) => ({ value: String(b.id), label: `${b.name} (${b.type})` })), ...NEW];
  const typeName = (t) => (t === 'modbus' ? 'Modbus' : t === 'voltronic' ? 'Voltronic' : 'Narada');
  const setWrite = (on) => run(() => api.post('/api/diagnostics/broker/allow-write', { on })).then((r) => r && adopt(r));

  const side = html`
    <${ToolCard} icon="waypoints" title="Broker" sub="Emulate a device, or proxy and rewrite a real one"
      actions=${html`<${ConnBadge} connected=${running} on="Running" off="Stopped" />`}>
      <${Fld} label="Broker">
        <select id="bk-pick" value=${choice} disabled=${running} onChange=${(e) => setChoice(e.target.value)}>
          ${options.map((o) => html`<option value=${o.value} selected=${o.value === choice}>${o.label}</option>`)}
        </select>
      <//>
      ${running &&
      html`<${Fld} label="Name"><input id="bk-name" value=${draft.name} placeholder=${`My ${draft.type} broker`} onInput=${(e) => edit({ name: e.target.value })} /><//>
        <div class="bk-stats">
          <div><span>Type</span><b>${typeName(draft.type)}</b></div>
          <div><span>Requests</span><b class="num">${st.stats.requests}</b></div>
          <div><span>Answered</span><b class="num">${st.stats.answered}</b></div>
          <div><span>Forwarded</span><b class="num">${st.stats.forwarded}</b></div>
        </div>`}
      <div class="dt-btns end">
        ${running
          ? html`${draft.id && html`<${Button} kind="ghost" onClick=${remove}><${Ic} name="trash-2" size="sm" />Delete<//>`}
              <${Button} kind="danger" onClick=${stop}><${Ic} name="circle-stop" size="sm" />Stop<//>
              <${Button} kind="primary" onClick=${save}><${Ic} name="save" size="sm" />Save<//>`
          : html`<${Button} kind="primary" disabled=${busy || !st} onClick=${start}><${Ic} name="circle-play" size="sm" />Start<//>`}
      </div>
    <//>
    ${running &&
    html`<${ToolCard} icon="cable" tone="load" title="Ports" sub="Master talks to From; To is the real device (optional)">
      <${PortControls} title="From (master)" side="from" cfg=${draft.from} st=${st.from} ports=${ports} onState=${adopt} />
      <${PortControls} title="To (slave)" side="to" cfg=${draft.to} st=${st.to} ports=${ports} onState=${adopt} />
      <div class="card-section bk-write">
        <${Toggle} checked=${Boolean(draft.allowWrite)} onChange=${setWrite} label="Allow writes" />
        <p class="muted small">${draft.allowWrite ? 'Master writes are passed through to the To device.' : 'Master writes are acknowledged locally and not passed through.'}</p>
      </div>
    <//>`}`;

  return html`<${Page} title="Brokers" crumbs=${CONFIG_CRUMBS}>
    <${ToolLayout} side=${side}>
      ${!running &&
      html`<${ToolCard} icon="waypoints" title="Workspace" sub="Register grids, responses and live traffic">
        <${ToolEmpty} icon="waypoints" title=${st ? 'No broker running' : 'Loading…'}>
          Pick a saved broker or a new Modbus, Voltronic or Narada one and press Start. You can then connect ports, edit the data live and Save.
        <//>
      <//>`}
      ${running &&
      (draft.type === 'modbus'
        ? html`<${ToolCard} icon="table" title="Registers"
            sub="Empty cells pass through to the To device (or answer 0 when it isn't connected). Addresses without a grid are forwarded."
            actions=${html`<${Toggle} checked=${hex} onChange=${setHex} label="Hex" />
              <${Button} small onClick=${() => {
                const last = draft.tables[draft.tables.length - 1];
                edit({ tables: [...draft.tables, { address: last?.address ?? 1, fn: last?.fn === 4 ? 3 : 4, start: 0, values: Array(20).fill(null), respondAddress: null }] });
              }}><${Ic} name="plus" size="sm" />Add grid<//>`}>
            ${draft.tables.length === 0 && html`<${ToolEmpty} icon="table" title="No register grids">Every request is forwarded. Add a grid to answer registers locally.<//>`}
            ${draft.tables.map((t, i) => html`<${RegisterGrid} key=${i} table=${t} index=${i} hex=${hex}
              onChange=${(nt) => edit({ tables: draft.tables.map((x, j) => (j === i ? nt : x)) })}
              onRemove=${() => edit({ tables: draft.tables.filter((_, j) => j !== i) })} />`)}
          <//>`
        : html`<${ToolCard} icon="list" title="Responses" sub="Request → response pairs answered locally">
            <${Responses} rows=${draft.responses} onChange=${(responses) => edit({ responses })} />
          <//>`)}
      ${running &&
      html`<${ToolCard} icon="activity" tone="battery" title="Traffic" sub="Master and slave frames in arrival order">
        <${SideLog} entries=${log} left="master" right="slave"
          leftLabel=${html`<span class="dg-side"><b>Master</b> From</span>`} rightLabel=${html`<span class="dg-side"><b>Slave</b> To</span>`} showHex=${true} />
      <//>`}
    <//>
  <//>`;
}

const css = `
.bk-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.bk-stats > div { background: var(--surface-2); border-radius: var(--radius-sm); padding: 8px 10px; min-width: 0; }
.bk-stats span { display: block; font-size: 11px; font-weight: 600; color: var(--muted); }
.bk-stats b { font-size: 15px; color: var(--heading); }
.bk-write p { margin: 6px 0 0; }
.bk-table + .bk-table { margin-top: 10px; padding-top: 18px; border-top: 1px solid var(--border); }
.bk-table-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
.bk-table-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.bk-table-title h3 { font-size: 14px; }
.bk-meta { margin-bottom: 12px; }
.bk-meta input { width: 96px; }
.bk-meta select { width: auto; }
.bk-grid-wrap { background: var(--surface-2); border: 1px solid var(--border); padding: 8px; }
.bk-grid { border-collapse: separate; border-spacing: 3px; font-size: 12px; font-variant-numeric: tabular-nums; }
.bk-grid th { font-weight: 600; padding: 0 6px; text-align: right; color: var(--muted); font-size: 11px; }
.bk-grid thead th { text-align: center; }
.bk-grid td { padding: 0; }
.bk-grid input { width: 62px; min-width: 0; padding: 4px 6px; font-size: 12px; border-radius: 6px; text-align: right; }
.bk-grid input.bk-empty { background: transparent; border-style: dashed; }
.bk-resp td { padding-top: 6px; padding-bottom: 6px; }
.bk-resp td:first-child input { min-width: 140px; }
.bk-resp td.l input { min-width: 220px; max-width: none; }
.bk-resp td.bk-none { white-space: normal; color: var(--muted); text-align: center; padding: 22px 12px; }
.bk-x { width: 32px; height: 32px; color: var(--muted); }
.bk-x:hover { color: var(--bad); }
@media (max-width: 560px) { .bk-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dt-toolbar.bk-meta .dt-f { flex: 1 1 40%; } .bk-meta input, .bk-meta select { width: 100%; } }
`;
if (!document.getElementById('css-diag-broker')) {
  const el = document.createElement('style');
  el.id = 'css-diag-broker';
  el.textContent = css;
  document.head.appendChild(el);
}
