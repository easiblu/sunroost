import * as acme from 'acme-client';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { backoffDelay, CertStore, needsRenewal, removeChallenge, setChallenge } from '../src/remote/domain/acme.ts';
import { checkDdnsAnswer, ddnsUrl, duckSubdomain, updateDdns } from '../src/remote/domain/ddns.ts';
import { compareDns } from '../src/remote/domain/dns.ts';
import { detectCgnat, isLanAddress, splitDomain } from '../src/remote/domain/net.ts';
import { createHttpsProxy, listen } from '../src/remote/domain/proxy.ts';
import { detectPublicIp } from '../src/remote/domain/publicip.ts';
import {
  buildMSearch, buildSoapEnvelope, getExternalIp, lanIpFor, onlyPermanentLeases, parseDeviceDescription, parseSoapResponse,
  parseSsdpResponse, soapCall, UpnpError, type Gateway,
} from '../src/remote/domain/upnp.ts';
import { register as registerAcme } from '../src/web/api/acme.ts';
import { isBanned, isBlocked, loginLockout, recordLockedAttempt, recordLoginFailure, resetBans } from '../src/web/auth.ts';

type Call = { url: string; init?: RequestInit };
/** A fetch stand-in that records calls and answers from a handler. */
function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: string | object }) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

// ---------- UPnP ----------

const SSDP_REPLY = [
  'HTTP/1.1 200 OK',
  'CACHE-CONTROL: max-age=120',
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'USN: uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'EXT:',
  'SERVER: Linux/3.4 UPnP/1.0 MiniUPnPd/2.1',
  'Location: http://192.168.1.1:5000/rootDesc.xml',
  '',
  '',
].join('\r\n');

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Home Router &amp; Wi-Fi</friendlyName>
    <serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
      <controlURL>/ctl/L3F</controlURL>
    </service></serviceList>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
            <controlURL>/ctl/PPPConn</controlURL>
          </service>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
            <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
            <controlURL>/ctl/IPConn</controlURL>
          </service>
        </serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>`;

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const GW: Gateway = { location: 'http://192.168.1.1:5000/rootDesc.xml', name: 'Router', serviceType: SERVICE, controlUrl: 'http://192.168.1.1:5000/ctl/IPConn' };

const FAULT = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>
<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError>
</detail></s:Fault></s:Body></s:Envelope>`;

