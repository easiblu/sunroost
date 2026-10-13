import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/core/db.ts';
import { settings } from '../src/core/settings.ts';
import * as remote from '../src/remote/index.ts';
import { hashPassword, loginLockout, recordLoginFailure, recordLoginSuccess } from '../src/web/auth.ts';

const token = Buffer.from(JSON.stringify({ a: 'account', t: 'tunnel-id', s: 'secret' })).toString('base64');

before(() => {
  openDb(':memory:');
  settings.init();
});

after(() => remote.stop());

test('tunnel token validation', () => {
  assert.equal(remote.isTunnelToken(token), true);
  assert.equal(remote.isTunnelToken('not-a-token'), false);
  assert.equal(remote.isTunnelToken(Buffer.from('{"a":"x"}').toString('base64')), false);
});

test('domain normalization', () => {
  assert.equal(remote.normalizeDomain('https://Solar.Example.com/dashboard'), 'solar.example.com');
  assert.equal(remote.normalizeDomain('solar.example.co.uk:443'), 'solar.example.co.uk');
  assert.equal(remote.normalizeDomain('localhost'), '');
  assert.equal(remote.normalizeDomain('bad domain.com'), '');
  assert.equal(remote.normalizeDomain('-x.example.com'), '');
});

test('sign-in rate limiting kicks in after 5 failures and clears on success', () => {
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) recordLoginFailure(ip);
  assert.equal(loginLockout(ip), 0);
  recordLoginFailure(ip);
  assert.ok(loginLockout(ip) > 25_000);
  recordLoginSuccess(ip);
  assert.equal(loginLockout(ip), 0);
});

test('tunnel does not start without a password', async () => {
  settings.setMany({ 'remote.mode': 'cloudflare', 'remote.domain': 'solar.example.com', 'remote.cloudflare_token': token });
  await remote.start(8080);
  await new Promise((r) => setTimeout(r, 100));
  const s = remote.status();
  assert.equal(s.running, false);
  assert.match(s.lastError ?? '', /password/i);
  await remote.stop();
});

test('supervises cloudflared, passes the token via env, and tracks connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solar-cf-'));
  const fake = join(dir, 'cloudflared');
  // Fails loudly unless the token arrives in the environment (never argv).
  writeFileSync(
    fake,
    `#!/bin/sh
case "$*" in *eyJ*) echo "token leaked into argv" >&2; exit 3;; esac
[ -n "$TUNNEL_TOKEN" ] || { echo "ERR missing token" >&2; exit 2; }
echo "2026-10-12T10:00:00Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=1.2.3.4 location=fra08 protocol=quic" >&2
echo "2026-10-12T10:00:00Z INF Registered tunnel connection connIndex=1 connection=def event=0 ip=1.2.3.5 location=ams01 protocol=quic" >&2
sleep 30
`,
  );
  chmodSync(fake, 0o755);
  settings.setMany({ 'auth.password_hash': hashPassword('correct horse battery'), 'remote.cloudflared_path': fake });
  await remote.start(8080);
  for (let i = 0; i < 50 && remote.status().connections.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const s = remote.status();
  assert.equal(s.running, true);
  assert.deepEqual(s.connections.sort(), ['ams01', 'fra08']);
  assert.equal(s.publicUrl, 'https://solar.example.com');
  await remote.stop();
  assert.equal(remote.status().running, false);
});
