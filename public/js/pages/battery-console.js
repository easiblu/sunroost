// Serial BMS console (Pylontech-style ASCII-hex protocol): connection + request on the left; on the
// right the request/response frames, a field map decoder with adjustable offset, cell count and
// temperature count, and a 16-bit byte table.
import { api, html, useEffect, useState } from '../lib/core.js';
import { Button, Ic, Page, Toggle, toast } from '../lib/ui.js';
import {
  BaudSelect, CONFIG_CRUMBS, ConnBadge, Fld, PortSelect, SubHead, ToolCard, ToolEmpty, ToolLayout, usePorts,
} from './diag-serial-inspect.js';

const u16 = (b, i) => (i + 1 < b.length ? (b[i] << 8) | b[i + 1] : null);
const s16 = (b, i) => {
  const v = u16(b, i);
  return v === null ? null : v > 0x7fff ? v - 0x10000 : v;
};
const u24 = (b, i) => (i + 2 < b.length ? (b[i] << 16) | (b[i + 1] << 8) | b[i + 2] : null);
const fix = (v, scale, digits) => (v === null || v === undefined ? '' : (v * scale).toFixed(digits));
const range = (a, b) => (a === b ? `index ${a}` : `index ${a} - ${b}`);

/** Field map for one pack block, given where the INFO data starts (offset) and the counts. */
export function fieldMap(bytes, offset, cells, temps) {
  const o = offset;
  const t0 = o + 9 + cells * 2;
  const c = t0 + 1 + temps * 2;
  const cellValues = Array.from({ length: cells }, (_, i) => u16(bytes, o + 9 + i * 2)).filter((v) => v !== null);
  const tempValues = Array.from({ length: temps }, (_, i) => s16(bytes, t0 + 1 + i * 2)).filter((v) => v !== null);
  const hex2 = (i) => (i < bytes.length ? bytes[i].toString(16).toUpperCase().padStart(2, '0') : '');
  return [
    ['Header (VER,ADR,CID1,CID2,LEN)', range(o, o + 5), [0, 1, 2, 3, 4, 5].map((i) => hex2(o + i)).join(' ')],
    ['Pack count', range(o + 7, o + 7), bytes[o + 7] ?? ''],
    ['Cell voltage count', range(o + 8, o + 8), bytes[o + 8] ?? ''],
    ['Cell voltage values', `${range(o + 9, o + 8 + cells * 2)} (length ${cells} x 2)`, cellValues.map((v) => (v / 1000).toFixed(3)).join(' ')],
    ['Cell temperature count', range(t0, t0), bytes[t0] ?? ''],
    ['Cell temperature values', `${range(t0 + 1, t0 + temps * 2)} (length ${temps} x 2)`, tempValues.map((v) => ((v - 2731) / 10).toFixed(1) + '°').join(' ')],
    ['Current (0.1A)', range(c, c), fix(s16(bytes, c), 0.1, 1)],
    ['Voltage (0.001V)', range(c + 2, c + 2), fix(u16(bytes, c + 2), 0.001, 3)],
    ['Capacity remain (0.001AH)', range(c + 4, c + 4), fix(u16(bytes, c + 4), 0.001, 3)],
    ['User defined count', range(c + 6, c + 6), bytes[c + 6] ?? ''],
    ['Capacity total (0.001AH)', range(c + 7, c + 7), fix(u16(bytes, c + 7), 0.001, 3)],
    ['Cycles', range(c + 9, c + 9), u16(bytes, c + 9) ?? ''],
    ['Capacity remain 24-bit (0.001AH)', range(c + 11, c + 11), fix(u24(bytes, c + 11), 0.001, 3)],
    ['Capacity total 24-bit (0.001AH)', range(c + 14, c + 14), fix(u24(bytes, c + 14), 0.001, 3)],
    ['Next battery cell count', range(c + 17, c + 17), bytes[c + 17] ?? ''],
  ];
}

