'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDocuments, REFERENCE_RANGE } = require('./browserDocument.cjs');
const page = () => ({ isDestroyed: () => false });
test('document and tab references never overlap or revive after invalidation', () => {
  const docs = createBrowserDocuments(); const one = page(); const two = page();
  const old = docs.current(one); const other = docs.current(two); const next = docs.invalidate(one);
  assert.ok(other.referenceBase >= old.referenceBase + REFERENCE_RANGE);
  assert.ok(next.referenceBase >= other.referenceBase + REFERENCE_RANGE);
  assert.throws(() => docs.assertCurrent(one, old), /page changed/);
  docs.assertCurrent(one, next);
});
test('handback requires each run to observe the current document, even after navigation', () => {
  const docs = createBrowserDocuments(); const tab = page();
  docs.assertObserved(tab, 'one');
  const returned = docs.invalidate(tab, true);
  assert.throws(() => docs.assertObserved(tab, 'one'), /Observe/);
  docs.observed(tab, 'one', returned); docs.assertObserved(tab, 'one');
  assert.throws(() => docs.assertObserved(tab, 'two'), /Observe/);
  docs.invalidate(tab);
  assert.throws(() => docs.assertObserved(tab, 'one'), /Observe/);
  assert.throws(() => docs.observed(tab, 'one', returned), /page changed/);
});
