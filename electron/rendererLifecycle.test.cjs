'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');

test('renderer resources survive child-frame and same-document navigation', () => {
  const webContents = new EventEmitter();
  const cleanups = [];
  wireRendererResourceCleanup(webContents, (details) => cleanups.push(details));

  webContents.emit('did-start-navigation', {}, 'about:srcdoc', false, false);
  webContents.emit('did-start-navigation', {}, 'file:///app/index.html#task', true, true);

  assert.deepEqual(cleanups, []);
});

test('renderer resources are cleared when the main document is replaced', () => {
  const webContents = new EventEmitter();
  const cleanups = [];
  const dispose = wireRendererResourceCleanup(webContents, (details) => cleanups.push(details));

  webContents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
  assert.deepEqual(cleanups, [{ reason: 'main_frame_document_navigation' }]);

  dispose();
  webContents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
  assert.equal(cleanups.length, 1);
});
