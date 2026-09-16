'use strict';

// CDP uses a separate session for out-of-process iframes. Arm each before
// resuming it; never send a node id from one session to another session.
function createBrowserFileChoosers() {
  const records = new WeakMap();
  function enable(contents) {
    const old = records.get(contents);
    if (old) return old.ready;
    const dbg = contents.debugger;
    const record = { held: true, pending: new Set(), sessions: new Set(), failure: null };
    records.set(contents, record);
    const assertHeld = () => { if (!record.held) throw new Error('Browser file chooser control was released'); };
    const arm = async (sessionId) => {
      assertHeld();
      if (sessionId) await dbg.sendCommand('Page.enable', {}, sessionId);
      assertHeld();
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true }, sessionId);
      assertHeld();
      await dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      }, sessionId);
      assertHeld();
    };
    const message = (_event, method, params) => {
      if (method === 'Target.detachedFromTarget') {
        record.sessions.delete(params?.sessionId);
        return;
      }
      if (method !== 'Target.attachedToTarget' || !params?.sessionId) return;
      const sessionId = params.sessionId;
      record.sessions.add(sessionId);
      const pending = (async () => {
        try {
          if (params.targetInfo?.type === 'iframe') await arm(sessionId);
          if (record.held && record.sessions.has(sessionId)) {
            await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId);
          }
        } catch (error) {
          // A detached frame cannot open a picker. A live unguarded frame must
          // remain paused until explicit user takeover detaches the debugger;
          // resuming it here would let delayed page scripts bypass the guard.
          if (record.held && record.sessions.has(sessionId)) record.failure = error;
        }
      })();
      record.pending.add(pending);
      void pending.finally(() => record.pending.delete(pending));
    };
    record.message = message;
    dbg.on('message', message);
    const detached = () => release(contents);
    record.detached = detached;
    dbg.on('detach', detached);
    record.ready = (async () => {
      await arm(undefined);
      while (record.pending.size) await Promise.all([...record.pending]);
      assertHeld();
      if (record.failure) throw record.failure;
    })();
    return record.ready;
  }
  function release(contents) {
    const record = records.get(contents);
    if (!record) return;
    record.held = false;
    records.delete(contents);
    contents.debugger.removeListener?.('message', record.message);
    contents.debugger.removeListener?.('detach', record.detached);
  }
  function assertReady(contents) {
    const record = records.get(contents);
    if (record?.failure) throw new Error(`Browser file chooser interception failed: ${String(record.failure)}. Stop automation and let the user take over.`);
  }
  return { enable, release, assertReady, held: (contents) => records.has(contents) };
}
module.exports = { createBrowserFileChoosers };
