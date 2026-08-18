'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const {
  MAX_PENDING_SHELL_CRASHES,
  SHELL_CRASH_EVENT,
  __resetForTest,
  flushPendingShellCrashReports,
  initShellCrashChannel,
  reportShellCrash,
} = require('./shellCrashChannel.cjs');

/**
 * Stand-in for tauriHost.emitEvent: returns the number of live subscribers,
 * which is 0 until the renderer's `runtime-crash` listener exists.
 */
function makeEmitter() {
  const sent = [];
  let subscribers = 0;
  return {
    sent,
    subscribe() { subscribers += 1; },
    emit: (event, payload) => {
      if (subscribers === 0) return 0;
      sent.push({ event, payload });
      return subscribers;
    },
  };
}

beforeEach(() => __resetForTest());

test('a crash observed before any subscriber exists is delivered on subscribe', () => {
  const emitter = makeEmitter();
  initShellCrashChannel({ emit: emitter.emit });

  // Crash observers are installed at main-module load; the renderer subscriber
  // only appears after preload + page load + React mount.
  assert.equal(reportShellCrash({ kind: 'main_uncaught_exception', errorType: 'typeerror' }), 0);
  assert.deepEqual(emitter.sent, []);

  emitter.subscribe();
  assert.equal(flushPendingShellCrashReports(), 1);
  assert.deepEqual(emitter.sent, [{
    event: SHELL_CRASH_EVENT,
    payload: { kind: 'main_uncaught_exception', errorType: 'typeerror' },
  }]);

  // Flushing again must not re-deliver an already-reported crash.
  assert.equal(flushPendingShellCrashReports(), 0);
  assert.equal(emitter.sent.length, 1);
});

test('queued crashes flush in arrival order once a subscriber appears', () => {
  const emitter = makeEmitter();
  initShellCrashChannel({ emit: emitter.emit });

  reportShellCrash({ kind: 'main_uncaught_exception', errorType: 'first' });
  reportShellCrash({ kind: 'main_unhandled_rejection', errorType: 'second' });
  emitter.subscribe();

  assert.equal(flushPendingShellCrashReports(), 2);
  assert.deepEqual(emitter.sent.map((entry) => entry.payload.errorType), ['first', 'second']);
});

test('a crash observed while a subscriber is live goes straight out', () => {
  const emitter = makeEmitter();
  initShellCrashChannel({ emit: emitter.emit });
  emitter.subscribe();

  assert.equal(reportShellCrash({ kind: 'renderer_process_gone', errorType: 'oom' }), 1);
  assert.equal(emitter.sent.length, 1);
  assert.equal(flushPendingShellCrashReports(), 0);
});

test('the queue is bounded, dropping the oldest crash first', () => {
  const emitter = makeEmitter();
  initShellCrashChannel({ emit: emitter.emit });

  // A crash loop with no renderer must not grow this queue without bound; the
  // local jsonl log keeps every record regardless of what is dropped here.
  for (let index = 0; index < MAX_PENDING_SHELL_CRASHES + 3; index++) {
    reportShellCrash({ kind: 'main_uncaught_exception', errorType: `crash-${index}` });
  }
  emitter.subscribe();
  flushPendingShellCrashReports();

  assert.equal(emitter.sent.length, MAX_PENDING_SHELL_CRASHES);
  assert.deepEqual(
    emitter.sent.map((entry) => entry.payload.errorType),
    ['crash-3', 'crash-4', 'crash-5', 'crash-6', 'crash-7'],
  );
});

test('a throwing transport keeps the crash queued instead of escalating', () => {
  initShellCrashChannel({
    emit: () => { throw new Error('renderer transport is gone'); },
  });

  assert.doesNotThrow(() => reportShellCrash({ kind: 'main_uncaught_exception' }));

  const emitter = makeEmitter();
  initShellCrashChannel({ emit: emitter.emit });
  emitter.subscribe();
  assert.equal(flushPendingShellCrashReports(), 1);
});

test('crashes queue harmlessly when no transport is wired at all', () => {
  assert.doesNotThrow(() => reportShellCrash({ kind: 'main_uncaught_exception' }));
  assert.equal(flushPendingShellCrashReports(), 0);
});
