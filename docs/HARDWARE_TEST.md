# Hardware test checklist

Everything here has been tested on macOS, in Linux containers (arm64, ARMv7, emulated ARMv6), against a real Home Assistant
2026.10 and a real ESPHome 2026.9 build. What only real boards and devices can show is below. Run the sections for the boards
you have. Note anything that fails, and attach `journalctl -u sunroost -n 300` and the self-test output.

## 0. Before you start
- A fresh SD card or SSD with Raspberry Pi OS (Bookworm or newer) Lite. Use 64-bit on Pi 3, 4, 5 and Zero 2 W unless you are
  testing 32-bit on purpose. On the Orange Pi 3 LTS, use Armbian or Debian (64-bit).
- On the board: `git clone` (or copy) the project, then from its folder run `sudo deploy/install.sh`.
- Record the output of: `cat /proc/device-tree/model`, `uname -m`, `dpkg --print-architecture`, `free -m`.
  **Orange Pi:** the model line must contain "OrangePi 3 LTS", or Sunroost won't recognise the board. Report the exact text.

## Image first boot (any board)
Flash the image for the board (README → Download), boot it, and check:
- With Ethernet: `http://sunroost.local` (or the board's IP) opens within ~2 minutes. Without Ethernet or WiFi set in
  Raspberry Pi Imager: a **Sunroost** WiFi hotspot appears; joining it leads to the WiFi setup page.
- Configuration → Devices shows **no inverter selected** (not the simulator).
- On a 64-bit board with 2 GB+: `systemctl status sunroost-firstboot` ends "First-boot setup done", and Home Assistant
  starts within ~10 minutes (it waits for internet if WiFi isn't set up yet).
- 32-bit image on a Pi 1 / Zero (ARMv6): the app starts (Node's ARMv6 build); slow but usable.
- Orange Pi 3 LTS: Armbian asks for a root password on its console the first time; Sunroost runs regardless.

## 1. Every board
1. The installer finishes with "Sunroost is running: http://…".
   - Pi 1 and Zero: it says it skips cloudflared and kiosk mode.
   - Boards with 2 GB or more: it says Home Assistant is starting.
2. `cd /opt/sunroost && sudo -u sunroost npm run selftest`: no ✗ lines.
   - Board and device engine match the table in README.md.
   - Node is 24 on 64-bit boards and 22 on 32-bit boards.
   - "Multicast discovery" is ✓.
3. Open `http://<board-ip>/`. The dashboard shows live values: the simulator by default, or your inverter once configured under
   Configuration → Devices.
4. **Configuration → System** shows the right board name.
5. Restart the board (`sudo reboot`). Sunroost comes back by itself.

## 2. Small boards (Pi 1, Zero, Zero W, Zero 2 W, Pi 2): speed and memory
1. `time sudo deploy/install.sh` on a Pi Zero: note the duration (`npm ci` is the slow part).
2. Let it run for 30 minutes with the inverter or simulator and four MQTT devices (Configuration → MQTT on, then Smart devices →
   Demo devices on). Then:
   - `systemctl status sunroost`: memory use (the "Memory:" line)
   - `top -b -n1 | head -15`: CPU use of node (should idle under about 20%)
   - the dashboard and Smart devices page load in under 5 s
3. Switch a demo plug on and off on the Smart devices page: it confirms within about 2 s.
4. `sudo -u sunroost npm run selftest` again: Memory is ✓.

## 3. Full engine boards (Pi 4/5 with 2 GB or more, Orange Pi 3 LTS)
1. `systemctl status sunroost-homeassistant` is active. The first start takes a few minutes; `docker ps` shows `sunroost-homeassistant`.
2. Within about 2 minutes of Home Assistant starting, the Smart devices KPI shows "Full", and Device settings shows
   "Home Assistant 2026.10.1 … on this board".
3. `curl -s http://<board-ip>:8123/` from **another computer** fails, because Home Assistant listens on 127.0.0.1 only.
4. Add integration → a brand you own (e.g. Shelly, Tuya, Hue) → finish its setup. Its devices appear and switch from Sunroost.
5. Devices Home Assistant discovers on your network show under "New devices" within a few minutes.
6. Device settings → **Back up**, then **Restart**: devices go unavailable and come back within about a minute.
7. Check memory: `free -m` and `docker stats --no-stream`.
8. **Pi 3 or 4 with 1 GB (optional):** `sudo deploy/install.sh --home-assistant`, then repeat steps 1–2 and watch for swapping
   (`vmstat 5`).

## 4. Lite engine with real devices (any board; set Smart devices → Device settings → Device engine → Lite)
For each brand you have, run **Scan** on the Smart devices page. The device should appear under "New devices"; set it up, then
switch it on and off. The ones whose simulator can't prove details:

| Brand | Check especially |
|---|---|
| Shelly Gen2+ | Live updates when you press the device's button; a password-protected device (digest auth, also on the WebSocket) |
| Shelly Gen1 | Discovery (`_http._tcp`) and the off-timer |
| Tuya | Protocol 3.4 and 3.5 devices (session keys); an energy plug's power reading; a circuit breaker's data points |
| Kasa / Tapo | A Tapo P110 with your TP-Link login (KLAP); the countdown off-timer |
| Hue | Plugs show as switches; motion and temperature sensors; reaction to the bridge being unplugged |
| Tasmota | Without SetOption19: devices appear by themselves; PulseTime off-timer; shutters, if you have one |
| ESPHome | A light, fan or cover (switch/sensor/number/select/button were tested on real ESPHome) |
| Modbus | An Eastron SDM120/SDM630 over RTU (USB–RS485): readings match the meter's display; a relay board |

## 5. Safety features (any board)
1. A device with the Protected role and an interlock "Max house load 1000 W": turning it on while the load is higher is refused
   with "Interlock: …", both by hand and from a rule.
2. A rule action "turn on … for 2 min" on a Shelly, Tasmota, Kasa or Tuya plug. Then stop Sunroost
   (`sudo systemctl stop sunroost`) right after it runs: the plug still switches off after 2 minutes (the device's own timer).
3. Spare solar with a deferrable plug on a sunny day: it starts when there is surplus and stops when a cloud makes the house
   import. History → "Spare solar" entries.

## 6. Your inverter
The inverter drivers were written from protocol documents and never run against real hardware. Configuration → Devices → pick
your inverter (Growatt: choose the model); then Inverter status shows sensible values, and **don't change settings** until the
readings look right. Report the model, the connection (USB/RS485/RS232), and any wrong or missing values.

**Solarman WiFi logger** (Deye, SunSynk, Sol-Ark, Megarevo, Solis, Afore … sticks with a 10-digit serial on the label):
Configuration → Devices → Network → **Find Solarman loggers**. The logger should be listed with its IP and serial; **Add** it,
then **Auto-detect**. Check: the logger answers at all (some newer firmware closes port 8899), readings match the inverter's
display, and they keep coming for an hour (loggers drop idle connections; Sunroost reconnects after 3 failed polls).

**Auto-detect** on a USB/RS485 port: it should name the right driver within ~10 s, and it must not change anything on the
inverter (it only reads). Report what it said for your model, especially wrong guesses.

**New read-only drivers (SRNE, Sumry, Luxpower/EG4, MUST, Megarevo/INVT, Felicity).** For each one you can reach: Auto-detect
names it; the dashboard numbers match the inverter's own display; and the settings page shows sensible values. The items
most likely to be wrong are below. Check them with the Modbus console and report the raw values.
- **Signs:** grid power (+ = import) and battery power (+ = charging) on every new driver. SRNE grid power is *derived*
  (load + battery − PV); compare it with a meter. The same applies to Felicity IVEM.
- **SRNE:** PV2 (0x010F–0x0111) on HESP/HYP; the phase B/C blocks on split/three-phase units; units answering on address 0xFF.
- **Sumry:** that register 184 = 3–6 really means the extended map; that export makes grid power (204) negative.
- **Luxpower:** where the serial lives (holding/input 115–119 or holding 2–6); the EPS L1/L2 legs on SNA-US/18kPV; whether
  the dongle accepts a blank inverter serial.
- **MUST:** address 4 versus 1 and 19200 baud per model; the battery current scale at 25274; the whole PH11 three-phase map.
- **Megarevo:** that single-phase units report on phase B; the model text at 0x121C. Also whether Amensolar and Vestwoods
  really use this map.
- **Felicity:** the T-REX LP and IVGM/HP maps (community sources only), the 0.01 kW scale, and 2400 versus 9600 baud on IVGM.
Once a model's readings are confirmed, its settings can be checked one by one before write support is turned on.

**Network inverters (Solis, GoodWe, Huawei, Sungrow, Victron GX, Sigenergy)**: all read-only too. Check the same things, plus:
- **Solis:** serial encoding at input 33004–33019; meter sign at 33130 (+ export assumed); battery power 33149 signed or not.
- **GoodWe:** that the dongle answers `goodwe://ip`, both the Modbus-over-UDP (ET/EH) and AA55 (ES) paths; s16 vs s32 for the
  power registers around 35124–35182; ES-C10 Uniq / D-ES / EHB really using the ET map.
- **Huawei:** meter power sign at 37113; unit 0 vs 1 on port 6607 vs the SDongle; whether 1 s after connect is enough.
- **Sungrow:** what encrypted WiNet-S firmware does on port 502 (Sunroost should say so); battery current/power signed or not;
  device type codes for SH-T and SG-RT.
- **Victron:** which VE.Bus unit id your GX uses (227/246/242); Device mode against the GX display; three-phase suffixes.
- **Sigenergy:** grid (30005) and battery (30037) signs; real model/serial strings at 30500/30515; multi-inverter systems.

**Phase 4 drivers (Senergy/Duracell/Salvare, Solax, Livoltek, Afore, Growatt WIT)**: read-only, same checks. Most likely wrong:
- **Senergy:** baud/address (some units need RS485 set to "Slave" in the app); grid (0x1300) and battery (0x2009) signs;
  the info block at 0x1A00.
- **Solax:** 19200 vs 9600; that holding 0x0007 reads "SolaX" (detect relies on it, or on the module name); feed-in word order
  and sign at input 0x46; the whole X1-Lite LV map (no public source).
- **Livoltek:** unit 17 and 9600 baud on Hyper and HP3; most V/A scales; 32-bit word order; the HP3 map.
- **Afore:** the WiFi stick answering as a Solarman logger; the battery block at input 2000–2014 (community source only).
- **Growatt WIT:** sign of battery power (input 8091); whether the 8000 block answers on the 4–15 kW units.

**Eybond / SmartESS dongle**: enter the dongle's IP and press **Point dongle here**. Check that the dongle connects within a
minute and is listed with its PN, that readings arrive after **Add**, and what happens after the dongle reboots (expected:
it goes back to the cloud). Report the dongle's reply text, its PN format, and whether requests time out (5 s).

**WeVolt / Gospower (no driver yet)**: if you have one, capture the RS232 port: (1) send `QPI\r` and `QPRTL\r` at 2400 and 9600
baud, with and without CRC; (2) a Modbus read (fn 3 and 4, unit 1, 9600 8N1) of registers 0–99; or best, (3) sniff the line
between the inverter and its "Solar Plug" WiFi dongle while the Solar of Things app runs.
