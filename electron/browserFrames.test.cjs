'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserDocuments } = require('./browserDocument.cjs');
const { createBrowserFrames } = require('./browserFrames.cjs');
function fixture() {
  const documents = createBrowserDocuments();
  const dbg = new EventEmitter(); const calls = [];
  const child = { id: 'child', parentId: 'main', loaderId: 'one', url: 'https://form.example/entry', securityOrigin: 'https://form.example' };
  const main = { id: 'main', loaderId: 'root', url: 'https://host.example/', securityOrigin: 'https://host.example' };
  dbg.isAttached = () => true;
  dbg.sendCommand = async (method, params, session) => {
    calls.push({ method, params, session });
    if (method === 'Page.getFrameTree') return {frameTree: session ? {frame: child} : {frame: main, childFrames: [{frame: child}]}};
    if (method === 'Target.getTargetInfo') return {targetInfo: {type: 'iframe'}};
    if (method === 'Target.attachToTarget') return {sessionId: 'child-session'};
    if (method === 'Page.createIsolatedWorld') {
      dbg.emit('message', {}, 'Runtime.executionContextCreated', {context: {id:42, uniqueId:'unique-child', name:params.worldName, auxData:{frameId:params.frameId}}}, session);
      return {executionContextId: 42};
    }
    if (method === 'Runtime.evaluate') return {result: {value: 'done'}};
    return {};
  };
  const contents = {debugger: dbg, isDestroyed: () => false};
  const frames = createBrowserFrames({documents, runtimeSource: () => '/* audited runtime */'});
  return {contents, documents, frames, child, calls};
}
test('listing reads native metadata, not page content or guessed iframe src', async () => {
  const f = fixture(); const rows = await f.frames.list(f.contents);
  assert.equal(rows[1].origin, 'https://form.example');
  assert.equal(rows[1].accessible, true);
  assert.equal(f.calls.some(call => call.method === 'Runtime.evaluate'), false);
  assert.equal(f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog'), false);
});
test('cross-origin writes require the exact region grant and dispatch in its isolated session', async () => {
  const f = fixture(); const [, region] = await f.frames.list(f.contents);
  await assert.rejects(f.frames.run(f.contents, region.frameId, 'fill', {expectedOrigin:'https://host.example'}, () => {}), /approved origin/);
  assert.equal(f.calls.some(call => call.method === 'Runtime.evaluate'), false);
  const result = await f.frames.run(f.contents, region.frameId, 'fill', {expectedOrigin:region.origin}, () => {});
  assert.equal(result, 'done');
  const writes = f.calls.filter(call => call.method === 'Runtime.evaluate');
  assert.equal(writes.length, 2);
  assert.equal(writes.every(call => call.session === 'child-session' && call.params.uniqueContextId === 'unique-child'), true);
  assert.match(writes[1].params.expression, /__abuFrameId/);
});
test('loader replacement never reuses the old frame identity, even without a host navigation event', async () => {
  const f = fixture(); const [, old] = await f.frames.list(f.contents);
  f.child.loaderId = 'two';
  const [, current] = await f.frames.list(f.contents);
  assert.notEqual(current.frameId, old.frameId);
  assert.throws(() => f.frames.resolve(f.contents, old.frameId), /unavailable/);
});
test('opaque native origin cannot be authorized through a plausible URL', async () => {
  const f = fixture(); f.child.securityOrigin = 'null';
  const [, region] = await f.frames.list(f.contents);
  assert.equal(region.accessible, false);
  assert.equal(region.origin, null);
  assert.throws(() => f.frames.resolve(f.contents, region.frameId), /opaque/);
});
test('cancel during isolated world creation never dispatches the action or retries it', async () => {
  const f = fixture(); const [, region] = await f.frames.list(f.contents);
  const send = f.contents.debugger.sendCommand;
  let stopped = false;
  f.contents.debugger.sendCommand = async (...args) => {
    const result = await send(...args);
    if (args[0] === 'Page.createIsolatedWorld') stopped = true;
    return result;
  };
  await assert.rejects(f.frames.run(f.contents, region.frameId, 'click', {expectedOrigin:region.origin}, () => {
    if (stopped) throw new Error('stopped');
  }), /stopped/);
  assert.equal(f.calls.some(call => call.method === 'Runtime.evaluate'), false);
});
test('document invalidation rejects saved frame handles before dispatch', async () => {
  const f = fixture(); const [, region] = await f.frames.list(f.contents);
  f.documents.invalidate(f.contents);
  assert.throws(() => f.frames.resolve(f.contents, region.frameId), /fresh frame list/);
});
test('concurrent frame probes share one scan and never prune a newly returned identity', async () => {
  const f = fixture(); const send = f.contents.debugger.sendCommand;
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let scans = 0;
  f.contents.debugger.sendCommand = async (...args) => {
    if (args[0] === 'Target.getTargets') { scans++; started(); await hold; }
    return send(...args);
  };
  const first = f.frames.list(f.contents); await entered;
  const second = f.frames.list(f.contents); release();
  const [a,b] = await Promise.all([first, second]);
  assert.equal(scans, 1); assert.deepEqual(a,b);
  assert.equal(f.frames.resolve(f.contents,b[1].frameId).origin, b[1].origin);
  assert.equal(f.calls.filter(call => call.method === 'Target.attachToTarget').length, 1);
});
test('cancelled target attach ACK is explicitly detached and cannot be cached', async () => {
  const f = fixture(); const send = f.contents.debugger.sendCommand;
  let cancelled = false;
  f.contents.debugger.sendCommand = async (...args) => {
    const result = await send(...args);
    if (args[0] === 'Target.attachToTarget') cancelled = true;
    return result;
  };
  await assert.rejects(f.frames.list(f.contents, () => { if (cancelled) throw new Error('cancelled'); }), /cancelled/);
  assert.equal(f.calls.filter(call => call.method === 'Target.detachFromTarget').length, 1);
});
test('native target parentage includes omitted OOPIFs but excludes unrelated pages', async () => {
  const f = fixture(); const send = f.contents.debugger.sendCommand;
  f.contents.debugger.sendCommand = async (method, params, session) => {
    if (method === 'Page.getFrameTree' && !session) return {frameTree:{frame:{id:'main',loaderId:'root',url:'https://host.example/',securityOrigin:'https://host.example'}}};
    if (method === 'Target.getTargets') return {targetInfos:[
      {type:'iframe',targetId:'child',parentFrameId:'main'},
      {type:'iframe',targetId:'private',parentFrameId:'someone-else'},
    ]};
    return send(method,params,session);
  };
  const rows = await f.frames.list(f.contents);
  assert.equal(rows.length,2); assert.equal(rows[1].origin,'https://form.example');
  assert.equal(f.calls.some(call => call.params?.targetId === 'private'),false);
});
test('a numerical execution context with the wrong native frame cannot be initialized', async () => {
  const f = fixture(); const [,region] = await f.frames.list(f.contents);
  const send = f.contents.debugger.sendCommand;
  f.contents.debugger.sendCommand = async (...args) => {
    const result = await send(...args);
    if (args[0] === 'Page.createIsolatedWorld') f.contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', {
      context:{id:42,uniqueId:'other-page',name:args[1].worldName,auxData:{frameId:'not-child'}},
    },args[2]);
    return result;
  };
  await assert.rejects(f.frames.run(f.contents,region.frameId,'fill',{expectedOrigin:region.origin},()=>{}),/context is unavailable/);
  assert.equal(f.calls.some(call => call.method === 'Runtime.evaluate'),false);
});
test('a scan from a detached connection cannot prune the replacement connection index', async () => {
  const f = fixture(); const send = f.contents.debugger.sendCommand;
  let release; let entered; let first = true;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.contents.debugger.sendCommand = async (...args) => {
    if (args[0] === 'Target.getTargets' && first) { first = false; entered(); await hold; }
    return send(...args);
  };
  const old = f.frames.list(f.contents); const rejection = assert.rejects(old,/connection changed/);
  await started; f.contents.debugger.emit('detach');
  const fresh = await f.frames.list(f.contents); release(); await rejection;
  assert.equal(f.frames.resolve(f.contents,fresh[1].frameId).origin,'https://form.example');
});
