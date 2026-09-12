'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createComputerUseGate,
  classifyHelperFailure,
  classifyInputRejection,
  COMPUTER_USE_GATE_MISS,
  TASK_GRANT_TTL_MS,
  MAX_TASK_CU_STEPS,
  MAX_TASK_CU_DURATION_MS,
  resolveBrowserOriginFromSnapshot,
} = require('./computerUseGate.cjs');
const policy = require('../src/core/tools/computerUsePolicy.json');
const {
  COMPUTER_USE_TOKEN_ARG,
  COMPUTER_USE_REQUEST_CONTEXT_ARG,
} = require('./computerUseCommands.cjs');
const { createComputerUseTurnStopStore } = require('./computerUseTurnStopStore.cjs');
const { replayComputerUseTrajectory } = require('./computerUseTrajectory.cjs');

test('Host produces replayable versioned observations and an end event without task text', async () => {
  const events = [];
  const h = harness({ observability: { noteComputerUseTrajectory: (attributes) => events.push({
    ...attributes, timestamp: events.length * 100, appSessionId: 'a1111111-1111-4111-8111-111111111111',
    event: 'main.computer_use_trajectory', process: 'main', schemaVersion: 1,
  }) } });
  await observeState(h);
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', { conversationId: 'conversation-1', loopId: 'loop-1' });
  const report = replayComputerUseTrajectory(events);
  assert.equal(report.invalidRecordCount, 0);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].phase, 'ended');
  assert.equal(report.runs[0].historyComplete, true);
  assert.equal(JSON.stringify(events).includes('conversation-1'), false);
  h.gate.teardown();
});

function harness(overrides = {}) {
  const {
    nativeDispatch: customNativeDispatch,
    ...gateOverrides
  } = overrides;
  const harnessPlatform = gateOverrides.platform ?? 'darwin';
  let currentIdentity = {
    app_name: 'Notes',
    bundle_id: 'com.apple.Notes',
    process_id: 100,
    ...(harnessPlatform === 'win32'
      ? { app_id: 'com.apple.Notes', window_id: 'hwnd:0x100' }
      : {}),
  };
  const nativeCalls = [];
  const approvalRequests = [];
  const taskApprovalRequests = [];
  const actionApprovalRequests = [];
  const browserSiteApprovalRequests = [];
  let axElements = [];
  let modalWindowId = null;
  let helperKillCount = 0;
  let now = 10_000;
  let stateSequence = 0;
  let axSessionSequence = 0;
  let failingNativeCommand = null;
  let failingNativeError = null;
  let helperGeneration = 1;
  let listedWindows = null;
  let lastResolvedIdentity = null;
  let axSnapshotExtra = {};
  const gate = createComputerUseGate({
    platform: 'darwin',
    now: () => now,
    tokenFactory: () => '0123456789abcdef0123456789abcdef',
    stateIdFactory: () => `state-${++stateSequence}`,
    getNativeHelperGeneration: () => helperGeneration,
    getActiveWindow: async () => currentIdentity,
    nativeDispatch: async (cmd, args) => {
      if (customNativeDispatch) {
        const result = await customNativeDispatch(cmd, args);
        if (cmd === 'resolve_app_identity' && result && typeof result === 'object') {
          lastResolvedIdentity = { ...currentIdentity, ...result };
        }
        if (cmd === 'list_windows' && !Array.isArray(result)) {
          const candidate = lastResolvedIdentity ?? currentIdentity;
          return typeof candidate?.window_id === 'string' ? [candidate] : [];
        }
        if (cmd === 'activate_window' && typeof result?.app_name !== 'string') {
          return lastResolvedIdentity ?? currentIdentity;
        }
        return result;
      }
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
      if (cmd === 'list_windows') {
        if (Array.isArray(listedWindows)) return listedWindows;
        return typeof currentIdentity.window_id === 'string' ? [currentIdentity] : [];
      }
      if (cmd === 'activate_window') return currentIdentity;
      if (cmd === 'ax_snapshot') {
        return {
          session_id: `ax-session-${++axSessionSequence}`,
          app: currentIdentity.app_name,
          elements: axElements,
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: axSessionSequence,
          modal: modalWindowId !== null,
          modal_window_id: modalWindowId,
          ...axSnapshotExtra,
        };
      }
      if (cmd === failingNativeCommand) {
        if (failingNativeError) throw failingNativeError;
        throw new Error(`simulated ${cmd} uncertainty`);
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
    requestBrowserSiteApproval: async (request) => {
      browserSiteApprovalRequests.push(request);
      return true;
    },
    killNativeHelper: () => {
      helperKillCount += 1;
    },
    ...gateOverrides,
  });
  return {
    gate,
    sender: {},
    record: { label: 'main' },
    nativeCalls,
    approvalRequests,
    taskApprovalRequests,
    actionApprovalRequests,
    browserSiteApprovalRequests,
    get helperKillCount() {
      return helperKillCount;
    },
    setIdentity(value) {
      currentIdentity = harnessPlatform === 'win32'
        ? {
            app_id: value.app_id ?? value.bundle_id,
            window_id: value.window_id ?? 'hwnd:0x100',
            ...value,
          }
        : value;
    },
    setListedWindows(value) {
      listedWindows = value;
    },
    setAxElements(value) {
      axElements = value;
    },
    setModalWindowId(value) {
      modalWindowId = value;
    },
    setAxSnapshotExtra(value) {
      axSnapshotExtra = value && typeof value === 'object' ? value : {};
    },
    failNativeCommand(cmd, error = null) {
      failingNativeCommand = cmd;
      failingNativeError = error;
    },
    restartHelper() {
      helperGeneration += 1;
    },
    advance(ms) {
      now += ms;
    },
  };
}

async function begin(h, extra = {}) {
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  const request = {
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
  };
  const statefulActions = new Set([
    'click', 'move', 'type', 'perform_action', 'scroll', 'drag', 'key', 'ax_click', 'ax_type',
  ]);
  if (
    request.scope === 'ui-control'
    && statefulActions.has(request.actionIntent.action)
    && !request.expectedStateId
  ) {
    const observeSession = await h.gate.dispatch(
      h.record,
      h.sender,
      'computer_use_begin_session',
      {
        ...request,
        toolCallId: `${request.toolCallId}-observe`,
        actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
      },
    );
    const snapshot = await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
      appName: request.targetApp ?? 'Notes',
      [COMPUTER_USE_TOKEN_ARG]: observeSession.token,
    });
    await h.gate.dispatch(h.record, h.sender, 'computer_use_end_session', {
      [COMPUTER_USE_TOKEN_ARG]: observeSession.token,
    });
    request.expectedStateId = snapshot.state_id;
  }
  return h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', request);
}

async function observeState(h, extra = {}) {
  const session = await begin(h, {
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
    ...extra,
  });
  const snapshot = await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
    appName: extra.targetApp ?? 'Notes',
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_session', {
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  return snapshot;
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
      [COMPUTER_USE_REQUEST_CONTEXT_ARG]: {
        conversationId: 'conversation-1',
        loopId: 'loop-1',
        target: {
          appId: 'com.apple.Notes',
          processId: 100,
          windowId: null,
        },
      },
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

test('a read-intent session cannot bypass state_id by dispatching native input', async () => {
  const h = harness();
  const session = await begin(h, {
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /fresh state_id/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('Host Gate issues state_id and requires the latest observation for writes', async () => {
  const h = harness();
  const snapshot = await observeState(h);
  assert.equal(snapshot.state_id, 'state-1');

  const session = await begin(h, { expectedStateId: snapshot.state_id });
  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });

  await assert.rejects(
    begin(h, { toolCallId: 'tool-reuse', expectedStateId: snapshot.state_id }),
    /state_id was already consumed|verification of the previous action/,
  );
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length, 1);
});

test('Host Gate consumes state_id before an uncertain native failure', async () => {
  const h = harness();
  const snapshot = await observeState(h);
  const session = await begin(h, {
    expectedStateId: snapshot.state_id,
    actionIntent: { action: 'move', category: 'none', summary: '' },
  });
  h.failNativeCommand('mouse_move');

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_move', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /simulated mouse_move uncertainty/,
  );
  const status = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_get_task_status',
    { conversationId: 'conversation-1', loopId: 'loop-1' },
  );
  assert.deepEqual(status.outcome_unknown_receipt, {
    status: 'outcome-unknown',
    execution: 'outcome-unknown',
    helper_code: 'legacy',
    command: 'mouse_move',
    before_state_id: snapshot.state_id,
    attempt_count: 1,
    consequential: false,
    decision: 'observe-required',
  });
  await assert.rejects(
    begin(h, { toolCallId: 'tool-after-error', expectedStateId: snapshot.state_id }),
    /state_id was already consumed|verification of the previous action|stop-ambiguous-side-effect/,
  );

  h.failNativeCommand(null);
  const recovered = await observeState(h, { toolCallId: 'tool-reobserve-unknown' });
  assert.equal(recovered.verification_receipt.recovered_from_outcome_unknown, true);
  assert.equal(
    (await h.gate.dispatch(
      h.record,
      h.sender,
      'computer_use_get_task_status',
      { conversationId: 'conversation-1', loopId: 'loop-1' },
    )).outcome_unknown_receipt,
    null,
  );
});

test('Host Gate requires a verification snapshot before the next write and returns a receipt', async () => {
  const h = harness();
  h.setAxElements([{
    id: 1,
    role: 'AXButton',
    label: 'Before',
    value: null,
    actions: ['AXPress'],
    bounds: [0, 0, 20, 20],
    depth: 1,
  }]);
  const before = await observeState(h);
  const first = await begin(h, { expectedStateId: before.state_id });
  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 1,
    y: 1,
    [COMPUTER_USE_TOKEN_ARG]: first.token,
  });

  await assert.rejects(
    begin(h, { toolCallId: 'tool-before-verify', expectedStateId: before.state_id }),
    /verification of the previous action|already consumed/,
  );

  h.setAxElements([{
    id: 1,
    role: 'AXButton',
    label: 'After',
    value: null,
    actions: ['AXPress'],
    bounds: [0, 0, 20, 20],
    depth: 1,
  }]);
  const after = await observeState(h, { toolCallId: 'tool-verify' });
  assert.deepEqual(after.verification_receipt, {
    attempt_count: 1,
    command: 'mouse_click',
    before_state_id: before.state_id,
    after_state_id: after.state_id,
    execution: 'dispatched',
    status: 'verified-change',
    observation: 'changed',
    expectation: 'not-requested',
    decision: 'continue',
    consecutive_no_change: 0,
    recovery_used: false,
  });
});

test('Host Gate permits one recovery after three no-change receipts then stops after two more', async () => {
  const h = harness();
  h.setAxElements([{
    id: 1,
    role: 'AXButton',
    label: 'Static',
    value: null,
    actions: ['AXPress'],
    bounds: [0, 0, 20, 20],
    depth: 1,
  }]);
  let state = await observeState(h);
  const receipts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const session = await begin(h, {
      toolCallId: `tool-${attempt}`,
      expectedStateId: state.state_id,
    });
    await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: attempt,
      y: attempt,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    });
    state = await observeState(h, { toolCallId: `verify-${attempt}` });
    receipts.push(state.verification_receipt);
  }

  assert.deepEqual(receipts.map((receipt) => receipt.decision), [
    'continue',
    'continue',
    'recover',
    'continue',
    'stop-no-progress',
  ]);
  await assert.rejects(
    begin(h, { toolCallId: 'tool-after-stop', expectedStateId: state.state_id }),
    /run is stopped/,
  );
});

