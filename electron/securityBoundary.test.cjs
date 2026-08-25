'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const vm = require('node:vm');

const {
  registerPrivilegedWebContents,
  assertTrustedIpcSender,
  assertTrustedMainIpcSender,
  validateInvokePayload,
  assertResourceOwner,
  canonicalFilePage,
  isWindowsAbsolutePath,
} = require('./securityBoundary.cjs');

class FakeWebContents extends EventEmitter {
  constructor(url) {
    super();
    this._url = url;
    this.mainFrame = { url };
    this.destroyed = false;
    this.windowOpenHandler = null;
  }

  getURL() {
    return this._url;
  }

  isDestroyed() {
    return this.destroyed;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

function preventableEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function fileUrl(name) {
  return pathToFileURL(path.join(os.tmpdir(), 'abu-security-boundary-tests', name)).href;
}

function trustedEvent(webContents, url = webContents.mainFrame.url) {
  webContents.mainFrame.url = url;
  return { sender: webContents, senderFrame: webContents.mainFrame };
}

function trustedRecord(label = 'main') {
  const page = fileUrl(`${label}.html`);
  const wc = new FakeWebContents(page);
  return registerPrivilegedWebContents(wc, page, { label });
}

test('unregistered privileged IPC sender is blocked', () => {
  const wc = new FakeWebContents(fileUrl('main.html'));
  assert.throws(
    () => assertTrustedIpcSender(trustedEvent(wc)),
    /unregistered IPC sender/
  );
});

test('registered main-frame sender on exact file page is accepted, ignoring query and hash', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(`${page}?boot=1#top`);
  registerPrivilegedWebContents(wc, page);

  assert.doesNotThrow(() => assertTrustedIpcSender(trustedEvent(wc, `${page}?next=2#other`)));
});

test('main-only direct IPC accepts main and rejects other privileged windows', () => {
  const mainPage = fileUrl('main.html');
  const main = new FakeWebContents(mainPage);
  registerPrivilegedWebContents(main, mainPage, { label: 'main' });

  const petPage = fileUrl('pet.html');
  const pet = new FakeWebContents(petPage);
  registerPrivilegedWebContents(pet, petPage, { label: 'pet' });

  assert.doesNotThrow(() => assertTrustedMainIpcSender(trustedEvent(main)));
  assert.throws(
    () => assertTrustedMainIpcSender(trustedEvent(pet)),
    /main window/
  );
});

test('Windows drive and UNC paths are recognized as file pages before URL parsing', () => {
  for (const page of [
    String.raw`C:\Users\Abu App\resources\index.html`,
    'D:/Abu/resources/index.html',
    String.raw`\\server\share\Abu\index.html`,
  ]) {
    assert.equal(isWindowsAbsolutePath(page), true, page);
    assert.equal(new URL(canonicalFilePage(page)).protocol, 'file:', page);
  }
  assert.equal(isWindowsAbsolutePath('https://example.com/index.html'), false);
});

test('child frame sender is blocked even when URL matches', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page);
  const childFrame = { url: page, parent: wc.mainFrame, top: wc.mainFrame };

  assert.throws(
    () => assertTrustedIpcSender({ sender: wc, senderFrame: childFrame }),
    /not the main frame/
  );
});

test('missing senderFrame and destroyed senders are blocked', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page);

  assert.throws(
    () => assertTrustedIpcSender({ sender: wc, senderFrame: null }),
    /not the main frame/
  );
  wc.destroyed = true;
  assert.throws(
    () => assertTrustedIpcSender(trustedEvent(wc)),
    /destroyed IPC sender/
  );
});

test('sender is blocked after the main frame navigates away from the registered file page', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page);

  assert.throws(
    () => assertTrustedIpcSender(trustedEvent(wc, fileUrl('other.html'))),
    /not the registered privileged page/
  );
});

test('navigation guard remains fail-closed after the trust record is destroyed', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page);
  wc.emit('destroyed');

  const event = preventableEvent();
  wc.emit('will-navigate', event, 'https://example.com/after-destroy');

  assert.equal(event.defaultPrevented, true);
});

test('external navigation is prevented and handed to openExternal', () => {
  const page = fileUrl('main.html');
  const opened = [];
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page, {
    label: 'main',
    shell: { openExternal: (url) => opened.push(url) },
  });

  const event = preventableEvent();
  wc.emit('will-navigate', event, 'https://example.com/path?q=1');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, ['https://example.com/path?q=1']);
});