const EXT_IP = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:GetExternalIPAddressResponse xmlns:u="${SERVICE}"><NewExternalIPAddress>100.72.10.5</NewExternalIPAddress></u:GetExternalIPAddressResponse>
</s:Body></s:Envelope>`;

describe('UPnP', () => {
  test('M-SEARCH and SSDP response parsing', () => {
    const m = buildMSearch('urn:schemas-upnp-org:device:InternetGatewayDevice:2');
    assert.match(m, /^M-SEARCH \* HTTP\/1\.1\r\nHOST: 239\.255\.255\.250:1900\r\n/);
    assert.match(m, /MAN: "ssdp:discover"/);
    assert.ok(m.endsWith('\r\n\r\n'));
    assert.deepEqual(parseSsdpResponse(SSDP_REPLY), {
      location: 'http://192.168.1.1:5000/rootDesc.xml',
      st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      server: 'Linux/3.4 UPnP/1.0 MiniUPnPd/2.1',
    });
    assert.equal(parseSsdpResponse('NOTIFY * HTTP/1.1\r\nLOCATION: http://x/\r\n\r\n'), null);
    assert.equal(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n'), null);
  });

  test('device description: prefers WANIPConnection and resolves the control URL', () => {
    const gw = parseDeviceDescription(DESC, 'http://192.168.1.1:5000/rootDesc.xml');
    assert.deepEqual(gw, {
      location: 'http://192.168.1.1:5000/rootDesc.xml',
      name: 'Home Router & Wi-Fi',
      serviceType: SERVICE,
      controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
    });
    const ppp = parseDeviceDescription(DESC.replace(/<service>\s*<serviceType>urn:schemas-upnp-org:service:WANIPConnection[\s\S]*?<\/service>/, ''), 'http://10.0.0.1/d.xml');
    assert.equal(ppp?.serviceType, 'urn:schemas-upnp-org:service:WANPPPConnection:1');
    assert.equal(ppp?.controlUrl, 'http://10.0.0.1/ctl/PPPConn');
    // URLBase wins over the location.
    const based = parseDeviceDescription(DESC.replace('<specVersion>', '<URLBase>http://192.168.1.254:49000</URLBase><specVersion>'), 'http://192.168.1.1/x.xml');
    assert.equal(based?.controlUrl, 'http://192.168.1.254:49000/ctl/IPConn');
    assert.equal(parseDeviceDescription('<root><device></device></root>', 'http://x/'), null);
  });

  test('SOAP envelope building escapes arguments', () => {
    const xml = buildSoapEnvelope(SERVICE, 'AddPortMapping', [['NewExternalPort', 443], ['NewPortMappingDescription', 'Sunroost <&>']]);
    assert.match(xml, /<s:Envelope xmlns:s="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
    assert.match(xml, new RegExp(`<u:AddPortMapping xmlns:u="${SERVICE}"><NewExternalPort>443</NewExternalPort><NewPortMappingDescription>Sunroost &lt;&amp;&gt;</NewPortMappingDescription></u:AddPortMapping>`));
  });

  test('SOAP response and fault parsing', () => {
    assert.deepEqual(parseSoapResponse(EXT_IP, 'GetExternalIPAddress'), { NewExternalIPAddress: '100.72.10.5' });
    assert.throws(() => parseSoapResponse(FAULT, 'AddPortMapping'), (err: unknown) => {
      assert.ok(err instanceof UpnpError);
      assert.equal(err.code, 725);
      assert.match(err.message, /OnlyPermanentLeasesSupported \(UPnP error 725\)/);
      assert.ok(onlyPermanentLeases(err));
      return true;
    });
  });

  test('SOAP calls send the action header and surface HTTP 500 faults', async () => {
    const { fn, calls } = mockFetch((_url, init) =>
      String((init?.headers as Record<string, string>).soapaction).includes('GetExternalIPAddress') ? { body: EXT_IP } : { status: 500, body: FAULT },
    );
    assert.equal(await getExternalIp(GW, fn), '100.72.10.5');
    assert.equal((calls[0].init?.headers as Record<string, string>).soapaction, `"${SERVICE}#GetExternalIPAddress"`);
    await assert.rejects(soapCall(GW, 'AddPortMapping', [], fn), /UPnP error 725/);
  });

  test('LAN IP is the interface on the router subnet', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null }],
      en1: [{ address: '10.8.0.2', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
      en0: [{ address: '192.168.1.131', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
    assert.equal(lanIpFor('192.168.1.1', ifaces), '192.168.1.131');
    assert.equal(lanIpFor('172.20.0.1', ifaces), null);
  });
});

// ---------- CGNAT, DNS, public IP ----------

test('CGNAT detection rules', () => {
  assert.deepEqual(detectCgnat(null, '203.0.113.9'), { cgnat: null, reason: null });
  assert.equal(detectCgnat('0.0.0.0', '203.0.113.9').cgnat, null);
  assert.equal(detectCgnat('203.0.113.9', '203.0.113.9').cgnat, false);
  const shared = detectCgnat('100.72.10.5', '203.0.113.9');
  assert.equal(shared.cgnat, true);
  assert.match(shared.reason!, /carrier-grade/);
  assert.equal(detectCgnat('100.127.255.254', null).cgnat, true);
  assert.equal(detectCgnat('100.128.0.1', '100.128.0.1').cgnat, false);
  assert.match(detectCgnat('192.168.0.10', '203.0.113.9').reason!, /private address/);
  assert.match(detectCgnat('198.51.100.4', '203.0.113.9').reason!, /another NAT/);
});

test('DNS comparison', () => {
  assert.equal(compareDns([], [], '203.0.113.9').state, 'pending');
  assert.match(compareDns([], ['2001:db8::1'], '203.0.113.9').note!, /only an IPv6/);
  assert.deepEqual(compareDns(['203.0.113.9'], [], '203.0.113.9'), { state: 'ok', seen: ['203.0.113.9'], note: null, error: null });
  assert.equal(compareDns(['198.51.100.1'], [], '203.0.113.9').state, 'mismatch');
  const extra = compareDns(['203.0.113.9', '198.51.100.1'], [], '203.0.113.9');
  assert.equal(extra.state, 'mismatch');
  assert.match(extra.note!, /198\.51\.100\.1/);
  const v6 = compareDns(['203.0.113.9'], ['2001:db8::1'], '203.0.113.9');
  assert.equal(v6.state, 'ok');
  assert.match(v6.note!, /AAAA/);
  assert.equal(compareDns(['203.0.113.9'], [], null).state, 'unknown');
});

test('public IP falls back through the services', async () => {
  const { fn, calls } = mockFetch((url) =>
    url.includes('ipify') ? { status: 503, body: 'down' } : url.includes('icanhazip') ? { body: '2001:db8::1\n' } : url.includes('ifconfig') ? { body: '' } : { body: 'fl=1\nh=1.1.1.1\nip=203.0.113.9\nts=1\n' },
  );
  assert.deepEqual(await detectPublicIp(fn), { ip: '203.0.113.9', source: '1.1.1.1' });
  assert.equal(calls.length, 4);
  const fail = mockFetch(() => ({ status: 500, body: '' }));
  await assert.rejects(detectPublicIp(fail.fn), /Couldn't detect the public IP/);
});

test('record name and LAN address helpers', () => {
  assert.deepEqual(splitDomain('solar.example.com'), { root: 'example.com', name: 'solar' });
  assert.deepEqual(splitDomain('example.com'), { root: 'example.com', name: '@' });
  assert.deepEqual(splitDomain('home.solar.example.co.za'), { root: 'example.co.za', name: 'home.solar' });
  assert.deepEqual(splitDomain('example.co.uk'), { root: 'example.co.uk', name: '@' });
  for (const ip of ['192.168.1.5', '10.1.2.3', '172.31.0.1', '127.0.0.1', '::1', '::ffff:192.168.0.2', 'fd00::1', 'fe80::1']) assert.ok(isLanAddress(ip), ip);
  for (const ip of ['203.0.113.9', '100.64.0.1', '172.32.0.1', '2001:db8::1', '']) assert.ok(!isLanAddress(ip), ip);
});

// ---------- Dynamic DNS ----------

describe('dynamic DNS', () => {
  test('DuckDNS', async () => {
    assert.equal(duckSubdomain('solar.duckdns.org'), 'solar');
    assert.equal(duckSubdomain('solar.example.com'), null);
    assert.equal(ddnsUrl('duckdns', 'tok', 'solar.duckdns.org', '203.0.113.9'), 'https://www.duckdns.org/update?domains=solar&token=tok&ip=203.0.113.9');
    const ok = mockFetch(() => ({ body: 'OK' }));
    assert.equal(await updateDdns('duckdns', 'tok', 'solar.duckdns.org', '203.0.113.9', ok.fn), 'updated');
    const ko = mockFetch(() => ({ body: 'KO' }));
    await assert.rejects(updateDdns('duckdns', 'tok', 'solar.duckdns.org', '203.0.113.9', ko.fn), /DuckDNS rejected/);
    await assert.rejects(updateDdns('duckdns', 'tok', 'solar.example.com', '203.0.113.9', ok.fn), /duckdns\.org/);
  });

  test('Namecheap', async () => {
    assert.equal(
      ddnsUrl('namecheap', 'p@ss', 'solar.example.com', '203.0.113.9'),
      'https://dynamicdns.park-your-domain.com/update?host=solar&domain=example.com&password=p%40ss&ip=203.0.113.9',
    );
    assert.match(ddnsUrl('namecheap', 'x', 'example.com', '1.2.3.4'), /host=%40&domain=example\.com/);
    assert.doesNotThrow(() => checkDdnsAnswer('namecheap', 200, '<interface-response><ErrCount>0</ErrCount></interface-response>'));
    const bad = mockFetch(() => ({ body: '<interface-response><ErrCount>1</ErrCount><errors><Err1>Passwords do not match</Err1></errors></interface-response>' }));
    await assert.rejects(updateDdns('namecheap', 'secret-pw', 'solar.example.com', '1.2.3.4', bad.fn), /Namecheap: Passwords do not match/);
  });

  test('custom URL with placeholders', async () => {
    assert.equal(ddnsUrl('url', 'https://dyn.example.net/u?h={domain}&a={ip}', 'solar.example.com', '1.2.3.4'), 'https://dyn.example.net/u?h=solar.example.com&a=1.2.3.4');
    assert.throws(() => ddnsUrl('url', 'ftp://x', 'a.b', '1.2.3.4'), /https/);
    const { fn, calls } = mockFetch(() => ({ body: 'good' }));
    await updateDdns('url', 'https://dyn.example.net/{ip}', 'solar.example.com', '1.2.3.4', fn);
    assert.equal(calls[0].url, 'https://dyn.example.net/1.2.3.4');
  });

  test('Cloudflare: finds the zone by suffix and creates or patches the A record', async () => {
    const zone = { id: 'z1', name: 'example.com' };
    const ok = (result: unknown) => ({ body: { success: true, result, errors: [] } });
    let records: { id: string; content: string }[] = [];
    const { fn, calls } = mockFetch((url, init) => {
      if (url.includes('/zones?name=')) return ok(url.endsWith('name=example.com') ? [zone] : []);
      if (url.includes('/dns_records?type=A')) return ok(records);
      if (init?.method === 'POST' || init?.method === 'PATCH') return ok({ id: 'r1' });
      return { status: 404, body: { success: false, errors: [{ message: 'nope' }] } };
    });
    assert.equal(await updateDdns('cloudflare', 'cf-token', 'solar.example.com', '203.0.113.9', fn), 'created');
    assert.deepEqual(calls.slice(0, 3).map((c) => c.url), [
      'https://api.cloudflare.com/client/v4/zones?name=solar.example.com',
      'https://api.cloudflare.com/client/v4/zones?name=example.com',
      'https://api.cloudflare.com/client/v4/zones/z1/dns_records?type=A&name=solar.example.com',
    ]);
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer cf-token');
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { type: 'A', name: 'solar.example.com', content: '203.0.113.9', ttl: 1, proxied: false, comment: 'Sunroost dynamic DNS' });

    records = [{ id: 'r9', content: '198.51.100.1' }];
    calls.length = 0;
    assert.equal(await updateDdns('cloudflare', 'cf-token', 'solar.example.com', '203.0.113.9', fn), 'updated');
    assert.equal(calls.at(-1)!.url, 'https://api.cloudflare.com/client/v4/zones/z1/dns_records/r9');
    assert.equal(calls.at(-1)!.init?.method, 'PATCH');
    records = [{ id: 'r9', content: '203.0.113.9' }];
    assert.equal(await updateDdns('cloudflare', 'cf-token', 'solar.example.com', '203.0.113.9', fn), 'unchanged');

    const denied = mockFetch(() => ({ status: 403, body: { success: false, errors: [{ message: 'Invalid API Token' }] } }));
    await assert.rejects(updateDdns('cloudflare', 'cf-token', 'solar.example.com', '1.2.3.4', denied.fn), /Cloudflare: Invalid API Token/);
  });

  test('errors never contain the token', async () => {
    const { fn } = mockFetch(() => {
      throw new Error('failed to reach https://www.duckdns.org/update?token=super-secret-123');
    });
    await assert.rejects(updateDdns('duckdns', 'super-secret-123', 'solar.duckdns.org', '1.2.3.4', fn), (err: Error) => {
      assert.ok(!err.message.includes('super-secret-123'));
      return true;
    });
  });
});

// ---------- Sign-in ban ----------

test('24 h ban after 20 failed sign-ins within an hour, LAN exempt', () => {
  resetBans();
  const wan = '203.0.113.50';
  const lan = '192.168.1.77';
  for (let i = 0; i < 19; i++) {
    recordLoginFailure(wan);
    recordLoginFailure(lan);
  }
  assert.equal(isBanned(wan), false);
  assert.ok(loginLockout(wan) > 0, 'the regular rate limit applies first');
  // Attempts refused by the rate limit still count.
  recordLockedAttempt(wan);
  recordLoginFailure(lan);
  assert.equal(isBanned(wan), true);
  assert.equal(isBlocked(wan), true);
  assert.equal(isBlocked(wan, Date.now() + 23 * 3600_000), true);
  assert.equal(isBlocked(wan, Date.now() + 24 * 3600_000 + 1000), false);
  // A LAN address is recorded as banned but never blocked.
  assert.equal(isBanned(lan), true);
  assert.equal(isBlocked(lan), false);
  resetBans();
});

// ---------- HTTPS reverse proxy ----------

describe('HTTPS reverse proxy', () => {
  let upstream: HttpServer;
  let upstreamPort = 0;
  let proxy: import('node:https').Server;
  let proxyPort = 0;
  let pem: { key: Buffer; cert: Buffer };
  const upgraded = new Set<import('node:stream').Duplex>();

  async function selfSigned(name: string) {
    const authz = { identifier: { type: 'dns', value: name } } as unknown as acme.Authorization;
    const [key, cert] = await acme.crypto.createAlpnCertificate(authz, 'test', await acme.crypto.createPrivateEcdsaKey());
    return { key, cert };
  }

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('set-cookie', ['a=1', 'b=2']);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      });
    });
    upstream.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `X-Seen-For: ${req.headers['x-forwarded-for']}\r\nX-Seen-Proto: ${req.headers['x-forwarded-proto']}\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`,
      );
      socket.on('data', (d) => socket.write(`echo:${d}`));
      socket.on('end', () => socket.destroy());
      upgraded.add(socket);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as { port: number }).port;
    pem = await selfSigned('localhost');
    proxy = createHttpsProxy(pem, upstreamPort);
    await listen(proxy, 0, '127.0.0.1');
    proxyPort = (proxy.address() as { port: number }).port;
  });

  after(async () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    for (const s of upgraded) s.destroy();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });

  /** Raw HTTPS exchange (self-signed cert): sends `request`, returns everything read until `until` matches or close. */
  function exchange(request: string, until?: RegExp, after?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = tlsConnect({ host: '127.0.0.1', port: proxyPort, rejectUnauthorized: false, servername: 'localhost' }, () => sock.write(request));
      let data = '';
      let sentAfter = false;
      sock.on('data', (d) => {
        data += d;
        if (after && !sentAfter && /\r\n\r\n/.test(data)) {
          sentAfter = true;
          sock.write(after);
        }
        if (until?.test(data)) {
          sock.destroy();
          resolve(data);
        }
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
  }

  test('forwards method, path, body and Host, replaces client X-Forwarded-*', async () => {
    const body = 'hello=1';
    const res = await exchange(
      `POST /api/x?y=1 HTTP/1.1\r\nHost: solar.example.com\r\nX-Forwarded-For: 192.168.1.2\r\nX-Forwarded-Proto: http\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    );
    assert.match(res, /^HTTP\/1\.1 200/);
    // Multiple Set-Cookie headers survive.
    assert.match(res, /set-cookie: a=1\r\nset-cookie: b=2/i);
    const json = JSON.parse(res.slice(res.indexOf('\r\n\r\n') + 4));
    assert.equal(json.method, 'POST');
    assert.equal(json.url, '/api/x?y=1');
    assert.equal(json.body, body);
    assert.equal(json.headers.host, 'solar.example.com');
    assert.equal(json.headers['x-forwarded-for'], '127.0.0.1', 'the spoofed LAN address is replaced');
    assert.equal(json.headers['x-forwarded-proto'], 'https');
    assert.equal(json.headers['x-forwarded-host'], 'solar.example.com');
  });

  test('WebSocket upgrade is piped both ways with forwarded headers', async () => {
    const res = await exchange(
      'GET /ws HTTP/1.1\r\nHost: solar.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      /echo:ping/,
      'ping',
    );
    assert.match(res, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(res, /X-Seen-For: 127\.0\.0\.1/);
    assert.match(res, /X-Seen-Proto: https/);
    assert.match(res, /X-Seen-Host: solar\.example\.com/);
    assert.match(res, /echo:ping/);
  });

  test('certificates hot-swap with setSecureContext', async () => {
    const next = await selfSigned('solar.example.com');
    proxy.setSecureContext({ key: next.key, cert: next.cert });
    const cn = await new Promise<string>((resolve, reject) => {
      const sock = tlsConnect({ host: '127.0.0.1', port: proxyPort, rejectUnauthorized: false, servername: 'solar.example.com' }, () => {
        resolve(String(sock.getPeerCertificate().subject.CN));
        sock.destroy();
      });
      sock.on('error', reject);
    });
    assert.equal(cn, 'solar.example.com');
  });

  test('502 when the app is down', async () => {
    const dead = createHttpsProxy(pem, 1);
    await listen(dead, 0, '127.0.0.1');
    const port = (dead.address() as { port: number }).port;
    const res = await new Promise<string>((resolve, reject) => {
      const sock = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let d = '';
      sock.on('data', (c) => (d += c));
      sock.on('end', () => resolve(d));
      sock.on('error', reject);
    });
    assert.match(res, /^HTTP\/1\.1 502/);
    await new Promise((r) => dead.close(r));
  });
});

