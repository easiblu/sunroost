import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OFFLINE_GRACE_MS, RETRY_WIFI_MS, decideFallback, hotspotSsid, parseDevices, parseIpAddr, parseWifiList, signalBars,
  splitTerse, validSsid, validWifiPassword, type FallbackInput,
} from '../src/network/parse.ts';

test('splits nmcli terse lines with escaped colons and backslashes', () => {
  assert.deepEqual(splitTerse('My\\:Net:72:WPA2'), ['My:Net', '72', 'WPA2']);
  assert.deepEqual(splitTerse('a\\\\b::x'), ['a\\b', '', 'x']);
});

test('parses the WiFi list: drops hidden, dedupes by strongest, sorts by signal', () => {
  const text = 'Home:40:WPA2\n:90:WPA2\nCafe:75:\nHome:62:WPA2 WPA3\n\n';
  const list = parseWifiList(text);
  assert.deepEqual(list.map((n) => [n.ssid, n.signal]), [['Cafe', 75], ['Home', 62]]);
  assert.equal(list[0].security, '');
  const active = parseWifiList('no:Home:40:WPA2\nyes:Home:38:WPA2\nno:Other:80:WPA2', true);
  assert.equal(active.find((n) => n.ssid === 'Home')?.active, true);
  assert.equal(active[0].ssid, 'Other');
});

test('parses nmcli devices', () => {
  const d = parseDevices('wlan0:wifi:connected:sunroost-wifi\neth0:ethernet:unavailable:\nlo:loopback:connected (externally):lo\n');
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { device: 'wlan0', type: 'wifi', state: 'connected', connection: 'sunroost-wifi' });
});

test('parses ip -j addr into the interface table', () => {
  const json = JSON.stringify([
    { ifname: 'lo', operstate: 'UNKNOWN', addr_info: [{ family: 'inet', local: '127.0.0.1' }] },
    { ifname: 'wlan0', operstate: 'UP', addr_info: [{ family: 'inet', local: '192.168.1.20' }, { family: 'inet6', local: 'fe80::1' }] },
    { ifname: 'eth0', operstate: 'DOWN', addr_info: [] },
    { ifname: 'pan0', operstate: 'DOWN', addr_info: [] },
  ]);
  assert.deepEqual(parseIpAddr(json), [
    { name: 'eth0', addresses: [], up: false },
    { name: 'wlan0', addresses: ['192.168.1.20'], up: true },
  ]);
  assert.deepEqual(parseIpAddr('not json'), []);
});

test('signal bars and validation', () => {
  assert.equal(signalBars(0), 0);
  assert.equal(signalBars(5), 1);
  assert.equal(signalBars(50), 3);
  assert.equal(signalBars(100), 6);
  assert.ok(validWifiPassword(''));
  assert.ok(!validWifiPassword('short'));
  assert.ok(validWifiPassword('longenough'));
  assert.ok(validWifiPassword('a'.repeat(63)));
  assert.ok(!validWifiPassword('z'.repeat(64)));
  assert.ok(validWifiPassword('ab'.repeat(32)));
  assert.ok(validSsid('Home'));
  assert.ok(!validSsid(''));
  assert.ok(!validSsid('x'.repeat(33)));
  assert.equal(hotspotSsid('  '), 'Sunroost');
  assert.equal(Buffer.byteLength(hotspotSsid('é'.repeat(40))), 32);
});

const base: FallbackInput = {
  now: 1_000_000, connected: true, ethernet: false, hotspotActive: false, manual: false, autoEnabled: true,
  hasSavedWifi: true, offlineSince: null, hotspotSince: null,
};

test('hotspot fallback starts only after 2 minutes offline', () => {
  assert.equal(decideFallback(base), 'none');
  assert.equal(decideFallback({ ...base, connected: false, offlineSince: base.now - OFFLINE_GRACE_MS + 1000 }), 'none');
  assert.equal(decideFallback({ ...base, connected: false, offlineSince: base.now - OFFLINE_GRACE_MS }), 'start-hotspot');
  assert.equal(decideFallback({ ...base, connected: false, autoEnabled: false, offlineSince: 0 }), 'none');
});

test('hotspot stops on Ethernet, retries WiFi periodically, and respects manual mode', () => {
  const hs = { ...base, connected: false, hotspotActive: true, hotspotSince: base.now - 1000 };
  assert.equal(decideFallback(hs), 'none');
  assert.equal(decideFallback({ ...hs, ethernet: true, connected: true }), 'stop-hotspot');
  assert.equal(decideFallback({ ...hs, hotspotSince: base.now - RETRY_WIFI_MS }), 'retry-wifi');
  assert.equal(decideFallback({ ...hs, hotspotSince: base.now - RETRY_WIFI_MS, hasSavedWifi: false }), 'none');
  assert.equal(decideFallback({ ...hs, manual: true, ethernet: true }), 'none');
  assert.equal(decideFallback({ ...hs, autoEnabled: false }), 'stop-hotspot');
});
