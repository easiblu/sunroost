// Configuration › Advanced: Dashboard, Grid, Inverter and Battery cards (each its own form,
// "Save" once changed), plus Tariffs & costs (prices and CO₂ intensity) at the end.
// Inverter/Battery inputs are locked while devices are connected, so a running link isn't changed under it.
import { api, appSettings, html, saveSettings, useEffect, useState, useStore } from '../lib/core.js';
import { Ic, Modal, toast } from '../lib/ui.js';
import { Btns, ConfigPage, F, Hint, Section, injectCss, usePoll } from './configuration.js';

/**
 * One independently saved form. Draft values are kept as typed and coerced to the stored type
 * (number/boolean/string) on save.
 */
function useForm(s, keys, validate) {
  const initial = () => Object.fromEntries(keys.map((k) => [k, s[k]]));
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = keys.some((k) => String(draft[k]) !== String(s[k]));
  useEffect(() => {
    if (!dirty) setDraft(initial());
  }, [s]);
  const error = dirty && validate ? validate(draft) : null;
  const save = async (e) => {
    e?.preventDefault();
    if (error) return;
    const values = {};
    for (const k of keys) {
      if (String(draft[k]) === String(s[k])) continue;
      values[k] = typeof s[k] === 'number' ? Number(draft[k]) : typeof s[k] === 'boolean' ? draft[k] === true || draft[k] === 'true' : draft[k];
      if (typeof values[k] === 'number' && !Number.isFinite(values[k])) return toast(`Invalid number for ${k}`, 'bad');
    }
    setBusy(true);
    try {
      await saveSettings(values);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => setDraft(initial());
  return { draft, set: (k, v) => setDraft((d) => ({ ...d, [k]: v })), dirty, error, busy, save, cancel };
}

/** Form footer: validation error, and "Save" once something changed. */
const Footer = ({ f }) => html`
  ${f.error && html`<div class="notice notice-bad cfg-err">${f.error}</div>`}
  <${Btns}>
    ${f.dirty && html`<button type="button" class="btn" onClick=${f.cancel}>Cancel</button>`}
    <button type="submit" class="btn btn-primary" disabled=${!f.dirty || f.busy || Boolean(f.error)}>${f.busy ? 'Saving…' : 'Save'}</button>
  <//>
`;

const Num = ({ f, k, min, max, step = 'any', disabled, scale = 1 }) => html`<input id=${k} type="number" min=${min} max=${max} step=${step} disabled=${disabled}
  value=${scale === 1 ? f.draft[k] : Number(f.draft[k]) / scale} onInput=${(e) => f.set(k, scale === 1 ? e.target.value : Math.round(Number(e.target.value) * scale))} />`;

const Sel = ({ f, k, options, disabled }) => html`<select id=${k} disabled=${disabled} onChange=${(e) => f.set(k, e.target.value)}>
  ${options.map(([v, label]) => html`<option value=${v} selected=${String(v) === String(f.draft[k])}>${label}</option>`)}
</select>`;

const Note = ({ children }) => html`<${Hint}>${children}<//>`;

function Dashboard({ s }) {
  const f = useForm(s, ['max_grid_power', 'max_pv_power', 'max_battery_power', 'battery_metric'], (d) =>
    ['max_grid_power', 'max_pv_power', 'max_battery_power'].some((k) => !(Number(d[k]) >= 10 && Number(d[k]) <= 1e6)) ? 'Maximum powers must be between 10 and 1000000.' : null,
  );
  return html`<${Section} icon="layout-dashboard" tone="accent" title="Dashboard" desc="Gauge ranges and battery display. Visual only, no other effect."><form onSubmit=${f.save}>
    <${F} label="Max grid power (W)" htmlFor="max_grid_power"><${Num} f=${f} k="max_grid_power" min="10" max="1000000" /><//>
    <${F} label="Max solar PV power (W)" htmlFor="max_pv_power"><${Num} f=${f} k="max_pv_power" min="10" max="1000000" /><//>
    <${F} label="Max battery power (W)" htmlFor="max_battery_power"><${Num} f=${f} k="max_battery_power" min="10" max="1000000" /><//>
    <${F} label="Battery metric" htmlFor="battery_metric" class="sa-top">
      <${Sel} f=${f} k="battery_metric" options=${[['soc', 'State of charge'], ['voltage', 'Voltage'], ['both', 'Both']]} />
    <//>
    <${Footer} f=${f} />
  </form><//>`;
}

/** "Select Eskom connection/area": searchable list (500 ms debounce). */
function EskomArea() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api.get(`/api/grid/eskom/areas?q=${encodeURIComponent(q)}`).then(setRes, (e) => setRes({ areas: [], error: e.message })), 500);
    return () => clearTimeout(t);
  }, [q, open]);
  useEffect(() => {
    api.get('/api/grid/eskom/areas?q=').then(setRes, () => {});
  }, []);
  const pick = async (a) => {
    try {
      await api.post('/api/grid/eskom/area', { area: a.id, name: a.name });
      setRes((r) => ({ ...r, selected: { id: a.id, name: a.name } }));
      setOpen(false);
      toast(`Area set to ${a.name}`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return html`
    <${F} label="Area">
      <span class="cfg-val"><span class="cfg-val-main">${res?.selected?.name ?? html`<span class="muted">Not selected</span>`}</span>
        <button type="button" class="btn btn-sm btn-ghost" onClick=${() => setOpen(true)}>Browse</button></span>
    <//>
    <${Modal} open=${open} title="Select Eskom connection/area" onClose=${() => setOpen(false)}
      footer=${html`<button type="button" class="btn" onClick=${() => setOpen(false)}>Cancel</button>`}>
      <input type="search" placeholder="Search" autofocus value=${q} onInput=${(e) => setQ(e.target.value)} style="max-width:none" />
      <div class="table-wrap" style="height:15em;overflow-y:auto;margin-top:10px">
        <table class="table">
          <tbody>
            ${(res?.areas ?? []).map((a) => html`<tr><td style="text-align:left"><a href="#" onClick=${(e) => { e.preventDefault(); pick(a); }}>${a.name}</a></td></tr>`)}
            ${res && !res.areas?.length && html`<tr><td class="muted">${res.error || 'No matching areas.'}</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:8px">Areas and schedules come from the community eskom-calendar project.</p>
    <//>`;
}

function Grid({ s }) {
  const grid = usePoll('/api/grid', 60000);
  const [areas, setAreas] = useState(null);
  useEffect(() => {
    api.get('/api/grid/areas').then(setAreas, () => setAreas([]));
  }, []);
  const f = useForm(s, ['grid.driver_id', 'grid.area', 'grid.currency', 'grid.price_multiplier'], (d) =>
    Number(d['grid.price_multiplier']) < 0 || Number(d['grid.price_multiplier']) > 1000 ? 'Price multiplier must be between 0 and 1000.' : null,
  );
  const providers = grid.data?.providers ?? [{ id: 'default', name: 'Default' }, { id: 'energy_charts', name: 'Day-ahead prices (Energy-Charts)' }];
  const currencies = grid.data?.currencies ?? ['EUR'];
  return html`<${Section} icon="utility-pole" tone="grid" title="Grid" desc="Electricity price provider and area"><form onSubmit=${f.save}>
    <${F} label="Provider" htmlFor="grid.driver_id"><${Sel} f=${f} k="grid.driver_id" options=${providers.map((p) => [p.id, p.name])} /><//>
    ${f.draft['grid.driver_id'] === 'eskom' && s['grid.driver_id'] === 'eskom' && html`<${EskomArea} />`}
    ${f.draft['grid.driver_id'] === 'eskom' && s['grid.driver_id'] !== 'eskom' && html`<${Note}>Save to choose your Eskom area.<//>`}
    ${f.draft['grid.driver_id'] === 'energy_charts' &&
    html`
      <${F} label="Area" htmlFor="grid.area">
        <${Sel} f=${f} k="grid.area" options=${(areas ?? [{ id: f.draft['grid.area'], name: f.draft['grid.area'] }]).map((a) => [a.id, `${a.name} (${a.id})`])} />
      <//>
      <${F} label="Currency" htmlFor="grid.currency"><${Sel} f=${f} k="grid.currency" options=${currencies.map((c) => [c, c])} /><//>
      <${F} label="Price multiplier" htmlFor="grid.price_multiplier" class="sa-top">
        <${Num} f=${f} k="grid.price_multiplier" min="0" max="1000" step="0.01" />
        <${Note}>Day-ahead wholesale prices from the free Energy-Charts API (Fraunhofer ISE, CC BY 4.0), without grid fees or taxes. Non-EUR currencies use the daily ECB rate. <a href="/grid/status">View prices</a><//>
      <//>
      ${grid.data?.error && html`<div class="notice notice-warn cfg-err">${grid.data.error}</div>`}`}
    <${Footer} f=${f} />
  </form><//>`;
}

function Inverter({ s, driver, locked }) {
  const keys = ['inverter.verify_crc', 'inverter.self_consumption', 'inverter.temperature_multiplier', 'inverter.grid_connection', 'inverter.baud_rate', 'inverter.modbus_address', 'inverter.poll_interval_ms'];
  const f = useForm(s, keys, (d) =>
    Number(d['inverter.poll_interval_ms']) < 500 ? 'Poll interval must be at least 0.5 s.'
    : Number(d['inverter.self_consumption']) < 0 ? 'Self consumption cannot be negative.'
    : !(Number(d['inverter.modbus_address']) >= 0 && Number(d['inverter.modbus_address']) <= 247) ? 'Modbus address must be between 0 (driver default) and 247.'
    : null,
  );
  const id = s['inverter.driver_id'];
  const serial = driver?.transport === 'serial';
  const conn = (s['inverter.connection_ids'] ?? []).join(', ');
  return html`<${Section} icon="cpu" tone="solar" title=${`Inverter · ${driver?.name ?? id}`} desc=${conn ? (conn.startsWith('/') ? `USB ${conn}` : conn) : 'Communication and measurement options'}><form onSubmit=${f.save}>
    ${id === 'voltronic' &&
    html`<${F} label="CRC verification" htmlFor="inverter.verify_crc"><${Sel} f=${f} k="inverter.verify_crc" disabled=${locked} options=${[['true', 'Enabled'], ['false', 'Disabled']]} /><//>`}
    <${F} label="Self consumption power" htmlFor="inverter.self_consumption"><${Num} f=${f} k="inverter.self_consumption" min="0" max="1000" step="1" disabled=${locked} /><//>
    <${F} label="Temperature multiplier" htmlFor="inverter.temperature_multiplier">
      <${Sel} f=${f} k="inverter.temperature_multiplier" disabled=${locked} options=${[['1', '1°C'], ['0.1', '0.1°C']]} />
    <//>
    <${F} label="Grid connection" htmlFor="inverter.grid_connection">
      <${Sel} f=${f} k="inverter.grid_connection" disabled=${locked} options=${[['auto', 'Auto detect'], ['grid_ct', 'CT clamp installed'], ['grid_ld', 'CT clamp not used']]} />
    <//>
    ${serial &&
    html`<${F} label="Baud rate" htmlFor="inverter.baud_rate">
      <${Sel} f=${f} k="inverter.baud_rate" disabled=${locked} options=${[
        [0, `Driver default${driver?.defaultBaudRate ? ` (${driver.defaultBaudRate})` : ''}`],
        ...[...new Set([2400, 4800, 9600, 19200, 38400, 57600, 115200, Number(s['inverter.baud_rate'])])].filter(Boolean).sort((a, b) => a - b).map((b) => [b, String(b)]),
      ]} />
    <//>`}
    ${driver?.transport !== 'none' && id !== 'voltronic' &&
    html`<${F} label="Modbus address" htmlFor="inverter.modbus_address"><${Num} f=${f} k="inverter.modbus_address" min="0" max="247" step="1" disabled=${locked} />
      <span class="cfg-hint">0 = driver default (${driver?.defaultAddress ?? 1})</span><//>`}
    <${F} label="Poll interval (seconds)" htmlFor="inverter.poll_interval_ms">
      <${Num} f=${f} k="inverter.poll_interval_ms" min="0.5" max="60" step="0.5" scale=${1000} disabled=${locked} />
    <//>
    <${Footer} f=${f} />
  </form><//>`;
}

// Option lists for the Advanced › Battery protocol settings ('' = Auto detect).
const PROTOCOL_SOC = [
  ['', 'Auto detect'],
  ['soc', 'Use state of charge (SoC)'],
  ['charge/design', 'Ignore SoC, compare charge capacity to design capacity'],
  ['charge/full', 'Ignore SoC, compare charge capacity to full capacity'],
];
const PROTOCOL_CAPACITY = [
  ['', 'Auto detect'],
  ['full,design', 'Use full capacity, show design capacity'],
  ['full', 'Use full capacity, hide design capacity'],
  ['10xfull', 'Use 10x full capacity, hide design capacity'],
  ['design', 'Use design capacity'],
];
const PROTOCOL_TEMPERATURE = [
  ['', 'Auto detect'],
  ['0.1K', '0.1 Kelvin'],
  ['1K', '1 Kelvin'],
  ['0.1°C', '0.1 Celsius'],
  ['1°C', '1 Celsius'],
  ['1°C-10', '1 Celsius (offset -10)'],
];
const PROTOCOL_VARIANTS = [['auto', 'Auto detect'], ['pylon', 'Pylontech'], ['dyness', 'Dyness'], ['seplos', 'Seplos'], ['generic', 'Generic']];
const BMS_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
/** Drivers that read several packs over one connection (pack count / current source apply). */
const MULTI_PACK = new Set(['serial', 'narada', 'pylontech', 'modbus', 'voltronic_lib']);
/** Drivers whose received data the Protocol settings reinterpret. */
const PROTOCOL_DRIVERS = new Set(['serial', 'narada', 'modbus', 'can']);

function Battery({ s, bms, locked }) {
  const id = s['bms.driver_id'];
  const emulated = id === 'emulated';
  const serial = id === 'serial';
  const real = bms?.transport === 'serial';
  const multiPack = real && (MULTI_PACK.has(id) || bms?.multiConnection);
  const protocol = real && PROTOCOL_DRIVERS.has(id);
  const keys = [
    'bms.capacity', 'bms.soc', 'bms.drift_soc', 'bms.voltage_30_soc', 'bms.voltage_80_soc', 'bms.invert_current', 'bms.maximum_pack_count',
    'bms.read_current_from_inverter', 'bms.protocol_soc', 'bms.protocol_capacity', 'bms.protocol_temperature', 'bms.serial_protocol_variant', 'bms.baud_rate',
  ];
  const f = useForm(s, keys, (d) => {
    if (!(Number(d['bms.capacity']) >= 0.1 && Number(d['bms.capacity']) <= 100000)) return 'Capacity must be between 0.1 and 100000 kWh.';
    if (!(Number(d['bms.soc']) >= 0 && Number(d['bms.soc']) <= 100)) return 'State of charge must be between 0 and 100.';
    if (Number(d['bms.voltage_80_soc']) <= Number(d['bms.voltage_30_soc'])) return 'The 80% voltage must be higher than the 30% voltage.';
    if (!(Number(d['bms.maximum_pack_count']) >= 1 && Number(d['bms.maximum_pack_count']) <= 32)) return 'Maximum pack count must be between 1 and 32.';
    return null;
  });
  const name = id === 'inverter' ? 'Use inverter values' : bms?.name ?? id;
  const bauds = [...new Set([...BMS_BAUD_RATES, Number(s['bms.baud_rate']) || 9600])].sort((a, b) => a - b);
  return html`<${Section} icon="battery-charging" tone="battery" title=${`Battery · ${name}`} desc="Capacity, state of charge and protocol options"><form onSubmit=${f.save}>
    <${F} label="Capacity (kWh)" htmlFor="bms.capacity" class="sa-top">
      <${Num} f=${f} k="bms.capacity" min="0.1" max="100000" step=".1" disabled=${locked} />
      <${Note}>This capacity is used only if neither the battery nor the inverter reports one.<//>
    <//>
    ${emulated &&
    html`
      <${F} label="Current state of charge" htmlFor="bms.soc"><${Num} f=${f} k="bms.soc" min="0" max="100" step="1" disabled=${locked} /><//>
      <${F} label="Drift state of charge at low current" htmlFor="bms.drift_soc" class="sa-top">
        <${Sel} f=${f} k="bms.drift_soc" disabled=${locked} options=${[['true', 'Yes'], ['false', 'No']]} />
        <${Note}>State of charge is counted from the energy flowing in and out of the battery. With drifting enabled it is adjusted toward the battery voltage when the current is low.<//>
      <//>
      <${F} label="30% state of charge voltage" htmlFor="bms.voltage_30_soc"><${Num} f=${f} k="bms.voltage_30_soc" min="8" max="999" step=".1" disabled=${locked} /><//>
      <${F} label="80% state of charge voltage" htmlFor="bms.voltage_80_soc"><${Num} f=${f} k="bms.voltage_80_soc" min="8" max="999" step=".1" disabled=${locked} /><//>`}
    ${real &&
    html`
      <${F} label="Invert current" htmlFor="bms.invert_current" class="sa-top">
        <${Sel} f=${f} k="bms.invert_current" disabled=${locked} options=${[['false', 'No'], ['true', 'Yes']]} />
        <${Note}>Check the sign: while the battery discharges, its current should read below zero.<//>
      <//>`}
    ${multiPack &&
    html`
      <${F} label="Maximum pack count" htmlFor="bms.maximum_pack_count" class="sa-top">
        <${Num} f=${f} k="bms.maximum_pack_count" min="1" max="32" step="1" disabled=${locked} />
        <${Note}>Some master packs repeat their own readings at the addresses after the last real pack. Set this to the number of packs installed to stop duplicates appearing.<//>
      <//>
      <${F} label="Read current from" htmlFor="bms.read_current_from_inverter" class="sa-top">
        <${Sel} f=${f} k="bms.read_current_from_inverter" disabled=${locked} options=${[['false', 'Battery'], ['true', 'Inverter']]} />
        <${Note}>Some batteries only report current for the master pack. Choose Inverter to take the battery current from the inverter instead.<//>
      <//>`}
    ${protocol &&
    html`
      <${F} label="Protocol state of charge" htmlFor="bms.protocol_soc"><${Sel} f=${f} k="bms.protocol_soc" disabled=${locked} options=${PROTOCOL_SOC} /><//>
      <${F} label="Protocol capacity" htmlFor="bms.protocol_capacity"><${Sel} f=${f} k="bms.protocol_capacity" disabled=${locked} options=${PROTOCOL_CAPACITY} /><//>
      <${F} label="Protocol temperature" htmlFor="bms.protocol_temperature" class="sa-top">
        <${Sel} f=${f} k="bms.protocol_temperature" disabled=${locked} options=${PROTOCOL_TEMPERATURE} />
        <${Note}>These three settings control how the values received from the battery are interpreted. Leave them on Auto detect unless readings look wrong.<//>
      <//>`}
    ${serial &&
    html`
      <${F} label="Protocol variant" htmlFor="bms.serial_protocol_variant" class="sa-top">
        <${Sel} f=${f} k="bms.serial_protocol_variant" disabled=${locked} options=${PROTOCOL_VARIANTS} />
        <${Note}>Changes the baud rate and pack addressing used to talk to the battery. Auto detect follows the selected battery model.<//>
      <//>
      <${F} label="Baud rate" htmlFor="bms.baud_rate">
        <${Sel} f=${f} k="bms.baud_rate" disabled=${locked} options=${[[0, 'Default'], ...bauds.map((b) => [b, String(b)])]} />
      <//>`}
    <${Footer} f=${f} />
  </form><//>`;
}

function Tariffs({ s }) {
  const f = useForm(s, ['tariff.import_price', 'tariff.export_price', 'site.co2_kg_per_kwh'], (d) =>
    Number(d['tariff.import_price']) < 0 || Number(d['tariff.export_price']) < 0 ? 'Prices cannot be negative.'
    : !(Number(d['site.co2_kg_per_kwh']) >= 0 && Number(d['site.co2_kg_per_kwh']) <= 5) ? 'CO₂ intensity must be between 0 and 5 kg per kWh.'
    : null,
  );
  const cur = s['grid.currency'] || '';
  return html`<${Section} icon="wallet" tone="accent" title="Tariffs & costs" desc="Flat prices and CO₂ intensity for the cost and savings estimates"><form onSubmit=${f.save}>
    <${F} label=${`Import price (${cur}/kWh)`} htmlFor="tariff.import_price"><${Num} f=${f} k="tariff.import_price" min="0" step="0.001" /><//>
    <${F} label=${`Export price (${cur}/kWh)`} htmlFor="tariff.export_price" class="sa-top">
      <${Num} f=${f} k="tariff.export_price" min="0" step="0.001" />
      <${Note}>Flat prices for the cost estimates on the Totals page. Set both to 0 to hide costs.<//>
    <//>
    <${F} label="CO₂ intensity (kg per kWh)" htmlFor="site.co2_kg_per_kwh" class="sa-top">
      <${Num} f=${f} k="site.co2_kg_per_kwh" min="0" max="5" step="0.01" />
      <${Note}>Grid emissions per kWh, used for "CO₂ saved" on the dashboard. Typical values are 0.2–0.5.<//>
    <//>
    <${Footer} f=${f} />
  </form><//>`;
}

export default function Advanced() {
  const s = useStore(appSettings);
  const status = usePoll('/api/devices/status', 5000);
  const [drivers, setDrivers] = useState(null);
  useEffect(() => {
    document.title = 'Advanced · Sunroost';
    api.get('/api/devices/drivers').then(setDrivers, () => {});
  }, []);
  if (!s) return html`<${ConfigPage} title="Advanced"><div class="loading">Loading…</div><//>`;
  const started = Boolean(status.data?.started);
  const driver = drivers?.inverters.find((d) => d.id === s['inverter.driver_id']);
  const bms = drivers?.batteries.find((d) => d.id === s['bms.driver_id']);
  return html`<${ConfigPage} title="Advanced">
    ${started && html`<div class="notice notice-info cfg-lock"><${Ic} name="lock" size="sm" /><span>Inverter and battery options are locked while connected. Disconnect on the <a href="/configuration#devices">Configuration</a> page to change them.</span></div>`}
    <${Dashboard} s=${s} />
    <${Grid} s=${s} />
    ${s['inverter.driver_id'] && html`<${Inverter} s=${s} driver=${driver} locked=${started} />`}
    <${Battery} s=${s} bms=${bms} locked=${started} />
    <${Tariffs} s=${s} />
  <//>`;
}

injectCss('css-config-advanced', `
.cfg-f.sa-top > .field-label { padding-top: 9px; }
`);
