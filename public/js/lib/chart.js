// Chart helpers in the app's design language: Inter labels, soft grid lines, gradient area fills,
// rounded dark tooltips and dot legends. Series colours come from the CSS tokens (--solar, --load,
// --grid, --battery …). uPlot is loaded globally by index.html (window.uPlot).
import { html, useEffect, useMemo, useRef, useState } from './core.js';
import { useWidth } from './ui.js';

/** CSS custom property value, e.g. color('--solar'). */
export const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const PALETTE = {
  pv: '--solar',
  load: '--load',
  grid: '--grid',
  battery: '--battery',
  soc: '--battery',
};

/** Font used on canvas axes. */
export const AXIS_FONT = '500 11px Inter, system-ui, sans-serif';

/** '--solar' → its value; other colours pass through. */
export const resolveColor = (c) => (typeof c === 'string' && c.startsWith('--') ? color(c) : c);

/** Any '#rgb', '#rrggbb', 'rgb()' or '--token' colour with an alpha. */
export function toRgba(c, a) {
  const v = resolveColor(c) || '#888888';
  if (v.startsWith('#')) {
    let hex = v.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split(/[\s,/]+/);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return v;
}

/** CSS colour for SVG/HTML: '--solar' → 'var(--solar)'. */
export const cssColor = (c) => (typeof c === 'string' && c.startsWith('--') ? `var(${c})` : c);

/** uPlot fill: vertical gradient from `alpha` at the top of the plot to transparent. */
export const gradientFill = (c, alpha = 0.28) => (u) => {
  const top = u.bbox.top;
  const h = u.bbox.height;
  if (!Number.isFinite(top) || !(h > 0)) return toRgba(c, alpha / 2);
  const g = u.ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, toRgba(c, alpha));
  g.addColorStop(1, toRgba(c, 0));
  return g;
};

/** Hex alpha suffix ('30') or true → a gradient top opacity. */
const fillAlpha = (fill) => (typeof fill === 'string' ? Math.min(0.5, parseInt(fill, 16) / 255 + 0.08) : 0.24);

