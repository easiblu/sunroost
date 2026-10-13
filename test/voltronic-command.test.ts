import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isQuery, validCommand } from '../src/web/api/command.ts';

test('command console validation', () => {
  assert.equal(validCommand('  QPIGS '), 'QPIGS');
  assert.throws(() => validCommand(''), /Enter a command/);
  assert.throws(() => validCommand('Q'.repeat(33)), /32/);
  assert.throws(() => validCommand('QPI\rGS'), /printable/);
  assert.throws(() => validCommand('QPIGSé'), /printable/);
  assert.ok(isQuery('QPIRI'));
  assert.ok(!isQuery('POP00'));
});
