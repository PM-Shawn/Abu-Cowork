'use strict';

// The helper's structured error must survive the process boundary intact, and
// anything unstructured must land on the pessimistic verdict. This is the
// manager half of the execution-receipt contract
// (research: 11-m1-execution-receipt-contract.md); the Gate half reads
// `error.helper` and never the message.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeHelperError, HELPER_EXECUTIONS } = require('./nativeHelperManager.cjs');

test('a structured helper error keeps code, execution and retryable', () => {
  const error = normalizeHelperError({
    code: 'target-changed',
    execution: 'not-executed',
    retryable: true,
    message: 'frontmost target changed; observe again',
  });
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'frontmost target changed; observe again');
  assert.deepEqual(error.helper, { code: 'target-changed', execution: 'not-executed', retryable: true });
  assert.ok(Object.isFrozen(error.helper));
});

test('retryable is only true when the helper said so explicitly', () => {
  for (const retryable of [undefined, null, 'true', 1]) {
    const error = normalizeHelperError({ code: 'x', execution: 'dispatched', retryable, message: 'm' });
    assert.equal(error.helper.retryable, false, `retryable=${String(retryable)}`);
  }
});

test('a legacy string error is outcome-unknown, never safe to replay', () => {
  const error = normalizeHelperError('SendInput was blocked after 0/3 events');
  assert.equal(error.message, 'SendInput was blocked after 0/3 events');
  assert.deepEqual(error.helper, { code: 'legacy', execution: 'outcome-unknown', retryable: false });
});

test('a malformed object error falls back to legacy without inventing a verdict', () => {
  const cases = [
    { code: 'target-changed' }, // no execution
    { execution: 'not-executed' }, // no code
    { code: 'target-changed', execution: 'maybe', message: 'm' }, // unknown verdict
    { code: '   ', execution: 'not-executed', message: 'm' }, // blank code
    ['not', 'an', 'object'],
    42,
  ];
  for (const raw of cases) {
    const error = normalizeHelperError(raw);
    assert.equal(error.helper.code, 'legacy', JSON.stringify(raw));
    assert.equal(error.helper.execution, 'outcome-unknown', JSON.stringify(raw));
    assert.equal(error.helper.retryable, false, JSON.stringify(raw));
    assert.ok(error.message.length > 0, JSON.stringify(raw));
  }
});

test('the execution vocabulary is exactly the three contract verdicts', () => {
  assert.deepEqual([...HELPER_EXECUTIONS].sort(), ['dispatched', 'not-executed', 'outcome-unknown']);
});
