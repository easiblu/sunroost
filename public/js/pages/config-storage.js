// Configuration › Storage: storage device (usage + maintenance actions), backup and restore,
// database details with the detail-retention setting, and the storage log.
import { api, appSettings, fmtDateTime, html, saveSettings, useApi, useState, useStore } from '../lib/core.js';
import { Badge, Ic, IconChip, LogPanel, Row, confirmAction, toast } from '../lib/ui.js';
import { Btns, ConfigPage, Perform, Section, fmtBytes, fmtDf, injectCss, usePoll } from './configuration.js';

function Backup({ info, onRestarting }) {
  const [mode, setMode] = useState('idle'); // idle | browse | ready | uploading
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const upload = async () => {
    if (!file) return;
    if (!confirmAction(`Replace the current database with ${file.name}? Settings, history and totals are overwritten and the application restarts.`)) return;
    setMode('uploading');
    setStatus(`Uploading ${file.name}...`);
    try {
      const res = await fetch('/api/storage/restore?restart=1', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      onRestarting();
    } catch (err) {
      setStatus(`Failed to upload ${file.name}: ${err.message}`);
      setMode('ready');
    }
  };
  const reset = () => (setFile(null), setMode('idle'), setStatus(''));
  return html`<${Section} icon="archive-restore" tone="load" title="Backup & restore" desc="One file with settings, history and totals">
    ${mode === 'idle' &&
    html`<div class="st-tiles">
      <a href="/api/storage/backup" download class="st-tile">
        <${IconChip} name="hard-drive-download" tone="load" />
        <span><b>Download backup</b><small>Save a copy of the database to this computer</small></span>
      </a>
      <button type="button" class="st-tile" onClick=${() => setMode('browse')}>
        <${IconChip} name="hard-drive-upload" tone="battery" />
        <span><b>Restore from file</b><small>Replace the database with a backup; the app restarts</small></span>
      </button>
    </div>`}
    ${mode === 'browse' &&
    html`<div class="st-drop">
      <${Ic} name="file-up" size="lg" />
      <input type="file" accept=".db,.sqlite,.sqlite3" aria-label="Backup file" onChange=${(e) => {
        const f = e.target.files?.[0];
        if (f) (setFile(f), setMode('ready'), setStatus(''));
      }} />
      <button type="button" class="btn btn-sm" onClick=${reset}>Cancel</button>
    </div>`}
    ${(mode === 'ready' || mode === 'uploading') &&
    html`<div class="list-item st-file">
        <${IconChip} name="database" tone="battery" />
        <div class="list-main"><div class="list-title">${file.name}</div><div class="list-sub">${fmtBytes(file.size)} · selected on this computer</div></div>
      </div>
      <${Btns}>
        ${mode === 'ready' && html`<button type="button" class="btn" onClick=${reset}>Clear</button>`}
        <button type="button" class="btn btn-primary" disabled=${mode === 'uploading'} onClick=${() => mode === 'ready' && upload()}>
          <${Ic} name="upload" size="sm" />${mode === 'uploading' ? 'Uploading…' : 'Import and restart'}</button>
      <//>`}
    ${status && html`<div class=${`notice ${status.startsWith('Failed') ? 'notice-bad' : 'notice-info'} cfg-err`}>${status}</div>`}
    ${info?.restorePending && html`<div class="notice notice-warn cfg-err">A restored backup is waiting and is applied when the application restarts.</div>`}
  <//>`;
}

function Retention() {
  const s = useStore(appSettings);
  const [value, setValue] = useState(null);
  const current = s?.['history.raw_retention_days'] ?? 14;
  const v = value ?? current;
  const save = async () => {
    const n = Math.round(Number(v));
    if (!(n >= 1 && n <= 365)) return toast('Choose between 1 and 365 days', 'bad');
    try {
      await saveSettings({ 'history.raw_retention_days': n });
      setValue(null);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const dirty = Number(v) !== current;
  return html`
    <div class="field cfg-f st-ret">
      <label class="field-label" for="retention">Keep 10-second detail for<span class="hint">Older data keeps 5-minute averages</span></label>
      <div class="cfg-fc"><span class="input-unit"><input id="retention" type="number" min="1" max="365" value=${v} onInput=${(e) => setValue(e.target.value)} /><span class="muted">days</span></span></div>
    </div>
    <${Btns}>
      ${dirty && html`<button type="button" class="btn" onClick=${() => setValue(null)}>Cancel</button>`}
      <button type="button" class="btn btn-primary" disabled=${!dirty} onClick=${save}>Save</button>
    <//>
  `;
}

export default function ConfigStorage() {
  const { data: info, reload } = useApi('/api/storage');
  const { data: sys } = usePoll('/api/system', 0);
  const s = useStore(appSettings);
  const [restarting, setRestarting] = useState(false);

  const resample = async () => {
    if (!confirmAction('Are you sure you want to resample totals?')) return;
    try {
      await api.post('/api/storage/resample-totals');
      toast('Resampling started; progress shows in the storage log');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setTimeout(reload, 1500);
    }
  };
  const clear = async () => {
    if (!confirmAction('Are you sure you want to clear all historic charts and totals?')) return;
    try {
      await api.post('/api/storage/clear-history', { confirm: true });
      toast('History cleared');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  if (restarting) return html`<${Perform} action="restart-app" seconds=${10} name=${s?.['site.name'] || 'Sunroost'} />`;
  const total = info?.diskTotal ?? sys?.disk?.total;
  const used = info?.diskTotal ? info.diskTotal - info.diskFree : sys?.disk?.used;
  const pct = total ? Math.round((used / total) * 100) : null;
  return html`<${ConfigPage} title="Storage">
    <${Section} icon="hard-drive" tone="battery" title="Storage device" desc="Disk holding the database">
      <div class="st-usage">
        <div class="st-usage-top"><b>${pct === null ? '–' : `${pct}%`}</b><span class="muted">${total ? `${fmtDf(used)} of ${fmtDf(total)} used` : 'Usage unknown'}</span>
          ${sys?.disk?.type && html`<${Badge}>${sys.disk.type}<//>`}</div>
        <div class="st-bar"><i class=${pct > 90 ? 'bad' : ''} style=${`width:${pct ?? 0}%`}></i></div>
      </div>
      <${Btns}>
        <button type="button" class="btn" disabled=${info?.resampling} onClick=${resample}><${Ic} name="refresh-cw" size="sm" />${info?.resampling ? 'Resampling…' : 'Resample totals'}</button>
        <button type="button" class="btn btn-danger" onClick=${clear}><${Ic} name="trash-2" size="sm" />Clear historic data</button>
      <//>
    <//>
    <${Backup} info=${info} onRestarting=${() => setRestarting(true)} />
    <${Section} icon="database" tone="grid" title="Database" desc="History kept on this device">
      <${Row} label="Database size">${info ? fmtBytes(info.dbSizeBytes) : '–'}<//>
      <${Row} label="Detailed history">${info ? `${info.rawRows.toLocaleString()} rows (10-second samples)` : '–'}<//>
      <${Row} label="Long-term history">${info ? `${info.rollupRows.toLocaleString()} rows (5-minute averages)` : '–'}<//>
      <${Row} label="Daily totals">${info ? `${info.totalsDays.toLocaleString()} days${info.firstTotalsDay ? ` since ${info.firstTotalsDay}` : ''}` : '–'}<//>
      <${Row} label="Oldest record">${info?.oldest ? fmtDateTime(info.oldest) : '–'}<//>
      <${Retention} />
    <//>
    <${Section} icon="scroll-text" title="Storage log" desc="Database maintenance messages">
      <${LogPanel} tag="db" height=${360} />
    <//>
  <//>`;
}

injectCss('css-config-storage', `
.st-usage { display: flex; flex-direction: column; gap: 10px; }
.st-usage-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.st-usage-top b { font-size: 26px; font-weight: 750; letter-spacing: -0.02em; color: var(--heading); font-variant-numeric: tabular-nums; }
.st-bar { height: 10px; border-radius: 5px; background: var(--surface-3); overflow: hidden; }
.st-bar i { display: block; height: 100%; border-radius: 5px; background: linear-gradient(90deg, var(--battery), #46c98a); }
.st-bar i.bad { background: linear-gradient(90deg, #f59e0b, var(--bad)); }
.st-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.st-tile { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 16px; border: 1.5px dashed var(--border); background: var(--surface-2);
  font: inherit; text-align: left; color: var(--text); cursor: pointer; text-decoration: none; }
.st-tile:hover { border-color: var(--accent); background: var(--accent-soft); text-decoration: none; }
.st-tile span { display: flex; flex-direction: column; min-width: 0; }
.st-tile b { color: var(--heading); font-weight: 650; }
.st-tile small { color: var(--muted); font-size: 12px; }
.st-drop { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 16px; border: 1.5px dashed var(--accent); background: var(--accent-soft); flex-wrap: wrap; }
.st-drop > .ic { color: var(--accent); }
.st-drop input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; }
.st-file { border: 1px solid var(--border); border-radius: 14px; padding: 10px 12px; }
.st-ret { border-top: 1px solid var(--grid-line); margin-top: 4px; }
@media (max-width: 560px) { .st-tiles { grid-template-columns: 1fr; } }
`);
