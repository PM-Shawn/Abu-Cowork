'use strict';

const crypto = require('node:crypto');
const { runtimeState } = require('./runtimeObservability.cjs');
const { createTrajectoryRecorder } = require('./computerUseTrajectory.cjs');
const { createComputerUseWindowRegistry } = require('./computerUseWindowRegistry.cjs');
const policy = require('../src/core/tools/computerUsePolicy.json');
const {
  COMPUTER_USE_TOKEN_ARG,
  COMPUTER_USE_REQUEST_CONTEXT_ARG,
  COMPUTER_USE_PROBE_COMMANDS,
  COMPUTER_USE_CLEANUP_COMMANDS,
  COMPUTER_USE_READ_COMMANDS,
  COMPUTER_USE_CONTROL_COMMANDS,
  COMPUTER_USE_PRIVILEGED_COMMANDS,
  COMPUTER_USE_HOST_COMMANDS,
} = require('./computerUseCommands.cjs');
const {
  normalizeActionIntent,
  resolveConsequence,
  sanitizeAxElements,
} = require('./computerUseActionPolicy.cjs');

const COMPUTER_USE_GATE_MISS = Symbol('computer-use-gate-miss');
const SESSION_TTL_MS = 2 * 60 * 1000;
const TASK_GRANT_TTL_MS = 30 * 60 * 1000;
const COMPUTER_STATE_TTL_MS = 30 * 1000;
/**
 * The Computer Use safety budget, enforced HERE rather than in the renderer.
 *
 * These caps existed only in `src/core/agent/computerUseStatus.ts`, whose
 * `setComputerUseActive(true, …)` runs at the top of EVERY computer batch and
 * unconditionally reset `stepCount` to 0 and `sessionStartTime` to now. A
 * task that spans several batches — the normal shape of any non-trivial CU
 * run — therefore restarted its budget on each batch and could never reach
 * either cap. The renderer also cannot be the place this is decided: it is
 * the process the budget exists to restrain.
 *
 * The budget rides on the task lease (`taskKey` = conversationId + loopId),
 * which already survives across batches, and the deadline is fixed when the
 * lease is first taken — re-entry reuses it, never extends it. Values match
 * the renderer's former MAX_CU_STEPS / MAX_CU_DURATION_MS so the cap the
 * product promised is the cap that now actually holds.
 */
const MAX_TASK_CU_STEPS = 30;
const MAX_TASK_CU_DURATION_MS = 5 * 60 * 1000;
/**
 * No-progress thresholds live in `computerUsePolicy.json` because the SAME
 * decision is made twice: here, and again in the renderer's
 * `computerUseController.assessProgress`. They used to be hardcoded 3 and 2 in
 * both places and stayed equal only because nobody had changed one of them yet.
 * `computerUseProgressPolicy.contract.test.ts` replays one fixture corpus
 * through both implementations so a divergence fails a test instead of shipping.
 */
const NO_PROGRESS_BEFORE_RECOVERY = policy.progressPolicy.noProgressBeforeRecovery;
const NO_PROGRESS_AFTER_RECOVERY = policy.progressPolicy.noProgressAfterRecovery;
const VALID_SCOPES = new Set(['screen-read', 'ui-control']);
const VALID_PERMISSION_MODES = new Set(['standard', 'smart', 'autonomous']);
const STATEFUL_ACTIONS = new Set([
  'click',
  'move',
  'type',
  'perform_action',
  'scroll',
  'drag',
  'key',
  'ax_click',
  'ax_type',
]);
const SCREEN_READ_TARGET = Object.freeze({
  app_name: 'Screen',
  bundle_id: 'abu.screen',
  process_id: null,
});

function normalizeIdentity(raw) {
  const appName = typeof raw?.app_name === 'string' ? raw.app_name.trim() : '';
  const bundleId = typeof raw?.bundle_id === 'string' ? raw.bundle_id.trim() : '';
  const processId = Number.isInteger(raw?.process_id) ? raw.process_id : null;
  if (!appName || !bundleId) {
    throw new Error('Computer Use target identity is unavailable');
  }
  return {
    app_name: appName,
    bundle_id: bundleId,
    process_id: processId,
    ...(typeof raw?.app_id === 'string' && raw.app_id.trim()
      ? { app_id: raw.app_id.trim() }
      : {}),
    ...(typeof raw?.executable_path === 'string' && raw.executable_path.trim()
      ? { executable_path: raw.executable_path.trim() }
      : {}),
    ...(typeof raw?.window_id === 'string' && raw.window_id.trim()
      ? { window_id: raw.window_id.trim() }
      : {}),
    ...(typeof raw?.title === 'string' && raw.title.trim()
      ? { title: raw.title.trim() }
      : {}),
    ...(typeof raw?.signature_status === 'string' && raw.signature_status.trim()
      ? { signature_status: raw.signature_status.trim().toLowerCase() }
      : {}),
    ...(typeof raw?.signer_subject === 'string' && raw.signer_subject.trim()
      ? { signer_subject: raw.signer_subject.trim() }
      : {}),
    ...(typeof raw?.package_full_name === 'string' && raw.package_full_name.trim()
      ? { package_full_name: raw.package_full_name.trim() }
      : {}),
  };
}

function policyForPlatform(platform) {
  return platform === 'win32' ? policy.windows : policy.macos;
}

function classifyIdentity(platform, identity) {
  const platformPolicy = policyForPlatform(platform);
  const keys = platform === 'win32'
    ? (() => {
        const values = [identity.bundle_id, identity.app_id, identity.executable_path]
          .filter((value) => typeof value === 'string' && value)
          .map((value) => value.toLowerCase());
        const keys = new Set();
        for (const full of values) {
          const fileName = full.split(/[\\/]/).at(-1) || full;
          const stem = fileName.endsWith('.exe') ? fileName.slice(0, -4) : fileName;
          keys.add(full);
          keys.add(fileName);
          keys.add(stem);
        }
        return keys;
      })()
    : new Set([identity.bundle_id]);
  if (platformPolicy.hardDeny.some((value) => (
    keys.has(platform === 'win32' ? value.toLowerCase() : value)
  ))) {
    return 'hard-deny';
  }
  if (
    platform === 'win32'
    && (platformPolicy.hardDenyPrefixes || []).some((prefix) => (
      [...keys].some((key) => key.startsWith(prefix.toLowerCase()))
    ))
  ) {
    return 'hard-deny';
  }
  if (platformPolicy.approvalRequired.some((value) => (
    keys.has(platform === 'win32' ? value.toLowerCase() : value)
  ))) {
    return 'approval-required';
  }
  if (platformPolicy.ordinaryAllow.some((value) => (
    keys.has(platform === 'win32' ? value.toLowerCase() : value)
  ))) {
    // A renamed unsigned binary must not inherit a low-risk identity simply
    // by calling itself notepad.exe/explorer.exe. Protocol v2 supplies the
    // native WinVerifyTrust result; absent or invalid trust is fail-closed to
    // explicit app approval rather than silently treated as ordinary.
    if (platform === 'win32') {
      const signer = String(identity.signer_subject || '').toLowerCase();
      const trustedSigner = (platformPolicy.ordinarySignerSubjects || [])
        .some((value) => signer === value.toLowerCase());
      const appId = String(identity.app_id || identity.bundle_id || '').toLowerCase();
      const trustedPackage = identity.signature_status === 'package-trusted'
        && typeof identity.package_full_name === 'string'
        && (platformPolicy.ordinaryPackagePrefixes || [])
          .some((value) => appId.startsWith(value.toLowerCase()));
      if (!(
        (identity.signature_status === 'valid' && trustedSigner)
        || trustedPackage
      )) {
        return 'approval-required';
      }
    }
    return 'ordinary';
  }
  // An installed app can expose credentials, a shell, or consequential
  // actions even when Abu has never seen its identity before. Unknown apps
  // therefore require a task-local user decision in every autonomy mode.
  return 'approval-required';
}

function isBrowserIdentity(platform, identity) {
  if (platform !== 'win32') return false;
  const values = [identity.bundle_id, identity.app_id, identity.executable_path]
    .filter((value) => typeof value === 'string' && value)
    .map((value) => value.toLowerCase());
  const keys = new Set();
  for (const full of values) {
    const fileName = full.split(/[\\/]/).at(-1) || full;
    keys.add(full);
    keys.add(fileName);
    keys.add(fileName.endsWith('.exe') ? fileName.slice(0, -4) : fileName);
  }
  return (policy.windows.browser || []).some((value) => keys.has(value.toLowerCase()));
}

