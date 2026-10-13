// Log viewer: everything in the server's ring buffer plus live lines, with tag filter chips (with
// counts), level filter, search, pause/resume and download as text.
import { api, html, onLog, useEffect, useMemo, useRef, useState } from '../lib/core.js';
import { Button, Ic, Page, Segmented } from '../lib/ui.js';

const MAX = 5000;
const SHOW = 1500;
const KNOWN_TAGS = ['devices', 'mqtt', 'automation', 'grid', 'system', 'db'];
const LEVELS = [{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'error', label: 'Errors' }];
const CRUMBS = [['Configuration', '/configuration']];

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const lineText = (l) => `${stamp(l.ts)} [${l.tag}] ${l.level === 'info' ? '' : l.level.toUpperCase() + ': '}${l.message}`;

export default function Logs() {
  const [lines, setLines] = useState([]); // newest first
  const [pending, setPending] = useState([]);
  const [paused, setPaused] = useState(false);
  const [tags, setTags] = useState(new Set());
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    api.get(`/api/logs?limit=2000`).then(
      (l) => alive && (setLines((cur) => [...cur, ...l].slice(0, MAX)), setLoaded(true)),
      (e) => alive && (setError(e.message), setLoaded(true)),
    );
    const off = onLog((line) => {
      if (pausedRef.current) setPending((p) => [line, ...p].slice(0, MAX));
      else setLines((l) => [line, ...l].slice(0, MAX));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const resume = () => {
    setLines((l) => [...pending, ...l].slice(0, MAX));
    setPending([]);
    setPaused(false);
  };

  const allTags = useMemo(() => [...new Set([...KNOWN_TAGS, ...lines.map((l) => l.tag)])], [lines]);
  const counts = useMemo(() => {
    const c = {};
    for (const l of lines) c[l.tag] = (c[l.tag] ?? 0) + 1;
    return c;
  }, [lines]);
  const q = query.trim().toLowerCase();
  const filtered = lines.filter(
    (l) =>
      (!tags.size || tags.has(l.tag)) &&
      (level === 'all' || (level === 'warn' ? l.level !== 'info' : l.level === 'error')) &&
      (!q || l.message.toLowerCase().includes(q) || l.tag.includes(q)),
  );
  const toggleTag = (t) =>
    setTags((cur) => {
      const next = new Set(cur);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  const download = () => {
    const text = [...filtered].reverse().map(lineText).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `sunroost-log-${stamp(Date.now()).replace(/[: ]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filteredOut = lines.length > 0 && filtered.length === 0;
  return html`<${Page} title="Logs" crumbs=${CRUMBS}>
    <section class="card lg-card">
      <header class="lg-head">
        <span class="chip-ic sm accent"><${Ic} name="scroll-text" /></span>
        <div class="lg-title">
          <h2>System log</h2>
          <p>
            ${paused
              ? html`<span class="badge badge-warn"><span class="dt-dot lg-dot-s"></span>Paused${pending.length ? ` · ${pending.length} new` : ''}</span>`
              : html`<span class="badge badge-ok"><span class="dt-dot lg-dot-s"></span>Live</span>`}
            <span class="num">${filtered.length === lines.length ? `${lines.length} lines` : `${filtered.length} of ${lines.length} lines`}</span>
            ${filtered.length > SHOW && html`<span>· showing the newest ${SHOW}</span>`}
          </p>
        </div>
        <div class="lg-actions">
          ${paused
            ? html`<${Button} small kind="primary" onClick=${resume}><${Ic} name="play" size="sm" />Resume${pending.length ? ` (${pending.length})` : ''}<//>`
            : html`<${Button} small onClick=${() => setPaused(true)}><${Ic} name="pause" size="sm" />Pause<//>`}
          <${Button} small onClick=${download} disabled=${!filtered.length}><${Ic} name="download" size="sm" />Download<//>
        </div>
      </header>

      <div class="lg-bar">
        <label class="lg-search">
          <${Ic} name="search" size="sm" />
          <input type="search" aria-label="Search logs" placeholder="Search messages and tags" value=${query} onInput=${(e) => setQuery(e.target.value)} />
        </label>
        <${Segmented} value=${level} options=${LEVELS} onChange=${setLevel} />
      </div>

      <div class="lg-chips" role="group" aria-label="Tags">
        <button type="button" class=${`lg-chip ${tags.size === 0 ? 'on' : ''}`} aria-pressed=${tags.size === 0} onClick=${() => setTags(new Set())}>
          All<span class="lg-n">${lines.length}</span>
        </button>
        ${allTags.map((t) => html`<button type="button" class=${`lg-chip ${tags.has(t) ? 'on' : ''}`} aria-pressed=${tags.has(t)} onClick=${() => toggleTag(t)}>
          ${t}<span class="lg-n">${counts[t] ?? 0}</span>
        </button>`)}
      </div>

      ${error && html`<div class="notice notice-bad">${error}</div>`}

      <div class="log lg-view" role="log" aria-live="off">
        ${filtered.length === 0 &&
        html`<div class="lg-empty">
          <${Ic} name=${filteredOut ? 'search-x' : 'scroll-text'} size="lg" />
          <b>${!loaded ? 'Loading…' : filteredOut ? 'No lines match the filters' : 'No log entries yet'}</b>
          ${filteredOut && html`<${Button} small kind="ghost" onClick=${() => (setTags(new Set()), setLevel('all'), setQuery(''))}>Clear filters<//>`}
        </div>`}
        ${filtered.slice(0, SHOW).map(
          (l) => html`<div class=${`lg-line lg-${l.level}`}>
            <span class="lg-dot" title=${l.level}></span>
            <span class="lg-time num" title=${stamp(l.ts)}>${stamp(l.ts).slice(5)}</span>
            <span class="lg-tag">${l.tag}</span>
            <span class="lg-msg">${l.message}</span>
          </div>`,
        )}
      </div>
    </section>
  <//>`;
}

const css = `
.lg-card { display: flex; flex-direction: column; gap: 14px; }
.lg-head .chip-ic.accent { padding: 0; margin: 0; border: 0; }
.lg-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lg-title { flex: 1; min-width: 180px; }
.lg-title h2 { font-size: 15.5px; }
.lg-title p { margin: 3px 0 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.lg-title .badge { padding: 1px 8px; font-size: 11.5px; }
.lg-dot-s, .dt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.lg-actions { display: flex; gap: 8px; }
.lg-actions .btn .ic { margin-left: -3px; }
.lg-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.lg-search { position: relative; flex: 1 1 260px; display: flex; align-items: center; min-width: 0; }
.lg-search .ic { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
.lg-search input { padding-left: 36px; max-width: 460px; height: 38px; }
.lg-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.lg-chip { font: inherit; font-size: 12.5px; font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: #5b6271; border-radius: 999px; padding: 4px 6px 4px 12px; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; transition: background .15s; }
.lg-chip:hover { background: var(--surface-2); }
.lg-chip.on { background: var(--accent-soft); color: var(--accent-text); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.lg-n { font-size: 11px; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--surface-2); color: var(--muted); text-align: center; font-variant-numeric: tabular-nums; }
.lg-chip.on .lg-n { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-text); }
.lg-view { height: calc(100vh - 330px); min-height: 340px; padding: 6px 8px; border: 1px solid var(--border); }
.lg-line { display: flex; gap: 10px; align-items: baseline; padding: 4px 6px; border-radius: 6px; line-height: 1.5; }
.lg-line:hover { background: var(--surface); }
.lg-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; align-self: center; }
.lg-warn .lg-dot { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.lg-error .lg-dot { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.lg-time { color: var(--muted); flex: none; }
.lg-tag { flex: none; font-family: var(--font); font-size: 11px; font-weight: 600; padding: 0 8px; border-radius: 999px; background: var(--surface-3); color: #5b6271; min-width: 64px; text-align: center; }
.lg-msg { white-space: pre-wrap; word-break: break-word; min-width: 0; color: var(--text); }
.lg-warn .lg-msg { color: #8a5a00; }
.lg-error .lg-msg { color: var(--bad); }
.lg-error { background: color-mix(in srgb, var(--bad-soft) 55%, transparent); }
.lg-empty { height: 100%; min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-family: var(--font); }
.lg-empty .ic { color: var(--faint); }
.lg-empty b { color: var(--heading); font-weight: 650; font-size: 13.5px; }
@media (max-width: 560px) {
  .lg-actions { width: 100%; }
  .lg-actions .btn { flex: 1; }
  .lg-bar .seg { width: 100%; }
  .lg-bar .seg button { flex: 1; }
  .lg-search input { max-width: none; }
  .lg-view { height: calc(100vh - 380px); }
  .lg-line { flex-wrap: wrap; column-gap: 8px; row-gap: 2px; }
  .lg-msg { flex-basis: 100%; padding-left: 17px; }
}
`;
if (!document.getElementById('css-tools-logs')) {
  const el = document.createElement('style');
  el.id = 'css-tools-logs';
  el.textContent = css;
  document.head.appendChild(el);
}