test('Host Gate stops a consequential run after an ambiguous native failure', async () => {
  const h = harness();
  const state = await observeState(h);
  const session = await begin(h, {
    expectedStateId: state.state_id,
    actionIntent: {
      action: 'click',
      category: 'send',
      summary: 'Send the disposable message',
    },
  });
  h.failNativeCommand('mouse_click');
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /simulated mouse_click uncertainty/,
  );
  const status = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_get_task_status',
    { conversationId: 'conversation-1', loopId: 'loop-1' },
  );
  assert.equal(status.stopped, true);
  assert.equal(status.stopped_reason, 'stop-ambiguous-side-effect');
  assert.equal(status.outcome_unknown_receipt.decision, 'stop-ambiguous-side-effect');
  await assert.rejects(
    begin(h, { toolCallId: 'tool-after-ambiguous', expectedStateId: state.state_id }),
    /run is stopped|already consumed/,
  );
});

test('Host Gate rejects expired state and a restarted target process', async () => {
  const expired = harness();
  const expiredSnapshot = await observeState(expired);
  expired.advance(30_001);
  await assert.rejects(
    begin(expired, { expectedStateId: expiredSnapshot.state_id }),
    /fresh state_id|state_id is expired/,
  );

  const restarted = harness();
  const restartedSnapshot = await observeState(restarted);
  restarted.setIdentity({
    app_name: 'Notes',
    bundle_id: 'com.apple.Notes',
    process_id: 101,
  });
  await assert.rejects(
    begin(restarted, { expectedStateId: restartedSnapshot.state_id }),
    /target process changed/,
  );
});

test('native helper restart invalidates old state_id and AX sessions', async () => {
  const pixel = harness();
  const pixelSnapshot = await observeState(pixel);
  pixel.restartHelper();
  await assert.rejects(
    begin(pixel, { expectedStateId: pixelSnapshot.state_id }),
    /fresh state_id after native helper restart/,
  );
  assert.equal(pixel.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);

  const accessibility = harness();
  const axSnapshot = await observeState(accessibility);
  const axSession = await begin(accessibility, {
    toolCallId: 'tool-after-observe',
    expectedStateId: axSnapshot.state_id,
    actionIntent: { action: 'ax_click', category: 'none', summary: '' },
  });
  accessibility.restartHelper();
  await assert.rejects(
    accessibility.gate.dispatch(accessibility.record, accessibility.sender, 'ax_press', {
      sessionId: 'ax-session-1',
      elementId: 1,
      [COMPUTER_USE_TOKEN_ARG]: axSession.token,
    }),
    /fresh state_id after native helper restart|Accessibility session expired after native helper restart/,
  );
  assert.equal(accessibility.nativeCalls.some(({ cmd }) => cmd === 'ax_press'), false);
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
      /state_id was already consumed|verification of the previous action/,
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

test('approval-required apps cannot bypass action approval by declaring Return harmless', async () => {
  const requests = [];
  const h = harness({
    requestActionApproval: async (request) => {
      requests.push(request);
      return false;
    },
  });
  h.setIdentity({
    app_name: 'Slack',
    bundle_id: 'com.tinyspeck.slackmacgap',
    process_id: 300,
  });
  const session = await begin(h, {
    targetApp: 'Slack',
    permissionMode: 'autonomous',
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'Return',
      modifiers: [],
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /was not approved/,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].consequence, {
    category: 'ambiguous',
    summary: 'Press Return in Slack; this may submit or send content',
    source: 'host-ambiguous-input',
  });
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'keyboard_press'), false);
});

test('approval-required apps require approval for semantic-free pixel clicks', async () => {
  const requests = [];
  const h = harness({
    requestActionApproval: async (request) => {
      requests.push(request);
      return false;
    },
  });
  h.setIdentity({
    app_name: 'Slack',
    bundle_id: 'com.tinyspeck.slackmacgap',
    process_id: 300,
  });
  const session = await begin(h, {
    targetApp: 'Slack',
    permissionMode: 'autonomous',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /was not approved/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].consequence.source, 'host-ambiguous-input');
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('ordinary apps cannot bypass action approval with semantic-free pixel clicks', async () => {
  const requests = [];
  const h = harness({
    requestActionApproval: async (request) => {
      requests.push(request);
      return false;
    },
  });
  const session = await begin(h, {
    permissionMode: 'autonomous',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /was not approved/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].consequence.source, 'host-ambiguous-input');
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
});

test('declared consequences retain their exact category and detail before ambiguous fallback', async () => {
  const h = harness();
  h.setIdentity({
    app_name: 'Slack',
    bundle_id: 'com.tinyspeck.slackmacgap',
    process_id: 300,
  });
  const session = await begin(h, {
    targetApp: 'Slack',
    actionIntent: {
      action: 'click',
      category: 'purchase',
      summary: 'Purchase the selected monthly plan',
    },
  });
  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 20,
    y: 30,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.deepEqual(h.actionApprovalRequests[0].consequence, {
    category: 'purchase',
    summary: 'Purchase the selected monthly plan',
    source: 'declared-intent',
  });
});

test('Windows obtains a UIA state_id before visual input and consumes it once', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const session = await begin(h, {
    targetApp: 'notepad',
    permissionMode: 'autonomous',
    actionIntent: { action: 'move', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'mouse_move', {
    x: 20,
    y: 30,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  const moves = h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_move');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].args.expectedInputEpoch, 1);
  assert.equal(moves[0].args.expectedWindowId, 'hwnd:0x100');
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'ax_snapshot'), true);
});

test('Host Gate treats a replacement modal HWND as progress when its controls are identical', async () => {
  const h = harness();
  h.setAxElements([{
    id: 1,
    role: 'Button',
    label: 'Close',
    value: null,
    actions: ['Invoke'],
    bounds: [10, 10, 20, 20],
    depth: 2,
  }]);
  h.setModalWindowId('hwnd:0x200');
  const before = await observeState(h);
  const session = await begin(h, {
    toolCallId: 'dismiss-first-modal',
    expectedStateId: before.state_id,
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_press', {
    sessionId: before.session_id,
    elementId: 1,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  h.setModalWindowId('hwnd:0x201');
  const after = await observeState(h, { toolCallId: 'observe-second-modal' });

  assert.equal(after.verification_receipt.status, 'verified-change');
  assert.equal(after.verification_receipt.decision, 'continue');
});

test('renderer calls cannot directly control the Host-owned input lease', async () => {
  const h = harness({ platform: 'win32' });
  assert.equal(
    await h.gate.dispatch(h.record, h.sender, 'input_lease_pause', {
      leaseId: 'attacker-selected',
      consentOwnerProcessId: process.pid,
    }),
    COMPUTER_USE_GATE_MISS,
  );
  assert.equal(h.nativeCalls.length, 0);
});

test('Windows locks the whole task after an ambiguous consequential native failure', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({ app_name: 'explorer', bundle_id: 'explorer.exe', process_id: 500 });
  const first = await begin(h, {
    targetApp: 'explorer',
    permissionMode: 'autonomous',
    actionIntent: {
      action: 'click',
      category: 'delete',
      summary: 'Delete the selected disposable test file',
    },
  });
  h.failNativeCommand('mouse_click');
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: first.token,
    }),
    /simulated mouse_click uncertainty/,
  );

  const nativeAttempts = h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length;
  await assert.rejects(
    begin(h, {
      targetApp: 'explorer',
      toolCallId: 'tool-windows-retry',
      permissionMode: 'autonomous',
      actionIntent: {
        action: 'click',
        category: 'delete',
        summary: 'Retry deleting the selected disposable test file',
      },
    }),
    /stop-ambiguous-side-effect|run is stopped/,
  );
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length, nativeAttempts);
});

test('Windows blocks same-task UI changes while consequential approval is pending', async () => {
  let resolveApproval;
  const h = harness({
    platform: 'win32',
    requestActionApproval: async () => new Promise((resolve) => {
      resolveApproval = resolve;
    }),
  });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const click = await begin(h, {
    targetApp: 'notepad',
    permissionMode: 'autonomous',
    actionIntent: {
      action: 'click',
      category: 'send',
      summary: 'Submit the prepared test content',
    },
  });
  const pendingClick = h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 20,
    y: 30,
    [COMPUTER_USE_TOKEN_ARG]: click.token,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    begin(h, {
      targetApp: 'notepad',
      toolCallId: 'tool-scroll-during-approval',
      permissionMode: 'autonomous',
      actionIntent: { action: 'scroll', category: 'none', summary: '' },
    }),
    /approval is still in progress|verification of the previous action/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_scroll'), false);

  resolveApproval(true);
  await pendingClick;
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length, 1);
});

test('Windows blocks consequential approval while another control command is in flight', async () => {
  let resolveScroll;
  const approvalRequests = [];
  const h = harness({
    platform: 'win32',
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'mouse_scroll') {
        return new Promise((resolve) => {
          resolveScroll = resolve;
        });
      }
      if (cmd === 'resolve_app_identity' || cmd === 'frontmost_app_identity') {
        return { app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 };
      }
      if (cmd === 'ax_snapshot') {
        return {
          session_id: 'windows-ax-session',
          app: 'notepad',
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x500',
          accessibility_revision: 1,
        };
      }
      return { ok: true };
    },
    requestActionApproval: async (request) => {
      approvalRequests.push(request);
      return true;
    },
  });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const scroll = await begin(h, {
    targetApp: 'notepad',
    permissionMode: 'autonomous',
    actionIntent: { action: 'scroll', category: 'none', summary: '' },
  });
  const pendingScroll = h.gate.dispatch(h.record, h.sender, 'mouse_scroll', {
    x: 20,
    y: 30,
    direction: 'down',
    [COMPUTER_USE_TOKEN_ARG]: scroll.token,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    begin(h, {
      targetApp: 'notepad',
      toolCallId: 'tool-click-during-scroll',
      permissionMode: 'autonomous',
      actionIntent: {
        action: 'click',
        category: 'send',
        summary: 'Submit the prepared test content',
      },
    }),
    /native action is still in flight|verification of the previous action/,
  );
  assert.equal(approvalRequests.length, 0);

  resolveScroll({ ok: true });
  await pendingScroll;
});

