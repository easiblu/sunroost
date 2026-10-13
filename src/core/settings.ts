/**
 * Persistent app settings (key → JSON value) with typed defaults.
 * Everything the user configures in the UI lives here; config.json only bootstraps
 * the HTTP port, database path and simulation flag.
 *
 * Key names are snake_case, matching the MQTT settings topics where one exists.
 */
import { EventEmitter } from 'node:events';
import { db } from './db.ts';

export const DEFAULTS = {
  // General / localization
  'site.name': 'Sunroost',
  /** Site location for weather (Open-Meteo); null until the user picks a place. */
  'site.latitude': null as number | null,
  'site.longitude': null as number | null,
  'site.location_name': '' as string,
  /** Grid CO₂ intensity used for "CO₂ saved" (kg per kWh of solar). */
  'site.co2_kg_per_kwh': 0.4,
  /** Solar array size in kWp; 0 = unknown. Used for the solar forecast until Sunroost has learned from its own history. */
  'site.pv_kwp': 0,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  temperature_unit: '°C' as '°C' | '°F',
  locale: 'en',
  'auth.password_hash': '' as string,
  'auth.secret': '' as string,

  // Devices
  auto_start_devices: true,
  'inverter.driver_id': 'simulator',
  'inverter.model_id': '' as string,
  'inverter.interface_id': '' as string,
  /** One entry per inverter: a serial path like /dev/ttyUSB0 or a host:port for TCP. */
  'inverter.connection_ids': [] as string[],
  // 0 = the driver's default (Voltronic 2400, MUST 19200 at address 4, …).
  'inverter.baud_rate': 0,
  'inverter.modbus_address': 0,
  'inverter.poll_interval_ms': 2000,
  'inverter.self_consumption': 0,
  'inverter.grid_connection': 'auto' as 'auto' | 'grid_ct' | 'grid_ld',
  'inverter.temperature_multiplier': 1,
  /** "CRC verification" option (Voltronic). Some firmwares send bad CRCs. */
  'inverter.verify_crc': true,
  'bms.driver_id': 'inverter',
  'bms.connection_ids': [] as string[],
  /** 0 = the driver's default. */
  'bms.baud_rate': 0,
  'bms.model_id': '' as string,
  /** kWh. Used for %/hr and the emulated BMS when the battery doesn't report capacity. */
  'bms.capacity': 10,
  'bms.soc': 50,
  'bms.drift_soc': true,
  'bms.voltage_30_soc': 49.6,
  'bms.voltage_80_soc': 52.8,
  'bms.invert_current': false,
  /** Advanced › Battery options for Pylontech-style serial batteries. */
  'bms.serial_protocol_variant': 'auto' as string,
  /** '' = auto, 'soc', 'charge/design', 'charge/full'. */
  'bms.protocol_soc': '' as string,
  /** '' = auto, 'full,design', 'full', '10xfull', 'design'. */
  'bms.protocol_capacity': '' as string,
  /** '' = auto, '0.1K', '1K', '0.1°C', '1°C', '1°C-10'. */
  'bms.protocol_temperature': '' as string,
  /** Take battery current from the inverter when packs only report it on the master. */
  'bms.read_current_from_inverter': false,
  /** CAN bus adapter: 'auto' | 'socketcan' | 'waveshare' | 'seeed'; interface name for SocketCAN. */
  'bms.can_adapter': 'auto' as string,
  'bms.can_interface': 'can0' as string,
  /** Stacked packs to probe on one port ("Maximum pack count", 1–32). */
  'bms.maximum_pack_count': 16,

  // Dashboard (gauge full-scale values)
  max_grid_power: 6000,
  max_pv_power: 6000,
  max_battery_power: 5000,
  battery_metric: 'soc' as 'soc' | 'voltage' | 'both',

  // Grid / tariffs
  'grid.driver_id': 'default' as 'default' | 'energy_charts' | 'eskom',
  'grid.area': 'DE-LU',
  'grid.currency': 'EUR',
  'grid.price_multiplier': 1,
  /** Flat tariff used for cost estimates on the Totals page; 0 hides costs. */
  'tariff.import_price': 0,
  'tariff.export_price': 0,

  // MQTT
  publish_mqtt: true,
  'mqtt.broker': 'builtin' as 'builtin' | 'external',
  'mqtt.port': 1883,
  'mqtt.url': '' as string,
  mqtt_prefix: 'sunroost',
  mqtt_allow_update: false,
  mqtt_discovery: true,
  mqtt_uniq_id: 'sr',
  mqtt_username: '' as string,
  mqtt_password: '' as string,
  reset_energy: 'd' as 'd' | 'w' | 'm',

  // Storage
  'history.raw_retention_days': 14,

  // Automations
  'automation.override_until': 0,
  /** Automations (and spare solar) switch one device at most this often per hour; 0 = no limit. */
  'automation.device_max_switches_per_hour': 12,
  /** Loop protection: a rule that ran this many times in 10 minutes is paused until the window passes; 0 = off. */
  'automation.max_runs_per_10min': 12,

  // Spare solar: devices with the "deferrable" role run on surplus, one at a time, in `surplus.order`.
  'surplus.enabled': false,
  /** Below this battery state of charge only exported power counts as surplus (the battery charges first). */
  'surplus.battery_soc': 90,
  /** Entity ids in start order; deferrable devices not listed come after, by name. */
  'surplus.order': [] as string[],
  /** Extra headroom (W) above a device's power before it is started. */
  'surplus.start_margin_w': 100,
  /** Surplus must last this long before starting a device, and a shortfall this long before stopping one. */
  'surplus.start_minutes': 5,
  'surplus.stop_minutes': 3,
  /** A device started on spare solar runs at least this long. */
  'surplus.min_on_minutes': 15,
  /** Internal: devices spare solar switched on (entity id → when), so it only stops what it started. */
  'surplus.managed': {} as Record<string, number>,

  // Smart devices
  /** Device engine: auto picks "full" (every Home Assistant integration) on boards that can run it, else "lite". */
  'home.engine': 'auto' as 'auto' | 'lite' | 'full',
  /** Home Assistant used by the full engine: the one install.sh runs locally, or another on the network. */
  'home.full_url': 'http://127.0.0.1:8123',
  /** Simulated MQTT devices (plug, bulb, air conditioner, EV charger) for trying smart devices without hardware. */
  'home.demo_devices': false,

  // Notifications (automation "notify" actions)
  /** Full ntfy topic URL, e.g. https://ntfy.sh/my-solar-xyz (may embed a token: never logged in full). */
  'notify.ntfy_url': '' as string,
  /** Webhook receiving POST JSON {title, message, ts}. */
  'notify.webhook_url': '' as string,

  // Remote access
  /**
   * off: LAN only; domain: own domain via DNS A record + built-in HTTPS (Let's Encrypt) + UPnP;
   * cloudflare: managed Cloudflare Tunnel; proxy: the user's own reverse proxy.
   */
  'remote.mode': 'off' as 'off' | 'domain' | 'cloudflare' | 'proxy',
  /** Own-domain mode: HTTPS listener port and whether to open router ports via UPnP. */
  'remote.https_port': 443,
  'remote.upnp': true,
  /** Optional email for Let's Encrypt expiry notices. */
  'remote.acme_email': '' as string,
  /** Dynamic DNS: keeps the A record pointing at a changing home IP. */
  'remote.ddns_provider': 'none' as 'none' | 'duckdns' | 'cloudflare' | 'namecheap' | 'url',
  /** Provider secret (DuckDNS token / Cloudflare API token / Namecheap DDNS password / URL with {ip}). Never returned by the API. */
  'remote.ddns_token': '' as string,
  /** Public hostname, e.g. solar.example.com. */
  'remote.domain': '' as string,
  /** Cloudflare Tunnel token (secret; never returned by the API). */
  'remote.cloudflare_token': '' as string,
  /** Path to the cloudflared binary; empty = look it up on PATH. */
  'remote.cloudflared_path': '' as string,
};

