import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as con from '../src/devices/bms/pylontech-console.ts';
import { BaseLink } from '../src/devices/bms/serial.ts';

class ScriptedLink extends BaseLink {
  open_ = false;
  baud: number;
  private respond: (req: string, baud: number) => string | null;
  constructor(name: string, baud: number, respond: (req: string, baud: number) => string | null) {
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
    const reply = this.respond(data.toString('latin1'), this.baud);
    if (reply === null) return;
    const buf = Buffer.from(reply, 'latin1');
    const mid = Math.floor(buf.length / 2);
    setImmediate(() => {
      this.feed(buf.subarray(0, mid));
      setImmediate(() => this.feed(buf.subarray(mid)));
    });
  }
}

const crlf = (lines: string[]) => lines.join('\r\n');
const END = ['Command completed successfully', '', '$$', '', 'pylon>'];

// US2000B/US2000C firmware: Time column with a space, Absent position 3.
const PWR_A = crlf([
  'pwr',
  '@',
  '',
  'Power Volt   Curr   Tempr  Tlow   Thigh  Vlow   Vhigh  Base.St  Volt.St  Curr.St  Temp.St  Coulomb  Time                 B.V.St   B.T.St  ',
  '1     49797  -1180  25000  24000  25000  3317   3322   Dischg   Normal   Normal   Normal   72%      2019-12-31 23:59:59  Normal   Normal  ',
  '2     49795  -1188  26000  24000  25000  3317   3321   Dischg   Normal   Normal   Normal   73%      2019-12-31 23:59:59  Normal   Normal  ',
  '3     -      -      -      -      -      -      -      Absent   -        -        -        -        -                    -        -       ',
  ...END,
]);

// US5000 / Pytes firmware: extra *.Id columns, MOSFET temperature, different column order.
const PWR_B = crlf([
  'pwr',
  '@',
  'Power Volt   Curr   Tempr  Tlow   Tlow.Id  Thigh  Thigh.Id  Vlow   Vlow.Id  Vhigh  Vhigh.Id  Coulomb  Base.St  Volt.St  Curr.St  Temp.St  Time                 B.V.St   B.T.St   MosTempr  M.T.St',
  '1     52310  12340  23400  22000  2        23000  5         3485   7        3492   12        88 %     Charge   Normal   Normal   Normal   2024-05-01 10:00:00  Normal   Normal   27100     Normal',
  '2     52300  12300  23500  22000  3        23000  5         3484   1        3495   9         87 %     Charge   High     Normal   Normal   2024-05-01 10:00:00  Normal   Normal   27500     Normal',
  ...END,
]);

const BAT = crlf([
  'bat 1',
  '@',
  'Battery  Volt     Curr     Tempr    Base State   Volt. State  Curr. State  Temp. State  SOC          Coulomb      BAL         ',
  ...Array.from({ length: 15 }, (_, i) =>
    `${String(i).padEnd(9)}${String(3317 + (i % 3)).padEnd(9)}-1180    ${String(i < 5 ? 25000 : 24000).padEnd(9)}Dischg       Normal       Normal       Normal       72%          36088 mAH    N           `,
  ),
  ...END,
]);

const INFO = crlf([
  'info 1',
  '@',
  'Device address      : 1',
  'Manufacturer        : Pylon',
  'Device name         : US2000C',
  'Board version       : PHANTOMSAV10R03',
  'Main Soft version   : B66.6',
  'Soft  version       : V2.4',
  'Barcode             : PPTBH02040123456',
  'Specification       : 48V/50AH',
  ...END,
]);

const STAT = crlf(['stat 1', '@', 'Device address      : 1', 'CYCLE Times         :     123', 'Charge Cnt.         :   4567', ...END]);

test('console: header and row tokenising', () => {
  assert.deepEqual(con.headerTokens('Battery  Volt  Base State   Volt. State  Coulomb'), ['battery', 'volt', 'basestate', 'voltstate', 'coulomb']);
  assert.deepEqual(con.rowTokens('0  3317  Dischg  72 %  36088 mAH  2019-12-31 23:59:59  N'), ['0', '3317', 'Dischg', '72%', '36088mAH', '2019-12-31 23:59:59', 'N']);
});

