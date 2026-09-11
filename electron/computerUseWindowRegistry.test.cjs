'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createComputerUseWindowRegistry } = require('./computerUseWindowRegistry.cjs');

function wordIdentity(overrides = {}) {
  return {
    app_name: 'Word',
    bundle_id: 'win32:word.exe',
    process_id: 42,
    window_id: 'hwnd:0x1234',
    title: 'Private budget.docx',
    ...overrides,
  };
}

test('issues a stable opaque ref without exposing the native window id or title', () => {
  const sender = {};
  const registry = createComputerUseWindowRegistry({
    refFactory: () => 'wr-test-token',
    getHelperGeneration: () => 7,
  });

  const first = registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity(),
    relation: 'root',
  });
  const second = registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity(),
    relation: 'root',
  });

  assert.deepEqual(first, {
    window_ref: 'wr-test-token',
    app_name: 'Word',
    relation: 'root',
  });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(first).includes('0x1234'), false);
  assert.equal(JSON.stringify(first).includes('Private budget.docx'), false);
});

test('returns a bounded title only when the caller explicitly requests it', () => {
  const registry = createComputerUseWindowRegistry({
    refFactory: () => 'wr-title',
    getHelperGeneration: () => 1,
  });
  const sender = {};
  const issued = registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity({ title: 'x'.repeat(300) }),
    relation: 'root',
  });
  const record = registry.resolve({
    sender,
    taskKey: 'conversation\0loop',
    windowRef: issued.window_ref,
  });

  assert.equal(registry.describe(record).title, undefined);
  assert.equal(registry.describe(record, true).title, 'x'.repeat(256));
});

test('keeps identical native windows isolated and stable for each sender', () => {
  const refs = ['wr-first', 'wr-second'];
  const registry = createComputerUseWindowRegistry({
    refFactory: () => refs.shift(),
    getHelperGeneration: () => 1,
  });
  const firstSender = {};
  const secondSender = {};
  const input = { taskKey: 'conversation\0loop', identity: wordIdentity(), relation: 'root' };

  const first = registry.issue({ sender: firstSender, ...input });
  const second = registry.issue({ sender: secondSender, ...input });
  const firstAgain = registry.issue({ sender: firstSender, ...input });

  assert.equal(first.window_ref, 'wr-first');
  assert.equal(second.window_ref, 'wr-second');
  assert.equal(firstAgain.window_ref, 'wr-first');
});

test('rejects a ref from another sender, task, or helper generation', () => {
  let generation = 1;
  const registry = createComputerUseWindowRegistry({
    refFactory: () => 'wr-one',
    getHelperGeneration: () => generation,
  });
  const sender = {};
  const descriptor = registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity(),
    relation: 'root',
  });

  assert.throws(() => registry.resolve({
    sender: {},
    taskKey: 'conversation\0loop',
    windowRef: descriptor.window_ref,
  }), /window-ref-invalid/);
  assert.throws(() => registry.resolve({
    sender,
    taskKey: 'other\0loop',
    windowRef: descriptor.window_ref,
  }), /window-ref-invalid/);

  generation = 2;
  assert.throws(() => registry.resolve({
    sender,
    taskKey: 'conversation\0loop',
    windowRef: descriptor.window_ref,
  }), /window-ref-expired/);
});

test('revokes refs by task and sender without touching unrelated owners', () => {
  let sequence = 0;
  const registry = createComputerUseWindowRegistry({
    refFactory: () => `wr-${++sequence}`,
    getHelperGeneration: () => 1,
  });
  const firstSender = {};
  const secondSender = {};
  const firstTask = registry.issue({ sender: firstSender, taskKey: 'c1\0l1', identity: wordIdentity(), relation: 'root' });
  const secondTask = registry.issue({ sender: firstSender, taskKey: 'c1\0l2', identity: wordIdentity(), relation: 'root' });
  const otherOwner = registry.issue({ sender: secondSender, taskKey: 'c1\0l1', identity: wordIdentity(), relation: 'root' });

  registry.revokeTask(firstSender, 'c1\0l1');
  assert.throws(() => registry.resolve({ sender: firstSender, taskKey: 'c1\0l1', windowRef: firstTask.window_ref }), /window-ref-invalid/);
  assert.doesNotThrow(() => registry.resolve({ sender: firstSender, taskKey: 'c1\0l2', windowRef: secondTask.window_ref }));
  assert.doesNotThrow(() => registry.resolve({ sender: secondSender, taskKey: 'c1\0l1', windowRef: otherOwner.window_ref }));

  registry.revokeSender(firstSender);
  assert.throws(() => registry.resolve({ sender: firstSender, taskKey: 'c1\0l2', windowRef: secondTask.window_ref }), /window-ref-invalid/);
  assert.doesNotThrow(() => registry.resolve({ sender: secondSender, taskKey: 'c1\0l1', windowRef: otherOwner.window_ref }));
});

test('rejects malformed native identities and unsupported relations', () => {
  const registry = createComputerUseWindowRegistry({ getHelperGeneration: () => 1 });
  const sender = {};
  assert.throws(() => registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity({ window_id: null }),
    relation: 'root',
  }), /window identity/i);
  assert.throws(() => registry.issue({
    sender,
    taskKey: 'conversation\0loop',
    identity: wordIdentity(),
    relation: 'same-app',
  }), /window relation/i);
});

test('prunes an obsolete helper generation and clears all remaining refs', () => {
  let generation = 1;
  let sequence = 0;
  const registry = createComputerUseWindowRegistry({
    refFactory: () => `wr-${++sequence}`,
    getHelperGeneration: () => generation,
  });
  const sender = {};
  const obsolete = registry.issue({ sender, taskKey: 'c1\0l1', identity: wordIdentity(), relation: 'root' });

  generation = 2;
  registry.prune();
  assert.throws(() => registry.resolve({ sender, taskKey: 'c1\0l1', windowRef: obsolete.window_ref }), /window-ref-invalid/);

  const current = registry.issue({ sender, taskKey: 'c1\0l2', identity: wordIdentity(), relation: 'root' });
  registry.clear();
  assert.throws(() => registry.resolve({ sender, taskKey: 'c1\0l2', windowRef: current.window_ref }), /window-ref-invalid/);
});
