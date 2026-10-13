import assert from 'node:assert/strict';
import { test } from 'node:test';
import { state } from '../src/core/state.ts';
import { packMetrics } from '../src/devices/bms/pack.ts';
import * as sa from '../src/devices/bms/serial-ascii.ts';
import { BaseLink } from '../src/devices/bms/serial.ts';

/** A link that answers each request via `respond` (null = silence), split in two chunks with noise. */
class ScriptedLink extends BaseLink {
  open_ = false;
  baud: number;
  private respond: (req: Buffer, baud: number) => Buffer | null;
  constructor(name: string, baud: number, respond: (req: Buffer, baud: number) => Buffer | null) {
    super(name);
    this.baud = baud;
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
    const reply = this.respond(data, this.baud);
    if (!reply) return;
    const mid = Math.floor(reply.length / 2);
    setImmediate(() => {
      this.feed(Buffer.from([0x00]));
      this.feed(reply.subarray(0, mid));
      setImmediate(() => this.feed(reply.subarray(mid)));
    });
  }
}

const bytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const AUTO: sa.ProtocolOptions = { soc: '', capacity: '', temperature: '' };

// ---- Frames ------------------------------------------------------------------------------------

test('serial ascii: frames and checksums for every variant', () => {
  // Pylontech, address 2, INFO = address
  assert.equal(sa.buildFrame(0x20, 0x02, 0x46, 0x42, Uint8Array.of(2)).toString(), '~20024642E00202FD33\r');
  // Seplos V2 telemetry for pack 0 (as sent by the Seplos PC software)
  assert.equal(sa.buildFrame(0x20, 0x00, 0x46, 0x42, Uint8Array.of(0)).toString(), '~20004642E00200FD37\r');
  // Pace (SOK / Revov) VER 0x25, pack 1
  assert.equal(sa.buildFrame(0x25, 0x01, 0x46, 0x42, Uint8Array.of(1)).toString(), '~25014642E00201FD30\r');
  assert.equal(sa.lengthField(0x0f6), 0xb0f6);
  const f = sa.parseFrame('~25014642E00201FD30\r');
  assert.deepEqual([f.ver, f.adr, f.cid1, f.cid2, [...f.info]], [0x25, 1, 0x46, 0x42, [1]]);
  assert.throws(() => sa.parseFrame('~25014642E00201FD31\r'), /checksum/);
});

// ---- Analog layouts ----------------------------------------------------------------------------

const cellsHex = (mv: number[]) => mv.map((v) => v.toString(16).padStart(4, '0')).join(' ');
const SEPLOS_CELLS = [3287, 3305, 3316, 3286, 3311, 3301, 3297, 3292, 3305, 3312, 3304, 3311, 3306, 3290, 3294, 3288];
// Seplos V2: DATAFLAG 00, group 01, 16 cells, 6 temps (4 cells, ambient, power), -5.00 A, 52.89 V,
// 114.00 Ah left, P = 0x0A, full 280.00 Ah, SOC 40.8 %, rated 280.00 Ah, 6 cycles, SOH 100.0 %,
// port voltage 53.52 V, 4 reserved words.
const SEPLOS_INFO = `00 01 10 ${cellsHex(SEPLOS_CELLS)} 06 0B98 0B95 0B97 0B95 0BA3 0B9D FE0C 14A9 2C88 0A 6D60 0198 6D60 0006 03E8 14E8 0000 0000 0000 0000`;

test('serial ascii: Seplos V2 layout', () => {
  const [p] = sa.decodeAnalog(bytes(SEPLOS_INFO));
  assert.equal(p.layout, 'seplos');
  assert.equal(p.cells.length, 16);
  assert.equal(p.current, -5);
  assert.equal(p.voltage, 52.89);
  assert.equal(p.remainingAh, 114);
  assert.equal(p.fullAh, 280);
  assert.equal(p.designAh, 280);
  assert.equal(p.soc, 40.8);
  assert.equal(p.cycles, 6);
  assert.equal(p.soh, 100);
  const m = packMetrics(sa.rawReading(p, AUTO));
  assert.equal(m['State of charge'], 40.8, 'Seplos auto = reported SOC');
  assert.equal(m['Design capacity'], 280);
  assert.equal(m.Capacity, 280);
  assert.equal(m['Temperature 1'], 23.7);
  assert.equal(m['Temperature ENV'], 24.8);
  assert.equal(m['Temperature MOS'], 24.2);
  assert.equal(m.Power, -264);
});

