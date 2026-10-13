import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtDiskSize, lsusbLines, parseSshMode, parseTimedatectl, sshConfigText } from '../src/system/info.ts';
import { exec } from '../src/system/exec.ts';

test('parses timedatectl show', () => {
  const t = parseTimedatectl('Timezone=Europe/Berlin\nLocalRTC=no\nNTP=yes\nNTPSynchronized=no\n');
  assert.deepEqual(t, { internetTime: true, synchronized: false, timezone: 'Europe/Berlin' });
  assert.deepEqual(parseTimedatectl(''), { internetTime: null, synchronized: null, timezone: null });
});

test('ssh drop-in round trip', () => {
  assert.equal(parseSshMode(sshConfigText('key')), 'key');
  assert.equal(parseSshMode(sshConfigText('key,password')), 'key,password');
  assert.equal(parseSshMode(''), 'key,password');
  assert.match(sshConfigText('key'), /^PasswordAuthentication no$/m);
});

test('lsusb lines and disk size formatting', () => {
  const lines = lsusbLines('Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n\nnoise\nBus 001 Device 003: ID 1a86:7523 QinHeng\n');
  assert.equal(lines.length, 2);
  assert.equal(fmtDiskSize(486 * 1024 ** 3), '486G');
  assert.equal(fmtDiskSize(2.5 * 1024 ** 3), '2.5G');
  assert.equal(fmtDiskSize(512), '512B');
});

test('exec never throws for a missing binary', async () => {
  const r = await exec('definitely-not-a-real-binary-xyz', []);
  assert.equal(r.ok, false);
  const ok = await exec('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hi' });
  assert.equal(ok.stdout, 'hi');
});
