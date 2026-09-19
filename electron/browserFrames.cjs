'use strict';
const { runCancellableAction } = require('./browserActionCancellation.cjs');

// Native frame/loader identities, never iframe src attributes supplied by a page.
// One context per document; no write is replayed when a context disappears.
function createBrowserFrames({ documents, runtimeSource }) {
  const pages = new WeakMap();
  const attachments = new WeakMap();
  const listings = new WeakMap();
  const originOf = (value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; }
  };
  function attach(contents) {
    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    let connection = attachments.get(contents);
    if (!connection) {
      connection = { sessions: new Map(), pending: new Map(), contexts: new Map(), epoch: 0 };
      attachments.set(contents, connection);
      dbg.on('detach', () => {
        connection.epoch++; connection.sessions.clear(); connection.pending.clear(); connection.contexts.clear();
        pages.delete(contents); listings.delete(contents);
      });
      dbg.on('message', (_event, method, params, sessionId) => {
        const prefix = `${sessionId || 'root'}:`;
        if (method === 'Runtime.executionContextCreated') connection.contexts.set(prefix + params.context.id, params.context);
        if (method === 'Runtime.executionContextDestroyed') connection.contexts.delete(prefix + params.executionContextId);
        if (method === 'Runtime.executionContextsCleared') {
          for (const key of connection.contexts.keys()) if (key.startsWith(prefix)) connection.contexts.delete(key);
        }
        if (method === 'Target.detachedFromTarget') {
          for (const [target, session] of connection.sessions) {
            if (session === params?.sessionId) connection.sessions.delete(target);
          }
        }
      });
    }
    return connection;
  }
  async function sessionFor(contents, frameId, check) {
    const connection = attach(contents);
    const { sessions, pending, epoch } = connection;
    if (sessions.has(frameId)) return sessions.get(frameId);
    let ready = pending.get(frameId);
    if (!ready) {
      ready = (async () => {
        let info;
        try { info = await contents.debugger.sendCommand('Target.getTargetInfo', { targetId: frameId }); }
        catch { check(); return undefined; } // An in-process frame has no Target.
        check();
        if (info.targetInfo?.type !== 'iframe') return undefined;
        const result = await contents.debugger.sendCommand('Target.attachToTarget', { targetId: frameId, flatten: true });
        try {
          check();
          if (connection.epoch !== epoch) throw new Error('Browser frame connection changed');
          if (!result.sessionId) throw new Error('Embedded region has no execution session');
          sessions.set(frameId, result.sessionId);
          return result.sessionId;
        } catch (error) {
          // A late ACK must not leak a session after cancellation/handback.
          if (result.sessionId) {
            try { await contents.debugger.sendCommand('Target.detachFromTarget', { sessionId: result.sessionId }); } catch { /* target/connection already gone */ }
          }
          throw error;
        }
      })();
      pending.set(frameId, ready);
    }
    try { const session = await ready; check(); return session; }
    finally { if (pending.get(frameId) === ready) pending.delete(frameId); }
  }
  async function list(contents, beforeDispatch = () => {}) {
    beforeDispatch();
    const document = documents.current(contents);
    let current = listings.get(contents);
    if (!current || current.document !== document) {
      current = { document, promise: scan(contents, beforeDispatch) };
      listings.set(contents, current);
    }
    try {
      const result = await current.promise;
      beforeDispatch(); documents.assertCurrent(contents, document);
      return result;
    } finally { if (listings.get(contents) === current) listings.delete(contents); }
  }
  async function scan(contents, beforeDispatch = () => {}) {
    const document = documents.current(contents);
    beforeDispatch();
    const connection = attach(contents); const epoch = connection.epoch;
    const check = () => {
      beforeDispatch(); documents.assertCurrent(contents, document);
      if (connection.epoch !== epoch) throw new Error('Browser frame connection changed');
    };
    check();
    const response = await contents.debugger.sendCommand('Page.getFrameTree'); check();
    if (!response.frameTree?.frame) throw new Error('Browser returned no native frame tree');
    const targets = await contents.debugger.sendCommand('Target.getTargets'); check();
    const remoteFrames = (targets.targetInfos || []).filter(target => target.type === 'iframe');
    let page = pages.get(contents);
    if (page?.document !== document) { page = { document, records: new Map() }; pages.set(contents, page); }
    const rows = []; const live = new Set(); const seen = new Set();
    const visit = async (tree, parentFrameId, depth) => {
      check();
      if (depth > 8 || rows.length >= 64 || seen.has(tree.frame.id)) return;
      const frame = tree.frame; seen.add(frame.id);
      let record = page.records.get(frame.id);
      if (!record || record.loaderId !== frame.loaderId) {
        const referenceBase = documents.reserveReferences();
        record = { nativeId: frame.id, loaderId: frame.loaderId, frameId: parentFrameId ? `f${referenceBase + 1}` : 'f0', referenceBase };
        page.records.set(frame.id, record);
      }
      live.add(frame.id);
      // securityOrigin includes opaque/sandbox origins; URL alone cannot grant.
      record.origin = originOf(frame.securityOrigin);
      record.url = frame.url;
      rows.push({ frameId: record.frameId, ...(parentFrameId ? { parentFrameId } : {}), origin: record.origin,
        url: record.url, accessible: record.origin !== null,
        sameOriginAsTop: record.origin !== null && record.origin === originOf(response.frameTree.frame.securityOrigin),
        ...(record.origin === null ? { inaccessibleReason: 'not-a-web-page' } : {}) });
      let children = tree.childFrames || [];
      if (parentFrameId) {
        record.sessionId = await sessionFor(contents, frame.id, check); check();
        if (record.sessionId) {
          const subtree = await contents.debugger.sendCommand('Page.getFrameTree', {}, record.sessionId); check();
          if (subtree.frameTree?.frame?.id !== frame.id || subtree.frameTree.frame.loaderId !== frame.loaderId) {
            throw new Error('Embedded region changed. Observe the page again.');
          }
          children = subtree.frameTree.childFrames || [];
        }
      }
      for (const child of children) await visit(child, record.frameId, depth + 1);
      // Page.getFrameTree omits out-of-process children in Chromium. Target's
      // native parentFrameId connects only this page's descendants; never use
      // a URL match or return unrelated target metadata to the caller.
      for (const target of remoteFrames) {
        if (target.parentFrameId !== frame.id || seen.has(target.targetId)) continue;
        const sessionId = await sessionFor(contents, target.targetId, check); check();
        if (!sessionId) throw new Error('Embedded region execution session is unavailable');
        const subtree = await contents.debugger.sendCommand('Page.getFrameTree', {}, sessionId); check();
        if (subtree.frameTree?.frame?.id !== target.targetId) throw new Error('Embedded region identity changed');
        await visit(subtree.frameTree, record.frameId, depth + 1);
      }
    };
    await visit(response.frameTree, null, 0); check();
    for (const key of page.records.keys()) if (!live.has(key)) page.records.delete(key);
    return rows;
  }
  function resolve(contents, frameId) {
    const page = pages.get(contents);
    if (!page || page.document !== documents.current(contents)) throw new Error('Embedded region changed. Get a fresh frame list before acting.');
    const record = [...page.records.values()].find(frame => frame.frameId === frameId);
    if (!record || !record.origin) throw new Error('Embedded region is unavailable or has an opaque origin. Nothing was changed.');
    return record;
  }
  async function run(contents, frameId, action, payload, beforeDispatch, signal) {
    const record = resolve(contents, frameId);
    const check = () => {
      beforeDispatch();
      if (resolve(contents, frameId) !== record) throw new Error('Embedded region changed. Do not replay the previous action.');
      if (!payload.expectedOrigin || payload.expectedOrigin !== record.origin) throw new Error('This embedded region needs its own approved origin.');
    };
    check();
    const evaluate = async (expression, enforceCurrent = true) => {
      if (enforceCurrent) check();
      const result = await contents.debugger.sendCommand('Runtime.evaluate', {
        expression, uniqueContextId: record.uniqueContextId, returnByValue: true, awaitPromise: true,
      }, record.sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Embedded region execution failed');
      return result.result?.value;
    };
    if (!record.ready) {
      record.ready = (async () => {
        const connection = attach(contents);
        await contents.debugger.sendCommand('Runtime.enable', {}, record.sessionId); check();
        const world = await contents.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: record.nativeId, worldName: `abu-browser-${record.referenceBase}`, grantUniveralAccess: false,
        }, record.sessionId); check();
        record.contextId = world.executionContextId;
        const context = connection.contexts.get(`${record.sessionId || 'root'}:${record.contextId}`);
        if (!context?.uniqueId || context.auxData?.frameId !== record.nativeId
          || context.name !== `abu-browser-${record.referenceBase}`) {
          throw new Error('Embedded region execution context is unavailable');
        }
        record.uniqueContextId = context.uniqueId;
        await evaluate(`globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__ = { referenceBase: ${record.referenceBase}, nativeFrames: true };\n${runtimeSource()}`);
        check();
      })();
    }
    try { await record.ready; } catch (error) { record.ready = null; throw error; }
    check();
    return runCancellableAction({ action, payload: { ...payload, frameId, __abuFrameId: frameId },
      referenceBase: record.referenceBase, dispatch: evaluate, signal });
  }
  return { list, resolve, run, attached: (contents) => attachments.has(contents) && contents.debugger.isAttached() };
}
module.exports = { createBrowserFrames };
