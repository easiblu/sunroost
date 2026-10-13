import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardProfile } from '../src/system/board.ts';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('recognises every supported board from its device-tree model', () => {
  const cases: [string, string][] = [
    ['Raspberry Pi Model B Rev 2', 'pi1'],
    ['Raspberry Pi Model B Plus Rev 1.2', 'pi1'],
    ['Raspberry Pi Model A Plus Rev 1.1', 'pi1'],
    ['Raspberry Pi Compute Module Rev 1.0', 'pi1'],
    ['Raspberry Pi Zero Rev 1.3', 'pi-zero'],
    ['Raspberry Pi Zero W Rev 1.1', 'pi-zero'],
    ['Raspberry Pi Zero 2 W Rev 1.0', 'pi-zero-2w'],
    ['Raspberry Pi 2 Model B Rev 1.1', 'pi2'],
    ['Raspberry Pi 3 Model B Rev 1.2', 'pi3'],
    ['Raspberry Pi 3 Model B Plus Rev 1.3', 'pi3'],
    ['Raspberry Pi 3 Model A Plus Rev 1.0', 'pi3'],
    ['Raspberry Pi Compute Module 3 Plus Rev 1.0', 'pi3'],
    ['Raspberry Pi 4 Model B Rev 1.5', 'pi4'],
    ['Raspberry Pi 400 Rev 1.0', 'pi4'],
    ['Raspberry Pi Compute Module 4 Rev 1.0', 'pi4'],
    ['Raspberry Pi 5 Model B Rev 1.0', 'pi5'],
    ['Raspberry Pi 500 Rev 1.0', 'pi5'],
    ['Raspberry Pi Compute Module 5 Rev 1.0', 'pi5'],
    ['OrangePi 3 LTS', 'orangepi-3-lts'],
  ];
  for (const [model, family] of cases) {
    const p = boardProfile(model, 'arm64', 2 * GB);
    assert.equal(p.family, family, model);
    assert.equal(p.supported, true, model);
  }
});

test('the non-LTS Orange Pi 3 and other machines are not supported boards', () => {
  assert.equal(boardProfile('OrangePi 3', 'arm64', 2 * GB).supported, false);
  const mac = boardProfile('Mac (Apple M1 Pro)', 'arm64', 16 * GB);
  assert.equal(mac.family, 'other');
  assert.equal(mac.name, 'Mac (Apple M1 Pro)');
  assert.equal(mac.engine.full, 'yes');
});

test('64-bit boards with 2 GB or more get the full device engine', () => {
  for (const model of ['Raspberry Pi 5 Model B Rev 1.0', 'Raspberry Pi 4 Model B Rev 1.4', 'OrangePi 3 LTS']) {
    // A 2 GB board reports about 1.8 GiB.
    const p = boardProfile(model, 'arm64', 1850 * MB);
    assert.deepEqual(p.engine, { recommended: 'full', full: 'yes', reason: null }, model);
  }
});

test('1 GB 64-bit boards can run full, but lite is recommended', () => {
  const p = boardProfile('Raspberry Pi 3 Model B Plus Rev 1.3', 'arm64', 906 * MB);
  assert.equal(p.engine.full, 'limited');
  assert.equal(p.engine.recommended, 'lite');
  assert.match(p.engine.reason!, /906 MB/);
});

test('512 MB and 32-bit boards get the lite engine with a reason', () => {
  const zero2 = boardProfile('Raspberry Pi Zero 2 W Rev 1.0', 'arm64', 427 * MB);
  assert.equal(zero2.engine.full, 'no');
  assert.equal(zero2.engine.recommended, 'lite');
  assert.match(zero2.engine.reason!, /2 GB/);

  const pi1 = boardProfile('Raspberry Pi Model B Plus Rev 1.2', 'arm', 434 * MB);
  assert.equal(pi1.engine.full, 'no');
  assert.match(pi1.engine.reason!, /64-bit board/);

  // A 64-bit-capable Pi running the 32-bit OS is told how to fix it.
  const pi4on32 = boardProfile('Raspberry Pi 4 Model B Rev 1.4', 'arm', 3800 * MB);
  assert.equal(pi4on32.engine.full, 'no');
  assert.match(pi4on32.engine.reason!, /64-bit OS/);
});
