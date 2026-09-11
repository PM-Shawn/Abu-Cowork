'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const SAVE_IMAGE_ATTACHMENT_CHANNEL = 'abu:save-image-attachment';
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_FORMATS = new Map([
  ['image/png', { extension: 'png', extensions: ['png'], label: 'PNG image' }],
  ['image/jpeg', { extension: 'jpg', extensions: ['jpg', 'jpeg'], label: 'JPEG image' }],
  ['image/gif', { extension: 'gif', extensions: ['gif'], label: 'GIF image' }],
  ['image/webp', { extension: 'webp', extensions: ['webp'], label: 'WebP image' }],
]);
const REQUEST_KEYS = new Set(['data', 'mediaType', 'suggestedName']);
const activeSenders = new WeakSet();

function bufferFromBinary(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function matchesImageSignature(mediaType, bytes) {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 8
        && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'image/webp':
      return bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
}

function safeSuggestedName(value, extension) {
  const raw = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(raw, 'utf8') > 512 || raw.includes('\0')) {
    throw new Error('image save: suggested name is invalid');
  }
  const basename = raw.split(/[\\/]/).pop() || 'Abu-image';
  const withoutExtension = basename.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const stem = withoutExtension
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'Abu-image';
  return `${stem}.${extension}`;
}

function validateDestination(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 32 * 1024
    || !path.isAbsolute(value)
  ) {
    throw new Error('image save: dialog returned an invalid path');
  }
  return value;
}

function resolveImageBytes(request) {
  const bytes = bufferFromBinary(request.data);
  if (!bytes) throw new Error('image save: data must be binary');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('image save: image size is invalid');
  }
  return bytes;
}

function noFollowFlag(fsImpl) {
  return typeof fsImpl.constants.O_NOFOLLOW === 'number' ? fsImpl.constants.O_NOFOLLOW : 0;
}

/**
 * Write to an exclusive sibling, flush it, then replace the chosen directory
 * entry atomically. The final rename replaces a destination symlink instead of
 * following it and leaves an existing file untouched if any earlier step fails.
 */
function writeImageAtomically(target, bytes, fsImpl = fs, randomBytes = crypto.randomBytes) {
  const unresolvedParent = path.dirname(target);
  const realpath = fsImpl.realpathSync.native || fsImpl.realpathSync;
  const parent = realpath(unresolvedParent);
  const resolvedTarget = path.join(parent, path.basename(target));
  // Keep the exclusive sibling name independent of the chosen basename. A
  // legal destination can already be close to the filesystem's per-component
  // limit; repeating it in the temporary name would turn a valid Save As into
  // ENAMETOOLONG before any bytes are written.
  const prefix = `.abu-image-save.${process.pid}`;
  const flags = fsImpl.constants.O_WRONLY
    | fsImpl.constants.O_CREAT
    | fsImpl.constants.O_EXCL
    | noFollowFlag(fsImpl);
  let temporary = null;
  let fd;

  for (let attempt = 0; attempt < 32; attempt++) {
    temporary = path.join(parent, `${prefix}.${randomBytes(16).toString('hex')}`);
    try {
      fd = fsImpl.openSync(temporary, flags, 0o600);
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  if (fd === undefined || temporary === null) {
    throw new Error('image save: could not create an exclusive temporary file');
  }

  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('image save: write made no progress');
      offset += written;
    }
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temporary, resolvedTarget);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fsImpl.rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

function validateDestinationExtension(destination, format) {
  const extension = path.extname(destination).slice(1).toLowerCase();
  if (!format.extensions.includes(extension)) {
    throw new Error('image save: destination extension does not match the image type');
  }
  return destination;
}

/**
 * Save bytes only after the user chooses a destination in the native dialog.
 * The renderer cannot supply the destination path, so this bridge never grants
 * a general arbitrary-write capability.
 */
async function saveImageAttachment(app, event, request, overrides = {}) {
  const sender = event?.sender;
  if (!sender || (typeof sender !== 'object' && typeof sender !== 'function')) {
    throw new Error('image save: IPC sender is unavailable');
  }
  if (activeSenders.has(sender)) {
    throw new Error('image save: another save is already in progress');
  }
  activeSenders.add(sender);

  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('image save: request must be an object');
    }
    const unknownKey = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
    if (unknownKey) throw new Error(`image save: unsupported request field ${unknownKey}`);
    const format = IMAGE_FORMATS.get(request.mediaType);
    if (!format) throw new Error('image save: unsupported media type');

    const dependencies = {
      fs: overrides.fs || fs,
      dialog: overrides.dialog,
      BrowserWindow: overrides.BrowserWindow,
      writeAtomic: overrides.writeAtomic,
    };
    if (!dependencies.dialog || !dependencies.BrowserWindow) {
      throw new Error('image save: Electron dialog dependencies are unavailable');
    }

    const bytes = resolveImageBytes(request);
    if (!matchesImageSignature(request.mediaType, bytes)) {
      throw new Error('image save: bytes do not match the declared media type');
    }

    const fileName = safeSuggestedName(request.suggestedName, format.extension);
    const defaultPath = path.join(app.getPath('downloads'), fileName);
    let owner = null;
    try {
      const candidate = dependencies.BrowserWindow.fromWebContents(sender);
      if (candidate && !candidate.isDestroyed()) owner = candidate;
    } catch {
      owner = null;
    }
    const options = {
      defaultPath,
      filters: [{ name: format.label, extensions: format.extensions }],
    };
    const result = owner
      ? await dependencies.dialog.showSaveDialog(owner, options)
      : await dependencies.dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };

    const destination = validateDestinationExtension(
      validateDestination(result.filePath),
      format,
    );
    if (dependencies.writeAtomic) dependencies.writeAtomic(destination, bytes);
    else writeImageAtomically(destination, bytes, dependencies.fs);
    return { saved: true, fileName: path.basename(destination) };
  } finally {
    activeSenders.delete(sender);
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  SAVE_IMAGE_ATTACHMENT_CHANNEL,
  matchesImageSignature,
  safeSuggestedName,
  saveImageAttachment,
  validateDestinationExtension,
  writeImageAtomically,
};