export type SettingKey = keyof typeof DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof DEFAULTS)[K];

class Settings extends EventEmitter {
  private cache = new Map<string, unknown>();

  init() {
    db().exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    for (const row of db().prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]) {
      try {
        this.cache.set(row.key, JSON.parse(row.value));
      } catch {
        // Ignore a corrupt row; the default applies.
      }
    }
  }

  /** Stores values for known keys that have never been set (first-run defaults from the boot config). */
  seed(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      if (!this.isKey(key) || this.cache.has(key)) continue;
      const def = DEFAULTS[key];
      if (def !== null && typeof value !== typeof def && !(Array.isArray(def) && Array.isArray(value))) continue;
      this.set(key, value as never);
    }
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    return (this.cache.has(key) ? this.cache.get(key) : DEFAULTS[key]) as SettingValue<K>;
  }

  set<K extends SettingKey>(key: K, value: SettingValue<K>) {
    this.cache.set(key, value);
    db().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
    this.emit('change', key, value);
  }

  /** Applies several keys at once and emits a single 'changes' event with the changed keys. */
  setMany(values: Partial<{ [K in SettingKey]: SettingValue<K> }>) {
    const keys = Object.keys(values) as SettingKey[];
    for (const k of keys) this.set(k, values[k] as never);
    this.emit('changes', keys);
  }

  /** All settings with defaults applied, minus secrets. */
  publicView(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      if (key.startsWith('auth.') || key === 'mqtt_password' || key === 'remote.cloudflare_token' || key === 'remote.ddns_token') continue;
      out[key] = this.get(key);
    }
    out['auth.password_set'] = Boolean(this.get('auth.password_hash'));
    out['mqtt_password_set'] = Boolean(this.get('mqtt_password'));
    out['remote.cloudflare_token_set'] = Boolean(this.get('remote.cloudflare_token'));
    out['remote.ddns_token_set'] = Boolean(this.get('remote.ddns_token'));
    return out;
  }

  isKey(key: string): key is SettingKey {
    return key in DEFAULTS;
  }
}

export const settings = new Settings();
