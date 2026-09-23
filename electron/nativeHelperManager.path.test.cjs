'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { COMPUTER_USE_REQUEST_CONTEXT_ARG } = require('./computerUseCommands.cjs');
const {
  nativeHelperExecutableName,
  resolveHelperPath,
  HELPER_CMDS,
  buildNativeHelperRequest,
  validateHelperHello,
  resolveHelperCallTimeoutMs,
  normalizeHelperEvent,
  createSerialExecutor,
  createNativeHelperSupervisorState,
  NATIVE_HELPER_PROTOCOL_VERSION,
} = require('./nativeHelperManager.cjs');

test('native helper exposes a read-only health probe for diagnostics', () => {
  assert.equal(HELPER_CMDS.has('native_helper_health'), true);
  assert.deepEqual(
    buildNativeHelperRequest('native_helper_health', {
      method: 'mouse_click',
      x: 100,
      y: 200,
    }),
    { method: 'health', params: {} },
  );
});

test('native helper owns the frontmost-app identity probe used by Computer Use', () => {
  assert.equal(HELPER_CMDS.has('frontmost_app_identity'), true);
  assert.deepEqual(
    buildNativeHelperRequest('frontmost_app_identity', {}),
    { method: 'frontmost_app_identity', params: {} },
  );
});

test('macOS AX snapshots prefer the focused window before the whole app tree', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src-tauri', 'src', 'accessibility_macos.rs'),
    'utf8',
  );
  const focused = source.indexOf('copy_attr(app, "AXFocusedWindow")');
  const main = source.indexOf('copy_attr(app, "AXMainWindow")');
  const fallback = source.indexOf('CFRetain(app)', main);
  const walk = source.indexOf('walk_and_cache(snapshot_root, 0, &mut st)');

  assert.ok(focused >= 0, 'focused-window root is missing');
  assert.ok(main > focused, 'main-window fallback must follow focused window');
  assert.ok(fallback > main, 'whole-app fallback must be last');
  assert.ok(walk > fallback, 'cached snapshot must walk the selected root');
});

test('native helper hello contract exposes version, platform, commands, and startup time', () => {
  const hello = {
    protocol_version: NATIVE_HELPER_PROTOCOL_VERSION,
    binary_version: '0.0.1',
    platform: 'macos',
    supported_commands: ['hello', 'health', 'ax_snapshot'],
    started_at_ms: 1_700_000_000_000,
    capabilities: {
      events: [],
      transport: 'ndjson-stdio',
      request_serialization: 'host',
      legacy_v1_request_adapter: true,
    },
  };
  assert.equal(validateHelperHello(hello), hello);
});

test('native helper exposes guarded accessibility text replacement', () => {
  assert.equal(HELPER_CMDS.has('ax_replace_text'), true);
  assert.deepEqual(
    buildNativeHelperRequest('ax_replace_text', {
      sessionId: 'uia-1',
      elementId: 7,
      text: 'visible edit',
      expectedBundleId: 'editor.exe',
      expectedProcessId: 42,
      expectedWindowId: 'hwnd:0x1234',
      expectedInputEpoch: 9,
    }),
    {
      method: 'ax_replace_text',
      params: {
        session_id: 'uia-1',
        element_id: 7,
        text: 'visible edit',
        expected_bundle_id: 'editor.exe',
        expected_process_id: 42,
        expected_window_id: 'hwnd:0x1234',
        expected_input_epoch: 9,
      },
    },
  );
});

test('native helper input-lease commands preserve only the explicit lease boundary', () => {
  assert.deepEqual(
    buildNativeHelperRequest('input_lease_pause', {
      leaseId: 'lease-123',
      consentOwnerProcessId: 456,
      userText: 'must not cross the helper boundary',
    }),
    {
      method: 'input_lease_pause',
      params: {
        lease_id: 'lease-123',
        consent_owner_process_id: 456,
      },
    },
  );
});

test('native helper v2 request carries only stable task and target context', () => {
  assert.deepEqual(
    buildNativeHelperRequest('ax_snapshot', {
      appName: 'Notepad',
      [COMPUTER_USE_REQUEST_CONTEXT_ARG]: {
        conversationId: 'conversation-1',
        loopId: 'loop-1',
        target: {
          appId: 'path:C:\\Windows\\System32\\notepad.exe',
          processId: 42,
          windowId: '0x1234',
          windowTitle: 'must not cross the boundary',
        },
        userText: 'must not cross the boundary',
      },
    }),
    {
      method: 'ax_snapshot',
      params: { app_name: 'Notepad' },
      context: {
        conversation_id: 'conversation-1',
        loop_id: 'loop-1',
        target: {
          app_id: 'path:C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
          window_id: '0x1234',
        },
      },
    },
  );
});

test('native helper v2 uses bounded command-specific timeouts', () => {
  assert.equal(resolveHelperCallTimeoutMs('health'), 5_000);
  assert.equal(resolveHelperCallTimeoutMs('ax_snapshot'), 15_000);
  assert.equal(resolveHelperCallTimeoutMs('get_window_state'), 15_000);
  assert.equal(resolveHelperCallTimeoutMs('mouse_click'), 10_000);
});

