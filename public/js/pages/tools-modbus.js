// Modbus console: a connection card (Serial (RTU) / Network (TCP), or the connected inverter) with
// Connect/Disconnect on the left, and a query workspace (Address, Function, Start, Limit) showing
// Raw, Metrics and Response on the right. `ModbusQuery` is also used by the inverter console page
// for Modbus drivers.
import { api, html, useApi, useEffect, useState } from '../lib/core.js';
import { Button, confirmAction, Ic, Notice, Page, Select, toast } from '../lib/ui.js';
import {
  BaudSelect, CONFIG_CRUMBS, ConnBadge, ErrorLine, Fld, PortSelect, Seg, SubHead, ToolCard, ToolEmpty, ToolLayout, usePorts,
} from './diag-serial-inspect.js';

const DEFAULT_FUNCTIONS = [
  { id: '4', name: 'Input register' },
  { id: '3', name: 'Holding register' },
];
const hex4 = (v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');
const signed = (v) => (v > 0x7fff ? v - 0x10000 : v);

/** Raw reply bytes, register table and decoded metrics. */
function ModbusResult({ result }) {
  const decoded = result.decoded && Object.keys(result.decoded).length ? Object.entries(result.decoded) : null;
  return html`
    <div class="dt-sub-block">
      <${SubHead} title="Raw">
        <span class="badge badge-muted num">${result.registers.length} register${result.registers.length === 1 ? '' : 's'}</span>
      <//>
      <pre class="dt-out">${result.raw}</pre>
    </div>
    <div class="dt-split dt-sub-block">
      <div>
        <${SubHead} title="Response" />
        <div class="table-wrap dt-scroll"><table class="table dt-table">
          <thead><tr><th>Index</th><th>Register</th><th>Value</th><th>Hex</th><th>Signed</th></tr></thead>
          <tbody>${result.registers.map((v, i) => html`<tr>
            <td class="idx">${i}</td><td>${result.start + i}</td><td>${v}</td><td class="hex">${hex4(v)}</td><td>${signed(v)}</td>
          </tr>`)}</tbody>
        </table></div>
      </div>
      <div>
        <${SubHead} title="Metrics" />
        ${decoded
          ? html`<div class="table-wrap dt-scroll"><table class="table dt-table"><thead><tr><th>Name</th><th>Value</th></tr></thead>
              <tbody>${decoded.map(([k, v]) => html`<tr><td>${k}</td><td class="mono">${String(v)}</td></tr>`)}</tbody></table></div>`
          : html`<${ToolEmpty} icon="binary" title="Nothing decoded">No known registers in this range.<//>`}
      </div>
    </div>`;
}

/**
 * Query form + results. mode 'device' reads through the running inverter driver (address = inverter
 * index); mode 'direct' reads through the console connection (address = Modbus unit id 0..32).
 */
export function ModbusQuery({ title, mode, ready, functions = DEFAULT_FUNCTIONS, inverters = 1, models = [], defaultModel = '', allowWrite }) {
  const [q, setQ] = useState({ address: mode === 'device' ? '0' : '1', fn: functions[0]?.id ?? '4', start: '0', count: '50', model: defaultModel });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [write, setWrite] = useState({ start: '', values: '' });
  useEffect(() => setQ((s) => ({ ...s, model: defaultModel })), [defaultModel]);
  const set = (k) => (v) => setQ((s) => ({ ...s, [k]: typeof v === 'string' ? v : v.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const start = Number(q.start);
    const count = Number(q.count);
    try {
      const res =
        mode === 'device'
          ? await api.post('/api/tools/modbus/read', { source: 'device', index: Number(q.address), fn: Number(q.fn), start, count })
          : await api.post('/api/diagnostics/modbus/query', { address: Number(q.address), fn: Number(q.fn), start, count, model: q.model || undefined });
      const raw = res.raw ?? res.hex?.join(' ');
      setResult({ ...res, raw, start });
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doWrite = async () => {
    const start = Number(write.start);
    const values = write.values.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!Number.isInteger(start) || !values.length || values.some((v) => !Number.isInteger(v) || v < 0 || v > 65535)) {
      return toast('Enter a start register and values 0–65535', 'bad');
    }
    if (!confirmAction(`Write ${values.join(', ')} to holding register ${start}${values.length > 1 ? `–${start + values.length - 1}` : ''} on inverter ${Number(q.address) + 1}?\n\nWrong values can change grid or battery protection settings.`)) return;
    try {
      await api.post('/api/tools/modbus/write', { index: Number(q.address), start, values, confirm: true });
      toast('Registers written');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const addresses =
    mode === 'device'
      ? Array.from({ length: Math.max(1, inverters) }, (_, i) => ({ value: String(i), label: `Inverter ${i + 1}` }))
      : Array.from({ length: 33 }, (_, i) => ({ value: String(i), label: `Address ${i}` }));
  const valid = /^\d+$/.test(q.start) && /^\d+$/.test(q.count) && Number(q.count) >= 1 && Number(q.count) <= 125;
  const fnOptions = functions.map((f) => ({ value: String(f.id), label: f.name }));
  const onEnter = (e) => e.key === 'Enter' && ready && valid && !busy && submit();

  return html`
    <${ToolCard} icon="square-terminal" title=${title}
      sub=${mode === 'device' ? 'Read registers through the running inverter driver' : 'Read registers from a Modbus unit on this connection'}
      actions=${html`<${ConnBadge} connected=${ready} on="Ready" off="Not connected" />`}>
      <div class="dt-toolbar">
        ${(mode === 'direct' || inverters > 1) &&
        html`<${Fld} label=${mode === 'device' ? 'Inverter' : 'Address'}><${Select} value=${q.address} options=${addresses} onChange=${set('address')} /><//>`}
        <${Fld} label="Function">
          ${fnOptions.length <= 3
            ? html`<${Seg} label="Function" value=${String(q.fn)} options=${fnOptions} onChange=${set('fn')} />`
            : html`<${Select} value=${q.fn} options=${fnOptions} onChange=${set('fn')} />`}
        <//>
        <${Fld} label="Start"><input class="dt-num num" value=${q.start} required inputmode="numeric" onInput=${set('start')} onKeyDown=${onEnter} /><//>
        <${Fld} label="Limit" help="1–125"><input class="dt-num num" value=${q.count} required inputmode="numeric" onInput=${set('count')} onKeyDown=${onEnter} /><//>
        ${mode === 'direct' && models.length > 0 &&
        html`<${Fld} label="Decode as"><${Select} value=${q.model} options=${[{ value: '', label: 'None' }, ...models]} onChange=${set('model')} /><//>`}
      </div>
      <div class="dt-btns end">
        <${Button} kind="primary" disabled=${!ready || busy || !valid} onClick=${submit}>
          <${Ic} name=${busy ? 'loader' : 'play'} size="sm" />${!ready ? 'Not connected' : busy ? 'Reading…' : 'Submit'}
        <//>
      </div>
      ${error && html`<${ErrorLine}>${error}<//>`}
    <//>
    <${ToolCard} icon="table" tone="load" title="Result"
      sub=${result ? `Registers ${result.start}–${result.start + result.registers.length - 1}` : 'Registers returned by the last query'}>
      ${result
        ? html`<${ModbusResult} result=${result} />`
        : html`<${ToolEmpty} icon="table" title="No query yet">${ready ? 'Pick a function and range, then Submit.' : 'Connect first, then submit a query.'}<//>`}
    <//>
    ${allowWrite && ready &&
    html`<${ToolCard} icon="pencil-line" tone="bad" title="Write holding registers" sub="Advanced: writes go straight to the inverter">
      <${Notice} kind="warn">Only write registers you have checked against the inverter's protocol. Wrong values can change grid or battery protection settings.<//>
      <div class="dt-toolbar">
        <${Fld} label="Start"><input class="dt-num num" type="number" value=${write.start} min="0" max="65535" onInput=${(e) => setWrite({ ...write, start: e.target.value })} /><//>
        <${Fld} label="Values" help="Comma or space separated, 0–65535" cls="dt-grow"><input class="mono" value=${write.values} placeholder="1, 0" onInput=${(e) => setWrite({ ...write, values: e.target.value })} /><//>
      </div>
      <div class="dt-btns end"><${Button} kind="danger" onClick=${doWrite}><${Ic} name="pencil-line" size="sm" />Write<//></div>
    <//>`}
  `;
}

export default function ToolsModbus() {
  const ctx = useApi('/api/tools/modbus/context');
  const drivers = useApi('/api/devices/drivers');
  const { ports } = usePorts();
  const c = ctx.data;
  const [conn, setConn] = useState(null);
  const [form, setForm] = useState({ type: 'rtu', path: '', baud: '9600', host: '', port: '502' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/diagnostics/modbus').then((s) => {
      setConn(s);
      if (s.connected && s.target) {
        const t = s.target;
        setForm((f) => ({ ...f, type: t.type, path: t.path ?? '', baud: String(t.baud ?? 9600), host: t.host ?? '', port: String(t.port ?? 502) }));
      }
    }, () => setConn({ connected: false }));
  }, []);
  useEffect(() => {
    if (c && !conn?.connected) setForm((f) => ({ ...f, baud: String(c.baudRate || 9600) }));
  }, [c]);
  useEffect(() => {
    if (!form.path && ports?.length) setForm((f) => ({ ...f, path: ports.find((p) => !p.busy)?.path ?? ports[0].path }));
  }, [ports]);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: typeof v === 'string' ? v : v.target.value }));
  const growatt = drivers.data?.inverters.find((d) => d.id === 'growatt');
  const active = drivers.data?.inverters.find((d) => d.id === c?.driverId);
  const functions = active?.consoleFunctions?.length ? active.consoleFunctions : DEFAULT_FUNCTIONS;
  const models = (growatt?.models ?? []).map((m) => ({ value: m.id, label: `Growatt ${m.name}` }));
  const isDevice = form.type === 'device';
  const connected = Boolean(conn?.connected);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setConn(await api.post('/api/diagnostics/modbus/connect', form.type === 'tcp'
        ? { type: 'tcp', host: form.host, port: Number(form.port) }
        : { type: 'rtu', path: form.path, baud: Number(form.baud) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      setConn(await api.post('/api/diagnostics/modbus/disconnect'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = [
    { value: 'rtu', label: 'Serial RTU', icon: 'usb' },
    { value: 'tcp', label: 'TCP', icon: 'network' },
    { value: 'device', label: 'Inverter', icon: 'cpu' },
  ];
  const deviceReady = Boolean(c?.started && c?.hasConsole);

  const side = html`<${ToolCard} icon="cable" title="Connection" sub="Serial RTU, TCP or the running inverter"
    actions=${isDevice ? html`<${ConnBadge} connected=${deviceReady} on="Driver ready" off="Not running" />` : html`<${ConnBadge} connected=${connected} busy=${busy} />`}>
    <${Fld} label="Type"><${Seg} label="Connection type" value=${form.type} options=${typeOptions} disabled=${connected} onChange=${set('type')} /><//>
    ${form.type === 'rtu' &&
    html`<div class="dt-fgrid">
      <${Fld} label="Device"><${PortSelect} value=${form.path} ports=${ports} disabled=${connected} onChange=${set('path')} /><//>
      <${Fld} label="Baud"><${BaudSelect} value=${form.baud} disabled=${connected} onChange=${set('baud')} /><//>
    </div>`}
    ${form.type === 'tcp' &&
    html`<div class="dt-fgrid">
      <${Fld} label="IP address"><input class="mono" value=${form.host} placeholder="192.168.1.50" disabled=${connected} onInput=${set('host')} /><//>
      <${Fld} label="Port"><input class="num" type="number" min="1" max="65535" value=${form.port} disabled=${connected} onInput=${set('port')} /><//>
    </div>`}
    ${isDevice &&
    (deviceReady
      ? html`<div class="dt-meta"><${Ic} name="cpu" size="sm" />Queries go through the running <b class="mono">${c.driverId}</b> driver.</div>`
      : html`<${Notice} kind="warn">Not connected. Start the inverter connection on the <a href="/configuration">Configuration</a> page.<//>`)}
    ${!isDevice &&
    html`<div class="dt-btns end">
      ${connected
        ? html`<${Button} kind="danger" disabled=${busy} onClick=${disconnect}><${Ic} name="unplug" size="sm" />Disconnect<//>`
        : html`<${Button} kind="primary" disabled=${busy || (form.type === 'rtu' ? !form.path : !form.host)} onClick=${connect}><${Ic} name="plug" size="sm" />${busy ? 'Connecting…' : 'Connect'}<//>`}
    </div>`}
    ${error && html`<${ErrorLine}>${error}<//>`}
  <//>`;

  return html`<${Page} title="Modbus console" crumbs=${CONFIG_CRUMBS}>
    <${ToolLayout} side=${side}>
      ${isDevice
        ? html`<${ModbusQuery} key="device" title="Inverter query" mode="device" ready=${deviceReady} functions=${functions}
            inverters=${c?.inverters ?? 1} allowWrite=${true} />`
        : html`<${ModbusQuery} key="direct" title=${`${form.type === 'tcp' ? 'TCP' : 'RTU'} query`} mode="direct" ready=${connected}
            models=${models} defaultModel=${c?.driverId === 'growatt' ? c.modelId || '' : ''} />`}
    <//>
  <//>`;
}
