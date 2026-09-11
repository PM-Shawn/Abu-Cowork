'use strict';

const crypto = require('node:crypto');

const VALID_RELATIONS = new Set(['root', 'owned', 'modal', 'replacement']);
const MAX_WINDOW_TITLE_LENGTH = 256;

function createComputerUseWindowRegistry(options = {}) {
  const now = options.now || (() => Date.now());
  const refFactory = options.refFactory
    || (() => `wr-${crypto.randomBytes(24).toString('base64url')}`);
  const getHelperGeneration = options.getHelperGeneration || (() => 0);
  const byRef = new Map();
  const byIdentity = new Map();
  const senderIds = new WeakMap();
  let nextSenderId = 0;

  function senderId(sender) {
    if ((typeof sender !== 'object' || sender === null) && typeof sender !== 'function') {
      throw new Error('Computer Use window sender is invalid');
    }
    let id = senderIds.get(sender);
    if (id === undefined) {
      id = ++nextSenderId;
      senderIds.set(sender, id);
    }
    return id;
  }

  function assertTaskKey(taskKey) {
    if (typeof taskKey !== 'string' || taskKey.length === 0) {
      throw new Error('Computer Use window task is invalid');
    }
  }

  function assertIdentity(identity) {
    if (
      !identity
      || typeof identity !== 'object'
      || typeof identity.app_name !== 'string'
      || identity.app_name.length === 0
      || typeof identity.bundle_id !== 'string'
      || identity.bundle_id.length === 0
      || (
        identity.process_id !== null
        && !Number.isSafeInteger(identity.process_id)
      )
      || typeof identity.window_id !== 'string'
      || identity.window_id.length === 0
    ) {
      throw new Error('Computer Use window identity is invalid');
    }
  }

  function assertRelation(relation) {
    if (!VALID_RELATIONS.has(relation)) {
      throw new Error('Computer Use window relation is invalid');
    }
  }

  function identityKey(sender, taskKey, generation, identity, relation, rootWindowRef) {
    return [
      senderId(sender),
      taskKey,
      generation,
      identity.bundle_id.toLowerCase(),
      identity.process_id ?? '',
      identity.window_id.toLowerCase(),
      relation,
      rootWindowRef ?? '',
    ].join('\0');
  }

  function describe(record, includeTitle = false) {
    return {
      window_ref: record.windowRef,
      app_name: record.identity.app_name,
      relation: record.relation,
      ...(includeTitle && typeof record.identity.title === 'string'
        ? { title: record.identity.title.slice(0, MAX_WINDOW_TITLE_LENGTH) }
        : {}),
    };
  }

  function issue({
    sender,
    taskKey,
    identity,
    relation = 'root',
    rootWindowRef = null,
    includeTitle = false,
  }) {
    assertTaskKey(taskKey);
    assertIdentity(identity);
    assertRelation(relation);
    const generation = getHelperGeneration();
    const key = identityKey(
      sender,
      taskKey,
      generation,
      identity,
      relation,
      rootWindowRef,
    );
    const existingRef = byIdentity.get(key);
    const existing = existingRef ? byRef.get(existingRef) : null;
    if (existing) return describe(existing, includeTitle);

    const windowRef = refFactory();
    if (typeof windowRef !== 'string' || windowRef.length === 0 || byRef.has(windowRef)) {
      throw new Error('Computer Use window reference factory returned an invalid value');
    }
    const timestamp = now();
    const record = {
      windowRef,
      sender,
      taskKey,
      identity: { ...identity },
      relation,
      rootWindowRef,
      generation,
      identityKey: key,
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
    };
    byRef.set(windowRef, record);
    byIdentity.set(key, windowRef);
    return describe(record, includeTitle);
  }

  function resolve({ sender, taskKey, windowRef }) {
    assertTaskKey(taskKey);
    const record = typeof windowRef === 'string' ? byRef.get(windowRef) : null;
    if (!record || record.sender !== sender || record.taskKey !== taskKey) {
      throw new Error('window-ref-invalid');
    }
    if (record.generation !== getHelperGeneration()) {
      byRef.delete(record.windowRef);
      byIdentity.delete(record.identityKey);
      throw new Error('window-ref-expired');
    }
    record.lastVerifiedAt = now();
    return record;
  }

  function deleteRecord(record) {
    byRef.delete(record.windowRef);
    byIdentity.delete(record.identityKey);
  }

  function revokeTask(sender, taskKey) {
    for (const record of [...byRef.values()]) {
      if (record.sender === sender && record.taskKey === taskKey) deleteRecord(record);
    }
  }

  function revokeSender(sender) {
    for (const record of [...byRef.values()]) {
      if (record.sender === sender) deleteRecord(record);
    }
  }

  function prune() {
    const generation = getHelperGeneration();
    for (const record of [...byRef.values()]) {
      if (record.generation !== generation) deleteRecord(record);
    }
  }

  function clear() {
    byRef.clear();
    byIdentity.clear();
  }

  return {
    issue,
    resolve,
    describe,
    revokeTask,
    revokeSender,
    prune,
    clear,
  };
}

module.exports = {
  createComputerUseWindowRegistry,
};
