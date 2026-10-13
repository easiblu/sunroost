# Automations v2: contract

Automations move to their own page (`/automations`) and gain a general **rule** type. The three existing types (`table` rule
table, `battery-soc` SOC control, `battery-protection`) keep working unchanged in the same store and runner. The Power page keeps
quick controls, the time-slot schedule and suspend.

## Rule (type `rule`)

```jsonc
{
  "type": "rule",
  "name": "Charge in cheapest hours",
  "enabled": true,
  "config": {
    "description": "optional free text",
    "priority": 50,                       // 1–100, higher wins when rules disagree about a setting
    "triggers": [ /* Trigger, any one fires */ ],
    "conditions": { "op": "and", "items": [ /* Condition | nested group */ ] },
    "actions": [ /* Action, run in order */ ],
    "elseActions": [ /* optional: run when a trigger fires but the conditions are false */ ],
    "options": {
      "cooldownMinutes": 5,               // minimum time between runs
      "maxRunsPerDay": 0,                 // 0 = unlimited
      "revertAfterMinutes": 0,            // >0: restore the previous setting values after this long
      "activeDays": [1,2,3,4,5,6,0],      // optional: weekdays the rule may run (0 = Sunday)
      "activeFrom": "MM-DD", "activeTo": "MM-DD"   // optional seasonal window (wraps the year end)
    }
  }
}
```

### Triggers (`kind`)
| kind | fields | fires |
|---|---|---|
| `time` | `at` "HH:MM", `days?` number[] | at that local time |
| `sun` | `event` "sunrise"\|"sunset", `offsetMinutes` (±) | sunrise/sunset from the site location (fallback: 06:00/18:00 with a warning) |
| `metric` | `metric` (any numeric total metric, e.g. "Battery state of charge", "PV power", "Load power", "Grid power", "Battery power", "Grid voltage", "Temperature"), `op` "above"\|"below", `value`, `forMinutes` (0 = immediately) | when the value **crosses** into the condition and stays there `forMinutes` (edge-triggered, re-arms after leaving) |
| `grid` | `event` "lost"\|"restored" | grid outage alert raised / cleared |
| `price` | `mode` "cheapest"\|"most_expensive", `hours` N (per day) — or `op` "below"\|"above", `value` | at the start of each of the N cheapest/most expensive hours of the day; or when the current price crosses the value |
| `forecast` | `at` "HH:MM", `metric` "tomorrow_sun"\|"today_sun" (daily radiation MJ/m² from the weather service), `op`, `value` | evaluated once at `at` |
| `alert` | `alert` id ("battery-low", "grid-outage", …) or `level` "bad"\|"warn" | when a matching alert is raised |
| `interval` | `everyMinutes` (≥5) | periodically |
| `device` | `entity` (smart-device entity id), `to?` state, `from?` state, `forMinutes` | when the device enters `to` (from `from`, if given) and stays there `forMinutes`; without `to`, on any change. The first state seen is a baseline |
| `manual` | — | only via "Run now" or a scene |

### Conditions (`kind`), combinable in `and`/`or` groups (nestable 2 levels)
| kind | fields |
|---|---|
| `time_between` | `from` "HH:MM", `to` "HH:MM" (wraps midnight) |
| `days` | `days` number[] |
| `metric` | `metric`, `op` "above"\|"below"\|"between", `value`, `value2?` |
| `grid` | `available` boolean |
| `price` | `op`, `value` (current price) or `cheapest_hours` N ("now is among the N cheapest hours today") |
| `sun` | `is` "up"\|"down" |
| `forecast` | `metric` "tomorrow_sun"\|"today_sun", `op`, `value` |
| `setting` | `inverter` (index or "all"), `setting` key, `equals` value |
| `automation` | `id`, `enabled` boolean |
| `date_between` | `from` "MM-DD", `to` "MM-DD" |
| `device` | `entity`, `is` state, `not?` boolean |

