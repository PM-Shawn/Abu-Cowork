'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  COMPUTER_USE_TOKEN_ARG,
  COMPUTER_USE_PRIVILEGED_COMMANDS,
} = require('./computerUseCommands.cjs');

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const RAW_BODY_COMMANDS = new Set([
  'plugin:fs|write_file',
  'plugin:fs|write_text_file',
]);
const RESTRICTED_WINDOW_COMMANDS = new Map([
  [
    'pet',
    new Set([
      'pet_set_frame',
      'pet_focus_main',
      'pet_hide',
      'plugin:event|listen',
      'plugin:event|unlisten',
      'plugin:event|emit',
      'plugin:window|outer_position',
      'plugin:window|primary_monitor',
      'plugin:window|start_dragging',
    ]),
  ],
  ['overlay', new Set(['plugin:event|listen', 'plugin:event|unlisten'])],
  ['stop-button', new Set(['plugin:event|emit'])],
]);
const RESTRICTED_EMITTED_EVENTS = new Map([
  [
    'pet',
    new Set([
      'pet-resync-request',
      'pet-send-message',
      'pet-open-state-changed',
    ]),
  ],
  ['stop-button', new Set(['computer-use-abort'])],
]);
const RESTRICTED_LISTENED_EVENTS = new Map([
  ['pet', new Set(['pet-status-update', 'tauri://move'])],
  ['overlay', new Set(['computer-use-status'])],
]);
const BASE_DIRECTORY_VALUES = new Set(Array.from({ length: 23 }, (_v, i) => i + 1));
const PATH_KEYS = new Set([
  'path',
  'oldPath',
  'newPath',
  'fromPath',
  'toPath',
  'dir',
  'target',
  'backup',
]);
const BASE_DIRECTORY_KEYS = new Set([
  'baseDir',
  'oldPathBaseDir',
  'newPathBaseDir',
  'fromPathBaseDir',
  'toPathBaseDir',
]);

const MAX_COMMAND_CHARS = 256;
const MAX_ARGS_DEPTH = 32;
const MAX_ARGS_NODES = 100_000;
const MAX_ARGS_BYTES = 8 * 1024 * 1024;
const MAX_RAW_BODY_BYTES = 128 * 1024 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_HEADER_VALUE_BYTES = 64 * 1024;

/** @type {WeakMap<object, { allowedFilePage: string, label: string, allowExternalOpen: boolean, shell?: { openExternal: (url: string) => unknown } }>} */
const trustedWebContents = new WeakMap();
/** @type {WeakSet<object>} */
const guardedWebContents = new WeakSet();

function lazyShell() {
  try {
    return require('electron').shell;
  } catch {
    return null;
  }
}

function isWindowsAbsolutePath(input) {
  return /^[a-zA-Z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input) || /^\/\/[^/]/.test(input);
}

function canonicalFilePage(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('trusted file page must be a non-empty string');
  }

  let filePath;
  if (isWindowsAbsolutePath(input)) {
    // WHATWG URL parses `C:\...` and `D:/...` as custom c:/d: schemes.
    // Production passes loadFile() an OS path, so recognize Windows drive and
    // UNC paths before URL parsing. path.resolve/pathToFileURL use win32
    // semantics on the actual Windows runtime.
    filePath = input;
  } else {
    try {
      const url = new URL(input);
      if (url.protocol !== 'file:') {
        throw new Error(`trusted page must be file:, got ${url.protocol}`);
      }
      url.search = '';
      url.hash = '';
      filePath = fileURLToPath(url);
    } catch (err) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) throw err;
      filePath = input;
    }
  }

  return pathToFileURL(path.resolve(filePath)).href;
}

function canonicalNavigatedFilePage(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  url.search = '';
  url.hash = '';
  try {
    return pathToFileURL(path.resolve(fileURLToPath(url))).href;
  } catch {
    return null;
  }
}

