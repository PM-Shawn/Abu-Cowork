'use strict';

const crypto = require('node:crypto');
const policy = require('../src/core/tools/computerUsePolicy.json');
const {
  COMPUTER_USE_TOKEN_ARG,
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
const NO_PROGRESS_BEFORE_RECOVERY = 3;
const NO_PROGRESS_AFTER_RECOVERY = 2;
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
  return { app_name: appName, bundle_id: bundleId, process_id: processId };
}

function policyForPlatform(platform) {
  return platform === 'win32' ? policy.windows : policy.macos;
}

function classifyIdentity(platform, identity) {
  const platformPolicy = policyForPlatform(platform);
  const key = platform === 'win32'
    ? identity.bundle_id.toLowerCase()
    : identity.bundle_id;
  if (platformPolicy.hardDeny.some((value) => (
    value.toLowerCase() === key.toLowerCase()
  ))) {
    return 'hard-deny';
  }
  if (platformPolicy.approvalRequired.some((value) => (
    value.toLowerCase() === key.toLowerCase()
  ))) {
    return 'approval-required';
  }
  if (platformPolicy.ordinaryAllow.some((value) => (
    value.toLowerCase() === key.toLowerCase()
  ))) {
    return 'ordinary';
  }
  // An installed app can expose credentials, a shell, or consequential
  // actions even when Abu has never seen its identity before. Unknown apps
  // therefore require a task-local user decision in every autonomy mode.
  return 'approval-required';
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
    platform = process.platform,
    now = () => Date.now(),
    tokenFactory = () => crypto.randomBytes(32).toString('base64url'),
    stateIdFactory = () => `cu-${crypto.randomBytes(18).toString('base64url')}`,
  } = options;
  const enabledSenders = new WeakSet();
  const sessions = new Map();
  const axSessions = new Map();
  const computerStates = new Map();
  const taskAttemptLedgers = new Map();
  const taskGrants = new Map();
  const taskLeases = new Map();
  /**
   * taskKey → { stepCount, deadlineAt }. Deliberately a sibling map rather
   * than a field on the lease: a lease is only written once `authorizeTask`
   * succeeds, but the DEADLINE has to start running from the first attempt,
   * or a task could sit in an approval round-trip for free. The step count
   * is charged separately, only for actions that were actually authorized —
   * see `assertTaskBudgetAvailable` / `chargeTaskBudget`. Torn down
   * everywhere a lease is (`revokeSender`, `pruneExpired`, `revokeTask`), so
   * a finished task's budget never outlives it.
   */
  const taskBudgets = new Map();
  let activeTask = null;

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
  }

  function getTaskAttemptLedger(sender, key) {
    let ledger = taskAttemptLedgers.get(key);
    if (!ledger) {
      ledger = {
        sender,
        attemptCount: 0,
        consecutiveNoChange: 0,
        recoveryUsed: false,
        stoppedReason: null,
        pendingAttempt: null,
      };
      taskAttemptLedgers.set(key, ledger);
    }
    if (ledger.sender !== sender) {
      throw new Error('Computer Use task attempt ledger belongs to another sender');
    }
    return ledger;
  }

  function hashAxElements(elements) {
    const normalized = elements instanceof Map
      ? Array.from(elements.entries())
      : Array.isArray(elements)
        ? elements
        : [];
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
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
    };
    return ledger;
  }

  function failTaskAttempt(ledger) {
    if (!ledger?.pendingAttempt) return;
    if (ledger.pendingAttempt.consequential) {
      ledger.stoppedReason = 'stop-ambiguous-side-effect';
    }
  }

  function beginUnverifiedTaskAttempt(sender, session, cmd, consequential) {
    const ledger = assertTaskAttemptAllowed(sender, session.taskKey);
    ledger.attemptCount += 1;
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

  function completeTaskAttempt(sender, key, stateId, elements) {
    const ledger = getTaskAttemptLedger(sender, key);
    const attempt = ledger.pendingAttempt;
    if (!attempt) return null;
    const changed = attempt.beforeFingerprint !== hashAxElements(elements);
    let decision = 'continue';
    if (changed) {
      ledger.consecutiveNoChange = 0;
    } else {
      ledger.consecutiveNoChange += 1;
      const threshold = ledger.recoveryUsed
        ? NO_PROGRESS_AFTER_RECOVERY
        : NO_PROGRESS_BEFORE_RECOVERY;
      if (ledger.consecutiveNoChange >= threshold) {
        if (!ledger.recoveryUsed) {
          ledger.recoveryUsed = true;
          ledger.consecutiveNoChange = 0;
          decision = 'recover';
        } else {
          ledger.stoppedReason = 'stop-no-progress';
          decision = ledger.stoppedReason;
        }
      }
    }
    if (ledger.stoppedReason === 'stop-ambiguous-side-effect') {
      decision = ledger.stoppedReason;
    }
    ledger.pendingAttempt = null;
    return {
      attempt_count: attempt.attemptCount,
      command: attempt.command,
      before_state_id: attempt.beforeStateId,
      after_state_id: stateId,
      status: changed ? 'verified-change' : 'no-change',
      decision,
      consecutive_no_change: ledger.consecutiveNoChange,
      recovery_used: ledger.recoveryUsed,
    };
  }

  async function resolveTarget(targetApp) {
    if (typeof targetApp === 'string' && targetApp.trim()) {
      if (platform === 'darwin') {
        return normalizeIdentity(await nativeDispatch('resolve_app_identity', {
          appName: targetApp.trim(),
        }));
      }
      const active = normalizeIdentity(await getActiveWindow());
      if (
        active.app_name.toLowerCase() !== targetApp.trim().toLowerCase()
        && active.bundle_id.toLowerCase() !== targetApp.trim().toLowerCase()
      ) {
        throw new Error('On Windows, the requested Computer Use app must already be foreground');
      }
      return active;
    }
    return normalizeIdentity(await getActiveWindow());
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
    const classification = classifyIdentity(platform, identity);
    if (classification === 'hard-deny') {
      throw new Error(`Computer Use is blocked for sensitive app "${identity.app_name}"`);
    }
    return classification;
  }

  function taskKey(args) {
    return `${args.conversationId}\u0000${args.loopId}`;
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

  /**
   * The task's budget, created on first reservation and REUSED on every
   * re-entry. `deadlineAt` is stamped once here and never recomputed: a task
   * that keeps starting fresh batches must not be able to walk its own clock
   * forward, which is exactly how the renderer-side budget was defeated.
   */
  function ensureTaskBudget(key) {
    let budget = taskBudgets.get(key);
    if (!budget) {
      budget = { stepCount: 0, deadlineAt: now() + MAX_TASK_CU_DURATION_MS };
      taskBudgets.set(key, budget);
    }
    return budget;
  }

  /**
   * Refuse an over-budget task. Checked BEFORE the reservation, so a task
   * that has nothing left cannot re-take the global single-flight
   * reservation after `pruneExpired` drops its lapsed lease.
   */
  function assertTaskBudgetAvailable(key) {
    const budget = ensureTaskBudget(key);
    if (now() > budget.deadlineAt) {
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
    ensureTaskBudget(key).stepCount += 1;
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
    const authorization = { key, sender };
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
        const approved = await requestTaskApproval({
          sender,
          target,
          classification,
          mode,
          conversationId: args.conversationId,
          loopId: args.loopId,
        });
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

    const approved = await requestAppApproval({
      sender,
      target,
      classification,
      scope: args.scope,
      permissionMode: mode,
      conversationId: args.conversationId,
      loopId: typeof args.loopId === 'string' ? args.loopId : null,
      toolCallId: args.toolCallId,
    });
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

  function revokeTask(sender, key) {
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
    if (taskAttemptLedgers.delete(key)) revoked = true;
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
    return revoked;
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
      const requested = await resolveTarget(args?.appName);
      assertIdentityAllowed(requested);
      assertSameTarget(session, requested);
      return;
    }
    if (cmd === 'ax_snapshot') {
      const requested = await resolveTarget(args?.appName);
      assertIdentityAllowed(requested);
      assertSameTarget(session, requested);
      return;
    }
    if (cmd === 'ax_press' || cmd === 'ax_set_value' || cmd === 'ax_perform_action') {
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
    assertSameTarget(session, active);
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
      // Refuse an over-budget task before it can take the reservation; the
      // step itself is charged only once the action is authorized, further
      // down. (Single-flight is unchanged either way: a task holds its
      // reservation until `computer_use_end_task`, as always.)
      assertTaskBudgetAvailable(taskKey(args));
      const reservation = reserveTaskAuthorization(sender, args);
      const { authorization } = reservation;
      try {
        const target = args.scope === 'screen-read'
          ? SCREEN_READ_TARGET
          : await resolveTarget(args?.targetApp);
        assertTaskAuthorizationLive(authorization);
        const classification = args.scope === 'screen-read'
          ? 'ordinary'
          : assertIdentityAllowed(target);
        if (
          platform !== 'win32'
          && args.scope === 'ui-control'
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
        assertTaskAuthorizationLive(authorization);
        // Authorized — everything that could refuse this action has now run,
        // so the step is real and the task pays for it.
        chargeTaskBudget(taskKey(args));
        const token = tokenFactory();
        const expiresAt = now() + SESSION_TTL_MS;
        sessions.set(token, {
          sender,
          taskKey: taskKey(args),
          authorization,
          conversationId: args.conversationId,
          toolCallId: args.toolCallId,
          loopId: typeof args.loopId === 'string' ? args.loopId : null,
          scope: args.scope,
          target,
          classification,
          permissionMode,
          actionIntent,
          expectedStateId: typeof args?.expectedStateId === 'string'
            ? args.expectedStateId
            : null,
          consequenceAttempted: false,
          expiresAt,
        });
        return { token, target, classification, expires_at: expiresAt };
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
      if (revokeTask(sender, taskKey(args))) killNativeHelper();
      return { ended: true };
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
    await assertOsPermissions(session.scope, cmd);
    await assertCommandTarget(session, cmd, args);
    const axSession = typeof args?.sessionId === 'string'
      ? axSessions.get(args.sessionId)
      : null;
    const statefulCommand = platform !== 'win32'
      && COMPUTER_USE_CONTROL_COMMANDS.has(cmd)
      && cmd !== 'activate_app';
    const windowsControlCommand = platform === 'win32'
      && COMPUTER_USE_CONTROL_COMMANDS.has(cmd);
    if (statefulCommand) {
      assertComputerState(
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
    if (windowsControlCommand) {
      // Every Windows control command takes the same task mutex. Reserving only
      // consequential actions leaves the reverse race open: an already-in-flight
      // scroll/type can mutate the UI while a later coordinate approval is shown.
      attemptLedger = beginUnverifiedTaskAttempt(
        sender,
        session,
        cmd,
        Boolean(consequence),
      );
    }
    if (consequence) {
      if (session.consequenceAttempted) {
        completeUnverifiedTaskAttempt(attemptLedger);
        throw new Error('Computer Use consequential action authorization was already used');
      }
      try {
        const approved = await requestActionApproval({
          sender,
          target: session.target,
          action: session.actionIntent.action,
          consequence,
          permissionMode: session.permissionMode,
          conversationId: session.conversationId,
          loopId: session.loopId,
          toolCallId: session.toolCallId,
        });
        if (!approved) {
          throw new Error(`Computer Use consequential action was not approved for "${session.target.app_name}"`);
        }
        assertTaskAuthorizationLive(session.authorization);
        await assertOsPermissions(session.scope, cmd);
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
    } else if (consequence && !attemptLedger) {
      // Windows keeps its legacy visual control path without macOS AX
      // state_id, but consequential failures still need the same task-level
      // ambiguous-side-effect lock and in-flight serialization.
      attemptLedger = beginUnverifiedTaskAttempt(sender, session, cmd, true);
    }
    const nativeArgs = stripToken(args);
    delete nativeArgs.expectedStateId;
    if (
      cmd.startsWith('mouse_')
      || cmd.startsWith('keyboard_')
      || (cmd.startsWith('capture_screen') && session.scope === 'ui-control')
      || cmd === 'ax_snapshot'
    ) {
      nativeArgs.expectedBundleId = session.target.bundle_id;
      nativeArgs.expectedProcessId = session.target.process_id;
    }
    let result;
    try {
      result = await nativeDispatch(cmd, nativeArgs);
    } catch (error) {
      failTaskAttempt(attemptLedger);
      if (windowsControlCommand && !consequence) {
        // A failed navigation/draft-edit command is safe to retry. Only an
        // uncertain consequential side effect permanently stops the task.
        completeUnverifiedTaskAttempt(attemptLedger);
      }
      throw error;
    } finally {
      if (consumedState) consumedState.actionInFlight = false;
    }
    if (windowsControlCommand) {
      completeUnverifiedTaskAttempt(attemptLedger);
    }
    if (cmd === 'ax_snapshot' && typeof result?.session_id === 'string') {
      axSessions.set(result.session_id, {
        sender,
        bundleId: session.target.bundle_id,
        taskKey: session.taskKey,
        helperGeneration: getNativeHelperGeneration(),
        elements: sanitizeAxElements(result),
        // Full AX values are reduced to an in-memory digest at the Host
        // boundary. This catches value-only UI changes without retaining or
        // logging labels, field values, or other user content.
        fingerprint: hashAxElements(result.elements),
        createdAt: now(),
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
        consumed: false,
        actionInFlight: false,
        expiresAt: now() + COMPUTER_STATE_TTL_MS,
      });
      const verificationReceipt = completeTaskAttempt(
        sender,
        session.taskKey,
        stateId,
        result.elements,
      );
      return {
        ...result,
        state_id: stateId,
        ...(verificationReceipt ? { verification_receipt: verificationReceipt } : {}),
      };
    }
    return result;
  }

  function teardown() {
    sessions.clear();
    axSessions.clear();
    computerStates.clear();
    taskAttemptLedgers.clear();
    taskGrants.clear();
    taskLeases.clear();
    taskBudgets.clear();
    activeTask = null;
    killNativeHelper();
  }

  return {
    dispatch,
    revokeSender,
    teardown,
    classifyIdentity: (identity) => classifyIdentity(platform, normalizeIdentity(identity)),
  };
}

module.exports = {
  createComputerUseGate,
  COMPUTER_USE_GATE_MISS,
  SESSION_TTL_MS,
  TASK_GRANT_TTL_MS,
  COMPUTER_STATE_TTL_MS,
  MAX_TASK_CU_STEPS,
  MAX_TASK_CU_DURATION_MS,
  NO_PROGRESS_BEFORE_RECOVERY,
  NO_PROGRESS_AFTER_RECOVERY,
  normalizeIdentity,
  classifyIdentity,
};
