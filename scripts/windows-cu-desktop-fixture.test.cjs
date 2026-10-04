'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const readline = require('node:readline');
const { startDesktopFixture, validateFixtureState } = require('./windows-cu-desktop-fixture.cjs');

const initial = {
  version: 1, sequence: 1, pid: 42, scenario: 'edit',
  windows: [{ role: 'main', windowId: '0x1A2B' }],
  dialogDepth: 0, cancelCount: 0, markerPresent: false,
  mainMarkerPresent: false, secondaryMarkerPresent: false, unexpectedWrites: 0,
};
const expected = { pid: 42, scenario: 'edit', sequence: 0 };

test('valid blank initial state is not a successful document', () => {
  const state = validateFixtureState(initial, expected);
  assert.deepEqual(state, {
    version: 1, sequence: 1, pid: 42, scenario: 'edit',
    windows: [{ role: 'main', windowId: '0x1A2B' }],
    dialogDepth: 0, cancelCount: 0, markerPresent: false,
    mainMarkerPresent: false, secondaryMarkerPresent: false, unexpectedWrites: 0,
  });
  assert.equal(state.markerPresent, false);
});

test('parser rejects wrong identity, replay, version, unknown content and invalid counters', () => {
  assert.equal(validateFixtureState({ version: 1, pid: 99 }, expected), null);
  for (const patch of [
    { pid: 99 }, { scenario: 'window-switch' }, { version: 2 }, { sequence: 0 },
    { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { text: 'arbitrary private text' }, { markerPresent: 'true' },
    { mainMarkerPresent: 1 }, { secondaryMarkerPresent: null },
    { cancelCount: -1 }, { unexpectedWrites: 0.5 }, { dialogDepth: 3 },
  ]) assert.equal(validateFixtureState({ ...initial, ...patch }, expected), null);
  assert.equal(validateFixtureState(initial, { ...expected, sequence: 1 }), null);
  assert.equal(validateFixtureState(initial, { ...expected, sequence: 2 }), null);
  for (const raw of [null, 'private text', [], {}, { ...initial, pid: undefined }]) {
    assert.equal(validateFixtureState(raw, expected), null);
  }
});

test('parser rejects malformed, duplicated, foreign and structurally impossible windows', () => {
  for (const windows of [
    null, {}, [{ role: 'main' }], [{ role: 'main', windowId: '42' }],
    [{ role: 'main', windowId: '0x0' }], [{ role: 'main', windowId: '0x1a2b' }],
    [{ role: 'main', windowId: '0x12345678901234567' }],
    [{ role: 'main', windowId: '0x1A2B', text: 'private' }],
    [{ role: 'foreign', windowId: '0x1A2B' }],
    [{ role: 'main', windowId: '0x1A2B' }, { role: 'main', windowId: '0x2B3C' }],
    [{ role: 'main', windowId: '0x1A2B' }, { role: 'secondary', windowId: '0x1A2B' }],
    [{ role: 'dialog', windowId: '0x1A2B' }],
    [{ role: 'main', windowId: '0x1A2B' }, { role: 'dialog', windowId: '0x2B3C' }],
  ]) assert.equal(validateFixtureState({ ...initial, windows }, expected), null);
  assert.equal(validateFixtureState({ ...initial, dialogDepth: 1 }, expected), null);
});

test('parser requires marker equality in the scenario destination, but allows pending debounce', () => {
  assert.equal(validateFixtureState({ ...initial, markerPresent: true }, expected), null);
  assert.equal(validateFixtureState({ ...initial, secondaryMarkerPresent: true }, expected), null);
  assert.equal(validateFixtureState({ ...initial, mainMarkerPresent: true }, expected).markerPresent, false);
  assert.equal(validateFixtureState({ ...initial, mainMarkerPresent: true, markerPresent: true }, expected).markerPresent, true);
  const switched = { ...initial, scenario: 'window-switch', windows: [
    { role: 'main', windowId: '0x1A2B' }, { role: 'secondary', windowId: '0x2B3C' },
  ], secondaryMarkerPresent: true, markerPresent: true };
  assert.equal(validateFixtureState(switched, { ...expected, scenario: 'window-switch' }).markerPresent, true);
  assert.equal(validateFixtureState({ ...switched, secondaryMarkerPresent: false }, { ...expected, scenario: 'window-switch' }), null);
});

test('validated state is immutable and detached from later caller mutation', () => {
  const raw = structuredClone(initial);
  const state = validateFixtureState(raw, expected);
  raw.windows[0].windowId = '0x9';
  assert.equal(state.windows[0].windowId, '0x1A2B');
  assert.throws(() => { state.markerPresent = true; }, TypeError);
  assert.throws(() => { state.windows.push({ role: 'main', windowId: '0x9' }); }, TypeError);
});

test('parser rejects main marker equality when the main window is absent', () => {
  assert.equal(validateFixtureState({
    version: 1, sequence: 1, pid: 42, scenario: 'edit', windows: [],
    dialogDepth: 0, cancelCount: 0, markerPresent: false,
    mainMarkerPresent: true, secondaryMarkerPresent: false, unexpectedWrites: 0,
  }, { pid: 42, scenario: 'edit', sequence: 0 }), null);
});

test('parser rejects secondary marker equality when the destination window is absent', () => {
  assert.equal(validateFixtureState({
    version: 1, sequence: 1, pid: 42, scenario: 'window-switch',
    windows: [{ role: 'main', windowId: '0x1A2B' }],
    dialogDepth: 0, cancelCount: 0, markerPresent: true,
    mainMarkerPresent: false, secondaryMarkerPresent: true, unexpectedWrites: 0,
  }, { pid: 42, scenario: 'window-switch', sequence: 0 }), null);
  assert.equal(validateFixtureState({
    version: 1, sequence: 1, pid: 42, scenario: 'window-switch',
    windows: [{ role: 'main', windowId: '0x1A2B' }],
    dialogDepth: 0, cancelCount: 0, markerPresent: false,
    mainMarkerPresent: false, secondaryMarkerPresent: true, unexpectedWrites: 0,
  }, { pid: 42, scenario: 'window-switch', sequence: 0 }), null);
});

test('invalid scenario and marker reject before any process or temporary directory is created', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('must not spawn'); });
  const mkdir = t.mock.method(fs, 'mkdtemp', () => { throw new Error('must not create files'); });
  for (const args of [undefined, null, {}, { scenario: 'unknown', marker: 'ABU_CU_SAFE' },
    { scenario: 'edit', marker: '' }, { scenario: 'edit', marker: 'ABU_CU_' },
    { scenario: 'edit', marker: 'ABU_CU_lowercase' }, { scenario: 'edit', marker: 'ABU_CU_X\n' },
    { scenario: 'edit', marker: 'ABU_CU_X;throw' }, { scenario: 'edit', marker: 'ABU_CU_' + 'A'.repeat(81) },
  ]) await assert.rejects(startDesktopFixture(args), /scenario|marker|options/);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(mkdir.mock.callCount(), 0);
});

