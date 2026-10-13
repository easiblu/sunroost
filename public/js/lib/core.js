// Shared frontend runtime: Preact + htm, live state over WebSocket, API client, router, formatting.
// Pages import everything from here so there is a single copy of each library.
export {
  html, render, Component, createContext,
  useState, useEffect, useMemo, useRef, useCallback, useContext, useReducer, useLayoutEffect,
} from '/vendor/htm/preact/standalone.module.js';
import { useEffect, useState } from '/vendor/htm/preact/standalone.module.js';

// ---------- Tiny observable store ----------

export function createStore(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      subs.forEach((fn) => fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Subscribes a component to a store and returns its current value. */
export function useStore(store) {
  const [value, setValue] = useState(store.get());
  useEffect(() => {
    const off = store.subscribe(setValue);
    // The value may have changed between the first render and this subscription.
    setValue(store.get());
    return off;
  }, [store]);
  return value;
}

// ---------- Live data ----------

/** Latest system snapshot: { ts, inverters[], batteries[], grid, totals, energy, status }. */
export const live = createStore(null);
/** WebSocket connection state: 'connecting' | 'open' | 'closed'. */
export const connection = createStore('connecting');
/** App settings (GET /api/settings), refreshed after every save. */
export const appSettings = createStore(null);

const listeners = { log: new Set(), settings: new Set(), notification: new Set(), home: new Set() };

/** Calls fn(line) for every new log line pushed by the server. Returns an unsubscribe function. */
export function onLog(fn) {
  listeners.log.add(fn);
  return () => listeners.log.delete(fn);
}

/** Calls fn(item, unreadCount) when an automation adds an in-app notification. */
export function onNotification(fn) {
  listeners.notification.add(fn);
  return () => listeners.notification.delete(fn);
}

/** Calls fn(states, removedIds) with smart-device state changes (batched by the server, at most once a second). */
export function onHomeStates(fn) {
  listeners.home.add(fn);
  return () => listeners.home.delete(fn);
}

/** Calls fn(index, values) whenever inverter settings are re-read. */
export function onInverterSettings(fn) {
  listeners.settings.add(fn);
  return () => listeners.settings.delete(fn);
}

let ws;
export function connectLive() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  connection.set('connecting');
  ws.onopen = () => connection.set('open');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') live.set(msg.data);
    else if (msg.type === 'log') listeners.log.forEach((fn) => fn(msg.line));
    else if (msg.type === 'settings') listeners.settings.forEach((fn) => fn(msg.index, msg.values));
    else if (msg.type === 'notification') listeners.notification.forEach((fn) => fn(msg.data, msg.unread));
    else if (msg.type === 'home_states') listeners.home.forEach((fn) => fn(msg.data, msg.removed ?? []));
  };
  ws.onclose = (ev) => {
    connection.set('closed');
    if (ev.code === 4401) return navigate('/sign-in');
    setTimeout(connectLive, 2000);
  };
}

// ---------- API ----------

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    navigate('/sign-in');
    throw new Error('Sign in required');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

export async function loadSettings() {
  appSettings.set(await api.get('/api/settings'));
  return appSettings.get();
}

/** Saves app settings (partial) and refreshes the settings store. */
export async function saveSettings(values) {
  appSettings.set(await api.patch('/api/settings', values));
  return appSettings.get();
}

/** Fetches a URL on mount (and when deps change). Returns { data, error, loading, reload }. */
export function useApi(url, deps = []) {
  const [result, setResult] = useState({ data: null, error: null, loading: true });
  const load = () => {
    if (!url) return;
    setResult((r) => ({ ...r, loading: true }));
    api.get(url).then(
      (data) => setResult({ data, error: null, loading: false }),
      (error) => setResult({ data: null, error: error.message, loading: false }),
    );
  };
  useEffect(load, [url, ...deps]);
  return { ...result, reload: load };
}

// ---------- Router ----------

export const route = createStore(location.pathname + location.search);

export function navigate(to, { replace = false } = {}) {
  if (to === route.get()) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  route.set(to);
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => route.set(location.pathname + location.search));

// Intercept same-origin <a href="/..."> clicks so navigation stays in the SPA.
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href]');
  if (!a || a.target || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
  ev.preventDefault();
  navigate(href);
});

export function useQuery() {
  const r = useStore(route);
  return Object.fromEntries(new URLSearchParams(r.split('?')[1] || ''));
}

// ---------- Formatting ----------

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 1234 → "1.23 kW", 640 → "640 W". */
export function fmtPower(w, { signed = false } = {}) {
  if (num(w) === null) return '–';
  const sign = signed && w > 0 ? '+' : '';
  return Math.abs(w) >= 1000 ? `${sign}${(w / 1000).toFixed(2)} kW` : `${sign}${Math.round(w)} W`;
}

export function fmtEnergy(kwh, digits = 1) {
  return num(kwh) === null ? '–' : `${kwh.toFixed(digits)} kWh`;
}

/** Temperature in the user's chosen unit. Values are stored in °C. */
export function fmtTemp(c) {
  if (num(c) === null) return '–';
  const unit = appSettings.get()?.temperature_unit ?? '°C';
  return unit === '°F' ? `${(c * 1.8 + 32).toFixed(1)} °F` : `${c.toFixed(1)} °C`;
}

const UNIT_RULES = [
  [/apparent power/i, 'VA'], [/power/i, 'W'], [/voltage/i, 'V'], [/current/i, 'A'],
  [/frequency/i, 'Hz'], [/temperature/i, '°C'], [/state of (charge|health)|percentage/i, '%'],
];

/** Display unit for a metric name, mirroring the server's catalog. */
export function unitFor(name) {
  for (const [re, unit] of UNIT_RULES) if (re.test(name)) return unit;
  return '';
}

/** Formats any metric value for display, with its unit. */
export function fmtMetric(name, value) {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'number') return String(value);
  const unit = unitFor(name);
  if (unit === '°C') return fmtTemp(value);
  if (unit === 'W' || unit === 'VA') return Math.abs(value) >= 10000 ? `${(value / 1000).toFixed(2)} k${unit}` : `${Math.round(value)} ${unit}`;
  const digits = Number.isInteger(value) ? 0 : unit === 'Hz' || unit === 'V' ? 2 : 1;
  return `${value.toFixed(digits)}${unit ? ' ' + unit : ''}`;
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Battery %/hr from power (W) and capacity (kWh). */
export function batteryRate(powerW, capacityKwh) {
  if (num(powerW) === null || !capacityKwh) return null;
  return (powerW / (capacityKwh * 1000)) * 100;
}
