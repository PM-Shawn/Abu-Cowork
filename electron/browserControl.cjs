'use strict';

const USER_CONTROL = 'The user has taken control of this page. Stop browser actions and wait for the user to hand it back; then observe the page again.';

// Only the trusted application toolbar calls take/release. Page input and
// transport payloads cannot create a control grant. State is per native opener
// family: a same-origin sibling can otherwise drive a page through its opener.
function createBrowserControl({ familyFor, onChange = () => {}, prepare = async () => {}, finalize = async () => {} }) {
  const states = new WeakMap();
  const operations = new WeakMap();
  function state(contents) {
    return [...familyFor(contents)].map((member) => states.get(member)).find((entry) => entry && entry.phase !== 'ai')
      || states.get(contents);
  }
  function phase(contents) { return state(contents)?.phase || 'ai'; }
  function acquire(contents, externalSignal) {
    if (phase(contents) !== 'ai') throw new Error(USER_CONTROL);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    let taken = false;
    const entry = { abort: () => { taken = true; abort(); }, done };
    const entries = operations.get(contents) || new Set();
    entries.add(entry);
    operations.set(contents, entries);
    return {
      signal: controller.signal,
      assert({ allowExternalAbort = false } = {}) {
        if (taken || phase(contents) !== 'ai') throw new Error(USER_CONTROL + ' An action already sent to the page may have taken effect; do not replay it.');
        if (controller.signal.aborted && !allowExternalAbort) throw new Error('Browser action cancelled because the run was stopped. An action already sent may have taken effect; do not replay it.');
      },
      end() {
        externalSignal?.removeEventListener('abort', abort);
        entries.delete(entry);
        if (!entries.size) operations.delete(contents);
        settle();
      },
    };
  }
  function publish(members, record) {
    for (const member of members) {
      states.set(member, record);
      if (!member.isDestroyed()) onChange(member, record.phase);
    }
  }
  async function take(contents) {
    const existing = state(contents);
    if (existing?.phase === 'human') return 'human';
    if (existing?.phase === 'yielding' && existing.completion) return existing.completion;
    const members = [...familyFor(contents)];
    const record = { phase: 'yielding', popupDenied: false };
    // Freeze before aborting: abort listeners can synchronously attempt work.
    publish(members, record);
    const pending = members.flatMap((member) => [...(operations.get(member) || [])]);
    for (const operation of pending) operation.abort();
    const failure = new Promise((_, reject) => { record.fail = reject; });
    const drain = prepare(members).then(() => Promise.all(pending.map((operation) => operation.done))).then(() => finalize(members)).then(() => {
      if (states.get(contents) !== record || record.phase !== 'yielding') return phase(contents);
      record.phase = 'human';
      publish(members, record);
      return 'human';
    });
    record.completion = Promise.race([drain, failure]).catch((error) => {
      record.phase = 'yield-failed';
      record.completion = null;
      publish(members, record);
      throw error;
    });
    return record.completion;
  }
  function release(contents) {
    const current = state(contents);
    if (current && current.phase !== 'ai' && current.phase !== 'human') throw new Error('The current browser action is still finishing. Wait before handing the page back.');
    if (current) current.phase = 'ai';
    publish([...familyFor(contents)], { phase: 'ai' });
    return 'ai';
  }
  function manualTicket(contents, owner, confirm) {
    const record = state(contents);
    if (!record || record.phase !== 'human' || record.popupDenied) return null;
    const valid = () => !contents.isDestroyed() && state(contents) === record && record.phase === 'human';
    let accepted = false;
    try { accepted = confirm() === true; } catch { /* Native dialog unavailable: deny. */ }
    if (!accepted || !valid()) { record.popupDenied = true; return null; }
    return { source: contents, owner, origin: null, valid };
  }
  function inherit(source, child) {
    const record = state(source);
    if (record) publish([child], record);
  }
  function fail(contents, error) {
    const record = state(contents);
    if (record?.phase === 'yielding') record.fail?.(error);
  }
  return { phase, acquire, take, release, manualTicket, inherit, fail };
}

module.exports = { createBrowserControl, USER_CONTROL };