const powerTick = (v) => (v == null ? '' : Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`);

/** "Mon 12 Oct, 14:35" for tooltip headers. */
export function fmtTipTime(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Shared axis style for uPlot. */
export function axisStyle() {
  return {
    stroke: color('--muted'),
    font: AXIS_FONT,
    grid: { stroke: color('--grid-line'), width: 1 },
    ticks: { show: false },
    border: { show: false },
    gap: 6,
  };
}

/**
 * uPlot plugin: a rounded floating tooltip that follows the cursor.
 * rows(u, idx) → [{ color, label, value }] ; header(u, idx) → string.
 */
export function tooltipPlugin({ rows, header = (u, idx) => fmtTipTime(u.data[0][idx]) }) {
  let tip;
  const hide = () => tip && (tip.style.display = 'none');
  return {
    hooks: {
      init: [
        (u) => {
          tip = document.createElement('div');
          tip.className = 'ch-tip';
          u.over.appendChild(tip);
          u.over.addEventListener('mouseleave', hide);
        },
      ],
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          if (!tip) return;
          if (idx == null || u.cursor.left == null || u.cursor.left < 0) return hide();
          const list = rows(u, idx).filter((r) => r.value != null);
          if (!list.length) return hide();
          tip.innerHTML = `<div class="ch-tip-head">${esc(header(u, idx))}</div>${list
            .map((r) => `<div class="ch-tip-row"><i style="background:${r.color}"></i><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`)
            .join('')}`;
          tip.style.display = 'block';
          const w = tip.offsetWidth;
          const h = tip.offsetHeight;
          const ow = u.over.clientWidth;
          const oh = u.over.clientHeight;
          const x = u.cursor.left;
          const y = u.cursor.top ?? 0;
          tip.style.left = `${x + 16 + w > ow ? Math.max(0, x - w - 16) : x + 16}px`;
          tip.style.top = `${Math.max(-8, Math.min(oh - h + 8, y - h / 2))}px`;
        },
      ],
    },
  };
}

/** Bumps when the color theme changes so canvases can be redrawn with new colors. */
export function useThemeKey() {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const bump = () => setKey((k) => k + 1);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', bump);
      mo.disconnect();
    };
  }, []);
  return key;
}

/** Clickable dot legend that hides/shows uPlot series. */
function SeriesLegend({ series, plot, hidden, setHidden }) {
  return html`<div class="ch-legend">
    ${series.map((s, i) => html`<button type="button" class=${hidden[i] ? 'off' : ''} style=${`--c:${cssColor(s.color)}`}
      onClick=${() => {
        const next = { ...hidden, [i]: !hidden[i] };
        setHidden(next);
        plot.current?.setSeries(i + 1, { show: !next[i] });
      }}><i></i>${s.label}</button>`)}
  </div>`;
}

/**
 * Time-series chart.
 * xs: unix seconds; series: [{ label, values, color (CSS var or hex), scale?, fill?, dash?, unit?, width?, bars? }]
 * scales: optional uPlot scales config, e.g. { '%': { range: [0, 100] } }.
 */
export function TimeChart({ xs, series, height = 260, scales = {}, unit = 'W', legend = true, syncKey }) {
  const [wrapRef, width] = useWidth();
  const plotRef = useRef(null);
  const holder = useRef(null);
  const [hidden, setHidden] = useState({});
  const themeKey = useThemeKey();
  const fmtVal = (s, v) => (v == null ? null : `${s.unit === '%' || s.scale === '%' ? Math.round(v) : powerTick(v)} ${s.unit ?? s.scale ?? unit}`);

  useEffect(() => {
    if (!width || !holder.current) return;
    const axis = axisStyle();
    const rightScales = [...new Set(series.filter((s) => s.scale).map((s) => s.scale))];
    const opts = {
      width,
      height,
      padding: [10, 6, 0, 0],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false },
        sync: syncKey ? { key: syncKey } : undefined,
        points: { size: 9, width: 2, fill: color('--surface') },
      },
      scales: { x: { time: true }, ...scales },
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          show: !hidden[i],
          stroke: resolveColor(s.color),
          width: s.width ?? 2,
          fill: s.fill ? gradientFill(s.color, fillAlpha(s.fill)) : undefined,
          dash: s.dash,
          scale: s.scale ?? 'y',
          spanGaps: false,
          points: { show: false },
          paths: s.bars ? uPlot.paths.bars({ size: [0.6, 40], radius: 0.3 }) : undefined,
        })),
      ],
      axes: [
        { ...axis, space: 70 },
        { ...axis, scale: 'y', size: 46, values: (u, vals) => vals.map((v) => `${powerTick(v)}`) },
        ...rightScales.map((sc) => ({
          ...axis,
          scale: sc,
          side: 1,
          size: 44,
          grid: { show: false },
          values: (u, vals) => vals.map((v) => (v == null ? '' : `${v}${sc === '%' ? '%' : ''}`)),
        })),
      ],
      plugins: [
        tooltipPlugin({
          rows: (u, idx) => series.map((s, i) => (u.series[i + 1].show ? { color: resolveColor(s.color), label: s.label, value: fmtVal(s, u.data[i + 1][idx]) } : {})),
        }),
      ],
    };
    const data = [xs, ...series.map((s) => s.values)];
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, holder.current);
    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [width, height, themeKey, series.length, series.map((s) => s.label + s.color).join()]);

  useEffect(() => {
    plotRef.current?.setData([xs, ...series.map((s) => s.values)]);
  }, [xs, series]);

  return html`<div class="chart ch" ref=${wrapRef}>
    <div ref=${holder}></div>
    ${legend && html`<${SeriesLegend} series=${series} plot=${plotRef} hidden=${hidden} setHidden=${setHidden} />`}
  </div>`;
}

/** "Nice" axis step for a max value and a target tick count. */
function niceStep(max, ticks = 5) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

const fmtAxis = (t) => (t >= 100 ? String(Math.round(t)) : String(+t.toFixed(2)));

/** SVG path for a bar with rounded top corners (bottom square). Negative heights round the bottom. */
function barPath(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Grouped bar chart for daily/weekly/monthly totals.
 * groups: [{ label, color, values }]; optional selected (index) + onSelect(i) highlight a category.
 */
export function BarChart({ labels, groups, height = 240, unit = 'kWh', selected, onSelect, legend = true }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  if (!width) return html`<div class="chart ch-bars" ref=${wrapRef} style=${`height:${height}px`}></div>`;
  const pad = { l: 40, r: 6, t: 12, b: 26 };
  const rawMax = Math.max(0, ...groups.flatMap((g) => g.values.map((v) => v ?? 0)));
  const step = rawMax > 0 ? niceStep(rawMax, 4) : 1;
  const max = rawMax > 0 ? Math.ceil(rawMax / step) * step : 1;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const n = Math.max(labels.length, 1);
  const slot = (width - pad.l - pad.r) / n;
  const inner = slot * (n > 20 ? 0.78 : 0.66);
  const gap = groups.length > 1 ? Math.min(3, inner * 0.08) : 0;
  const bw = Math.max(2, (inner - gap * (groups.length - 1)) / groups.length);
  const y = (v) => height - pad.b - (v / max) * (height - pad.t - pad.b);
  const every = Math.ceil(labels.length / Math.max(1, Math.floor(width / 64)));
  const active = hover ?? selected;
  const tipX = hover === null ? 0 : pad.l + slot * (hover + 0.5);
  return html`<div class="chart ch-bars" ref=${wrapRef} onMouseLeave=${() => setHover(null)}>
    <svg width=${width} height=${height} class="bars" role="img">
      ${ticks.map((t) => html`<line x1=${pad.l} x2=${width - pad.r} y1=${y(t)} y2=${y(t)} class="bar-grid" />
        <text x=${pad.l - 8} y=${y(t) + 4} text-anchor="end" class="bar-axis">${fmtAxis(t)}</text>`)}
      ${labels.map((label, i) => {
        const x0 = pad.l + slot * i + (slot - (bw * groups.length + gap * (groups.length - 1))) / 2;
        const dim = hover !== null && hover !== i;
        return html`<g class=${dim ? 'dim' : ''}>
          ${active === i && html`<rect x=${pad.l + slot * i + 1} y=${pad.t - 6} width=${slot - 2} height=${height - pad.t - pad.b + 6} rx="8" class="bar-band" />`}
          ${groups.map((g, gi) => {
            const v = Math.max(0, g.values[i] ?? 0);
            return html`<path d=${barPath(x0 + gi * (bw + gap), y(v), bw, height - pad.b - y(v), Math.min(5, bw / 2))} fill=${cssColor(g.color)} />`;
          })}
          ${i % every === 0 && html`<text x=${pad.l + slot * i + slot / 2} y=${height - 6} text-anchor="middle" class="bar-axis">${label}</text>`}
          <rect x=${pad.l + slot * i} y="0" width=${slot} height=${height} fill="transparent" style=${onSelect ? 'cursor:pointer' : ''}
            onMouseEnter=${() => setHover(i)} onClick=${() => onSelect?.(i)} />
        </g>`;
      })}
    </svg>
    ${hover !== null &&
    html`<div class="ch-tip ch-tip-svg" style=${`left:${tipX}px;transform:translateX(${tipX > width * 0.6 ? 'calc(-100% - 14px)' : '14px'})`}>
      <div class="ch-tip-head">${labels[hover]}</div>
      ${groups.map((g) => html`<div class="ch-tip-row"><i style=${`background:${cssColor(g.color)}`}></i><span>${g.label}</span><b>${(g.values[hover] ?? 0).toFixed(1)} ${unit}</b></div>`)}
    </div>`}
    ${legend && html`<div class="ch-legend static">${groups.map((g) => html`<span style=${`--c:${cssColor(g.color)}`}><i></i>${g.label}</span>`)}</div>`}
  </div>`;
}

// ---------- History chart ----------

/** Value with unit for legends/tooltips: 1520 W → "1.52 kW", 52.31 V → "52.31 V". */
export function fmtUnit(v, unit = '') {
  if (v == null || !Number.isFinite(v)) return '–';
  if (unit === 'W' || unit === 'VA') return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} k${unit}` : `${Math.round(v)} ${unit}`;
  if (unit === '%') return `${Math.round(v)} %`;
  const digits = unit === 'Hz' || unit === 'V' || unit === 'A' ? (Math.abs(v) >= 100 ? 1 : 2) : 1;
  return `${v.toFixed(digits)}${unit ? ' ' + unit : ''}`;
}

