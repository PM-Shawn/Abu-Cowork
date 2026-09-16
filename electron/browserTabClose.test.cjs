'use strict';
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');
const { requestBrowserTabClose } = require('./browserTabClose.cjs');

function fixture(action) {
  const contents = new EventEmitter();
  let calls = 0;
  contents.close = (options) => {
    calls += 1;
    assert.deepEqual(options, { waitForBeforeUnload: true });
    action?.(contents);
  };
  return { contents, calls: () => calls };
}

test('only removes the tab after native destruction', async () => {
  const { contents } = fixture((wc) => wc.emit('destroyed'));
  let removed = 0;
  assert.deepEqual(await requestBrowserTabClose(contents, () => removed++), { status: 'closed' });
  assert.equal(removed, 1);
  assert.equal(contents.listenerCount('will-prevent-unload'), 0);
});

test('preserves a page that vetoes unloading without overriding its veto', async () => {
  let forced = false;
  const { contents } = fixture((wc) => wc.emit('will-prevent-unload', { preventDefault: () => { forced = true; } }));
  let removed = false;
  assert.equal((await requestBrowserTabClose(contents, () => { removed = true; })).status, 'requires_user_action');
  assert.equal(forced, false);
  assert.equal(removed, false);
  assert.equal(contents.listenerCount('destroyed'), 0);
});

test('a slow close is not retried and a late native completion still removes the tab once', async () => {
  const { contents, calls } = fixture();
  let timeout;
  let removed = 0;
  const first = requestBrowserTabClose(contents, () => removed++, { schedule: (fn) => { timeout = fn; return 1; }, unschedule: () => {} });
  assert.equal(requestBrowserTabClose(contents, () => assert.fail('second callback')), first);
  timeout();
  assert.equal((await first).status, 'closing');
  assert.equal(requestBrowserTabClose(contents, () => assert.fail('third callback')), first);
  assert.equal(calls(), 1);
  contents.emit('destroyed');
  assert.equal(removed, 1);
  assert.equal(contents.listenerCount('destroyed'), 0);
});

test('a synchronous native error leaves the tab record intact', async () => {
  const { contents } = fixture(() => { throw new Error('native failure'); });
  const result = await requestBrowserTabClose(contents, () => assert.fail('must retain'));
  assert.equal(result.status, 'requires_user_action');
  assert.equal(contents.listenerCount('destroyed'), 0);
});

test('a veto arriving after the waiting deadline still retains the page', async () => {
  const { contents } = fixture();
  let timeout;
  let retained = 0;
  const closing = requestBrowserTabClose(contents, () => assert.fail('must not remove'), {
    onRetained: () => retained++,
    schedule: (fn) => { timeout = fn; return 1; },
    unschedule: () => {},
  });
  timeout();
  assert.equal((await closing).status, 'closing');
  contents.emit('will-prevent-unload');
  assert.equal(retained, 1);
  assert.equal(contents.listenerCount('destroyed'), 0);
});
