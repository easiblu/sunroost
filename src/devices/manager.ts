/**
 * Starts, polls and stops the configured inverter(s) and battery driver, keeps the
 * inverter settings cache, and validates + applies setting changes from the UI, MQTT and automations.
 */
import { EventEmitter } from 'node:events';
import { logger } from '../core/log.ts';
import type { Value } from '../core/metrics.ts';
import { settings } from '../core/settings.ts';
import { state } from '../core/state.ts';
import { bmsDriver, inverterDriver } from './registry.ts';
import type { BmsDriver, InverterDriver, SettingDef, SettingValues } from './types.ts';

const log = logger('devices');
const SETTINGS_REFRESH_MS = 60_000;
const SETTINGS_REREAD_AFTER_WRITE_MS = 1500;
const MAX_BACKOFF_MS = 30_000;

export interface SetResult {
  ok: boolean;
  message: string;
}

interface InverterSlot {
  driver: InverterDriver;
  connected: boolean;
  failures: number;
  timer: NodeJS.Timeout | null;
  settings: SettingValues;
  settingsReadAt: number;
}

class DeviceManager extends EventEmitter {
  private inverters: InverterSlot[] = [];
  private bms: BmsDriver | null = null;
  private bmsTimer: NodeJS.Timeout | null = null;
  private running = false;

  get started() {
    return this.running;
  }

  get inverterCount() {
    return this.inverters.length;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (!settings.get('inverter.driver_id')) {
      state.setStatus('inverter', 'disconnected', 'No inverter selected');
      this.running = false;
      return;
    }
    const desc = inverterDriver(settings.get('inverter.driver_id'));
    if (!desc) {
      state.setStatus('inverter', 'error', `Unknown inverter driver "${settings.get('inverter.driver_id')}"`);
      this.running = false;
      return;
    }
    const connections = settings.get('inverter.connection_ids');
    const list = desc.transport === 'none' ? (connections.length ? connections : ['']) : connections;
    if (!list.length) {
      state.setStatus('inverter', 'error', 'No connection selected');
      this.running = false;
      return;
    }
    log.info(`Opening device connections (${desc.name}, ${list.length} inverter${list.length > 1 ? 's' : ''}).`);
    state.setStatus('inverter', 'connecting', 'Connecting');
    this.inverters = list.map((connection, index) => ({
      driver: desc.create({
        modelId: settings.get('inverter.model_id'),
        connection,
        baudRate: settings.get('inverter.baud_rate') || desc.defaultBaudRate || 9600,
        address: settings.get('inverter.modbus_address') || desc.defaultAddress || 1,
        index,
        verifyCrc: settings.get('inverter.verify_crc'),
      }),
      connected: false,
      failures: 0,
      timer: null,
      settings: {},
      settingsReadAt: 0,
    }));
    this.inverters.forEach((slot, i) => this.pollInverter(i, slot));
    this.startBms();
    this.emit('started');
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const slot of this.inverters) {
      if (slot.timer) clearTimeout(slot.timer);
      await slot.driver.close().catch(() => {});
    }
    if (this.bmsTimer) clearTimeout(this.bmsTimer);
    await this.bms?.close().catch(() => {});
    this.inverters = [];
    this.bms = null;
    state.clear('inverter');
    state.clear('battery');
    state.setStatus('inverter', 'disconnected', 'Not connected');
    state.setStatus('battery', 'disconnected', 'Not connected');
    log.info('Device connections closed.');
    this.emit('stopped');
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  driver(index = 0): InverterDriver | null {
    return this.inverters[index]?.driver ?? null;
  }

  settingDefs(index = 0): SettingDef[] {
    return this.inverters[index]?.driver.settingDefs() ?? [];
  }

  settingValues(index = 0): SettingValues {
    return this.inverters[index]?.settings ?? {};
  }

  allSettings() {
    return this.inverters.map((s) => ({ defs: s.driver.settingDefs(), values: s.settings, info: s.driver.info() }));
  }

  /** Validates and writes one setting. Accepts the key or the label. */
  async setSetting(index: number, keyOrLabel: string, raw: Value, source = 'ui'): Promise<SetResult> {
    const slot = this.inverters[index];
    if (!slot?.connected) return { ok: false, message: 'Error: the inverter is not connected' };
    const def = slot.driver
      .settingDefs()
      .find((d) => d.key === keyOrLabel || d.label.toLowerCase() === keyOrLabel.toLowerCase());
    if (!def) return { ok: false, message: `Error: invalid setting: ${keyOrLabel}` };
    if (def.readOnly || this.readOnlyDriver()) return { ok: false, message: `Error: changing '${def.label}' is not supported` };
    const parsed = validate(def, raw);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    try {
      await slot.driver.writeSetting(def.key, parsed.value);
      slot.settings[def.key] = parsed.value;
      log.info(`Set '${def.label}' to '${parsed.value}' on inverter ${index + 1} (${source}).`);
      this.emit('settings', index, slot.settings);
      setTimeout(() => this.readSettings(index).catch(() => {}), SETTINGS_REREAD_AFTER_WRITE_MS);
      return { ok: true, message: `Set '${def.label}' to '${parsed.value}'` };
    } catch (err) {
      const message = `Failed to set '${def.label}' to '${parsed.value}': ${(err as Error).message}`;
      log.warn(message);
      return { ok: false, message };
    }
  }

  /** Drivers (or models) marked read-only never get writes, whatever their setting definitions say. */
  private readOnlyDriver() {
    const desc = inverterDriver(settings.get('inverter.driver_id'));
    return Boolean(desc?.readOnly || desc?.readOnlyModels?.includes(settings.get('inverter.model_id')));
  }

