// Inverter helpers for the Devices form: the brand picker (brand → series → driver + model), the
// Solarman logger finder, and auto-detect on a chosen connection.
import { api, html, useEffect, useMemo, useState } from '../lib/core.js';
import { Badge, Ic, confirmAction, toast } from '../lib/ui.js';

export const SUPPORT = {
  supported: { kind: 'ok', text: 'Supported' },
  'read-only': { kind: 'info', text: 'Read-only' },
  planned: { kind: 'warn', text: 'Not supported yet' },
  auto: { kind: 'muted', text: 'Use auto-detect' },
};

const CONNECTION_NAMES = {
  usb: 'USB cable', rs232: 'RS232 cable', rs485: 'RS485 cable', can: 'CAN cable', wifi: 'WiFi dongle',
  solarman: 'Solarman WiFi logger', network: 'Network (LAN/WiFi)', gx: 'Victron GX device',
};

/** "solarman://ip[:port]/serial", "luxpower://ip[:port]/dongle[/inverter]", "host:port" or "tcp://host:port". */
export const isNet = (c) =>
  /^solarman:\/\/[\w.-]+(:\d{1,5})?\/\d{1,10}$/i.test(c) ||
  /^luxpower:\/\/[\w.-]+(:\d{1,5})?\/[A-Za-z0-9]{10}(\/[A-Za-z0-9]{10})?$/i.test(c) ||
  /^goodwe:\/\/[\w.-]+(:\d{1,5})?\/?$/i.test(c) ||
  /^eybond:\/\/(\d{1,5})?(\/[\w-]{1,32})?$/i.test(c) ||
  (/^(tcp:\/\/)?[\w.-]+:\d{1,5}$/.test(c) && !c.startsWith('/'));

/**
 * Brand + series selects. Choosing a supported series sets the driver and model; others explain
 * what to do. `driver`/`model` are the current form values, used to preselect a matching row.
 */
export function BrandPicker({ driver, model, disabled, onPick }) {
  const [data, setData] = useState(null);
  const [brand, setBrand] = useState('');
  const [idx, setIdx] = useState(-1);
  useEffect(() => {
    api.get('/api/devices/catalogue').then(setData, () => setData({ entries: [] }));
  }, []);
  const brands = useMemo(() => [...new Set((data?.entries ?? []).map((e) => e.brand))].sort((a, b) => a.localeCompare(b)), [data]);
  const rows = useMemo(() => (data?.entries ?? []).map((e, i) => ({ ...e, i })).filter((e) => e.brand === brand), [data, brand]);
  // Preselect the brand of the configured driver/model once the catalogue arrives.
  useEffect(() => {
    if (!data || brand || !driver) return;
    const hit = data.entries.find((e) => e.driverId === driver && (!model || e.modelId === model));
    if (hit) setBrand(hit.brand);
  }, [data]);
  if (!data) return html`<span class="muted">Loading…</span>`;
  const row = idx >= 0 ? data.entries[idx] : null;
  const choose = (i) => {
    setIdx(i);
    const e = data.entries[i];
    if (e && (e.support === 'supported' || e.support === 'read-only')) onPick({ driver: e.driverId, model: e.modelId ?? '' });
  };
  return html`<div class="inv-pick">
    <div class="inv-pick-row">
      <select aria-label="Brand" disabled=${disabled} onChange=${(e) => (setBrand(e.target.value), setIdx(-1))}>
        <option value="" selected=${!brand}>Brand…</option>
        ${brands.map((b) => html`<option value=${b} selected=${b === brand}>${b}</option>`)}
      </select>
      <select aria-label="Series" disabled=${disabled || !brand} onChange=${(e) => choose(Number(e.target.value))}>
        <option value="-1" selected=${idx < 0}>Series…</option>
        ${rows.map((e) => html`<option value=${e.i} selected=${e.i === idx}>${e.series}${e.support === 'planned' ? ' (not yet)' : ''}</option>`)}
      </select>
    </div>
    ${row && html`<div class="inv-pick-info">
      <${Badge} kind=${SUPPORT[row.support].kind}>${SUPPORT[row.support].text}<//>
      ${row.protocol && html`<span class="muted">Protocol: ${row.protocol}</span>`}
      ${row.connections.length > 0 && html`<span class="muted">Connects by ${row.connections.map((c) => CONNECTION_NAMES[c] ?? c).join(', ')}</span>`}
      ${row.support === 'read-only' && html`<span class="cfg-hint">Readings work; settings can't be changed until this model is verified on real hardware.</span>`}
      ${row.support === 'planned' && html`<span class="cfg-hint">The ${row.protocol} protocol has no driver yet. It is on the list.</span>`}
      ${row.support === 'auto' && html`<span class="cfg-hint">The protocol for this series isn't known. Pick its connection below and press Auto-detect.</span>`}
      ${row.models.length > 0 && html`<span class="cfg-hint">Models: ${row.models.join(', ')}</span>`}
    </div>`}
  </div>`;
}

