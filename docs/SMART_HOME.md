# Smart devices: core contract

Code: `src/home/`. API: `src/web/api/home.ts`. The model follows Home Assistant's core so that both device engines map onto it
directly.

## Engines

| Engine | Runs on | Provides |
|---|---|---|
| `energy` | every board, always | Sunroost's readings as read-only entities |
| `lite` | every board | Sunroost's own device drivers (MQTT discovery, Shelly, ESPHome, Modbus …) |
| `full` | 64-bit boards with about 2 GB of RAM (`src/system/board.ts`) | every Home Assistant integration (embedded Home Assistant) |
| `group` | every board, always | `group.*` entities that switch their members together (`groups.ts`) |

One device engine (`lite` or `full`) runs next to `energy`. The setting `home.engine` is `auto`, `lite` or `full`. `auto` uses the
board's recommendation, and `full` on a board that can't run it falls back to `lite`. An engine implements `DeviceEngine`
(`types.ts`) and talks to the core only through its `EngineHost`, which is scoped to its own devices and entities.

## Model

- **Entity ids** are `<domain>.<object_id>`. The registry fixes an id the first time it sees the engine's `uniqueId`, adds `_2`,
  `_3` … on a collision, and never changes it afterwards. If a device changes domain (a plug re-flashed as a light), the old id is
  retired and a new one is created.
- **States** are strings. `unavailable` means the device can't be reached; `unknown` means there's no value yet. On start,
  every registered entity is `unavailable` until its engine reports. Writing the same state and attributes again is a no-op; a
  change to attributes alone keeps `lastChanged`.
- **User fields** survive re-registration: `name`, `icon`, `role`, `areaId` and `hidden` on entities; `nameByUser`, `areaId`,
  `reviewed` and `hidden` on devices.