  async readSettings(index: number) {
    const slot = this.inverters[index];
    if (!slot?.connected) return;
    slot.settings = await slot.driver.readSettings();
    slot.settingsReadAt = Date.now();
    this.emit('settings', index, slot.settings);
  }

  private pollInverter(index: number, slot: InverterSlot) {
    const interval = Math.max(500, settings.get('inverter.poll_interval_ms'));
    const tick = async () => {
      if (!this.running) return;
      const started = Date.now();
      let delay = interval;
      try {
        if (!slot.connected) {
          await slot.driver.connect();
          slot.connected = true;
          state.updateInverter(index, slot.driver.info());
          log.info(`Inverter ${index + 1} connected.`);
        }
        state.updateInverter(index, await slot.driver.read());
        if (slot.failures > 0) log.info(`Inverter ${index + 1} communication restored.`);
        slot.failures = 0;
        if (this.inverters.every((s) => s.connected && s.failures === 0)) {
          if (state.status.inverter.name !== 'connected') state.setStatus('inverter', 'connected', 'Connected');
        }
        if (Date.now() - slot.settingsReadAt > SETTINGS_REFRESH_MS) {
          await this.readSettings(index).catch((e) => log.warn(`Reading settings failed: ${(e as Error).message}`));
        }
        delay = Math.max(0, interval - (Date.now() - started));
      } catch (err) {
        slot.failures++;
        const message = (err as Error).message;
        if (slot.failures === 1) log.warn(`Inverter ${index + 1}: ${message}`);
        state.setStatus('inverter', 'error', message);
        if (slot.failures >= 3 && slot.connected) {
          slot.connected = false;
          await slot.driver.close().catch(() => {});
        }
        delay = Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(slot.failures, 4));
      }
      if (this.running) slot.timer = setTimeout(tick, delay);
    };
    void tick();
  }

  private startBms() {
    const id = settings.get('bms.driver_id');
    const desc = bmsDriver(id);
    if (!desc) {
      state.setStatus('battery', 'disconnected', id === 'inverter' ? 'Read from inverter' : 'Not configured');
      return;
    }
    this.bms = desc.create({
      connections: settings.get('bms.connection_ids'),
      baudRate: settings.get('bms.baud_rate') || desc.defaultBaudRate || 9600,
      modelId: settings.get('bms.model_id'),
    });
    state.setStatus('battery', 'connecting', 'Connecting');
    let connected = false;
    let failures = 0;
    const tick = async () => {
      if (!this.running || !this.bms) return;
      try {
        if (!connected) {
          await this.bms.connect();
          connected = true;
        }
        const packs = await this.bms.read();
        packs.forEach((p, i) => state.updateBattery(i, p));
        if (state.status.battery.name !== 'connected') state.setStatus('battery', 'connected', 'Connected');
        failures = 0;
      } catch (err) {
        failures++;
        if (failures === 1) log.warn(`Battery: ${(err as Error).message}`);
        state.setStatus('battery', 'error', (err as Error).message);
        if (failures >= 3) {
          connected = false;
          await this.bms.close().catch(() => {});
        }
      }
      this.bmsTimer = setTimeout(tick, Math.max(1000, settings.get('inverter.poll_interval_ms')));
    };
    void tick();
  }
}

function validate(def: SettingDef, raw: Value): { ok: true; value: Value } | { ok: false; message: string } {
  const text = String(raw ?? '').trim();
  switch (def.type) {
    case 'select': {
      const match = def.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      return match
        ? { ok: true, value: match }
        : { ok: false, message: `Invalid value '${text}' for '${def.label}'. Valid values: ${def.options?.join(', ')}` };
    }
    case 'number': {
      const n = Number(text);
      if (!text || !Number.isFinite(n)) return { ok: false, message: `Error: Invalid number '${text}'` };
      if (def.min !== undefined && n < def.min) return { ok: false, message: `'${def.label}' must be at least ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, message: `'${def.label}' must be at most ${def.max}` };
      return { ok: true, value: n };
    }
    case 'checkbox': {
      const t = text.toLowerCase();
      if (['true', '1', 'on', 'yes', 'enabled'].includes(t)) return { ok: true, value: true };
      if (['false', '0', 'off', 'no', 'disabled'].includes(t)) return { ok: true, value: false };
      return { ok: false, message: `Invalid value '${text}' for '${def.label}'. Valid values: true, false.` };
    }
    case 'time':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(text)
        ? { ok: true, value: text }
        : { ok: false, message: `Invalid time '${text}' for '${def.label}'. Use HH:MM.` };
    case 'slot': {
      const parts = text.split(',').map((p) => p.trim());
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      const hasPriority = Boolean(def.slotPriorities?.length);
      const expected = hasPriority ? 4 : 3;
      if (parts.length !== expected || !time.test(parts[0]) || !time.test(parts[1])) {
        return {
          ok: false,
          message: `Invalid slot '${text}' for '${def.label}'. Use ${hasPriority ? 'HH:MM,HH:MM,<priority>,true|false' : 'HH:MM,HH:MM,true|false'}.`,
        };
      }
      if (hasPriority) {
        const p = def.slotPriorities!.find((o) => o.toLowerCase() === parts[2].toLowerCase());
        if (!p) return { ok: false, message: `Invalid priority '${parts[2]}'. Valid values: ${def.slotPriorities!.join(', ')}` };
        parts[2] = p;
      }
      const enabled = parts[expected - 1].toLowerCase();
      if (!['true', 'false'].includes(enabled)) return { ok: false, message: `Slot enabled must be true or false` };
      parts[expected - 1] = enabled;
      return { ok: true, value: parts.join(',') };
    }
  }
}

export const devices = new DeviceManager();
