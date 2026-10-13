import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { connectAsync, type MqttClient } from 'mqtt';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import { devices } from '../src/devices/manager.ts';
import * as mqtt from '../src/mqtt/index.ts';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Every message received so far, per topic (retained ones arrive right after subscribing). */
const seen = new Map<string, string>();

/** Resolves with the latest (or next) message on `topic` that satisfies `pred`. */
function waitFor(client: MqttClient, topic: string, pred: (v: string) => boolean = () => true, ms = 8000, fresh = false) {
  return new Promise<string>((resolve, reject) => {
    if (!fresh && seen.has(topic) && pred(seen.get(topic)!)) return resolve(seen.get(topic)!);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${topic}`)), ms);
    const on = (t: string, p: Buffer) => {
      if (t === topic && pred(p.toString())) {
        clearTimeout(timer);
        client.off('message', on);
        resolve(p.toString());
      }
    };
    client.on('message', on);
  });
}

let port = 0;
before(async () => {
  openDb(':memory:');
  settings.init();
  port = await freePort();
  settings.setMany({
    'mqtt.port': port,
    mqtt_allow_update: true,
    'inverter.driver_id': 'simulator',
    'inverter.poll_interval_ms': 500,
    mqtt_username: 'ha',
  });
  // settings.set bypasses the API, which is fine for the password here.
  settings.set('mqtt_password', 'secret1');
  await mqtt.start({ host: '127.0.0.1' });
  await devices.start();
});

after(async () => {
  await devices.stop();
  await mqtt.stop();
});

test('built-in broker: auth, state topics, discovery and a /set command', async () => {
  const url = `mqtt://127.0.0.1:${port}`;
  await assert.rejects(connectAsync(url, { username: 'ha', password: 'wrong', reconnectPeriod: 0 }));

  const client = await connectAsync(url, { username: 'ha', password: 'secret1', reconnectPeriod: 0 });
  try {
    assert.equal(mqtt.status().clients, 1);
    client.on('message', (t, p) => seen.set(t, p.toString()));
    await client.subscribeAsync(['sunroost/#', 'homeassistant/#']);
    const pv = await waitFor(client, 'sunroost/inverter_1/pv_power/state');
    assert.match(pv, /^-?\d+(\.\d+)?$/);
    assert.equal(await waitFor(client, 'sunroost/status'), 'online');
    const disc = JSON.parse(await waitFor(client, 'homeassistant/sensor/sr_inverter_1_pv_power/config'));
    assert.equal(disc.state_topic, 'sunroost/inverter_1/pv_power/state');
    await waitFor(client, 'sunroost/inverter_1/buzzer/state');

    const response = waitFor(client, 'sunroost/set/response_message/state', undefined, 8000, true);
    const state = waitFor(client, 'sunroost/inverter_1/buzzer/state', (v) => v === 'true');
    await client.publishAsync('sunroost/inverter_1/buzzer/set', 'true');
    assert.equal(await response, "Set 'Buzzer' to 'true'");
    assert.equal(await state, 'true');

    const err = waitFor(client, 'sunroost/set/response_message/state', undefined, 8000, true);
    await client.publishAsync('sunroost/inverter_1/no_such/set', '1');
    assert.equal(await err, 'Error: invalid setting: no_such');

    const st = mqtt.status();
    assert.equal(st.running, true);
    assert.equal(st.broker, 'builtin');
    assert.ok(st.topicCount > 10);
    assert.ok(mqtt.topics().some((t) => t.topic === 'sunroost/inverter_1/pv_power/state'));
    assert.equal(JSON.stringify(st).includes('secret1'), false);
  } finally {
    await client.endAsync();
  }

  // Stopping via the setting tears the broker down.
  settings.set('publish_mqtt', false);
  await mqtt.apply();
  assert.equal(mqtt.status().running, false);
  await assert.rejects(connectAsync(url, { username: 'ha', password: 'secret1', reconnectPeriod: 0, connectTimeout: 1000 }));
});
