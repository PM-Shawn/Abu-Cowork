'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateInvokePayload, configureIpcPayloadLimits } = require('./securityBoundary.cjs');
const { fsDispatch } = require('./fsHost.cjs');
const { payloadTooLargeMessage } = require('./ipcPayloadError.cjs');

const record = { label: 'main', allowedFilePage: 'x', allowExternalOpen: false };
const MB = 1024 * 1024;
const bytesOf = (text) => new Uint8Array(Buffer.from(text));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-ipc-raw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('plain args are measured in UTF-8 bytes and fail with the typed error', () => {
  // 3 MiB of CJK = 9 MiB UTF-8 but only 3 MiB UTF-16 units.
  const text = '中'.repeat(3 * MB);
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'mcp_write', args: { id: 'abu-sidecar', message: text } }),
    (err) => err.code === 'payload_too_large'
      && err.method === 'mcp_write'
      && err.limit === 8 * MB
      && err.bytes > 8 * MB
      && /^payload_too_large \{/.test(err.message),
  );
  // Plain small writes keep the old shape.
  const plain = validateInvokePayload(record, { cmd: 'mcp_write', args: { id: 'abu-sidecar', message: '{}' } });
  assert.deepEqual(plain, { cmd: 'mcp_write', args: { id: 'abu-sidecar', message: '{}' }, body: undefined, headers: undefined });
});

test('mcp_write raw body: accepted up to 128 MiB, typed error above, single-line UTF-8 only', () => {
  const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.start', params: { t: '中'.repeat(4 * MB) } }));
  const ok = validateInvokePayload(record, {
    cmd: 'mcp_write',
    body: new Uint8Array(line),
    headers: { id: 'abu-sidecar', method: 'agent.start', rpcId: '1', runId: 'run-1' },
  });
  assert.equal(ok.cmd, 'mcp_write');
  assert.deepEqual(ok.args, { id: 'abu-sidecar' });
  assert.ok(Buffer.isBuffer(ok.body));
  assert.equal(ok.body.length, line.length);
  assert.ok(ok.body.equals(line));
  assert.deepEqual(ok.headers, { method: 'agent.start', rpcId: '1', runId: 'run-1' });

  // A view into a larger buffer only carries its own bytes.
  const backing = Buffer.from('xx{"a":1}yy');
  const view = validateInvokePayload(record, {
    cmd: 'mcp_write',
    body: new Uint8Array(backing.buffer, backing.byteOffset + 2, 7),
    headers: { id: 'abu-sidecar' },
  });
  assert.equal(view.body.toString('utf8'), '{"a":1}');
  assert.deepEqual(view.headers, {});

  assert.throws(
    () => validateInvokePayload(record, { cmd: 'mcp_write', body: new Uint8Array(new ArrayBuffer(128 * MB + 1)), headers: { id: 'abu-sidecar' } }),
    (err) => err.code === 'payload_too_large'
      && err.message === payloadTooLargeMessage({ bytes: 128 * MB + 1, limit: 128 * MB, method: 'mcp_write' }),
  );
  for (const bad of [Buffer.from('a\nb'), Buffer.from('a\rb'), Buffer.from([0x61, 0x00]), Buffer.from([0xff, 0xfe]), Buffer.from([0xe4, 0xb8])]) {
    assert.throws(
      () => validateInvokePayload(record, { cmd: 'mcp_write', body: new Uint8Array(bad), headers: { id: 'abu-sidecar' } }),
      /body must/,
    );
  }
});

