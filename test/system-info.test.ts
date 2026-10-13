import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countUnderVoltage, isRootHub, parseBoardModel, parseCpuTemp, parseLsusb, parseOsRelease, parseThrottled, tailLines,
} from '../src/system/info.ts';

test('parses CPU temperature from sysfs', () => {
  assert.equal(parseCpuTemp('48312\n'), 48.3);
  assert.equal(parseCpuTemp('52'), 52);
  assert.equal(parseCpuTemp(''), null);
  assert.equal(parseCpuTemp('garbage'), null);
});

test('parses board model and os-release', () => {
  assert.equal(parseBoardModel('Raspberry Pi 4 Model B Rev 1.4\0'), 'Raspberry Pi 4 Model B Rev 1.4');
  assert.equal(parseBoardModel('\0'), null);
  assert.equal(parseOsRelease('NAME="Debian"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'), 'Debian GNU/Linux 12 (bookworm)');
  assert.equal(parseOsRelease('PRETTY_NAME=Alpine\n'), 'Alpine');
  assert.equal(parseOsRelease('NAME=x'), null);
});

test('decodes vcgencmd get_throttled flags', () => {
  const t = parseThrottled('throttled=0x50005\n')!;
  assert.equal(t.underVoltageNow, true);
  assert.equal(t.throttledNow, true);
  assert.equal(t.frequencyCappedNow, false);
  assert.equal(t.underVoltageOccurred, true);
  assert.equal(t.throttledOccurred, true);
  assert.equal(parseThrottled('throttled=0x0')!.underVoltageOccurred, false);
  assert.equal(parseThrottled('error'), null);
});

test('counts under-voltage events in dmesg', () => {
  const log = `[    5.1] hwmon hwmon1: Undervoltage detected!\n[    9.2] usb 1-1.3: new device\n[   12.0] Under-voltage detected! (0x00050005)\n`;
  assert.equal(countUnderVoltage(log), 2);
  assert.equal(countUnderVoltage(''), 0);
});

test('parses lsusb output and spots root hubs', () => {
  const list = parseLsusb(`Bus 001 Device 003: ID 1a86:7523 QinHeng Electronics CH340 serial converter
Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub
garbage line`);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { bus: '001', device: '003', id: '1a86:7523', name: 'QinHeng Electronics CH340 serial converter' });
  assert.equal(isRootHub(list[0]), false);
  assert.equal(isRootHub(list[1]), true);
});

test('tails the kernel log newest first', () => {
  assert.deepEqual(tailLines('a\nb\n\nc\n', 2), ['c', 'b']);
});

test('settings.seed: first-run values for unset keys only', async () => {
  const { settings } = await import('../src/core/settings.ts');
  const { openDb } = await import('../src/core/db.ts');
  openDb(':memory:');
  settings.init();
  settings.set('site.name', 'Kept');
  settings.seed({ 'inverter.driver_id': '', 'site.name': 'Ignored', 'not.a.key': 1, 'inverter.poll_interval_ms': 'wrong type' });
  assert.equal(settings.get('inverter.driver_id'), '');
  assert.equal(settings.get('site.name'), 'Kept');
  assert.equal(typeof settings.get('inverter.poll_interval_ms'), 'number');
});
