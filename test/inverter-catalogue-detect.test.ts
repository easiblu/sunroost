import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CATALOGUE } from '../src/devices/catalogue-data.ts';
import { catalogue, coverage, resolve } from '../src/devices/catalogue.ts';
import { detect } from '../src/devices/detect.ts';
import { INVERTER_DRIVERS, inverterDriver } from '../src/devices/registry.ts';
import { fakeLogger } from '../src/devices/solarman.ts';

const ascii = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => (s.charCodeAt(i * 2) << 8) | s.charCodeAt(i * 2 + 1));

test('catalogue: every row resolves; model ids exist in their driver', () => {
  assert.ok(CATALOGUE.length >= 200);
  assert.ok(new Set(CATALOGUE.map((r) => r.b)).size >= 64);
  for (const e of catalogue()) {
    if (e.support === 'supported' || e.support === 'read-only') {
      const d = inverterDriver(e.driverId!);
      assert.ok(d, `${e.brand} ${e.series}: driver ${e.driverId}`);
      if (d.models?.length) assert.ok(d.models.some((m) => m.id === e.modelId), `${e.brand} ${e.series}: model ${e.modelId}`);
    }
  }
});

test('catalogue: rebrands map onto the right driver and support level', () => {
  const find = (b: string, s: string) => catalogue().find((e) => e.brand === b && e.series.startsWith(s))!;
  assert.deepEqual([find('Sol-Ark', '30K').driverId, find('Sol-Ark', '30K').modelId], ['sunsynk', 'hybrid3hv']);
  assert.equal(find('Deye', 'SG04LP3').modelId, 'hybrid3');
  assert.equal(find('PowMr', 'POW-SunSmart').protocol, 'srne');
  assert.equal(find('Growatt', 'SPF-ES').modelId, 'spf');
  assert.equal(find('Growatt', 'WIT').support, 'read-only');
  assert.equal(find('WeVolt', 'WVLVS-IP54').support, 'planned');
  assert.equal(find('Voltronic', 'InfiniSolar Hybrid').support, 'read-only');
  assert.equal(find('Voltronic', 'Axpert MAX II').modelId, 'axpert_max');
  assert.equal(find('AMIBA', 'AN-Series').support, 'auto');
  // A protocol without a driver yet is "planned", and turns "read-only" once a read-only driver exists.
  const row = CATALOGUE.find((r) => r.p === 'srne')!;
  assert.equal(resolve(row).support, inverterDriver('srne') ? resolve(row).support : 'planned');
  const c = coverage();
  assert.equal(Object.values(c.series).reduce((a, b) => a + b, 0), CATALOGUE.length);
});

async function withLogger(holding: Map<number, number>, fn: (connection: string) => Promise<void>) {
  const server = fakeLogger({ serial: 42, holding });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`solarman://127.0.0.1:${(server.address() as AddressInfo).port}/42`);
  } finally {
    server.close();
  }
}

test('detect: Deye through a Solarman logger, with model from the device type', async () => {
  const holding = new Map<number, number>([[0, 5]]);
  ascii('2106123456').forEach((v, i) => holding.set(3 + i, v));
  await withLogger(holding, async (connection) => {
    const r = await detect(connection, { modbusTimeoutMs: 300, networkSettleMs: 0 });
    assert.equal(r.length, 1);
    assert.equal(r[0].driverId, 'sunsynk');
    assert.equal(r[0].modelId, 'hybrid3');
    assert.match(r[0].evidence, /2106123456/);
  });
});

test('detect: Growatt (serial at 23, firmware at 9); nothing when registers are blank', async () => {
  const holding = new Map<number, number>();
  ascii('RA1.0 ').forEach((v, i) => holding.set(9 + i, v));
  ascii('XYZ0123456').forEach((v, i) => holding.set(23 + i, v));
  await withLogger(holding, async (connection) => {
    const r = await detect(connection, { modbusTimeoutMs: 300, networkSettleMs: 0 });
    assert.equal(r[0]?.driverId, 'growatt');
    assert.equal(r[0].modelId, null);
  });
  await withLogger(new Map(), async (connection) => {
    assert.deepEqual(await detect(connection, { modbusTimeoutMs: 300, networkSettleMs: 0 }), []);
  });
});

test('detect: Voltronic answers first on serial paths; PI18 means InfiniSolar', async () => {
  const r = await detect('/dev/ttyFAKE0', { voltronic: async () => ({ protocol: 'PI18', model: 'MKS2-5600' }), drivers: INVERTER_DRIVERS });
  assert.deepEqual(r, [{ driverId: 'voltronic', driverName: inverterDriver('voltronic')!.name, modelId: 'infinisolar', baudRate: 2400, address: null, evidence: 'protocol PI18, model MKS2-5600' }]);
  // HID paths only get the Voltronic probe.
  assert.deepEqual(await detect('/dev/hidraw9', { voltronic: async () => { throw new Error('timeout'); } }), []);
  await assert.rejects(detect('  '), /Choose a connection/);
});

test('detect: dongle schemes go straight to their driver', async () => {
  const lux = await detect('luxpower://192.168.1.7/BA12345678');
  assert.equal(lux[0].driverId, 'luxpower');
  const gw = await detect('goodwe://192.168.1.8', { goodweUdp: async () => ({ modelId: 'et', evidence: 'GW10K-ET, serial 9010KETU123A4567', address: 247 }) });
  assert.deepEqual(gw.map((r) => [r.driverId, r.modelId, r.address]), [['goodwe', 'et', null]]);
  assert.deepEqual(await detect('goodwe://192.168.1.8', { goodweUdp: async () => null }), []);
});

test('detect: a Sumry inverter behind an Eybond dongle that dialled in', async () => {
  const { fakeDongle } = await import('../src/devices/eybond.ts');
  const port = 21000 + Math.floor(Math.random() * 2000);
  const holding = new Map<number, number>();
  ascii('SM2304120001').forEach((v, i) => holding.set(186 + i, v));
  holding.set(201, 3);
  // The dongle keeps retrying until the listener (opened by detect) accepts it.
  const live: { dongle: ReturnType<typeof fakeDongle> | null } = { dongle: null };
  const timer = setInterval(() => {
    if (live.dongle) return;
    const d = fakeDongle({ port, pn: 'W0012345678901', holding, unsolicitedHeartbeat: true });
    d.socket.once('error', () => (live.dongle = null));
    live.dongle = d;
  }, 100);
  try {
    const r = await detect(`eybond://${port}/W0012345678901`, { modbusTimeoutMs: 1000, networkSettleMs: 0 });
    assert.equal(r[0]?.driverId, 'sumry');
  } finally {
    clearInterval(timer);
    live.dongle?.close();
  }
});