### Actions (`kind`)
| kind | fields |
|---|---|
| `set_setting` | `inverter` (0-based index or "all"), `setting` key, `value` (validated against the driver's SettingDef) |
| `scene` | `scene` id |
| `notify` | `channel` "app"\|"ntfy"\|"webhook", `title`, `message` (templates: `{soc}`, `{pv}`, `{load}`, `{grid}`, `{battery}`, `{price}`, `{time}`, `{rule}`) |
| `mqtt` | `topic`, `payload`, `retain?` |
| `delay` | `minutes` (1–240; later actions run after the delay, a newer run of the same rule cancels pending delayed actions) |
| `automation` | `id`, `enabled` boolean |
| `device` | `target` (entity id, `role:<energy role>` or `area:<room id>`), `service` (e.g. turn_on, set_temperature), `data` (e.g. `{temperature: 22}`), `allowProtected?` |

**Device readings as values:** `metric` triggers and conditions also accept a numeric smart-device entity id (e.g.
`sensor.geyser_power`). They are listed as "Device: …" in the Measurement picker.

**Smart-device safety** (`src/automation/devices.ts`, applied to every device action, dry runs included):
- **Room and role targets** are resolved when the rule runs: every visible, controllable device in that room or role that
  supports the command.
- **Protected devices** (transfer switch, chargers) are skipped unless the action sets `allowProtected`.
- **Critical devices** are never switched off: turn_off, close, stop, toggle while on, or climate mode off.
- **A device already in the wanted state** isn't sent the command ("Already on").
- **Anti-chatter:** a device switched by an automation isn't switched again by one within 2 minutes ("Held: …").
- **Suspension:** suspending automations skips device actions. They don't need the inverter to be connected.
- **Cause chain:** commands carry a context with origin `rule` and the rule id, so state changes trace back to the rule.
- **Not covered:** device actions are not arbitrated between rules and are not reverted by `revertAfterMinutes`.

Rules watching a device re-evaluate within 150 ms of its state changing (`home.bus` `state_changed`). `ruleOptions.devices`
lists `{entities: [{id, name, device, domain, unit, role, areaId, state, numeric, services, attributes}], areas, roles}` for
the editor. A rule can be started for one device with `/automations?edit=new&device=<entity id>` (the Smart devices page's
"Automate" button).

**Safety:**
- Writes go through `devices.setSetting` (validation) and the existing rate limiter.
- No writes while suspended or disconnected. Notifications and MQTT still run.
- When two enabled rules target the same setting within the same evaluation, the higher priority wins. On a tie, the most recently triggered rule wins.
- The losing rule's run records the action as "skipped (overridden by #id)".
- A rule may not target a setting owned by an enabled legacy automation. That is a conflict error on enable, like today.

## Scenes
`{ id, name, icon (Lucide name), color ("solar"|"load"|"grid"|"battery"|"accent"), settings: [{ inverter, setting, value }] }`. Applying a scene writes each setting, records a run, and returns per-setting results.

## Runs (history)
`{ id, automationId|null, sceneId|null, ts, trigger (text), dryRun, result "ok"|"partial"|"failed"|"skipped", actions: [{ text, ok, message }] }`. Kept 30 days.

## Notifications
Settings:
- `notify.ntfy_url`: full topic URL, e.g. https://ntfy.sh/my-solar-xyz
- `notify.webhook_url`: POST JSON `{title, message, ts}`

The "app" channel adds the message to the in-app notification feed. That feed shows under the top-bar bell as "Notifications", next to the alerts.

## API
| Method | Path | |
|---|---|---|
| GET | /api/automations | existing list (now includes `rule`s with `view` fields: summary, nextRun, lastRun, runsToday, status) |
| POST/PUT/DELETE | /api/automations[/:id] | existing (type `rule` accepted) |
| POST | /api/automations/:id/run?dry=1 | run now (dry: evaluate + report, write nothing) → run record |
| GET | /api/automations/:id/runs?limit= | history for one automation |
| GET | /api/automations/runs?limit= | all recent runs (incl. scenes) |
| GET | /api/automations/upcoming?hours=24 | `[{ at, automationId, name, trigger, summary }]` time/sun/price/forecast/interval triggers predicted |
| GET | /api/automations/templates | `[{ id, name, description, icon, requires: ["price"\|"forecast"\|"sun"\|"grid"\|"battery"], rule }]` |
| GET | /api/automations/options | existing + `ruleOptions: { triggerKinds, conditionKinds, actionKinds, metrics: [{name, unit}], alerts: [{id, title}], sun: {sunrise, sunset} \| null, priceAvailable, forecastAvailable, notify: { ntfy: bool, webhook: bool } }` |
| GET/POST | /api/scenes | list / create |
| PUT/DELETE | /api/scenes/:id | update / delete |
| POST | /api/scenes/:id/apply | apply → run record |
| GET | /api/notifications?limit= | in-app feed `[{ id, ts, title, message, read }]` |
| POST | /api/notifications/read | mark all read |
| POST | /api/notify/test | `{ channel }` → `{ ok, error? }` |

Errors: 400 `{error}` validation, 404 not found, 409 conflict.

## Implementation notes (backend as built)

Code: `src/automation/` — `rules.ts` (shapes, validation, summary, condition evaluation), `engine.ts` (triggers, arbitration,
actions, delays, reverts), `scheduler.ts` + `sun.ts` + `time.ts` (fire times, NOAA sunrise/sunset), `runs.ts` (history,
trigger state, reverts), `scenes.ts`, `notify.ts`, `templates.ts`; API in `src/web/api/{automation,scenes,notifications}.ts`.

**Evaluation.** Rules evaluate on state refreshes (at most every 5 s), on the 30 s tick, and at the exact next scheduled fire,
hold deadline or revert (one engine timer, recomputed after every evaluation).
- Scheduled triggers (`time`, `sun`, `forecast`, `interval`, price `mode`) fire for the latest scheduled time in
  (last fire, now], looking back at most 10 minutes. The last fire per trigger is persisted (`automation_trigger_state`),
  so a restart never repeats a fire and catches up a fire missed by up to 10 minutes.
- `interval` fires at multiples of `everyMinutes` from local midnight (every 15 → :00, :15, :30, :45).
- `metric` and price `op`/`value` triggers are edge-triggered with in-memory state. The first value seen after a start (or
  after creating/editing the rule) is a baseline: a value already inside the condition does not fire until it leaves and re-enters.
- `grid` lost/restored = the `grid-outage` alert raised/cleared; `alert` = a matching alert newly raised.
- `forecast` is checked once at `at`; it fires only if the comparison holds then.
- `price` `cheapest`/`most_expensive`: the N cheapest/dearest whole hours (sub-hourly slots averaged) of each local day.
- Extra metric for triggers/conditions: `"Planned outage in"` (minutes to the next Eskom planned outage; only with the
  Eskom grid provider). `"Price"` is also available as a metric when a price provider is configured.
- Condition groups: the root group plus up to 2 levels of nested groups.

**Runs.** A fired rule whose `activeDays`/season don't match is ignored silently. Cooldown or `maxRunsPerDay` hits, and fires
whose conditions are false without `elseActions`, record a `skipped` run with the reason. Cooldown and daily limit count only
executed (non-skipped) runs. Run actions carry an extra `skipped: true` for actions not attempted (suspended, disconnected,
overridden, already set); these don't count as failures, and a run whose actions were all skipped is `skipped`.
Writes held by the rate limiter are `ok: false` ("Held by write protection").

**Arbitration** covers the immediate actions (before the first `delay`) of all rules firing in one evaluation, per inverter and
setting, with scenes expanded. Ties: most recent trigger time, then the newer rule. Delayed actions are not arbitrated.

**Delays** are in-memory timers. A restart cancels pending delayed actions; a new run of the same rule, disabling or deleting it
cancels them too (the run records "Cancelled: …"). Delayed actions append to the original run.

**Revert** (`revertAfterMinutes`): pending reverts are persisted (`automation_reverts`) and survive restarts. One revert per
inverter+setting keeps the value from before the first change; a later write of the same setting by a rule with a revert
extends it, a write by a rule/scene without one cancels it. At the due time the previous value is restored only if the setting
still has the value the rule wrote (otherwise a skipped run "Not restored …" is recorded). Reverts wait while suspended or
disconnected. A revert is recorded as a run with trigger "Revert after N min".

**Scenes** applied by hand (`POST /api/scenes/:id/apply`) are user writes: allowed while suspended, not rate limited.
From a rule's `scene` action they follow the rule rules (suspension, rate limit, arbitration, revert). Deleting a scene used by a
rule is a 409.

**Conflicts** are symmetric: enabling a legacy automation whose setting an enabled rule writes is also a 409. A rule created
`enabled` that conflicts is stored disabled with `warning` (like the legacy types).

### API details and deviations
- `GET /api/automations`: rules carry `view: { summary, nextRun (ms|null), onCondition (has metric/grid/alert/price-threshold
  triggers), lastRun {ts,result}|null, runsToday, status, statusMessage, conditionsMet, conditions (evaluation tree),
  pendingDelay, pendingRevert }` plus `typeName: "Rule"`, `label` and `status: { state, disableMessage }` for parity with the
  legacy items. `status` adds **`"disabled"`** to the five contract values. `active` = a pending delay/revert, or the rule has
  conditions and they are met now.
- `POST /api/automations/:id/run`: "Run now" ignores triggers, cooldown and limits; conditions still choose `actions` vs
  `elseActions` unless **`&force=1`**. Works on disabled rules. With `dry=1` nothing is written or persisted; the response is a
  run record (`id: 0`, `dryRun: true`) plus `conditions` (evaluation tree with per-condition text), `branch`
  ("actions"|"elseActions"|"none"), `wouldRun: [{kind, text, inverter?, setting?, value?, current?, outcome}]`,
  `arbitration: [{inverter, setting, competitors:[{id,name,priority}], wins}]`, `blocked`, `limits`, `active`.
  Legacy automations: `GET /api/automations/:id/preview` is unchanged; for a rule it returns the dry run. `run` on a legacy
  automation is a 400.
- `GET /api/automations/upcoming?hours=` (1–168): the timeline items `{at, automationId, name, trigger, summary}` sorted by
  time (respecting active days/season), **followed by** one item per event trigger with `at: null, onCondition: true` and
  `trigger: "On condition: …"`.
- `GET /api/automations/templates`: items also have `available` and `reason` (e.g. no matching setting on this inverter).
  The `rule` is ready to `POST /api/automations`. 10 templates: cheapest-hours-charge, expensive-hours-battery, outage-reserve
  (needs the Eskom provider), cloudy-tomorrow-charge, battery-full-self-use, low-battery-night-utility, grid-lost-notify,
  inverter-hot-notify, sunrise-solar-first, sunset-sbu.
- `GET /api/automations/options` → `ruleOptions` also has `sunWarning` (when no site location: 06:00/18:00 are used),
  `priceUnit`, `outageAvailable`, `forecast {today_sun, tomorrow_sun}` and `scenes [{id,name}]`. `priceAvailable` is true for
  the day-ahead price provider only.
- `GET /api/notifications` returns the array as specified; `GET /api/notifications/unread` → `{ unread }`. New feed entries are
  pushed over the WebSocket as `{ type: "notification", data: item, unread }`. `POST /api/notifications/read` → `{ok, unread: 0}`.
- `POST /api/notify/test` sends "Sunroost test notification"; an invalid channel is a 400 `{ok:false, error}`.
- Notification errors and logs show only the URL origin (tokens in paths/queries are never logged). Remote sends time out
  after 10 s; failures are recorded in the run's action message.
- `mqtt` actions publish through the active broker connection (`publishMessage` in `src/mqtt/index.ts`); with MQTT disabled or
  disconnected the action fails with that reason.

## Energy outlook and spare solar

Code: `src/energy/` (forecast, surplus), `src/automation/surplus.ts` (spare-solar scheduling), API `src/web/api/surplus.ts`.

**Expected solar** (`forecast.ts`): the weather forecast gives radiation on flat ground, in MJ/m² per day and W/m² per hour.
Sunroost turns it into energy with a factor in kWh per kWh/m² (effectively the array's effective kW):
- **Learned:** the 80th percentile of measured daily PV ÷ radiation over the last 14 days (the weather fetch includes
  `past_days=14`). Days under 1 kWh/m² are skipped, and curtailed days fall below the percentile. Used once 5 or more days
  qualify.
- **Array:** `site.pv_kwp` × 0.8, until enough days are learned.
- **Estimate:** `max_pv_power` / 1000 × 0.8, as a last resort.

These metrics are available in rules and as energy entities: `PV forecast today`, `PV forecast tomorrow` and
`PV forecast rest of today` (kWh). `GET /api/energy/outlook` returns them plus the next 24 hours.

**Solar surplus** (`surplus.ts`, metric `Solar surplus` W, entity `sensor.solar_surplus`):
- Importing more than 50 W, or discharging the battery, means 0.
- Below `surplus.battery_soc` (90%) only exported power counts, because the battery charges first.
- At or above it, max(export, PV − load) counts. An inverter that can't export curtails solar, so export alone would read 0.

**Spare solar** (Automations › Spare solar; settings `surplus.*`): devices with the Deferrable role, in `surplus.order`, then
by name.
- **Start:** the next device starts when the surplus is at least its power plus `start_margin_w` (100 W) for `start_minutes`
  (5). Its power is its own W reading while on (a power sensor on the same device), else the user's "power when on" (`powerW`).
  Its consumption then lowers the surplus, so the next device waits.
- **Stop:** when importing or using the battery (over 100 W) for `stop_minutes` (3), the last device spare solar started that
  has run at least `min_on_minutes` (15) is stopped. Stops happen in reverse order, one per period.
- **Hands off:** devices switched on by hand are never stopped. The devices it started are persisted in `surplus.managed`.
- **Guards:** the 2-minute anti-chatter guard is shared with rules; a suspension or switching it off stops all switching.
- **History:** every switch is a run with no rule or scene id and the trigger "Spare solar: …". The UI labels these
  "Spare solar".
- **API:** `GET /api/surplus` returns the status; `PUT /api/surplus` takes
  `{enabled, order, batterySoc, startMarginW, startMinutes, stopMinutes, minOnMinutes}`.

**Device templates:** battery-low-shed, grid-lost-shed, expensive-hours-pause and poor-solar-tomorrow. Their actions target
energy roles; a template is unavailable until at least one device has one of its roles.

**Simulator:** `SOLAR_SIM_HOUR_OFFSET=<hours>` shifts the simulated sun and load (e.g. midday at night). The demo smart
devices add what they draw to the simulated house load (`src/devices/inverters/sim-load.ts`).