- **New devices** have `reviewed: false` until the user sets them up or ignores them (Sunroost's own devices start reviewed).
  `hidden` on a device means "ignored": it is kept, but left off the Devices page by default.
- **Rooms** (`areas.ts`, Home Assistant's areas) are `{id, name, icon}`. Ids are slugs; names are unique, ignoring case.
  Deleting a room clears it from every device and entity.
- **Groups** (`group.*`): `{name, icon, members (switch/light/fan/climate/media_player entities, 1–50), mode any|all}`.
  - **State:** on when any (or all available) members are on; unavailable when no member is.
  - **Attributes:** `entity_id`, `mode`, `members_on`, `members_available`.
  - **Commands** fan out to the available members as child contexts. The call fails only if every member fails; partial
    failures and skipped members are in its message.
  - Renaming a group keeps its entity id.
- **Energy roles** apply only to controllable entities: `critical`, `essential`, `deferrable`, `sheddable`, `protected`.
- **Context**: `{id, parentId, origin: device|user|rule|system, ruleId?}`. A state change caused by a command has the command's
  context as its parent.
- **Bus events**: `state_changed {entityId, oldState, newState, context}` (newState null = removed),
  `call_service {domain, service, entityIds, data, context, results}`.

## Energy entities

| Source | Entity |
|---|---|
| System totals (non-info metrics) | `sensor.<snake(metric)>`, e.g. `sensor.battery_state_of_charge`, `sensor.pv_power` |
| Today's energy | `sensor.pv_energy_today`, `sensor.load_energy_today`, `sensor.grid_import_energy_today`, `sensor.grid_export_energy_today`, `sensor.battery_charge_energy_today`, `sensor.battery_discharge_energy_today` |
| Grid provider metrics | `sensor.grid_<snake(metric)>`, e.g. `sensor.grid_price`, `sensor.grid_next_planned_outage_in` |
| Grid availability | `binary_sensor.grid_available`: off while the `grid-outage` alert is active; otherwise on when the grid voltage is 100 V or more |
| Weather | `sensor.solar_radiation_today`, `sensor.solar_radiation_tomorrow` (MJ/m²), `sensor.outdoor_temperature` |

Totals and grid availability are `unavailable` while neither the inverter nor the BMS is connected. A metric that disappears
becomes `unavailable` and stays in the registry.

## Service calls

`callService(domain, service, entityIds, data, context)` is the only command path, used by the UI, automations and MQTT.
For each entity, in parallel, it checks in this order:
1. The entity exists.
2. The domain matches. `homeassistant.turn_on|turn_off|toggle` works on any entity.
3. The service is supported (the engine's list, or the domain defaults in `DOMAIN_SERVICES`). Read-only entities support none.
4. The entity is not `unavailable`, and its engine is running.

It then sends the command (10 s timeout). When the resulting state is predictable, it waits up to 5 s for that state and
returns `confirmed: true|false`:
- switch, light, fan: `turn_on`/`turn_off`/`toggle` → on/off
- climate: `turn_off` → off, `set_hvac_mode` → the mode
- media_player: `turn_off` → off
- lock: `lock`/`unlock` → locked/unlocked
- select: `select_option` → the option

Other services return `confirmed: null`. An unconfirmed command is still
`ok`; its message says the device hasn't confirmed it yet. The energy guard rails (step 5) go in this path.

## API

| Method | Path | |
|---|---|---|
| GET | /api/home/status | `{setting, recommended, selected, active, demoDevices, board (BoardProfile), engines: [{id, name, running, info}]}`. For lite, `info` is `{drivers: [{id, name, state, message, entities, details}]}`. |
| GET | /api/home/entities | entity views: registry fields + `state, attributes, lastChanged, lastUpdated, services, deviceName` |
| GET / PATCH | /api/home/entities/:entityId | PATCH `{name?, icon?, role?, hidden?, areaId?}` (null resets name/icon/role/room) |
| GET | /api/home/devices | `{id, name, originalName, engine, manufacturer, model, swVersion, areaId, entities[]}`. Engine `config` is never returned. |
| PATCH | /api/home/devices/:id | `{name?, areaId?, reviewed?, hidden?}` (null resets name/room) |
| DELETE | /api/home/devices/:id | only for a device none of whose entities is reachable (409 otherwise, and for Sunroost's own data) |
| GET / POST | /api/home/areas | list / `{name, icon?}` (409 on a duplicate name) |
| PATCH / DELETE | /api/home/areas/:id | `{name?, icon?}` / delete |
| GET / POST | /api/home/groups | list (with `entityId`) / `{name, icon?, members, mode?}` |
| PUT / DELETE | /api/home/groups/:id | update / delete |
| POST | /api/home/services/:domain/:service | `{entity_id: id \| id[], ...data}` → `{ok, context, results: {[entityId]: {ok, confirmed, message?}}}` |

Bus listeners are isolated: a listener that throws is logged and the others still run (`emit` in `bus.ts`).

UI: `public/js/pages/devices.js` (`/devices`, "Smart devices" in the sidebar). It loads everything once, applies the
`home_states` pushes, and reloads when an unknown entity appears or one is removed.

WebSocket: `{type: 'home_states', data: [{entityId, state, attributes, lastChanged, lastUpdated}], removed: [entityId]}`. Changes
are batched and sent at most once a second.

## Lite engine: MQTT discovery driver

Code: `src/home/lite/`. Each driver prefixes its entities' `uniqueId` with its id (`mqtt:`); commands are routed by that prefix.

The MQTT driver connects to Sunroost's broker as an ordinary client:
- **Which broker:** the built-in broker at `127.0.0.1:<port>`, or the external URL.
- **When it doesn't connect:** if the built-in broker failed to start (for example, the port is taken), it reports the error and
  retries every 5 s. It never connects to whatever else holds the port.
- **On every connect** it subscribes to `homeassistant/#` and publishes the birth message `homeassistant/status` = `online`.
  Devices re-announce on that, so nothing is lost when Sunroost or its in-memory broker restarts.
- **Settings:** changing a broker setting reconnects it.

Discovery (`discovery.ts`) follows Home Assistant:
- Topic layouts: `homeassistant/<component>/[<node_id>/]<object_id>/config`, plus device discovery
  `homeassistant/device/<id>/config` with `cmps`.
- Payload rules: abbreviated keys, the `~` base topic, an empty payload to remove, and a component reduced to `{p}` removed.
- **Naming:** no entity name → the device name; otherwise "Device Name" unless the name already starts with the device name.
  Device info is merged across a device's entities, because firmware often sends the full block only once.
- **Ids:** `default_entity_id`/`object_id` set the preferred entity id. The `uniqueId` is `mqtt:<component>:<unique_id>`; without a
  `unique_id`, the config topic is used.
- **Sunroost's own discovery** (any topic under `mqtt_prefix`) is ignored; that data is already energy entities.
- **Ignored configs** (unsupported component, unsupported template, bad JSON) are listed in the driver's `details.ignored`.

**Components:**
- sensor, binary_sensor
- switch, light (default and `json` schemas, brightness)
- fan (on/off, percentage)
- button, select, number
- cover (open/close/stop/position)
- lock
- climate (modes, target and current temperature, fan mode, power topic)

**Behaviour, per Home Assistant's defaults:**
- **Availability:** `availability_topic` or an `availability` list, modes latest/all/any, payload templates. An entity with
  availability topics is `unavailable` until one reports.
- **No state topic** (or `optimistic: true`): the entity follows its own commands (optimistic).
- `json_attributes_topic` is merged into the attributes.
- The `qos` and `retain` from the config are used for commands.

**Templates** (`template.ts`) are a safe subset of Jinja:
- literals, `value`/`value_json`, attribute and index access
- arithmetic, comparisons, `and`/`or`/`not`, `in`, `is defined|none|number|string`
- inline if, `{% if/elif/else %}`, whitespace control
- filters: int, float, round, abs, bool, lower, upper, title, capitalize, trim, string, length, replace, default, is_defined,
  multiply, min, max, tojson, from_json, first, last
- functions: int(), float(), round(), min(), max(), bool()
- dict `.get()` and a few string methods

Output follows Python's `str()` (`True`, `False`, `None`). A missing value renders empty and is skipped. Anything else is
rejected when the device is discovered.

**Firmware notes:**
- **ESPHome** (MQTT mode), **Zigbee2MQTT** and **OpenBeken** announce in this format.
- **Tasmota** needs `SetOption19 1` (its legacy Home Assistant format); its native `tasmota/discovery` format is a later driver.
- **Shelly** doesn't announce over MQTT; it gets its own driver.

**Demo devices** (`home.demo_devices`, `demo.ts`) simulate four devices over MQTT, each the way its real firmware talks:
- a Tasmota water-heater plug (2 kW)
- a Zigbee2MQTT bulb
- an ESPHome air conditioner (device discovery)
- an ESPHome EV charger with a charging-current number

Turning the setting off withdraws them. A normal shutdown only takes them offline.

## Full engine: Home Assistant

Code: `src/home/full/`. Tested against Home Assistant 2026.10.1.
- `client.ts`: WebSocket and REST, using Node's built-in WebSocket.
- `onboard.ts`: sets up a fresh Home Assistant with no user involvement.
- `mapping.ts`: what is mirrored and how.
- `flows.ts`: setup flows turned into plain forms.
- `index.ts`: the `FullEngine`.

**Installation** (`deploy/install.sh`):
- **When:** on 64-bit boards with 2 GB of RAM or more and about 6 GB of free disk. `--home-assistant` also installs it on a
  1 GB board; `--no-home-assistant` skips it.
- **What:** installs `docker.io`, pulls the pinned image (`HA_IMAGE`, default `ghcr.io/home-assistant/home-assistant:2026.10.1`),
  and runs it as `sunroost-homeassistant.service`.
  - Container settings: host networking (for discovery), privileged with D-Bus (USB and Bluetooth sticks), and a memory limit
    of 55% of RAM.
  - Config lives in `/var/lib/sunroost-homeassistant`, outside `/opt/sunroost`, so reinstalling doesn't wipe it.
  - `configuration.yaml` sets `http.server_host: 127.0.0.1` (only Sunroost can reach it) and recorder `purge_keep_days: 3`.
- The `sunroost` user gets no Docker access; systemd runs the container.

**Choosing the engine:** `home.engine` set to `full` (or `auto` on a capable board) plus a reachable Home Assistant, or a
stored token, starts the full engine. Otherwise lite stands in and Sunroost checks for Home Assistant every minute. A board that
can't run Home Assistant can still use one elsewhere: `home.full_url` points to it, and the user pastes a token
(`POST /api/home/full/link`).

**Setup and credentials:**
- For a local Home Assistant with no owner, Sunroost runs onboarding itself. It creates the `sunroost` owner with a random password,
  finishes the remaining steps, sets the time zone, and creates a long-lived token.
- The token and password are stored with `src/core/secrets.ts`: AES-256-GCM with `<dataDir>/secret.key`, mode 0600. They
  are never returned by the API.
- A Home Assistant that already has an owner needs a pasted token.
- A rejected token puts the engine in `setup` instead of retrying forever.
- The local token can't be unlinked, because Sunroost created that instance's only owner.

**Mirroring:**
- **Which entities:** every registry entity except disabled ones, these domains and these integrations:
  - skipped domains (`SKIPPED_DOMAINS`): sun, update, tts, camera, person, zone and other Home Assistant internals
  - internal integrations (`INTERNAL_PLATFORMS`): backup, cloud, sun, met and similar
  - Sunroost's own inverter data coming back through Home Assistant's MQTT integration (MQTT devices whose identifier starts with
    `<mqtt_uniq_id>_`)
- **Ids:** entity ids match Home Assistant's. Device and entity `uniqueId`s are Home Assistant's registry ids.
- **Names and visibility:** names come from `friendly_name`. Diagnostic and configuration entities start hidden.
- **Services:** come from `get_services`, minus `reload`. Sensors, binary sensors, weather, air quality and device trackers are
  read-only.
- **New devices and rooms:** devices already in Home Assistant at the first link are not "new"; devices added later are. A
  device's Home Assistant area becomes its Sunroost room the first time it appears.
- **Updates:** states come from `subscribe_entities`, merging the compressed changes. Registry change events trigger a
  re-sync, so removed entities disappear from Sunroost.
- **Connection loss:** marks everything unavailable and reconnects after 5, 15, 30, then 60 s.

**Commands** go out as `call_service` with the entity as the target. Home Assistant's validation errors are passed through,
e.g. "Accepted range is 7 to 35". Home Assistant reports the state change before the command's reply, so the cause chain links
an entity's changes to the last command sent to it within 10 s.

**MQTT:** a local Home Assistant's MQTT integration is pointed at Sunroost's broker once, with protocol **3.1.1**. Sunroost's
built-in broker (aedes) can't do MQTT 5, Home Assistant's default. This makes Tasmota, Zigbee2MQTT and the rest work in the
full engine.

**Integrations** (`/api/home/integrations…`, `/api/home/flows…`):
- **Catalogue:** the integrations from `integration/descriptions` that can be set up with a config flow, brands flattened
  (915 on 2026.10.1).
- **Setup flows** become forms with translated labels, help, errors and abort reasons (`frontend/get_translations`). Field
  kinds: text, password, number, boolean, select, multiselect, section and unsupported. Steps can also be a menu, an external
  sign-in or progress.
- **Submissions** are completed the way Home Assistant's own UI does it (`withDefaults`/`initialValue`): defaults, false for a
  required yes/no field, the first option for a required dropdown, and every section as an object. Home Assistant rejects the
  form otherwise.
- **Discovered devices:** flows in progress whose source is zeroconf, SSDP, DHCP, Bluetooth, USB and so on. They show under
  "New devices"; dismissing one aborts its flow.
- **Configured integrations** are listed, leaving out ones Home Assistant set up itself (source onboarding or system), and can
  be removed.

| Method | Path | |
|---|---|---|
| GET | /api/home/integrations | catalogue `[{domain, name, iotClass, brand}]` (409 without the full engine) |
| GET / DELETE | /api/home/integrations/entries[/:id] | configured integrations / remove one |
| GET | /api/home/integrations/discovered | `[{flowId, handler, name, title, source}]` (empty without the full engine) |
| POST | /api/home/flows | `{handler}` → FlowView |
| GET / POST / DELETE | /api/home/flows/:id | current step / `{input}` → next FlowView / cancel |
| POST | /api/home/full/link | `{url, token}`: checks by connecting, stores the token, switches to full |
| POST | /api/home/full/unlink | forget a Home Assistant elsewhere on the network (409 for the local one) |

Errors: Home Assistant rejecting input → 400; Home Assistant unreachable or failing → 502.

## Lite drivers

The contract is in `src/home/lite/types.ts`:
- **Commands are routed by prefix:** every entity's uniqueId starts with the driver id.
- **Setup flows** use the same forms as Home Assistant's.
- **Entries:** one per configured device, hub or account. Their data is encrypted with `core/secrets.ts`, and devices carry
  `config.entryId`, so removing the entry removes them.
- **Discovery:** mDNS and SSDP (`lite/discovery/`, a built-in DNS codec, no dependencies) plus each driver's own UDP probes.
  Findings become "New devices"; dismissing one keeps it dismissed (`home_lite_ignored`).
- **Off-timer:** drivers whose hardware can time itself mark entities `supports_auto_off` and accept `data.auto_off_s` on
  `turn_on`.

| Driver | Protocol | Push / poll | Discovery | Off-timer | Verified against |
|---|---|---|---|---|---|
| MQTT discovery | Home Assistant MQTT discovery | push | MQTT | — | simulated devices |
| Tasmota | native discovery over MQTT | push | MQTT | PulseTime | simulator |
| Shelly | Gen1 HTTP; Gen2+ RPC + WebSocket, digest auth | push (Gen2) / poll | mDNS | toggle_after / timer | simulator |
| ESPHome | native API, plaintext + Noise | push | mDNS | — | **real ESPHome 2026.9** + simulator |
| Philips Hue | CLIP v2 + event stream, link button | push | mDNS | — | simulator |
| TP-Link Kasa / Tapo | XOR protocol (9999); KLAP v2 | poll | UDP broadcast (XOR) | countdown | simulator |
| Tuya | local 3.3 / 3.4 / 3.5 | push | UDP 6666/6667/7000 | countdown DP | simulator |
| WiZ | UDP JSON (38899) | poll | UDP broadcast | — | simulator |
| Modbus | TCP / RTU; relay, SDM120/630 and custom profiles | poll | — | — | simulator |

Each driver's simulator lives in `test/sims/`. Where a simulator was written from the same understanding as the driver, the
driver's header comment says which details remain unverified. `docs/HARDWARE_TEST.md` lists what to check on real devices.

Robustness: a driver writing to an entity that was removed meanwhile is ignored. A write to another engine's entity is logged,
not thrown. Unhandled promise rejections are logged instead of stopping the app.

## Safety (automations and every command)
- **Interlocks** (`EntityEntry.interlock`: `maxLoadW`, `gridAvailable`, `minBatterySoc`) are checked in `callService` for every
  command, manual or automatic, against the energy entities. A command is refused when a reading is unknown.
- **Automation guard rails** (`src/automation/devices.ts`):
  - protected devices only with `allowProtected`
  - critical devices never switched off
  - no command when the device is already in the wanted state
  - 2-minute anti-chatter, and at most `automation.device_max_switches_per_hour` (12) switches per device per hour
  - priority between rules commanding the same device in one evaluation (key `device:<entity>` in the engine's arbitration)
- **Loop protection:** a rule that ran `automation.max_runs_per_10min` (12) times in 10 minutes is skipped with a message.
- **Timers** (`automation_device_timers`, persisted):
  - `autoOffMinutes` on turn-on actions: the device-side timer when supported, plus Sunroost's own.
  - `revertAfterMinutes`: the previous state is restored only if the device still has the state the rule set.
- **Dead-man switch:** spare solar gives devices that time themselves a 20-minute off-timer, renewed every 10 minutes while
  they run.

## History and loads
- **History** (`src/home/history.ts`, table `home_state_log`) records non-energy entities:
  - every state change; numeric values when they move 2% (at least 1) or after 60 s
  - written every 10 s, kept 14 days
- **APIs:**
  - `GET /api/home/history?entity=&hours=` returns the state before the window, then the points. Numeric series are averaged
    to at most 600 points.
  - `GET /api/home/loads` returns every device power reading (W) now and its energy today.
- **UI:** the dashboard's "Where your power goes" card and each device's History button.

## Managing Home Assistant (full engine)
- **API:**
  - `GET /api/home/full/version` (current and latest, from version.home-assistant.io)
  - `POST /api/home/full/backup`: waits until the backup manager is idle, then makes a `backup.local` backup
  - `POST /api/home/full/restart`
  - `POST /api/home/full/update {version | "rollback"}`
- **Updates:**
  - backup first, then the root-owned `/usr/local/sbin/sunroost-ha-update` via sudo
  - accepts only `YYYY.M.P` or `rollback`, and keeps the previous image for rollback
  - refused before the backup where Sunroost didn't install Home Assistant
- **After switching engines:** devices left by an engine no longer in use, all offline, are counted in `GET /api/home/status`
  (`leftovers`). `POST /api/home/cleanup` removes them.
