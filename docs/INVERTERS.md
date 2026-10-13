# Inverter support

Sunroost knows **206 series from 65 brands** (Configuration → Devices → Brand). Each series maps to the protocol it speaks, and
the protocol to a driver. Many brands are rebrands: PowMr, Easun and SunGoldPower speak SRNE; Sol-Ark and Turbo Energy speak
Deye; MPP Solar, Mecer, OPTI-Solar and a dozen more speak Voltronic.

The list lives in `src/devices/catalogue-data.ts` (data) and `src/devices/catalogue.ts` (support levels, worked out from the
drivers that exist). `GET /api/devices/catalogue` returns it with a coverage count.

| Support | Meaning |
|---|---|
| Supported | Driver and model exist; readings and settings |
| Read-only | Readings only; settings shown but not writable until verified on hardware (the manager also refuses writes) |
| Planned | The protocol is known; no driver yet |
| Use auto-detect | The protocol for this series is unknown; probe the connection |

## Protocols

All new drivers are **read-only** until a real unit has been checked (`readOnly: true`; the manager refuses writes and
automations get no SOC control). Per-register confidence is noted in each driver's register file.

| Protocol | Driver · models | Default link | Brands |
|---|---|---|---|
| sunsynk | `sunsynk` · hybrid, hybrid3, hybrid3hv, string | 9600, addr 1 | Deye, SunSynk, Sol-Ark, Turbo Energy |
| growatt | `growatt` · spf, sph, sph3, tlxh, tlx, wit (WIT read-only; auto-detect picks it from DTC 5600–5603) | 9600, addr 1 | Growatt, LVTopSun |
| voltronic | `voltronic` · axpert, axpert_king, axpert_max, infinisolar (read-only) | 2400 / USB HID | Voltronic, MPP Solar, Easun, Effekta, EG4 off-grid, Mecer, PowMr, Kodak, OPTI-Solar, Phocos, RCT, WKS, Growtech, Fronus, Datouboss, Anern |
| srne | `srne` (read-only) · offgrid, offgrid-split, offgrid-three, hybrid, hybrid-split | 9600, addr 1 | SRNE, PowMr, Easun, Eco-worthy, Hanchu, RUiXU, SunGoldPower |
| sumry | `sumry` (read-only) · smg (classic SMG-II map), smg_ext (split-phase / 11 kW map) | 9600, addr 1 | Sumry, Anenji, Busbyr, Conderenergy, Daxtromn, HumsiENK, HZSolar, LiveFun, POWLAND, Tingen, Vevor, Easun SMG, EG4 3000EHV |
| luxpower | `luxpower` (read-only) · hybrid, ac | 19200, addr 1; or the WiFi dongle | Luxpower, EG4 hybrids (not GridBOSS) |
| must | `must` (read-only) · ph1800, pv1900, pv3300, ph10 | 19200, **addr 4** | MUST, Synerji |
| megarevo | `megarevo` (read-only) · hybrid, split, three, invt_xd | 9600, addr 1 | Megarevo, INVT (own map), Amensolar, Vestwoods |
| felicity | `felicity` (read-only) · ivem, trex, hv3 | 2400 (hv3: 9600), addr 1 | Felicity Solar |
| solis | `solis` (read-only) · hybrid, hybrid3, string, string3 | 9600, addr 1; Solis/Solarman stick | Solis, Dyness 1P-A |
| goodwe | `goodwe` (read-only) · et, eh, et-split, es (es: dongle only) | 9600, **addr 247**; or `goodwe://ip` (UDP 8899) | GoodWe |
| huawei | `huawei` (read-only) · hybrid, three | SDongleA `ip:502` addr 1; inverter WLAN `ip:6607` addr 0; RS485 9600 | Huawei SUN2000 (+ LUNA2000, DTSU666-H) |
| sungrow | `sungrow` (read-only) · hybrid3, hybrid, grid | WiNet-S `ip:502` or RS485 9600, addr 1 | Sungrow SH / SG |
| victron | `victron` (read-only) · gx | GX device `ip:502`, **unit 100** (VE.Bus unit found automatically) | Victron MultiPlus-II, EasySolar-II, Quattro |
| sigenergy | `sigenergy` (read-only) · hybrid, hybrid3 | `ip:502`, plant **unit 247**, inverter unit 1 | Sigenergy SigenStor EC |
| senergy | `senergy` (read-only) · hybrid, split, hybrid3 | 9600, addr 1 | Senergy, Duracell Dura-i, Salvare |
| solax | `solax` (read-only) · x1_hybrid, x3_hybrid, x1_lite_lv | 19200 (also tries 9600), addr 1; Pocket WiFi `ip:502` | Solax |
| livoltek | `livoltek` (read-only) · hyper, hp3 | 9600 (also tries 19200), **addr 17** | Livoltek |
| afore | `afore` (read-only) · hybrid, hybrid3 | 9600, addr 1; Solarman stick | Afore |
| midnite | `midnite` (read-only) · aio (a Senergy SE 11.4KHB-UL underneath, same map) | 9600, addr 1 | MidNite MN15-12KW-AIO. **Rosie: no driver** (MidNite's CAN protocol is unpublished; needs a `candump` capture and bitrate) |
| gospower | **no driver**: no public protocol found | | WeVolt (Gospower GPEO) |

Baud rate and Modbus address default to **0 = the driver's default** (`defaultBaudRate`, `defaultAddress`); Advanced
settings can override them.

## Connections

- **USB / RS232 / RS485**: a serial path (`/dev/ttyUSB0`), or `/dev/hidraw0` for Voltronic USB HID.
- **Modbus TCP**: `host:port` (an RS485-to-Ethernet gateway, or inverters with Modbus TCP built in).
- **Solarman V5 logger**: `solarman://ip[:port]/serial` (`src/devices/solarman.ts`). The WiFi stick relays Modbus RTU frames
  wrapped in a V5 envelope on TCP 8899, and only answers requests carrying its own serial. **Find Solarman loggers** uses
  the UDP 48899 discovery broadcast. Any Modbus driver works over it unchanged: `ModbusConnection` handles the transport.
- **Luxpower/EG4 WiFi dongle**: `luxpower://ip[:8000]/<dongle serial>[/<inverter serial>]` (`inverters/luxpower/dongle.ts`),
  the dongle's own TCP framing. Only the Luxpower driver accepts it.
- **Not yet**: the Eybond / SmartESS / "WiFi Plug Pro" dongles sold with Sumry-family inverters speak a cloud protocol that
  needs the dongle pointed at Sunroost; until that transport exists those units need a cable (or a Solarman stick).
- **Eybond / SmartESS / "WiFi Plug Pro" dongle**: `eybond://[port][/PN]` (`src/devices/eybond.ts`). These dongles dial *out* to
  a cloud server; Sunroost listens (port 8899) and, when the user clicks **Point dongle here**, sends the dongle
  `set>server=<board ip>:8899;` on UDP 58899. That is temporary: after a reboot the dongle returns to the cloud. Making it
  permanent (collector parameter 21, or DNS for ess.eybond.com → the board on port 502) is documented but not wired up.
  Offered for the Sumry, SRNE, Voltronic and MUST drivers; any Modbus driver works over it.
- **GoodWe WiFi/LAN dongle**: `goodwe://ip[:8899]` (`inverters/goodwe/udp.ts`): Modbus RTU frames over UDP for ET-family
  units, the older AA55 protocol for ES/EM/BP.
- **Victron**: enable Modbus TCP on the GX (Settings → Services → Modbus TCP). VE.Bus over an MK3-USB cable is not supported.
- **Sungrow**: newer WiNet-S firmware encrypts Modbus TCP; those units need an RS485 cable (or older dongle firmware).
- **Huawei**: enable Modbus TCP in FusionSolar for the inverter's own WLAN/LAN; Sunroost waits 1 s after connecting before the
  first request.

## Auto-detect

`POST /api/devices/detect {connection}` (`src/devices/detect.ts`) probes one connection with read-only queries. Serial and
HID paths get the Voltronic `QPI`/`QMN` query first (PI17/PI18 → InfiniSolar). Then each driver's `detect(conn)` hook runs at
each of its `detectBaudRates` (default: its default baud rate). A probe may try other unit ids itself (MUST tries 4, then
1) and report the one that answered; **Use** stores it. `test/inverter-detect-cross.test.ts` runs every probe against every
other brand's identity registers, so no probe claims another brand's inverter. A new Modbus driver adds a `detect` that reads a few identifying registers and returns
`{ modelId?, evidence }`, or null. Refused while the device connection is running.

## Adding a driver

1. Implement `InverterDriverDescriptor` (`src/devices/types.ts`). Set `readOnly: true` until a real unit has been checked.
2. Add `detect` if the protocol has identifying registers.
3. Register it in `src/devices/registry.ts`. The catalogue rows with that protocol id switch from *Planned* automatically.
   If the driver has models, set the `m` model id on those rows in `catalogue-data.ts`.
