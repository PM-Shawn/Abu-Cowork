'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createComputerUseGate,
  COMPUTER_USE_GATE_MISS,
  TASK_GRANT_TTL_MS,
} = require('./computerUseGate.cjs');
const { COMPUTER_USE_TOKEN_ARG } = require('./computerUseCommands.cjs');

function harness(overrides = {}) {
  let currentIdentity = {
    app_name: 'Notes',
    bundle_id: 'com.apple.Notes',
    process_id: 100,
  };
  const nativeCalls = [];
  const approvalRequests = [];
  const taskApprovalRequests = [];
  const actionApprovalRequests = [];
  let axElements = [];
  let helperKillCount = 0;
  let now = 10_000;
  const gate = createComputerUseGate({
    platform: 'darwin',
    now: () => now,
    tokenFactory: () => '0123456789abcdef0123456789abcdef',
    getActiveWindow: async () => currentIdentity,
    nativeDispatch: async (cmd, args) => {
      nativeCalls.push({ cmd, args });
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        if (args.appName === 'Keychain Access') {
          return {
            app_name: 'Keychain Access',
            bundle_id: 'com.apple.keychainaccess',
            process_id: 200,
          };
        }
        if (args.appName === 'Slack') {
          return {
            app_name: 'Slack',
            bundle_id: 'com.tinyspeck.slackmacgap',
            process_id: 300,
          };
        }
        return currentIdentity;
      }
      if (cmd === 'ax_snapshot') {
        return {
          session_id: 'ax-session-1',
          app: currentIdentity.app_name,
          elements: axElements,
        };
      }
      return { ok: true };
    },
    requestAppApproval: async (request) => {
      approvalRequests.push(request);
      return true;
    },
    requestTaskApproval: async (request) => {
      taskApprovalRequests.push(request);
      return true;
    },
    requestActionApproval: async (request) => {
      actionApprovalRequests.push(request);
      return true;
    },
    killNativeHelper: () => {
      helperKillCount += 1;
    },
    ...overrides,
  });
  return {
    gate,
    sender: {},
    record: { label: 'main' },
    nativeCalls,
    approvalRequests,
    taskApprovalRequests,
    actionApprovalRequests,
    get helperKillCount() {
      return helperKillCount;
    },
    setIdentity(value) {
      currentIdentity = value;
    },
    setAxElements(value) {
      axElements = value;
    },
    advance(ms) {
      now += ms;
    },
  };
}

async function begin(h, extra = {}) {
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  return h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
    conversationId: 'conversation-1',
    toolCallId: 'tool-1',
    loopId: 'loop-1',
    interactionMode: 'foreground',
    scope: 'ui-control',
    permissionMode: 'standard',
    actionIntent: {
      action: 'click',
      category: 'none',
      summary: '',
    },
    ...extra,
  });
}

test('non-Computer-Use commands fall through', async () => {
  const h = harness();
  assert.equal(
    await h.gate.dispatch(h.record, h.sender, 'plugin:path|home_dir', {}),
    COMPUTER_USE_GATE_MISS
  );
});

test('privileged commands require a live sender-bound session token', async () => {
  const h = harness();
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', { x: 1, y: 1 }),
    /authorization token is required/
  );

  const session = await begin(h);
  const result = await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.nativeCalls.at(-1), {
    cmd: 'mouse_click',
    args: {
      x: 1,
      y: 1,
      expectedBundleId: 'com.apple.Notes',
      expectedProcessId: 100,
    },
  });

  await assert.rejects(
    h.gate.dispatch(h.record, {}, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /invalid or expired/
  );
});

test('UI-control sessions require a structured action intent', async () => {
  const h = harness();
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      loopId: 'loop-1',
      interactionMode: 'foreground',
      scope: 'ui-control',
      permissionMode: 'standard',
    }),
    /action intent is required/,
  );
});

test('consequential actions ask in every permission mode and only authorize one native attempt', async () => {
  for (const permissionMode of ['standard', 'smart', 'autonomous']) {
    const h = harness();
    const session = await begin(h, {
      permissionMode,
      actionIntent: {
        action: 'click',
        category: 'send',
        summary: 'Send the prepared test message',
      },
    });
    await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    });
    assert.equal(h.actionApprovalRequests.length, 1, permissionMode);
    assert.deepEqual(h.actionApprovalRequests[0].consequence, {
      category: 'send',
      summary: 'Send the prepared test message',
      source: 'declared-intent',
    });
    await assert.rejects(
      h.gate.dispatch(h.record, h.sender, 'mouse_click', {
        x: 40,
        y: 50,
        [COMPUTER_USE_TOKEN_ARG]: session.token,
      }),
      /authorization was already used/,
    );
    assert.equal(
      h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length,
      1,
      permissionMode,
    );
  }
});