function normalizeHttpOrigin(value) {
  if (typeof value !== 'string' || value.length > 8_192) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve a Chromium origin only from the browser's native Omnibox UIA
 * provider. Web content can choose an accessible label, but it cannot choose
 * Chromium's native OmniboxViewViews class + view_<number> automation id.
 * Ambiguity, elided/non-HTTP values, Firefox, and unknown providers fail
 * closed. The raw URL is used transiently and never retained; only its origin
 * is stored in the task-local authorization record.
 */
function resolveBrowserOriginFromSnapshot(result) {
  if (!Array.isArray(result?.elements)) return null;
  const candidates = [];
  for (const element of result.elements) {
    if (element?.role !== 'TextField') continue;
    if (String(element.class_name || '').toLowerCase() !== 'omniboxviewviews') continue;
    if (!/^view_\d+$/i.test(String(element.automation_id || ''))) continue;
    let origin = normalizeHttpOrigin(element.value);
    if (!origin && typeof element.value === 'string' && !element.value.includes('://')) {
      // Chromium deliberately elides https:// from a steady-state address bar,
      // including from ValuePattern. Infer HTTPS only when the same native
      // browser chrome contains exactly one trusted LocationIconView whose
      // browser-owned accessible name represents the normal site-info state.
      // Insecure HTTP and certificate-error states deliberately remain blocked:
      // their shared "Not secure" label cannot distinguish the real scheme.
      const securityIcons = result.elements.filter((candidate) => (
        candidate?.role === 'Button'
        && String(candidate.class_name || '').toLowerCase() === 'locationiconview'
        && /^view_\d+$/i.test(String(candidate.automation_id || ''))
      ));
      const securityLabel = securityIcons.length === 1
        ? String(securityIcons[0].label || '').trim().toLowerCase()
        : '';
      const confirmsSecureSite = new Set([
        'view site information',
        '查看站点信息',
        '查看网站信息',
      ]).has(securityLabel);
      if (confirmsSecureSite) {
        origin = normalizeHttpOrigin(`https://${element.value.trim()}`);
      }
    }
    if (origin) candidates.push(origin);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function classifyInputRejection(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('physical user input') || message.includes('input epoch')) return 'physical-input';
  if (message.includes('secure desktop') || message.includes('desktop is locked')) return 'secure-desktop';
  if (message.includes('integrity level') || message.includes('higher-integrity')) return 'higher-integrity';
  if (message.includes('occlud') || message.includes('windowfrompoint')) return 'occluded';
  if (message.includes('screenshot_id')) return 'screenshot-invalidated';
  if (message.includes('runtime id') || message.includes('element')) return 'element-invalidated';
  if (message.includes('window') || message.includes('target changed')) return 'window-invalidated';
  if (message.includes('state_id') || message.includes('observation')) return 'state-invalidated';
  return 'native-rejected';
}

function assertSafeKeyboardCommand(platform, cmd, args) {
  if (cmd !== 'keyboard_press') return;
  const aliases = new Map([
    ['control', 'ctrl'],
    ['cmd', 'meta'],
    ['command', 'meta'],
    ['super', 'meta'],
    ['win', 'meta'],
    ['option', 'alt'],
  ]);
  const modifiers = Array.isArray(args?.modifiers)
    ? args.modifiers.map((value) => {
        const lower = String(value).toLowerCase();
        return aliases.get(lower) || lower;
      }).sort()
    : [];
  const key = typeof args?.key === 'string' ? args.key.toLowerCase() : '';
  const combo = [...modifiers, key].join('+');
  const blocked = platform === 'win32'
    ? new Set([
        'alt+f4',
        'alt+tab',
        'alt+ctrl+delete',
        'ctrl+shift+escape',
        'meta+i',
        'meta+l',
        'meta+r',
        'meta+x',
      ])
    : new Set([
        'meta+q',
        'meta+shift+q',
        'alt+meta+escape',
        'meta+tab',
        'ctrl+meta+q',
        'meta+shift+delete',
      ]);
  if (blocked.has(combo)) {
    throw new Error(`Computer Use blocked dangerous system shortcut "${combo}"`);
  }
}

/**
 * The no-progress half of an action decision.
 *
 * Pure and exported so `computerUseProgressPolicy.contract.test.ts` can replay
 * one fixture corpus through both this and the renderer's
 * `computerUseController.assessProgress`. Both tiers judge the same actions
 * independently — the Host because it is the boundary the budget exists to
 * restrain, the renderer because it is the side holding the model's
 * `expected_effect` — so the only thing that can keep them equal is a replay,
 * not a comment saying they match.
 *
 * `state` is read, never mutated; the caller applies the returned counters.
 */
function decideNoProgress(state, changed) {
  if (changed) {
    return { decision: 'continue', consecutiveNoChange: 0, recoveryUsed: state.recoveryUsed };
  }
  const consecutiveNoChange = state.consecutiveNoChange + 1;
  const threshold = state.recoveryUsed
    ? NO_PROGRESS_AFTER_RECOVERY
    : NO_PROGRESS_BEFORE_RECOVERY;
  if (consecutiveNoChange < threshold) {
    return { decision: 'continue', consecutiveNoChange, recoveryUsed: state.recoveryUsed };
  }
  if (!state.recoveryUsed) {
    return { decision: 'recover', consecutiveNoChange: 0, recoveryUsed: true };
  }
  return { decision: 'stop-no-progress', consecutiveNoChange, recoveryUsed: true };
}

function assertMainRecord(record) {
  if (!record || record.label !== 'main') {
    throw new Error('Computer Use is only available to the main window');
  }
}

function assertShortId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a short non-empty string`);
  }
}

function stripToken(args) {
  const clean = { ...(args || {}) };
  delete clean[COMPUTER_USE_TOKEN_ARG];
  return clean;
}

function createComputerUseGate(options) {
  const {
    nativeDispatch,
    getActiveWindow,
    getNativeHelperGeneration = () => 0,
    killNativeHelper = () => {},
    requestAppApproval = async () => false,
    requestTaskApproval = async () => false,
    requestActionApproval = async () => false,
    requestBrowserSiteApproval = async () => false,
    observability = runtimeState,
    platform = process.platform,
    selfProcessId = null,
    now = () => Date.now(),
    tokenFactory = () => crypto.randomBytes(32).toString('base64url'),
    stateIdFactory = () => `cu-${crypto.randomBytes(18).toString('base64url')}`,
    inputLeaseIdFactory = () => `lease-${crypto.randomBytes(18).toString('base64url')}`,
    turnStopStore = null,
  } = options;
  const enabledSenders = new WeakSet();
  const sessions = new Map();
  const axSessions = new Map();
  const computerStates = new Map();
  const taskAttemptLedgers = new Map();
  const taskGrants = new Map();
  const taskLeases = new Map();
  const turnTargetSnapshots = new Map();
  const windowRegistry = createComputerUseWindowRegistry({
    getHelperGeneration: getNativeHelperGeneration,
  });
  const trajectoryRecorder = createTrajectoryRecorder({
    emit: (attributes) => observability.noteComputerUseTrajectory?.(attributes),
  });
  // Task budgets count active execution time. Human review inside a native
  // approval dialog is deliberately paused: reading for 5 seconds or 5
  // minutes must not change the authorization outcome.
  const taskBudgets = new Map();
  let activeTask = null;

  function isSelfIdentity(identity) {
    return Number.isInteger(selfProcessId)
      && Number.isInteger(identity?.process_id)
      && identity.process_id === selfProcessId;
  }

  function identityClassification(identity) {
    return isSelfIdentity(identity)
      ? 'hard-deny'
      : classifyIdentity(platform, identity);
  }

  function revokeSender(sender) {
    let revoked = false;
    revoked = enabledSenders.delete(sender) || revoked;
    for (const [token, session] of sessions) {
      if (session.sender === sender) {
        sessions.delete(token);
        revoked = true;
      }
    }
    for (const [sessionId, record] of axSessions) {
      if (record.sender === sender) {
        axSessions.delete(sessionId);
        revoked = true;
      }
    }
    for (const [key, state] of computerStates) {
      if (state.sender === sender) {
        computerStates.delete(key);
        revoked = true;
      }
    }
    for (const [key, ledger] of taskAttemptLedgers) {
      if (ledger.sender === sender) {
        taskAttemptLedgers.delete(key);
        revoked = true;
      }
    }
    for (const [key, grant] of taskGrants) {
      if (grant.sender === sender) {
        taskGrants.delete(key);
        revoked = true;
      }
    }
    for (const [key, lease] of taskLeases) {
      if (lease.sender === sender) {
        taskLeases.delete(key);
        taskBudgets.delete(key);
        revoked = true;
      }
    }
    for (const [key, snapshot] of turnTargetSnapshots) {
      if (snapshot.sender === sender) {
        turnTargetSnapshots.delete(key);
        revoked = true;
      }
    }
    windowRegistry.revokeSender(sender);
    if (activeTask?.sender === sender) {
      taskBudgets.delete(activeTask.key);
      activeTask = null;
      revoked = true;
    }
    if (revoked) {
      killNativeHelper();
    }
  }

  function pruneExpired() {
    const current = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(token);
    }
    for (const [key, grant] of taskGrants) {
      if (grant.expiresAt <= current) taskGrants.delete(key);
    }
    for (const [key, lease] of taskLeases) {
      if (lease.expiresAt <= current) {
        taskLeases.delete(key);
        taskBudgets.delete(key);
        if (activeTask === lease.authorization) {
          activeTask = null;
          killNativeHelper();
        }
      }
    }
    for (const [key, state] of computerStates) {
      if (state.expiresAt <= current) computerStates.delete(key);
    }
    windowRegistry.prune();
  }

  function getTaskAttemptLedger(sender, key) {
    let ledger = taskAttemptLedgers.get(key);
    if (!ledger) {
      ledger = {
        key,
        sender,
        attemptCount: 0,
        consecutiveNoChange: 0,
        recoveryUsed: false,
        stoppedReason: null,
        pendingAttempt: null,
        outcomeUnknownReceipt: null,
      };
      taskAttemptLedgers.set(key, ledger);
    }
    if (ledger.sender !== sender) {
      throw new Error('Computer Use task attempt ledger belongs to another sender');
    }
    return ledger;
  }

  function hashAxElements(elements, modalWindowId = null) {
    const normalized = elements instanceof Map
      ? Array.from(elements.entries())
      : Array.isArray(elements)
        ? elements
        : [];
    return crypto.createHash('sha256')
      .update(JSON.stringify([modalWindowId, normalized]))
      .digest('hex');
  }

  function hashWindowGraph(graph) {
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
    const normalized = graph.nodes.map((node) => ({
      window_id: typeof node?.window_id === 'string' ? node.window_id.toLowerCase() : null,
      owner_window_id: typeof node?.owner_window_id === 'string'
        ? node.owner_window_id.toLowerCase()
        : null,
      app_id: typeof node?.app_id === 'string' ? node.app_id.toLowerCase() : null,
      process_id: Number.isSafeInteger(node?.process_id) ? node.process_id : null,
      bounds: Array.isArray(node?.bounds) ? node.bounds.slice(0, 4) : null,
      minimized: node?.minimized === true,
      relation: typeof node?.relation === 'string' ? node.relation : null,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    // Activation can reorder the same windows without changing the input
    // boundary. Physical takeover is checked separately through input_epoch;
    // retain identity, ownership, geometry and membership in this digest.
    return crypto.createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
  }

  function noteComputerUseTrajectory(key, stage, attributes = {}) {
    trajectoryRecorder.record(key, stage, attributes);
  }

  function assertTaskAttemptAllowed(sender, key) {
    const ledger = getTaskAttemptLedger(sender, key);
    if (ledger.stoppedReason) {
      throw new Error(`Computer Use run is stopped (${ledger.stoppedReason})`);
    }
    if (ledger.pendingAttempt) {
      throw new Error('Computer Use requires verification of the previous action before another write');
    }
    return ledger;
  }

  function assertObservationAllowed(sender, key) {
    const ledger = getTaskAttemptLedger(sender, key);
    if (ledger.pendingAttempt?.beforeStateId === null) {
      throw new Error('Computer Use action approval is still in progress');
    }
    const state = computerStates.get(key);
    if (state?.sender === sender && state.actionInFlight) {
      throw new Error('Computer Use native action is still in flight');
    }
  }

  function beginTaskAttempt(sender, session, cmd, state, consequential) {
    const ledger = assertTaskAttemptAllowed(sender, session.taskKey);
    const beforeFingerprint = state.axSessionId
      ? axSessions.get(state.axSessionId)?.fingerprint ?? hashAxElements([])
      : hashAxElements([]);
    ledger.attemptCount += 1;
    ledger.pendingAttempt = {
      attemptCount: ledger.attemptCount,
      command: cmd,
      beforeStateId: state.stateId,
      beforeFingerprint,
      consequential,
      outcomeUnknown: false,
    };
    ledger.outcomeUnknownReceipt = null;
    noteComputerUseTrajectory(session.taskKey, 'action-attempted', {
      command: cmd,
      attemptCount: ledger.attemptCount,
      consequential,
      stateId: state.stateId,
    });
    return ledger;
  }

  function failTaskAttempt(ledger) {
    if (!ledger?.pendingAttempt) return null;
    ledger.pendingAttempt.outcomeUnknown = true;
    if (ledger.pendingAttempt.consequential) {
      ledger.stoppedReason = 'stop-ambiguous-side-effect';
      markTurnStopped(ledger.key, 'outcome-unknown');
    }
    ledger.outcomeUnknownReceipt = Object.freeze({
      status: 'outcome-unknown',
      command: ledger.pendingAttempt.command,
      before_state_id: ledger.pendingAttempt.beforeStateId,
      attempt_count: ledger.pendingAttempt.attemptCount,
      consequential: ledger.pendingAttempt.consequential,
      decision: ledger.stoppedReason || 'observe-required',
    });
    noteComputerUseTrajectory(ledger.key, 'action-outcome', {
      command: ledger.pendingAttempt.command,
      attemptCount: ledger.pendingAttempt.attemptCount,
      consequential: ledger.pendingAttempt.consequential,
      outcome: 'outcome-unknown',
      outcomeUnknown: true,
      reason: ledger.outcomeUnknownReceipt.decision,
    });
    return ledger.outcomeUnknownReceipt;
  }

  function beginUnverifiedTaskAttempt(sender, session, cmd, consequential) {
    const ledger = assertTaskAttemptAllowed(sender, session.taskKey);
    ledger.pendingAttempt = {
      attemptCount: ledger.attemptCount,
      command: cmd,
      beforeStateId: null,
      beforeFingerprint: null,
      consequential,
    };
    return ledger;
  }

  function completeUnverifiedTaskAttempt(ledger) {
    if (ledger?.pendingAttempt) ledger.pendingAttempt = null;
  }

  function completeTaskAttempt(sender, key, stateId, elements, modalWindowId = null) {
    const ledger = getTaskAttemptLedger(sender, key);
    const attempt = ledger.pendingAttempt;
    if (!attempt) return null;
    const changed = attempt.beforeFingerprint !== hashAxElements(elements, modalWindowId);
    const progress = decideNoProgress(ledger, changed);
    ledger.consecutiveNoChange = progress.consecutiveNoChange;
    ledger.recoveryUsed = progress.recoveryUsed;
    let decision = progress.decision;
    if (decision === 'stop-no-progress') {
      ledger.stoppedReason = decision;
    }
    if (ledger.stoppedReason === 'stop-ambiguous-side-effect') {
      decision = ledger.stoppedReason;
    }
    ledger.pendingAttempt = null;
    ledger.outcomeUnknownReceipt = null;
    const receipt = {
      attempt_count: attempt.attemptCount,
      command: attempt.command,
      before_state_id: attempt.beforeStateId,
      after_state_id: stateId,
      status: changed ? 'verified-change' : 'no-change',
      observation: changed ? 'changed' : 'unchanged',
      expectation: 'not-requested',
      decision,
      consecutive_no_change: ledger.consecutiveNoChange,
      recovery_used: ledger.recoveryUsed,
      ...(attempt.outcomeUnknown ? { recovered_from_outcome_unknown: true } : {}),
    };
    noteComputerUseTrajectory(key, 'action-outcome', {
      command: attempt.command,
      attemptCount: attempt.attemptCount,
      consequential: attempt.consequential,
      outcome: receipt.status,
      outcomeUnknown: false,
      verificationStatus: receipt.status,
      reason: decision,
      stateId,
    });
    return receipt;
  }

  async function resolveTarget(targetApp) {
    if (typeof targetApp === 'string' && targetApp.trim()) {
      return normalizeIdentity(await nativeDispatch('resolve_app_identity', {
        appName: targetApp.trim(),
      }));
    }
    const active = normalizeIdentity(await getActiveWindow());
    if (!isSelfIdentity(active)) return active;

    // Submitting a prompt necessarily raises Abu, so GetForegroundWindow can
    // describe Abu even though the user's intended target was the external
    // window immediately behind it. Windows' top-level list is in Z order;
    // the first non-Abu entry is therefore the best host-trusted equivalent of
    // "the app I was just using". Pin its exact HWND instead of allowing an
    // unnamed request to observe/control Abu itself.
    if (platform === 'win32') {
      const windows = await nativeDispatch('list_windows', {});
      const external = Array.isArray(windows)
        ? windows.find((window) => (
            Number.isInteger(window?.process_id)
            && window.process_id !== selfProcessId
          ))
        : null;
      if (external) {
        return normalizeIdentity({
          ...external,
          bundle_id: external.bundle_id || external.app_id,
        });
      }
    }
    throw new Error(
      'Computer Use cannot infer a visible external target while Abu is foreground; '
      + 'ask the user to open or focus the intended app',
    );
  }

  function protocolTargetError(code, nextAction, candidates) {
    return {
      status: 'target-error',
      error: {
        code,
        recoverable: true,
        next_action: nextAction,
        ...(Array.isArray(candidates) ? { candidates } : {}),
      },
    };
  }

  function normalizeListedWindow(raw) {
    return normalizeIdentity({
      ...raw,
      bundle_id: raw?.bundle_id || raw?.app_id,
    });
  }

  function describeAuthorizedTarget(sender, key, target, windowRef = null) {
    if (platform !== 'win32' || typeof target.window_id !== 'string') {
      return {
        app_name: target.app_name,
        bundle_id: target.bundle_id,
        process_id: target.process_id,
        window_ref: null,
        relation: 'root',
      };
    }
    const record = windowRef ? windowRegistry.resolve({ sender, taskKey: key, windowRef }) : null;
    if (record) assertSameTarget({ target: record.identity }, target);
    const descriptor = record ? windowRegistry.describe(record) : windowRegistry.issue({
      sender,
      taskKey: key,
      identity: target,
      relation: 'root',
    });
    return {
      ...descriptor,
      bundle_id: target.bundle_id,
      process_id: target.process_id,
    };
  }

  function manualHandoffProtocolError() {
    return {
      code: 'manual-handoff-required',
      recoverable: true,
      next_action: 'wait-for-user',
    };
  }

  function isManualHandoffError(error) {
    const rejection = classifyInputRejection(error);
    if (rejection === 'secure-desktop' || rejection === 'higher-integrity') return true;
    return /credential|authentication|windows security|user account control|secure surface/i.test(
      String(error?.message || error || ''),
    );
  }

  function graphNodeIdentity(node, session) {
    const appId = typeof node?.app_id === 'string' && node.app_id.trim()
      ? node.app_id.trim()
      : node?.process_id === session.target.process_id
        ? session.target.bundle_id
        : String(node?.app_name || '').trim();
    return normalizeIdentity({
      app_name: node?.app_name,
      bundle_id: appId,
      app_id: appId,
      process_id: node?.process_id,
      window_id: node?.window_id,
      title: node?.title,
    });
  }

  function isSecurityGraphNode(node, session) {
    let identity;
    try {
      identity = graphNodeIdentity(node, session);
    } catch {
      return true;
    }
    if (identityClassification(identity) === 'hard-deny') return true;
    return /credential|authentication|windows security|user account control|secure desktop/i.test([
      node?.app_name,
      node?.app_id,
      node?.title,
    ].filter(Boolean).join(' '));
  }

  function ownerChainReachesRoot(node, byWindowId, rootWindowId) {
    let ownerId = typeof node?.owner_window_id === 'string' ? node.owner_window_id : null;
    const expectedRoot = String(rootWindowId || '').toLowerCase();
    const visited = new Set();
    for (let depth = 0; ownerId && depth < 16; depth += 1) {
      const normalized = ownerId.toLowerCase();
      if (normalized === expectedRoot) return true;
      if (visited.has(normalized)) return false;
      visited.add(normalized);
      ownerId = byWindowId.get(normalized)?.owner_window_id ?? null;
    }
    return false;
  }

  function observedOwnerChain(session, result) {
    const nodes = Array.isArray(result?.window_graph?.nodes) ? result.window_graph.nodes : [];
    const byId = new Map(nodes.filter((node) => typeof node?.window_id === 'string')
      .map((node) => [node.window_id.toLowerCase(), node]));
    let current = byId.get(String(session.target.window_id).toLowerCase());
    const visited = new Set([String(session.target.window_id).toLowerCase()]);
    const owners = [];
    for (let depth = 0; depth < 16 && typeof current?.owner_window_id === 'string'; depth += 1) {
      const ownerId = current.owner_window_id.toLowerCase();
      if (visited.has(ownerId)) break;
      visited.add(ownerId);
      current = byId.get(ownerId);
      if (!current || current.process_id !== session.target.process_id
        || current.app_id?.toLowerCase() !== session.target.bundle_id.toLowerCase()
        || isSecurityGraphNode(current, session)) break;
      owners.push(graphNodeIdentity(current, session));
    }
    return owners;
  }

  function isMissingWindowError(error) {
    return /window (?:is not visible|was not found|not found|is invalid)/i.test(String(error?.message || error));
  }

  async function resolveClosedWindowOwner(session, error) {
    if (platform !== 'win32' || !isMissingWindowError(error)) return null;
    const state = computerStates.get(session.taskKey);
    const attempt = taskAttemptLedgers.get(session.taskKey)?.pendingAttempt;
    const ax = state && axSessions.get(state.axSessionId);
    if (!state || state.sender !== session.sender || !state.consumed || state.actionInFlight
      || attempt?.beforeStateId !== state.stateId || attempt.outcomeUnknown
      || ax?.helperGeneration !== getNativeHelperGeneration()
      || !ax?.observedOwners?.length) return null;
    assertSameTarget(session, state.target);
    // Only the exact observed owner lineage is eligible. Never resolve by app
    // name or use an unrelated same-process sibling after a dialog disappears.
    try {
      await nativeDispatch('get_window', { windowId: session.target.window_id });
      return null;
    } catch (missing) {
      if (!isMissingWindowError(missing)) throw missing;
    }
    for (const owner of ax.observedOwners) {
      assertTaskAuthorizationLive(session.authorization);
      let raw;
      try {
        raw = await nativeDispatch('get_window', { windowId: owner.window_id });
      } catch (missing) {
        if (isMissingWindowError(missing)) continue;
        throw missing;
      }
      assertTaskAuthorizationLive(session.authorization);
      if (computerStates.get(session.taskKey) !== state
        || taskAttemptLedgers.get(session.taskKey)?.pendingAttempt !== attempt
        || ax.helperGeneration !== getNativeHelperGeneration()) {
        throw new Error('Computer Use verification authorization changed');
      }
      const target = normalizeIdentity({ ...raw, bundle_id: raw?.bundle_id || raw?.app_id });
      assertSameTarget({ target: owner }, target);
      assertIdentityAllowed(target);
      if (isSecurityGraphNode({ ...target, app_id: target.bundle_id }, session)) {
        throw new Error('Computer Use secure surface requires manual handoff');
      }
      return target;
    }
    return null;
  }

  function sanitizeWindowsObservation(sender, session, result) {
    if (platform !== 'win32' || !result || typeof result !== 'object') return result;
    const graph = result.window_graph;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const key = session.taskKey;
    const previousState = computerStates.get(key);
    const pendingAttempt = taskAttemptLedgers.get(key)?.pendingAttempt ?? null;
    const targetChanged = (
      typeof previousState?.target?.window_id === 'string'
      && typeof session.target?.window_id === 'string'
      && previousState.target.window_id.toLowerCase() !== session.target.window_id.toLowerCase()
    );
    let rootWindowRef = null;
    let targetRelation = 'root';
    if (targetChanged && previousState.consumed === true && pendingAttempt) {
      rootWindowRef = windowRegistry.issue({
        sender,
        taskKey: key,
        identity: previousState.target,
        relation: 'root',
      }).window_ref;
      targetRelation = 'replacement';
    }
    const targetDescriptor = targetRelation !== 'replacement' && session.windowRef
      ? windowRegistry.describe(windowRegistry.resolve({ sender, taskKey: key, windowRef: session.windowRef }))
      : windowRegistry.issue({
      sender,
      taskKey: key,
      identity: session.target,
      relation: targetRelation,
      rootWindowRef,
    });
    session.windowRef = targetDescriptor.window_ref;
    const target = {
      ...targetDescriptor,
      bundle_id: session.target.bundle_id,
      process_id: session.target.process_id,
    };
    const relatedWindows = targetRelation === 'replacement'
      ? [targetDescriptor]
      : [];
    const byWindowId = new Map(nodes
      .filter((node) => typeof node?.window_id === 'string')
      .map((node) => [node.window_id.toLowerCase(), node]));
    const securitySurface = nodes.find((node) => isSecurityGraphNode(node, session));
    if (securitySurface) {
      return {
        session_id: result.session_id,
        app: result.app ?? session.target.app_name,
        elements: [],
        modal: true,
        modal_window_id: null,
        target,
        related_windows: [],
        protocol_error: manualHandoffProtocolError(),
      };
    }
    let modalWindowRef = null;
    for (const node of nodes) {
      if (typeof node?.window_id !== 'string') continue;
      if (node.window_id.toLowerCase() === String(session.target.window_id || '').toLowerCase()) continue;
      const sameProcess = node.process_id === session.target.process_id;
      const sameApp = typeof node.app_id === 'string'
        && node.app_id.toLowerCase() === session.target.bundle_id.toLowerCase();
      const isModal = typeof result.modal_window_id === 'string'
        && node.window_id.toLowerCase() === result.modal_window_id.toLowerCase();
      const trustedOwned = node.relation === 'owned-popup'
        && ownerChainReachesRoot(node, byWindowId, session.target.window_id);
      if (!sameProcess || !sameApp || (!trustedOwned && !isModal)) continue;
      const descriptor = windowRegistry.issue({
        sender,
        taskKey: key,
        identity: graphNodeIdentity(node, session),
        relation: isModal ? 'modal' : 'owned',
        rootWindowRef: targetDescriptor.window_ref,
      });
      relatedWindows.push(descriptor);
      if (isModal) modalWindowRef = descriptor.window_ref;
    }
    const {
      window_graph: _windowGraph,
      window_id: _windowId,
      process_id: _processId,
      modal_window_id: _modalWindowId,
      ...safeResult
    } = result;
    return {
      ...safeResult,
      target,
      related_windows: relatedWindows,
      modal_window_id: modalWindowRef,
    };
  }

  async function captureTurnTarget(sender, args) {
    if (platform !== 'win32') return { captured: false };
    const key = taskKey(args);
    let target = normalizeIdentity(await getActiveWindow());
    if (isSelfIdentity(target)) {
      const windows = await nativeDispatch('list_windows', {});
      const external = Array.isArray(windows)
        ? windows.find((window) => (
            Number.isInteger(window?.process_id)
            && window.process_id !== selfProcessId
            && typeof window?.window_id === 'string'
          ))
        : null;
      if (!external) {
        turnTargetSnapshots.delete(key);
        return { captured: false };
      }
      target = normalizeListedWindow(external);
    }
    if (typeof target.window_id !== 'string') {
      turnTargetSnapshots.delete(key);
      return { captured: false };
    }
    turnTargetSnapshots.set(key, { sender, target });
    return { captured: true };
  }

  async function listWindowsForApp(sender, args) {
    if (platform !== 'win32') {
      return protocolTargetError('target-not-found', 'select-target');
    }
    if (typeof args?.app !== 'string' || !args.app.trim()) {
      return protocolTargetError('target-required', 'select-target');
    }
    const { windows: normalized } = await resolveVisibleAppWindows(args.app.trim());
    const includeTitle = normalized.length > 1;
    const candidates = normalized.map((identity) => windowRegistry.issue({
      sender,
      taskKey: taskKey(args),
      identity,
      relation: 'root',
      includeTitle,
    }));
    return { status: 'candidates', candidates };
  }

  async function resolveVisibleAppWindows(appName) {
    const resolved = await resolveTarget(appName);
    assertIdentityAllowed(resolved);
    const windows = await nativeDispatch('list_windows', {
      expectedAppId: resolved.bundle_id,
    });
    const normalized = Array.isArray(windows)
      ? windows
          .filter((window) => window?.minimized !== true)
          .map((window) => normalizeListedWindow({ ...resolved, ...window }))
          .filter((window) => typeof window.window_id === 'string')
          .filter((window) => window.bundle_id.toLowerCase() === resolved.bundle_id.toLowerCase())
      : [];
    return { resolved, windows: normalized };
  }

  async function resolveUniqueAppWindow(sender, key, appName) {
    const { windows } = await resolveVisibleAppWindows(appName);
    if (windows.length === 0) {
      return protocolTargetError('target-not-found', 'select-target');
    }
    if (windows.length > 1) {
      const candidates = windows.map((identity) => windowRegistry.issue({
        sender,
        taskKey: key,
        identity,
        relation: 'root',
        includeTitle: true,
      }));
      return protocolTargetError('target-ambiguous', 'select-target', candidates);
    }
    return { identity: windows[0] };
  }

  async function resolveSessionTarget(sender, args) {
    const key = taskKey(args);
    if (typeof args?.windowRef === 'string' && args.windowRef) {
      try {
        const record = windowRegistry.resolve({
          sender,
          taskKey: key,
          windowRef: args.windowRef,
        });
        return { identity: record.identity };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (code === 'window-ref-invalid' || code === 'window-ref-expired') {
          return protocolTargetError(code, 'select-target');
        }
        throw error;
      }
    }
    if (args?.targetSelector === 'foreground-at-submit') {
      const snapshot = turnTargetSnapshots.get(key);
      if (!snapshot || snapshot.sender !== sender) {
        return protocolTargetError('target-required', 'select-target');
      }
      return { identity: snapshot.target };
    }
    if (typeof args?.targetApp === 'string' && args.targetApp.trim()) {
      return resolveUniqueAppWindow(sender, key, args.targetApp.trim());
    }
    return protocolTargetError('target-required', 'select-target');
  }

  function assertSameAppProcess(session, identity) {
    if (identity.bundle_id.toLowerCase() !== session.target.bundle_id.toLowerCase()) {
      throw new Error(
        `Computer Use target changed from "${session.target.app_name}" to "${identity.app_name}"`
      );
    }
    if (
      session.target.process_id !== null
      && identity.process_id !== null
      && session.target.process_id !== identity.process_id
    ) {
      throw new Error(
        `Computer Use target process changed for "${session.target.app_name}"`
      );
    }
  }

  async function pinWindowsTaskTarget(sender, args, requestedTarget) {
    if (platform !== 'win32') return requestedTarget;
    // Explicit Host-issued selections must not be replaced by legacy app-name
    // pinning. Writes still require the current state for this exact target.
    if (typeof args?.windowRef === 'string' && args.windowRef) return requestedTarget;
    const key = taskKey(args);
    const state = computerStates.get(key);
    if (
      !state
      || state.sender !== sender
      || (
        typeof args?.expectedStateId === 'string'
        && state.stateId !== args.expectedStateId
      )
      || typeof state.target?.window_id !== 'string'
      || state.target.window_id.toLowerCase() === requestedTarget.window_id?.toLowerCase()
    ) {
      return requestedTarget;
    }

    // Office can expose several top-level HWNDs for one document process (for
    // example a document window plus an activation/search surface). Resolving
    // the app name again between observe, act, and verification may therefore
    // choose a different sibling HWND even though the observed document is
    // still alive. Keep the task bound to its exact observed HWND and ask the
    // helper to revalidate that native handle instead of silently retargeting.
    assertSameAppProcess({ target: state.target }, requestedTarget);
    let rawWindow;
    try {
      rawWindow = await nativeDispatch('get_window', {
        windowId: state.target.window_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const verifiesCompletedWrite = state.consumed === true
        && state.actionInFlight !== true
        && taskAttemptLedgers.get(key)?.pendingAttempt;
      const previousWindowIsGone = /window (?:is not visible|was not found|not found|is invalid)/i.test(message);
      if (verifiesCompletedWrite && previousWindowIsGone) {
        // Some applications replace their top-level HWND as the direct result
        // of an approved action. Word does this when the start/backstage window
        // creates a document. The consumed state still proves which old HWND
        // was acted on, while the pending-attempt ledger makes this one
        // same-process replacement a verification step rather than an
        // unrestricted retarget. The next AX snapshot pins the replacement.
        return requestedTarget;
      }
      throw error;
    }
    const pinnedTarget = normalizeIdentity({
      ...rawWindow,
      bundle_id: rawWindow?.bundle_id || rawWindow?.app_id,
    });
    assertSameTarget({ target: state.target }, pinnedTarget);
    return pinnedTarget;
  }

  function getSession(sender, args) {
    pruneExpired();
    const token = args?.[COMPUTER_USE_TOKEN_ARG];
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Computer Use authorization token is required');
    }
    const session = sessions.get(token);
    if (!session || session.sender !== sender) {
      throw new Error('Computer Use authorization token is invalid or expired');
    }
    if (!enabledSenders.has(sender)) {
      sessions.delete(token);
      throw new Error('Computer Use is disabled');
    }
    const lease = taskLeases.get(session.taskKey);
    if (
      !lease
      || lease.sender !== sender
      || lease.authorization !== session.authorization
      || activeTask !== session.authorization
    ) {
      sessions.delete(token);
      throw new Error('Computer Use task authorization is no longer active');
    }
    return session;
  }

  function assertScope(session, cmd) {
    if (COMPUTER_USE_CONTROL_COMMANDS.has(cmd) && session.scope !== 'ui-control') {
      throw new Error(`Computer Use session scope "${session.scope}" cannot invoke ${cmd}`);
    }
    if (
      !COMPUTER_USE_CONTROL_COMMANDS.has(cmd)
      && !COMPUTER_USE_READ_COMMANDS.has(cmd)
    ) {
      throw new Error(`Computer Use command is not authorized: ${cmd}`);
    }
  }

  function assertIdentityAllowed(identity) {
    const classification = identityClassification(identity);
    if (classification === 'hard-deny') {
      throw new Error(isSelfIdentity(identity)
        ? 'Computer Use is blocked from operating Abu itself'
        : `Computer Use is blocked for sensitive app "${identity.app_name}"`);
    }
    return classification;
  }

  function taskKey(args) {
    return `${args.conversationId}\u0000${args.loopId}`;
  }

  function assertTurnNotStopped(key) {
    const marker = turnStopStore?.get?.(key) ?? null;
    if (marker) {
      throw new Error(
        `Computer Use turn is stopped (${marker.reason}); start a new turn to continue`,
      );
    }
  }

  function markTurnStopped(key, reason) {
    const marker = turnStopStore?.stop?.(key, reason) ?? null;
    noteComputerUseTrajectory(key, 'turn-stopped', {
      outcome: 'stopped',
      reason: typeof reason === 'string' ? reason : 'stopped',
    });
    return marker;
  }

  function nativeRequestContext(session) {
    return {
      conversationId: session.conversationId,
      loopId: session.loopId,
      target: {
        appId: session.target.app_id || session.target.bundle_id,
        processId: session.target.process_id,
        windowId: session.target.window_id || null,
      },
    };
  }

  function taskGrantKey(key, identity) {
    return `${key}\u0000${identity.bundle_id.toLowerCase()}`;
  }

  function grantCoversScope(grant, scope) {
    return grant.scope === 'ui-control' || grant.scope === scope;
  }

  function assertTaskAuthorizationLive(authorization) {
    if (activeTask !== authorization) {
      throw new Error('Computer Use task authorization is no longer active');
    }
    const lease = taskLeases.get(authorization.key);
    if (lease && lease.authorization !== authorization) {
      throw new Error('Computer Use task authorization was replaced');
    }
  }

  function ensureTaskBudget(key) {
    let budget = taskBudgets.get(key);
    if (!budget) {
      budget = { stepCount: 0, elapsedMs: 0, runningSince: null, pauseDepth: 0 };
      taskBudgets.set(key, budget);
    }
    return budget;
  }

  function taskBudgetElapsed(budget) {
    return budget.elapsedMs + (
      budget.runningSince === null ? 0 : Math.max(0, now() - budget.runningSince)
    );
  }

  function pauseTaskBudget(key) {
    const budget = taskBudgets.get(key);
    if (!budget) return;
    budget.pauseDepth += 1;
    if (budget.pauseDepth === 1 && budget.runningSince !== null) {
      budget.elapsedMs += Math.max(0, now() - budget.runningSince);
      budget.runningSince = null;
    }
  }

  function resumeTaskBudget(key) {
    const budget = taskBudgets.get(key);
    if (!budget) return;
    if (budget.pauseDepth > 0) budget.pauseDepth -= 1;
    if (budget.pauseDepth === 0 && budget.runningSince === null && budget.stepCount > 0) {
      budget.runningSince = now();
    }
  }

  function extendAuthorizationTtls(authorization, durationMs) {
    if (durationMs <= 0 || activeTask !== authorization) return;
    const lease = taskLeases.get(authorization.key);
    if (lease?.authorization === authorization) lease.expiresAt += durationMs;
    for (const session of sessions.values()) {
      if (session.authorization === authorization) session.expiresAt += durationMs;
    }
    for (const grant of taskGrants.values()) {
      if (grant.authorization === authorization) grant.expiresAt += durationMs;
    }
    const state = computerStates.get(authorization.key);
    if (state?.sender === authorization.sender) state.expiresAt += durationMs;
  }

  /**
   * Refuse an over-budget task. Checked BEFORE the reservation, so a task
   * that has nothing left cannot re-take the global single-flight
   * reservation after `pruneExpired` drops its lapsed lease.
   */
  function assertTaskBudgetAvailable(key) {
    const budget = ensureTaskBudget(key);
    if (taskBudgetElapsed(budget) > MAX_TASK_CU_DURATION_MS) {
      throw new Error(
        `Computer Use has hit its ${MAX_TASK_CU_DURATION_MS / 60000}-minute limit for this task. `
        + 'Report progress to the user and ask whether to continue.',
      );
    }
    if (budget.stepCount >= MAX_TASK_CU_STEPS) {
      throw new Error(
        `Computer Use has hit its ${MAX_TASK_CU_STEPS}-step limit for this task. `
        + 'Report progress to the user and ask whether to continue.',
      );
    }
  }

  /**
   * Spend one step, once the action is actually authorized to run.
   *
   * Deliberately separate from the check above, and deliberately last: an
   * attempt refused for single-flight ('already active in another foreground
   * task'), for a denied approval, or by any of the target/permission
   * assertions in between must not cost the task a step. Charging up front
   * meant a task that never executed anything could burn its whole budget
   * retrying a transient conflict — and would then be told it had hit a
   * 30-step limit rather than the real reason.
   *
   * One step per `computer_use_begin_session`, which is one CU action — the
   * same unit the renderer's status bar counts, so the number the user sees
   * and the number that is enforced are the same number.
   */
  function chargeTaskBudget(key) {
    const budget = ensureTaskBudget(key);
    budget.stepCount += 1;
    if (budget.pauseDepth === 0 && budget.runningSince === null) {
      budget.runningSince = now();
    }
  }

  async function ensureInputLease(authorization) {
    if (platform !== 'win32') return;
    if (authorization.inputLeaseId) return;
    const leaseId = inputLeaseIdFactory();
    await nativeDispatch('input_lease_begin', { leaseId });
    assertTaskAuthorizationLive(authorization);
    authorization.inputLeaseId = leaseId;
    authorization.inputLeaseGeneration = getNativeHelperGeneration();
  }

  async function commitInputLeaseAfterObservation(session, result) {
    if (platform !== 'win32') return;
    const leaseId = session.authorization.inputLeaseId;
    if (!leaseId) {
      throw new Error('Computer Use input lease was not established before observation');
    }
    if (!Number.isSafeInteger(result?.input_epoch) || result.input_epoch < 1) {
      throw new Error('Windows observation did not include a valid physical-input epoch');
    }
    await nativeDispatch('input_lease_commit_observation', {
      leaseId,
      expectedInputEpoch: result.input_epoch,
    });
    assertTaskAuthorizationLive(session.authorization);
  }

  async function activateInputLeaseForAction(session, state) {
    if (platform !== 'win32') return false;
    const leaseId = session.authorization.inputLeaseId;
    if (!leaseId) {
      throw new Error('Computer Use input lease was not established before native input');
    }
    if (!Number.isSafeInteger(state?.inputEpoch) || state.inputEpoch < 1) {
      throw new Error('Computer Use action has no valid physical-input epoch');
    }
    await nativeDispatch('input_lease_activate', {
      leaseId,
      expectedInputEpoch: state.inputEpoch,
    });
    assertTaskAuthorizationLive(session.authorization);
    return true;
  }

  async function observeInputLeaseAfterAction(session) {
    if (platform !== 'win32') return;
    const leaseId = session.authorization.inputLeaseId;
    if (!leaseId || activeTask !== session.authorization) return;
    await nativeDispatch('input_lease_observe', { leaseId });
    assertTaskAuthorizationLive(session.authorization);
  }

  /**
   * Electron's native consent dialog necessarily becomes the foreground
   * window while the user is deciding. Closing it can return focus to Abu
   * instead of to the exact control that was focused when the action was
   * proposed (Office is especially prone to this). Restore only the pinned
   * HWND and the UIA element from the observation; both are checked again by
   * the Helper before SetFocus is allowed.
   */
  async function restoreWindowsFocusForAction(session, state) {
    if (platform !== 'win32' || !state) return;
    const windowId = session.target.window_id;
    // Legacy/test identities can lack a WindowRef. They retain the previous
    // foreground check; precise restoration is available only for v2 HWND-
    // pinned Windows sessions.
    if (typeof windowId !== 'string') return;
    const axSession = state.axSessionId ? axSessions.get(state.axSessionId) : null;
    let leaseActivated = false;
    try {
      // Check the physical-input epoch before raising anything. If the user
      // changed focus after observation, activation fails and Abu never grabs
      // the old window back from them.
      leaseActivated = await activateInputLeaseForAction(session, state);
      const activatedRaw = await nativeDispatch('activate_window', { windowId });
      const activated = normalizeIdentity({
        ...activatedRaw,
        bundle_id: activatedRaw?.bundle_id ?? activatedRaw?.app_id,
      });
      assertSameTarget(session, activated);
      if (axSession) {
        await nativeDispatch('ax_restore_focus', {
          sessionId: state.axSessionId,
          [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
        });
      }
    } finally {
      if (leaseActivated && activeTask === session.authorization) {
        await observeInputLeaseAfterAction(session);
      }
    }
  }

  /**
   * A state_id is a claim about the UI that was observed, not merely about the
   * foreground PID/HWND. Same-process Office dialogs can arrive
   * asynchronously without changing the physical-input epoch. Re-snapshot
   * immediately before every write and require the modal boundary to still
   * match, otherwise a stale key/click could land in that dialog. We do not
   * compare the whole Office tree here: ribbon status controls update on their
   * own and are not a target-boundary change.
   */
  async function revalidateWindowsUiState(session, state) {
    if (platform !== 'win32' || !state?.axSessionId) return;
    const observed = axSessions.get(state.axSessionId);
    if (!observed) {
      computerStates.delete(session.taskKey);
      throw new Error('Computer Use accessibility state expired; observe again');
    }
    let snapshot = null;
    try {
      snapshot = await nativeDispatch('ax_snapshot', {
        appName: session.target.app_name,
        expectedBundleId: session.target.bundle_id,
        expectedProcessId: session.target.process_id,
        expectedWindowId: session.target.window_id,
        [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
      });
      assertTaskAuthorizationLive(session.authorization);
      const changedBoundary = !Number.isSafeInteger(snapshot?.input_epoch) || snapshot.input_epoch !== state.inputEpoch
        ? 'input-epoch'
        : snapshot.window_id?.toLowerCase() !== state.windowId?.toLowerCase() ? 'target-window'
          : Boolean(snapshot.modal) !== observed.modal ? 'modal-boundary'
            : (snapshot.modal_window_id ?? null) !== observed.modalWindowId ? 'modal-window'
              : observed.windowGraphRevision !== null && hashWindowGraph(snapshot.window_graph) !== observed.windowGraphRevision
                ? 'window-graph' : null;
      if (changedBoundary) {
        computerStates.delete(session.taskKey);
        throw new Error(`Computer Use interface changed after observation (${changedBoundary}); observe again`);
      }
    } finally {
      if (typeof snapshot?.session_id === 'string') {
        try {
          await nativeDispatch('ax_close_session', {
            sessionId: snapshot.session_id,
            [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
          });
        } catch {
          // The original validation result remains authoritative. A Helper
          // restart is caught by the generation check on the next operation.
        }
      }
    }
  }

  async function withApprovalPaused(authorization, approvalKind, callback) {
    const key = authorization.key;
    const leaseId = platform === 'win32' ? authorization.inputLeaseId : null;
    const approvalStartedAt = now();
    let leasePaused = false;
    let value;
    let callbackError = null;
    let resumeError = null;
    noteComputerUseTrajectory(key, 'approval', {
      approvalKind,
      approvalDecision: 'requested',
    });
    pauseTaskBudget(key);
    try {
      if (leaseId) {
        await nativeDispatch('input_lease_pause', {
          leaseId,
          consentOwnerProcessId: process.pid,
        });
        leasePaused = true;
      }
      value = await callback();
    } catch (error) {
      callbackError = error;
    } finally {
      // A task may be stopped while the native dialog is pending. Never spawn
      // a fresh Helper merely to resume a lease that the stop already revoked.
      if (leasePaused && activeTask === authorization) {
        try {
          const resumed = await nativeDispatch('input_lease_resume', { leaseId });
          if (resumed?.dirty === true) {
            computerStates.delete(key);
            resumeError = new Error(
              'Physical user input changed another app during approval; observe again',
            );
          }
        } catch (error) {
          resumeError = error;
        }
      }
      extendAuthorizationTtls(authorization, Math.max(0, now() - approvalStartedAt));
      resumeTaskBudget(key);
    }
    noteComputerUseTrajectory(key, 'approval', {
      approvalKind,
      approvalDecision: resumeError || callbackError
        ? 'error'
        : value === true ? 'allowed' : 'denied',
      durationMs: Math.max(0, now() - approvalStartedAt),
    });
    if (resumeError) throw resumeError;
    if (callbackError) throw callbackError;
    return value;
  }

  function reserveTaskAuthorization(sender, args) {
    const key = taskKey(args);
    const existing = taskLeases.get(key);
    if (existing && existing.sender === sender) {
      assertTaskAuthorizationLive(existing.authorization);
      return {
        authorization: existing.authorization,
        existingMode: existing.mode,
      };
    }
    if (activeTask) {
      throw new Error('Computer Use is already active in another foreground task');
    }
    const authorization = { key, sender, browserOrigins: new Set() };
    activeTask = authorization;
    return { authorization, existingMode: null };
  }

  async function authorizeTask(sender, args, target, classification, reservation) {
    const { authorization, existingMode } = reservation;
    assertTaskAuthorizationLive(authorization);
    if (existingMode) {
      return { mode: existingMode, authorization };
    }
    const mode = VALID_PERMISSION_MODES.has(args.permissionMode)
      ? args.permissionMode
      : 'standard';
    try {
      if (mode !== 'standard') {
        const approved = await withApprovalPaused(authorization, 'task', () => requestTaskApproval({
          sender,
          target,
          classification,
          mode,
          conversationId: args.conversationId,
          loopId: args.loopId,
        }));
        if (!approved) {
          throw new Error('Computer Use was not approved for this task');
        }
      }
      assertTaskAuthorizationLive(authorization);
      taskLeases.set(authorization.key, {
        sender,
        mode,
        authorization,
        expiresAt: now() + TASK_GRANT_TTL_MS,
      });
      return { mode, authorization };
    } catch (error) {
      if (activeTask === authorization) activeTask = null;
      throw error;
    }
  }

  async function authorizeTarget(
    sender,
    args,
    target,
    classification,
    mode,
    authorization
  ) {
    assertTaskAuthorizationLive(authorization);
    const decision = policy.modePolicy[mode]?.[classification] ?? 'confirm';
    if (decision === 'allow') return;

    const key = taskGrantKey(taskKey(args), target);
    const existing = taskGrants.get(key);
    if (
      existing
      && existing.sender === sender
      && existing.authorization === authorization
      && grantCoversScope(existing, args.scope)
    ) {
      return;
    }

    const approved = await withApprovalPaused(authorization, 'app', () => requestAppApproval({
      sender,
      target,
      classification,
      scope: args.scope,
      permissionMode: mode,
      conversationId: args.conversationId,
      loopId: typeof args.loopId === 'string' ? args.loopId : null,
      toolCallId: args.toolCallId,
    }));
    if (!approved) {
      throw new Error(`Computer Use app approval was not granted for "${target.app_name}"`);
    }
    assertTaskAuthorizationLive(authorization);
    taskGrants.set(key, {
      sender,
      taskKey: taskKey(args),
      authorization,
      scope: args.scope,
      expiresAt: now() + TASK_GRANT_TTL_MS,
    });
  }

  function revokeTask(sender, key, { preserveAttemptLedger = false } = {}) {
    let revoked = false;
    for (const [token, session] of sessions) {
      if (session.sender === sender && session.taskKey === key) {
        sessions.delete(token);
        revoked = true;
      }
    }
    for (const [sessionId, record] of axSessions) {
      if (record.sender === sender && record.taskKey === key) {
        axSessions.delete(sessionId);
        revoked = true;
      }
    }
    for (const [grantKey, grant] of taskGrants) {
      if (grant.sender === sender && grant.taskKey === key) {
        taskGrants.delete(grantKey);
        revoked = true;
      }
    }
    const state = computerStates.get(key);
    if (state?.sender === sender) {
      computerStates.delete(key);
      revoked = true;
    }
    if (!preserveAttemptLedger && taskAttemptLedgers.delete(key)) revoked = true;
    const lease = taskLeases.get(key);
    if (lease?.sender === sender) {
      taskLeases.delete(key);
      taskBudgets.delete(key);
      revoked = true;
    }
    if (activeTask?.sender === sender && activeTask.key === key) {
      taskBudgets.delete(key);
      activeTask = null;
      revoked = true;
    }
    const targetSnapshot = turnTargetSnapshots.get(key);
    if (targetSnapshot?.sender === sender) {
      turnTargetSnapshots.delete(key);
      revoked = true;
    }
    windowRegistry.revokeTask(sender, key);
    return revoked;
  }

  function handleNativeHelperEvent(event) {
    if (
      !activeTask
      || !event
      || !['user-interrupted', 'user-input-detected', 'window-invalidated'].includes(event.type)
    ) {
      return null;
    }
    const authorization = activeTask;
    markTurnStopped(authorization.key, event.type);
    observability.noteComputerUseInvalidation?.(
      event.type === 'window-invalidated' ? 'window-invalidated' : 'physical-input',
    );
    const [conversationId, loopId] = authorization.key.split('\u0000');
    revokeTask(authorization.sender, authorization.key);
    killNativeHelper(`event:${event.type}`);
    return Object.freeze({
      type: event.type,
      reason: event.reason || null,
      conversationId: conversationId || null,
      loopId: loopId || null,
    });
  }

  async function assertOsPermissions(scope, cmd) {
    const permissions = await nativeDispatch('check_macos_permissions', {});
    const needsScreen = COMPUTER_USE_READ_COMMANDS.has(cmd)
      && cmd !== 'ax_snapshot';
    const needsAccessibility = COMPUTER_USE_CONTROL_COMMANDS.has(cmd)
      || cmd === 'ax_snapshot'
      || scope === 'ui-control';
    if (needsScreen && permissions?.screen_recording !== true) {
      throw new Error('Computer Use requires Screen Recording permission');
    }
    if (needsAccessibility && permissions?.accessibility !== true) {
      throw new Error('Computer Use requires Accessibility permission');
    }
  }

  function assertSameTarget(session, identity) {
    assertSameAppProcess(session, identity);
    if (
      platform === 'win32'
      && typeof session.target.window_id === 'string'
      && typeof identity.window_id === 'string'
      && session.target.window_id.toLowerCase() !== identity.window_id.toLowerCase()
    ) {
      throw new Error(
        `Computer Use target window changed for "${session.target.app_name}" `
        + `(expected ${session.target.window_id}, got ${identity.window_id})`,
      );
    }
  }

  function assertComputerState(sender, key, target, expectedStateId, consume) {
    const state = computerStates.get(key);
    if (!state || state.sender !== sender) {
      throw new Error('Computer Use requires a fresh state_id from get_app_state');
    }
    if (state.expiresAt <= now()) {
      computerStates.delete(key);
      throw new Error('Computer Use state_id is expired');
    }
    if (state.helperGeneration !== getNativeHelperGeneration()) {
      computerStates.delete(key);
      throw new Error('Computer Use requires a fresh state_id after native helper restart');
    }
    if (typeof expectedStateId !== 'string' || expectedStateId !== state.stateId) {
      throw new Error('Computer Use state_id is not the latest observation');
    }
    assertSameTarget({ target: state.target }, target);
    if (state.actionInFlight) {
      throw new Error('Another Computer Use action is already in flight');
    }
    if (state.consumed) {
      throw new Error('Computer Use state_id was already consumed');
    }
    if (consume) {
      state.consumed = true;
      state.actionInFlight = true;
    }
    return state;
  }

  async function assertCommandTarget(session, cmd, args) {
    if (
      session.scope === 'screen-read'
      && (cmd === 'capture_screen' || cmd === 'capture_screen_excluding')
    ) {
      // A desktop screenshot reads the screen as a whole. Binding it to whichever
      // app happened to be foreground when the request began is misleading and
      // breaks the Windows hide-before-capture fallback.
      return;
    }
    if (cmd === 'activate_app') {
      if (platform === 'win32' && typeof session.target.window_id === 'string'
        && args?.appName === session.target.app_name) {
        const window = await nativeDispatch('get_window', { windowId: session.target.window_id });
        const requested = normalizeIdentity({ ...window, bundle_id: window?.bundle_id ?? window?.app_id });
        assertIdentityAllowed(requested);
        assertSameTarget(session, requested);
        return;
      }
      const requested = await resolveTarget(args?.appName);
      assertIdentityAllowed(requested);
      assertSameTarget(session, requested);
      return;
    }
    if (cmd === 'ax_snapshot') {
      if (platform === 'win32' && typeof session.target.window_id === 'string') {
        // The Windows helper receives the exact app/process/HWND tuple below
        // and resolves that HWND directly. Re-resolving the app name here can
        // select an Office auxiliary surface and contradict the pinned target.
        return;
      }
      const requested = await resolveTarget(args?.appName);
      assertIdentityAllowed(requested);
      assertSameTarget(session, requested);
      return;
    }
    if (
      cmd === 'ax_press'
      || cmd === 'ax_set_value'
      || cmd === 'ax_replace_text'
      || cmd === 'ax_perform_action'
    ) {
      const axSession = axSessions.get(args?.sessionId);
      if (!axSession || axSession.sender !== session.sender) {
        throw new Error('Accessibility session is invalid or expired');
      }
      if (axSession.helperGeneration !== getNativeHelperGeneration()) {
        axSessions.delete(args.sessionId);
        throw new Error('Accessibility session expired after native helper restart');
      }
      if (axSession.bundleId !== session.target.bundle_id) {
        throw new Error('Accessibility session belongs to a different app');
      }
      if (axSession.taskKey !== session.taskKey) {
        throw new Error('Accessibility session belongs to a different task');
      }
      return;
    }
    const active = normalizeIdentity(await getActiveWindow());
    assertIdentityAllowed(active);
    if (
      platform === 'win32'
      && typeof session.target.window_id === 'string'
      && typeof active.window_id === 'string'
      && session.target.window_id.toLowerCase() !== active.window_id.toLowerCase()
    ) {
      assertSameAppProcess(session, active);
      const match = await nativeDispatch('frontmost_matches_target', {
        expectedAppId: session.target.bundle_id,
        expectedProcessId: session.target.process_id,
        expectedWindowId: session.target.window_id,
      });
      if (match?.matches === true) return;
      if (match && typeof match === 'object') {
        throw new Error(
          `Computer Use target window changed for "${session.target.app_name}" `
          + `(expected ${session.target.window_id} ${JSON.stringify(match.expected_bounds)}, `
          + `got ${active.window_id} ${JSON.stringify(match.actual_bounds)}, `
          + `relation ${String(match.relation || 'unknown')})`,
        );
      }
    }
    assertSameTarget(session, active);
  }

  async function assertBrowserOriginCurrent(session) {
    if (!session.browserOrigin) return;
    let snapshot = null;
    try {
      snapshot = await nativeDispatch('ax_snapshot', {
        app_name: session.target.app_name,
        expected_bundle_id: session.target.bundle_id,
        expected_process_id: session.target.process_id,
        [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
        ...(typeof session.target.window_id === 'string'
          ? { expected_window_id: session.target.window_id }
          : {}),
      });
      const currentOrigin = resolveBrowserOriginFromSnapshot(snapshot);
      if (currentOrigin !== session.browserOrigin) {
        throw new Error(
          'Browser Computer Use origin changed after observation; get a fresh app state and approve the new site',
        );
      }
    } finally {
      if (typeof snapshot?.session_id === 'string') {
        try {
          await nativeDispatch('ax_close_session', {
            session_id: snapshot.session_id,
            [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
          });
        } catch {
          // The helper generation/cache may already have been invalidated. The
          // original verification outcome remains authoritative and no raw URL
          // is logged while cleaning this short-lived session.
        }
      }
    }
  }

  async function dispatch(record, sender, cmd, args) {
    const ownsCommand = COMPUTER_USE_HOST_COMMANDS.has(cmd)
      || COMPUTER_USE_PROBE_COMMANDS.has(cmd)
      || COMPUTER_USE_CLEANUP_COMMANDS.has(cmd)
      || COMPUTER_USE_PRIVILEGED_COMMANDS.has(cmd);
    if (!ownsCommand) return COMPUTER_USE_GATE_MISS;

    assertMainRecord(record);

    if (cmd === 'computer_use_set_enabled') {
      if (typeof args?.enabled !== 'boolean') {
        throw new Error('computer_use_set_enabled requires a boolean enabled value');
      }
      if (args.enabled) {
        enabledSenders.add(sender);
      } else {
        revokeSender(sender);
      }
      return null;
    }

    if (cmd === 'computer_use_capture_turn_target') {
      if (!enabledSenders.has(sender)) throw new Error('Computer Use is disabled');
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.loopId, 'loopId');
      if (args?.interactionMode !== 'foreground') {
        throw new Error('Background tasks cannot capture a Computer Use target');
      }
      assertTurnNotStopped(taskKey(args));
      return captureTurnTarget(sender, args);
    }

    if (cmd === 'computer_use_list_windows') {
      if (!enabledSenders.has(sender)) throw new Error('Computer Use is disabled');
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.loopId, 'loopId');
      if (args?.interactionMode !== 'foreground') {
        throw new Error('Background tasks cannot list Computer Use windows');
      }
      assertTurnNotStopped(taskKey(args));
      return listWindowsForApp(sender, args);
    }

    if (cmd === 'computer_use_begin_session') {
      if (!enabledSenders.has(sender)) throw new Error('Computer Use is disabled');
      pruneExpired();
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.toolCallId, 'toolCallId');
      assertShortId(args?.loopId, 'loopId');
      if (args?.interactionMode !== 'foreground') {
        throw new Error('Background tasks cannot open Computer Use sessions');
      }
      if (!VALID_SCOPES.has(args?.scope)) {
        throw new Error('Computer Use session scope is invalid');
      }
      const actionIntent = normalizeActionIntent(args?.actionIntent, args.scope);
      assertTurnNotStopped(taskKey(args));
      // Refuse an over-budget task before it can take the reservation; the
      // step itself is charged only once the action is authorized, further
      // down. (Single-flight is unchanged either way: a task holds its
      // reservation until `computer_use_end_task`, as always.)
      assertTaskBudgetAvailable(taskKey(args));
      const reservation = reserveTaskAuthorization(sender, args);
      const { authorization } = reservation;
      const targetFailure = (error) => {
        if (activeTask === authorization && !taskLeases.has(authorization.key)) {
          activeTask = null;
        }
        return error;
      };
      try {
        let requestedTarget;
        if (args.scope === 'screen-read') {
          requestedTarget = SCREEN_READ_TARGET;
        } else if (platform === 'win32') {
          const resolution = await resolveSessionTarget(sender, args);
          if (resolution.status === 'target-error') {
            return targetFailure(resolution);
          }
          requestedTarget = resolution.identity;
        } else if (typeof args?.targetApp === 'string' && args.targetApp.trim()) {
          requestedTarget = await resolveTarget(args.targetApp);
        } else {
          requestedTarget = await resolveTarget(args?.targetApp);
        }
        const target = args.scope === 'screen-read'
          ? requestedTarget
          : await pinWindowsTaskTarget(sender, args, requestedTarget);
        assertTaskAuthorizationLive(authorization);
        const classification = args.scope === 'screen-read'
          ? 'ordinary'
          : assertIdentityAllowed(target);
        let browserOrigin = null;
        if (
          args.scope === 'ui-control'
          && STATEFUL_ACTIONS.has(actionIntent.action)
          && isBrowserIdentity(platform, target)
        ) {
          const state = computerStates.get(taskKey(args));
          const axSession = state?.axSessionId ? axSessions.get(state.axSessionId) : null;
          browserOrigin = axSession?.browserOrigin || null;
          if (!browserOrigin) {
            throw new Error(
              'Browser Computer Use is blocked because the current origin cannot be verified by the trusted host',
            );
          }
        }
        if (
          args.scope === 'ui-control'
          && STATEFUL_ACTIONS.has(actionIntent.action)
        ) {
          assertTaskAttemptAllowed(sender, taskKey(args));
          assertComputerState(
            sender,
            taskKey(args),
            target,
            args?.expectedStateId,
            false
          );
        }
        await assertOsPermissions(
          args.scope,
          args.scope === 'screen-read' ? 'capture_screen' : 'activate_app'
        );
        assertTaskAuthorizationLive(authorization);
        const { mode: permissionMode } = await authorizeTask(
          sender,
          args,
          target,
          classification,
          reservation
        );
        await authorizeTarget(
          sender,
          args,
          target,
          classification,
          permissionMode,
          authorization
        );
        if (browserOrigin && !authorization.browserOrigins.has(browserOrigin)) {
          const approved = await withApprovalPaused(authorization, 'browser-origin', () => requestBrowserSiteApproval({
            sender,
            target,
            origin: browserOrigin,
            conversationId: args.conversationId,
            loopId: args.loopId,
            toolCallId: args.toolCallId,
          }));
          if (!approved) {
            revokeTask(sender, taskKey(args));
            throw new Error(`Browser Computer Use site approval was not granted for "${browserOrigin}"`);
          }
          assertTaskAuthorizationLive(authorization);
          authorization.browserOrigins.add(browserOrigin);
        }
        assertTaskAuthorizationLive(authorization);
        await ensureInputLease(authorization);
        // Authorized — everything that could refuse this action has now run,
        // so the step is real and the task pays for it.
        chargeTaskBudget(taskKey(args));
        const token = tokenFactory();
        const expiresAt = now() + SESSION_TTL_MS;
        const authorizedTarget = describeAuthorizedTarget(sender, taskKey(args), target, args?.windowRef);
        sessions.set(token, {
          sender,
          taskKey: taskKey(args),
          authorization,
          conversationId: args.conversationId,
          toolCallId: args.toolCallId,
          loopId: typeof args.loopId === 'string' ? args.loopId : null,
          scope: args.scope,
          target,
          windowRef: authorizedTarget.window_ref,
          classification,
          permissionMode,
          actionIntent,
          expectedStateId: typeof args?.expectedStateId === 'string'
            ? args.expectedStateId
            : null,
          browserOrigin,
          consequenceAttempted: false,
          expiresAt,
        });
        return {
          status: 'authorized',
          token,
          target: authorizedTarget,
          classification,
          expires_at: expiresAt,
        };
      } catch (error) {
        if (
          activeTask === authorization
          && !taskLeases.has(authorization.key)
        ) {
          activeTask = null;
        }
        throw error;
      }
    }

    if (cmd === 'computer_use_end_task') {
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.loopId, 'loopId');
      if (revokeTask(sender, taskKey(args))) {
        noteComputerUseTrajectory(taskKey(args), 'turn-ended', { reason: 'task-ended' });
        killNativeHelper();
      }
      return { ended: true };
    }

    if (cmd === 'computer_use_stop_turn') {
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.loopId, 'loopId');
      const key = taskKey(args);
      const marker = markTurnStopped(key, args?.reason);
      const revoked = revokeTask(sender, key);
      if (revoked) killNativeHelper(`turn-stopped:${marker?.reason || 'stopped'}`);
      return {
        stopped: true,
        reason: marker?.reason || 'stopped',
        persisted: marker?.persisted === true,
      };
    }

    if (cmd === 'computer_use_get_task_status') {
      assertShortId(args?.conversationId, 'conversationId');
      assertShortId(args?.loopId, 'loopId');
      const key = taskKey(args);
      const ledger = taskAttemptLedgers.get(key);
      if (ledger && ledger.sender !== sender) {
        throw new Error('Computer Use task status belongs to another sender');
      }
      const stopMarker = turnStopStore?.get?.(key) ?? null;
      return {
        active: activeTask?.sender === sender && activeTask.key === key,
        stopped: Boolean(stopMarker || ledger?.stoppedReason),
        stopped_reason: stopMarker?.reason || ledger?.stoppedReason || null,
        outcome_unknown_receipt: ledger?.outcomeUnknownReceipt ?? null,
      };
    }

    if (cmd === 'computer_use_end_session') {
      const token = args?.[COMPUTER_USE_TOKEN_ARG];
      const session = getSession(sender, args);
      if (typeof token === 'string') sessions.delete(token);
      return { ended: true, target: session.target };
    }

    if (COMPUTER_USE_PROBE_COMMANDS.has(cmd)) {
      return nativeDispatch(cmd, stripToken(args));
    }

    if (COMPUTER_USE_CLEANUP_COMMANDS.has(cmd)) {
      if (typeof args?.sessionId === 'string') {
        axSessions.delete(args.sessionId);
        for (const [key, state] of computerStates) {
          if (state.sender === sender && state.axSessionId === args.sessionId) {
            computerStates.delete(key);
          }
        }
      }
      return nativeDispatch(cmd, stripToken(args));
    }

    const session = getSession(sender, args);
    assertScope(session, cmd);
    if (cmd === 'ax_snapshot') {
      assertObservationAllowed(sender, session.taskKey);
    }
    await assertOsPermissions(session.scope, cmd);
    await assertCommandTarget(session, cmd, args);
    if (COMPUTER_USE_CONTROL_COMMANDS.has(cmd) && cmd !== 'activate_app') {
      await assertBrowserOriginCurrent(session);
    }
    assertSafeKeyboardCommand(platform, cmd, args);
    const axSession = typeof args?.sessionId === 'string'
      ? axSessions.get(args.sessionId)
      : null;
    if (axSession && ['ax_press', 'ax_set_value', 'ax_replace_text', 'ax_perform_action'].includes(cmd)) {
      observability.noteComputerUseCache?.(
        'uia-element',
        true,
        axSession.accessibilityRevision,
      );
    }
    const statefulCommand = COMPUTER_USE_CONTROL_COMMANDS.has(cmd)
      && cmd !== 'activate_app';
    let preActionState = null;
    if (statefulCommand) {
      preActionState = assertComputerState(
        sender,
        session.taskKey,
        session.target,
        session.expectedStateId,
        false
      );
      assertTaskAttemptAllowed(sender, session.taskKey);
    }
    const consequence = resolveConsequence(session, cmd, args, axSession);
    let consumedState = null;
    let attemptLedger = null;
    if (consequence) {
      if (session.consequenceAttempted) {
        throw new Error('Computer Use consequential action authorization was already used');
      }
      // Reserve the task while native approval is visible. Otherwise a second
      // session could mutate the same window while the user is reviewing the
      // exact consequence, invalidating what they approved.
      attemptLedger = beginUnverifiedTaskAttempt(sender, session, cmd, true);
      try {
        const approved = await withApprovalPaused(
          session.authorization,
          'action',
          () => requestActionApproval({
            sender,
            target: session.target,
            action: session.actionIntent.action,
            consequence,
            permissionMode: session.permissionMode,
            conversationId: session.conversationId,
            loopId: session.loopId,
            toolCallId: session.toolCallId,
          }),
        );
        if (!approved) {
          throw new Error(`Computer Use consequential action was not approved for "${session.target.app_name}"`);
        }
        assertTaskAuthorizationLive(session.authorization);
        await assertOsPermissions(session.scope, cmd);
        await restoreWindowsFocusForAction(session, preActionState);
        await assertCommandTarget(session, cmd, args);
      } catch (error) {
        // No native side effect was attempted, so a rejected, cancelled, or
        // stale approval releases the Windows task reservation for a safe retry.
        completeUnverifiedTaskAttempt(attemptLedger);
        throw error;
      }
      // Mark before dispatch. If native input reports an ambiguous failure, a
      // renderer fallback must not repeat a potentially completed side effect.
      session.consequenceAttempted = true;
      completeUnverifiedTaskAttempt(attemptLedger);
      attemptLedger = null;
    }
    if (statefulCommand) {
      if (!consequence) {
        await restoreWindowsFocusForAction(session, preActionState);
        await assertCommandTarget(session, cmd, args);
      }
      await revalidateWindowsUiState(session, preActionState);
    }
    if (statefulCommand) {
      consumedState = assertComputerState(
        sender,
        session.taskKey,
        session.target,
        session.expectedStateId,
        true
      );
      attemptLedger = beginTaskAttempt(
        sender,
        session,
        cmd,
        consumedState,
        Boolean(consequence),
      );
    }
    const nativeArgs = stripToken(args);
    delete nativeArgs.expectedStateId;
    nativeArgs[COMPUTER_USE_REQUEST_CONTEXT_ARG] = nativeRequestContext(session);
    if (
      platform === 'win32'
      && consumedState
      && (cmd.startsWith('mouse_') || cmd.startsWith('keyboard_') || cmd === 'ax_replace_text')
    ) {
      nativeArgs.expectedInputEpoch = consumedState.inputEpoch;
      nativeArgs.expectedWindowId = consumedState.windowId;
    }
    if (
      cmd.startsWith('mouse_')
      || cmd.startsWith('keyboard_')
      || cmd === 'ax_replace_text'
      || (cmd.startsWith('capture_screen') && session.scope === 'ui-control')
      || cmd === 'ax_snapshot'
    ) {
      nativeArgs.expectedBundleId = session.target.bundle_id;
      nativeArgs.expectedProcessId = session.target.process_id;
      if (typeof session.target.window_id === 'string') {
        nativeArgs.expectedWindowId = session.target.window_id;
      }
    }
    let result;
    let actionLeaseActivated = false;
    try {
      if (statefulCommand && consumedState) {
        actionLeaseActivated = await activateInputLeaseForAction(session, consumedState);
      }
      try {
        if (platform === 'win32' && cmd === 'activate_app' && typeof session.target.window_id === 'string') {
          // The model's app name cannot reselect a same-process sibling after
          // authorization. Activate only the already validated exact HWND.
          assertTaskAuthorizationLive(session.authorization);
          const window = await nativeDispatch('activate_window', {
            windowId: session.target.window_id,
            [COMPUTER_USE_REQUEST_CONTEXT_ARG]: nativeRequestContext(session),
          });
          assertTaskAuthorizationLive(session.authorization);
          const activated = normalizeIdentity({ ...window, bundle_id: window?.bundle_id ?? window?.app_id });
          assertSameTarget(session, activated);
          result = activated.app_name;
        } else {
          result = await nativeDispatch(cmd, nativeArgs);
        }
      } catch (error) {
        const owner = cmd === 'ax_snapshot' ? await resolveClosedWindowOwner(session, error) : null;
        if (!owner) throw error;
        session.target = owner;
        nativeArgs.expectedBundleId = owner.bundle_id;
        nativeArgs.expectedProcessId = owner.process_id;
        nativeArgs.expectedWindowId = owner.window_id;
        nativeArgs[COMPUTER_USE_REQUEST_CONTEXT_ARG] = nativeRequestContext(session);
        result = await nativeDispatch(cmd, nativeArgs);
        assertTaskAuthorizationLive(session.authorization);
      }
    } catch (error) {
      if (platform === 'win32' && cmd === 'ax_snapshot' && isManualHandoffError(error)) {
        computerStates.delete(session.taskKey);
        return {
          app: session.target.app_name,
          elements: [],
          modal: true,
          modal_window_id: null,
          target: describeAuthorizedTarget(sender, session.taskKey, session.target),
          related_windows: [],
          protocol_error: manualHandoffProtocolError(),
        };
      }
      if (statefulCommand) {
        observability.noteComputerUseInputRejected?.(classifyInputRejection(error));
      }
      const receipt = failTaskAttempt(attemptLedger);
      if (receipt) {
        throw new Error(
          `Computer Use outcome is unknown after '${cmd}'; automatic replay is blocked: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    } finally {
      if (consumedState) consumedState.actionInFlight = false;
      if (actionLeaseActivated && activeTask === session.authorization) {
        try {
          await observeInputLeaseAfterAction(session);
        } catch (error) {
          const receipt = failTaskAttempt(attemptLedger);
          revokeTask(sender, session.taskKey, { preserveAttemptLedger: Boolean(receipt) });
          killNativeHelper('input-lease-observe-failed');
          if (receipt) {
            throw new Error(
              `Computer Use outcome is unknown after '${cmd}'; automatic replay is blocked: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          throw error;
        }
      }
    }
    if (COMPUTER_USE_READ_COMMANDS.has(cmd)) {
      await commitInputLeaseAfterObservation(session, result);
    }
    if (cmd === 'ax_snapshot' && typeof result?.session_id === 'string') {
      if (
        platform === 'win32'
        && (!Number.isSafeInteger(result.input_epoch) || result.input_epoch < 1)
      ) {
        throw new Error('Windows UIA observation did not include a valid physical-input epoch');
      }
      const windowGraphRevision = hashWindowGraph(result.window_graph);
      const sanitizedResult = sanitizeWindowsObservation(sender, session, result);
      if (sanitizedResult?.protocol_error) {
        computerStates.delete(session.taskKey);
        return sanitizedResult;
      }
      axSessions.set(result.session_id, {
        sender,
        bundleId: session.target.bundle_id,
        taskKey: session.taskKey,
        helperGeneration: getNativeHelperGeneration(),
        inputEpoch: result.input_epoch,
        windowId: result.window_id,
        accessibilityRevision: result.accessibility_revision,
        focusedElementId: Number.isInteger(result.focused_element_id)
          ? result.focused_element_id
          : null,
        modal: result.modal === true,
        modalWindowId: result.modal_window_id ?? null,
        windowGraphRevision,
        observedOwners: platform === 'win32' ? observedOwnerChain(session, result) : [],
        elements: sanitizeAxElements(result),
        browserOrigin: isBrowserIdentity(platform, session.target)
          ? resolveBrowserOriginFromSnapshot(result)
          : null,
        // Full AX values are reduced to an in-memory digest at the Host
        // boundary. This catches value-only UI changes without retaining or
        // logging labels, field values, or other user content.
        fingerprint: hashAxElements(result.elements, result.modal_window_id ?? null),
        createdAt: now(),
      });
      observability.noteComputerUseObservation?.({
        accessibilityRevision: result.accessibility_revision,
        inputEpoch: result.input_epoch,
      });
      const stateId = stateIdFactory({
        sender,
        taskKey: session.taskKey,
        target: session.target,
        axSessionId: result.session_id,
      });
      computerStates.set(session.taskKey, {
        sender,
        stateId,
        target: session.target,
        axSessionId: result.session_id,
        helperGeneration: getNativeHelperGeneration(),
        inputEpoch: result.input_epoch,
        windowId: result.window_id,
        accessibilityRevision: result.accessibility_revision,
        consumed: false,
        actionInFlight: false,
        expiresAt: now() + COMPUTER_STATE_TTL_MS,
      });
      noteComputerUseTrajectory(session.taskKey, 'observation', {
        outcome: 'success',
        stateId,
        windowGraphRevision,
        helperGeneration: getNativeHelperGeneration(),
      });
      const verificationReceipt = completeTaskAttempt(
        sender,
        session.taskKey,
        stateId,
        result.elements,
        result.modal_window_id ?? null,
      );
      return {
        ...sanitizedResult,
        state_id: stateId,
        ...(windowGraphRevision ? { window_graph_revision: windowGraphRevision } : {}),
        ...(verificationReceipt ? { verification_receipt: verificationReceipt } : {}),
      };
    }
    if (cmd.startsWith('capture_screen') && result && typeof result === 'object') {
      observability.noteComputerUseObservation?.({
        snapshotRevision: result.snapshot_revision,
        zIndex: result.z_index,
      });
    }
    return result;
  }

  function teardown() {
    trajectoryRecorder.clear();
    sessions.clear();
    axSessions.clear();
    computerStates.clear();
    taskAttemptLedgers.clear();
    taskGrants.clear();
    taskLeases.clear();
    taskBudgets.clear();
    turnTargetSnapshots.clear();
    windowRegistry.clear();
    activeTask = null;
    killNativeHelper();
  }

  return {
    dispatch,
    revokeSender,
    handleNativeHelperEvent,
    teardown,
    classifyIdentity: (identity) => identityClassification(normalizeIdentity(identity)),
  };
}

module.exports = {
  createComputerUseGate,
  resolveBrowserOriginFromSnapshot,
  COMPUTER_USE_GATE_MISS,
  SESSION_TTL_MS,
  TASK_GRANT_TTL_MS,
  COMPUTER_STATE_TTL_MS,
  MAX_TASK_CU_STEPS,
  MAX_TASK_CU_DURATION_MS,
  NO_PROGRESS_BEFORE_RECOVERY,
  NO_PROGRESS_AFTER_RECOVERY,
  decideNoProgress,
  normalizeIdentity,
  classifyIdentity,
};