function shouldOpenExternal(rawUrl) {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function openExternalSafely(record, rawUrl) {
  if (!record.allowExternalOpen || !shouldOpenExternal(rawUrl)) return;
  const shell = record.shell || lazyShell();
  if (!shell || typeof shell.openExternal !== 'function') return;
  try {
    Promise.resolve(shell.openExternal(rawUrl)).catch(() => {});
  } catch {
    /* deny still holds even when the OS refuses the handoff */
  }
}

function isAllowedRegisteredPage(record, rawUrl) {
  return canonicalNavigatedFilePage(rawUrl) === record.allowedFilePage;
}

function guardNavigationEvent(webContents, event, rawUrl) {
  const record = trustedWebContents.get(webContents);
  if (record && isAllowedRegisteredPage(record, rawUrl)) return;
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  if (record) openExternalSafely(record, rawUrl);
}

function installNavigationGuards(webContents) {
  if (!webContents || guardedWebContents.has(webContents)) return;
  guardedWebContents.add(webContents);

  if (typeof webContents.on === 'function') {
    webContents.on('will-navigate', (event, rawUrl) => {
      guardNavigationEvent(webContents, event, rawUrl);
    });
    webContents.on('will-redirect', (event, rawUrl) => {
      guardNavigationEvent(webContents, event, rawUrl);
    });
    webContents.on('will-attach-webview', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
    webContents.on('destroyed', () => {
      trustedWebContents.delete(webContents);
    });
  }

  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler(({ url } = {}) => {
      const record = trustedWebContents.get(webContents);
      if (record && typeof url === 'string') openExternalSafely(record, url);
      return { action: 'deny' };
    });
  }
}

/**
 * Register a privileged-preload WebContents to exactly one local file page.
 * Query strings and hashes are intentionally ignored so loadFile(..., {query})
 * can pass dynamic display-only values without widening the trusted document.
 *
 * @param {object} webContents
 * @param {string} filePage
 * @param {{ label?: string, allowExternalOpen?: boolean, shell?: { openExternal: (url: string) => unknown } }} [options]
 */
function registerPrivilegedWebContents(webContents, filePage, options = {}) {
  if (!webContents || typeof webContents !== 'object') {
    throw new Error('webContents is required');
  }
  const record = {
    allowedFilePage: canonicalFilePage(filePage),
    label: options.label || 'privileged-window',
    allowExternalOpen:
      options.allowExternalOpen == null
        ? options.label === 'main'
        : options.allowExternalOpen === true,
    shell: options.shell,
  };
  trustedWebContents.set(webContents, record);
  installNavigationGuards(webContents);
  return record;
}

/**
 * @param {{ webContents?: object }} win
 * @param {string} filePage
 * @param {{ label?: string, allowExternalOpen?: boolean, shell?: { openExternal: (url: string) => unknown } }} [options]
 */
function registerPrivilegedWindow(win, filePage, options = {}) {
  if (!win || !win.webContents) throw new Error('BrowserWindow with webContents is required');
  return registerPrivilegedWebContents(win.webContents, filePage, options);
}

function isDestroyedSender(sender) {
  return !!sender && typeof sender.isDestroyed === 'function' && sender.isDestroyed();
}

function isMainFrame(sender, senderFrame) {
  if (!senderFrame) return false;
  if (sender && sender.mainFrame) return senderFrame === sender.mainFrame;
  if ('parent' in senderFrame) return senderFrame.parent == null;
  if ('top' in senderFrame) return senderFrame.top === senderFrame;
  return false;
}

function senderFrameUrl(senderFrame) {
  return typeof senderFrame?.url === 'string' ? senderFrame.url : '';
}

function validateTrustedIpcSender(event) {
  const sender = event && event.sender;
  const senderFrame = event && event.senderFrame;
  const record = sender && trustedWebContents.get(sender);

  if (!record) return { ok: false, reason: 'unregistered IPC sender' };
  if (isDestroyedSender(sender)) return { ok: false, reason: 'destroyed IPC sender' };
  if (!isMainFrame(sender, senderFrame)) return { ok: false, reason: 'IPC sender is not the main frame' };
  if (!isAllowedRegisteredPage(record, senderFrameUrl(senderFrame))) {
    return { ok: false, reason: 'IPC sender URL is not the registered privileged page' };
  }
  return { ok: true, record };
}

function assertTrustedIpcSender(event) {
  const result = validateTrustedIpcSender(event);
  if (!result.ok) {
    throw new Error(`Blocked privileged IPC: ${result.reason}`);
  }
  return result.record;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function assertSafePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`);
  if (byteLength(value) > MAX_PATH_BYTES) throw new Error(`${label} is too long`);
}

function assertJsonValue(value, state, depth, key) {
  state.nodes++;
  if (state.nodes > MAX_ARGS_NODES) throw new Error('IPC args contain too many values');
  if (depth > MAX_ARGS_DEPTH) throw new Error('IPC args are too deeply nested');
  if (
    BASE_DIRECTORY_KEYS.has(key) &&
    value != null &&
    (!Number.isInteger(value) || !BASE_DIRECTORY_VALUES.has(value))
  ) {
    throw new Error(`unknown BaseDirectory value for ${key}`);
  }

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`IPC numeric value ${key || '<root>'} must be finite`);
    if (
      (key === 'ttlHours' || key === 'ttl_hours' || key === 'delayMs') &&
      value < 0
    ) {
      throw new Error(`IPC numeric value ${key} must not be negative`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new Error(`IPC string value ${key || '<root>'} must not contain NUL`);
    state.bytes += byteLength(value);
    if (state.bytes > MAX_ARGS_BYTES) throw new Error('IPC args are too large');
    if (PATH_KEYS.has(key)) assertSafePath(value, `IPC ${key}`);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`IPC args contain unsupported ${typeof value} value`);
  }
  if (state.seen.has(value)) throw new Error('IPC args must not be cyclic');
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (state.byteArrays?.has(value)) {
      state.bytes += value.length;
      if (state.bytes > MAX_ARGS_BYTES) throw new Error('IPC args are too large');
      for (const byte of value) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
          throw new Error('plugin:http|fetch body must contain only bytes');
        }
      }
    } else {
      for (const item of value) assertJsonValue(item, state, depth + 1, key);
    }
  } else {
    if (!isPlainRecord(value)) throw new Error('IPC args must contain only plain objects');
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey.includes('\0') || byteLength(childKey) > 512) {
        throw new Error('IPC args contain an invalid object key');
      }
      state.bytes += byteLength(childKey);
      if (state.bytes > MAX_ARGS_BYTES) throw new Error('IPC args are too large');
      assertJsonValue(childValue, state, depth + 1, childKey);
    }
  }
  state.seen.delete(value);
}

function jsonValidationState(cmd, args) {
  const byteArrays = new WeakSet();
  const httpData = cmd === 'plugin:http|fetch' ? args?.clientConfig?.data : null;
  if (Array.isArray(httpData)) byteArrays.add(httpData);
  return { nodes: 0, bytes: 0, seen: new WeakSet(), byteArrays };
}

function assertCommandAllowed(record, cmd) {
  const allowed = RESTRICTED_WINDOW_COMMANDS.get(record.label);
  if (allowed && !allowed.has(cmd)) {
    throw new Error(`window "${record.label}" cannot invoke ${cmd}`);
  }
}

function assertWindowEventAllowed(record, cmd, args) {
  if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
    const allowed = RESTRICTED_EMITTED_EVENTS.get(record.label);
    if (allowed && !allowed.has(args?.event)) {
      throw new Error(`window "${record.label}" cannot emit event ${String(args?.event)}`);
    }
  }
  if (cmd === 'plugin:event|listen') {
    const allowed = RESTRICTED_LISTENED_EVENTS.get(record.label);
    if (allowed && !allowed.has(args?.event)) {
      throw new Error(`window "${record.label}" cannot listen to event ${String(args?.event)}`);
    }
  }
}

function assertComputerUseEnvelope(cmd, args) {
  if (!COMPUTER_USE_PRIVILEGED_COMMANDS.has(cmd)) return;
  const token = args?.[COMPUTER_USE_TOKEN_ARG];
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
    throw new Error(`Computer Use command ${cmd} requires an authorization token`);
  }
}

function bodyByteLength(body) {
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

function validateInvokePayload(record, payload) {
  if (!isPlainRecord(payload)) throw new Error('IPC payload must be a plain object');
  for (const key of Object.keys(payload)) {
    if (!['cmd', 'args', 'body', 'headers'].includes(key)) {
      throw new Error(`IPC payload contains unsupported field: ${key}`);
    }
  }

  const { cmd, args, body, headers } = payload;
  if (
    typeof cmd !== 'string' ||
    cmd.length === 0 ||
    cmd.length > MAX_COMMAND_CHARS ||
    cmd.includes('\0')
  ) {
    throw new Error('IPC command must be a short non-empty string');
  }
  assertCommandAllowed(record, cmd);

  if (args != null) {
    if (!isPlainRecord(args)) throw new Error('IPC args must be a plain object');
    assertJsonValue(args, jsonValidationState(cmd, args), 0, '');
  }
  assertWindowEventAllowed(record, cmd, args);
  assertComputerUseEnvelope(cmd, args);
  if (
    cmd === 'plugin:path|resolve_directory' &&
    (!Number.isInteger(args?.directory) || !BASE_DIRECTORY_VALUES.has(args.directory))
  ) {
    throw new Error('unknown BaseDirectory value for directory');
  }

  const rawCommand = RAW_BODY_COMMANDS.has(cmd);
  let normalizedHeaders = headers;
  if (!rawCommand && (body !== undefined || headers !== undefined)) {
    throw new Error(`raw body and headers are not allowed for ${cmd}`);
  }
  if (rawCommand) {
    const bodyBytes = bodyByteLength(body);
    if (bodyBytes == null) throw new Error(`${cmd} requires a binary body`);
    if (bodyBytes > MAX_RAW_BODY_BYTES) throw new Error(`${cmd} body is too large`);
    if (!isPlainRecord(headers)) throw new Error(`${cmd} requires plain-object headers`);
    for (const [key, value] of Object.entries(headers)) {
      if (key !== 'path' && key !== 'options') {
        throw new Error(`${cmd} header ${key} is not allowed`);
      }
      if (key === 'options' && value === undefined) continue;
      if (typeof value !== 'string' || byteLength(value) > MAX_HEADER_VALUE_BYTES) {
        throw new Error(`${cmd} header ${key} is invalid`);
      }
    }
    if (typeof headers.path !== 'string') throw new Error(`${cmd} requires a path header`);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(headers.path);
    } catch {
      throw new Error(`${cmd} path header is not valid URI encoding`);
    }
    assertSafePath(decodedPath, `${cmd} path header`);
    if (headers.options != null) {
      let options;
      try {
        options = JSON.parse(headers.options);
      } catch {
        throw new Error(`${cmd} options header is not valid JSON`);
      }
      if (!isPlainRecord(options)) throw new Error(`${cmd} options header must encode an object`);
      assertJsonValue(options, { nodes: 0, bytes: 0, seen: new WeakSet() }, 0, '');
    }
    if (headers.options === undefined) normalizedHeaders = { ...headers, options: '{}' };
  }

  return { cmd, args: args || {}, body, headers: normalizedHeaders };
}

function assertResourceOwner(resource, sender, kind) {
  if (resource && resource.sender !== sender) {
    throw new Error(`${kind} belongs to a different IPC sender`);
  }
}

module.exports = {
  registerPrivilegedWebContents,
  registerPrivilegedWindow,
  validateTrustedIpcSender,
  assertTrustedIpcSender,
  canonicalFilePage,
  isWindowsAbsolutePath,
  canonicalNavigatedFilePage,
  shouldOpenExternal,
  validateInvokePayload,
  assertResourceOwner,
};
