// Time-series graph panels for the Charts page (the classic solar-monitor
// Grafana graphs), drawn with uPlot in the app's design language: soft grid lines, gradient fills,
// threshold bands, drag-to-zoom and a rounded tooltip.
import { api, html, useEffect, useRef, useState } from './core.js';
import { AXIS_FONT, axisStyle, color, cssColor, fmtUnit, gradientFill, resolveColor, tooltipPlugin, useThemeKey } from './chart.js';

/** Named series colours (kept for callers that used Grafana's names), mapped to the design tokens. */
export const GCOLORS = {
  yellow: '--solar',
  red: '--grid',
  blue: '--load',
  green: '--battery',
  black: '--heading',
};

/** Threshold region fills. */
const LEVEL_FILL = {
  ok: ['--ok', 0.06],
  warning: ['--warn', 0.09],
  critical: ['--bad', 0.07],
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Grafana "short" unit: 1520 → "1.52 K", 0.5 → "0.500" style decimals from the tick step. */
export function shortFmt(v, step) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const big = abs >= 1000 || (step != null && step >= 1000);
  const scaled = big ? v / 1000 : v;
  const s = step != null ? (big ? step / 1000 : step) : null;
  const a = Math.abs(scaled);
  let digits = s != null ? Math.max(0, Math.min(3, -Math.floor(Math.log10(s) + 1e-9))) : a >= 100 ? 0 : a >= 10 ? 1 : 2;
  if (s == null && Number.isInteger(scaled)) digits = 0;
  return `${scaled.toFixed(digits)}${big ? ' K' : ''}`;
}

/** Time tick labels picked from the tick spacing and the visible span. */
function timeLabels(incr, span) {
  const day = 86400;
  return (d) => {
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const md = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    if (incr < 60) return `${hm}:${pad2(d.getSeconds())}`;
    if (incr <= 7200 || span <= day * 1.1) return hm;
    if (incr <= 80000) return `${md} ${hm}`;
    if (span <= 365 * day) return md;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  };
}