/** Finds Solarman loggers on the LAN; "Add" adds the logger's connection string. */
export function SolarmanFinder({ value, onAdd, disabled }) {
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ ip: '', serial: '' });
  const scan = async () => {
    setBusy(true);
    try {
      setFound((await api.get('/api/devices/solarman')).loggers);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const manualOk = /^[\w.-]+$/.test(manual.ip.trim()) && /^\d{1,10}$/.test(manual.serial.trim());
  if (disabled) return null;
  return html`<div class="inv-sm">
    <div class="cfg-inline">
      <button type="button" class="btn btn-sm" disabled=${busy} onClick=${scan}><${Ic} name="radar" size="sm" />${busy ? 'Searching…' : 'Find Solarman loggers'}</button>
    </div>
    ${found && !found.length && html`<span class="cfg-hint">No loggers answered. Is the logger on the same network? You can also enter its IP and serial (on its label).</span>`}
    ${found?.map((l) => html`<div class="inv-sm-row">
      <span><b>${l.serial}</b> <span class="muted">${l.ip}${l.mac ? ` · ${l.mac}` : ''}</span></span>
      <button type="button" class="btn btn-sm" disabled=${value.includes(l.connection)} onClick=${() => onAdd(l.connection)}>${value.includes(l.connection) ? 'Added' : 'Add'}</button>
    </div>`)}
    <div class="cfg-inline">
      <input type="text" placeholder="Logger IP" aria-label="Logger IP" value=${manual.ip} onInput=${(e) => setManual((o) => ({ ...o, ip: e.target.value }))} />
      <input type="text" inputmode="numeric" placeholder="Logger serial" aria-label="Logger serial" value=${manual.serial} onInput=${(e) => setManual((o) => ({ ...o, serial: e.target.value }))} />
      <button type="button" class="btn btn-sm" disabled=${!manualOk}
        onClick=${() => (onAdd(`solarman://${manual.ip.trim()}/${manual.serial.trim()}`), setManual({ ip: '', serial: '' }))}>Add logger</button>
    </div>
  </div>`;
}

/** Luxpower / EG4 WiFi dongle: IP plus the dongle's and (optionally) the inverter's 10-character serials. */
export function LuxDongleAdd({ onAdd, disabled }) {
  const [v, setV] = useState({ ip: '', dongle: '', inverter: '' });
  const ok = /^[\w.-]+$/.test(v.ip.trim()) && /^[A-Za-z0-9]{10}$/.test(v.dongle.trim()) && (!v.inverter.trim() || /^[A-Za-z0-9]{10}$/.test(v.inverter.trim()));
  if (disabled) return null;
  const add = () => {
    onAdd(`luxpower://${v.ip.trim()}/${v.dongle.trim()}${v.inverter.trim() ? `/${v.inverter.trim()}` : ''}`);
    setV({ ip: '', dongle: '', inverter: '' });
  };
  return html`<div class="inv-sm">
    <span class="cfg-hint">Luxpower/EG4 WiFi dongle (TCP 8000): its IP and the serials on the dongle and inverter labels.</span>
    <div class="cfg-inline">
      <input type="text" placeholder="Dongle IP" aria-label="Dongle IP" value=${v.ip} onInput=${(e) => setV((o) => ({ ...o, ip: e.target.value }))} />
      <input type="text" placeholder="Dongle serial" aria-label="Dongle serial" maxlength="10" value=${v.dongle} onInput=${(e) => setV((o) => ({ ...o, dongle: e.target.value }))} />
      <input type="text" placeholder="Inverter serial (optional)" aria-label="Inverter serial" maxlength="10" value=${v.inverter} onInput=${(e) => setV((o) => ({ ...o, inverter: e.target.value }))} />
      <button type="button" class="btn btn-sm" disabled=${!ok} onClick=${add}>Add dongle</button>
    </div>
  </div>`;
}

