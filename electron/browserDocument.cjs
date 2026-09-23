'use strict';

const REFERENCE_RANGE = 1_000_000;
const STALE_DOCUMENT = 'The page changed since it was observed. Take a fresh snapshot before acting; do not replay the previous action.';
function createBrowserDocuments() {
  const records = new WeakMap();
  let sequence = 0;
  function reserveReferences() {
    const base = ++sequence * REFERENCE_RANGE;
    if (!Number.isSafeInteger(base + REFERENCE_RANGE)) throw new Error('Browser reference space exhausted. Restart the application.');
    return base;
  }
  function allocate(contents, needsObservation = false) {
    const referenceBase = reserveReferences();
    const record = { referenceBase, needsObservation, observedBy: new Set() };
    records.set(contents, record);
    return record;
  }
  function current(contents) { return records.get(contents) || allocate(contents); }
  function invalidate(contents, handback = false) {
    return allocate(contents, handback || records.get(contents)?.needsObservation === true);
  }
  function assertCurrent(contents, record) {
    if (contents.isDestroyed() || current(contents) !== record) throw new Error(STALE_DOCUMENT);
  }
  function assertObserved(contents, owner) {
    const record = current(contents);
    if (record.needsObservation && !record.observedBy.has(owner)) {
      throw new Error('The user handed this page back. Observe it with snapshot or another read tool before continuing. Do not replay prior actions.');
    }
  }
  function observed(contents, owner, record) {
    assertCurrent(contents, record);
    record.observedBy.add(owner);
  }
  return { current, invalidate, assertCurrent, assertObserved, observed, reserveReferences };
}
module.exports = { createBrowserDocuments, REFERENCE_RANGE, STALE_DOCUMENT };
