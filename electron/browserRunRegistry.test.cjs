'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserRunRegistry } = require('./browserRunRegistry.cjs');

test('unknown and terminated child requests fail closed, while other runs remain active', () => {
  const registry = createBrowserRunRegistry();
  const request = { ownerId: 'conversation', runId: 'child' };
  assert.throws(() => registry.signalFor(request), /not active/);
  registry.register('conversation', 'child');
  registry.register('conversation', 'sibling');
  const live = registry.signalFor(request);
  registry.unregister('conversation', 'child');
  assert.equal(live.aborted, true);
  assert.throws(() => registry.signalFor(request), /not active/);
  assert.equal(registry.signalFor({ ...request, runId: 'sibling' }).aborted, false);
  assert.equal(registry.size, 1);
});
test('conversation deletion revokes only that conversation before invoking listeners', () => {
  const registry = createBrowserRunRegistry();
  registry.register('a', 'child'); registry.register('b', 'child');
  const signal = registry.signalFor({ ownerId: 'a', runId: 'child' });
  signal.addEventListener('abort', () => assert.throws(() => registry.signalFor({ ownerId: 'a', runId: 'child' })));
  registry.disposeConversation('a');
  assert.equal(signal.aborted, true);
  assert.equal(registry.signalFor({ ownerId: 'b', runId: 'child' }).aborted, false);
});
test('long autonomous sessions do not accumulate terminal records or trip a cumulative limit', () => {
  const registry = createBrowserRunRegistry();
  for (let i = 0; i < 5000; i += 1) {
    registry.register('conversation', `child-${i}`);
    registry.unregister('conversation', `child-${i}`);
  }
  assert.equal(registry.size, 0);
  registry.register('conversation', 'next');
  assert.equal(registry.signalFor({ ownerId: 'conversation', runId: 'next' }).aborted, false);
  assert.throws(() => registry.signalFor({ ownerId: 'conversation', runId: 'child-0' }), /not active/);
});
test('renderer replacement revokes its browser runs; a subframe navigation does not', () => {
  const registry = createBrowserRunRegistry();
  const renderer = new EventEmitter();
  registry.bindRenderer(renderer); registry.bindRenderer(renderer);
  registry.register('a', 'child');
  const signal = registry.signalFor({ ownerId: 'a', runId: 'child' });
  renderer.emit('did-start-navigation', {}, 'https://iframe', false, false);
  assert.equal(signal.aborted, false);
  renderer.emit('did-start-navigation', {}, 'app://reload', false, true);
  assert.equal(signal.aborted, true);
  assert.equal(registry.size, 0);
});
test('main identity preserves transport cancellation and malformed child identities cannot become main', () => {
  const registry = createBrowserRunRegistry();
  const external = new AbortController();
  assert.equal(registry.signalFor({}, external.signal), external.signal);
  for (const runId of ['', 1, null, 'x\0y']) assert.throws(() => registry.signalFor({ ownerId: 'a', runId }));
  registry.register('a', 'child');
  const signal = registry.signalFor({ ownerId: 'a', runId: 'child' }, external.signal);
  external.abort();
  assert.equal(signal.aborted, true);
});

test('a crashed renderer revokes child work even while its WebContents remains alive', () => {
  const { EventEmitter } = require('node:events');
  const registry = createBrowserRunRegistry();
  const renderer = new EventEmitter();
  registry.bindRenderer(renderer);
  registry.register('conversation', 'child');
  const signal = registry.signalFor({ ownerId: 'conversation', runId: 'child' });
  renderer.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(registry.size, 0);
  assert.equal(signal.aborted, true);
  assert.throws(() => registry.signalFor({ ownerId: 'conversation', runId: 'child' }), /not active/);
});