// Only OS/process boundaries are replaced. The parser, framing, waiter lifecycle,
// environment filtering and ownership checks run through the public controller.
function fakeDesktop(t, { compileCode = 0, initialEvent = initial, automaticExit = true, hungCompiler = false } = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const directory = path.resolve('fixture-test-temp', 'abu-cu-desktop-ABC123');
  t.mock.method(os, 'tmpdir', () => path.dirname(directory));
  t.mock.method(fs, 'realpath', async (value) => value);
  t.mock.method(fs, 'mkdtemp', async () => directory);
  t.mock.method(fs, 'lstat', async () => ({ isDirectory: () => true, isSymbolicLink: () => false }));
  const removals = t.mock.method(fs, 'rm', async () => {});
  const children = [];
  const spawns = t.mock.method(childProcess, 'spawn', (_file, _args, options) => {
    const child = new EventEmitter();
    child.pid = options.stdio[0] === 'ignore' ? 41 : 42;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = options.stdio[0] === 'ignore' ? null : new PassThrough();
    child.kill = t.mock.fn(() => { if (!hungCompiler) queueMicrotask(() => child.emit('close', 1)); return true; });
    if (child.stdin && automaticExit) child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
    children.push(child);
    queueMicrotask(() => {
      if (!child.stdin) { if (!hungCompiler) child.emit('close', compileCode); }
      else if (initialEvent) child.stdout.write(JSON.stringify(initialEvent) + '\n');
    });
    return child;
  });
  return { directory, children, spawns, removals };
}