test('mcp_write raw headers follow a closed schema', () => {
  const body = bytesOf('{}');
  const attempt = (headers, extra = {}) => validateInvokePayload(record, { cmd: 'mcp_write', body, headers, ...extra });
  assert.throws(() => attempt({}), /requires a id header/);
  assert.throws(() => attempt(undefined), /requires plain-object headers/);
  assert.throws(() => attempt(['abu-sidecar']), /requires plain-object headers/);
  assert.throws(() => attempt({ id: 'x', path: '/etc/passwd' }), /header path is not allowed/);
  assert.throws(() => attempt({ id: 'x', options: '{}' }), /header options is not allowed/);
  assert.throws(() => attempt({ id: 'x', message: 'y' }), /header message is not allowed/);
  assert.throws(() => attempt({ id: 'x', constructor: 'y' }), /header constructor is not allowed/);
  assert.throws(() => attempt(JSON.parse('{"id":"x","__proto__":"y"}')), /header __proto__ is not allowed/);
  assert.throws(() => attempt({ id: 'x', method: 'm'.repeat(257) }), /header method is invalid/);
  assert.throws(() => attempt({ id: 'x', method: '中'.repeat(86) }), /header method is invalid/);
  assert.throws(() => attempt({ id: 'x', rpcId: 5 }), /header rpcId is invalid/);
  assert.throws(() => attempt({ id: '' }), /header id is invalid/);
  assert.throws(() => attempt({ id: 'a\0b' }), /header id is invalid/);
  assert.throws(() => attempt({ id: 'x' }, { args: { id: 'x' } }), /must not carry args/);
  assert.throws(() => attempt({ id: 'x' }, { args: {} }), /must not carry args/);
  assert.throws(() => attempt({ id: 'x' }, { body: 'not-binary' }), /requires a binary body/);
  assert.throws(() => attempt({ id: 'x' }, { body: undefined }), /requires a binary body/);
  assert.deepEqual(attempt({ id: 'x', method: 'm'.repeat(256), payloadDigest: 'd', clientMessageId: 'c' }).headers, {
    method: 'm'.repeat(256),
    payloadDigest: 'd',
    clientMessageId: 'c',
  });
});

test('raw bodies stay forbidden for every other non-fs command', () => {
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'run_shell_command', body: Buffer.from('x'), headers: { path: 'a' } }),
    /raw body and headers are not allowed/,
  );
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'mcp_spawn', body: bytesOf('x'), headers: { id: 'abu-sidecar' } }),
    /raw body and headers are not allowed/,
  );
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'atomic_write_with_backup', body: bytesOf('x'), headers: { path: encodeURIComponent('/tmp/a') } }),
    /raw body and headers are not allowed/,
  );
});

test('restricted windows cannot reach the raw text commands', () => {
  for (const label of ['pet', 'overlay', 'stop-button']) {
    for (const [cmd, headers] of [
      ['mcp_write', { id: 'abu-sidecar' }],
      ['append_file_text', { path: encodeURIComponent('/tmp/a') }],
      ['atomic_write_text', { path: encodeURIComponent('/tmp/a') }],
    ]) {
      assert.throws(
        () => validateInvokePayload({ label }, { cmd, body: bytesOf('{}'), headers }),
        new RegExp(`window "${label}" cannot invoke ${cmd}`),
      );
    }
  }
});

test('E2E override lowers only the mcp_write raw limit', () => {
  configureIpcPayloadLimits({ mcpWriteRawBodyBytes: 10 });
  try {
    assert.throws(
      () => validateInvokePayload(record, { cmd: 'mcp_write', body: bytesOf('{"a":"0123456789"}'), headers: { id: 'abu-sidecar' } }),
      (err) => err.code === 'payload_too_large' && err.limit === 10 && err.bytes === 18,
    );
    assert.doesNotThrow(() => validateInvokePayload(record, {
      cmd: 'append_file_text', body: bytesOf('0123456789ABCDEF'), headers: { path: encodeURIComponent('/tmp/a.jsonl') },
    }));
  } finally {
    configureIpcPayloadLimits({});
  }
  assert.doesNotThrow(() => validateInvokePayload(record, {
    cmd: 'mcp_write', body: bytesOf('{"a":"0123456789"}'), headers: { id: 'abu-sidecar' },
  }));
});

