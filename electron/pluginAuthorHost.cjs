'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const PLUGIN_AUTHOR_CHANNEL = 'abu:plugin-author';

function createPluginAuthorHost({ home, session, snapshots, now = () => new Date().toISOString(), randomId = () => crypto.randomBytes(16).toString('hex') }) {
  let queue = Promise.resolve();
  async function call(action, request = {}) {
    await session.ready();
    const identity = await fs.stat(home);
    return session.author({ home, identity: { ino: identity.ino, dev: identity.dev }, action, nonce: randomId(), ...request });
  }
  async function dispatch(sender, action, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Plugin author: invalid request');
    const allowed = { list: [], create: [], delete: ['id'], bind: ['id', 'conversationId', 'expectedConversationId'], prepare: ['id', 'conversationId'], validated: ['token'] }[action];
    if (!allowed || Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Plugin author: unsupported request');
    if (action === 'create') return call('create', { id: randomId(), createdAt: now() });
    if (action === 'list' || action === 'bind' || action === 'delete') return call(action, request);
    if (action === 'validated') {
      const snapshot = await snapshots.identity(sender, request);
      if (!snapshot.authoringId) throw new Error('Plugin author: snapshot is not authored');
      return call('prepared', { id: snapshot.authoringId, name: snapshot.name, version: snapshot.version, checksum: snapshot.checksum, description: snapshot.description });
    }
    if ((!request.id && !request.conversationId) || (request.id && request.conversationId)) throw new Error('Plugin author: select one author identity');
    const author = (await call('list')).find(item => request.id ? item.id === request.id : item.conversationId === request.conversationId);
    if (!author) throw new Error('Plugin author: no author record for this conversation');
    const snapshot = await snapshots.prepareAuthored(sender, { sourceDir: author.sourceDir, marketplaceName: author.marketplace, authoringId: author.id, boundName: author.name });
    return { author: { ...author, name: snapshot.name, key: `${snapshot.name}@${author.marketplace}`,
      prepared: { version: snapshot.version, checksum: snapshot.checksum, description: snapshot.description } }, snapshot };
  }
  return { dispatch(sender, action, request = {}) {
    const captured = structuredClone(request);
    const pending = queue.then(() => dispatch(sender, action, captured));
    queue = pending.catch(() => {});
    return pending;
  } };
}
module.exports = { PLUGIN_AUTHOR_CHANNEL, createPluginAuthorHost };