test('controller strips the evaluation key, uses argument boundaries and only removes its exited fixture directory', async (t) => {
  const context = fakeDesktop(t);
  const previous = process.env.ABU_CU_EVAL_API_KEY;
  process.env.ABU_CU_EVAL_API_KEY = 'fixture-test-secret';
  t.after(() => { if (previous === undefined) delete process.env.ABU_CU_EVAL_API_KEY; else process.env.ABU_CU_EVAL_API_KEY = previous; });
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  assert.equal(fixture.pid, 42);
  assert.equal(fixture.state.markerPresent, false);
  assert.equal(context.removals.mock.callCount(), 0);
  for (const call of context.spawns.mock.calls) {
    assert.equal(Object.keys(call.arguments[2].env).some((key) => key.toUpperCase() === 'ABU_CU_EVAL_API_KEY'), false);
    assert.equal(call.arguments[2].windowsHide, true);
    assert.equal(call.arguments[2].shell, false);
  }
  assert.deepEqual(context.spawns.mock.calls[1].arguments[1], ['edit', 'ABU_CU_SAFE']);
  assert.equal(context.spawns.mock.calls[0].arguments[1].join(' ').includes('ABU_CU_SAFE'), false);
  const closed = fixture.close();
  assert.equal(fixture.state, null);
  assert.equal(fixture.close(), closed);
  await closed;
  assert.equal(context.removals.mock.callCount(), 1);
  assert.equal(context.removals.mock.calls[0].arguments[0], context.directory);
  assert.equal(context.children[1].kill.mock.callCount(), 0);
});

test('live state handles split JSONL and waits for settled marker instead of intermediate typing', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  try {
    let resolved = false;
    const pending = fixture.waitFor((value) => value.markerPresent).then((value) => { resolved = true; return value; });
    context.children[1].stdout.write(JSON.stringify({ ...initial, sequence: 2, mainMarkerPresent: true }) + '\r\n');
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(fixture.state.sequence, 2);
    const final = JSON.stringify({ ...initial, sequence: 3, mainMarkerPresent: true, markerPresent: true }) + '\n';
    context.children[1].stdout.write(final.slice(0, 20));
    assert.equal(fixture.state.sequence, 2);
    context.children[1].stdout.write(final.slice(20));
    assert.equal((await pending).sequence, 3);
    assert.equal(fixture.state.unexpectedWrites, 0);
  } finally { await fixture.close(); }
});

test('invalid stream data fails all waiters and triggers owned cleanup without reflecting raw content', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false), /invalid JSON/);
  context.children[1].stdout.write('PRIVATE ARBITRARY CONTENT\n');
  await pending;
  await assert.rejects(fixture.waitFor(() => true), /invalid JSON/);
  await fixture.close();
  assert.equal(context.removals.mock.callCount(), 1);
});

test('replayed state cannot masquerade as a new observation', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false), /invalid state/);
  context.children[1].stdout.write(JSON.stringify(initial) + '\n');
  await pending;
  await fixture.close();
});

test('overlong unterminated JSONL fails before unbounded buffering', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false), /line exceeded/);
  context.children[1].stdout.write('A'.repeat(16385));
  await pending;
  await fixture.close();
});

test('total stderr output is bounded and errors are not reflected into oracle state', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false), /output exceeded limit/);
  context.children[1].stderr.write(Buffer.alloc(4 * 1024 * 1024, 65));
  await pending;
  assert.equal(fixture.state, null);
  await fixture.close();
});

test('Windows-only rejection happens before allocating files or spawning children', async (t) => {
  const context = fakeDesktop(t);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await assert.rejects(startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' }), /requires Windows/);
  assert.equal(context.spawns.mock.callCount(), 0);
  assert.equal(fs.mkdtemp.mock.callCount(), 0);
});

test('process failure rejects pending waiters and close waits for the exact child exit', async (t) => {
  const context = fakeDesktop(t, { automaticExit: false });
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false), /process failed/);
  context.children[1].emit('error', new Error('do not expose arbitrary errors'));
  assert.equal(fixture.state, null);
  await pending;
  assert.equal(context.removals.mock.callCount(), 0);
  context.children[1].emit('close', 1);
  await fixture.close();
  assert.equal(context.removals.mock.callCount(), 1);
});

test('closing and unexpected exit invalidate cached state immediately', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  context.children[1].emit('close', 0);
  assert.equal(fixture.state, null);
  await fixture.close();
  assert.equal(fixture.state, null);
});

test('cleanup refuses a directory replaced by a symbolic link', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  t.mock.method(fs, 'lstat', async () => ({ isDirectory: () => true, isSymbolicLink: () => true }));
  await assert.rejects(fixture.close(), /identity changed/);
  assert.equal(context.removals.mock.callCount(), 0);
});

