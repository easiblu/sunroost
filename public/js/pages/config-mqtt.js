// Configuration › MQTT: the configuration card (topics, Home Assistant, authentication, broker),
// locked while the broker runs, next to broker status, the MQTT log, a topic browser and a
// Home Assistant example.
import { api, appSettings, html, saveSettings, useEffect, useMemo, useState, useStore } from '../lib/core.js';
import { Badge, Ic, LogPanel, Row, Toggle, toast } from '../lib/ui.js';
import { Btns, ConfigPage, F, Section, Sub, Val, injectCss, usePoll } from './configuration.js';

/** Address Home Assistant should use for the broker. */
function brokerAddress(st) {
  if (!st) return '';
  if (st.broker === 'external') return st.url || '(no URL configured)';
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
  const host = local && st.addresses?.length ? st.addresses[0] : location.hostname;
  return `mqtt://${host}:${st.port}`;
}

const KEYS = ['mqtt_prefix', 'mqtt_allow_update', 'reset_energy', 'mqtt_uniq_id', 'mqtt_discovery', 'mqtt_username', 'mqtt.broker', 'mqtt.port', 'mqtt.url'];

function ConfigCard({ s, locked }) {
  const [draft, setDraft] = useState({});
  const [pwEdit, setPwEdit] = useState(false);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const v = (k) => (k in draft ? draft[k] : s[k]);
  const set = (k) => (val) => setDraft((d) => ({ ...d, [k]: val }));
  const dirty = KEYS.some((k) => k in draft && draft[k] !== s[k]) || (pwEdit && password !== '');
  const external = v('mqtt.broker') === 'external';

  const save = async (e) => {
    e.preventDefault();
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, val]) => val !== s[k]));
    if ('mqtt.port' in changed) {
      const p = Number(changed['mqtt.port']);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return toast('Port must be 1–65535', 'bad');
      changed['mqtt.port'] = p;
    }
    if ('mqtt_prefix' in changed && !/^[^#+\s]+$/.test(changed.mqtt_prefix)) return toast('Topic prefix may not contain spaces, # or +', 'bad');
    if (external && !String(v('mqtt.url')).match(/^(mqtts?|wss?|tcp|ssl):\/\//)) return toast('Broker URL must start with mqtt:// or mqtts://', 'bad');
    if (pwEdit && password && (password.length < 4 || password.length > 64)) return toast('Password must be 4 to 64 characters', 'bad');
    setSaving(true);
    try {
      if (pwEdit && password) await api.post('/api/mqtt/password', { password });
      await saveSettings(changed);
      setDraft({});
      setPwEdit(false);
      setPassword('');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  };
  const clearPassword = async () => {
    try {
      await api.post('/api/mqtt/password', { password: null });
      await saveSettings({});
      setPwEdit(false);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const sel = (k, options) => html`<select id=${k} disabled=${locked} onChange=${(e) => set(k)(options[0][0] === true ? e.target.value === 'true' : e.target.value)}>
    ${options.map(([val, label]) => html`<option value=${String(val)} selected=${v(k) === val}>${label}</option>`)}
  </select>`;
  const text = (k, extra = {}) => html`<input id=${k} type="text" disabled=${locked} value=${v(k)} onInput=${(e) => set(k)(e.target.value.trim())} ...${extra} />`;
  const enabled = [[true, 'Enabled'], [false, 'Disabled']];

  return html`<${Section} icon="radio-tower" tone="grid" title="MQTT configuration" desc="Topics, Home Assistant discovery, authentication and broker"
    actions=${locked ? html`<${Badge} kind="ok">Running<//>` : html`<${Badge}>Stopped<//>`}>
    ${locked && html`<div class="notice notice-info cfg-lock"><${Ic} name="lock" size="sm" /><span>Stop the MQTT broker on the <a href="/configuration">Configuration</a> page to make changes.</span></div>`}
    <form onSubmit=${save}>
      <${Sub} icon="list-tree">Topics<//>
      <${F} label="Topic prefix" htmlFor="mqtt_prefix">${text('mqtt_prefix')}
        <span class="cfg-hint">Default <code>sunroost</code>. Moving from SolarAssistant? Set it to <code>solar_assistant</code> so existing Home Assistant setups keep working.</span>
      <//>
      <${F} label="Allow setting changes" htmlFor="mqtt_allow_update">${sel('mqtt_allow_update', [[false, 'Disabled'], [true, 'Enabled']])}<//>
      <${F} label="Reset energy totals" htmlFor="reset_energy">${sel('reset_energy', [['d', 'Daily'], ['w', 'Weekly'], ['m', 'Monthly']])}<//>
      <${Sub} icon="house">Home Assistant<//>
      <${F} label="Unique ID" htmlFor="mqtt_uniq_id">${text('mqtt_uniq_id')}<//>
      <${F} label="Auto discovery" htmlFor="mqtt_discovery">${sel('mqtt_discovery', enabled)}<//>
      <${Sub} icon="key-round">Authentication<//>
      <${F} label="Username" htmlFor="mqtt_username">${text('mqtt_username', { autocomplete: 'off' })}<//>
      <${F} label="Password" htmlFor="mqtt_password">
        ${pwEdit
          ? html`<input id="mqtt_password" type="password" minlength="4" maxlength="64" autocomplete="new-password" disabled=${locked}
              value=${password} onInput=${(e) => setPassword(e.target.value)} />`
          : html`<${Val} action=${!locked && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setPwEdit(true)}>Edit</button>
                ${s.mqtt_password_set && html`<button type="button" class="btn btn-sm" onClick=${clearPassword}>Clear</button>`}`}>
              ${s.mqtt_password_set ? html`<span class="mq-dots">●●●●●●●●</span>` : html`<${Badge} kind="warn">Blank<//>`}
            <//>`}
      <//>
      <${Sub} icon="server">Broker<//>
      <${F} label="Broker" htmlFor="mqtt.broker">${sel('mqtt.broker', [['builtin', 'Built-in broker on this device'], ['external', 'External broker']])}<//>
      ${external
        ? html`<${F} label="Broker URL" htmlFor="mqtt.url">${text('mqtt.url', { placeholder: 'mqtt://homeassistant.local:1883' })}<//>`
        : html`<${F} label="Port" htmlFor="mqtt.port">
            <input id="mqtt.port" type="number" min="1" max="65535" disabled=${locked} value=${v('mqtt.port')} onInput=${(e) => set('mqtt.port')(Number(e.target.value))} />
          <//>`}
      <${Btns}>
        ${dirty && html`<button type="button" class="btn" onClick=${() => (setDraft({}), setPwEdit(false), setPassword(''))}>Cancel</button>`}
        <button type="submit" class="btn btn-primary" disabled=${!dirty || saving || locked}>${saving ? 'Saving…' : 'Save'}</button>
      <//>
    </form>
  <//>`;
}

function StatusSection({ st }) {
  const state = !st
    ? '–'
    : !st.enabled
      ? html`<${Badge}>Disabled<//>`
      : st.running && st.connected
        ? html`<${Badge} kind="ok">Running<//>`
        : st.lastError
          ? html`<${Badge} kind="bad">${st.lastError}<//>`
          : html`<${Badge} kind="warn">Connecting<//>`;
  return html`<${Section} icon="activity" tone="battery" title="Broker status" desc="Live state of the MQTT connection">
    <${Row} label="Status">${state}<//>
    <${Row} label="Address"><span class="mono">${brokerAddress(st)}</span><//>
    ${st?.broker === 'builtin' && html`<${Row} label="Connected clients">${st?.running ? st.clients : '–'}<//>`}
    <${Row} label="Topics published">${st?.running ? st.topicCount : '–'}<//>
    <${Row} label="Discovery entities">${st?.running ? st.discoveryCount : '–'}<//>
  <//>`;
}

function TopicBrowser({ running }) {
  const [filter, setFilter] = useState('');
  const [discovery, setDiscovery] = useState(false);
  const { data } = usePoll(`/api/mqtt/topics${discovery ? '?discovery=1' : ''}`, 3000);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data ?? []).filter((t) => !q || t.topic.toLowerCase().includes(q) || t.value.toLowerCase().includes(q));
  }, [data, filter]);
  return html`<${Section} icon="list-tree" tone="load" title="Topics" desc="Values published by this device"
    actions=${data && html`<${Badge}>${rows.length} of ${data.length}<//>`}>
    <div class="mq-filter">
      <div class="cfg-search"><${Ic} name="search" size="sm" />
        <input type="search" placeholder="Filter, e.g. battery or pv_power" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="Filter topics" /></div>
      <${Toggle} checked=${discovery} onChange=${setDiscovery} label="Discovery configs" />
    </div>
    ${!running
      ? html`<div class="empty"><${Ic} name="radio-tower" /><div>MQTT is not running.</div></div>`
      : !data
        ? html`<div class="muted">Loading…</div>`
        : rows.length === 0
          ? html`<div class="empty"><${Ic} name="search-x" /><div>No matching topics.</div></div>`
          : html`<div class="table-wrap mq-topics"><table class="table">
              <thead><tr><th>Topic</th><th>Value</th></tr></thead>
              <tbody>${rows.map((t) => html`<tr key=${t.topic}><td>${t.topic.split('/').map((part, i) => html`${i ? html`/<wbr />` : ''}${part}`)}</td>
                <td>${t.value.length > 160 ? t.value.slice(0, 160) + '…' : t.value || html`<span class="muted">(empty)</span>`}</td></tr>`)}</tbody>
            </table></div>`}
  <//>`;
}

function snippet(st, s) {
  const prefix = st?.prefix || 'sunroost';
  const addr = brokerAddress(st);
  const head = s?.mqtt_discovery
    ? `# Auto discovery is on: add the MQTT integration in Home Assistant
# (Settings › Devices & services › Add integration › MQTT) with broker
#   ${addr}${s?.mqtt_username ? `\n#   Username: ${s.mqtt_username}` : ''}
# Devices "Inverter 1", "Battery 1" and "Total" then appear on their own.
#
# Without discovery, define entities in configuration.yaml:
`
    : `# Add to configuration.yaml (broker: ${addr}):\n`;
  return `${head}mqtt:
  sensor:
    - name: "PV power"
      state_topic: "${prefix}/total/pv_power/state"
      unit_of_measurement: "W"
      device_class: power
      state_class: measurement
    - name: "Battery state of charge"
      state_topic: "${prefix}/total/battery_state_of_charge/state"
      unit_of_measurement: "%"
      device_class: battery
      state_class: measurement
    - name: "PV energy"
      state_topic: "${prefix}/total/pv_energy/state"
      unit_of_measurement: "kWh"
      device_class: energy
      state_class: total_increasing
${s?.mqtt_allow_update ? `  select:
    - name: "Output source priority"
      state_topic: "${prefix}/inverter_1/output_source_priority/state"
      command_topic: "${prefix}/inverter_1/output_source_priority/set"
      options: ["Utility first", "Solar first", "Solar/Battery/Utility"]
` : ''}`;
}

function Snippet({ st, s }) {
  const text = snippet(st, s);
  return html`<${Section} icon="house" tone="accent" title="Home Assistant example" desc="Broker address and sensors for configuration.yaml"
    actions=${navigator.clipboard && html`<button type="button" class="btn btn-sm" onClick=${() => navigator.clipboard.writeText(text).then(() => toast('Copied'))}><${Ic} name="copy" size="sm" />Copy</button>`}>
    <pre class="cfg-pre">${text}</pre>
  <//>`;
}

export default function ConfigMqtt() {
  const s = useStore(appSettings);
  const { data: st, reload } = usePoll('/api/mqtt/status', 3000);
  useEffect(() => {
    const t = setTimeout(reload, 400);
    return () => clearTimeout(t);
  }, [s]);
  if (!s) return html`<${ConfigPage} title="MQTT"><div class="loading">Loading…</div><//>`;
  return html`<${ConfigPage} title="MQTT" wide>
    <div class="mq-cols">
      <div class="cfg-stack">
        <${ConfigCard} s=${s} locked=${Boolean(s.publish_mqtt)} />
        <${StatusSection} st=${st} />
      </div>
      <div class="cfg-stack">
        <${Section} icon="scroll-text" title="MQTT log" desc="Connection and publishing messages"><${LogPanel} tag="mqtt" height=${360} /><//>
        <${Snippet} st=${st} s=${s} />
      </div>
    </div>
    <${TopicBrowser} running=${Boolean(st?.running)} />
  <//>`;
}

injectCss('css-config-mqtt', `
.mq-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 1200px) { .mq-cols { grid-template-columns: minmax(0, 1fr); } }
.mq-dots { letter-spacing: 2px; color: var(--muted); }
.mq-filter { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.mq-filter .cfg-search { flex: 1 1 240px; }
.mq-topics { max-height: 480px; overflow: auto; }
.mq-topics table { table-layout: fixed; font-size: 12px; font-family: var(--mono); }
.mq-topics td, .mq-topics th { white-space: normal; text-align: left; overflow-wrap: anywhere; }
.mq-topics td:first-child, .mq-topics th:first-child { width: 58%; }
`);