test('Windows releases the pre-approval task reservation when the user rejects', async () => {
  const h = harness({ platform: 'win32', requestActionApproval: async () => false });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const click = await begin(h, {
    targetApp: 'notepad',
    permissionMode: 'autonomous',
    actionIntent: {
      action: 'click',
      category: 'send',
      summary: 'Submit the prepared test content',
    },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 20,
      y: 30,
      [COMPUTER_USE_TOKEN_ARG]: click.token,
    }),
    /was not approved/,
  );

  const move = await begin(h, {
    targetApp: 'notepad',
    toolCallId: 'tool-move-after-reject',
    permissionMode: 'autonomous',
    actionIntent: { action: 'move', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'mouse_move', {
    x: 20,
    y: 30,
    [COMPUTER_USE_TOKEN_ARG]: move.token,
  });
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_move').length, 1);
});

test('Windows Explorer Delete cannot bypass action approval by declaring none', async () => {
  const requests = [];
  const h = harness({
    platform: 'win32',
    requestActionApproval: async (request) => {
      requests.push(request);
      return false;
    },
  });
  h.setIdentity({ app_name: 'explorer', bundle_id: 'explorer.exe', process_id: 500 });
  const session = await begin(h, {
    targetApp: 'explorer',
    permissionMode: 'autonomous',
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'Delete',
      modifiers: ['Shift'],
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /was not approved/,
  );
  assert.equal(requests[0].consequence.category, 'delete');
  assert.match(requests[0].consequence.summary, /Permanently delete/);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'keyboard_press'), false);
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

test('Host keeps the same window state valid across a long action approval', async () => {
  let releaseApproval;
  let noteRequested;
  const approvalRequested = new Promise((resolve) => { noteRequested = resolve; });
  const h = harness({
    platform: 'win32',
    requestActionApproval: async () => {
      noteRequested();
      return new Promise((resolve) => { releaseApproval = resolve; });
    },
  });
  h.setIdentity({
    app_name: 'Notes', bundle_id: 'notes.exe', process_id: 100, window_id: 'hwnd:0x100',
  });
  const observed = await observeState(h, { targetApp: 'Notes' });
  const session = await begin(h, {
    windowRef: observed.target.window_ref,
    expectedStateId: observed.state_id,
    actionIntent: { action: 'click', category: 'send', summary: 'send fixture marker' },
  });
  const pending = h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 20,
    y: 30,
    expectedStateId: observed.state_id,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  await approvalRequested;

  h.advance(10 * 60 * 1000);
  releaseApproval(true);

  await assert.doesNotReject(pending);
  assert.equal(session.target.window_ref, observed.target.window_ref);
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_click').length, 1);
});

test('Host stop aborts while approval is paused and no input follows', async () => {
  let releaseApproval;
  let noteRequested;
  const approvalRequested = new Promise((resolve) => { noteRequested = resolve; });
  const h = harness({
    platform: 'win32',
    requestActionApproval: async () => {
      noteRequested();
      return new Promise((resolve) => { releaseApproval = resolve; });
    },
  });
  h.setIdentity({
    app_name: 'Notes', bundle_id: 'notes.exe', process_id: 100, window_id: 'hwnd:0x100',
  });
  const observed = await observeState(h, { targetApp: 'Notes' });
  const session = await begin(h, {
    windowRef: observed.target.window_ref,
    expectedStateId: observed.state_id,
    actionIntent: { action: 'click', category: 'send', summary: 'send fixture marker' },
  });
  const pending = h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 20,
    y: 30,
    expectedStateId: observed.state_id,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  await approvalRequested;

  await h.gate.dispatch(h.record, h.sender, 'computer_use_stop_turn', {
    conversationId: 'conversation-1', loopId: 'loop-1', reason: 'user-stop',
  });
  releaseApproval(true);

  await assert.rejects(pending, /no longer active|stopped/i);
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

test('Windows rejects Abu itself even when development uses electron.exe', async () => {
  const h = harness({ platform: 'win32', selfProcessId: 9616 });
  h.setIdentity({
    app_name: 'electron',
    bundle_id: 'F:\\Abu\\Abu-Cowork\\node_modules\\electron\\dist\\electron.exe',
    process_id: 9616,
  });

  await assert.rejects(
    begin(h, { targetApp: 'electron' }),
    /blocked from operating Abu itself/,
  );
  assert.equal(h.gate.classifyIdentity({
    app_name: 'electron',
    bundle_id: 'F:\\Abu\\Abu-Cowork\\node_modules\\electron\\dist\\electron.exe',
    process_id: 9616,
  }), 'hard-deny');
});

test('Windows foreground-at-submit uses only the target frozen at turn start', async () => {
  const selfWindow = {
    app_name: 'electron',
    bundle_id: 'F:\\Abu\\Abu-Cowork\\node_modules\\electron\\dist\\electron.exe',
    app_id: 'F:\\Abu\\Abu-Cowork\\node_modules\\electron\\dist\\electron.exe',
    process_id: 9616,
    window_id: '0x100',
  };
  const notepadWindow = {
    app_name: 'Notepad',
    app_id: 'aumid:microsoft.windowsnotepad_8wekyb3d8bbwe!app',
    process_id: 9676,
    window_id: '0x200',
    signature_status: 'package-trusted',
    package_full_name: 'Microsoft.WindowsNotepad_11.0.0.0_x64__8wekyb3d8bbwe',
  };
  const calculatorWindow = {
    app_name: 'Calculator',
    app_id: 'aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app',
    process_id: 9680,
    window_id: '0x300',
    signature_status: 'package-trusted',
    package_full_name: 'Microsoft.WindowsCalculator_11.0.0.0_x64__8wekyb3d8bbwe',
  };
  const h = harness({ platform: 'win32', selfProcessId: 9616 });
  h.setIdentity(selfWindow);
  h.setListedWindows([selfWindow, notepadWindow, calculatorWindow]);
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });

  const capture = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_capture_turn_target',
    { conversationId: 'conversation-1', loopId: 'loop-1', interactionMode: 'foreground' },
  );
  h.setListedWindows([selfWindow, calculatorWindow, notepadWindow]);
  const session = await begin(h, {
    targetSelector: 'foreground-at-submit',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.deepEqual(capture, { captured: true });
  assert.equal(session.status, 'authorized');
  assert.equal(session.target.app_name, 'Notepad');
  assert.equal(session.target.process_id, 9676);
});

test('Windows missing target returns target-required without reading foreground or Z-order', async () => {
  let activeWindowReads = 0;
  const h = harness({
    platform: 'win32',
    selfProcessId: 9616,
    getActiveWindow: async () => {
      activeWindowReads += 1;
      return {
        app_name: 'Notepad',
        bundle_id: 'aumid:microsoft.windowsnotepad_8wekyb3d8bbwe!app',
        process_id: 9676,
        window_id: '0x200',
        signature_status: 'package-trusted',
        package_full_name: 'Microsoft.WindowsNotepad_11.0.0.0_x64__8wekyb3d8bbwe',
      };
    },
  });

  const result = await begin(h, {
    targetApp: null,
    windowRef: null,
    targetSelector: null,
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.deepEqual(result, {
    status: 'target-error',
    error: {
      code: 'target-required',
      recoverable: true,
      next_action: 'select-target',
    },
  });
  assert.equal(activeWindowReads, 0);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'list_windows'), false);
});

test('Windows window listing returns opaque candidates without starting input or observation', async () => {
  const firstWindow = {
    app_name: 'Notepad',
    app_id: 'aumid:microsoft.windowsnotepad_8wekyb3d8bbwe!app',
    process_id: 9676,
    window_id: '0x200',
    title: 'first.txt - Notepad',
    signature_status: 'package-trusted',
    package_full_name: 'Microsoft.WindowsNotepad_11.0.0.0_x64__8wekyb3d8bbwe',
  };
  const secondWindow = {
    ...firstWindow,
    process_id: 9677,
    window_id: '0x201',
    title: 'second.txt - Notepad',
  };
  const h = harness({ platform: 'win32', selfProcessId: 9616 });
  h.setIdentity({ ...firstWindow, bundle_id: firstWindow.app_id });
  h.setListedWindows([firstWindow, secondWindow]);
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });

  const result = await h.gate.dispatch(h.record, h.sender, 'computer_use_list_windows', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
    interactionMode: 'foreground',
    app: 'Notepad',
  });

  assert.equal(result.status, 'candidates');
  assert.deepEqual(result.candidates.map(({ app_name, relation, title }) => ({ app_name, relation, title })), [
    { app_name: 'Notepad', relation: 'root', title: 'first.txt - Notepad' },
    { app_name: 'Notepad', relation: 'root', title: 'second.txt - Notepad' },
  ]);
  assert.equal(result.candidates.every(({ window_ref }) => /^wr-/.test(window_ref)), true);
  assert.equal(JSON.stringify(result).includes('0x200'), false);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'ax_snapshot' || cmd === 'activate_window'), false);
});

test('Windows session resolves an existing windowRef before conflicting app selectors', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    app_id: 'winword.exe',
    process_id: 42,
    window_id: 'hwnd:0x100',
  });
  h.setListedWindows([{
    app_name: 'WINWORD',
    app_id: 'winword.exe',
    process_id: 42,
    window_id: 'hwnd:0x100',
  }]);
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  const listed = await h.gate.dispatch(h.record, h.sender, 'computer_use_list_windows', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
    interactionMode: 'foreground',
    app: 'Word',
  });
  h.nativeCalls.length = 0;

  const session = await begin(h, {
    windowRef: listed.candidates[0].window_ref,
    targetApp: 'Excel',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.equal(session.status, 'authorized');
  assert.equal(session.target.window_ref, listed.candidates[0].window_ref);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'resolve_app_identity'), false);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'get_active_window'), false);
});

test('Windows explicit app selection returns candidates instead of choosing one of several windows', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    app_id: 'winword.exe',
    process_id: 42,
    window_id: 'hwnd:0x100',
  });
  h.setListedWindows([
    {
      app_name: 'WINWORD', app_id: 'winword.exe', process_id: 42,
      window_id: 'hwnd:0x100', title: 'Document 1',
    },
    {
      app_name: 'WINWORD', app_id: 'winword.exe', process_id: 42,
      window_id: 'hwnd:0x200', title: 'Document 2',
    },
  ]);

  const result = await begin(h, {
    targetApp: 'Word',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.equal(result.status, 'target-error');
  assert.equal(result.error.code, 'target-ambiguous');
  assert.equal(result.error.candidates.length, 2);
  assert.deepEqual(result.error.candidates.map((candidate) => candidate.title), [
    'Document 1', 'Document 2',
  ]);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'ax_snapshot'), false);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'input_lease_begin'), false);
});

test('Windows explicit app selection returns target-not-found when no visible window matches', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'WINWORD', bundle_id: 'winword.exe', process_id: 42,
    window_id: 'hwnd:0x100',
  });
  h.setListedWindows([]);

  const result = await begin(h, {
    targetApp: 'Word',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.deepEqual(result, {
    status: 'target-error',
    error: {
      code: 'target-not-found',
      recoverable: true,
      next_action: 'select-target',
    },
  });
  assert.equal(h.approvalRequests.length, 0);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'input_lease_begin'), false);
});

