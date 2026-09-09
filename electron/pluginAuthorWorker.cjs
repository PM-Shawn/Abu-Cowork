'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { enterDirectory } = require('./pluginRegistryWorker.cjs');
const { registryIO, safeSegment } = require('./pluginRegistryHost.cjs');
const idValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const preparedValid = value => value === null || (value && typeof value === 'object' && safeSegment(value.version) && /^[a-f0-9]{64}$/.test(value.checksum) && typeof value.description === 'string' && value.description.length <= 2048);
const conversationValid = value => typeof value === 'string' && /^[\w-]{1,120}$/.test(value);

/** Runs inside the profile's single leased worker. Source is outside .abu so
 * a creation conversation never needs write access to runtime metadata. */
function runAuthor(input, io = fs, chdir = process.chdir) {
  const home = process.cwd();
  const stat = io.statSync('.');
  if (stat.ino !== input.identity.ino || stat.dev !== input.identity.dev) throw new Error('Plugin author: profile changed');
  enterDirectory('.abu', true, io, chdir);
  enterDirectory('plugin-authors', true, io, chdir);
  const metadataDir = process.cwd();
  const metadataIdentity = io.statSync('.');
  const data = registryIO(io, () => input.nonce);
  const raw = data.read('authors.json');
  const authors = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(authors) || authors.length > 500 || authors.some(author => !author || !idValid(author.id) || !preparedValid(author.prepared)
    || typeof author.createdAt !== 'string' || author.createdAt.length > 32
    || (author.conversationId !== null && !conversationValid(author.conversationId))
    || (author.name !== null && !safeSegment(author.name)))
    || new Set(authors.map(author => author.id)).size !== authors.length) throw new Error('Plugin author: invalid records; original file preserved');
  const result = author => ({ ...author, sourceDir: path.join(home, 'Abu Plugins', author.id),
    marketplace: `author-${author.id}`, key: author.name ? `${author.name}@author-${author.id}` : null });
  if (input.action === 'list') return authors.map(result);
  if (!idValid(input.nonce)) throw new Error('Plugin author: invalid operation identity');
  let author;
  if (input.action === 'create') {
    if (typeof input.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.createdAt) || !idValid(input.id) || authors.some(item => item.id === input.id) || authors.length >= 500) throw new Error('Plugin author: invalid or duplicate author identity');
    author = { id: input.id, createdAt: input.createdAt, conversationId: null, name: null, prepared: null };
    chdir(home);
    if (io.statSync('.').ino !== stat.ino || io.statSync('.').dev !== stat.dev) throw new Error('Plugin author: profile changed');
    enterDirectory('Abu Plugins', true, io, chdir);
    io.mkdirSync(input.id);
    authors.push(author);
  } else {
    author = authors.find(item => item.id === input.id);
    if (!author) throw new Error('Plugin author: record unavailable');
    if (input.action === 'bind') {
      if (!conversationValid(input.conversationId) || authors.some(item => item.id !== author.id && item.conversationId === input.conversationId)) throw new Error('Plugin author: invalid or reused conversation');
      if (author.conversationId !== input.conversationId && author.conversationId !== (input.expectedConversationId ?? null)) throw new Error('Plugin author: conversation binding changed');
      author.conversationId = input.conversationId;
    } else if (input.action === 'prepared') {
      if (!safeSegment(input.name) || (author.name && author.name !== input.name)) throw new Error('Plugin author: package name is bound; keep the original name when editing');
      if (!safeSegment(input.version) || !/^[a-f0-9]{64}$/.test(input.checksum) || typeof input.description !== 'string' || input.description.length > 2048) throw new Error('Plugin author: invalid preparation');
      author.name = input.name;
      author.prepared = { version: input.version, checksum: input.checksum, description: input.description };
    } else throw new Error('Plugin author: unsupported action');
  }
  chdir(metadataDir);
  const current = io.statSync('.');
  if (current.ino !== metadataIdentity.ino || current.dev !== metadataIdentity.dev) throw new Error('Plugin author: metadata directory changed');
  data.write('authors.json', JSON.stringify(authors));
  let fd;
  try { fd = io.openSync('.', 'r'); io.fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) io.closeSync(fd); }
  return result(author);
}
module.exports = { runAuthor };