test('console: pwr table, older firmware layout', () => {
  const packs = con.parsePwr(PWR_A);
  assert.equal(packs.length, 2, 'the Absent position is skipped');
  assert.deepEqual(packs.map((p) => p.index), [1, 2]);
  const r = packs[0].reading;
  assert.equal(r.voltage, 49.797);
  assert.equal(r.current, -1.18);
  assert.equal(r.temperature, 25);
  assert.equal(r.soc, 72);
  assert.deepEqual(r.alarms, []);
  assert.equal(packs[1].reading.temperature, 26);
});

test('console: pwr table, US5000/Pytes layout with reordered columns', () => {
  const packs = con.parsePwr(PWR_B);
  assert.equal(packs.length, 2);
  const [a, b] = packs.map((p) => p.reading);
  assert.equal(a.voltage, 52.31);
  assert.equal(a.current, 12.34);
  assert.equal(a.temperature, 23.4);
  assert.equal(a.temperatureMos, 27.1);
  assert.equal(a.soc, 88);
  assert.equal(b.soc, 87);
  assert.deepEqual(b.alarms, ['Voltage high']);
  assert.equal(packs[0].status, 'Charge');
});

test('console: bat, stat and info', () => {
  const bat = con.parseBat(BAT);
  assert.equal(bat.cells?.length, 15);
  assert.equal(bat.cells?.[0], 3.317);
  assert.equal(bat.cells?.[2], 3.319);
  assert.equal(bat.cellTemperatures?.[0], 25);
  assert.equal(bat.cellTemperatures?.[14], 24);
  assert.equal(bat.remainingAh, 36.088);
  assert.equal(con.parseStat(STAT), 123);
  assert.deepEqual(con.parseInfo(INFO), { model: 'US2000C', firmware: 'B66.6', serial: 'PPTBH02040123456' });
});

test('console: reply framing waits for $$ and the prompt', () => {
  const r = con.consoleReader;
  assert.equal(r(Buffer.from('pwr\r\n@\r\nPower Volt')), 0);
  assert.equal(r(Buffer.from('x\r\n$$')), 0);
  assert.equal(r(Buffer.from('x\r\n$$\r\n\r\npylon>tail')), 'x\r\n$$\r\n\r\npylon>'.length);
  assert.equal(r(Buffer.from('x\r\n$$\r\n\r\n')), 'x\r\n$$\r\n\r\n'.length);
});

test('console: driver wakes an RJ11 unit at 1200 baud, then reads packs at 115200', async () => {
  let awake = false;
  const sent: string[] = [];
  const respond = (req: string, baud: number) => {
    sent.push(`${baud}:${req.trim()}`);
    if (baud === 1200 && req === con.WAKE_FRAME) {
      awake = true;
      return null;
    }
    if (baud !== 115200 || !awake) return null;
    const cmd = req.trim();
    if (cmd === '') return '\r\n$$\r\n\r\npylon>';
    if (cmd === 'pwr') return PWR_A;
    if (/^bat \d$/.test(cmd)) return BAT;
    if (/^info \d$/.test(cmd)) return INFO;
    if (/^stat \d$/.test(cmd)) return STAT;
    return crlf(['Unknown command', ...END]);
  };
  const bms = con.createPylontechConsole(['/dev/c'], (p, baud) => new ScriptedLink(p, baud, respond), () => 8);
  await bms.connect();
  const packs = await bms.read();
  assert.equal(packs.length, 2);
  assert.equal(packs[0].Voltage, 49.8);
  assert.equal(packs[0]['State of charge'], 72);
  assert.equal(packs[0].Cycles, 123);
  assert.equal(packs[0]['Model name'], 'US2000C');
  assert.equal(packs[0]['Cell voltage - Highest'], 3.319);
  assert.equal(packs[0]['Charge capacity'], 36.1);
  assert.equal(packs[0]['Device mode'], 'Discharging');
  assert.ok(sent.indexOf(`1200:${con.WAKE_FRAME.trim()}`) >= 0);
  assert.equal(con.pylontechConsoleDriver.name, 'USB PylonTech/Pytes console');
  assert.equal(con.pylontechConsoleDriver.id, 'pylontech');
});
