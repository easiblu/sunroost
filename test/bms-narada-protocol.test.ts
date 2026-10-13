import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as narada from '../src/devices/bms/narada.ts';
import { packMetrics } from '../src/devices/bms/pack.ts';
import { buildFrame, parseFrame, type ProtocolOptions } from '../src/devices/bms/serial-ascii.ts';
import { BaseLink } from '../src/devices/bms/serial.ts';

class ScriptedLink extends BaseLink {
  open_ = false;
  private respond: (req: Buffer) => Buffer | null;
  constructor(name: string, respond: (req: Buffer) => Buffer | null) {
    super(name);
    this.respond = respond;
  }
  get isOpen() {
    return this.open_;
  }
  async open() {
    this.open_ = true;
  }
  async close() {
    this.open_ = false;
  }
  protected async write(data: Buffer) {
    const reply = this.respond(data);
    if (reply) setImmediate(() => this.feed(reply));
  }
}

const bytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const AUTO: ProtocolOptions = { soc: '', capacity: '', temperature: '' };
const CELLS = Array.from({ length: 16 }, (_, i) => (3310 + (i % 4)).toString(16).padStart(4, '0')).join(' ');
// 16 cells ≈ 3.31 V, 4 temps (0.1 K), -10.00 A, 53.00 V, 80.00 Ah left, P = 2, 100.00 Ah full, 33 cycles
const BODY = `10 ${CELLS} 04 0BA5 0BA0 0B9B 0BAF FC18 14B4 1F40`;

test('narada: EG4 request frame', () => {
  assert.equal(buildFrame(0x20, 0x01, narada.CID1_NARADA, narada.CID2_ANALOG).toString(), '~20014A420000FDA2\r');
  assert.equal(narada.naradaDriver.name, 'USB Narada RS485');
  assert.deepEqual(narada.naradaDriver.models?.map((m) => m.name), ['EG4 LifePower4 (no LCD)', 'SunSynk SSLB', 'Shoto SDA10-48100L5', 'Vestwood VT48100e', 'Generic']);
});

test('narada: analog decode with INFOFLAG + address header and a P byte', () => {
  const r = narada.decodeNarada(bytes(`00 02 ${BODY} 02 2710 0021`));
  assert.equal(r.cells.length, 16);
  assert.equal(r.cells[3], 3.313);
  assert.equal(r.current, -10);
  assert.equal(r.voltage, 53);
  assert.equal(r.remainingAh, 80);
  assert.equal(r.fullAh, 100);
  assert.equal(r.cycles, 33);
  const m = packMetrics(narada.naradaReading(r, AUTO));
  assert.equal(m['State of charge'], 80);
  assert.equal(m['Temperature 1'], 25);
  assert.equal(m.Temperature, 24.9);
  assert.equal(m.Power, -530);
});

test('narada: no header, no P byte, design capacity and other units', () => {
  const r = narada.decodeNarada(bytes(`${BODY} 2710 0021 2904`));
  assert.equal(narada.cellOffset(bytes(BODY)), 0);
  assert.equal(r.designAh, 105);
  assert.equal(r.cycles, 33);
  const m = packMetrics(narada.naradaReading(r, { soc: 'charge/design', capacity: 'full,design', temperature: '0.1K' }));
  assert.equal(m['State of charge'], 76.2);
  assert.equal(m['Design capacity'], 105);
  // Voltage in mV instead of 10 mV is caught by the cell-sum cross-check.
  const mv = narada.decodeNarada(bytes(`00 ${BODY.replace('14B4', 'CEFF')} 2710 0021`));
  assert.equal(mv.voltage, 52.991);
  // Temperatures sent as 0.1 °C are recognised in auto mode.
  const c = narada.decodeNarada(bytes(BODY.replace('0BA5 0BA0 0B9B 0BAF', '00FA 00F5 00F0 0104')));
  assert.deepEqual(packMetrics(narada.naradaReading(c, AUTO))['Temperature 1'], 25);
  assert.throws(() => narada.decodeNarada(bytes('00 01 02 03')), /cell block/);
});

test('narada: EG4 packs from address 2 without gaps; empty INFO rejected → address sent', async () => {
  const requests: string[] = [];
  const respond = (req: Buffer) => {
    const f = parseFrame(req);
    requests.push(req.toString().trim());
    if (f.cid1 !== narada.CID1_NARADA || ![2, 3, 5].includes(f.adr)) return null;
    if (!f.info.length) return buildFrame(0x20, f.adr, 0x4a, 0x05); // command format error
    return buildFrame(0x20, f.adr, 0x4a, 0x00, bytes(`00 ${f.adr.toString(16).padStart(2, '0')} ${BODY} 02 2710 0021`));
  };
  const bms = narada.createNarada(['/dev/n'], { modelId: 'eg4', baudRate: 9600, maxPacks: () => 16, protocol: () => AUTO }, (p) => new ScriptedLink(p, respond));
  await bms.connect();
  const packs = await bms.read();
  assert.equal(packs.length, 2, 'address 4 missing: discovery stops, address 5 is not used');
  assert.equal(packs[1]['State of charge'], 80);
  assert.equal(requests[0], '~20024A420000FDA1');
  assert.ok(requests.includes(buildFrame(0x20, 2, 0x4a, 0x42, Uint8Array.of(2)).toString().trim()));
});
