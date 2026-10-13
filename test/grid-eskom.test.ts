import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fmtIn, humanName, mergeAdjacent, nextOutage, parseAreaMetadata, parseOutagesCsv, splitCsvLine, type Outage,
} from '../src/grid/eskom.ts';

const H = 3_600_000;

test('splits CSV lines with quoted fields', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('"say ""hi""",,x'), ['say "hi"', '', 'x']);
});

test('parses the eskom-calendar machine-friendly CSV', () => {
  const csv = [
    'area_name,start,finsh,stage,source',
    'city-of-cape-town-area-1,2026-10-13T16:00:00+02:00,2026-10-13T18:30:00+02:00,4,"https://example.com/a"',
    'city-of-cape-town-area-1,2026-10-13T08:00:00+02:00,2026-10-13T10:30:00+02:00,2,"https://example.com/b"',
    'broken-row,not-a-date,2026-10-13T10:30:00+02:00,2,',
    '',
  ].join('\n');
  const rows = parseOutagesCsv(csv);
  assert.equal(rows.length, 2);
  // Sorted by start; times keep their offset.
  assert.equal(rows[0].start, Date.parse('2026-10-13T06:00:00Z'));
  assert.equal(rows[0].stage, 2);
  assert.equal(rows[1].end - rows[1].start, 2.5 * H);
  assert.equal(rows[1].source, 'https://example.com/a');
  assert.throws(() => parseOutagesCsv('foo,bar\n1,2'));
});

test('parses area metadata in all its list styles', () => {
  const yaml = `---
area_details:
- calendar_name: eskom-direct-1-even.ics
  provider: eskom
  areas:
  - province: free-state
    municipality: "kopanong"
    name: ["aandenking","alicedale"]
- calendar_name: city-of-cape-town-area-1.ics
  province: western-cape
  municipality: city-of-cape-town-metropolitan
  areas:
  - {name: "parow east"}
  - {name: bellville}
- calendar_name: city-of-cape-town-area-12.ics
  province: western-cape
  municipality: city-of-cape-town-metropolitan
  areas: [{name: city of cape town area 12}, {name: "sea point"}]
`;
  const entries = parseAreaMetadata(yaml);
  const names = (area: string) => entries.filter((e) => e.area === area).map((e) => e.name);
  assert.deepEqual(names('eskom-direct-1-even'), ['Eskom Direct 1 Even', 'aandenking', 'alicedale']);
  assert.deepEqual(names('city-of-cape-town-area-1'), ['City of Cape Town Area 1', 'parow east', 'bellville']);
  assert.deepEqual(names('city-of-cape-town-area-12'), ['City of Cape Town Area 12', 'city of cape town area 12', 'sea point']);
  const bell = entries.find((e) => e.name === 'bellville')!;
  assert.equal(bell.province, 'western-cape');
  assert.equal(bell.municipality, 'city-of-cape-town-metropolitan');
  assert.equal(entries.find((e) => e.name === 'alicedale')!.municipality, 'kopanong');
  // The calendar's own entry carries calendar-level province/municipality.
  assert.equal(entries.find((e) => e.name === 'City of Cape Town Area 12')!.province, 'western-cape');
});

test('finds the current or next outage and merges back-to-back slots', () => {
  const t0 = Date.UTC(2026, 9, 13, 6);
  const o = (start: number, end: number, stage = 2): Outage => ({ area: 'a', start, end, stage, source: '' });
  const list = [o(t0, t0 + 2 * H), o(t0 + 10 * H, t0 + 12 * H, 4)];
  assert.equal(nextOutage(list, t0 - H), list[0]);
  assert.equal(nextOutage(list, t0 + H), list[0]); // in progress
  assert.equal(nextOutage(list, t0 + 3 * H), list[1]);
  assert.equal(nextOutage(list, t0 + 13 * H), null);
  const merged = mergeAdjacent([o(t0 + 2 * H, t0 + 4 * H), o(t0, t0 + 2 * H), o(t0 + 4 * H, t0 + 5 * H, 3)]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end, t0 + 4 * H);
});

test('formats names and countdowns', () => {
  assert.equal(humanName('city-of-cape-town-area-1.ics'), 'City of Cape Town Area 1');
  assert.equal(humanName('eskom-direct-1-even'), 'Eskom Direct 1 Even');
  assert.equal(fmtIn(0), 'now');
  assert.equal(fmtIn(45 * 60_000), '45m');
  assert.equal(fmtIn(125 * 60_000), '2h 05m');
});