test('Windows activation uses the authorized exact window rather than resolving its app again', async () => {
  const identity = { app_name: 'Editor', bundle_id: 'editor.exe', app_id: 'editor.exe', process_id: 42, window_id: 'hwnd:0x100' };
  const calls = [];
  let changed = false;
  const h = harness({ platform: 'win32', nativeDispatch: async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'check_macos_permissions') return { screen_recording: true, accessibility: true };
    if (cmd === 'resolve_app_identity') return { ...identity, window_id: changed ? 'hwnd:0x200' : identity.window_id };
    if (cmd === 'get_window' || cmd === 'activate_window') return identity;
    return { ok: true };
  } });
  h.setIdentity(identity);
  const session = await begin(h, { targetApp: 'Editor', actionIntent: { action: 'get_window_state', category: 'none', summary: '' } });
  changed = true;
  calls.length = 0;
  const result = await h.gate.dispatch(h.record, h.sender, 'activate_app', {
    appName: 'Editor', [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.equal(result, 'Editor');
  assert.equal(calls.some(({ cmd }) => cmd === 'resolve_app_identity' || cmd === 'activate_app'), false);
  assert.equal(calls.find(({ cmd }) => cmd === 'activate_window')?.args.windowId, 'hwnd:0x100');
});

test('Windows rejects a WindowRef outside its sender-bound task without app fallback', async () => {
  const h = harness({ platform: 'win32' });

  const result = await begin(h, {
    windowRef: 'wr-not-issued-for-this-task',
    targetApp: 'Word',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  assert.equal(result.status, 'target-error');
  assert.equal(result.error.code, 'window-ref-invalid');
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'resolve_app_identity'), false);
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
    window_ref: null,
    relation: 'root',
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
    args: {
      [COMPUTER_USE_REQUEST_CONTEXT_ARG]: {
        conversationId: 'conversation-1',
        loopId: 'loop-1',
        target: {
          appId: 'abu.screen',
          processId: null,
          windowId: null,
        },
      },
    },
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
      if (cmd === 'resolve_app_identity') {
        return { app_name: 'Notes', bundle_id: 'com.apple.Notes', process_id: 100 };
      }
      if (cmd === 'ax_snapshot') {
        return { session_id: 'ax-stop-test', app: 'Notes', elements: [] };
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
      if (cmd === 'resolve_app_identity') {
        return { app_name: 'Notes', bundle_id: 'com.apple.Notes', process_id: 100 };
      }
      if (cmd === 'ax_snapshot') {
        assert.equal(args.expectedBundleId, 'com.apple.Notes');
        assert.equal(args.expectedProcessId, 100);
        return { session_id: 'ax-global-input', app: 'Notes', elements: [] };
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

// ── RB-04: the task CU budget is enforced HERE, across batches ──
// The renderer used to own these caps, and reset them at the top of every
// computer batch (`setComputerUseActive(true, …)`), so a task spanning
// several batches never reached either limit. These pin the host as the
// authoritative counter.

/** One begin_session that consumes exactly one step (screen-read never
 *  triggers the observe-then-act pair that a stateful ui-control action
 *  does, so the arithmetic below stays honest). */
async function readStep(h, extra = {}) {
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });
  return h.gate.dispatch(h.record, h.sender, 'computer_use_begin_session', {
    conversationId: 'conversation-1',
    toolCallId: 'tool-1',
    loopId: 'loop-1',
    interactionMode: 'foreground',
    scope: 'screen-read',
    permissionMode: 'standard',
    actionIntent: { action: 'screenshot', category: 'none', summary: '' },
    ...extra,
  });
}

test('CU step budget accumulates across batches instead of resetting', async () => {
  const h = harness();
  for (let i = 0; i < MAX_TASK_CU_STEPS; i++) {
    await readStep(h, { toolCallId: `tool-${i}` });
  }

  // The 31st action in the SAME task is refused — under the old renderer
  // budget each new batch zeroed the counter, so this never happened.
  await assert.rejects(
    readStep(h, { toolCallId: 'tool-over' }),
    /30-step limit/,
  );
});

test('CU step budget is per task — a later task starts with a full one', async () => {
  const h = harness();
  for (let i = 0; i < MAX_TASK_CU_STEPS; i++) {
    await readStep(h, { toolCallId: `tool-${i}` });
  }
  await assert.rejects(readStep(h, { toolCallId: 'tool-over' }), /30-step limit/);

  // Single-flight is unchanged by this fix: the spent task still holds the
  // global reservation until it ends, exactly as before. End it the way the
  // agent loop does, and the next task gets its own full budget rather than
  // inheriting the exhausted one.
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });

  await assert.doesNotReject(
    readStep(h, { loopId: 'loop-2', toolCallId: 'tool-fresh' }),
  );
});

test('CU time budget is fixed at first use and re-entry does not extend it', async () => {
  const h = harness();
  await readStep(h);

  // Just inside the window: still allowed, and this re-entry must NOT push
  // the deadline forward.
  h.advance(MAX_TASK_CU_DURATION_MS - 1_000);
  await assert.doesNotReject(readStep(h, { toolCallId: 'tool-late' }));

  h.advance(2_000);
  await assert.rejects(
    readStep(h, { toolCallId: 'tool-expired' }),
    /5-minute limit/,
  );
});

test('an over-budget task keeps its budget across a re-entry attempt', async () => {
  const h = harness();
  for (let i = 0; i < MAX_TASK_CU_STEPS; i++) {
    await readStep(h, { toolCallId: `tool-${i}` });
  }

  // Refused, and STAYS refused: a rejected action must not have banked a
  // step back or rebuilt the budget, or retrying would walk past the cap one
  // failure at a time.
  await assert.rejects(readStep(h, { toolCallId: 'tool-over-1' }), /30-step limit/);
  await assert.rejects(readStep(h, { toolCallId: 'tool-over-2' }), /30-step limit/);
});

// Review finding on the first cut of this change: the budget was charged
// before `reserveTaskAuthorization`, which throws when another task holds
// the global single-flight reservation. The throw does not refund, so a task
// that never executed anything could burn its whole budget on transient
// "already active" errors — and would then be told it hit a 30-step limit
// instead of the real reason.
test('a reservation refused for single-flight does not burn the budget', async () => {
  const h = harness();
  await h.gate.dispatch(h.record, h.sender, 'computer_use_set_enabled', { enabled: true });

  // Task A takes the global reservation.
  await readStep(h, { conversationId: 'conversation-a', loopId: 'loop-a', toolCallId: 'a-1' });

  // Task B is refused for single-flight, MAX times over — the natural shape
  // of an agent retrying a transient error.
  for (let i = 0; i < MAX_TASK_CU_STEPS; i++) {
    await assert.rejects(
      readStep(h, { conversationId: 'conversation-b', loopId: 'loop-b', toolCallId: `b-${i}` }),
      /already active in another foreground task/,
    );
  }

  // A now finishes. B must still have its full budget: it never ran a step.
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_task', {
    conversationId: 'conversation-a',
    loopId: 'loop-a',
  });

  await assert.doesNotReject(
    readStep(h, { conversationId: 'conversation-b', loopId: 'loop-b', toolCallId: 'b-final' }),
  );
});

test('Windows approval duration is excluded and the input lease starts only after consent', async () => {
  let finishApproval;
  const events = [];
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-duration-test',
    nativeDispatch: async (cmd) => {
      events.push(cmd);
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        return {
          app_name: 'Notes',
          bundle_id: 'notes.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'input_lease_begin') {
        return { phase: 'observing', input_epoch: 1 };
      }
      return { ok: true };
    },
    requestAppApproval: async () => {
      events.push('approval-open');
      await new Promise((resolve) => { finishApproval = resolve; });
      events.push('approval-closed');
      return true;
    },
  });

  const pending = begin(h, {
    targetApp: 'Notes',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('input_lease_begin'), false);

  // Human review can take arbitrarily longer than the execution budget.
  h.advance(MAX_TASK_CU_DURATION_MS * 12);
  finishApproval();
  await pending;
  assert.ok(events.indexOf('approval-closed') < events.indexOf('input_lease_begin'));

  // The active-time clock starts after approval, not when the dialog opened.
  h.advance(MAX_TASK_CU_DURATION_MS - 1_000);
  await assert.doesNotReject(begin(h, {
    targetApp: 'Notes',
    toolCallId: 'tool-after-long-consent',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  }));
  h.advance(2_000);
  await assert.rejects(begin(h, {
    targetApp: 'Notes',
    toolCallId: 'tool-active-time-expired',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  }), /5-minute limit/);
});

test('Windows publishes takeover only inside a native write critical section', async () => {
  const events = [];
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-critical-section',
    nativeDispatch: async (cmd) => {
      events.push(cmd);
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        return {
          app_name: 'Word',
          bundle_id: 'winword.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 1 };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'activate_window') {
        return {
          app_name: 'Word',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'ax_snapshot') {
        return {
          session_id: 'ax-critical-section',
          app: 'Word',
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: 1,
        };
      }
      if (cmd === 'mouse_click') return { ok: true };
      return { ok: true };
    },
  });
  h.setIdentity({
    app_name: 'Word',
    bundle_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  });

  const state = await observeState(h, { targetApp: 'Word' });
  const commitIndex = events.lastIndexOf('input_lease_commit_observation');
  assert.ok(commitIndex > events.lastIndexOf('ax_snapshot'));
  assert.equal(events.slice(0, commitIndex + 1).includes('input_lease_activate'), false);

  const session = await begin(h, {
    targetApp: 'Word',
    expectedStateId: state.state_id,
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'mouse_click', {
    x: 10,
    y: 10,
    expectedStateId: state.state_id,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });

  const activateIndex = events.lastIndexOf('input_lease_activate');
  const actionIndex = events.lastIndexOf('mouse_click');
  const observeIndex = events.lastIndexOf('input_lease_observe');
  assert.ok(activateIndex < actionIndex);
  assert.ok(actionIndex < observeIndex);
});

test('Windows stateful actions stay pinned to the observed Office HWND', async () => {
  let resolveCalls = 0;
  const nativeCalls = [];
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-office-window-pin',
    nativeDispatch: async (cmd, args) => {
      nativeCalls.push({ cmd, args });
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        resolveCalls += 1;
        return {
          app_name: 'WINWORD',
          bundle_id: 'winword.exe',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: resolveCalls <= 2 ? 'hwnd:0x100' : 'hwnd:0x200',
        };
      }
      if (cmd === 'get_window') {
        assert.equal(args.windowId, 'hwnd:0x100');
        return {
          app_name: 'WINWORD',
          app_id: 'winword.exe',
          executable_path: 'C:\\Program Files\\Microsoft Office\\WINWORD.EXE',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'frontmost_matches_target') {
        assert.deepEqual(args, {
          expectedAppId: 'winword.exe',
          expectedProcessId: 100,
          expectedWindowId: 'hwnd:0x100',
        });
        return {
          matches: true,
          actual_window_id: 'hwnd:0x300',
          relation: 'frontmost-owned-by-target',
        };
      }
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 1 };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'activate_window') {
        return {
          app_name: 'WINWORD',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'ax_snapshot') {
        return {
          session_id: 'ax-office-window-pin',
          app: 'WINWORD',
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: 1,
        };
      }
      return { ok: true };
    },
  });
  h.setIdentity({
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  });

  const state = await observeState(h, { targetApp: 'Word' });
  const actionSession = await begin(h, {
    targetApp: 'Word',
    expectedStateId: state.state_id,
    actionIntent: { action: 'type', category: 'none', summary: '' },
  });
  assert.match(actionSession.target.window_ref, /^wr-/);
  assert.equal(actionSession.target.window_id, undefined);

  h.setIdentity({
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x300',
  });

  await h.gate.dispatch(h.record, h.sender, 'keyboard_type', {
    text: 'ABU',
    expectedStateId: state.state_id,
    [COMPUTER_USE_TOKEN_ARG]: actionSession.token,
  });
  const write = nativeCalls.findLast(({ cmd }) => cmd === 'keyboard_type');
  assert.equal(write.args.expectedWindowId, 'hwnd:0x100');
});