test('invalid overrides are ignored and can never raise the limit', () => {
  for (const value of [0, -1, 1.5, Number.NaN, '10', 256 * MB]) {
    configureIpcPayloadLimits({ mcpWriteRawBodyBytes: value });
    try {
      if (value === 256 * MB) {
        assert.throws(
          () => validateInvokePayload(record, { cmd: 'mcp_write', body: new Uint8Array(new ArrayBuffer(128 * MB + 1)), headers: { id: 'abu-sidecar' } }),
          (err) => err.code === 'payload_too_large' && err.limit === 128 * MB,
        );
      } else {
        assert.doesNotThrow(() => validateInvokePayload(record, {
          cmd: 'mcp_write', body: bytesOf('{"a":"0123456789"}'), headers: { id: 'abu-sidecar' },
        }));
      }
    } finally {
      configureIpcPayloadLimits({});
    }
  }
});

test('ledger: a single >8 MiB line appends and an >8 MiB file atomically rewrites through the raw form', (t) => {
  const dir = tempDir(t);
  const ledger = path.join(dir, 'conv', 'messages.jsonl');
  const line = `${JSON.stringify({ id: 'm1', content: '中'.repeat(3 * MB) })}\n`;
  const append = validateInvokePayload(record, {
    cmd: 'append_file_text', body: bytesOf(line), headers: { path: encodeURIComponent(ledger) },
  });
  assert.deepEqual(append.args, { path: ledger });
  assert.deepEqual(append.headers, {});
  fsDispatch({}, append.cmd, append);
  assert.equal(fs.readFileSync(ledger, 'utf8'), line);

  const whole = line + line;
  const rewrite = validateInvokePayload(record, {
    cmd: 'atomic_write_text', body: bytesOf(whole), headers: { path: encodeURIComponent(ledger) },
  });
  fsDispatch({}, rewrite.cmd, rewrite);
  assert.equal(fs.statSync(ledger).size, Buffer.byteLength(whole));
  assert.equal(fs.readFileSync(ledger, 'utf8'), whole);
});

test('raw fs text commands keep the path checks of the plain form', (t) => {
  const dir = tempDir(t);
  const attempt = (cmd, headers, body = bytesOf('x')) => validateInvokePayload(record, { cmd, body, headers });
  for (const cmd of ['append_file_text', 'atomic_write_text']) {
    assert.throws(() => attempt(cmd, {}), new RegExp(`${cmd} requires a path header`));
    assert.throws(() => attempt(cmd, { path: encodeURIComponent('/tmp/a%00b').replace('%2500', '%00') }), /must not contain NUL/);
    assert.throws(() => attempt(cmd, { path: '%E0%A4%A' }), /not valid URI encoding/);
    assert.throws(() => attempt(cmd, { path: encodeURIComponent(`/${'a'.repeat(40 * 1024)}`) }), /header path is invalid/);
    assert.throws(() => attempt(cmd, { path: encodeURIComponent('/tmp/a'), id: 'abu-sidecar' }), /header id is not allowed/);
    assert.throws(() => attempt(cmd, { path: encodeURIComponent('/tmp/a'), options: '{}' }), /header options is not allowed/);
    assert.throws(() => attempt(cmd, { path: encodeURIComponent('/tmp/a') }, new Uint8Array([0xff])), /valid UTF-8/);
    assert.throws(() => attempt(cmd, { path: encodeURIComponent('/tmp/a') }, new Uint8Array([0x61, 0])), /must not contain NUL/);
    // Multi-line text is the whole point of the fs commands.
    assert.doesNotThrow(() => attempt(cmd, { path: encodeURIComponent(path.join(dir, 'ok.jsonl')) }, bytesOf('a\nb\r\n')));
  }
});

// Windows fs scope is allow-all (fsHost assertAllowed), like fsHost.security.test.cjs.
test('raw fs text commands still hit the dispatch-time scope guard', { skip: process.platform === 'win32' }, () => {
  for (const cmd of ['append_file_text', 'atomic_write_text']) {
    const outside = validateInvokePayload(record, {
      cmd, body: bytesOf('x'), headers: { path: encodeURIComponent('/etc/abu-549-should-not-exist.txt') },
    });
    assert.throws(() => fsDispatch({}, outside.cmd, outside), /outside the allowed scope/);
    assert.equal(fs.existsSync('/etc/abu-549-should-not-exist.txt'), false);
  }
});