test('compile failure removes its owned directory but never launches the fixture', async (t) => {
  const context = fakeDesktop(t, { compileCode: 1 });
  await assert.rejects(startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' }), /compilation failed/);
  assert.equal(context.spawns.mock.callCount(), 1);
  assert.equal(context.removals.mock.callCount(), 1);
});

function controlledTimeouts(t) {
  const timers = new Map();
  t.mock.method(global, 'setTimeout', (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; });
  t.mock.method(global, 'clearTimeout', (token) => timers.delete(token));
  return {
    async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    fire(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `expected a ${delay} ms timeout`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

test('compiler that fails to exit retains its temp directory instead of deleting a live child executable', async (t) => {
  const context = fakeDesktop(t, { hungCompiler: true });
  const clock = controlledTimeouts(t);
  const pending = assert.rejects(startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' }), /did not exit/);
  await clock.flush();
  clock.fire(30000);
  await clock.flush();
  clock.fire(3000);
  await clock.flush();
  clock.fire(3000);
  await pending;
  assert.equal(context.removals.mock.callCount(), 0);
  assert.equal(context.spawns.mock.callCount(), 1);
});

test('wait timeout rejects only that waiter while later observations remain usable', async (t) => {
  const context = fakeDesktop(t);
  const clock = controlledTimeouts(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  const pending = assert.rejects(fixture.waitFor(() => false, 25), /timed out/);
  clock.fire(25);
  await pending;
  context.children[1].stdout.write(JSON.stringify({ ...initial, sequence: 2 }) + '\n');
  assert.equal((await fixture.waitFor(() => true)).sequence, 2);
  await fixture.close();
});

test('throwing predicates reject independently without poisoning another waiter', async (t) => {
  const context = fakeDesktop(t);
  const fixture = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_SAFE' });
  try {
    await assert.rejects(fixture.waitFor(() => { throw new Error('bad predicate'); }), /bad predicate/);
    await assert.rejects(fixture.waitFor(null), /predicate/);
    await assert.rejects(fixture.waitFor(() => true, -1), /timeout/);
    const pending = fixture.waitFor((value) => value.sequence === 2);
    context.children[1].stdout.write(JSON.stringify({ ...initial, sequence: 2 }) + '\n');
    assert.equal((await pending).sequence, 2);
  } finally { await fixture.close(); }
});

const native = process.platform === 'win32' && process.env.ABU_CU_FIXTURE_NATIVE === '1';

// This independent native consumer must accept the fixture's actual HWND and
// random executable identity; managed Form.Visible alone is not readiness.
function startNativeObserver() {
  const helperPath = path.join(__dirname, '..', 'electron', 'native-helper', 'target', 'release', 'native-helper.exe');
  const helper = childProcess.spawn(helperPath, [], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ABU_CU_EVAL_API_KEY')),
  });
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  let exited = false;
  const completion = new Promise((resolve) => helper.once('close', () => { exited = true; resolve(); }));
  const lines = readline.createInterface({ input: helper.stdout });
  const fail = (message) => {
    failure = new Error(message);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
    pending.clear();
  };
  helper.on('error', () => fail('Native observer failed to start'));
  helper.stdin.on('error', () => fail('Native observer input failed'));
  helper.stderr.on('data', () => {});
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch { fail('Native observer returned malformed JSON'); return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error != null) request.reject(new Error(String(response.error)));
    else request.resolve(response.result);
  });
  return {
    call(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native observation timed out')); }, 10000);
        pending.set(id, { resolve, reject, timer });
        helper.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    async close() {
      fail('Native observer closed');
      lines.close();
      helper.stdin.end();
      if (!exited) helper.kill();
      await completion;
    },
  };
}

test('native graph remains stable when the exact owned target is activated before observation', { skip: !native, timeout: 45000 }, async () => {
  const target = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_GRAPH_TARGET' });
  let foreground;
  const observer = startNativeObserver();
  try {
    foreground = await startDesktopFixture({ scenario: 'edit', marker: 'ABU_CU_GRAPH_FOREGROUND' });
    const window = await observer.call('get_window', { window_id: target.state.windows[0].windowId });
    const params = { app_name: target.appName, expected_bundle_id: window.app_id,
      expected_process_id: target.pid, expected_window_id: window.window_id };
    const lease = { lease_id: `fixture-graph-${process.pid}` };
    await observer.call('input_lease_begin', lease);
    await observer.call('activate_window', { window_id: window.window_id });
    const before = await observer.call('ax_snapshot', params);
    await observer.call('input_lease_commit_observation', { ...lease, expected_input_epoch: before.input_epoch });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await observer.call('input_lease_activate', { ...lease, expected_input_epoch: before.input_epoch });
    await observer.call('activate_window', { window_id: window.window_id });
    await observer.call('ax_restore_focus', { session_id: before.session_id });
    await observer.call('input_lease_observe', lease);
    const after = await observer.call('ax_snapshot', params);
    const fields = ['window_id', 'owner_window_id', 'app_id', 'process_id', 'bounds', 'minimized', 'relation'];
    const differences = fields.filter((field) => {
      const values = (snapshot) => snapshot.window_graph.nodes.map((node) => JSON.stringify([node.window_id, node[field]])).sort();
      return JSON.stringify(values(before)) !== JSON.stringify(values(after));
    });
    // Assert only fixed field names: never put graph titles/identities in output.
    const summarizeUnmatched = (left, right) => left.window_graph.nodes
      .filter((node) => !right.window_graph.nodes.some((other) => other.window_id === node.window_id))
      .map((node) => ({ relation: ['exact', 'owned-popup', 'owner', 'same-process', 'same-app'].includes(node.relation) ? node.relation : 'unknown',
        sameProcess: node.process_id === target.pid, ownedByTarget: node.owner_window_id === window.window_id,
        hasTitle: Boolean(node.title), bounds: node.bounds }));
    assert.deepEqual(differences, [], JSON.stringify({ beforeCount: before.window_graph.nodes.length,
      afterCount: after.window_graph.nodes.length, added: summarizeUnmatched(after, before), removed: summarizeUnmatched(before, after) }));
  } finally {
    try { await observer.close(); } finally {
      try { if (foreground) await foreground.close(); } finally { await target.close(); }
    }
  }
});

for (const [scenario, depth, roles] of [
  ['edit', 0, ['main']], ['modal-cancel', 1, ['main', 'dialog']],
  ['nested-modal', 2, ['main', 'dialog', 'nested']], ['window-switch', 0, ['main']],
]) {
  test(`native fixture initial state and owned cleanup: ${scenario}`, { skip: !native, timeout: 45000 }, async () => {
    const fixture = await startDesktopFixture({ scenario, marker: 'ABU_CU_NATIVE_TEST' });
    const tempDirectory = path.dirname(fixture.executablePath);
    const observer = startNativeObserver();
    try {
      const state = await fixture.waitFor((value) => value.dialogDepth === depth && value.windows.length === roles.length);
      assert.equal(state.pid, fixture.pid);
      assert.equal(state.scenario, scenario);
      assert.deepEqual(state.windows.map((window) => window.role), roles);
      assert.equal(state.markerPresent, false);
      assert.equal(state.mainMarkerPresent, false);
      assert.equal(state.secondaryMarkerPresent, false);
      assert.equal(state.cancelCount, 0);
      assert.equal(state.unexpectedWrites, 0);
      for (const owned of state.windows) {
        const window = await observer.call('get_window', { window_id: owned.windowId });
        assert.equal(window.process_id, fixture.pid);
        assert.equal(window.window_id, owned.windowId);
        assert.equal(window.app_name, fixture.appName);
        assert.equal(window.minimized, false);
      }
      const identity = await observer.call('resolve_app_identity', { app_name: fixture.appName });
      assert.equal(identity.process_id, fixture.pid);
      assert.equal(identity.app_name, fixture.appName);
      assert.equal(path.resolve(identity.executable_path).toLowerCase(), path.resolve(fixture.executablePath).toLowerCase());
      assert.equal(state.windows.some((window) => window.windowId === identity.window_id), true);
      assert.match(fixture.appName, /^AbuCuFixture-[a-f0-9]{24}$/);
      assert.equal(path.basename(fixture.executablePath), fixture.appName + '.exe');
      assert.equal((await fs.stat(fixture.executablePath)).isFile(), true);
      process.kill(fixture.pid, 0);
    } finally {
      try { await observer.close(); } finally { await fixture.close(); }
    }
    await fixture.close();
    assert.throws(() => process.kill(fixture.pid, 0), { code: 'ESRCH' });
    await assert.rejects(fs.stat(tempDirectory), { code: 'ENOENT' });
  });
}