// Pace (SOK / Revov): 00, pack 01, 16 × 3.310 V, 6 temps (4 cells, MOS, env), -10.00 A, 52.960 V,
// 80.00 Ah left, P = 3, full 100.00 Ah, 33 cycles, design 105.00 Ah.
const PACE_INFO = `00 01 10 ${cellsHex(Array(16).fill(3310))} 06 0BA5 0BA5 0BAF 0BAF 0BB9 0B9B FC18 CEE0 1F40 03 2710 0021 2904`;

test('serial ascii: Pace layout', () => {
  const [p] = sa.decodeAnalog(bytes(PACE_INFO));
  assert.equal(p.layout, 'pace');
  assert.equal(p.current, -10);
  assert.equal(p.voltage, 52.96);
  assert.equal(p.remainingAh, 80);
  assert.equal(p.fullAh, 100);
  assert.equal(p.designAh, 105);
  assert.equal(p.cycles, 33);
  const m = packMetrics(sa.rawReading(p, AUTO));
  assert.equal(m['State of charge'], 80);
  assert.equal(m['Design capacity'], 105);
  assert.equal(m['Temperature MOS'], 27);
  assert.equal(m['Temperature ENV'], 24);
  assert.equal(m['Cell temperature - Highest'], 26);
});

// Pylontech: 15 cells, 5 temps, -10.0 A, 49.000 V, 40 Ah left, P = 2, 50 Ah, 16 cycles
const PYLON_INFO = `00 02 0F 0CE4 0CEE${' 0CE9'.repeat(13)} 05 0BA5 0B9B 0B9B 0BA0 0BA0 FF9C BF68 9C40 02 C350 0010`;

test('serial ascii: Pylontech layout and voltage cross-check', () => {
  const [p] = sa.decodeAnalog(bytes(PYLON_INFO));
  assert.equal(p.layout, 'pylon');
  assert.equal(p.current, -10);
  assert.equal(p.voltage, 49);
  const m = packMetrics(sa.rawReading(p, AUTO));
  assert.equal(m['State of charge'], 80);
  assert.equal(m.Temperature, 25);
  assert.equal(m['Design capacity'], undefined);
  // Forcing the Pylontech layout on a Seplos block: voltage still follows the cell sum.
  assert.equal(sa.plausibleVoltage(5289, 0.001, SEPLOS_CELLS.map((v) => v / 1000)), 52.89);
});

// ---- Protocol interpretation matrix -------------------------------------------------------

