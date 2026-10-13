import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as notify from '../src/automation/notify.ts';
import { openDb } from '../src/core/db.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  notify.setFetch((async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch);
  return calls;
}

const URLS = { ntfy: 'https://ntfy.sh/secret-topic-123', webhook: 'https://hooks.example.com/abc?token=s3cret' };

beforeEach(() => {
  openDb(':memory:');
  notify.initNotifications();
});

afterEach(() => notify.setFetch(null));

describe('notification channels', () => {
  it('app: adds to the feed, emits an event, caps at 200 and tracks unread', async () => {
    const seen: notify.FeedItem[] = [];
    const on = (i: notify.FeedItem) => seen.push(i);
    notify.events.on('notification', on);
    assert.deepEqual(await notify.send('app', 'Grid lost', 'at 10:00', URLS, 1000), { ok: true });
    notify.events.off('notification', on);
    assert.equal(seen[0].title, 'Grid lost');
    for (let i = 0; i < 210; i++) notify.addToFeed('t', `m${i}`, 2000 + i);
    const f = notify.feed(500);
    assert.equal(f.items.length, 200);
    assert.equal(f.items[0].message, 'm209');
    assert.equal(f.unread, 200);
    notify.markAllRead();
    assert.equal(notify.unreadCount(), 0);
    assert.equal(notify.feed(5).items[0].read, true);
  });

  it('ntfy: POSTs the message with a Title header', async () => {
    const calls = mockFetch(() => new Response('ok'));
    assert.deepEqual(await notify.send('ntfy', 'Battery low', 'SOC 15%', URLS), { ok: true });
    assert.equal(calls[0].url, URLS.ntfy);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).Title, 'Battery low');
    assert.equal(calls[0].init.body, 'SOC 15%');
    assert.ok(calls[0].init.signal, 'has a timeout signal');
    await notify.send('ntfy', 'Überhitzt', 'x', URLS);
    assert.match((calls[1].init.headers as Record<string, string>).Title, /^=\?UTF-8\?B\?/);
  });

  it('webhook: POSTs JSON {title, message, ts}', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    assert.deepEqual(await notify.send('webhook', 'T', 'M', URLS, 1234), { ok: true });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { title: 'T', message: 'M', ts: 1234 });
    assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
  });

  it('reports failures without leaking the URL path or token', async () => {
    mockFetch(() => new Response('no', { status: 500 }));
    const r1 = await notify.send('webhook', 'T', 'M', URLS);
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'https://hooks.example.com answered HTTP 500');
    mockFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const r2 = await notify.send('ntfy', 'T', 'M', URLS);
    assert.equal(r2.error, 'Sending to https://ntfy.sh failed: timed out after 10 s');
    assert.doesNotMatch(r2.error!, /secret/);
    assert.match((await notify.send('ntfy', 'T', 'M', { ntfy: '', webhook: '' })).error!, /No ntfy URL configured/);
    assert.match((await notify.send('webhook', 'T', 'M', { ntfy: '', webhook: 'ftp://x' })).error!, /not a valid http/);
  });
});