/**
 * Time-series chart with drag-to-zoom. Like TimeChart, plus:
 *  - onZoom(fromSec, toSec): called after a drag-select (the chart itself does not zoom, so the
 *    caller can refetch at a finer resolution and keep every panel in sync)
 *  - xRange: [fromSec, toSec] pins the x axis to the requested window
 *  - series[].split: { above: '--ok', below: '--bad' } fills above/below zero in two colors
 *  - series[].unit: unit for values ('W', 'V', '%' …)
 */
export function HistoryChart({ xs, series, height = 220, scales = {}, syncKey, onZoom, xRange, legend = true }) {
  const [wrapRef, width] = useWidth();
  const plotRef = useRef(null);
  const holder = useRef(null);
  const latest = useRef({});
  const [hidden, setHidden] = useState({});
  latest.current = { onZoom, xRange };
  const themeKey = useThemeKey();

  useEffect(() => {
    if (!width || !holder.current) return;
    const axis = axisStyle();
    const leftUnit = series.find((s) => !s.scale)?.unit ?? '';
    const rightScales = [...new Set(series.filter((s) => s.scale).map((s) => s.scale))];
    const splitFill = (s) => (u) => {
      const top = u.bbox.top;
      const bottom = top + u.bbox.height;
      const y0 = u.valToPos(0, s.scale ?? 'y', true);
      const above = toRgba(s.split.above, 0.28);
      const below = toRgba(s.split.below, 0.28);
      // Before the first layout (or with no data) positions aren't finite yet.
      if (![top, bottom, y0].every(Number.isFinite) || bottom <= top) return above;
      const f = Math.max(0, Math.min(1, (y0 - top) / (bottom - top)));
      const g = u.ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, above);
      g.addColorStop(f, toRgba(s.split.above, 0.04));
      g.addColorStop(f, toRgba(s.split.below, 0.04));
      g.addColorStop(1, below);
      return g;
    };
    const tick = (v) => (v == null ? '' : leftUnit === 'W' && Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(2)}`);
    const opts = {
      width,
      height,
      padding: [10, 6, 0, 0],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: false },
        sync: syncKey ? { key: syncKey } : undefined,
        points: { size: 9, width: 2, fill: color('--surface') },
      },
      select: { show: true },
      scales: {
        x: { time: true, range: (u, min, max) => latest.current.xRange ?? [min, max] },
        ...scales,
      },
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          show: !hidden[i],
          stroke: resolveColor(s.color),
          width: s.width ?? 1.75,
          fill: s.split ? splitFill(s) : s.fill ? gradientFill(s.color, fillAlpha(s.fill)) : undefined,
          fillTo: s.split ? 0 : undefined,
          dash: s.dash,
          scale: s.scale ?? 'y',
          spanGaps: false,
          points: { show: false },
        })),
      ],
      axes: [
        { ...axis, space: 70 },
        { ...axis, scale: 'y', size: 48, values: (u, vals) => vals.map(tick) },
        ...rightScales.map((sc) => ({
          ...axis, scale: sc, side: 1, size: 44, grid: { show: false },
          values: (u, vals) => vals.map((v) => (v == null ? '' : `${v}${sc === '%' ? '%' : ''}`)),
        })),
      ],
      plugins: [
        tooltipPlugin({
          rows: (u, idx) => series.map((s, i) => (u.series[i + 1].show ? { color: resolveColor(s.color), label: s.label, value: u.data[i + 1][idx] == null ? null : fmtUnit(u.data[i + 1][idx], s.unit ?? '') } : {})),
        }),
      ],
      hooks: {
        setSelect: [
          (u) => {
            const { left, width: w } = u.select;
            if (w > 4 && latest.current.onZoom) {
              latest.current.onZoom(Math.floor(u.posToVal(left, 'x')), Math.ceil(u.posToVal(left + w, 'x')));
            }
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
      },
    };
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, [xs, ...series.map((s) => s.values)], holder.current);
    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [width, height, themeKey, series.length, series.map((s) => s.label + s.color + (s.unit ?? '')).join()]);

  useEffect(() => {
    plotRef.current?.setData([xs, ...series.map((s) => s.values)]);
  }, [xs, series, xRange?.[0], xRange?.[1]]);

  return html`<div class="chart ch" ref=${wrapRef}>
    <div ref=${holder}></div>
    ${legend && html`<${SeriesLegend} series=${series} plot=${plotRef} hidden=${hidden} setHidden=${setHidden} />`}
  </div>`;
}

// ---------- Category area chart ----------

/** Smooth path through points with horizontal tangents (never overshoots between points). */
function smoothPath(pts) {
  if (!pts.length) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

/**
 * Smooth area chart over categories (days, weeks) with gradient fills, a crosshair tooltip and a
 * clickable dot legend.
 *  labels   category labels
 *  series   [{ label, color: '--token' | '#rrggbb', areaOpacity, values }]
 *  every    show every Nth x label
 *  unit     y-axis/tooltip unit
 */
export function CategoryLineChart({ labels, series, height = 320, every = 7, unit = 'kWh' }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [hidden, setHidden] = useState({});
  const shown = series.filter((s) => !hidden[s.label]);
  const max = Math.max(0, ...shown.flatMap((s) => s.values.map((v) => v ?? 0)));
  const step = max > 0 ? niceStep(max, 4) : 0;
  const top = max > 0 ? Math.ceil(max / step) * step : 0;
  const ticks = top > 0 ? Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) : [];
  const box = { l: 44, r: 12, t: 12, b: 28 };
  const plotW = Math.max(10, width - box.l - box.r);
  const plotB = height - box.b;
  const n = Math.max(labels.length, 1);
  const band = plotW / n;
  const x = (i) => box.l + band * (i + 0.5);
  const y = (v) => (top > 0 ? plotB - ((v ?? 0) / top) * (plotB - box.t) : plotB);
  const id = useMemo(() => `cl${Math.random().toString(36).slice(2, 8)}`, []);

  const onMove = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left - box.l) / band);
    setHover(i >= 0 && i < labels.length ? i : null);
  };

  if (!width) return html`<div class="chart ch-cat" ref=${wrapRef} style=${`height:${height + 34}px`}></div>`;
  const hx = hover === null ? 0 : x(hover);
  return html`<div class="chart ch-cat" ref=${wrapRef}>
    <svg width=${width} height=${height} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
      <defs>
        ${series.map((s, k) => html`<linearGradient id=${`${id}-${k}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color=${cssColor(s.color)} stop-opacity=${Math.min(0.4, (s.areaOpacity ?? 0.5) * 0.5)} />
          <stop offset="1" stop-color=${cssColor(s.color)} stop-opacity="0" />
        </linearGradient>`)}
      </defs>
      ${ticks.map((t) => html`<line x1=${box.l} x2=${box.l + plotW} y1=${y(t)} y2=${y(t)} class="bar-grid" />
        <text x=${box.l - 8} y=${y(t) + 4} text-anchor="end" class="bar-axis">${fmtAxis(t)}</text>`)}
      ${series.map((s, k) => {
        if (hidden[s.label] || !labels.length) return null;
        const pts = s.values.map((v, i) => [x(i), y(v)]);
        const line = smoothPath(pts);
        return html`<g>
          <path d=${`${line} L${x(labels.length - 1)},${plotB} L${x(0)},${plotB} Z`} fill=${`url(#${id}-${k})`} />
          <path d=${line} fill="none" stroke=${cssColor(s.color)} stroke-width="2.2" stroke-linejoin="round" />
        </g>`;
      })}
      ${labels.map((l, i) => i % every === 0 && html`<text x=${x(i)} y=${height - 8} text-anchor="middle" class="bar-axis">${l}</text>`)}
      ${hover !== null && html`<line x1=${hx} x2=${hx} y1=${box.t} y2=${plotB} class="ch-cursor" />
        ${shown.map((s) => html`<circle cx=${hx} cy=${y(s.values[hover])} r="4.5" fill="var(--surface)" stroke=${cssColor(s.color)} stroke-width="2.5" />`)}`}
    </svg>
    ${hover !== null &&
    html`<div class="ch-tip ch-tip-svg" style=${`left:${hx}px;transform:translateX(${hx > width * 0.6 ? 'calc(-100% - 14px)' : '14px'})`}>
      <div class="ch-tip-head">${labels[hover]}</div>
      ${shown.map((s) => html`<div class="ch-tip-row"><i style=${`background:${cssColor(s.color)}`}></i><span>${s.label}</span><b>${(s.values[hover] ?? 0).toFixed(2)} ${unit}</b></div>`)}
    </div>`}
    <div class="ch-legend">
      ${series.map((s) => html`<button type="button" class=${hidden[s.label] ? 'off' : ''} style=${`--c:${cssColor(s.color)}`}
        onClick=${() => setHidden({ ...hidden, [s.label]: !hidden[s.label] })}><i></i>${s.label}</button>`)}
    </div>
  </div>`;
}

const chartCss = `
.ch { position: relative; }
.ch .uplot, .ch .u-wrap { font-family: var(--font); }
.ch .u-over { overflow: visible; }
.ch-tip { display: none; position: absolute; z-index: 10; pointer-events: none; min-width: 140px; padding: 9px 12px; border-radius: 12px;
  background: var(--heading); color: #fff; font: 500 12px/1.5 var(--font); white-space: nowrap;
  box-shadow: 0 10px 28px rgba(17, 24, 39, 0.22); font-variant-numeric: tabular-nums; }
.ch-tip-svg { display: block; top: 8px; }
.ch-tip-head { font-weight: 650; margin-bottom: 4px; color: rgba(255, 255, 255, 0.72); font-size: 11.5px; }
.ch-tip-row { display: flex; align-items: center; gap: 7px; }
.ch-tip-row i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ch-tip-row span { color: rgba(255, 255, 255, 0.82); }
.ch-tip-row b { margin-left: auto; padding-left: 16px; font-weight: 650; color: #fff; }
.ch-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; margin-top: 10px; font-size: 12px; color: var(--muted); font-weight: 550; }
.ch-legend button, .ch-legend span { all: unset; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; padding: 2px 0; }
.ch-legend span { cursor: default; }
.ch-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 18%, transparent); }
.ch-legend button:hover { color: var(--text); }
.ch-legend button.off { color: var(--faint); text-decoration: line-through; }
.ch-legend button.off i { background: var(--faint); box-shadow: none; }
.ch-legend button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.ch-bars, .ch-cat { position: relative; }
.ch-bars svg, .ch-cat svg { display: block; overflow: visible; }
.bars .bar-grid, .ch-cat .bar-grid { stroke: var(--grid-line); }
.bar-axis { fill: var(--muted); font: 500 11px var(--font); }
.bar-band { fill: var(--surface-2); }
.bars g.dim path { opacity: 0.4; }
.bars path { transition: opacity 0.15s; }
.ch-cursor { stroke: var(--faint); stroke-dasharray: 3 3; }
`;
let chartStyle = document.getElementById('css-chart');
if (!chartStyle) {
  chartStyle = document.createElement('style');
  chartStyle.id = 'css-chart';
  document.head.appendChild(chartStyle);
}
chartStyle.textContent = chartCss;
