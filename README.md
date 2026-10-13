# Sunroost

A local-first solar monitor and controller for the Raspberry Pi and Orange Pi. It reads your inverter and battery, keeps
history, runs automations, controls smart devices and publishes everything over MQTT. See `docs/ARCHITECTURE.md` for how it
works.

Sunroost is an independent project. It is not affiliated with or endorsed by SolarAssistant or any inverter maker; brand
names are used only to say which hardware and which published APIs Sunroost works with. Inverter protocols are implemented
from vendors' public documents and community-documented register maps (see `docs/INVERTERS.md`).

## Features

| Area | What you get |
|---|---|
| **Dashboard** | Live power flow (solar, grid, battery, load), gauges, inverter/solar/grid/battery tiles, battery %/hr, today's energy, and 24 h charts. Updates every 2 s over WebSocket. |
| **Charts** | Panels for overview, battery power and SOC, per-MPPT PV, voltages, currents, temperatures, frequency, bus voltage) drawn natively. Ranges from 6 h to 30 days or a custom date, with drag-to-zoom and synced cursors. |
| **Totals** | Day/week/month/year energy: load, solar, battery in/out, grid used/exported. Adds self-sufficiency, optional cost estimates and CSV export. |
| **Power** | Quick one-tap controls for the inverter's main setting, suspend automations, and a 24-hour time-slot schedule. |
| **Automations** | A separate page with a **When → If → Then** rule builder. **Triggers:** time, sunrise/sunset ± offset, battery % or power thresholds held for N minutes, grid lost/restored, cheapest/most expensive N hours, tomorrow's weather forecast, alerts, interval. **Conditions:** AND/OR groups. **Actions:** change settings, apply a scene, notify (in-app, ntfy push, webhook), MQTT, delay, enable/disable rules. **Also:** auto-revert, priorities with conflict handling, cooldowns, max runs per day, dry run, a 24-hour upcoming timeline, run history, 10 templates, **scenes** (one-tap setting bundles), and the classic rule-table, SOC-control and battery-protection types. See `docs/AUTOMATIONS.md`. |
| **Inverter** | Status pages (single and parallel), plus a settings editor that writes only the fields you changed. |
| **Battery / Grid** | Bank and per-pack status. Day-ahead electricity prices for 41 European bidding zones (Energy-Charts), with the cheapest hours highlighted. |
| **MQTT** | Built-in broker (port 1883) or an external one, compatible with SolarAssistant's published MQTT API (topic layout `<prefix>/inverter_1/pv_power/state` and `…/set` writes). Default prefix `sunroost/`; set it to `solar_assistant` for drop-in compatibility with SolarAssistant's published MQTT API (Configuration › MQTT › Topic prefix), so existing Home Assistant setups keep working. Adds HA auto-discovery for sensors, selects, numbers and switches, and settings writes over `…/set`. |
| **Configuration** | General, WiFi network (scan/connect, automatic hotspot fallback, captive portal), Inverter/Battery, System, MQTT Broker. Also Advanced, System (timezone, internet time, °C/°F, HDMI kiosk, Bluetooth, SSH, password, reboot/shutdown) and Storage (backup/restore, resample totals, clear history). |
| **Diagnostics** | Modbus console, inverter command console (Voltronic), battery serial console (Pylontech decoder), serial loopback test, serial inspector (pipe two ports, frame decoding, trace record/replay), device emulator (brokers), USB devices and kernel log, log viewer. |

### Design choices