// ---------- ACME ----------

describe('ACME', () => {
  test('challenge route serves tokens as plain text, 404 otherwise', async () => {
    const app = Fastify();
    await registerAcme(app);
    setChallenge('tok_123-abc', 'tok_123-abc.thumbprint');
    const hit = await app.inject('/.well-known/acme-challenge/tok_123-abc');
    assert.equal(hit.statusCode, 200);
    assert.equal(hit.body, 'tok_123-abc.thumbprint');
    assert.match(String(hit.headers['content-type']), /text\/plain/);
    removeChallenge('tok_123-abc');
    assert.equal((await app.inject('/.well-known/acme-challenge/tok_123-abc')).statusCode, 404);
    assert.equal((await app.inject('/.well-known/acme-challenge/..%2Fetc')).statusCode, 404);
    setChallenge('short', 'v', -1);
    assert.equal((await app.inject('/.well-known/acme-challenge/short')).statusCode, 404, 'expired');
    await app.close();
  });

  test('certificate store: 0600 files, info, renewal and back-off rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solar-acme-'));
    const store = new CertStore(dir);
    assert.equal(store.load(), null);
    const key = await store.accountKey();
    assert.equal(await store.accountKey(), key, 'account key is reused');
    const authz = { identifier: { type: 'dns', value: 'solar.example.com' } } as unknown as acme.Authorization;
    const [certKey, cert] = await acme.crypto.createAlpnCertificate(authz, 'x', await acme.crypto.createPrivateEcdsaKey());
    store.save(certKey.toString(), cert.toString());
    for (const f of ['account.key', 'key.pem', 'cert.pem']) assert.equal(statSync(join(dir, 'acme', f)).mode & 0o777, 0o600, f);
    const info = store.load()!;
    assert.deepEqual(info.domains, ['solar.example.com']);
    assert.equal(needsRenewal(info, 'solar.example.com'), true, 'expires now');
    assert.equal(needsRenewal({ ...info, expires: Date.now() + 60 * 864e5 }, 'solar.example.com'), false);
    assert.equal(needsRenewal({ ...info, expires: Date.now() + 60 * 864e5 }, 'other.example.com'), true);
    assert.equal(needsRenewal(null, 'solar.example.com'), true);
    assert.equal(backoffDelay(1), 3600_000);
    assert.equal(backoffDelay(3), 4 * 3600_000);
    assert.equal(backoffDelay(10), 24 * 3600_000);
    store.saveBackoff({ failures: 2, nextAttemptAt: 123, lastError: 'x' });
    assert.deepEqual(store.loadBackoff(), { failures: 2, nextAttemptAt: 123, lastError: 'x' });
  });
});
