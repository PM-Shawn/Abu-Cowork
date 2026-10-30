'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CONVERSATION_BYTES = 1024 * 1024 * 1024;
const TOTAL_BYTES = 5 * CONVERSATION_BYTES;

function storedBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('Media storage contains a symbolic link');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('Media storage contains an unsupported file');
  return fs.readdirSync(directory).reduce((total, name) => total + storedBytes(path.join(directory, name)), 0);
}

function createMediaStorageBudget(dataRoot) {
  const reservations = new Map();
  const assertCapacity = (conversationId, additionalBytes) => {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('Media storage size is invalid');
    const hash = createHash('sha256').update(conversationId).digest('hex');
    const media = path.join(dataRoot, 'media');
    const conversations = path.join(dataRoot, 'conversations');
    const current = storedBytes(path.join(media, 'captures', hash)) + storedBytes(path.join(media, 'results', hash))
      + storedBytes(path.join(conversations, conversationId, 'outputs'));
    const reserved = [...reservations.values()];
    const conversationReserved = reserved.filter(item => item.conversationId === conversationId).reduce((total, item) => total + item.bytes, 0);
    if (current + conversationReserved + additionalBytes > CONVERSATION_BYTES) throw new Error('Conversation media storage capacity has been reached');
    const allOutputs = fs.existsSync(conversations) ? fs.readdirSync(conversations, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).reduce((total, entry) => total + storedBytes(path.join(conversations, entry.name, 'outputs')), 0) : 0;
    const all = storedBytes(path.join(media, 'captures')) + storedBytes(path.join(media, 'results')) + allOutputs;
    if (all + reserved.reduce((total, item) => total + item.bytes, 0) + additionalBytes > TOTAL_BYTES) throw new Error('Media storage capacity has been reached');
  };
  assertCapacity.reserve = (conversationId, bytes) => {
    assertCapacity(conversationId, bytes);
    const key = Symbol();
    const reservation = { conversationId, bytes };
    reservations.set(key, reservation);
    return {
      consume(amount) {
        if (!reservations.has(key) || !Number.isSafeInteger(amount) || amount < 0 || amount > reservation.bytes) throw new Error('Media storage reservation is invalid');
        reservation.bytes -= amount;
        assertCapacity(conversationId, amount);
      },
      release() { reservations.delete(key); },
    };
  };
  return assertCapacity;
}

module.exports = { createMediaStorageBudget };
