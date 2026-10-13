import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { after, before, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { openDb } from '../src/core/db.ts';
import * as secrets from '../src/core/secrets.ts';
import { settings } from '../src/core/settings.ts';
import * as areas from '../src/home/areas.ts';
import { hostFor } from '../src/home/index.ts';
import { LiteEngine } from '../src/home/lite/index.ts';
import { TuyaDriver } from '../src/home/lite/tuya/index.ts';
import { decodePhase, parseCustom } from '../src/home/lite/tuya/profiles.ts';
import {
  CMD, decodeDiscovery, encodeDiscovery, pack55aa, pack6699, takeFrame, UDP_KEY,
} from '../src/home/lite/tuya/protocol.ts';
import * as registry from '../src/home/registry.ts';
import { callService, setEngineLookup } from '../src/home/services.ts';
import * as states from '../src/home/states.ts';
import { TuyaSim } from './sims/tuya.ts';

const KEY = 'a1b2c3d4e5f6g7h8';
const BAD = 'zzzzzzzzzzzzzzzz';

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function freshDb() {
  openDb(':memory:');
  settings.init();
  secrets.init(null);
  registry.init();
  areas.init();
  states.reset();
}

const st = (id: string) => states.get(id)?.state;
type Form = { type: 'form'; flowId: string; errors: Record<string, string>; fields: { name: string; default?: unknown }[] };

describe('Tuya protocol', () => {
  it('uses the published constants: zlib CRC32 and the UDP key md5("yGAdlopoPVldABfn")', () => {
    assert.equal(crc32('123456789') >>> 0, 0xcbf43926, 'standard CRC-32 check value');
    assert.equal(UDP_KEY.toString('hex'), '6c1ec8e2bb9bb59ab50b0daf649b410a');
  });

  it('frames: 55AA with CRC or HMAC, return codes, length field and suffix', () => {
    const f = pack55aa(7, CMD.HEART_BEAT, Buffer.from('abc'), null);
    assert.equal(f.readUInt32BE(0), 0x000055aa);
    assert.equal(f.readUInt32BE(12), 3 + 8, 'len = payload + CRC + suffix');
    assert.equal(f.readUInt32BE(f.length - 4), 0x0000aa55);
    assert.equal(f.readUInt32BE(f.length - 8), crc32(f.subarray(0, f.length - 8)) >>> 0, 'CRC over header + payload');
    const back = takeFrame(f, { hmacKey: null, gcmKey: null, fromDevice: false })!;
    assert.deepEqual([back.frame.seq, back.frame.cmd, back.frame.payload.toString(), back.frame.retcode], [7, 9, 'abc', null]);

    const key = Buffer.from(KEY);
    const fromDevice = pack55aa(8, CMD.STATUS, Buffer.from('x'), key, 0);
    assert.equal(fromDevice.readUInt32BE(12), 4 + 1 + 36, 'len = retcode + payload + HMAC + suffix');
    const r = takeFrame(Buffer.concat([Buffer.from('noise'), fromDevice, Buffer.from([0, 0])]), { hmacKey: key, gcmKey: null, fromDevice: true })!;
    assert.deepEqual([r.frame.retcode, r.frame.payload.toString(), r.rest.length], [0, 'x', 2], 'garbage skipped, rest kept');
    assert.throws(() => takeFrame(fromDevice, { hmacKey: Buffer.from(BAD), gcmKey: null, fromDevice: true }), /HMAC/);
    assert.equal(takeFrame(f.subarray(0, 10), { hmacKey: null, gcmKey: null, fromDevice: false }), null, 'incomplete');
  });

  it('frames: 6699 with AES-GCM over the header', () => {
    const key = Buffer.from(KEY);
    const f = pack6699(3, CMD.STATUS, Buffer.from('hello'), key);
    assert.equal(f.readUInt32BE(14), 5 + 12 + 16, 'len = iv + ciphertext + tag');
    assert.equal(f.readUInt32BE(f.length - 4), 0x00009966);
    assert.equal(takeFrame(f, { hmacKey: null, gcmKey: key, fromDevice: false })!.frame.payload.toString(), 'hello');
    const tampered = Buffer.from(f);
    tampered[10] ^= 1; // cmd byte is authenticated
    assert.throws(() => takeFrame(tampered, { hmacKey: null, gcmKey: key, fromDevice: false }), /decrypt/);
  });

  it('decodes discovery broadcasts, clear and encrypted', () => {
    const a = { ip: '192.168.1.50', gwId: 'bf1234567890abcdefgh', productKey: 'pk', version: '3.3' };
    assert.deepEqual(decodeDiscovery(encodeDiscovery(a)), { ...a });
    assert.deepEqual(decodeDiscovery(encodeDiscovery(a, true)), { ...a });
    assert.equal(decodeDiscovery(Buffer.from('nonsense nonsense nonsense')), null);
  });

  it('profiles: custom DPs and the breaker phase encoding', () => {
    assert.deepEqual(parseCustom('1:switch\n19:sensor:0.1:W:power\n9:countdown'), [
      { dp: '1', kind: 'switch', name: '', scale: undefined, unit: null },
      { dp: '19', kind: 'sensor', name: 'power', scale: 0.1, unit: 'W' },
      { dp: '9', kind: 'countdown', name: 'dp 9', scale: undefined, unit: null },
    ]);
    assert.throws(() => parseCustom('x:switch'), /Line 1/);
    assert.throws(() => parseCustom('1:light'), /kind/);
    // 230.4 V, 1.234 A, 280 W
    const raw = Buffer.from([0x09, 0x00, 0x00, 0x04, 0xd2, 0x00, 0x01, 0x18]).toString('base64');
    assert.deepEqual(decodePhase(raw), { voltage: 230.4, current: 1.234, power: 280 });
  });
});

describe('Tuya 3.3 energy plug, end to end', () => {
  let sim: TuyaSim;
  let engine: LiteEngine;
  let udp: number;
  const ID = 'bf0123456789abcdefgh';

  before(async () => {
    freshDb();
    sim = new TuyaSim({ version: '3.3', localKey: KEY, deviceId: ID, dps: { '1': false, '9': 0, '17': 12, '18': 512, '19': 1234, '20': 2301 } });
    await sim.start();
    udp = await freeUdpPort();
    engine = new LiteEngine([new TuyaDriver({ port: sim.port, discoveryPorts: [udp], timeoutMs: 1000, heartbeatMs: 200, retryMs: [100] })]);
    await engine.start(hostFor('lite'));
    setEngineLookup((id) => (id === 'lite' ? engine : null));
  });

  after(async () => {
    await engine.stop();
    await sim.stop();
  });

  it('is discovered from its encrypted broadcast; the form is prefilled', async () => {
    await new Promise((r) => setTimeout(r, 100));
    sim.broadcast(udp);
    const [found] = (await until('discovered', () => engine.discovered().then((l) => (l.length ? l : null))))!;
    assert.deepEqual([found.handler, found.title], ['tuya', 'Tuya device at 127.0.0.1']);
    const form = (await engine.flowStep(found.flowId, null)) as Form;
    const dflt = Object.fromEntries(form.fields.map((f) => [f.name, f.default]));
    assert.deepEqual([dflt.host, dflt.device_id, dflt.version], ['127.0.0.1', ID, '3.3']);

    const wrong = (await engine.flowStep(found.flowId, { host: '127.0.0.1', device_id: ID, local_key: BAD, version: '3.3', profile: 'metering' })) as Form;
    assert.match(wrong.errors.local_key, /json obj data unvalid|wrong local key/);
    const mismatch = (await engine.flowStep(found.flowId, { host: '127.0.0.1', device_id: ID, local_key: KEY, version: '3.3', profile: 'custom', custom: '50:switch' })) as Form;
    assert.match(mismatch.errors.profile, /reports: 1, 9, 17, 18, 19, 20/);
    const done = await engine.flowStep(found.flowId, { host: '127.0.0.1', device_id: ID, local_key: KEY, version: '3.3', profile: 'metering' });
    assert.equal(done.type, 'create_entry');
    assert.deepEqual(await engine.discovered(), []);
  });

  it('shows the switch and scaled readings', async () => {
    await until('connected', () => st('switch.tuya_plug_127_0_0_1') === 'off');
    assert.equal(st('sensor.tuya_plug_127_0_0_1_power'), '123.4');
    assert.equal(st('sensor.tuya_plug_127_0_0_1_current'), '0.512');
    assert.equal(st('sensor.tuya_plug_127_0_0_1_voltage'), '230.1');
    assert.equal(registry.entity('sensor.tuya_plug_127_0_0_1_power')!.unit, 'W');
    assert.equal(states.get('switch.tuya_plug_127_0_0_1')!.attributes.supports_auto_off, true);
  });

  it('switches on with the device-side countdown, confirmed by the status push', async () => {
    const res = await callService('switch', 'turn_on', 'switch.tuya_plug_127_0_0_1', { auto_off_s: 600 }, undefined, { confirmMs: 2000 });
    assert.deepEqual(res.results['switch.tuya_plug_127_0_0_1'], { ok: true, confirmed: true, message: undefined });
    assert.deepEqual(sim.controls.at(-1), { '1': true, '9': 600 });
    assert.equal(states.get('switch.tuya_plug_127_0_0_1')!.context.parentId, res.context.id, 'status traced to the command');
    sim.change({ '19': 20000 }); // button press / load change pushed by the device
    await until('push', () => st('sensor.tuya_plug_127_0_0_1_power') === '2000');
  });

  it('goes unavailable when the link drops and comes back by itself', async () => {
    sim.kill();
    await until('unavailable', () => st('switch.tuya_plug_127_0_0_1') === 'unavailable');
    await until('back', () => st('switch.tuya_plug_127_0_0_1') === 'on', 5000);
  });

  it('follows the device to a new address from its broadcast, and removing the entry closes the link', async () => {
    const driver = engine.drivers[0] as TuyaDriver;
    const announce = (ip: string) => driver.onBroadcast(encodeDiscovery({ ip, gwId: ID, version: '3.3', productKey: 'pk' }), ip);
    announce('127.0.0.9'); // the router gave it a new address (nothing listens there in the test)
    await until('moved', () => st('switch.tuya_plug_127_0_0_1') === 'unavailable');
    announce('127.0.0.1');
    await until('back at the old address', () => st('switch.tuya_plug_127_0_0_1') === 'on', 5000);
    const [entry] = await engine.entries();
    await engine.removeEntry(entry.entryId);
    assert.equal(registry.entity('switch.tuya_plug_127_0_0_1'), null);
    await until('closed', () => sim.conns.size === 0);
  });
});

for (const version of ['3.4', '3.5'] as const) {
  describe(`Tuya ${version} two-outlet switch, end to end`, () => {
    let sim: TuyaSim;
    let engine: LiteEngine;
    const ID = `bf${version.replace('.', '')}00000000000000000`;

    before(async () => {
      freshDb();
      sim = new TuyaSim({ version, localKey: KEY, deviceId: ID, dps: { '1': false, '2': true } });
      await sim.start();
      engine = new LiteEngine([new TuyaDriver({ port: sim.port, discoveryPorts: [], timeoutMs: 1000, heartbeatMs: 200, retryMs: [100] })]);
      await engine.start(hostFor('lite'));
      setEngineLookup((id) => (id === 'lite' ? engine : null));
    });

    after(async () => {
      await engine.stop();
      await sim.stop();
    });

    it('negotiates the session key; a wrong key is reported on the key field', async () => {
      const f = (await engine.startFlow('tuya')) as Form;
      const wrong = (await engine.flowStep(f.flowId, { host: '127.0.0.1', device_id: ID, local_key: BAD, version, profile: 'switch', outlets: 2 })) as Form;
      assert.match(wrong.errors.local_key, /key/i);
      const unreachable = (await engine.flowStep(f.flowId, { host: '127.0.0.2', device_id: ID, local_key: KEY, version, profile: 'switch', outlets: 2 })) as Form;
      assert.match(unreachable.errors.base, /Nothing answered|connect/);
      const done = await engine.flowStep(f.flowId, { host: '127.0.0.1', device_id: ID, local_key: KEY, version, profile: 'switch', outlets: 2 });
      assert.equal(done.type, 'create_entry');
    });

    it('controls each outlet over the encrypted session', async () => {
      await until('connected', () => st('switch.tuya_switch_127_0_0_1_outlet_2') === 'on');
      assert.equal(st('switch.tuya_switch_127_0_0_1_outlet_1'), 'off');
      const res = await callService('switch', 'toggle', 'switch.tuya_switch_127_0_0_1_outlet_2', {}, undefined, { confirmMs: 2000 });
      assert.equal(res.results['switch.tuya_switch_127_0_0_1_outlet_2'].confirmed, true);
      assert.equal(sim.dps['2'], false);
      assert.equal(states.get('switch.tuya_switch_127_0_0_1_outlet_1')!.attributes.supports_auto_off, undefined, 'no countdown DP on this profile');
      // Heartbeats keep the link up well past the dead-link window (3 × 200 ms).
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(st('switch.tuya_switch_127_0_0_1_outlet_1'), 'off');
      assert.equal(sim.conns.size, 1);
    });
  });
}
