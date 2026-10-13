/** How smart-home MQTT clients reach Sunroost's broker: the built-in one on this machine, or the external one. */
import { settings, type SettingKey } from '../../../core/settings.ts';
import * as mqtt from '../../../mqtt/index.ts';

/** Settings that change where or how to connect. */
export const BROKER_KEYS: SettingKey[] = ['publish_mqtt', 'mqtt.broker', 'mqtt.port', 'mqtt.url', 'mqtt_username', 'mqtt_password', 'mqtt_prefix'];

export type BrokerTarget =
  | { ok: true; url: string; username?: string; password?: string }
  | { ok: false; reason: 'off' | 'error'; message: string };

export function brokerTarget(): BrokerTarget {
  if (!settings.get('publish_mqtt')) {
    return { ok: false, reason: 'off', message: 'MQTT is turned off. Turn it on under Configuration → MQTT to use MQTT devices.' };
  }
  const creds = { username: settings.get('mqtt_username') || undefined, password: settings.get('mqtt_password') || undefined };
  if (settings.get('mqtt.broker') === 'external') {
    const url = settings.get('mqtt.url').trim();
    return url ? { ok: true, url, ...creds } : { ok: false, reason: 'error', message: 'No external broker URL is configured.' };
  }
  // If the built-in broker failed (port taken), whatever holds the port is not ours: don't connect to it.
  const st = mqtt.status();
  if (!st.connected) {
    return { ok: false, reason: 'error', message: `Sunroost's MQTT broker is not running${st.lastError ? `: ${st.lastError}` : ''}.` };
  }
  return { ok: true, url: `mqtt://127.0.0.1:${st.port}`, ...creds };
}