test('serial ascii: protocol capacity × state of charge matrix', () => {
  const raw = { remainingAh: 40, fullAh: 50, designAh: 100, soc: 77 };
  const cap = (capacity: sa.CapacityMode, soc: sa.SocMode = '') => sa.interpretCapacity(raw, { capacity, soc });
  assert.deepEqual(cap('full,design'), { soc: 77, remainingAh: 40, fullAh: 50, designAh: 100 });
  assert.deepEqual(cap('full'), { soc: 77, remainingAh: 40, fullAh: 50, designAh: undefined });
  assert.deepEqual(cap('10xfull'), { soc: 77, remainingAh: 40, fullAh: 500, designAh: undefined });
  assert.deepEqual(cap('design'), { soc: 77, remainingAh: 40, fullAh: 100, designAh: undefined });
  const expected: Record<string, Record<string, number>> = {
    soc: { 'full,design': 77, full: 77, '10xfull': 77, design: 77 },
    'charge/design': { 'full,design': 40, full: 40, '10xfull': 40, design: 40 },
    'charge/full': { 'full,design': 80, full: 80, '10xfull': 8, design: 40 },
  };
  for (const [soc, row] of Object.entries(expected)) {
    for (const [capacity, want] of Object.entries(row)) {
      assert.equal(cap(capacity as sa.CapacityMode, soc as sa.SocMode).soc, want, `${soc} / ${capacity}`);
    }
  }
  // Auto: reported SOC when present, else charge ÷ full; variant defaults apply first.
  assert.equal(sa.interpretCapacity({ remainingAh: 40, fullAh: 50 }, { soc: '', capacity: '' }).soc, 80);
  assert.equal(sa.interpretCapacity(raw, { soc: '', capacity: '' }, { soc: 'charge/full', capacity: 'full' }).soc, 80);
  // Missing inputs fall back.
  assert.equal(sa.interpretCapacity({ remainingAh: 40, fullAh: 50 }, { soc: 'soc', capacity: '' }).soc, 80);
  assert.equal(sa.interpretCapacity({ remainingAh: 40, fullAh: 50 }, { soc: 'charge/design', capacity: '' }).soc, 80);
  assert.equal(sa.interpretCapacity({ remainingAh: 40, designAh: 80 }, { soc: '', capacity: 'full' }).fullAh, 80);
});

test('serial ascii: protocol temperature modes', () => {
  assert.equal(sa.convertTemperature(2981, '0.1K'), 25);
  assert.equal(Math.round(sa.convertTemperature(298, '1K') * 100) / 100, 24.85);
  assert.equal(sa.convertTemperature(250, '0.1°C'), 25);
  assert.equal(sa.convertTemperature(-5, '1°C'), -5);
  assert.equal(sa.convertTemperature(35, '1°C-10'), 25);
  assert.equal(sa.guessTemperatureMode([2981, 2990]), '0.1K');
  assert.equal(sa.guessTemperatureMode([250, 262]), '0.1°C');
  assert.equal(sa.guessTemperatureMode([25, 26]), '1°C');
  assert.deepEqual(sa.temperaturesC([2981, 2971], '', '0.1K'), [25, 24]);
  assert.deepEqual(sa.temperaturesC([2981, 2971], '0.1°C', '0.1K'), [298.1, 297.1], 'the setting overrides the variant');
  // Overriding the temperature setting on a decoded Pace block.
  const [p] = sa.decodeAnalog(bytes(PACE_INFO));
  const m = packMetrics(sa.rawReading(p, { soc: '', capacity: '10xfull', temperature: '1K' }));
  assert.equal(m['Temperature MOS'], 2727.9);
  assert.equal(m.Capacity, 1000);
  assert.equal(m['Design capacity'], undefined);
  assert.equal(m['State of charge'], 8);
});

// ---- Presets / variants ---------------------------------------------------------------------

test('serial ascii: model presets, variant and baud overrides', () => {
  assert.deepEqual(sa.resolveAttempts('seplos', 'auto', 0).map((a) => [a.variant, a.baud, a.first]), [['seplos', 19200, [0, 1]]]);
  assert.deepEqual(sa.resolveAttempts('seplos', 'pylon', 0).map((a) => [a.variant, a.baud]), [['pylon', 9600]]);
  assert.deepEqual(sa.resolveAttempts('seplos', '', 9600).map((a) => [a.variant, a.baud]), [['seplos', 9600]]);
  assert.deepEqual(sa.resolveAttempts('vestwood', 'auto', 0)[0].first, [2]);
  assert.deepEqual(sa.resolveAttempts('trophy', 'auto', 0).map((a) => a.variant), ['pace', 'seplos']);
  assert.deepEqual(sa.resolveAttempts('sok', 'auto', 0)[0].versions, [0x25]);
  assert.equal(sa.resolveAttempts('unknown', 'auto', 0), sa.AUTO_ATTEMPTS);
  const auto = sa.resolveAttempts('auto', 'auto', 19200);
  assert.ok(auto.every((a) => a.baud === 19200));
  assert.ok(auto.length < sa.AUTO_ATTEMPTS.length, 'duplicates dropped after the baud override');
  assert.deepEqual(sa.serialDriver.models?.map((m) => m.id), ['auto', 'pylontech', 'dyness', 'seplos', 'sok', 'revov', 'trophy', 'sunsynk', 'vestwood', 'generic']);
  assert.equal(sa.serialDriver.name, 'USB Serial RS232/485');
  assert.equal(sa.serialDriver.id, 'serial');
});

