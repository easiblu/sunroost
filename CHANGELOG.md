# Changelog

## 0.1.0 (unreleased)

First public release.

- Live dashboard, history, totals, charts and power controls for solar, battery and grid.
- 23 inverter protocol drivers (190+ series, 60 brands); most are read-only until confirmed on hardware. Brand
  catalogue and auto-detect. Connections: USB, RS232/485, Modbus TCP, Solarman, Luxpower, GoodWe and Eybond WiFi sticks.
- Battery BMS drivers (Pylontech, JK, Daly, JBD, Seplos, CAN bus, VE.Direct and more).
- Automations with a When → If → Then builder, scenes, spare-solar control and device safety limits.
- Smart devices: built-in drivers (MQTT, Tasmota, Shelly, ESPHome, Hue, Kasa, Tuya, WiZ, Modbus) or Home Assistant.
- MQTT with Home Assistant discovery; optional compatibility with SolarAssistant's published MQTT topic layout.
- SD-card images for Raspberry Pi (32- and 64-bit) and Orange Pi 3 LTS.