test('Windows accessibility text replacement carries the observed target and input epoch', async () => {
  const nativeCalls = [];
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-visible-text',
    nativeDispatch: async (cmd, args) => {
      nativeCalls.push({ cmd, args });
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity' || cmd === 'activate_window') {
        return {
          app_name: 'Editor',
          bundle_id: 'editor.exe',
          app_id: 'editor.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'get_window') {
        return {
          app_name: 'Editor',
          app_id: 'editor.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 9 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 9 };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 9 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 9 };
      if (cmd === 'ax_snapshot') {
        return {
          session_id: `ax-visible-text-${nativeCalls.length}`,
          app: 'Editor',
          elements: [{ id: 7, role: 'Document', label: 'Document' }],
          input_epoch: 9,
          window_id: 'hwnd:0x100',
          accessibility_revision: 1,
        };
      }
      return { ok: true };
    },
  });
  h.setIdentity({
    app_name: 'Editor',
    bundle_id: 'editor.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  });

  const state = await observeState(h, { targetApp: 'Editor' });
  const actionSession = await begin(h, {
    targetApp: 'Editor',
    expectedStateId: state.state_id,
    actionIntent: { action: 'type', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_replace_text', {
    sessionId: state.session_id,
    elementId: 7,
    text: 'visible edit',
    expectedStateId: state.state_id,
    [COMPUTER_USE_TOKEN_ARG]: actionSession.token,
  });

  const write = nativeCalls.findLast(({ cmd }) => cmd === 'ax_replace_text');
  assert.equal(write.args.expectedBundleId, 'editor.exe');
  assert.equal(write.args.expectedProcessId, 100);
  assert.equal(write.args.expectedWindowId, 'hwnd:0x100');
  assert.equal(write.args.expectedInputEpoch, 9);
});

test('Windows verification follows a same-process HWND replacement after an approved action', async () => {
  let currentWindowId = 'hwnd:0x100';
  let previousWindowGone = false;
  let snapshotSequence = 0;
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-office-window-replacement',
    nativeDispatch: async (cmd, args) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        return {
          app_name: 'WINWORD',
          bundle_id: 'winword.exe',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: currentWindowId,
        };
      }
      if (cmd === 'get_window') {
        assert.equal(args.windowId, 'hwnd:0x100');
        if (previousWindowGone) throw new Error('window is not visible');
        return {
          app_name: 'WINWORD',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 1 };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'activate_window') {
        return {
          app_name: 'WINWORD',
          app_id: 'winword.exe',
          process_id: 100,
          window_id: currentWindowId,
        };
      }
      if (cmd === 'ax_snapshot') {
        snapshotSequence += 1;
        return {
          session_id: `ax-office-window-replacement-${snapshotSequence}`,
          app: 'WINWORD',
          elements: previousWindowGone ? [{
            id: 0,
            role: 'Document',
            label: 'Document1',
            value: null,
            bounds: [0, 0, 100, 100],
            patterns: [],
            actions: [],
            depth: 0,
            automation_id: null,
            class_name: null,
            enabled: true,
            offscreen: false,
            focused: true,
          }] : [],
          input_epoch: 1,
          window_id: currentWindowId,
          accessibility_revision: snapshotSequence,
        };
      }
      if (cmd === 'ax_press') {
        previousWindowGone = true;
        currentWindowId = 'hwnd:0x200';
        return { ok: true };
      }
      return { ok: true };
    },
  });
  h.setIdentity({
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  });

  const before = await observeState(h, { targetApp: 'Word' });
  const actionSession = await begin(h, {
    targetApp: 'Word',
    expectedStateId: before.state_id,
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_press', {
    sessionId: before.session_id,
    elementId: 0,
    expectedStateId: before.state_id,
    [COMPUTER_USE_TOKEN_ARG]: actionSession.token,
  });
  await h.gate.dispatch(h.record, h.sender, 'computer_use_end_session', {
    [COMPUTER_USE_TOKEN_ARG]: actionSession.token,
  });

  const after = await observeState(h, { targetApp: 'Word' });
  assert.equal(after.window_id, undefined);
  assert.equal(after.target.relation, 'replacement');
  assert.equal(after.target.window_ref.startsWith('wr-'), true);
  assert.deepEqual(after.related_windows, [{
    window_ref: after.target.window_ref,
    app_name: 'WINWORD',
    relation: 'replacement',
  }]);
  assert.equal(after.verification_receipt.status, 'verified-change');
  assert.equal(after.verification_receipt.decision, 'continue');
});

test('Windows pauses takeover for action consent and rejects external input before dispatch', async () => {
  const events = [];
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-consent-test',
    nativeDispatch: async (cmd) => {
      events.push(cmd);
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') {
        return {
          app_name: 'Notes',
          bundle_id: 'notes.exe',
          process_id: 100,
          window_id: 'hwnd:0x100',
        };
      }
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_pause') return { phase: 'paused-for-consent', input_epoch: 1 };
      if (cmd === 'input_lease_resume') {
        return { phase: 'observing', input_epoch: 2, dirty: true };
      }
      if (cmd === 'ax_snapshot') {
        return {
          session_id: 'ax-consent-test',
          app: 'Notes',
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: 1,
        };
      }
      return { ok: true };
    },
    requestActionApproval: async () => {
      events.push('action-approval');
      return true;
    },
  });
  h.setIdentity({
    app_name: 'Notes',
    bundle_id: 'notes.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  });

  const state = await observeState(h, { targetApp: 'Notes' });
  const session = await begin(h, {
    targetApp: 'Notes',
    expectedStateId: state.state_id,
    actionIntent: {
      action: 'click',
      category: 'delete',
      summary: 'Delete the selected item',
    },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 10,
      y: 10,
      expectedStateId: state.state_id,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /changed another app during approval/,
  );
  assert.ok(events.indexOf('input_lease_pause') < events.indexOf('action-approval'));
  assert.ok(events.indexOf('action-approval') < events.indexOf('input_lease_resume'));
  assert.equal(events.includes('mouse_click'), false);
});

test('Windows restores the exact UIA focus after action consent before dispatch', async () => {
  const events = [];
  let snapshotSequence = 0;
  const identity = {
    app_name: 'POWERPNT',
    bundle_id: 'powerpnt.exe',
    app_id: 'powerpnt.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  };
  const element = {
    id: 7,
    role: 'Document',
    label: 'Slide title',
    value: null,
    bounds: [10, 10, 400, 200],
    patterns: [],
    actions: ['Focus'],
    depth: 1,
    automation_id: null,
    class_name: null,
    enabled: true,
    offscreen: false,
    focused: true,
  };
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-focus-restore',
    nativeDispatch: async (cmd, args) => {
      events.push({ cmd, args });
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') return identity;
      if (cmd === 'activate_window') return identity;
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 1 };
      }
      if (cmd === 'input_lease_pause') return { phase: 'paused-for-consent', input_epoch: 1 };
      if (cmd === 'input_lease_resume') {
        return { phase: 'observing', input_epoch: 1, dirty: false };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'ax_snapshot') {
        snapshotSequence += 1;
        return {
          session_id: `ax-focus-${snapshotSequence}`,
          app: 'POWERPNT',
          elements: [element],
          focused_element_id: 7,
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: snapshotSequence,
        };
      }
      return { ok: true };
    },
    requestActionApproval: async () => {
      events.push({ cmd: 'action-approval', args: null });
      return true;
    },
  });
  h.setIdentity(identity);

  const state = await observeState(h, { targetApp: 'PowerPoint' });
  const session = await begin(h, {
    targetApp: 'PowerPoint',
    expectedStateId: state.state_id,
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
    key: 'Enter',
    expectedStateId: state.state_id,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });

  const approvalIndex = events.findIndex(({ cmd }) => cmd === 'action-approval');
  const activateWindowIndex = events.findIndex(({ cmd }) => cmd === 'activate_window');
  const restoreIndex = events.findIndex(({ cmd }) => cmd === 'ax_restore_focus');
  const keyIndex = events.findIndex(({ cmd }) => cmd === 'keyboard_press');
  assert.ok(approvalIndex < activateWindowIndex);
  assert.ok(activateWindowIndex < restoreIndex);
  assert.ok(restoreIndex < keyIndex);
  assert.equal(events[restoreIndex].args.sessionId, state.session_id);
});

test('Windows rejects a stale state when an Office modal appears before input', async () => {
  let snapshotSequence = 0;
  let keyboardDispatched = false;
  const identity = {
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    app_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  };
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-late-modal',
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') return identity;
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') {
        return { phase: 'observing', input_epoch: 1 };
      }
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'activate_window') return identity;
      if (cmd === 'ax_snapshot') {
        snapshotSequence += 1;
        const modal = snapshotSequence > 1;
        return {
          session_id: `ax-late-modal-${snapshotSequence}`,
          app: 'WINWORD',
          elements: modal ? [{
            id: 1,
            role: 'Button',
            label: 'Close',
            value: null,
            bounds: [100, 100, 40, 30],
            patterns: ['Invoke'],
            actions: ['Invoke'],
            depth: 1,
            automation_id: null,
            class_name: null,
            enabled: true,
            offscreen: false,
            focused: true,
          }] : [],
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: snapshotSequence,
          modal,
          modal_window_id: modal ? 'hwnd:0x200' : null,
        };
      }
      if (cmd === 'keyboard_press') keyboardDispatched = true;
      return { ok: true };
    },
  });
  h.setIdentity(identity);

  const state = await observeState(h, { targetApp: 'Word' });
  const session = await begin(h, {
    targetApp: 'Word',
    expectedStateId: state.state_id,
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'Tab',
      expectedStateId: state.state_id,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /interface changed after observation/,
  );
  assert.equal(keyboardDispatched, false);
});