test('registered exact file navigation is allowed while other file pages are denied', () => {
  const page = fileUrl('main.html');
  const opened = [];
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page, {
    label: 'main',
    shell: { openExternal: (url) => opened.push(url) },
  });

  const same = preventableEvent();
  wc.emit('will-navigate', same, `${page}?x=1#hash`);
  assert.equal(same.defaultPrevented, false);

  const other = preventableEvent();
  wc.emit('will-redirect', other, fileUrl('other.html'));
  assert.equal(other.defaultPrevented, true);
  assert.deepEqual(opened, []);
});

test('malicious schemes are prevented without external handoff', () => {
  const page = fileUrl('main.html');
  const opened = [];
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page, {
    label: 'main',
    shell: { openExternal: (url) => opened.push(url) },
  });

  for (const url of ['javascript:alert(1)', 'data:text/html,pwned', 'about:blank']) {
    const event = preventableEvent();
    wc.emit('will-navigate', event, url);
    assert.equal(event.defaultPrevented, true, url);
  }
  assert.deepEqual(opened, []);
});

test('popup is always denied and external popup URLs are opened externally', () => {
  const page = fileUrl('main.html');
  const opened = [];
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page, {
    label: 'main',
    shell: { openExternal: (url) => opened.push(url) },
  });

  assert.deepEqual(wc.windowOpenHandler({ url: 'https://example.com/popup' }), { action: 'deny' });
  assert.deepEqual(wc.windowOpenHandler({ url: fileUrl('popup.html') }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/popup']);
});

test('non-main privileged windows deny external handoff', () => {
  const page = fileUrl('pet.html');
  const opened = [];
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page, {
    label: 'pet',
    shell: { openExternal: (url) => opened.push(url) },
  });

  const event = preventableEvent();
  wc.emit('will-navigate', event, 'https://example.com/from-pet');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, []);
});

test('webview attach is denied inside privileged windows', () => {
  const page = fileUrl('main.html');
  const wc = new FakeWebContents(page);
  registerPrivilegedWebContents(wc, page);

  const event = preventableEvent();
  wc.emit('will-attach-webview', event, {}, {});

  assert.equal(event.defaultPrevented, true);
});

test('pet, overlay, and stop-button windows only receive their required commands', () => {
  assert.doesNotThrow(() =>
    validateInvokePayload(trustedRecord('pet'), {
      cmd: 'pet_set_frame',
      args: { width: 80, height: 80 },
    })
  );
  assert.throws(
    () => validateInvokePayload(trustedRecord('pet'), { cmd: 'mcp_spawn', args: {} }),
    /cannot invoke/
  );
  assert.throws(
    () =>
      validateInvokePayload(trustedRecord('pet'), {
        cmd: 'plugin:event|emit',
        args: { event: 'computer-use-abort' },
      }),
    /cannot emit event/
  );
  assert.doesNotThrow(() =>
    validateInvokePayload(trustedRecord('overlay'), {
      cmd: 'plugin:event|listen',
      args: { event: 'computer-use-status', handler: 1 },
    })
  );
  assert.throws(
    () =>
      validateInvokePayload(trustedRecord('overlay'), {
        cmd: 'plugin:event|emit',
        args: { event: 'computer-use-abort' },
      }),
    /cannot invoke/
  );
  assert.throws(
    () =>
      validateInvokePayload(trustedRecord('overlay'), {
        cmd: 'plugin:event|listen',
        args: { event: 'close-requested', handler: 1 },
      }),
    /cannot listen to event/
  );
  assert.doesNotThrow(() =>
    validateInvokePayload(trustedRecord('stop-button'), {
      cmd: 'plugin:event|emit',
      args: { event: 'computer-use-abort' },
    })
  );
});

test('main renderer cannot invoke privileged Computer Use commands without a session token', () => {
  const record = trustedRecord('main');
  for (const cmd of ['mouse_click', 'ax_press', 'capture_screen']) {
    assert.throws(
      () => validateInvokePayload(record, { cmd, args: {} }),
      /requires an authorization token/,
      cmd
    );
  }
  assert.doesNotThrow(() =>
    validateInvokePayload(record, {
      cmd: 'mouse_click',
      args: {
        x: 1,
        y: 2,
        __abuComputerUseToken: '0123456789abcdef0123456789abcdef',
      },
    })
  );
});

