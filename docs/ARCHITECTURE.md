# Sunroost v2 architecture

Sunroost runs as one Node 22.18+ process with no build step (the installer uses Node 24 LTS on 64-bit boards and Node 22 LTS on 32-bit ARM, the last line with builds for the Pi 1, 2 and Zero). Don't use APIs added after Node 22; `@types/node` is pinned to 22 so `tsc` catches them. TypeScript runs through Node's type stripping, and the frontend is Preact + htm loaded as ES modules.

## Runtime

```
devices/manager ──poll──▶ core/state ──'refresh'──┬──▶ web (WebSocket snapshot to UI)
   ▲  (drivers)               │                    ├──▶ stats (history samples, energy totals)
   │                          │                    ├──▶ mqtt (state topics + HA discovery)
   └──── setSetting ◀─────────┴── automation, mqtt, UI
```

## Core modules (owned by the lead, don't restructure)

| Module | What it gives you |
|---|---|
| `src/core/db.ts` | `db()` returns the single `DatabaseSync` (node:sqlite). Create your tables with `CREATE TABLE IF NOT EXISTS` in your own `start()`. |
| `src/core/settings.ts` | `settings.get(key)`, `settings.set(key, v)`, `settings.setMany({...})`, events `'change'(key, value)` and `'changes'(keys[])`. Every key and its default is listed in `DEFAULTS`. Add new keys there when needed. |
| `src/core/log.ts` | `logger(tag)` returns `.info/.warn/.error`. Tags: `devices`, `mqtt`, `automation`, `db`, `system`, `grid`. The UI filters log panels by tag. |
| `src/core/metrics.ts` | Metric naming, `meta(name)` for unit and aggregation, `snake(name)`, `u32/s32/s16/round`, and the history metric lists. |
| `src/core/state.ts` | `state.inverters[i]`, `state.batteries[i]`, `state.grid`, `state.totals` (derived), `state.energy`, `state.status`, `state.snapshot()`. Events: `'refresh'(snapshot)` (at most every 500 ms) and `'status'`. Writers: `updateInverter`, `updateBattery`, `updateGrid`, `setEnergy`. |
| `src/devices/types.ts` | Driver contracts: `InverterDriverDescriptor`, `InverterDriver`, `SettingDef`, `BmsDriverDescriptor`. |
| `src/devices/manager.ts` | `devices.start/stop/restart`, `devices.started`, `devices.setSetting(index, keyOrLabel, value, source)` returns `{ok, message}` and validates against the `SettingDef`. Also `devices.settingDefs(i)`, `devices.settingValues(i)`, `devices.driver(i)`. Event `'settings'(index, values)`. |
| `src/devices/registry.ts` | Driver lists. |
| `src/web/server.ts` | Auto-loads every `src/web/api/*.ts` that exports `register(app: App)`. `broadcast(msg)` pushes to every WebSocket client. All `/api/*` routes except `/api/auth/*` require a session when a password is set. |
| `src/home/` | Smart devices (Home Assistant-shaped): `registry` (stable entity ids, user names and energy roles), `states` (state machine), `bus` (`state_changed`, `call_service`), `callService()` (the only device command path) and the device engines. Contract: `docs/SMART_HOME.md`. |
| `src/index.ts` | Boot order: db → settings → stats, system, grid, weather, alerts, home, automation, mqtt (`start()`) → web → devices. |

Each subsystem has `src/<name>/index.ts` exporting `start()` and `stop()`; the lead wires these into `src/index.ts`.

## Metric naming

Metric names (which also become MQTT topic names, compatible with SolarAssistant's published MQTT API): `PV power`, `PV power 1`, `PV voltage 2`, `Load power`, `Grid power` (+ import / − export), `Battery power` (+ charging / − discharging), `Battery state of charge`, `Battery voltage`, `Battery current`, `Battery temperature`, `Grid voltage`, `Grid frequency`, `AC output voltage`, `AC output frequency`, `Load apparent power`, `Load percentage`, `Bus voltage`, `Temperature` (inverter), and `Device mode` (string). Info metrics use the same map: `Serial number`, `Model name`, `Firmware version`, `Max AC output power`.

MQTT topics are `<prefix>/<device>/<metric>/state` (`mqtt_prefix`, editable under Configuration › MQTT › Topic prefix). Default prefix `sunroost/`; set it to `solar_assistant` for drop-in compatibility with SolarAssistant's published MQTT API.

Battery packs (BMS) use pack-level names: `State of charge`, `Power`, `Voltage`, `Current`, `Temperature`, `Cycles`, `Cell voltage - Highest/Average/Lowest`.

Temperatures are always stored in °C. The UI converts to °F when the user chooses it.

## Settings (inverter)

`SettingDef.key` is the snake_case of its label (`Output source priority` becomes `output_source_priority`). That is also its MQTT topic segment. Value types are:
- `select`: an option string
- `number`
- `checkbox`: boolean
- `time`: `HH:MM`
- `slot`: `HH:MM,HH:MM,true|false`, or `HH:MM,HH:MM,<priority>,true|false` when `slotPriorities` is set

## Frontend

- `public/js/lib/core.js`: `html`, hooks, `live` (snapshot store), `useStore`, `api.get/post/patch/del`, `useApi(url)`, `appSettings`, `loadSettings()`, `saveSettings(partial)`, `navigate`, `useQuery`, `onLog`, `onInverterSettings`, and formatters (`fmtPower`, `fmtEnergy`, `fmtTemp`, `fmtMetric`, `fmtTime`, `fmtDateTime`, `batteryRate`).
- `public/js/lib/ui.js`: `Page`, `Card`, `Grid`, `Row`, `Field`, `Button` (kinds: default/primary/danger/ok/ghost), `Select`, `Toggle`, `Badge` (ok/warn/bad/info/muted), `DeviceStatus`, `Notice`, `Empty`, `Modal`, `confirmAction`, `toast`, `LogPanel`, `Gauge`, `SettingsForm`, `SettingInput`, `displaySetting`, `useWidth`.
- `public/js/lib/chart.js`: `TimeChart` (uPlot) and `BarChart` (SVG).
- `public/css/app.css`: design tokens and component classes (`.table`, `.seg`, `.stat`, `.notice`, `.row`, `.field` …). Page-specific CSS is injected by the page module (see `pages/dashboard.js`).
- Pages: `public/js/pages/<name>.js` with `export default function`. The routes are fixed in `public/js/app.js`.

## Conventions

- Match the style of the core files: small, commented where non-obvious, no new dependencies without need.
- Boot environment variables keep their `SOLAR_*` names (`SOLAR_PORT`, `SOLAR_HOST`, `SOLAR_DATA`, `SOLAR_CONFIG`, `SOLAR_SIM_HOUR_OFFSET`, `SOLAR_UPNP_DRYRUN`, `SOLAR_ACME_STAGING`) after the rename to Sunroost: they are internal, and renaming them adds risk for no user benefit.
- Typecheck with `npx tsc`, test with `npm test` (`test/*.test.ts`, node:test).
- Never block the event loop with long synchronous work on a Raspberry Pi. Batch DB writes.
