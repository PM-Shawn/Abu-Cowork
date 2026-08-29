'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bytesMatchMediaType } = require('./mediaSignature.cjs');

const PERSIST_DELEGATED_MEDIA_CHANNEL = 'abu:persist-delegated-media';
const READ_DELEGATED_MEDIA_CHANNEL = 'abu:read-delegated-media';
const MAX_DELEGATED_MEDIA_BYTES = Math.floor(3.75 * 1024 * 1024);
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function toBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function isOpaqueId(value) {
  return typeof value === 'string'
    && OPAQUE_ID.test(value)
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !value.startsWith('~');
}

function validateConversationId(conversationId) {
  if (!isOpaqueId(conversationId)) throw new Error('delegated media: conversation id is invalid');
}

function validateMediaType(mediaType) {
  if (!MEDIA_TYPES.has(mediaType)) throw new Error('delegated media: media type is unsupported');
}

function validateDimensions(width, height) {
  for (const value of [width, height]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('delegated media: dimensions are invalid');
    }
  }
}

function looksLikeMedia(bytes, mediaType) {
  return bytesMatchMediaType(bytes, mediaType);
}

function validateMediaSize(bytes, _mediaType) {
  if (bytes.length > MAX_DELEGATED_MEDIA_BYTES) throw new Error('delegated media: bytes are too large');
}

function extensionFor(mediaType) {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function mediaDir(appDataDir, conversationId) {
  validateConversationId(conversationId);
  return path.join(appDataDir, 'conversations', conversationId, 'delegated-media');
}

function mediaPath(appDataDir, conversationId, ref) {
  if (!isOpaqueId(ref.id) || !SHA256_HEX.test(ref.sha256)) throw new Error('delegated media: ref is invalid');
  const dir = mediaDir(appDataDir, conversationId);
  const target = path.join(dir, `${ref.id}.${extensionFor(ref.mediaType)}`);
  const normalizedDir = `${path.resolve(dir)}${path.sep}`;
  const normalizedTarget = path.resolve(target);
  if (!normalizedTarget.startsWith(normalizedDir)) throw new Error('delegated media: path escaped store');
  return target;
}

function persistDelegatedMedia(appDataDir, request) {
  validateConversationId(request?.conversationId);
  validateMediaType(request?.mediaType);
  validateDimensions(request?.width, request?.height);
  const bytes = toBuffer(request.bytes);
  if (bytes) validateMediaSize(bytes, request.mediaType);
  if (!bytes || bytes.length <= 0 || !looksLikeMedia(bytes, request.mediaType)) {
    throw new Error('delegated media: bytes are invalid');
  }
  const digest = sha256(bytes);
  const ref = Object.freeze({
    id: `media_${digest}`,
    sha256: digest,
    mediaType: request.mediaType,
    bytes: bytes.length,
    ...(request.width === undefined ? {} : { width: request.width }),
    ...(request.height === undefined ? {} : { height: request.height }),
  });
  const dir = mediaDir(appDataDir, request.conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const target = mediaPath(appDataDir, request.conversationId, ref);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.length !== bytes.length || sha256(existing) !== digest) {
      throw new Error('delegated media: existing snapshot failed integrity verification');
    }
    return ref;
  }
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    fs.linkSync(tmp, target);
    fs.rmSync(tmp, { force: true });
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (error && error.code === 'EEXIST') {
      const existing = fs.readFileSync(target);
      if (existing.length === bytes.length && sha256(existing) === digest) return ref;
      throw new Error('delegated media: existing snapshot failed integrity verification');
    }
    throw new Error('delegated media: failed to persist snapshot');
  }
  return ref;
}

function readDelegatedMedia(appDataDir, request) {
  validateConversationId(request?.conversationId);
  const ref = request?.ref;
  if (!ref || !isOpaqueId(ref.id) || !SHA256_HEX.test(ref.sha256) || !MEDIA_TYPES.has(ref.mediaType) || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) return null;
  const target = mediaPath(appDataDir, request.conversationId, ref);
  let bytes;
  try {
    bytes = fs.readFileSync(target);
  } catch {
    return null;
  }
  if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256 || !looksLikeMedia(bytes, ref.mediaType)) return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

module.exports = {
  MAX_DELEGATED_MEDIA_BYTES,
  PERSIST_DELEGATED_MEDIA_CHANNEL,
  READ_DELEGATED_MEDIA_CHANNEL,
  persistDelegatedMedia,
  readDelegatedMedia,
};