test('invoke payload rejects malformed, oversized, and dangerous values', () => {
  const record = trustedRecord();
  assert.throws(() => validateInvokePayload(record, null), /plain object/);
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'x'.repeat(257), args: {} }),
    /short non-empty string/
  );
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'plugin:path|home_dir', args: [] }),
    /args must be a plain object/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'plugin:path|home_dir',
        args: { path: `bad\0path` },
      }),
    /must not contain NUL/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'plugin:path|resolve_directory',
        args: { directory: 999 },
      }),
    /unknown BaseDirectory/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'plugin:fs|exists',
        args: { path: 'a.txt', options: { baseDir: '12' } },
      }),
    /unknown BaseDirectory/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'cleanup_old_backups',
        args: { dir: os.tmpdir(), ttlHours: -1 },
      }),
    /must not be negative/
  );

  let nested = {};
  for (let i = 0; i < 34; i++) nested = { child: nested };
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'plugin:path|home_dir', args: nested }),
    /too deeply nested/
  );
});

test('raw bodies and headers are limited to fs write commands', () => {
  const record = trustedRecord();
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'mcp_write',
        args: {},
        body: Buffer.from('x'),
      }),
    /raw body and headers are not allowed/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'plugin:fs|write_file',
        body: 'not-binary',
        headers: { path: encodeURIComponent('/tmp/a'), options: '{}' },
    }),
    /requires a binary body/
  );
  assert.throws(
    () =>
      validateInvokePayload(record, {
        cmd: 'plugin:fs|write_file',
        body: Buffer.from('x'),
        headers: {
          path: encodeURIComponent('/tmp/a'),
          options: '{}',
          unexpected: 'x',
        },
      }),
    /header unexpected is not allowed/
  );
  const normalized = validateInvokePayload(record, {
    cmd: 'plugin:fs|write_text_file',
    body: Buffer.from('ok'),
    headers: { path: encodeURIComponent('/tmp/no-options'), options: undefined },
  });
  assert.equal(normalized.headers.options, '{}');
  assert.doesNotThrow(() =>
    validateInvokePayload(record, {
      cmd: 'plugin:fs|write_file',
      body: Buffer.from('ok'),
      headers: { path: encodeURIComponent('/tmp/a'), options: '{"baseDir":12}' },
    })
  );
});

test('real plugin-fs writeTextFile without options produces an accepted raw request', async () => {
  const previousWindow = global.window;
  let captured;
  global.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, body, options) => {
        captured = { cmd, body, headers: options?.headers };
      },
    },
  };
  try {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile('/tmp/abu-sdk-shape.txt', 'sdk-shape');
  } finally {
    global.window = previousWindow;
  }

  assert.equal(captured.cmd, 'plugin:fs|write_text_file');
  assert.equal(captured.headers.options, undefined);
  const normalized = validateInvokePayload(trustedRecord(), captured);
  assert.equal(normalized.headers.options, '{}');
});

test('plugin:http accepts a large byte-array body without counting every byte as a JSON node', () => {
  const data = Array.from({ length: 128 * 1024 }, (_value, index) => index % 256);
  assert.doesNotThrow(() =>
    validateInvokePayload(trustedRecord(), {
      cmd: 'plugin:http|fetch',
      args: {
        clientConfig: {
          method: 'POST',
          url: 'http://127.0.0.1:11434/api/chat',
          headers: [['content-type', 'application/json']],
          data,
        },
      },
    })
  );
  data[data.length - 1] = 256;
  assert.throws(
    () =>
      validateInvokePayload(trustedRecord(), {
        cmd: 'plugin:http|fetch',
        args: { clientConfig: { data } },
      }),
    /only bytes/
  );
});

test('resources cannot be released by another IPC sender', () => {
  const owner = {};
  const other = {};
  assert.doesNotThrow(() => assertResourceOwner({ sender: owner }, owner, 'test resource'));
  assert.throws(
    () => assertResourceOwner({ sender: owner }, other, 'test resource'),
    /different IPC sender/
  );
});