/**
 * Eybond / SmartESS / "WiFi Plug Pro" dongles: they dial out to a cloud server, so Sunroost asks one to
 * dial this board instead (temporary, until the dongle reboots), then lists the dongles that connected.
 */
export function EybondAdd({ value, onAdd, disabled }) {
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);
  const poll = () => api.get('/api/devices/eybond').then(setState, () => {});
  useEffect(() => {
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);
  if (disabled) return null;
  const redirect = async () => {
    if (!(await confirmAction(`Ask the dongle at ${ip} to connect to this board instead of the SmartESS cloud? The app stops updating until the dongle reboots, when it goes back to the cloud.`))) return;
    setBusy(true);
    try {
      const r = await api.post('/api/devices/eybond/redirect', { ip });
      toast(r.reply ? `Dongle answered: ${r.reply}` : 'Sent; waiting for the dongle to connect…');
      poll();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="inv-sm">
    <span class="cfg-hint">Eybond / SmartESS WiFi dongle: enter its IP to point it at this board (port ${state?.port ?? 8899}).</span>
    <div class="cfg-inline">
      <input type="text" placeholder="Dongle IP" aria-label="Eybond dongle IP" value=${ip} onInput=${(e) => setIp(e.target.value)} />
      <button type="button" class="btn btn-sm" disabled=${busy || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())} onClick=${redirect}>Point dongle here</button>
    </div>
    ${state?.dongles?.map((d) => {
      const c = `eybond://${state.port}/${d.pn}`;
      return html`<div class="inv-sm-row"><span><b>${d.pn}</b> <span class="muted">${d.ip}</span></span>
        <button type="button" class="btn btn-sm" disabled=${value.includes(c)} onClick=${() => onAdd(c)}>${value.includes(c) ? 'Added' : 'Add'}</button></div>`;
    })}
  </div>`;
}

/** Probes the first chosen connection and offers the driver that answered. */
export function AutoDetect({ connections, disabled, onUse }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const target = connections[0];
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult((await api.post('/api/devices/detect', { connection: target })).results);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (disabled) return null;
  return html`<div class="inv-detect">
    <button type="button" class="btn btn-sm" disabled=${busy || !target} onClick=${run} title=${target ? `Probe ${target}` : 'Choose a connection first'}>
      <${Ic} name="scan-search" size="sm" />${busy ? 'Probing…' : 'Auto-detect'}</button>
    ${!target && html`<span class="cfg-hint">Choose a connection, then auto-detect.</span>`}
    ${result && !result.length && html`<span class="cfg-hint">Nothing recognised on ${target}. Check the cable, or pick the brand above.</span>`}
    ${result?.map((r) => html`<div class="inv-sm-row">
      <span><b>${r.driverName}</b> <span class="muted">${r.evidence}</span></span>
      <button type="button" class="btn btn-sm btn-primary" onClick=${() => onUse({ driver: r.driverId, model: r.modelId ?? '', address: r.address ?? 0, baud: r.baudRate ?? 0 })}>Use</button>
    </div>`)}
  </div>`;
}

export const INVERTER_CSS = `
.inv-pick, .inv-sm, .inv-detect { display: flex; flex-direction: column; gap: 8px; }
.inv-pick-row { display: flex; gap: 8px; flex-wrap: wrap; }
.inv-pick-row select { flex: 1 1 160px; min-width: 0; }
.inv-pick-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.inv-pick-info .cfg-hint { flex-basis: 100%; }
.inv-sm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; flex-wrap: wrap; }
.inv-sm .cfg-inline input { flex: 1 1 130px; min-width: 0; }
.inv-detect > .btn { align-self: flex-start; }
`;
