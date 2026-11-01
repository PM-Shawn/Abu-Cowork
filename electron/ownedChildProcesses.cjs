'use strict';

function createOwnedChildProcesses({ timeoutMs = 10000 } = {}) {
  const entries = new Set();
  let closing = false;

  function assertAdmission() {
    if (closing) throw new Error('Application is exiting');
  }

  function track(child, stop) {
    let resolve;
    const closed = new Promise(done => { resolve = done; });
    trackCompletion(closed, stop, `child ${child.pid}`);
    child.once('close', resolve);
  }

  function trackCompletion(closed, stop, label = 'child process') {
    const entry = { stop, closed, label };
    entries.add(entry);
    void closed.then(() => {
      entries.delete(entry);
    });
  }

  async function shutdown() {
    closing = true;
    const pending = [...entries];
    const startedAt = performance.now();
    console.log(`[exit] closing ${pending.length} child processes`);
    for (const entry of pending) entry.stop();
    // Keep Node's event loop alive until its process-exit callbacks have run.
    // Closing live process handles during FreeEnvironment can block on Windows.
    let timer;
    try {
      await Promise.race([
        Promise.all(pending.map(entry => entry.closed)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const waiting = pending.filter(entry => entries.has(entry)).map(entry => entry.label);
            reject(new Error(`ABU_EXIT_CHILD_TIMEOUT: ${waiting.join(', ')}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      console.log(`[exit] child process wait ended after ${Math.round(performance.now() - startedAt)}ms; remaining=${pending.filter(entry => entries.has(entry)).length}`);
    }
  }

  return { assertAdmission, track, trackCompletion, shutdown, resume() { closing = false; } };
}

module.exports = { createOwnedChildProcesses, ownedChildProcesses: createOwnedChildProcesses() };