- **One process, not five.** SQLite replaces InfluxDB, native charts replace Grafana, and the MQTT broker is built in. That means fewer moving parts and less SD-card wear on a Pi.
- **No activation, licence or cloud dependency.**
- **Optional external MQTT broker**, plus grid-price and energy topics.
- **Safer Growatt writes.** Registers that haven't been verified are read-only, and automations rate-limit writes to protect the inverter's EEPROM.
- **Cost and self-sufficiency on Totals**, plus CSV export and day-ahead prices.
- A phone layout and a kiosk mode (opening `http://127.0.0.1` on the Pi's HDMI screen turns animations off).

## Download

Ready-to-flash SD-card images are attached to every release on the **[Releases page](../../releases/latest)**:

| Image | Boards |
|---|---|
| `sunroost-<version>-rpi-arm64.img.xz` | Raspberry Pi 3, 4, 5, Zero 2 W (64-bit, recommended) |
| `sunroost-<version>-rpi-armhf.img.xz` | Every Raspberry Pi, including Pi 1, Pi 2, Zero and Zero W (32-bit) |
| `sunroost-<version>-orangepi3-lts.img.xz` | Orange Pi 3 LTS |

1. Flash it with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (*Choose OS → Use custom*) or
   [balenaEtcher](https://etcher.balena.io/). In Raspberry Pi Imager you can also set WiFi, a user and SSH before writing.
2. Boot the board with an Ethernet cable, or without one: if no WiFi is set up it opens a **Sunroost** WiFi hotspot;
   join it and pick your network.
3. Open **http://sunroost.local** (or the board's IP address) and go to **Configuration → Devices**.

Each image is Raspberry Pi OS Lite or Armbian with Sunroost preinstalled. On first boot a 64-bit board with 2 GB of RAM or
more also downloads Home Assistant for the full smart-device engine. The `.sha256` file next to each image lets you check
the download. Images are built by `image/build.sh` (see `image/README.md`).

## Supported hardware

**Inverters:** 23 protocol drivers covering 190+ series from 60+ brands. Connect by USB, RS232/RS485, Modbus TCP, or the
inverter's WiFi stick (Solarman, Luxpower, GoodWe, Eybond/SmartESS). Pick your brand and series in
**Configuration → Devices**, or press **Auto-detect**. Per-series details are in `docs/INVERTERS.md`.

| Status | Meaning |
|---|---|
| ✅ | Full driver: readings and settings |
| 🟡 | Read-only: readings work; settings can't be changed until the driver is confirmed on real hardware |
| 🔍 | Protocol unknown for this series: use **Auto-detect** |
| ❌ | No driver yet |

Where a brand mixes statuses, each series is marked. No driver has been confirmed on real hardware yet, so compare the
first readings with the inverter's own display.

| Brand | Series | Driver | Connection | Status |
|---|---|---|---|---|
| Afore | AF-SL Single-Phase Hybrid, AF-TH Three-Phase Hybrid | `afore` | Solarman, RS485 | 🟡 |
| Amensolar | N3H-X10 Split-Phase Hybrid | `megarevo` | — | 🟡 |
| AMIBA | AN-Series Hybrid | auto-detect | RS232, WiFi stick | 🔍 |
| Anenji | All-In-One Solar Charge, ANJ Hybrid 24V, ANJ Hybrid 48V, ANJ Hybrid Off-Grid/On-Grid WIFI, ANJ-HHS Hybrid 48V, GES-500 Hybrid | `sumry` | RS485, USB, WiFi stick, RS232 | 🟡 |
| Anern | AN-FGI Series 🔍, AN-PV Multi MPPT ✅, AN-SCI-EVO Series Solar 🔍, ECO AN-SCI-EVO Hybrid 🟡 | `voltronic`, `sumry` | USB, RS232, WiFi stick | ✅ 🟡 🔍 |
| Busbyr | GES Split-Phase Hybrid | `sumry` | RS485, USB, WiFi stick | 🟡 |
| CHISAGE ESS | Mars G2 Three-Phase Hybrid | auto-detect | RS485 | 🔍 |
| Conderenergy | KVA Hybrid 🔍, S-Series Hybrid 🟡 | `sumry` | RS232, WiFi stick | 🟡 🔍 |
| Datouboss | DT4811B Hybrid ✅, DT4855U Hybrid ✅, JC series All-In-One Hybrid inverters with LiFePO4 battery 🔍 | `voltronic` | RS232, USB | ✅ 🔍 |
| Daxtromn | AGH Hybrid series 🟡, AGH PRO 🔍 | `sumry` | RS232, WiFi stick | 🟡 🔍 |
| Deye | OG01LP1 Single-Phase Off-Grid, SG01HP3 Three-Phase Hybrid, SG01LP1 Single-Phase Hybrid, SG02HP3 Three-Phase Hybrid High Voltage, SG02LP1 Single-Phase Hybrid, SG04LP1 Single-Phase Hybrid, SG04LP3 Three-Phase Hybrid, SG05LP1 Single-Phase Hybrid, SG05LP3 Three-Phase Hybrid | `sunsynk` | RS232, RS485, Solarman | ✅ |
| Duracell | Dura-i G1 Hybrid, Dura-i G3 | `senergy` | RS485 | 🟡 |
| Dyness | 1P-A series | `solis` | RS485, WiFi stick | 🟡 |
| Easun Power | Easun Isolar SMX II 🟡, IGrid-SGR Hybrid with WiFi 🟡, ISolar MLV-U 🟡, ISolar SMG II 🟡, ISolar SMG II Off-Grid 3 Phase WiFi 🟡, ISolar SMG III WIFI 🟡, ISolar SMH III 🟡, ISolar SML-V WIFI 🟡, Isolar SMP Off-Grid ✅, ISolar SMS W-E 🟡, ISolar-SMT Off-Grid Hybrid ✅ | `srne`, `sumry`, `voltronic` | RS485, USB, WiFi stick, RS232 | ✅ 🟡 |
| Eco-worthy | ECO Split-Phase Off-Grid 🟡, ECO-INV Split-Phase AIO 🔍, SPI Hybrid series 🟡 | `srne` | RS232, WiFi stick, RS485, USB | 🟡 🔍 |
| Effekta | AX M1 Series | `voltronic` | RS232, USB | ✅ |
| EG4 | 3000EHV-48 All-In-One Off-Grid 🟡, 6500EX Off-grid ✅, FlexBOSS 21 Split-Phase All-In-One Hybrid 🟡, GridBOSS ❌, IV-6000-XP-IN All-In-One Off-Grid 🟡, IV-HYB-AW All-In-One Hybrid 🟡, IV-XP-IN 🟡 | `sumry`, `voltronic`, `luxpower` | RS232, WiFi stick, USB, RS485 | ✅ 🟡 ❌ |
| Felicity Solar | IVEM Hybrid, IVGM Hybrid, IVPA Off-Grid, T-Rex HP, T-REX LP1G01 Hybrid | `felicity` | RS232, RS485 | 🟡 |
| Fronus PK | Infineon | `voltronic` | RS232, USB | ✅ |
| GoodWe | D-ES Single-Phase Hybrid ES, EHB AU G11 Hybrid, ES-C10 Uniq Series Single-Phase Hybrid, ET G2 Series, GW-ES Split-Phase Hybrid, GW-ET Three-Phase Hybrid | `goodwe` | LAN, WiFi stick, RS485 | 🟡 |
| Growatt | MID-TL3-XH ✅, MIN TL-XH-US ✅, MIN-TL-X ✅, MIN-TL-XH ✅, MOD-TL3-XH ✅, SPA TL-BL ✅, SPE-ES ✅, SPF-DVM-US Split-Phase Off-Grid ✅, SPF-ES ✅, SPF-ES-Plus ✅, SPH TL BL-UP ✅, SPH TL BL-US ✅, SPH TL-HU-US ✅, SPH TL3 BH-UP ✅, WIT Three-Phase Hybrid 🟡 | `growatt` | RS485, USB, LAN | ✅ 🟡 |
| Growtech | Axpert GT, Axpert Max GT | `voltronic` | RS232 | ✅ |
| Hanchu | HESS off-grid | `srne` | RS485, USB, WiFi stick | 🟡 |
| Huawei | SUN2000 KTL-L1 Single-Phase Hybrid, SUN2000-KTL-M3, SUN2000-TL-M1 Three-Phase | `huawei` | — | 🟡 |
| HumsiENK | HSINV KWSP-SGRE Hybrid | `sumry` | RS232, WiFi stick | 🟡 |
| HZSolar | HZ Off-Grid | `sumry` | RS232, WiFi stick | 🟡 |
| INVT | XD10KTL Hybrid | `megarevo` | RS485, Solarman | 🟡 |
| Kodak | OG Off-Grid | `voltronic` | RS232, USB | ✅ |
| LiveFun | GES Split-Phase Hybrid | `sumry` | RS485, USB, WiFi stick | 🟡 |
| Livoltek | HP3, Hyper | `livoltek` | RS485, USB | 🟡 |
| Luxpower | LXP AC Coupled, LXP-LB Hybrid, SNA Single-Phase Hybrid, SNA-US Split-Phase Hybrid | `luxpower` | RS485, WiFi stick | 🟡 |
| LVTopSun | LV-Pro Off-Grid | `growatt` | USB | ✅ |
| Mecer | SOL-I-AX-11M | `voltronic` | RS232, USB | ✅ |
| Megarevo | R-KL1 Single-Phase Hybrid ESS | `megarevo` | RS485, Solarman | 🟡 |
| MidNite Solar | Midnite Rosie ❌, MN-AIO All-In-One 🟡 | `midnite` | CAN, RS485 | 🟡 ❌ |
| MPP Solar | MPI Hybrid, MPI Three-Phase, MPI Waterproof (IP65 Rated) WP | `voltronic` | RS232, USB | 🟡 |
| MUST | PH11 PRO, PH11 Three-Phase Hybrid, PH18-Plus Hybrid, PV19-EXP Series, PV33 TLV Series | `must` | RS485, USB | 🟡 |
| OPTI-Solar | SP Brilliant Ultra III Series, SP Handy Grid III Series, SP Handy II Series, SP Handy Plus II Series, SP Handy Plus Series, SP Handy Series, SP Handy Ultra Series, SP Initial Series, SP IP Grid HV ECO Series, SP IP Grid HV Series, SP IP Grid Series, SP Power One Series, SP Premium Plus Series, SP Regal Ultra Series | `voltronic` | RS232, USB | ✅ |
| Phocos | Phocos Any-Grid | `voltronic` | RS232, USB | ✅ |
| POWLAND | GES-500 Split-Phase Hybrid | `sumry` | RS485, USB, WiFi stick | 🟡 |
| PowMr | HVM KP-series All-In-One ✅, HVM M-series All-In-One ✅, HVM P-series All-In-One Three-Phase ✅, LVM H-series All-In-One 🟡, POW-LVM All-In-One 48V 🟡, POW-SunSmart 🟡, POW-SunSmart Split-Phase 🟡 | `voltronic`, `srne` | RS232, WiFi stick, RS485, USB | ✅ 🟡 |
| RCT | Axpert AXMX2, Axpert MK4 Twin | `voltronic` | RS232, USB | ✅ |
| RUiXU | SUNON Split-Phase Off-Grid 🔍, SUNON10 Split-Phase Off-Grid 🟡 | `srne` | RS485, USB, WiFi stick | 🟡 🔍 |
| Salvare | 10 PRO | `senergy` | RS485 | 🟡 |
| Senergy | SE KTL-G2P Split-Phase Hybrid | `senergy` | RS485 | 🟡 |
| Sigenergy | SigenStor EC Single-Phase Hybrid, SigenStor EC Three-Phase Hybrid | `sigenergy` | WiFi stick, LAN | 🟡 |
| Sol-Ark | 12K-2P Hybrid, 15K-2P Hybrid, 18k-2P, 30K-3P High-Voltage, 5K-1P Hybrid | `sunsynk` | RS232, RS485, WiFi stick | ✅ |
| Solax | X1 Lite LV | `solax` | RS485 | 🟡 |
| Solis | RHI-HVES-5G-DC Hybrid, S5-EH1P-L Single-Phase Hybrid, S6 Hybrid, S6 Three-Phase K-H Series, S6-EH3 Solarator Series | `solis` | RS485, WiFi stick | 🟡 |
| SRNE | ABP Split/Single-Phase Off-Grid, ASF Single-Phase Off-Grid, ASP Split-Phase Hybrid, ASP Three-Phase Off-Grid, HESP Single-Phase Hybrid, HYP Single/Split-Phase Low Voltage, SR-HF Off-Grid | `srne` | RS485, USB, WiFi stick | 🟡 |
| Sumry | HGX, VICTOR MAX Hybrid | `sumry` | RS232, WiFi stick | 🟡 |
| SunGoldPower | FR12K-B All-In-One Off-Grid 🟡, SGN-KHB Split-Phase Hybrid 🔍, SGS-MAX All-In-One Hybrid 🟡, SPH-80A Hybrid 🟡, SPH-P Solar Charger 🟡 | `srne` | RS485, USB, WiFi stick | 🟡 🔍 |
| Sungrow | SG-RT Three-Phase Grid-Tied, SH-RT Three-Phase Hybrid, SH-T Three-Phase Hybrid | `sungrow` | WiFi stick, LAN, RS485 | 🟡 |
| SunSynk | Acure Single-Phase, LIFELYNK S, X & XL SERIES, SG01HP3 3-Phase Hybrid, SG01LP1 Single-Phase Hybrid, SG02LP1 Single-Phase Hybrid, SG03LP1 Hybrid Single-Phase, SG04LP3 3-Phase Hybrid, Sunsynk Lifelynk Lynks | `sunsynk` | RS485, WiFi stick, RS232 | ✅ |
| Synerji | SYSV Off-Grid | `must` | RS485, USB | 🟡 |
| The Sun Pays | MPS-V MAX Duel AC output | auto-detect | RS232, WiFi stick | 🔍 |
| Tingen | GES Split-Phase Hybrid | `sumry` | RS485, USB, WiFi stick | 🟡 |
| Turbo Energy | 5.0 Hybrid SERIES | `sunsynk` | RS232, RS485, Solarman | ✅ |
| Vestwoods | R8KL1NA Split-Phase Hybrid | `megarevo` | — | 🟡 |
| Vevor | EM-24L Hybrid 🟡, EM-48L Hybrid 🔍 | `sumry` | RS232, WiFi stick | 🟡 🔍 |
| Victron | EasySolar-II, MultiPlus-II | `victron` | GX, LAN | 🟡 |
| Voltronic | Axpert MAX II ✅, Axpert MKS ✅, Axpert MKS II ✅, InfiniSolar 3-phase 🟡, InfiniSolar Hybrid 🟡, InfiniSolar PRE-Series Hybrid 🟡, InfiniSolar V Multiphase 🟡, InfiniSolar WP LV Hybrid 🟡, Knox Krypton Infini Max II 🟡 | `voltronic` | RS232, USB, RS485 | ✅ 🟡 |
| WattCycle | SPHPB-SGRC Split-Phase All-In-One | auto-detect | USB | 🔍 |
| WeVolt | WVLVS-IP54, WVLVS-IP55 | `(gospower)` | RS232 | ❌ |
| WKS | EVO-CIRCLE Single-Phase Hybrid | `voltronic` | RS232, USB | ✅ |

**Batteries and grid:**

| Type | Driver | Models / notes | Link |
|---|---|---|---|
| Inverter | Simulator | Off-grid or hybrid, 1–n parallel units | none |
| Battery | USB Serial RS232/485 | Pylontech (RS485), Dyness / Mecer, Seplos V2 / Shoto / LBSA, SOK, Revov, Trophy, SunSynk SUN-BATT / BYD, Vestwood, Generic | serial, Pylontech-style protocol |
| Battery | USB PylonTech/Pytes console | Pylontech US/UP series, Pytes (console port) | serial 115200 |
| Battery | USB Narada RS485 | EG4 LifePower4 (no LCD), SunSynk SSLB, Shoto L5, Vestwood VT48100e | serial |
| Battery | USB Modbus RS232/485 | EG4 LL / LifePower4 (LCD), Seplos V3, Revov R9 Gen1, Polarium, Leoch, Ecomlight, SunStone | serial Modbus RTU |
| Battery | USB Voltronic LIB RS485 | Felicity Solar, Giter | serial (experimental) |
| Battery | USB JK RS485 | JK BMS, JK inverter BMS (JK-PB: master port or listen to the parallel bus) | serial 115200 |
| Battery | USB Daly UART/RS485, USB JBD RS485 | Daly, JBD / Overkill | serial, one port per BMS |
| Battery | USB CAN bus | Any battery speaking Pylontech/Sunsynk CAN (CFE, SolarMD, Pylontech, Dyness…), listen-only, whole bank | Waveshare USB-CAN-A, Seeed USB-CAN Analyzer, or SocketCAN (`can0`) |
| Battery | USB Victron VE.Direct | BMV / SmartShunt | serial 19200 |
| Battery | Use inverter values / Emulated BMS / Simulated | Emulated uses energy counting for lead-acid or unlinked banks | none |
| Grid | Default / Energy-Charts day-ahead prices / Eskom load-shedding | 41 EU bidding zones; South African areas | internet |

> **Most drivers have not been tested on real hardware yet.** They are written from vendor protocol documents and community register maps. Drivers that haven't been confirmed are read-only: readings work, settings can't be changed until someone with that inverter checks them (`docs/HARDWARE_TEST.md`). Reports from real hardware are the most useful contribution you can make: open a *Hardware report* issue.

## Quick start (no hardware)

```bash
npm install
npm run seed -- 30   # optional: 30 days of simulated history
npm start            # http://localhost:8080, MQTT on :1883
```

The simulator runs by default. To switch to your inverter, go to **Configuration → Devices**, pick your brand and series (or press Auto-detect), choose the connection, then press Save.

## Install on an existing OS

Prefer the images above. To install on a board that already runs Raspberry Pi OS (Bookworm or newer) or Armbian:

Supported boards:

| Board | OS | Smart-device engine |
|---|---|---|
| Raspberry Pi 5, Pi 4 (2 GB+), Orange Pi 3 LTS | 64-bit | Full (every Home Assistant integration) |
| Raspberry Pi 3, Pi 4 (1 GB) | 64-bit | Lite by default; Full fits but is tight on memory |
| Raspberry Pi Zero 2 W | 32- or 64-bit | Lite |
| Raspberry Pi 1, 2, Zero, Zero W | 32-bit | Lite |

On Full boards the installer also installs Home Assistant (Docker, pinned version, listening on 127.0.0.1 only), and Sunroost
sets it up and connects by itself. Use `--no-home-assistant` to skip it, or `--home-assistant` to force it on a 1 GB board.
Boards without Full can link to a Home Assistant elsewhere on the network (Smart devices → Device settings). Details:
`docs/SMART_HOME.md`.

Only the LTS model of the Orange Pi 3 is supported. A 64-bit-capable Pi running the 32-bit OS gets the Lite engine. **Configuration → System** reports the detected board and engine (`profile` in `GET /api/system`).

```bash
sudo deploy/install.sh
```

Run `sudo deploy/install.sh --kiosk` to also drive an HDMI screen. The script detects the board and installs Node for it, checksum-verified: Node 24 LTS on 64-bit boards, and Node 22 LTS on 32-bit ones (official ARMv7 builds, Node's unofficial build for ARMv6; Node 22's security support ends in April 2027), plus `cloudflared` and `uhubctl`. Pi 1 and Zero get no `cloudflared`, because Cloudflare doesn't build it for ARMv6, so use the reverse-proxy option for remote access there. `--kiosk` is skipped on boards with less than 1 GB of RAM. The script creates a `sunroost` system user and a systemd service on **port 80**, and adds narrowly scoped polkit/sudoers rules for the WiFi, time, power, SSH, Bluetooth and kiosk controls. Everything else is configured in the web UI. Logs: `journalctl -u sunroost -f`.

After installing, `cd /opt/sunroost && sudo -u sunroost npm run selftest` checks the board, storage, serial ports, multicast, Sunroost, MQTT and Home Assistant. `docs/HARDWARE_TEST.md` is the full checklist for real boards and devices.

Smart devices without Home Assistant (every board): MQTT discovery, Tasmota, Shelly, ESPHome, Philips Hue, TP-Link Kasa/Tapo, Tuya, WiZ and Modbus, built in (see `docs/SMART_HOME.md`).

Boot options go in `config.json` or environment variables: `SOLAR_PORT` (8080), `SOLAR_HOST`, `SOLAR_DATA` (`data/`), `SOLAR_CONFIG`.

## Remote access on your own domain

**Configuration → Remote access** puts the dashboard on a domain such as `https://solar.example.com`.

- **Own domain (simplest).** Enter the domain and add the one DNS **A record** the page shows (your public IP) at your domain provider. A live checklist then covers the rest:
  - router ports 80/443 opened via UPnP, or the exact manual rule to add
  - a carrier-grade NAT check
  - a free Let's Encrypt certificate, with automatic renewal
  - the built-in HTTPS listener
  - a reachability test from the internet

  If your home IP changes, pick a dynamic-DNS provider (DuckDNS, Cloudflare DNS, Namecheap, or any update URL) and the record is updated automatically.

- **Cloudflare Tunnel (recommended).** No router changes are needed, HTTPS is automatic, and it works behind CGNAT.
  1. Add your domain to Cloudflare (the free plan is enough).
  2. Create a tunnel under **Zero Trust → Networks → Tunnels** and route the hostname to `http://localhost:8080`.
  3. Paste the tunnel token into the app. It then runs and supervises `cloudflared` itself; `deploy/install.sh` installs `cloudflared` from Cloudflare's apt repository.
- **Own reverse proxy.** Use Caddy or nginx on the Pi with ports 80/443 forwarded. The page shows a ready-made Caddyfile.

Going public requires a local password of at least 10 characters. Other protections:
- Sign-in attempts are rate-limited per client address.
- Session cookies are `Secure` over HTTPS.
- Cross-site requests and WebSocket connections are rejected.
- Forwarded headers are trusted only from localhost.

The MQTT broker is not exposed and stays on the LAN. The **Test from the internet** button fetches your domain from the device and confirms it reaches this unit.

## Development

```bash
npm run dev         # restart on source changes
npm run typecheck
npm test            # node:test (1000+ tests)
```

The stack is Node 22 LTS or newer (22.18+) running TypeScript directly (type stripping), with `node:sqlite`, Fastify and aedes. The frontend is Preact + htm + uPlot as plain ES modules, with no build step.

## Contributing

Bug reports, hardware reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