test('rejecting a consequential action never dispatches native input', async () => {
  const h = harness({ requestActionApproval: async () => false });
  const session = await begin(h, {
    actionIntent: {
      action: 'click',
      category: 'delete',
      summary: 'Delete the disposable test note',
    },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /was not approved/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('a risky native accessibility label cannot bypass approval by declaring none', async () => {
  const h = harness();
  h.setAxElements([
    {
      id: 9,
      role: 'AXButton',
      label: 'Delete message',
      value: null,
      actions: ['AXPress'],
      bounds: [0, 0, 20, 20],
      depth: 1,
    },
  ]);
  const readSession = await begin(h, {
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
    appName: 'Notes',
    [COMPUTER_USE_TOKEN_ARG]: readSession.token,
  });
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_session', {
    [COMPUTER_USE_TOKEN_ARG]: readSession.token,
  });

  const clickSession = await begin(h, {
    toolCallId: 'tool-2',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_press', {
    sessionId: 'ax-session-1',
    elementId: 9,
    [COMPUTER_USE_TOKEN_ARG]: clickSession.token,
  });
  assert.equal(h.actionApprovalRequests.length, 1);
  assert.equal(h.actionApprovalRequests[0].consequence.category, 'delete');
  assert.match(h.actionApprovalRequests[0].consequence.summary, /Delete message/);
});

test('Stop invalidates an action approval that returns late', async () => {
  let resolveApproval;
  const h = harness({
    requestActionApproval: async () => new Promise((resolve) => {
      resolveApproval = resolve;
    }),
  });
  const session = await begin(h, {
    actionIntent: {
      action: 'click',
      category: 'publish',
      summary: 'Publish the disposable test post',
    },
  });
  const staleAction = h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 20,
    y: 30,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  resolveApproval(true);
  await assert.rejects(staleAction, /authorization is no longer active/);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('target changes while action approval is open fail closed', async () => {
  const h = harness({
    requestActionApproval: async () => {
      h.setIdentity({
        app_name: 'Finder',
        bundle_id: 'com.apple.finder',
        process_id: 400,
      });
      return true;
    },
  });
  const session = await begin(h, {
    actionIntent: {
      action: 'click',
      category: 'delete',
      summary: 'Delete the disposable test note',
    },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /target changed/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('renderer reload invalidates an action approval that returns late', async () => {
  let resolveApproval;
  const h = harness({
    requestActionApproval: async () => new Promise((resolve) => {
      resolveApproval = resolve;
    }),
  });
  const session = await begin(h, {
    actionIntent: {
      action: 'key',
      category: 'send',
      summary: 'Send the disposable test message',
    },
  });
  const staleAction = h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
    key: 'Return',
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.gate.revokeSender(h.sender);
  resolveApproval(true);
  await assert.rejects(staleAction, /authorization is no longer active/);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'keyboard_press'), false);
});

test('disabled, background, expired, and target-changed sessions fail closed', async () => {
  const h = harness();
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
      scope: 'ui-control',
    }),
    /disabled/
  );

  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      loopId: 'loop-1',
      interactionMode: 'background',
      scope: 'ui-control',
    }),
    /Background tasks/
  );

  const session = await begin(h);
  h.setIdentity({
    app_name: 'Finder',
    bundle_id: 'com.apple.finder',
    process_id: 400,
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_type', {
      text: 'x',
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /target changed/
  );

  h.advance(2 * 60 * 1000 + 1);
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /invalid or expired/
  );
});

test('hard-denied and missing target identities cannot open sessions', async () => {
  const h = harness();
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });

  await assert.rejects(
    begin(h, { targetApp: 'Keychain Access' }),
    /blocked for sensitive app/
  );

  h.setIdentity({ app_name: '', bundle_id: '', process_id: null });
  await assert.rejects(begin(h), /identity is unavailable/);
});

