'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  bytesMatchMediaType,
} = require('./mediaSignature.cjs');

const READ_USER_ATTACHMENT_CHANNEL = 'abu:read-user-attachment';
const RELEASE_USER_ATTACHMENT_CHANNEL = 'abu:release-user-attachment';
const AUTHORIZE_USER_ATTACHMENT_CHANNEL = 'abu:authorize-user-attachment';
const SELECT_USER_ATTACHMENTS_CHANNEL = 'abu:select-user-attachments';
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_USER_ATTACHMENT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOKENS_PER_SENDER = 32;
const MAX_TOTAL_TOKENS = 512;
const REQUEST_KEYS = new Set(['token']);
const AUTHORIZE_KEYS = new Set(['path', 'name', 'mediaType', 'maxBytes', 'sender', 'now', 'ttlMs']);
const SELECT_KEYS = new Set(['mediaTypes']);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const tokenRecords = new Map();

const MEDIA_TYPE_EXTENSIONS = new Map([
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/png', ['png']],
  ['image/gif', ['gif']],
  ['image/webp', ['webp']],
]);

const EXTENSION_MEDIA_TYPES = new Map(
  [...MEDIA_TYPE_EXTENSIONS.entries()].flatMap(([mediaType, extensions]) => (
    extensions.map((extension) => [extension, mediaType])
  )),
);

function maxBytesForMediaType() {
  return MAX_USER_ATTACHMENT_IMAGE_BYTES;
}

function validateTokenRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('attachment read: request must be an object');
  }
  const unknownKey = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unknownKey) throw new Error(`attachment read: unsupported request field ${unknownKey}`);
  if (typeof request.token !== 'string' || request.token.length < 32 || request.token.length > 256 || request.token.includes('\0')) {
    throw new Error('attachment read: token is invalid');
  }
}

function validateAuthorizeRequest(request, allowedMediaTypes = IMAGE_MEDIA_TYPES) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('attachment authorize: request must be an object');
  }
  const unknownKey = Object.keys(request).find((key) => !AUTHORIZE_KEYS.has(key));
  if (unknownKey) throw new Error(`attachment authorize: unsupported request field ${unknownKey}`);
  if (
    typeof request.path !== 'string'
    || request.path.length === 0
    || request.path.includes('\0')
    || Buffer.byteLength(request.path, 'utf8') > 32 * 1024
    || !path.isAbsolute(request.path)
  ) {
    throw new Error('attachment authorize: path is invalid');
  }
  if (!allowedMediaTypes.has(request.mediaType)) {
    throw new Error('attachment authorize: media type is unsupported');
  }
  const maxAllowedBytes = maxBytesForMediaType(request.mediaType);
  if (
    request.maxBytes !== undefined
    && (!Number.isSafeInteger(request.maxBytes)
      || request.maxBytes <= 0
      || request.maxBytes > maxAllowedBytes)
  ) {
    throw new Error('attachment authorize: maxBytes is invalid');
  }
  if (request.name !== undefined && (typeof request.name !== 'string' || request.name.includes('\0') || Buffer.byteLength(request.name, 'utf8') > 512)) {
    throw new Error('attachment authorize: name is invalid');
  }
}

function validateRequest(request) {
  return validateTokenRequest(request);
}

function releaseUserAttachment(event, request) {
  validateTokenRequest(request);
  const record = tokenRecords.get(request.token);
  if (!record) return { released: false };
  if (record.sender !== event?.sender) {
    throw new Error('attachment release: token belongs to a different IPC sender');
  }
  tokenRecords.delete(request.token);
  return { released: true };
}

function cleanupExpiredTokens(now = Date.now()) {
  for (const [token, record] of tokenRecords) {
    if (record.expiresAt <= now) tokenRecords.delete(token);
  }
}

function isSenderDestroyed(sender) {
  try {
    return Boolean(sender && typeof sender.isDestroyed === 'function' && sender.isDestroyed());
  } catch {
    return true;
  }
}

