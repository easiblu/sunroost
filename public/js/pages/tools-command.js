// Inverter console. Text-protocol (Voltronic) drivers get the Voltronic console (inverter, command,
// value → Submit, response and decoded metrics); Modbus drivers get the Modbus query console against
// the connected inverter. A status card on the left shows the driver and connection.
import { api, html, useApi, useState } from '../lib/core.js';
import { Button, confirmAction, Ic, Notice, Page, Select } from '../lib/ui.js';
import { ModbusQuery } from './tools-modbus.js';
import { CONFIG_CRUMBS, ConnBadge, ErrorLine, Fld, SubHead, ToolCard, ToolEmpty, ToolLayout } from './diag-serial-inspect.js';

const isQuery = (c) => /^Q/i.test(c);
const fmt = (v) => (v === true ? 'Yes' : v === false ? 'No' : String(v));
const OTHER = '__other__';

function VoltronicConsole({ c }) {
  const ready = Boolean(c.started && c.hasConsole);
  const known = c.commands ?? [];
  const [index, setIndex] = useState('0');
  const [pick, setPick] = useState(known[0]?.command ?? OTHER);
  const [custom, setCustom] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const command = ((pick === OTHER ? custom : pick) + value).trim();
  const valid = command.length > 0 && command.length <= 32 && /^[\x20-\x7e]+$/.test(command);
  const setting = command && !isQuery(command);

  const submit = async () => {
    let confirm = false;
    if (!isQuery(command)) {
      if (!confirmAction(`'${command}' is not a query and may change a setting on inverter ${Number(index) + 1}.\n\nSend it anyway?`)) return;
      confirm = true;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/tools/command', { index: Number(index), command, confirm });
      setResult({ ...res, command });
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const options = [...known.map((k) => ({ value: k.command, label: `${k.command} - ${k.name}` })), { value: OTHER, label: 'Other…' }];
  const decoded = result?.decoded && Object.keys(result.decoded).length ? Object.entries(result.decoded) : null;
  return html`
    <${ToolCard} icon="square-terminal" title="Voltronic console" sub="Send a protocol command and inspect the reply"
      actions=${html`<${ConnBadge} connected=${ready} on="Ready" off="Not connected" />`}>
      <div class="dt-toolbar">
        ${c.inverters > 1 &&
        html`<${Fld} label="Inverter"><${Select} value=${index} onChange=${setIndex}
          options=${Array.from({ length: c.inverters }, (_, i) => ({ value: String(i), label: `Inverter ${i + 1}` }))} /><//>`}
        <${Fld} label="Command" cls="cc-cmd"><${Select} value=${pick} options=${options} onChange=${setPick} /><//>
        ${pick === OTHER &&
        html`<${Fld} label="Custom command"><input class="mono cc-in" value=${custom} maxlength="32" spellcheck="false" autocomplete="off" placeholder="QPIGS"
          onInput=${(e) => setCustom(e.target.value)} /><//>`}
        <${Fld} label="Value" help="Appended, e.g. 02 for POP02">
          <input class="mono cc-in" value=${value} maxlength="24" spellcheck="false" autocomplete="off"
            onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && ready && valid && !busy && submit()} />
        <//>
      </div>
      <div class="cc-send">
        <div class="cc-preview">
          <span class="dt-f-label">Sends</span>
          <code>${command || '–'}</code>
          ${command && html`<span class=${`badge ${setting ? 'badge-warn' : 'badge-info'}`}>${setting ? 'Changes a setting' : 'Query'}</span>`}
        </div>
        <${Button} kind=${setting ? 'danger' : 'primary'} disabled=${!ready || !valid || busy} onClick=${submit}>
          <${Ic} name=${busy ? 'loader' : 'send'} size="sm" />${!ready ? 'Not connected' : busy ? 'Sending…' : 'Submit'}
        <//>
      </div>
      <p class="muted small dt-hint">Commands that don't start with Q change inverter settings and ask for confirmation.</p>
      ${error && html`<${ErrorLine}>${error}<//>`}
    <//>
    <${ToolCard} icon="file-text" tone="load" title="Response" sub=${result ? `Reply to ${result.command}` : 'Reply to the last command'}>
      ${result
        ? html`<div class="dt-sub-block">
            <${SubHead} title="Raw">
              ${/^NAK/.test(result.reply) && html`<span class="badge badge-bad">Rejected (NAK)</span>`}
              ${/^ACK/.test(result.reply) && html`<span class="badge badge-ok">Accepted (ACK)</span>`}
            <//>
            <pre class="dt-out">${result.reply === '' ? '(empty)' : result.reply}</pre>
          </div>
          <div class="dt-sub-block">
            <${SubHead} title="Metrics" />
            ${decoded
              ? html`<div class="table-wrap dt-scroll"><table class="table dt-table"><thead><tr><th>Name</th><th>Value</th></tr></thead>
                  <tbody>${decoded.map(([k, v]) => html`<tr><td>${k}</td><td class="mono">${fmt(v)}</td></tr>`)}</tbody></table></div>`
              : html`<${ToolEmpty} icon="binary" title="No decoder">No decoder for this reply.<//>`}
          </div>`
        : html`<${ToolEmpty} icon="square-terminal" title="Nothing sent yet">${ready ? 'Pick a command and Submit.' : 'Connect the inverter to use its console.'}<//>`}
    <//>`;
}

function StatusCard({ c, driver, kind }) {
  return html`<${ToolCard} icon="cpu" title="Inverter" sub=${driver?.name ?? c.driverId ?? 'No driver'}
    actions=${html`<${ConnBadge} connected=${c.started} on="Running" off="Stopped" />`}>
    <div class="cc-rows">
      <div class="row"><span class="row-label">Driver</span><span class="row-value mono">${c.driverId || '–'}</span></div>
      <div class="row"><span class="row-label">Protocol</span><span class="row-value">${kind}</span></div>
      <div class="row"><span class="row-label">Inverters</span><span class="row-value">${c.inverters || 1}</span></div>
      <div class="row"><span class="row-label">Console</span><span class="row-value">${c.hasConsole ? html`<span class="badge badge-ok">Available</span>` : html`<span class="badge badge-muted">None</span>`}</span></div>
    </div>
    <div class="dt-btns">
      <a class="btn btn-sm" href="/configuration"><${Ic} name="settings" size="sm" />Configuration</a>
      <a class="btn btn-sm" href="/modbus/console"><${Ic} name="cable" size="sm" />Modbus console</a>
    </div>
  <//>`;
}

export default function ToolsCommand() {
  const cmd = useApi('/api/tools/command/context');
  const mb = useApi('/api/tools/modbus/context');
  const drivers = useApi('/api/devices/drivers');
  const c = cmd.data;
  const m = mb.data;
  if (!c || !m) return html`<${Page} title="Inverter console" crumbs=${CONFIG_CRUMBS}><div class="loading">Loading…</div><//>`;

  const driver = drivers.data?.inverters.find((d) => d.id === c.driverId);
  const textProtocol = c.driverId === 'voltronic' || c.hasConsole;
  const modbus = !textProtocol && (m.hasConsole || driver?.consoleFunctions?.length);

  return html`<${Page} title="Inverter console" crumbs=${CONFIG_CRUMBS}>
    ${!c.started &&
    html`<${Notice} kind="warn">Not connected. Start the inverter connection on the <a href="/configuration">Configuration</a> page,
      or use the standalone <a href="/modbus/console">Modbus console</a>.<//>`}
    <${ToolLayout} side=${html`<${StatusCard} c=${c} driver=${driver} kind=${textProtocol ? 'Voltronic (text)' : modbus ? 'Modbus' : '–'} />`}>
      ${textProtocol
        ? html`<${VoltronicConsole} c=${c} />`
        : modbus
          ? html`<${ModbusQuery} title=${`${driver?.name ?? 'Inverter'} console`} mode="device" ready=${Boolean(m.started && m.hasConsole)}
              functions=${driver?.consoleFunctions?.length ? driver.consoleFunctions : undefined} inverters=${m.inverters || 1} allowWrite=${true} />`
          : html`<${ToolCard} icon="square-terminal" title="Inverter console" sub="Send commands to the connected inverter">
              <${ToolEmpty} icon="terminal" title="No console">${c.started ? 'This inverter driver has no console.' : 'Connect an inverter to use its console.'}<//>
            <//>`}
    <//>
  <//>`;
}

const css = `
.cc-cmd { flex: 1 1 280px !important; }
.cc-cmd select { max-width: none; }
.cc-in { width: 160px; }
.cc-send { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 12px 14px; background: var(--surface-2); border-radius: var(--radius-sm); }
.cc-preview { display: flex; gap: 10px; align-items: center; min-width: 0; flex-wrap: wrap; }
.cc-preview code { font-size: 14px; font-weight: 600; color: var(--heading); word-break: break-all; }
.cc-rows { margin-top: -6px; }
`;
if (!document.getElementById('css-tools-command')) {
  const el = document.createElement('style');
  el.id = 'css-tools-command';
  el.textContent = css;
  document.head.appendChild(el);
}