test('permission modes and app risk decide task-local approval frequency', async () => {
  const standard = harness();
  await begin(standard);
  await begin(standard, { toolCallId: 'tool-2' });
  assert.equal(standard.approvalRequests.length, 1);
  assert.equal(standard.approvalRequests[0].classification, 'ordinary');

  const smart = harness();
  await begin(smart, { permissionMode: 'smart' });
  assert.equal(smart.approvalRequests.length, 0);
  assert.equal(smart.taskApprovalRequests.length, 1);

  const sensitive = harness();
  await begin(sensitive, { targetApp: 'Slack', permissionMode: 'autonomous' });
  assert.equal(sensitive.approvalRequests.length, 1);
  assert.equal(sensitive.taskApprovalRequests.length, 1);
  assert.equal(sensitive.approvalRequests[0].classification, 'approval-required');

  const unknown = harness();
  unknown.setIdentity({
    app_name: 'Unreviewed App',
    bundle_id: 'example.unreviewed.app',
    process_id: 500,
  });
  await begin(unknown, { permissionMode: 'autonomous' });
  assert.equal(unknown.approvalRequests.length, 1);
  assert.equal(unknown.approvalRequests[0].classification, 'approval-required');

  const denied = harness({ requestAppApproval: async () => false });
  await assert.rejects(
    begin(denied, { targetApp: 'Slack', permissionMode: 'smart' }),
    /approval was not granted/
  );
});

test('task grants are loop-bound and UI-control scope cannot be inferred from screen-read', async () => {
  const h = harness();
  await begin(h, { scope: 'screen-read' });
  await begin(h, { toolCallId: 'tool-2', scope: 'ui-control' });
  assert.equal(h.approvalRequests.length, 2);

  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  await begin(h, {
    loopId: 'loop-2',
    toolCallId: 'tool-3',
    scope: 'screen-read',
  });
  assert.equal(h.approvalRequests.length, 3);

  const controlFirst = harness();
  await begin(controlFirst, { scope: 'ui-control' });
  await begin(controlFirst, { toolCallId: 'tool-2', scope: 'screen-read' });
  // Controlling one app does not silently grant whole-screen reading.
  assert.equal(controlFirst.approvalRequests.length, 2);
});

test('screen-read sessions authorize the whole screen without binding to Abu or another foreground app', async () => {
  const h = harness();
  const session = await begin(h, { scope: 'screen-read' });
  assert.deepEqual(session.target, {
    app_name: 'Screen',
    bundle_id: 'abu.screen',
    process_id: null,
  });
  assert.equal(h.approvalRequests.length, 1);
  assert.equal(h.approvalRequests[0].target.bundle_id, 'abu.screen');

  h.setIdentity({
    app_name: 'Finder',
    bundle_id: 'com.apple.finder',
    process_id: 400,
  });
  await h.gate.dispatch(h.record, h.sender, 'capture_screen', {
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.deepEqual(h.nativeCalls.at(-1), {
    cmd: 'capture_screen',
    args: {},
  });
});

test('task stop revokes sessions and per-app grants immediately', async () => {
  const h = harness();
  const session = await begin(h);
  assert.equal(h.approvalRequests.length, 1);

  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  assert.equal(h.helperKillCount, 1);

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /invalid or expired/
  );

  await begin(h, { toolCallId: 'tool-2' });
  assert.equal(h.approvalRequests.length, 2);
});

test('only one foreground task can own Computer Use at a time', async () => {
  const h = harness();
  await begin(h);

  await assert.rejects(
    begin(h, {
      conversationId: 'conversation-2',
      loopId: 'loop-2',
      toolCallId: 'tool-2',
    }),
    /already active in another foreground task/
  );

  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  await begin(h, {
    conversationId: 'conversation-2',
    loopId: 'loop-2',
    toolCallId: 'tool-3',
  });
});

test('Stop invalidates a session begin that is still checking OS permissions', async () => {
  let resolveFirstCheck;
  let checkCount = 0;
  const h = harness({
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') {
        checkCount += 1;
        if (checkCount === 1) {
          return new Promise((resolve) => {
            resolveFirstCheck = resolve;
          });
        }
        return { screen_recording: true, accessibility: true };
      }
      return { ok: true };
    },
  });

  const staleBegin = begin(h);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCount, 1);

  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  const freshSession = await begin(h, { toolCallId: 'tool-2' });

  resolveFirstCheck({ screen_recording: true, accessibility: true });
  await assert.rejects(staleBegin, /task authorization is no longer active/);

  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: freshSession.token,
  });
});