function pruneDestroyedSenders() {
  for (const [token, record] of tokenRecords) {
    if (isSenderDestroyed(record.sender)) tokenRecords.delete(token);
  }
}

function enforceTokenRegistryLimits(sender, now = Date.now()) {
  cleanupExpiredTokens(now);
  pruneDestroyedSenders();
  const senderTokens = [...tokenRecords.values()].filter((record) => record.sender === sender).length;
  if (senderTokens >= MAX_TOKENS_PER_SENDER) {
    throw new Error('attachment authorize: token limit reached');
  }
  if (tokenRecords.size >= MAX_TOTAL_TOKENS) {
    throw new Error('attachment authorize: global token limit reached');
  }
}

function enforceTokenBatchCapacity(sender, requestedCount, now = Date.now()) {
  cleanupExpiredTokens(now);
  pruneDestroyedSenders();
  const senderTokens = [...tokenRecords.values()].filter((record) => record.sender === sender).length;
  if (requestedCount > MAX_TOKENS_PER_SENDER - senderTokens) {
    throw new Error('attachment select: token limit reached');
  }
  if (requestedCount > MAX_TOTAL_TOKENS - tokenRecords.size) {
    throw new Error('attachment select: global token limit reached');
  }
}

function basenameForToken(request) {
  const candidate = typeof request.name === 'string' && request.name.trim()
    ? request.name
    : path.basename(request.path);
  return candidate.split(/[\\/]/).pop() || 'attachment';
}

function issueUserAttachmentToken(request, allowedMediaTypes = IMAGE_MEDIA_TYPES) {
  validateAuthorizeRequest(request, allowedMediaTypes);
  const now = Number.isFinite(request.now) ? request.now : Date.now();
  const ttlMs = Number.isSafeInteger(request.ttlMs) && request.ttlMs > 0
    ? request.ttlMs
    : DEFAULT_TOKEN_TTL_MS;
  enforceTokenRegistryLimits(request.sender, now);
  const token = crypto.randomBytes(32).toString('base64url');
  const record = {
    sender: request.sender,
    path: request.path,
    name: basenameForToken(request),
    mediaType: request.mediaType,
    maxBytes: Math.min(request.maxBytes ?? maxBytesForMediaType(request.mediaType), maxBytesForMediaType(request.mediaType)),
    expiresAt: now + ttlMs,
  };
  tokenRecords.set(token, record);
  return {
    token,
    name: record.name,
    mediaType: record.mediaType,
    expiresAt: record.expiresAt,
  };
}

function authorizeUserAttachment(event, request) {
  return issueUserAttachmentToken({
    ...request,
    sender: event?.sender,
  }, IMAGE_MEDIA_TYPES);
}

function validateSelectRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('attachment select: request must be an object');
  }
  const unknownKey = Object.keys(request).find((key) => !SELECT_KEYS.has(key));
  if (unknownKey) throw new Error(`attachment select: unsupported request field ${unknownKey}`);
  const mediaTypes = Array.isArray(request.mediaTypes) ? request.mediaTypes : [...IMAGE_MEDIA_TYPES];
  if (mediaTypes.length === 0 || mediaTypes.some((mediaType) => !IMAGE_MEDIA_TYPES.has(mediaType))) {
    throw new Error('attachment select: media type is unsupported');
  }
  return mediaTypes;
}

function extensionsForMediaTypes(mediaTypes) {
  const extensions = [];
  for (const mediaType of mediaTypes) {
    extensions.push(...(MEDIA_TYPE_EXTENSIONS.get(mediaType) ?? []));
  }
  return [...new Set(extensions)];
}

function dialogFiltersForMediaTypes(mediaTypes) {
  const imageExtensions = [...new Set(
    mediaTypes
      .filter((mediaType) => IMAGE_MEDIA_TYPES.has(mediaType))
      .flatMap((mediaType) => MEDIA_TYPE_EXTENSIONS.get(mediaType) ?? []),
  )];
  if (imageExtensions.length > 0) {
    return [{ name: 'Images', extensions: imageExtensions }];
  }
  return [];
}