/** "2026-10-12 14:35:00" (used for absolute range labels). */
export function fmtStamp(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Hook: element size (width and height) tracked with a ResizeObserver. */
export function useSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

const hasValues = (s) => s.values?.some((v) => v != null);

/**
 * A graph panel.
 *  title        optional panel title (cards usually render their own header)
 *  xs           unix seconds
 *  series       [{ label, values, color ('--token' or hex), unit? }]
 *  from, to     visible window (unix seconds); the axis always spans it
 *  thresholds   [{ op: 'gt' | 'lt', value, level: 'ok' | 'warning' | 'critical' }]
 *  yMin, yMax   fixed axis bounds (e.g. 0..100 for state of charge)
 *  legend       show the series legend under the graph
 *  onZoom(from, to)  drag-to-zoom callback (unix seconds)
 * The panel fills its container's height; give the container a height.
 */
export function GraphPanel({ title, xs = [], series = [], from, to, thresholds = [], yMin, yMax, legend = false, onZoom, bordered = false }) {
  const [boxRef, size] = useSize();
  const holder = useRef(null);
  const plotRef = useRef(null);
  const latest = useRef({});
  const themeKey = useThemeKey();
  const empty = !series.some(hasValues);
  const legendH = legend && !empty ? 30 : 0;
  const titleH = title ? 28 : 0;
  latest.current = { onZoom, from, to, thresholds, empty, yMin, yMax, series };

  const data = () => {
    const l = latest.current;
    if (l.empty) return [[l.from, l.to], ...l.series.map(() => [null, null])];
    return [xs, ...l.series.map((s) => s.values)];
  };

  const plotH = Math.max(60, size.h - titleH - legendH);

  useEffect(() => {
    if (!size.w || !size.h || !holder.current) return;
    const axis = { ...axisStyle(), font: AXIS_FONT };
    const opts = {
      width: size.w,
      height: plotH,
      padding: [10, 8, 0, 0],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: false },
        points: { size: 8, width: 2, fill: color('--surface') },
        y: false,
      },
      select: { show: true },
      scales: {
        x: { time: true, range: () => [latest.current.from, latest.current.to] },
        y: {
          range: (u, min, max) => {
            const l = latest.current;
            if (l.empty) return [l.yMin ?? -1, l.yMax ?? 1];
            if (l.yMin != null && l.yMax != null) return [l.yMin, l.yMax];
            const r = uPlot.rangeNum(min, max, 0.1, true);
            if (min >= 0 && r[0] < 0) r[0] = 0;
            return [l.yMin ?? r[0], l.yMax ?? r[1]];
          },
        },
      },
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: resolveColor(s.color),
          width: 1.75,
          spanGaps: false,
          points: { show: false },
          fill: gradientFill(s.color, 0.24),
        })),
      ],
      axes: [
        {
          ...axis,
          space: 80,
          size: 28,
          values: (u, splits, ai, space, incr) => {
            const fmt = timeLabels(incr, latest.current.to - latest.current.from);
            return splits.map((v) => fmt(new Date(v * 1000)));
          },
        },
        {
          ...axis,
          space: 34,
          size: (u, values) => {
            if (!values) return 40;
            const longest = Math.max(...values.map((v) => String(v).length));
            return Math.max(30, longest * 6.6 + 12);
          },
          values: (u, splits) => {
            const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) : null;
            return splits.map((v) => shortFmt(v, step));
          },
        },
      ],
      plugins: [
        tooltipPlugin({
          rows: (u, idx) => {
            if (latest.current.empty) return [];
            return latest.current.series.map((s, i) => {
              const v = u.data[i + 1][idx];
              return { color: resolveColor(s.color), label: s.label, value: v == null ? null : s.unit ? fmtUnit(v, s.unit) : shortFmt(v) };
            });
          },
        }),
      ],
      hooks: {
        drawAxes: [
          (u) => {
            const ths = latest.current.thresholds;
            if (!ths?.length) return;
            const { ctx, bbox } = u;
            ctx.save();
            for (const t of ths) {
              const y = u.valToPos(t.value, 'y', true);
              const [y0, y1] = t.op === 'gt' ? [bbox.top, Math.min(y, bbox.top + bbox.height)] : [Math.max(y, bbox.top), bbox.top + bbox.height];
              if (y1 <= y0) continue;
              const [c, a] = LEVEL_FILL[t.level];
              const hex = color(c);
              const n = parseInt(hex.slice(1, 7), 16);
              ctx.fillStyle = Number.isFinite(n) ? `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})` : 'transparent';
              ctx.fillRect(bbox.left, y0, bbox.width, y1 - y0);
            }
            ctx.restore();
          },
        ],
        setSelect: [
          (u) => {
            const { left, width } = u.select;
            if (width > 4 && latest.current.onZoom) {
              latest.current.onZoom(Math.floor(u.posToVal(left, 'x')), Math.ceil(u.posToVal(left + width, 'x')));
            }
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
      },
    };
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data(), holder.current);
    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [size.w, plotH, themeKey, series.length, series.map((s) => s.label + s.color + (s.unit ?? '')).join()]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    u.setData(data());
  }, [xs, series, from, to, empty, yMin, yMax]);

  return html`<div class=${`gpanel ch ${bordered ? 'gpanel-bordered' : ''}`} ref=${boxRef}>
    ${title && html`<div class="gpanel-title">${title}</div>`}
    <div class="gpanel-plot">
      <div ref=${holder}></div>
      ${empty && html`<div class="gpanel-nodata"><i class="ic" style="--i:url(/vendor/lucide/chart-line.svg)"></i>No data in this range</div>`}
    </div>
    ${legendH > 0 &&
    html`<div class="ch-legend static gpanel-legend">
      ${series.map((s) => html`<span style=${`--c:${cssColor(s.color)}`}><i></i>${s.label}</span>`)}
    </div>`}
  </div>`;
}

/** Fetches history for `win` = { from, to } (ms). Returns { data: { xs, series, resolution, from, to } | null, error }. */
export function useHistoryWindow(win, metrics) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ from: String(Math.floor(win.from)), to: String(Math.ceil(win.to)), metrics: metrics.join(',') });
    api.get(`/api/history?${q}`).then(
      (d) => alive && (setData({ ...d, from: win.from, to: win.to }), setError(null)),
      (e) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [win.from, win.to, metrics.join()]);
  return { data, error };
}

const css = `
.gpanel { position: relative; display: flex; flex-direction: column; height: 100%; min-width: 0; font-family: var(--font); color: var(--text); }
.gpanel-bordered { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; background: var(--surface); }
.gpanel-title { flex: none; height: 28px; line-height: 28px; font-size: 14px; font-weight: 650; color: var(--heading);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gpanel-plot { position: relative; flex: 1; min-height: 0; }
.gpanel-plot .u-select { background: color-mix(in srgb, var(--accent) 12%, transparent); border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); }
.gpanel-nodata { position: absolute; left: 0; right: 0; top: 38%; display: flex; flex-direction: column; align-items: center; gap: 6px;
  font-size: 12.5px; color: var(--muted); pointer-events: none; }
.gpanel-nodata .ic { color: var(--faint); width: 22px; height: 22px; }
.gpanel-legend { flex: none; margin-top: 8px; height: 22px; }
`;
let gStyle = document.getElementById('css-grafana');
if (!gStyle) {
  gStyle = document.createElement('style');
  gStyle.id = 'css-grafana';
  document.head.appendChild(gStyle);
}
gStyle.textContent = css;