test('Windows pre-input revalidation identifies the changed boundary without exposing window content', async () => {
  for (const [change, reason] of [
    [{ input_epoch: 2 }, 'input-epoch'],
    [{ window_id: 'hwnd:0x999' }, 'target-window'],
    [{ modal: true }, 'modal-boundary'],
    [{ modal_window_id: 'hwnd:0x999' }, 'modal-window'],
    [{ window_graph: { nodes: [] } }, 'window-graph'],
  ]) {
    const identity = { app_name: 'Editor', bundle_id: 'editor.exe', process_id: 100, window_id: 'hwnd:0x100' };
    let sequence = 0;
    let dispatched = false;
    const h = harness({ platform: 'win32', nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') return { screen_recording: true, accessibility: true };
      if (cmd === 'resolve_app_identity' || cmd === 'activate_window') return identity;
      if (cmd.startsWith('input_lease_')) return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'ax_snapshot') return {
        session_id: `ax-boundary-${++sequence}`, app: 'Editor', elements: [], input_epoch: 1,
        window_id: 'hwnd:0x100', modal: false, modal_window_id: null,
        window_graph: { target_window_id: 'hwnd:0x100', nodes: [{ window_id: 'hwnd:0x100',
          app_id: 'editor.exe', app_name: 'Editor', process_id: 100, relation: 'exact', title: 'PRIVATE_TITLE' }] },
        ...(sequence > 1 ? change : {}),
      };
      if (cmd === 'keyboard_press') dispatched = true;
      return { ok: true };
    } });
    h.setIdentity(identity);
    const state = await observeState(h, { targetApp: 'Editor' });
    const session = await begin(h, { targetApp: 'Editor', expectedStateId: state.state_id,
      actionIntent: { action: 'key', category: 'none', summary: '' } });
    await assert.rejects(h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'Tab', expectedStateId: state.state_id, [COMPUTER_USE_TOKEN_ARG]: session.token,
    }), (error) => error.message.includes(`interface changed after observation (${reason})`)
      && !error.message.includes('PRIVATE_TITLE'));
    assert.equal(dispatched, false, reason);
  }
});

test('Windows WindowGraph rejects an unclassified owned popup before input', async () => {
  let snapshotSequence = 0;
  let keyboardDispatched = false;
  const identity = {
    app_name: 'WINWORD',
    bundle_id: 'winword.exe',
    app_id: 'winword.exe',
    process_id: 100,
    window_id: 'hwnd:0x100',
  };
  const graphNode = {
    window_id: 'hwnd:0x100',
    owner_window_id: null,
    app_id: 'winword.exe',
    app_name: 'WINWORD',
    process_id: 100,
    title: 'Document1',
    bounds: [0, 0, 1200, 800],
    minimized: false,
    z_index: 1,
    relation: 'exact',
    foreground: true,
  };
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-window-graph',
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') return identity;
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'activate_window') return identity;
      if (cmd === 'ax_snapshot') {
        snapshotSequence += 1;
        const nodes = snapshotSequence === 1
          ? [graphNode]
          : [{
              ...graphNode,
              foreground: false,
              z_index: 2,
            }, {
              ...graphNode,
              window_id: 'hwnd:0x200',
              owner_window_id: 'hwnd:0x100',
              title: 'Compatibility notice',
              bounds: [300, 200, 500, 300],
              z_index: 1,
              relation: 'owned-popup',
              foreground: true,
            }];
        return {
          session_id: `ax-window-graph-${snapshotSequence}`,
          app: 'WINWORD',
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x100',
          accessibility_revision: snapshotSequence,
          modal: false,
          modal_window_id: null,
          window_graph: {
            target_window_id: 'hwnd:0x100',
            foreground_window_id: nodes.find((node) => node.foreground)?.window_id ?? null,
            nodes,
          },
        };
      }
      if (cmd === 'keyboard_press') keyboardDispatched = true;
      return { ok: true };
    },
  });
  h.setIdentity(identity);

  const state = await observeState(h, { targetApp: 'Word' });
  assert.equal(typeof state.window_graph_revision, 'string');
  const session = await begin(h, {
    targetApp: 'Word',
    expectedStateId: state.state_id,
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'Tab',
      expectedStateId: state.state_id,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /interface changed after observation/,
  );
  assert.equal(keyboardDispatched, false);
});

test('Windows WindowGraph ignores activation-only z-order changes before input', async () => {
  let snapshotSequence = 0;
  let pressed = false;
  const identity = {
    app_name: 'Editor', bundle_id: 'editor.exe', app_id: 'editor.exe',
    process_id: 100, window_id: 'hwnd:0x200',
  };
  const main = {
    window_id: 'hwnd:0x100', owner_window_id: null, app_id: 'editor.exe',
    app_name: 'Editor', process_id: 100, title: 'Document', bounds: [0, 0, 800, 600],
    minimized: false, z_index: 1, relation: 'same-app', foreground: false,
  };
  const dialog = {
    window_id: 'hwnd:0x200', owner_window_id: 'hwnd:0x100', app_id: 'editor.exe',
    app_name: 'Editor', process_id: 100, title: 'Dialog', bounds: [100, 100, 300, 200],
    minimized: false, z_index: 0, relation: 'exact', foreground: true,
  };
  const h = harness({
    platform: 'win32',
    inputLeaseIdFactory: () => 'lease-z-order',
    nativeDispatch: async (cmd) => {
      if (cmd === 'check_macos_permissions') return { screen_recording: true, accessibility: true };
      if (cmd === 'resolve_app_identity' || cmd === 'activate_window') return identity;
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_commit_observation') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'input_lease_activate') return { phase: 'running', input_epoch: 1 };
      if (cmd === 'input_lease_observe') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'ax_snapshot') {
        snapshotSequence += 1;
        const nodes = snapshotSequence === 1
          ? [main, dialog]
          : [{ ...dialog, z_index: 1, foreground: false }, { ...main, z_index: 0, foreground: true }];
        return {
          session_id: `ax-z-order-${snapshotSequence}`,
          app: 'Editor',
          elements: [{ id: 2, role: 'Button', label: 'Cancel dialog', actions: ['Invoke'] }],
          input_epoch: 1,
          window_id: 'hwnd:0x200',
          accessibility_revision: snapshotSequence,
          modal: true,
          modal_window_id: 'hwnd:0x200',
          window_graph: { target_window_id: 'hwnd:0x200', foreground_window_id: nodes.find((node) => node.foreground)?.window_id ?? null, nodes },
        };
      }
      if (cmd === 'ax_press') pressed = true;
      return { ok: true };
    },
  });
  h.setIdentity(identity);

  const state = await observeState(h, { targetApp: 'Editor' });
  const session = await begin(h, {
    windowRef: state.target.window_ref,
    expectedStateId: state.state_id,
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  await h.gate.dispatch(h.record, h.sender, 'ax_press', {
    sessionId: state.session_id,
    elementId: 2,
    expectedStateId: state.state_id,
    [COMPUTER_USE_TOKEN_ARG]: session.token,
  });
  assert.equal(pressed, true);
});

for (const scenario of ['owner', 'nested-owner', 'sibling', 'reused-owner', 'security-owner', 'stopped']) {
  test(`Windows same-session post-action observation follows only trusted live owners: ${scenario}`, async () => {
    let closed = false;
    let sequence = 0;
    let writes = 0;
    const snapshotTargets = [];
    const identity = {
      app_name: 'Editor', app_id: 'editor.exe', bundle_id: 'editor.exe',
      process_id: 100, window_id: 'dialog',
    };
    const node = (windowId, ownerId, title = 'Document') => ({
      window_id: windowId, owner_window_id: ownerId, app_id: 'editor.exe',
      app_name: 'Editor', process_id: 100, title, bounds: [0, 0, 800, 600],
      minimized: false, relation: windowId === 'dialog' ? 'exact' : 'owner',
    });
    const ownerId = scenario === 'nested-owner' ? 'intermediate' : 'document';
    const nodes = [
      node('dialog', scenario === 'sibling' ? null : ownerId),
      node('document', null),
      ...(scenario === 'nested-owner' ? [node('intermediate', 'document')] : []),
    ];
    const h = harness({
      platform: 'win32',
      nativeDispatch: async (cmd, args) => {
        if (cmd === 'check_macos_permissions') return { screen_recording: true, accessibility: true };
        if (cmd === 'resolve_app_identity' || cmd === 'activate_window') return identity;
        if (cmd.startsWith('input_lease_')) return { phase: cmd === 'input_lease_activate' ? 'running' : 'observing', input_epoch: 1 };
        if (cmd === 'get_window') {
          if (closed && ['dialog', 'intermediate'].includes(args.windowId)) throw new Error('window is not visible');
          if (scenario === 'stopped') {
            await h.gate.dispatch(h.record, h.sender, 'computer_use_stop_turn', {
              conversationId: 'conversation-1', loopId: 'loop-1', reason: 'user-stop',
            });
          }
          return {
            ...identity, window_id: args.windowId,
            process_id: scenario === 'reused-owner' ? 200 : 100,
            title: scenario === 'security-owner' ? 'Windows Security authentication' : 'Document',
          };
        }
        if (cmd === 'ax_snapshot') {
          snapshotTargets.push(args.expectedWindowId);
          assert.equal(args[COMPUTER_USE_REQUEST_CONTEXT_ARG].target.windowId, args.expectedWindowId);
          if (closed && args.expectedWindowId === 'dialog') throw new Error('window is not visible');
          return {
            session_id: `ax-owner-${++sequence}`, app: 'Editor', input_epoch: 1,
            window_id: args.expectedWindowId, accessibility_revision: sequence,
            modal: !closed, modal_window_id: closed ? null : 'dialog',
            elements: closed
              ? [{ id: 3, role: 'Document', label: 'Document body', actions: [] }]
              : [{ id: 2, role: 'Button', label: 'Cancel dialog', actions: ['Invoke'] }],
            window_graph: { target_window_id: args.expectedWindowId, nodes: closed ? [node('document', null)] : nodes },
          };
        }
        if (cmd === 'ax_press') { closed = true; writes += 1; }
        return { ok: true };
      },
    });
    h.setIdentity(identity);
    const before = await observeState(h, { targetApp: 'Editor' });
    const session = await begin(h, {
      windowRef: before.target.window_ref, expectedStateId: before.state_id,
      actionIntent: { action: 'click', category: 'none', summary: '' },
    });
    await h.gate.dispatch(h.record, h.sender, 'ax_press', {
      sessionId: before.session_id, elementId: 2, expectedStateId: before.state_id,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    });
    const observation = h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
      appName: 'Editor', [COMPUTER_USE_TOKEN_ARG]: session.token,
    });
    if (scenario === 'owner' || scenario === 'nested-owner') {
      const after = await observation;
      assert.equal(after.target.relation, 'replacement');
      assert.notEqual(after.target.window_ref, before.target.window_ref);
      assert.equal(after.verification_receipt.status, 'verified-change');
      assert.equal(after.elements[0].label, 'Document body');
      assert.equal(snapshotTargets.at(-1), 'document');
      await h.gate.dispatch(h.record, h.sender, 'computer_use_end_session', {
        [COMPUTER_USE_TOKEN_ARG]: session.token,
      });
      const nextSession = await begin(h, {
        windowRef: after.target.window_ref, expectedStateId: after.state_id,
        actionIntent: { action: 'get_window_state', category: 'none', summary: '' },
      });
      assert.equal(nextSession.target.window_ref, after.target.window_ref);
      const refreshed = await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
        appName: 'Editor', [COMPUTER_USE_TOKEN_ARG]: nextSession.token,
      });
      assert.equal(refreshed.target.window_ref, after.target.window_ref);
    } else if (scenario === 'security-owner') {
      const after = await observation;
      assert.equal(after.protocol_error.code, 'manual-handoff-required');
      assert.equal(snapshotTargets.includes('document'), false);
    } else {
      await assert.rejects(observation, /not visible|different|changed|authorization|active/i);
      assert.equal(snapshotTargets.includes('document'), false);
    }
    assert.equal(writes, 1);
    h.gate.teardown();
  });
}

