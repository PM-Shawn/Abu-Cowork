'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { enterDirectory, acquireWriteLock, run: runRegistry } = require('./pluginRegistryWorker.cjs');
const { run } = require('./pluginOperationWorker.cjs');
const { runAuthor } = require('./pluginAuthorWorker.cjs');

/** One worker holds the profile lease while main reads/decides and it mutates.
 * On parent death, synchronous mutations finish BEFORE IPC disconnect releases
 * the lease. A replacement main cannot read an older journal in that window.
 */
function createOperationSession(home) {
  let child, startup, closed = false, disposed = false, serial = 0, generation = 0;
  const pending = new Map();
  let exitPromise, anchors;
  function launch() {
    // Orphan the previous worker's callbacks: after a reopen its late 'error'
    // or 'exit' must not close the session that replaced it, nor reject the
    // new generation's in-flight calls.
    const mine = ++generation;
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      const worker = spawn(process.execPath, [__filename], { cwd: home, env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      child = worker;
      exitPromise = new Promise(done => worker.once('exit', done));
      let message = '', admitted = false;
      worker.stderr.on('data', bytes => { message = (message + bytes.toString()).slice(-4096); });
      worker.on('message', value => {
        if (value?.ready) { admitted = true; anchors = value.anchors; resolve(); return; }
        const callback = pending.get(value?.id);
        if (!callback) return;
        pending.delete(value.id);
        value.error ? callback.reject(new Error(value.error)) : callback.resolve(value.result);
      });
      const failed = error => {
        if (mine !== generation) return;
        if (admitted) closed = true;
        reject(error);
        for (const callback of pending.values()) callback.reject(error);
        pending.clear();
      };
      worker.once('error', failed);
      worker.once('exit', () => failed(new Error(message || 'Plugin operation: session interrupted')));
    });
  }
  /** A worker death is a transient fault, not a terminal one: the journal keeps
   * the on-disk state recoverable, and a dead worker's PID no longer holds the
   * lease. Without this the plugins tab's retry button re-awaits the cached
   * rejected startup and can never succeed. Refuse while calls are in flight
   * (their results would be attributed to the wrong worker) and after an
   * intentional shutdown. */
  function reopen() {
    if (disposed || pending.size) return false;
    if (!closed) return true;
    generation++;
    closed = false; startup = undefined; child = undefined;
    exitPromise = undefined; anchors = undefined;
    return true;
  }
  function ready() {
    if (closed) return Promise.reject(new Error('Plugin operation: session closed'));
    startup ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        try { await launch(); return; }
        catch (error) {
          if (closed || attempt >= 30 || !error.message.includes('another write is active')) {
            closed = true; throw error;
          }
          // A former worker may be finishing its synchronous write after its
          // parent died. Wait for its lease, then acquire before any main read.
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    })();
    return startup;
  }
  async function send(kind, { home: _home, ...input }) {
      await ready();
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        child.send({ id, input, kind }, error => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
  }
  return {
    ready,
    reopen,
    get pid() { return child?.pid; },
    get anchors() { return anchors; },
    mutate: input => send('operation', input),
    registry: input => send('registry', input),
    author: input => send('author', input),
    async close() {
      disposed = true;
      closed = true;
      if (!child) return;
      if (child.connected) child.disconnect();
      await exitPromise;
    },
  };
}

function serve() {
  const home = process.cwd();
  const identity = fs.statSync('.');
  const reset = () => {
    process.chdir(home);
    const actual = fs.statSync('.');
    if (identity.ino !== actual.ino || identity.dev !== actual.dev) throw new Error('Plugin operation: profile changed');
  };
  enterDirectory('.abu', true);
  const abu = fs.statSync('.');
  enterDirectory('plugin-operations', true);
  const operations = fs.statSync('.');
  const release = acquireWriteLock();
  reset();
  const verifyLease = () => {
    reset();
    for (const [name, expected] of [['.abu', abu], ['plugin-operations', operations]]) {
      try { enterDirectory(name, false); }
      catch { throw new Error('Plugin operation: lease directory changed'); }
      const actual = fs.statSync('.');
      if (expected.ino !== actual.ino || expected.dev !== actual.dev) throw new Error('Plugin operation: lease directory changed');
    }
  };
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    try {
      verifyLease();
      release();
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
    if (process.connected) process.disconnect();
  };
  process.on('disconnect', finish);
  process.on('message', value => {
    if (ended) return;
    const reply = { id: value?.id };
    try {
      if (!value || Buffer.byteLength(JSON.stringify(value)) > (value?.input?.action === 'tree' ? 300 : 13) * 1024 * 1024) throw new Error('Plugin operation: oversized mutation');
      verifyLease(); reset();
      if (value.kind === 'operation') run(value.input);
      else if (value.kind === 'registry') runRegistry(value.input);
      else if (value.kind === 'author') reply.result = runAuthor(value.input);
      else throw new Error('Plugin operation: unsupported session action');
      verifyLease(); reset();
    } catch (error) { reply.error = error.message; }
    if (process.connected) process.send(reply, () => {});
  });
  process.send({ ready: true, anchors: { abu: { ino: abu.ino, dev: abu.dev }, operations: { ino: operations.ino, dev: operations.dev } } });
}
if (require.main === module) {
  try { serve(); }
  catch (error) { process.stderr.write(error.message); process.exitCode = 1; if (process.connected) process.disconnect(); }
}
module.exports = { createOperationSession };
