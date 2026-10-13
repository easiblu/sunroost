// Serial test: transmit random printable text on every free serial port at 115200 and show what
// comes back. Receive is green when it matches Transmit (loopback plug or cross-wired adapters).
import { api, html, useState } from '../lib/core.js';
import { Button, Ic, IconChip, Page, toast } from '../lib/ui.js';
import { CONFIG_CRUMBS, ToolCard, ToolEmpty, useDiagStream } from './diag-serial-inspect.js';

const name = (path) => path.replace(/^\/dev\//, '');

function Result({ p }) {
  if (p.error) return html`<span class="badge badge-warn">Skipped</span>`;
  if (p.ok === true) return html`<span class="badge badge-ok"><${Ic} name="circle-check" size="sm" />Match</span>`;
  if (p.ok === false) return html`<span class="badge badge-bad"><${Ic} name="circle-x" size="sm" />No match</span>`;
  return html`<span class="badge badge-muted">Waiting</span>`;
}

export default function DiagSerialTest() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useDiagStream('test', {
    // The stream snapshot is the engine state; when idle, list the ports instead.
    snapshot: (s) => (s.running ? setSt(s) : api.get('/api/diagnostics/serial-test').then(setSt, () => setSt(s))),
    state: setSt,
  });

  const toggle = async () => {
    setBusy(true);
    try {
      setSt(await api.post(`/api/diagnostics/serial-test/${st?.running ? 'stop' : 'start'}`));
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const ports = st?.ports ?? [];
  const passing = ports.filter((p) => p.ok === true).length;
  return html`<${Page} title="Serial test" crumbs=${CONFIG_CRUMBS}>
    <${ToolCard} icon="test-tube-diagonal" title="Loopback test"
      sub="Sends random text on every free port at 115200 baud. Fit a loopback plug (TX↔RX) or cross-wire two adapters."
      actions=${html`
        ${st?.running && html`<span class="badge badge-ok"><span class="dt-dot"></span>Running · ${passing}/${ports.length} passing</span>`}
        <${Button} kind=${st?.running ? 'danger' : 'primary'} disabled=${busy || !st} onClick=${toggle}>
          <${Ic} name=${st?.running ? 'circle-stop' : 'circle-play'} size="sm" />${st?.running ? 'Stop' : 'Start'}
        <//>`}>
      ${st === null && html`<div class="loading">Loading…</div>`}
      ${st && ports.length === 0 && html`<${ToolEmpty} icon="usb" title="No serial devices found">Plug in a USB serial adapter and reload.<//>`}
      ${ports.length > 0 &&
      html`<div class="list st-list">
        ${ports.map(
          (p) => html`<div class="list-item st-item">
            <${IconChip} name="usb" tone=${p.ok === true ? 'battery' : p.ok === false ? 'bad' : ''} small />
            <div class="list-main st-main">
              <div class="st-top">
                <span class="list-title mono">${name(p.path)}</span>
                <${Result} p=${p} />
                ${p.rounds > 0 && html`<span class="list-sub num">${p.passed} of ${p.rounds} rounds matched</span>`}
              </div>
              <div class="st-io">
                <span class="st-k">TX</span><code class="st-v">${p.transmit || html`<span class="muted">–</span>`}</code>
                <span class="st-k">RX</span><code class=${`st-v ${p.ok === true ? 'st-ok' : p.ok === false ? 'st-bad' : ''}`}>${p.receive || (p.ok === false ? '(nothing received)' : html`<span class="muted">–</span>`)}</code>
              </div>
              ${p.error && html`<div class="list-sub text-bad">${p.error}</div>`}
            </div>
          </div>`,
        )}
      </div>`}
    <//>
  <//>`;
}

const css = `
.st-item { align-items: flex-start; padding: 14px 0; }
.st-main { display: flex; flex-direction: column; gap: 8px; }
.st-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.st-top .list-title { font-size: 13.5px; }
.st-io { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; align-items: center; background: var(--surface-2); border-radius: var(--radius-sm); padding: 10px 12px; }
.st-k { font-size: 11px; font-weight: 700; letter-spacing: .05em; color: var(--muted); }
.st-v { font-size: 12.5px; word-break: break-all; padding: 1px 6px; border-radius: 6px; justify-self: start; }
.st-ok { color: var(--ok-text); background: var(--ok-soft); }
.st-bad { color: var(--bad); background: var(--bad-soft); }
`;
if (!document.getElementById('css-diag-serial-test')) {
  const el = document.createElement('style');
  el.id = 'css-diag-serial-test';
  el.textContent = css;
  document.head.appendChild(el);
}