test('Host issues a modal ref only for a trusted owned window', async () => {
  const h = harness({ platform: 'win32', selfProcessId: 999 });
  const rootNode = {
    window_id: 'root', owner_window_id: null, app_id: 'word.exe', app_name: 'Word',
    process_id: 42, title: 'Document', bounds: [0, 0, 800, 600], minimized: false,
    z_index: 1, relation: 'exact', foreground: false,
  };
  const dialogNode = {
    window_id: 'dialog', owner_window_id: 'root', app_id: 'word.exe', app_name: 'Word',
    process_id: 42, title: 'Dialog', bounds: [100, 100, 300, 200], minimized: false,
    z_index: 0, relation: 'owned-popup', foreground: true,
  };
  h.setIdentity({ app_name: 'Word', bundle_id: 'word.exe', process_id: 42, window_id: 'root' });
  h.setListedWindows([{
    app_name: 'Word', app_id: 'word.exe', process_id: 42, window_id: 'root',
  }]);
  h.setAxSnapshotExtra({
    window_id: 'root',
    window_graph: {
      target_window_id: 'root',
      foreground_window_id: 'dialog',
      nodes: [rootNode, dialogNode],
    },
    modal: true,
    modal_window_id: 'dialog',
  });

  const result = await observeState(h, { targetApp: 'Word' });

  assert.deepEqual(result.related_windows.map((item) => item.relation), ['modal']);
  assert.equal(result.related_windows[0].window_ref.startsWith('wr-'), true);
  assert.equal(result.window_graph, undefined);
  assert.equal(result.modal_window_id.startsWith('wr-'), true);

  const modalRef = result.related_windows[0].window_ref;
  h.setIdentity({ app_name: 'Word', bundle_id: 'word.exe', process_id: 42, window_id: 'dialog' });
  h.setAxSnapshotExtra({ window_id: 'dialog', modal: true, modal_window_id: 'dialog' });
  const modalSession = await begin(h, {
    windowRef: modalRef,
    actionIntent: { action: 'get_window_state', category: 'none', summary: '' },
  });
  assert.equal(modalSession.target.window_ref, modalRef);
  const modalState = await h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
    appName: 'Word', [COMPUTER_USE_TOKEN_ARG]: modalSession.token,
  });
  assert.equal(modalState.target.window_ref, modalRef);
});

test('Host does not issue writable refs for unrelated same-app siblings or security UI', async () => {
  const h = harness({ platform: 'win32', selfProcessId: 999 });
  h.setIdentity({ app_name: 'Word', bundle_id: 'word.exe', process_id: 42, window_id: 'root' });
  h.setListedWindows([{
    app_name: 'Word', app_id: 'word.exe', process_id: 42, window_id: 'root',
  }]);
  h.setAxSnapshotExtra({
    window_id: 'root',
    window_graph: {
      target_window_id: 'root',
      foreground_window_id: 'credential',
      nodes: [
        { window_id: 'root', owner_window_id: null, app_id: 'word.exe', app_name: 'Word', process_id: 42, title: 'Document', bounds: [0, 0, 800, 600], minimized: false, z_index: 1, relation: 'exact', foreground: false },
        { window_id: 'sibling', owner_window_id: null, app_id: 'word.exe', app_name: 'Word', process_id: 42, title: 'Other document', bounds: [0, 0, 800, 600], minimized: false, z_index: 2, relation: 'same-app', foreground: false },
        { window_id: 'credential', owner_window_id: null, app_id: 'credentialuibroker.exe', app_name: 'Credential UI', process_id: 77, title: 'Credential UI', bounds: [100, 100, 300, 200], minimized: false, z_index: 0, relation: 'same-app', foreground: true },
      ],
    },
  });

  const result = await observeState(h, { targetApp: 'Word' });

  assert.equal(result.related_windows.some((item) => item.app_name === 'Credential UI'), false);
  assert.equal(result.protocol_error.code, 'manual-handoff-required');
  assert.equal(result.protocol_error.next_action, 'wait-for-user');
  assert.equal(result.window_graph, undefined);
});

test('Host maps secure-desktop observation failure to manual-handoff without native input', async () => {
  const nativeCommands = [];
  const identity = {
    app_name: 'Word', bundle_id: 'word.exe', app_id: 'word.exe',
    process_id: 42, window_id: 'root',
  };
  const h = harness({
    platform: 'win32',
    selfProcessId: 999,
    nativeDispatch: async (cmd) => {
      nativeCommands.push(cmd);
      if (cmd === 'check_macos_permissions') {
        return { screen_recording: true, accessibility: true };
      }
      if (cmd === 'resolve_app_identity') return identity;
      if (cmd === 'input_lease_begin') return { phase: 'observing', input_epoch: 1 };
      if (cmd === 'ax_snapshot') throw new Error('Windows secure desktop is active');
      return { ok: true };
    },
  });
  h.setIdentity(identity);

  const result = await observeState(h, { targetApp: 'Word' });

  assert.equal(result.protocol_error.code, 'manual-handoff-required');
  assert.equal(result.protocol_error.next_action, 'wait-for-user');
  assert.deepEqual(result.related_windows, []);
  assert.equal(h.actionApprovalRequests.length, 0);
  assert.equal(nativeCommands.some((cmd) => cmd.startsWith('mouse_') || cmd.startsWith('keyboard_')), false);
});

test('native physical-input events revoke the active Windows task and stop the helper', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const session = await begin(h, {
    targetApp: 'notepad',
    actionIntent: { action: 'get_app_state', category: 'none', summary: '' },
  });

  const interruption = h.gate.handleNativeHelperEvent({
    type: 'user-input-detected',
    reason: 'physical-input',
  });
  assert.deepEqual(interruption, {
    type: 'user-input-detected',
    reason: 'physical-input',
    conversationId: 'conversation-1',
    loopId: 'loop-1',
  });
  assert.equal(h.helperKillCount, 1);
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'ax_snapshot', {
      appName: 'notepad',
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /authorization token is invalid or expired/,
  );
  assert.equal(h.gate.handleNativeHelperEvent({ type: 'user-input-detected' }), null);
});

test('a stopped turn cannot resume after task cleanup or helper restart but a new turn can', async () => {
  const turnStopStore = createComputerUseTurnStopStore();
  const h = harness({ turnStopStore });
  const session = await begin(h);

  const stopped = await h.gate.dispatch(h.record, h.sender, 'computer_use_stop_turn', {
    conversationId: 'conversation-1',
    loopId: 'loop-1',
    reason: 'overlay-stop-button',
  });
  assert.deepEqual(stopped, {
    stopped: true,
    reason: 'overlay-stop-button',
    persisted: true,
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /invalid or expired/,
  );

  h.restartHelper();
  await assert.rejects(
    begin(h, { toolCallId: 'same-turn-retry' }),
    /turn is stopped \(overlay-stop-button\)/,
  );

  await begin(h, { loopId: 'loop-2', toolCallId: 'new-turn' });
});

test('Windows AUMID policy hard-denies Settings, Terminal, Windows Security, and Abu', () => {
  const h = harness({ platform: 'win32' });
  for (const bundle_id of [
    'aumid:windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel',
    'aumid:microsoft.windowsterminal_8wekyb3d8bbwe!app',
    'aumid:microsoft.windows.sechealthui_cw5n1h2txyewy!sechealthui',
    'aumid:abu.desktop!app',
  ]) {
    assert.equal(h.gate.classifyIdentity({
      app_name: 'sensitive',
      bundle_id,
      process_id: 10,
    }), 'hard-deny');
  }
});

test('Windows approval-required policy tracks vendor process-name drift', () => {
  // WeChat 4.x runs as Weixin.exe (WeChatAppEx.exe hosts mini programs and
  // articles), Feishu ships as Feishu.exe, and the new Outlook is the packaged
  // olk.exe. All must classify as approval-required by their stable
  // executable identity, alongside the legacy names they replaced.
  const h = harness({ platform: 'win32' });
  const cases = [
    ['Weixin', 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'],
    ['Weixin', 'C:\\Users\\me\\AppData\\Roaming\\Tencent\\xwechat\\Weixin.exe'],
    ['WeChatAppEx', 'C:\\Users\\me\\AppData\\Roaming\\Tencent\\WeChat\\XPlugin\\Plugins\\RadiumWMPF\\14315\\extracted\\runtime\\WeChatAppEx.exe'],
    ['WeChat', 'D:\\Normal Software\\WeChat\\WeChat.exe'],
    ['Feishu', 'D:\\Normal Software\\Feishu\\7.76.7\\Feishu.exe'],
    ['DingTalk', 'D:\\Normal Software\\DingDing\\main\\current\\DingTalk.exe'],
  ];
  // An unlisted app also falls through to approval-required, so classification
  // alone cannot prove the entry exists; assert policy membership explicitly.
  const approvalRequired = policy.windows.approvalRequired;
  for (const [app_name, executable_path] of cases) {
    const stem = app_name.toLowerCase();
    assert.ok(approvalRequired.includes(stem), `${stem} listed`);
    assert.ok(approvalRequired.includes(`${stem}.exe`), `${stem}.exe listed`);
    assert.equal(h.gate.classifyIdentity({
      app_name,
      bundle_id: executable_path,
      app_id: executable_path,
      executable_path,
      process_id: 20,
      signature_status: 'valid',
      signer_subject: 'Vendor Publisher',
    }), 'approval-required', executable_path);
  }
  assert.ok(approvalRequired.includes('olk') && approvalRequired.includes('olk.exe'));
  // Packaged new Outlook: the AUMID is the app identity, the executable name
  // is the stable key the policy matches on.
  assert.equal(h.gate.classifyIdentity({
    app_name: 'Outlook',
    bundle_id: 'aumid:microsoft.outlookforwindows_8wekyb3d8bbwe!microsoft.outlookforwindows',
    app_id: 'aumid:microsoft.outlookforwindows_8wekyb3d8bbwe!microsoft.outlookforwindows',
    executable_path: 'C:\\Program Files\\WindowsApps\\Microsoft.OutlookForWindows_1.2024.327.300_x64__8wekyb3d8bbwe\\olk.exe',
    process_id: 21,
    signature_status: 'package-trusted',
    package_full_name: 'Microsoft.OutlookForWindows_1.2024.327.300_x64__8wekyb3d8bbwe',
  }), 'approval-required');
});

test('Windows ordinary allowlist requires a valid Authenticode identity', () => {
  const h = harness({ platform: 'win32' });
  const base = {
    app_name: 'notepad',
    bundle_id: 'C:\\Windows\\System32\\notepad.exe',
    executable_path: 'C:\\Windows\\System32\\notepad.exe',
    process_id: 10,
  };
  assert.equal(h.gate.classifyIdentity({
    ...base,
    signature_status: 'valid',
    signer_subject: 'Microsoft Windows',
  }), 'ordinary');
  assert.equal(h.gate.classifyIdentity({
    ...base,
    signature_status: 'untrusted',
  }), 'approval-required');
  assert.equal(h.gate.classifyIdentity({
    ...base,
    signature_status: 'valid',
    signer_subject: 'Unrelated Publisher LLC',
  }), 'approval-required');
  assert.equal(h.gate.classifyIdentity(base), 'approval-required');
  assert.equal(h.gate.classifyIdentity({
    app_name: 'CalculatorApp',
    bundle_id: 'aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app',
    app_id: 'aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app',
    executable_path: 'C:\\Program Files\\WindowsApps\\CalculatorApp.exe',
    process_id: 11,
    signature_status: 'package-trusted',
    package_full_name: 'Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe',
  }), 'ordinary');
  assert.equal(h.gate.classifyIdentity({
    app_name: 'CalculatorApp',
    bundle_id: 'aumid:attacker.fakecalculator_123!app',
    app_id: 'aumid:attacker.fakecalculator_123!app',
    executable_path: 'C:\\Program Files\\WindowsApps\\CalculatorApp.exe',
    process_id: 12,
    signature_status: 'package-trusted',
    package_full_name: 'Attacker.FakeCalculator_1.0_x64__123',
  }), 'approval-required');
});

test('Windows browser writes fail closed when the trusted host cannot verify origin', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'msedge',
    bundle_id: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process_id: 700,
  });
  await assert.rejects(
    begin(h, {
      targetApp: 'msedge',
      permissionMode: 'autonomous',
      actionIntent: { action: 'click', category: 'none', summary: '' },
    }),
    /current origin cannot be verified/,
  );
});

