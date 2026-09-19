'use strict';

function runKey(conversationId, runId) {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.includes('\0')
      || typeof runId !== 'string' || !runId || runId === 'main' || runId.includes('\0')) {
    throw new Error('Invalid browser child-run identity');
  }
  return `${conversationId}\0${runId}`;
}

// Authorization contains only live records, not a bounded list of terminal
// identities. Unknown is denied. Trusted shell run ids are never reused within
// a renderer lifetime; reload revokes these records before another shell runs.
function createBrowserRunRegistry() {
  const active = new Map();
  const renderers = new WeakSet();
  function register(conversationId, runId) {
    const key = runKey(conversationId, runId);
    if (!active.has(key)) active.set(key, { conversationId, controller: new AbortController() });
  }
  function unregister(conversationId, runId) {
    const key = runKey(conversationId, runId);
    const record = active.get(key);
    active.delete(key); // revoke before abort listeners can call back
    record?.controller.abort();
  }
  function disposeConversation(conversationId) {
    for (const [key, record] of active) {
      if (record.conversationId !== conversationId) continue;
      active.delete(key);
      record.controller.abort();
    }
  }
  function clear() {
    const records = [...active.values()];
    active.clear();
    for (const record of records) record.controller.abort();
  }
  function bindRenderer(contents) {
    if (renderers.has(contents)) return;
    renderers.add(contents);
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) clear();
    });
    contents.on('render-process-gone', clear);
    contents.once('destroyed', clear);
  }
  function signalFor(payload, signal) {
    // Main-loop and legacy calls retain their existing execution identity.
    if (payload.runId === undefined || payload.runId === 'main') return signal;
    const record = active.get(runKey(payload.ownerId, payload.runId));
    if (!record) throw new Error('Browser child run is not active. Do not retry its browser actions or recreate its pages.');
    return signal ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal;
  }
  return { register, unregister, disposeConversation, clear, bindRenderer, signalFor, get size() { return active.size; } };
}

const browserRunRegistry = createBrowserRunRegistry();
module.exports = { createBrowserRunRegistry, browserRunRegistry };
