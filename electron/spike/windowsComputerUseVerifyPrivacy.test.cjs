'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPrivateTextEqual,
  keyboardLayoutSummary,
} = require('./windowsComputerUseVerifyPrivacy.cjs');

test('failed private text checks expose only the fixed diagnostic', () => {
  const failureMessage = 'keyboard verification failed';
  assert.throws(
    () => assertPrivateTextEqual(
      'private observed UIA value',
      'private expected fixture value',
      failureMessage,
    ),
    (error) => {
      assert.equal(error.message === failureMessage, true);
      return true;
    },
  );
});

test('keyboard layout summaries expose coverage without typed characters', () => {
  const privateFixture = 'private typed fixture';
  const summary = keyboardLayoutSummary(privateFixture, true);
  assert.equal(JSON.stringify(summary).includes(privateFixture), false);
  assert.equal(summary.characterCount, privateFixture.length);
  assert.equal(summary.characterCasesPassed, true);
  assert.equal(summary.ctrlSelectAll, true);
});
