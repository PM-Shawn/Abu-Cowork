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

const COMPUTER_USE_GATE_MISS = Symbol('computer-use-gate-miss');
const SESSION_TTL_MS = 2 * 60 * 1000;
const TASK_GRANT_TTL_MS = 30 * 60 * 1000;
const VALID_SCOPES = new Set(['screen-read', 'ui-control']);
const VALID_PERMISSION_MODES = new Set(['standard', 'smart', 'autonomous']);
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
    killNativeHelper = () => {},
    requestAppApproval = async () => false,
    requestTaskApproval = async () => false,
    platform = process.platform,
    now = () => Date.now(),
    tokenFactory = () => crypto.randomBytes(32).toString('base64url'),
  } = options;
  const enabledSenders = new WeakSet();
  const sessions = new Map();
  const axSessions = new Map();
  const taskGrants = new Map();
  const taskLeases = new Map();
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
    for (const [key, grant] of taskGrants) {
      if (grant.sender === sender) {
        taskGrants.delete(key);
        revoked = true;
      }
    }
    for (const [key, lease] of taskLeases) {
      if (lease.sender === sender) {
        taskLeases.delete(key);
        revoked = true;
      }
    }
    if (activeTask?.sender === sender) {
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
        if (activeTask === lease.authorization) {
          activeTask = null;
          killNativeHelper();
        }
      }
    }
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
    const lease = taskLeases.get(key);
    if (lease?.sender === sender) {
      taskLeases.delete(key);
      revoked = true;
    }
    if (activeTask?.sender === sender && activeTask.key === key) {
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
      if (axSession.bundleId !== session.target.bundle_id) {
        throw new Error('Accessibility session belongs to a different app');
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
      if (typeof args?.sessionId === 'string') axSessions.delete(args.sessionId);
      return nativeDispatch(cmd, stripToken(args));
    }

    const session = getSession(sender, args);
    assertScope(session, cmd);
    await assertOsPermissions(session.scope, cmd);
    await assertCommandTarget(session, cmd, args);
    const nativeArgs = stripToken(args);
    if (
      cmd.startsWith('mouse_')
      || cmd.startsWith('keyboard_')
      || (cmd.startsWith('capture_screen') && session.scope === 'ui-control')
    ) {
      nativeArgs.expectedBundleId = session.target.bundle_id;
      nativeArgs.expectedProcessId = session.target.process_id;
    }
    const result = await nativeDispatch(cmd, nativeArgs);
    if (cmd === 'ax_snapshot' && typeof result?.session_id === 'string') {
      axSessions.set(result.session_id, {
        sender,
        bundleId: session.target.bundle_id,
        taskKey: session.taskKey,
        createdAt: now(),
      });
    }
    return result;
  }

  function teardown() {
    sessions.clear();
    axSessions.clear();
    taskGrants.clear();
    taskLeases.clear();
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
  normalizeIdentity,
  classifyIdentity,
};
