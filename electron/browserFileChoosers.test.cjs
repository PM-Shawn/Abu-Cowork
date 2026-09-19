'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserFileChoosers } = require('./browserFileChoosers.cjs');
function fixture() {
  const debugger_ = new EventEmitter(); const calls = [];
  debugger_.sendCommand = async (method, params, sessionId) => { calls.push({ method, params, sessionId }); };
  return { contents: { debugger: debugger_ }, calls, debugger_ };
}
test('root and OOPIF guards cancel all chooser types before resuming a frame', async () => {
  const { contents, calls, debugger_ } = fixture(); const guard = createBrowserFileChoosers();
  await guard.enable(contents);
  debugger_.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const root = calls.find((c) => c.method === 'Page.setInterceptFileChooserDialog' && !c.sessionId);
  assert.deepEqual(root.params, { enabled: true, cancel: true });
  const child = calls.filter((c) => c.sessionId === 'child');
  assert.deepEqual(child.map((c) => c.method), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  assert.deepEqual(child[1].params, { enabled: true, cancel: true });
  assert.equal(guard.held(contents), true);
  guard.release(contents);
  assert.equal(guard.held(contents), false);
});
test('release during initialization cannot rearm chooser control later', async () => {
  const { contents, debugger_, calls } = fixture(); const guard = createBrowserFileChoosers();
  let resume;
  debugger_.sendCommand = (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    return new Promise((resolve) => { resume = resolve; });
  };
  const pending = guard.enable(contents); const refused = assert.rejects(pending, /released/);
  guard.release(contents); resume(); await refused;
  assert.deepEqual(calls.map((c) => c.method), ['Page.setInterceptFileChooserDialog']);
});
test('an unsupported child guard surfaces failure instead of permitting later automation', async () => {
  const { contents, debugger_, calls } = fixture(); const guard = createBrowserFileChoosers();
  await guard.enable(contents);
  debugger_.sendCommand = async (method, _params, sessionId) => {
    calls.push({method, sessionId});
    if (sessionId && method === 'Page.setInterceptFileChooserDialog') throw new Error('unsupported');
  };
  debugger_.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.throws(() => guard.assertReady(contents), /interception failed/);
  assert.equal(calls.some(c => c.method === 'Runtime.runIfWaitingForDebugger'), false, 'live unguarded frame stays paused');
});

test('a detached iframe initialization failure does not poison the surviving page', async () => {
  const { contents, debugger_ } = fixture(); const guard = createBrowserFileChoosers();
  await guard.enable(contents);
  let rejectCommand;
  debugger_.sendCommand = () => new Promise((_resolve, reject) => { rejectCommand = reject; });
  debugger_.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'old', targetInfo: { type: 'iframe' } });
  debugger_.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'old' });
  rejectCommand(new Error('Session with given id not found'));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.doesNotThrow(() => guard.assertReady(contents));
});
