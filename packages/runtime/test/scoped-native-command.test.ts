import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScopedManagedFill, parseScopedNativeFill } from '../src/scoped-native-command.ts';

test('scoped command retains literal target and value bytes', () => {
  assert.deepEqual(parseScopedNativeFill('Fill Display Name with café ✓'), {
    fieldLabel: 'Display Name', value: 'café ✓', prefix: 'Fill Display Name with ',
  });
});

test('managed command retains approved URL and literal value bytes', () => {
  assert.deepEqual(parseScopedManagedFill('Fill Search on https://example.com/ with café'), {
    fieldLabel: 'Search', url: 'https://example.com/', value: 'café',
    prefix: 'Fill Search on https://example.com/ with ',
  });
  assert.throws(() => parseScopedManagedFill('Fill Search on https://example.com/ with '));
});

test('scoped command refuses missing, ambiguous and oversized operands', () => {
  for (const text of ['delete this', 'Fill Name', 'Fill  with data',
    'Fill Name with ', 'Fill Name with  secret',
    `Fill Name with ${'x'.repeat(1_025)}`]) {
    assert.throws(() => parseScopedNativeFill(text));
  }
});