test('a late task approval cannot revive a stopped task with reused IDs', async () => {
  let resolveFirstApproval;
  let approvalCount = 0;
  const h = harness({
    requestTaskApproval: async () => {
      approvalCount += 1;
      if (approvalCount === 1) {
        return new Promise((resolve) => {
          resolveFirstApproval = resolve;
        });
      }
      return true;
    },
  });

  const staleBegin = begin(h, { permissionMode: 'autonomous' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvalCount, 1);

  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });

  const freshSession = await begin(h, {
    toolCallId: 'tool-2',
    permissionMode: 'autonomous',
  });
  assert.equal(approvalCount, 2);

  resolveFirstApproval(true);
  await assert.rejects(staleBegin, /task authorization is no longer active/);

  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: freshSession.token,
  });
  await begin(h, {
    toolCallId: 'tool-3',
    permissionMode: 'autonomous',
  });
  assert.equal(approvalCount, 2);
});

test('a late app approval cannot revive authorization after renderer reload', async () => {
  let resolveFirstApproval;
  let approvalCount = 0;
  const h = harness({
    requestAppApproval: async () => {
      approvalCount += 1;
      if (approvalCount === 1) {
        return new Promise((resolve) => {
          resolveFirstApproval = resolve;
        });
      }
      return true;
    },
  });

  const staleBegin = begin(h);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvalCount, 1);

  h.gate.revokeSender(h.sender);
  const freshSession = await begin(h, { toolCallId: 'tool-2' });
  assert.equal(approvalCount, 2);

  resolveFirstApproval(true);
  await assert.rejects(staleBegin, /task authorization is no longer active/);

  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: freshSession.token,
  });
});

test('renderer reload revokes task state and stops pending native input', async () => {
  const h = harness();
  const session = await begin(h);

  h.gate.revokeSender(h.sender);
  assert.equal(h.helperKillCount, 1);

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /invalid or expired/
  );
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-2',
      loopId: 'loop-1',
      interactionMode: 'foreground',
      scope: 'ui-control',
      permissionMode: 'standard',
    }),
    /Computer Use is disabled/
  );
});

test('a self-reported relaxed mode still requires a main-owned task approval', async () => {
  const h = harness({ requestTaskApproval: async () => false });
  await assert.rejects(
    begin(h, { permissionMode: 'autonomous' }),
    /not approved for this task/
  );
});

test('main process independently verifies operating-system permissions', async () => {
  const h = harness({
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: false, accessibility: false };
      }
      return { ok: true };
    },
  });
  await assert.rejects(
    begin(h, { scope: 'screen-read' }),
    /Screen Recording permission/
  );
  await assert.rejects(
    begin(h, { scope: 'ui-control' }),
    /Accessibility permission/
  );
});

test('global input carries the expected app identity into the native helper', async () => {
  let actualBundleAtDispatch = 'com.apple.Notes';
  const h = harness({
    nativeDispatch: async (cmd, args) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'mouse_click') {
        assert.equal(args.expectedBundleId, 'com.apple.Notes');
        if (actualBundleAtDispatch !== args.expectedBundleId) {
          throw new Error('Computer Use native target changed');
        }
      }
      return { ok: true };
    },
  });
  const session = await begin(h);
  actualBundleAtDispatch = 'com.apple.Terminal';
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /native target changed/
  );
});

test('AX sessions stay bound to the authorized app and are cleaned explicitly', async () => {
  const h = harness();
  const session = await begin(h);
  const snapshot = await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
    appName: 'Notes',
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.equal(snapshot.session_id, 'ax-session-1');

  await h.gate.dispatch(h.record, h.sender, 'ax_press', {
    sessionId: 'ax-session-1',
    elementId: 1,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });

  await h.gate.dispatch(h.record, h.sender, 'ax_close_session', {
    sessionId: 'ax-session-1',
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'ax_press', {
      sessionId: 'ax-session-1',
      elementId: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /Accessibility session is invalid/
  );
});

test('AX sessions from an expired task cannot be reused by a later task', async () => {
  const h = harness();
  const firstSession = await begin(h);
  await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
    appName: 'Notes',
    [COMPUTER_USE_TOKEN_ARG]: firstSession.token,
  });

  h.advance(TASK_GRANT_TTL_MS + 1);
  const laterSession = await begin(h, {
    loopId: 'loop-2',
    toolCallId: 'tool-2',
  });

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'ax_press', {
      sessionId: 'ax-session-1',
      elementId: 1,
      [COMPUTER_USE_TOKEN_ARG]: laterSession.token,
    }),
    /belongs to a different task/,
  );
});