test('Windows browser origin accepts one native Chromium omnibox and rejects web-content lookalikes', () => {
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'OmniboxViewViews',
      automation_id: 'view_1012',
      value: 'https://Example.COM:443/path?secret=not-retained',
    }],
  }), 'https://example.com');
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'OmniboxViewViews',
      automation_id: 'view_1012',
      value: 'example.com',
    }, {
      role: 'Button',
      class_name: 'LocationIconView',
      automation_id: 'view_1011',
      label: '查看网站信息',
    }],
  }), 'https://example.com');
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'OmniboxViewViews',
      automation_id: 'view_1012',
      value: 'Example.COM/private/path?secret=not-retained',
    }, {
      role: 'Button',
      class_name: 'LocationIconView',
      automation_id: 'view_1011',
      label: 'View site information',
    }],
  }), 'https://example.com');
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'OmniboxViewViews',
      automation_id: 'view_1012',
      value: 'plain-http.example/private',
    }, {
      role: 'Button',
      class_name: 'LocationIconView',
      automation_id: 'view_1011',
      label: 'Not secure',
    }],
  }), null);
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'HTMLInputElement',
      automation_id: 'view_1012',
      value: 'https://attacker.example/',
      label: 'Address and search bar',
    }],
  }), null);
  assert.equal(resolveBrowserOriginFromSnapshot({
    elements: [{
      role: 'TextField',
      class_name: 'OmniboxViewViews',
      automation_id: 'view_1012',
      value: 'file:///C:/private.txt',
    }],
  }), null);
});

test('Windows browser writes require an exact task-local origin approval', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'msedge',
    bundle_id: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process_id: 700,
  });
  h.setAxElements([{
    id: 1,
    role: 'TextField',
    class_name: 'OmniboxViewViews',
    automation_id: 'view_1012',
    value: 'https://example.com/private/path?token=redacted-at-boundary',
    bounds: [100, 20, 800, 40],
    patterns: ['Value'],
    actions: ['SetValue'],
    depth: 4,
  }]);
  const session = await begin(h, {
    targetApp: 'msedge',
    permissionMode: 'autonomous',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  assert.equal(session.classification, 'approval-required');
  assert.equal(h.browserSiteApprovalRequests.length, 1);
  assert.equal(h.browserSiteApprovalRequests[0].origin, 'https://example.com');
  assert.equal(JSON.stringify(h.browserSiteApprovalRequests).includes('/private/path'), false);

  await begin(h, {
    targetApp: 'msedge',
    toolCallId: 'same-origin-second-action',
    permissionMode: 'autonomous',
    expectedStateId: 'state-1',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  assert.equal(h.browserSiteApprovalRequests.length, 1);
});

test('Windows browser origin is re-read immediately before native input', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({
    app_name: 'msedge',
    bundle_id: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process_id: 700,
  });
  h.setAxElements([{
    id: 1,
    role: 'TextField',
    class_name: 'OmniboxViewViews',
    automation_id: 'view_1012',
    value: 'https://example.com/start',
  }]);
  const session = await begin(h, {
    targetApp: 'msedge',
    permissionMode: 'autonomous',
    actionIntent: { action: 'click', category: 'none', summary: '' },
  });
  h.setAxElements([{
    id: 1,
    role: 'TextField',
    class_name: 'OmniboxViewViews',
    automation_id: 'view_1012',
    value: 'https://other.example/automatic-redirect',
  }]);
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_click', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /origin changed after observation/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'mouse_click'), false);
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'ax_close_session'), true);
});

test('Host Gate blocks Windows shell and security shortcuts before native input', async () => {
  const h = harness({ platform: 'win32' });
  h.setIdentity({ app_name: 'notepad', bundle_id: 'notepad.exe', process_id: 500 });
  const session = await begin(h, {
    targetApp: 'notepad',
    permissionMode: 'autonomous',
    actionIntent: { action: 'key', category: 'none', summary: '' },
  });
  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'keyboard_press', {
      key: 'r',
      modifiers: ['win'],
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /blocked dangerous system shortcut/,
  );
  assert.equal(h.nativeCalls.some(({ cmd }) => cmd === 'keyboard_press'), false);
});

function helperError(message, helper) {
  return Object.assign(new Error(message), { helper: Object.freeze(helper) });
}

test('a helper refusal before dispatch releases the attempt instead of blocking replay', async () => {
  const h = harness();
  const snapshot = await observeState(h);
  const session = await begin(h, {
    expectedStateId: snapshot.state_id,
    actionIntent: { action: 'move', category: 'none', summary: '' },
  });
  h.failNativeCommand('mouse_move', helperError('frontmost target changed; observe again', {
    code: 'target-changed',
    execution: 'not-executed',
    retryable: true,
  }));

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_move', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /frontmost target changed/,
  );
  const status = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_get_task_status',
    { conversationId: 'conversation-1', loopId: 'loop-1' },
  );
  assert.equal(status.outcome_unknown_receipt, null);
  assert.equal(status.stopped, false);
  assert.deepEqual(status.not_executed_receipt, {
    status: 'not-executed',
    execution: 'not-executed',
    helper_code: 'target-changed',
    retryable: true,
    command: 'mouse_move',
    before_state_id: snapshot.state_id,
    attempt_count: 1,
    consequential: false,
    decision: 'observe-required',
  });

  // The world may have moved, so the next action still needs a fresh
  // observation — but that observation has nothing to verify and the run
  // is not stopped.
  h.failNativeCommand(null);
  const fresh = await observeState(h, { toolCallId: 'tool-after-refusal' });
  assert.equal(fresh.verification_receipt, undefined);
  const next = await begin(h, { toolCallId: 'tool-retry', expectedStateId: fresh.state_id });
  await h.gate.dispatch(h.record, h.sender, 'mouse_move', {
    x: 2,
    y: 2,
    [COMPUTER_USE_TOKEN_ARG]: next.token,
  });
  const after = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_get_task_status',
    { conversationId: 'conversation-1', loopId: 'loop-1' },
  );
  assert.equal(after.not_executed_receipt, null);
  assert.equal(h.nativeCalls.filter(({ cmd }) => cmd === 'mouse_move').length, 2);
});

test('a structured outcome-unknown helper error still blocks replay and stamps the receipt', async () => {
  const h = harness();
  const snapshot = await observeState(h);
  const session = await begin(h, {
    expectedStateId: snapshot.state_id,
    actionIntent: { action: 'move', category: 'none', summary: '' },
  });
  h.failNativeCommand('mouse_move', helperError('SendInput was blocked after 1/3 events', {
    code: 'send-input-failed',
    execution: 'outcome-unknown',
    retryable: false,
  }));

  await assert.rejects(
    h.gate.dispatch(h.record, h.sender, 'mouse_move', {
      x: 1,
      y: 1,
      [COMPUTER_USE_TOKEN_ARG]: session.token,
    }),
    /outcome is unknown after 'mouse_move'/,
  );
  const status = await h.gate.dispatch(
    h.record,
    h.sender,
    'computer_use_get_task_status',
    { conversationId: 'conversation-1', loopId: 'loop-1' },
  );
  assert.equal(status.not_executed_receipt, null);
  assert.equal(status.outcome_unknown_receipt.execution, 'outcome-unknown');
  assert.equal(status.outcome_unknown_receipt.helper_code, 'send-input-failed');
  assert.equal(status.outcome_unknown_receipt.status, 'outcome-unknown');
});

test('classifyHelperFailure trusts a structured verdict and falls back by command kind', () => {
  const structured = classifyHelperFailure('stateful', helperError('m', {
    code: 'screenshot-stale', execution: 'not-executed', retryable: true,
  }));
  assert.deepEqual(structured, { code: 'screenshot-stale', execution: 'not-executed', retryable: true });

  // retryable is never inferred.
  assert.equal(classifyHelperFailure('stateful', helperError('m', {
    code: 'screenshot-stale', execution: 'not-executed', retryable: 'yes',
  })).retryable, false);

  // Unstructured: the kind decides, always pessimistic for stateful commands.
  assert.deepEqual(classifyHelperFailure('stateful', new Error('boom')),
    { code: 'legacy', execution: 'outcome-unknown', retryable: false });
  assert.deepEqual(classifyHelperFailure('observation', new Error('boom')),
    { code: 'legacy', execution: 'not-executed', retryable: false });
  assert.deepEqual(classifyHelperFailure('stateful', helperError('m', {
    code: 'legacy', execution: 'outcome-unknown', retryable: false,
  })), { code: 'legacy', execution: 'outcome-unknown', retryable: false });
  // A structured object with an unknown verdict is not trusted either.
  assert.equal(classifyHelperFailure('stateful', helperError('m', {
    code: 'target-changed', execution: 'maybe', retryable: true,
  })).execution, 'outcome-unknown');
  // Even an explicit "internal" verdict is the helper's own word.
  assert.equal(classifyHelperFailure('stateful', helperError('m', {
    code: 'internal', execution: 'not-executed', retryable: false,
  })).execution, 'not-executed');
});

test('classifyInputRejection reads the helper code before any message', () => {
  assert.equal(classifyInputRejection(helperError('nothing recognisable here', {
    code: 'secure-desktop', execution: 'not-executed', retryable: false,
  })), 'secure-desktop');
  assert.equal(classifyInputRejection(helperError('frontmost target changed', {
    code: 'target-changed', execution: 'not-executed', retryable: true,
  })), 'window-invalidated');
  assert.equal(classifyInputRejection(helperError('screenshot_id belongs elsewhere', {
    code: 'internal', execution: 'not-executed', retryable: false,
  })), 'native-rejected');
  // Only a legacy (string) error may still be classified from its text.
  assert.equal(classifyInputRejection(helperError('input is blocked on secure desktop', {
    code: 'legacy', execution: 'outcome-unknown', retryable: false,
  })), 'secure-desktop');
  assert.equal(classifyInputRejection(new Error('physical user input occurred')), 'physical-input');
});
