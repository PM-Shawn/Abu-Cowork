'use strict';

function assertPrivateTextEqual(actual, expected, failureMessage) {
  if (actual !== expected) throw new Error(failureMessage);
}

function keyboardLayoutSummary(expected, ctrlSelectAll) {
  return {
    characterCount: expected.length,
    characterCasesPassed: true,
    ctrlSelectAll,
  };
}

module.exports = { assertPrivateTextEqual, keyboardLayoutSummary };