test('plain-form append/atomic keep working unchanged', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.txt');
  const plain = validateInvokePayload(record, { cmd: 'append_file_text', args: { path: file, data: 'hi' } });
  assert.equal(plain.body, undefined);
  fsDispatch({}, plain.cmd, plain);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hi');
  const atomic = validateInvokePayload(record, { cmd: 'atomic_write_text', args: { path: file, content: 'whole' } });
  fsDispatch({}, atomic.cmd, atomic);
  assert.equal(fs.readFileSync(file, 'utf8'), 'whole');
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'append_file_text', args: { path: file, data: 'x'.repeat(8 * MB) } }),
    (err) => err.code === 'payload_too_large' && err.method === 'append_file_text',
  );
});

function loadPreload() {
  const exposed = new Map();
  const invoked = [];
  const context = {
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
        ipcRenderer: {
          invoke: async (channel, payload) => { invoked.push({ channel, payload }); },
          on() {},
          send() {},
          sendSync: () => null,
        },
        webUtils: { getPathForFile: () => '' },
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), context, { filename: 'preload.cjs' });
  return { internals: exposed.get('__TAURI_INTERNALS__'), invoked };
}

test('preload counts the same UTF-8 bytes as main and throws the same typed message', () => {
  const { internals, invoked } = loadPreload();
  // Escaping-heavy text: JSON escapes double it, but main counts raw bytes.
  const quotes = '"'.repeat(5 * MB);
  internals.invoke('mcp_write', { id: 'abu-sidecar', message: quotes });
  assert.equal(invoked.length, 1, 'preload must not reject what main accepts');
  assert.doesNotThrow(() => validateInvokePayload(record, structuredClone(invoked[0].payload)));

  const cjk = '中'.repeat(3 * MB);
  const expectedBytes = Buffer.byteLength('id') + Buffer.byteLength('abu-sidecar') + Buffer.byteLength('message') + Buffer.byteLength(cjk);
  const preloadMessage = (() => {
    try {
      internals.invoke('mcp_write', { id: 'abu-sidecar', message: cjk });
    } catch (err) {
      return err.message;
    }
    return null;
  })();
  assert.equal(preloadMessage, payloadTooLargeMessage({ bytes: expectedBytes, limit: 8 * MB, method: 'mcp_write' }));
  assert.equal(invoked.length, 1);
  // Main measures the same total for the same args.
  assert.throws(
    () => validateInvokePayload(record, { cmd: 'mcp_write', args: { id: 'abu-sidecar', message: cjk } }),
    (err) => err.message === preloadMessage,
  );

  assert.throws(
    () => internals.invoke('mcp_write', new Uint8Array(new ArrayBuffer(128 * MB + 1)), { headers: { id: 'abu-sidecar' } }),
    (err) => err.message === payloadTooLargeMessage({ bytes: 128 * MB + 1, limit: 128 * MB, method: 'mcp_write' }),
  );
  assert.equal(invoked.length, 1);

  // The raw form passes through with body + headers and no args.
  internals.invoke('append_file_text', new Uint8Array(Buffer.from('line\n')), { headers: { path: encodeURIComponent('/tmp/x') } });
  assert.equal(invoked.length, 2);
  // structuredClone = what Electron IPC does to the payload.
  const forwarded = structuredClone(invoked[1].payload);
  assert.equal(forwarded.cmd, 'append_file_text');
  assert.equal(forwarded.args, undefined);
  assert.deepEqual(forwarded.headers, { path: encodeURIComponent('/tmp/x') });
  assert.deepEqual(validateInvokePayload(record, forwarded).args, { path: '/tmp/x' });
});