// ---- Over a link ---------------------------------------------------------------------------

/** A bus of packs at `addresses` answering `info` frames only at `baud` / `ver`. */
function bus(opts: { baud: number; ver: number; addresses: number[]; info: (adr: number) => string }) {
  const seen: string[] = [];
  const respond = (req: Buffer, baud: number) => {
    const f = sa.parseFrame(req);
    seen.push(`${baud}/${f.ver.toString(16)}/${f.adr}`);
    if (baud !== opts.baud || f.ver !== opts.ver || !opts.addresses.includes(f.adr)) return null;
    if (f.cid2 !== sa.CMD.analog) return sa.buildFrame(f.ver, f.adr, 0x46, 0x04);
    return sa.buildFrame(f.ver, f.adr, 0x46, 0x00, bytes(opts.info(f.adr)));
  };
  return { respond, seen };
}

test('serial ascii: auto detect finds a Seplos stack at 19200 baud', async () => {
  const b = bus({ baud: 19200, ver: 0x20, addresses: [0, 1], info: () => SEPLOS_INFO });
  const bms = sa.createSerial(['/dev/s'], { modelId: 'auto', maxPacks: () => 8, protocol: () => AUTO }, (p, baud) => new ScriptedLink(p, baud, b.respond));
  await bms.connect();
  const packs = await bms.read();
  assert.equal(packs.length, 2);
  assert.equal(packs[1]['State of charge'], 40.8);
  assert.equal(packs[0].Voltage, 52.89);
  assert.ok(b.seen.indexOf('9600/20/2') < b.seen.indexOf('19200/20/0'), 'Pylontech at 9600 is tried before Seplos at 19200');
});

test('serial ascii: Pace stack, maximum pack count and current from the inverter', async () => {
  const b = bus({ baud: 9600, ver: 0x25, addresses: [1, 2, 3, 4], info: () => PACE_INFO });
  let fromInverter = false;
  const bms = sa.createSerial(
    ['/dev/p'],
    { modelId: 'revov', maxPacks: () => 3, protocol: () => AUTO, readCurrentFromInverter: () => fromInverter },
    (p, baud) => new ScriptedLink(p, baud, b.respond),
  );
  await bms.connect();
  let packs = await bms.read();
  assert.equal(packs.length, 3, 'capped by the maximum pack count');
  assert.equal(packs[0].Current, -10);
  fromInverter = true;
  state.inverters = [{ 'Battery current': 30 }];
  packs = await bms.read();
  assert.deepEqual(packs.map((p) => p.Current), [10, 10, 10]);
  assert.equal(packs[0].Power, 530);
  assert.equal(packs[0]['Device mode'], 'Charging');
  state.inverters = [];
  packs = await bms.read();
  assert.equal(packs[0].Current, -10, 'no inverter reading: pack values kept');
});

test('serial ascii: a master answering for the whole stack', async () => {
  const block2 = `0F ${'0CE9 '.repeat(15)} 05 0BA5 0BA5 0BA5 0BA5 0BA5 0064 B6F8 9C40 02 C350 0011`;
  const b = bus({ baud: 9600, ver: 0x20, addresses: [2], info: () => `${PYLON_INFO} ${block2}` });
  const bms = sa.createSerial(['/dev/m'], { modelId: 'pylontech', maxPacks: () => 16, protocol: () => AUTO }, (p, baud) => new ScriptedLink(p, baud, b.respond));
  await bms.connect();
  const packs = await bms.read();
  assert.equal(packs.length, 2);
  assert.equal(packs[1].Current, 10);
  assert.equal(packs[1].Cycles, 17);
});
