// Configuration › USB devices: the USB device list (lsusb), "Cycle USB power" (uhubctl)
// and the kernel log in UTC, newest first.
import { api, html, useEffect, useState } from '../lib/core.js';
import { Badge, Ic, IconChip, confirmAction, toast } from '../lib/ui.js';
import { ConfigPage, Section, injectCss } from './configuration.js';

export default function SystemKernel() {
  const [data, setData] = useState(null);
  const [cycling, setCycling] = useState(false);
  const [filter, setFilter] = useState('');
  const load = () =>
    api.get('/api/system/kernel-log?limit=1000').then(setData, (err) => setData({ available: false, lines: [], usb: [], error: err.message }));
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const cycle = async () => {
    if (!confirmAction('Are you sure you want to turn USB power off and back on?')) return;
    setCycling(true);
    try {
      const r = await fetch('/api/system/usb-cycle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.command ? `${body.error} ${body.command}` : body.error || r.statusText);
      toast('USB power cycled');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setCycling(false);
      setTimeout(load, 3000);
    }
  };
  const q = filter.trim().toLowerCase();
  const lines = (data?.lines ?? []).filter((l) => !q || l.toLowerCase().includes(q));
  return html`<${ConfigPage} title="USB devices" wide>
    <${Section} icon="usb" tone="load" title="USB devices" desc="Devices detected on the USB bus"
      actions=${html`${data && html`<${Badge}>${data.usb.length} found<//>`}
        <button type="button" class="btn btn-sm" disabled=${cycling} onClick=${cycle}><${Ic} name="refresh-cw" size="sm" />${cycling ? 'Cycling…' : 'Cycle USB power'}</button>`}>
      ${!data
        ? html`<div class="muted">Loading…</div>`
        : data.usb.length === 0
          ? html`<div class="empty"><${Ic} name="unplug" /><div>No USB devices found.</div></div>`
          : html`<div class="list">${data.usb.map((l) => {
              const m = l.match(/^(Bus \d+ Device \d+): (ID \S+)\s*(.*)$/);
              return html`<div class="list-item">
                <${IconChip} name="usb" small />
                <div class="list-main"><div class="list-title">${m ? m[3] || m[2] : l}</div>${m && html`<div class="list-sub mono">${m[1]} · ${m[2]}</div>`}</div>
              </div>`;
            })}</div>`}
    <//>
    <${Section} icon="scroll-text" title="Kernel log" desc="UTC time, newest first"
      actions=${data?.available && html`<div class="cfg-search kn-filter"><${Ic} name="search" size="sm" />
        <input type="search" placeholder="Filter" aria-label="Filter kernel log" value=${filter} onInput=${(e) => setFilter(e.target.value)} /></div>`}>
      ${!data
        ? html`<div class="muted">Loading…</div>`
        : !data.available
          ? html`<div class="empty"><${Ic} name="file-x" /><div>${data.error}</div></div>`
          : lines.length === 0
            ? html`<div class="empty"><${Ic} name="search-x" /><div>No matching lines.</div></div>`
            : html`<div class="log sa-log kn-log">${lines.map((l) => html`<div class=${/under-?voltage|error|fail/i.test(l) ? 'w' : ''}>${l}</div>`)}</div>`}
    <//>
  <//>`;
}

injectCss('css-system-kernel', `
.kn-filter { width: 220px; }
.kn-log { max-height: calc(100vh - 360px); min-height: 280px; }
@media (max-width: 560px) { .kn-filter { width: 100%; } }
`);