test('preload exposes only narrow file, diagnostics, and receive-only sidecar bridges', async () => {
  const exposed = new Map();
  const sent = [];
  const invoked = [];
  let holdImageSave = false;
  let resolveHeldImageSave;
  const ipcListeners = new Map();
  const nativeFile = { name: 'report.pdf' };
  const webUtils = {
    getPathForFile(file) {
      assert.equal(file, nativeFile);
      return '/native/report.pdf';
    },
  };
  const ipcRenderer = {
    invoke: async (channel, payload) => {
      invoked.push({ channel, payload });
      if (channel === 'abu:fs-canonicalize-for-policy') return `/canonical${payload.path}`;
      if (channel === 'abu:runtime-diagnostics') return { schemaVersion: 1 };
      if (channel === 'abu:sidecar-bridge-state') {
        return { version: 1, lastSequence: payload.afterSequence };
      }
      if (channel === 'abu:save-image-attachment') {
        if (holdImageSave) {
          return new Promise((resolve) => {
            resolveHeldImageSave = resolve;
          });
        }
        return { saved: true, fileName: 'image.png' };
      }
      return undefined;
    },
    on: (channel, callback) => ipcListeners.set(channel, callback),
    send: (channel, payload) => sent.push({ channel, payload }),
    sendSync: () => null,
  };
  const context = {
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(key, value) {
            exposed.set(key, value);
          },
        },
        ipcRenderer,
        webUtils,
      };
    },
  };
  context.globalThis = context;

  const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInNewContext(preloadSource, context, { filename: 'preload.cjs' });

  const shellBridge = exposed.get('__ABU_SHELL__');
  assert.deepEqual(Object.keys(shellBridge).sort(), [
    'canonicalizePathForPolicy',
    'getPathForFile',
    'getRuntimeDiagnostics',
    'getSidecarBridgeSnapshot',
    'mainSupervisesSidecar',
    'recordRuntimeEvent',
    'saveImageAttachment',
    'subscribeSidecarEvents',
  ]);
  assert.equal(
    await shellBridge.canonicalizePathForPolicy('/native/report.pdf'),
    '/canonical/native/report.pdf',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(invoked[0])), {
    channel: 'abu:fs-canonicalize-for-policy',
    payload: { path: '/native/report.pdf', followFinalSymlink: true },
  });
  assert.equal(shellBridge.getPathForFile(nativeFile), '/native/report.pdf');
  assert.deepEqual(
    await shellBridge.saveImageAttachment({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      suggestedName: 'image.png',
    }),
    { saved: true, fileName: 'image.png' },
  );
  assert.equal(invoked[1].channel, 'abu:save-image-attachment');
  assert.equal(invoked[1].payload.mediaType, 'image/png');
  assert.deepEqual(Array.from(invoked[1].payload.data), [1, 2, 3]);
  assert.throws(
    () => shellBridge.saveImageAttachment({
      data: new Uint8Array([1]),
      mediaType: 'image/png',
      destinationPath: '/renderer-chosen/path.png',
    }),
    /does not accept destinationPath/,
  );
  assert.throws(
    () => shellBridge.saveImageAttachment({
      sourcePath: '/renderer/reopen.png',
      mediaType: 'image/png',
    }),
    /does not accept sourcePath/,
  );
  assert.throws(
    () => shellBridge.saveImageAttachment({ data: new Uint8Array(), mediaType: 'image/png' }),
    /data is invalid/,
  );

  holdImageSave = true;
  const firstPendingSave = shellBridge.saveImageAttachment({
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
  });
  const saveInvokeCount = invoked.filter(({ channel }) => (
    channel === 'abu:save-image-attachment'
  )).length;
  assert.throws(
    () => shellBridge.saveImageAttachment({
      data: new Uint8Array([4, 5, 6]),
      mediaType: 'image/png',
    }),
    /already in progress/,
  );
  assert.equal(invoked.filter(({ channel }) => (
    channel === 'abu:save-image-attachment'
  )).length, saveInvokeCount);
  resolveHeldImageSave({ saved: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await firstPendingSave)), { saved: false });
  holdImageSave = false;
  await assert.doesNotReject(shellBridge.saveImageAttachment({
    data: new Uint8Array([7, 8, 9]),
    mediaType: 'image/png',
  }));
  shellBridge.recordRuntimeEvent({ event: 'renderer.test', runId: 'run-1' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    channel: 'abu:runtime-event',
    payload: { event: 'renderer.test', runId: 'run-1' },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await shellBridge.getRuntimeDiagnostics())), { schemaVersion: 1 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await shellBridge.getSidecarBridgeSnapshot(17))),
    { version: 1, lastSequence: 17 },
  );

  const sidecarEvents = [];
  // Main may emit before renderer modules finish evaluating. The receive-only
  // bridge must retain that first valid frame until sidecarManager subscribes.
  ipcListeners.get('abu:sidecar-event')({}, {
    type: 'message', payload: '{"ok":true}', sequence: 1, generation: 1,
  });
  ipcListeners.get('abu:sidecar-event')({}, {
    type: 'unknown', payload: 'ignored', sequence: 2, generation: 1,
  });
  const unsubscribe = shellBridge.subscribeSidecarEvents((event) => sidecarEvents.push(event));
  assert.deepEqual(JSON.parse(JSON.stringify(sidecarEvents)), [{
    type: 'message',
    payload: '{"ok":true}',
    sequence: 1,
    generation: 1,
  }]);
  unsubscribe();
  ipcListeners.get('abu:sidecar-event')({}, {
    type: 'close', payload: '', sequence: 3, generation: 1,
  });
  assert.equal(sidecarEvents.length, 1);
});