function mediaTypeForSelectedPath(filePath, allowedMediaTypes) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mediaType = EXTENSION_MEDIA_TYPES.get(extension);
  if (!mediaType || !allowedMediaTypes.includes(mediaType)) {
    throw new Error('attachment select: selected file type is unsupported');
  }
  return mediaType;
}

async function selectUserAttachments(event, request, overrides = {}) {
  const mediaTypes = validateSelectRequest(request);
  const dialog = overrides.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    throw new Error('attachment select: dialog host unavailable');
  }
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: dialogFiltersForMediaTypes(mediaTypes),
  });
  if (result?.canceled) return [];
  const requests = (result.filePaths ?? []).map((filePath) => ({
    sender: event?.sender,
    path: filePath,
    name: path.basename(filePath),
    mediaType: mediaTypeForSelectedPath(filePath, mediaTypes),
  }));
  enforceTokenBatchCapacity(event?.sender, requests.length);
  return requests.map((tokenRequest) => issueUserAttachmentToken(tokenRequest, IMAGE_MEDIA_TYPES));
}

function consumeToken(event, token, now = Date.now()) {
  const record = tokenRecords.get(token);
  if (!record) throw new Error('attachment read: token is not authorized');
  if (record.expiresAt <= now) {
    tokenRecords.delete(token);
    throw new Error('attachment read: token expired');
  }
  cleanupExpiredTokens(now);
  if (record.sender !== event?.sender) {
    throw new Error('attachment read: token belongs to a different IPC sender');
  }
  return record;
}

function noFollowFlag(fsImpl) {
  return typeof fsImpl.constants?.O_NOFOLLOW === 'number' ? fsImpl.constants.O_NOFOLLOW : 0;
}

async function readFileDescriptor(handle, size) {
  const out = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(out, offset, size - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('attachment read: file size changed');
  return out;
}

async function readUserAttachment(event, request, overrides = {}) {
  validateTokenRequest(request);
  const now = Number.isFinite(overrides.now) ? overrides.now : Date.now();
  const record = consumeToken(event, request.token, now);
  const fsImpl = overrides.fs || fs.promises;
  const flags = (fs.constants.O_RDONLY ?? 0) | noFollowFlag(fsImpl);
  let handle;
  try {
    handle = await fsImpl.open(record.path, flags);
  } catch (error) {
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      throw new Error('attachment read: symlink is not allowed');
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > record.maxBytes) {
      throw new Error('attachment read: file is invalid');
    }
    const bytes = await readFileDescriptor(handle, stats.size);
    const afterStats = await handle.stat();
    if (!afterStats.isFile() || afterStats.size !== stats.size) {
      throw new Error('attachment read: file size changed');
    }
    if (bytes.byteLength !== stats.size || bytes.byteLength > record.maxBytes) {
      throw new Error('attachment read: file size changed');
    }
    if (!bytesMatchMediaType(bytes, record.mediaType)) {
      throw new Error('attachment read: bytes do not match declared media type');
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } finally {
    if (handle && typeof handle.close === 'function') {
      await handle.close().catch(() => {});
    }
  }
}

module.exports = {
  AUTHORIZE_USER_ATTACHMENT_CHANNEL,
  DEFAULT_TOKEN_TTL_MS,
  MAX_USER_ATTACHMENT_IMAGE_BYTES,
  READ_USER_ATTACHMENT_CHANNEL,
  RELEASE_USER_ATTACHMENT_CHANNEL,
  SELECT_USER_ATTACHMENTS_CHANNEL,
  authorizeUserAttachment,
  bytesMatchMediaType,
  issueUserAttachmentToken,
  readUserAttachment,
  releaseUserAttachment,
  selectUserAttachments,
  validateRequest,
  __testing: {
    MAX_TOKENS_PER_SENDER,
    MAX_TOTAL_TOKENS,
    countTokens: () => tokenRecords.size,
    countTokensForSender: (sender) => [...tokenRecords.values()].filter((record) => record.sender === sender).length,
    pruneDestroyedSenders,
    resetTokens: () => tokenRecords.clear(),
  },
};