export default function BatteryConsole() {
  const { ports } = usePorts();
  const [conn, setConn] = useState(null);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState('9600');
  const [req, setReq] = useState({ protocol: '20', address: '02', unit: 'FF' });
  const [simulate, setSimulate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [dec, setDec] = useState({ offset: '0', cells: '15', temps: '5' });

  useEffect(() => {
    api.get('/api/diagnostics/bms').then((s) => {
      setConn(s);
      if (s.connected) {
        setPath(s.path);
        setBaud(String(s.baud));
      }
    }, () => setConn({ connected: false }));
  }, []);
  useEffect(() => {
    if (!path && ports?.length) setPath(ports.find((p) => !p.busy)?.path ?? ports[0].path);
  }, [ports]);

  const call = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      toast(err.message, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    const s = await call(() => api.post('/api/diagnostics/bms/connect', { path, baud: Number(baud) }));
    if (s) setConn(s);
  };
  const disconnect = async () => {
    const s = await call(() => api.post('/api/diagnostics/bms/disconnect'));
    if (s) setConn(s);
  };
  const submit = async () => {
    const r = await call(() => api.post('/api/diagnostics/bms/submit', { ...req, simulate }));
    if (r) setResult(r);
  };

  const bytes = result?.bytes ?? [];
  const offset = Math.max(0, Number(dec.offset) || 0);
  const cells = Math.max(0, Math.min(64, Number(dec.cells) || 0));
  const temps = Math.max(0, Math.min(32, Number(dec.temps) || 0));
  const map = fieldMap(bytes, offset, cells, temps);
  const rows = [];
  for (let i = offset; i < bytes.length; i++) rows.push(i);
  const connected = Boolean(conn?.connected);
  const setR = (k) => (e) => setReq({ ...req, [k]: e.target.value });
  const setD = (k) => (e) => setDec({ ...dec, [k]: e.target.value });
  const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

  const side = html`
    <${ToolCard} icon="cable" title="Connection" sub="RS232 / RS485 port of the battery BMS"
      actions=${html`<${ConnBadge} connected=${connected} busy=${busy && !result} />`}>
      <div class="dt-fgrid">
        <${Fld} label="Device"><${PortSelect} value=${path} ports=${ports} disabled=${connected} onChange=${setPath} /><//>
        <${Fld} label="Baud"><${BaudSelect} value=${baud} disabled=${connected} onChange=${setBaud} /><//>
      </div>
      <div class="dt-btns end">
        ${connected
          ? html`<${Button} kind="danger" disabled=${busy} onClick=${disconnect}><${Ic} name="unplug" size="sm" />Disconnect<//>`
          : html`<${Button} kind="primary" disabled=${busy || !path} onClick=${connect}><${Ic} name="plug" size="sm" />Connect<//>`}
      </div>
    <//>
    <${ToolCard} icon="battery-charging" tone="battery" title="Request" sub="Analogue values command (CID2 42)">
      <div class="dt-fgrid three">
        <${Fld} label="Protocol"><input class="mono" value=${req.protocol} maxlength="2" spellcheck="false" onInput=${setR('protocol')} /><//>
        <${Fld} label="Address"><input class="mono" value=${req.address} maxlength="2" spellcheck="false" onInput=${setR('address')} /><//>
        <${Fld} label="Unit"><input class="mono" value=${req.unit} maxlength="2" spellcheck="false" onInput=${setR('unit')} /><//>
      </div>
      <div class="bc-submit">
        <${Toggle} checked=${simulate} onChange=${setSimulate} label="Simulation response" />
        <${Button} kind="primary" disabled=${busy || (!connected && !simulate)} onClick=${submit}>
          <${Ic} name="send" size="sm" />${connected || simulate ? 'Submit' : 'Not connected'}
        <//>
      </div>
    <//>`;

  return html`<${Page} title="Serial BMS console" crumbs=${CONFIG_CRUMBS}>
    <${ToolLayout} side=${side}>
      <${ToolCard} icon="arrow-right-left" title="Frames" sub=${result ? `${bytes.length} data bytes` : 'Request sent and reply received'}
        actions=${result?.checksumOk === true ? html`<span class="badge badge-ok"><${Ic} name="circle-check" size="sm" />Checksum OK</span>`
          : result?.checksumOk === false ? html`<span class="badge badge-bad"><${Ic} name="circle-x" size="sm" />Checksum mismatch</span>` : null}>
        ${result
          ? html`<div class="dt-sub-block"><${SubHead} title="Request" /><pre class="dt-out">${JSON.stringify(result.request)}</pre></div>
            <div class="dt-sub-block"><${SubHead} title="Response" /><pre class="dt-out">${JSON.stringify(result.response ?? '')}</pre></div>`
          : html`<${ToolEmpty} icon="battery-charging" title="No reply yet">${connected ? 'Submit a request to read the BMS.' : 'Connect, or tick Simulation response to try the decoder.'}<//>`}
      <//>

      <${ToolCard} icon="binary" tone="load" title="Decoder" sub="Field map for one pack block; adjust where the data starts"
        actions=${html`<div class="bc-dec">
          <label>Offset <input class="num" type="number" min="0" value=${dec.offset} onInput=${setD('offset')} /></label>
          <label>Cells <input class="num" type="number" min="0" max="64" value=${dec.cells} onInput=${setD('cells')} /></label>
          <label>Temps <input class="num" type="number" min="0" max="32" value=${dec.temps} onInput=${setD('temps')} /></label>
        </div>`}>
        <div class="table-wrap"><table class="table dt-table bc-map">
          <thead><tr><th>Field</th><th class="l">Bytes</th><th class="l">Value</th></tr></thead>
          <tbody>${map.map(([label, where, value]) => html`<tr>
            <td>${label}</td><td class="l idx">${where}</td><td class="l mono bc-val">${bytes.length ? String(value) : html`<span class="muted">–</span>`}</td>
          </tr>`)}</tbody>
        </table></div>
      <//>

      <${ToolCard} icon="table" title="Bytes" sub="Each index read as a 16-bit word (high, low)">
        ${bytes.length
          ? html`<div class="table-wrap dt-scroll"><table class="table dt-table">
              <thead><tr><th>Index</th><th>High</th><th>Low</th><th>Signed</th><th>Unsigned</th></tr></thead>
              <tbody>
                ${rows.map((i) => html`<tr>
                  <td class="idx">${i}</td>
                  <td class="hex">${h2(bytes[i])}</td>
                  <td class="hex">${i + 1 < bytes.length ? h2(bytes[i + 1]) : ''}</td>
                  <td>${s16(bytes, i) ?? ''}</td>
                  <td>${u16(bytes, i) ?? bytes[i]}</td>
                </tr>`)}
              </tbody>
            </table></div>`
          : html`<${ToolEmpty} icon="table" title="No bytes">The reply's data bytes appear here.<//>`}
      <//>
    <//>
  <//>`;
}

const css = `
.bc-submit { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.bc-dec { display: flex; gap: 10px; flex-wrap: wrap; }
.bc-dec label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.bc-dec input { width: 64px; height: 32px; padding: 4px 8px; }
.bc-map td:first-child { color: var(--heading); font-weight: 550; }
.bc-map td.bc-val { white-space: normal; word-break: break-word; min-width: 160px; }
`;
if (!document.getElementById('css-battery-console')) {
  const el = document.createElement('style');
  el.id = 'css-battery-console';
  el.textContent = css;
  document.head.appendChild(el);
}