test('native helper v2 accepts only allowlisted content-free event frames', () => {
  assert.deepEqual(normalizeHelperEvent({
    event: 'user-interrupted',
    context: { conversation_id: 'conversation-1', loop_id: 'loop-1' },
    reason: 'physical-escape',
    prompt: 'must not cross the boundary',
  }), {
    type: 'user-interrupted',
    conversationId: 'conversation-1',
    loopId: 'loop-1',
    reason: 'physical-escape',
  });
  assert.equal(normalizeHelperEvent({ event: 'arbitrary-event' }), null);
});

test('native helper serial executor orders calls and invalidates queued work', async () => {
  const executor = createSerialExecutor();
  const order = [];
  let releaseFirst;
  const first = executor.run(async () => {
    order.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push('first:end');
  });
  const second = executor.run(async () => {
    order.push('second');
  });

  await new Promise((resolve) => setImmediate(resolve));
  executor.invalidate();
  releaseFirst();
  await first;
  await assert.rejects(second, /invalidated before execution/);
  assert.deepEqual(order, ['first:start', 'first:end']);
});

test('native helper supervisor pauses indefinitely for approval and resumes the same generation', () => {
  let clock = 1_000;
  const supervisor = createNativeHelperSupervisorState({ now: () => clock });
  supervisor.spawnStarted(7);
  supervisor.requestStarted('hello', 1);
  supervisor.requestCompleted('hello', 0);
  supervisor.ready(7);
  supervisor.requestStarted('input_lease_pause', 1);
  supervisor.requestCompleted('input_lease_pause', 0);

  clock += 60 * 60 * 1_000;
  assert.deepEqual(supervisor.snapshot(), {
    state: 'awaiting-approval',
    generation: 7,
    activeMethod: null,
    pendingCount: 0,
    approvalPaused: true,
    lastTransitionAt: 1_000,
    lastReason: 'approval-paused',
  });
  assert.equal(supervisor.canDispatch('mouse_click'), false);
  assert.equal(supervisor.canDispatch('input_lease_resume'), true);
  assert.throws(
    () => supervisor.requestStarted('mouse_click', 1),
    /awaiting user approval/,
  );

  supervisor.requestStarted('input_lease_resume', 1);
  supervisor.requestCompleted('input_lease_resume', 0);
  assert.deepEqual(supervisor.snapshot(), {
    state: 'ready',
    generation: 7,
    activeMethod: null,
    pendingCount: 0,
    approvalPaused: false,
    lastTransitionAt: clock,
    lastReason: 'approval-resumed',
  });
});

test('native helper supervisor requires a reset after a failed approval resume', () => {
  const supervisor = createNativeHelperSupervisorState();
  supervisor.spawnStarted(3);
  supervisor.ready(3);
  supervisor.requestStarted('input_lease_pause', 1);
  supervisor.requestCompleted('input_lease_pause', 0);
  supervisor.requestStarted('input_lease_resume', 1);
  supervisor.requestFailed('input_lease_resume', 0, 'resume-failed');

  assert.equal(supervisor.snapshot().state, 'awaiting-approval');
  assert.equal(supervisor.canDispatch('keyboard_type'), false);
  supervisor.resetting('resume-failed');
  supervisor.stopped(4, 'resume-failed');
  assert.match(supervisor.snapshot().state, /stopped/);
  assert.equal(supervisor.snapshot().generation, 4);
});

test('native helper version mismatch fails with an explicit compatibility error', () => {
  assert.throws(
    () => validateHelperHello({
      protocol_version: NATIVE_HELPER_PROTOCOL_VERSION + 1,
      binary_version: '9.9.9',
      platform: 'macos',
      supported_commands: [],
      started_at_ms: 1,
    }),
    /protocol is incompatible/,
  );
});

test('native helper v2 rejects an incomplete capability contract', () => {
  assert.throws(
    () => validateHelperHello({
      protocol_version: NATIVE_HELPER_PROTOCOL_VERSION,
      binary_version: '0.0.1',
      platform: 'win32',
      supported_commands: ['hello'],
      started_at_ms: 1,
      capabilities: {
        transport: 'ndjson-stdio',
        request_serialization: 'host',
        legacy_v1_request_adapter: false,
        events: [],
      },
    }),
    /incomplete hello response/,
  );
});

test('native helper request builder fails closed for an unknown command', () => {
  assert.equal(
    buildNativeHelperRequest('arbitrary_helper_method', { method: 'keyboard_type' }),
    null,
  );
});

test('native helper uses the Cargo .exe name in Windows packages', () => {
  assert.equal(nativeHelperExecutableName('win32'), 'native-helper.exe');
  assert.equal(
    resolveHelperPath({
      platform: 'win32',
      packaged: true,
      resourcesPath: 'C:\\Abu\\resources',
    }),
    path.join('C:\\Abu\\resources', 'native-helper', 'native-helper.exe'),
  );
});

test('native helper keeps the extensionless Unix binary name', () => {
  assert.equal(nativeHelperExecutableName('darwin'), 'native-helper');
  assert.equal(
    resolveHelperPath({
      platform: 'darwin',
      packaged: true,
      resourcesPath: '/Applications/Abu.app/Contents/Resources',
    }),
    '/Applications/Abu.app/Contents/Resources/native-helper/native-helper',
  );
});
