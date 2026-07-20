/**
 * agentLoopRunner.ts — P1-3b-2 channel plumbing (registry, reverse-channel
 * handlers, push emitters, LoopContext-lite construction). DORMANT machinery
 * — every test here exercises the module directly (capturing the handler
 * functions passed to the mocked onSidecarNotification/onSidecarRequest),
 * since nothing in production wires it up yet.
 *
 * Every test dynamically re-imports the module fresh (vi.resetModules()),
 * same isolation discipline as subagentRunner.test.ts — module-level
 * `sessions`/`handlersRegistered`/`emittersInstalled` state must not leak
 * across tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocked dependencies ─────────────────────────────────────────────────

const onSidecarNotification = vi.fn();
const onSidecarRequest = vi.fn();
const notifySidecar = vi.fn();
class MockSidecarRequestError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
vi.mock('../sidecar/sidecarManager', () => ({
  onSidecarNotification: (...a: unknown[]) => onSidecarNotification(...a),
  onSidecarRequest: (...a: unknown[]) => onSidecarRequest(...a),
  notifySidecar: (...a: unknown[]) => notifySidecar(...a),
  SidecarRequestError: MockSidecarRequestError,
}));

const applyDeltaFramesMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./frameApplier', () => ({
  applyDeltaFrames: (...a: unknown[]) => applyDeltaFramesMock(...a),
}));

vi.mock('./ports/executionPort', () => ({
  getExecutionPort: () => ({ marker: 'execution-port-stub' }),
}));

const appendToolCallContextMock = vi.fn();
vi.mock('./ports/chatDelta', () => ({
  getChatDelta: () => ({ appendToolCallContext: (...a: unknown[]) => appendToolCallContextMock(...a) }),
}));

const scratchpadAddEntryMock = vi.fn();
vi.mock('./ports/scratchpadPort', () => ({
  getScratchpadPort: () => ({ addEntry: (...a: unknown[]) => scratchpadAddEntryMock(...a) }),
}));

const recordMaxOutputTokensMock = vi.fn();
const recordContextWindowMock = vi.fn();
const recordReasoningObservedMock = vi.fn();
vi.mock('./ports/capsPort', () => ({
  getCapsPort: () => ({
    recordMaxOutputTokens: (...a: unknown[]) => recordMaxOutputTokensMock(...a),
    recordContextWindow: (...a: unknown[]) => recordContextWindowMock(...a),
    recordReasoningObserved: (...a: unknown[]) => recordReasoningObservedMock(...a),
  }),
}));

const getAllToolsMock = vi.fn().mockReturnValue([
  { name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} }, execute: async () => 'x' },
]);
vi.mock('./ports/toolInvoker', () => ({
  getToolInvoker: () => ({ getAllTools: (...a: unknown[]) => getAllToolsMock(...a) }),
}));

const getSettingsSnapshotMock = vi.fn().mockReturnValue({ agentMaxTurns: 200 });
vi.mock('./ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => getSettingsSnapshotMock() }),
}));

vi.mock('./subagentRunner', () => ({
  toSerializableTool: (t: { name: string; description: string; inputSchema: unknown }) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }),
}));

const createEventRouterMock = vi.fn((...a: unknown[]) => ({ __eventRouterStub: true, deps: a[0], locale: a[1] }));
vi.mock('./eventRouter', () => ({
  createEventRouter: (...a: unknown[]) => createEventRouterMock(...a),
}));

const requestCommandConfirmationMock = vi.fn().mockResolvedValue(true);
const requestFilePermissionMock = vi.fn().mockResolvedValue(true);
const setLoopContextMock = vi.fn();
const clearLoopContextMock = vi.fn();
const drainConfirmationQueueMock = vi.fn();
const drainFilePermissionQueueMock = vi.fn();
const drainWorkspaceRequestMock = vi.fn();
const drainUserQuestionsMock = vi.fn();
vi.mock('./permissionBridge', () => ({
  // Exported directly (not wrapped) — agentLoopRunner.ts's default-callback
  // fallback (`session.options.requestCommandConfirmation ?? requestCommandConfirmation`)
  // must resolve to THIS exact mock reference so the "uses defaults" test
  // below can assert identity, not just "was called".
  requestCommandConfirmation: requestCommandConfirmationMock,
  requestFilePermission: requestFilePermissionMock,
  setLoopContext: (...a: unknown[]) => setLoopContextMock(...a),
  clearLoopContext: (...a: unknown[]) => clearLoopContextMock(...a),
  drainConfirmationQueue: (...a: unknown[]) => drainConfirmationQueueMock(...a),
  drainFilePermissionQueue: (...a: unknown[]) => drainFilePermissionQueueMock(...a),
  drainWorkspaceRequest: (...a: unknown[]) => drainWorkspaceRequestMock(...a),
  drainUserQuestions: (...a: unknown[]) => drainUserQuestionsMock(...a),
}));

const clearPlanModeMock = vi.fn();
let capturedPlanModeCb: ((conversationId: string, mode: string | null) => void) | undefined;
const onPlanModeChangeMock = vi.fn((cb: (conversationId: string, mode: string | null) => void) => {
  capturedPlanModeCb = cb;
  return () => { capturedPlanModeCb = undefined; };
});
vi.mock('./planMode', () => ({
  clearPlanMode: (...a: unknown[]) => clearPlanModeMock(...a),
  onPlanModeChange: (...a: [(conversationId: string, mode: string | null) => void]) => onPlanModeChangeMock(...a),
}));

const setComputerUseActiveMock = vi.fn();
const setCurrentActionMock = vi.fn();
const incrementComputerUseStepMock = vi.fn();
const pauseComputerUseStatusMock = vi.fn();
const setSessionWindowHiddenMock = vi.fn();
vi.mock('./computerUseStatus', () => ({
  setComputerUseActive: (...a: unknown[]) => setComputerUseActiveMock(...a),
  setCurrentAction: (...a: unknown[]) => setCurrentActionMock(...a),
  incrementComputerUseStep: (...a: unknown[]) => incrementComputerUseStepMock(...a),
  pauseComputerUseStatus: (...a: unknown[]) => pauseComputerUseStatusMock(...a),
  setSessionWindowHidden: (...a: unknown[]) => setSessionWindowHiddenMock(...a),
}));

const setComputerUseBatchModeMock = vi.fn();
const setSkipAutoScreenshotMock = vi.fn();
vi.mock('../tools/builtins', () => ({
  setComputerUseBatchMode: (...a: unknown[]) => setComputerUseBatchModeMock(...a),
  setSkipAutoScreenshot: (...a: unknown[]) => setSkipAutoScreenshotMock(...a),
}));

const notifyTaskCompletedMock = vi.fn().mockResolvedValue(undefined);
const notifyTaskErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/notifications', () => ({
  notifyTaskCompleted: (...a: unknown[]) => notifyTaskCompletedMock(...a),
  notifyTaskError: (...a: unknown[]) => notifyTaskErrorMock(...a),
}));

let capturedSettingsCb: (() => void) | undefined;
const settingsUnsubMock = vi.fn();
const settingsSubscribeMock = vi.fn((cb: () => void) => {
  capturedSettingsCb = cb;
  return settingsUnsubMock;
});
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { subscribe: (...a: [() => void]) => settingsSubscribeMock(...a) },
}));

interface ChatStateStub {
  conversations: Record<string, { workspacePath?: string | null; title?: string; activeSkills?: string[] }>;
  conversationIndex: Record<string, { model?: { providerId: string; modelId: string } }>;
}
let chatState: ChatStateStub = { conversations: {}, conversationIndex: {} };
let capturedChatCb: (() => void) | undefined;
const chatUnsubMock = vi.fn();
const chatSubscribeMock = vi.fn((cb: () => void) => {
  capturedChatCb = cb;
  return chatUnsubMock;
});
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    subscribe: (...a: [() => void]) => chatSubscribeMock(...a),
    getState: () => chatState,
  },
}));

vi.mock('../../i18n', () => ({
  getLocale: () => 'zh-CN',
}));

const isMessageWrittenToDiskMock = vi.fn().mockReturnValue(true);
vi.mock('../session/conversationStorage', () => ({
  isMessageWrittenToDisk: (...a: unknown[]) => isMessageWrittenToDiskMock(...a),
}));

const tauriInvokeMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => tauriInvokeMock(...a),
}));

async function importFresh() {
  vi.resetModules();
  return import('./agentLoopRunner');
}

/** Pull the handler fn registered for a given method out of a mocked onSidecarNotification/onSidecarRequest call list. */
function handlerFor(mock: ReturnType<typeof vi.fn>, method: string): (params: unknown) => unknown {
  const call = mock.mock.calls.find((c) => c[0] === method);
  if (!call) throw new Error(`no handler registered for ${method}`);
  return call[1] as (params: unknown) => unknown;
}

function makeSession(overrides: Partial<{ conversationId: string; loopId: string }> = {}) {
  return {
    conversationId: overrides.conversationId ?? 'conv-1',
    loopId: overrides.loopId ?? 'loop-1',
    options: {},
    shellAbortController: new AbortController(),
    toolCallToStepId: new Map<string, string>(),
  };
}

describe('agentLoopRunner', () => {
  beforeEach(() => {
    onSidecarNotification.mockReset();
    onSidecarRequest.mockReset();
    notifySidecar.mockReset();
    applyDeltaFramesMock.mockReset();
    applyDeltaFramesMock.mockResolvedValue(undefined);
    appendToolCallContextMock.mockReset();
    scratchpadAddEntryMock.mockReset();
    recordMaxOutputTokensMock.mockReset();
    recordContextWindowMock.mockReset();
    recordReasoningObservedMock.mockReset();
    getAllToolsMock.mockClear();
    getSettingsSnapshotMock.mockClear();
    createEventRouterMock.mockClear();
    requestCommandConfirmationMock.mockClear();
    requestFilePermissionMock.mockClear();
    setLoopContextMock.mockReset();
    clearLoopContextMock.mockReset();
    drainConfirmationQueueMock.mockReset();
    drainFilePermissionQueueMock.mockReset();
    drainWorkspaceRequestMock.mockReset();
    drainUserQuestionsMock.mockReset();
    clearPlanModeMock.mockReset();
    onPlanModeChangeMock.mockClear();
    capturedPlanModeCb = undefined;
    setComputerUseActiveMock.mockReset();
    setCurrentActionMock.mockReset();
    incrementComputerUseStepMock.mockReset();
    pauseComputerUseStatusMock.mockReset();
    setSessionWindowHiddenMock.mockReset();
    setComputerUseBatchModeMock.mockReset();
    setSkipAutoScreenshotMock.mockReset();
    notifyTaskCompletedMock.mockClear();
    notifyTaskErrorMock.mockClear();
    settingsSubscribeMock.mockClear();
    settingsUnsubMock.mockReset();
    capturedSettingsCb = undefined;
    chatSubscribeMock.mockClear();
    chatUnsubMock.mockReset();
    capturedChatCb = undefined;
    chatState = { conversations: {}, conversationIndex: {} };
    isMessageWrittenToDiskMock.mockClear();
    tauriInvokeMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Handler registration ──────────────────────────────────────────────

  describe('ensureHandlersRegistered', () => {
    it('registers every handler exactly once across multiple calls', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      ensureHandlersRegistered();
      ensureHandlersRegistered();

      expect(onSidecarNotification).toHaveBeenCalledTimes(6);
      expect(onSidecarRequest).toHaveBeenCalledTimes(3);

      const notifiedMethods = onSidecarNotification.mock.calls.map((c) => c[0]);
      expect(notifiedMethods).toEqual(
        expect.arrayContaining(['agent.delta', 'approval.drain', 'plan.clear', 'caps.record', 'shell.notifyTask', 'cu.setState']),
      );
      const requestedMethods = onSidecarRequest.mock.calls.map((c) => c[0]);
      expect(requestedMethods).toEqual(
        expect.arrayContaining(['native.invoke', 'tool.list', 'session.isMessageWrittenToDisk']),
      );
    });
  });

  // ── agent.delta ────────────────────────────────────────────────────────

  describe('agent.delta handler', () => {
    it('routes to applyDeltaFrames for a known runId', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      const frames = [{ p: 'chat', m: 'appendText', a: ['c1', 'hi'] }];
      handler({ runId: 'run-1', frames });

      await Promise.resolve();
      expect(applyDeltaFramesMock).toHaveBeenCalledWith(frames);
    });

    it('drops silently for an unknown runId (no throw, applyDeltaFrames not called)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      expect(() => handler({ runId: 'no-such-run', frames: [] })).not.toThrow();
      expect(applyDeltaFramesMock).not.toHaveBeenCalled();
    });

    it('drops silently on malformed params', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      expect(() => handler(null)).not.toThrow();
      expect(() => handler({ runId: 123, frames: [] })).not.toThrow();
      expect(applyDeltaFramesMock).not.toHaveBeenCalled();
    });
  });

  // ── approval.drain ─────────────────────────────────────────────────────

  describe('approval.drain handler', () => {
    it.each([
      ['command', () => drainConfirmationQueueMock],
      ['file-permission', () => drainFilePermissionQueueMock],
      ['workspace', () => drainWorkspaceRequestMock],
      ['user-question', () => drainUserQuestionsMock],
    ] as const)('calls the correct drain function for kind=%s', async (kind, getMock) => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'approval.drain');
      handler({ runId: 'run-1', kind });
      expect(getMock()).toHaveBeenCalledTimes(1);
    });

    it('kind="all" drains every queue', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'approval.drain');
      handler({ runId: 'run-1', kind: 'all' });
      expect(drainConfirmationQueueMock).toHaveBeenCalledTimes(1);
      expect(drainFilePermissionQueueMock).toHaveBeenCalledTimes(1);
      expect(drainWorkspaceRequestMock).toHaveBeenCalledTimes(1);
      expect(drainUserQuestionsMock).toHaveBeenCalledTimes(1);
    });

    it('unknown kind is dropped without calling any drain', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'approval.drain');
      handler({ runId: 'run-1', kind: 'bogus' });
      expect(drainConfirmationQueueMock).not.toHaveBeenCalled();
      expect(drainFilePermissionQueueMock).not.toHaveBeenCalled();
      expect(drainWorkspaceRequestMock).not.toHaveBeenCalled();
      expect(drainUserQuestionsMock).not.toHaveBeenCalled();
    });
  });

  // ── plan.clear ─────────────────────────────────────────────────────────

  describe('plan.clear handler', () => {
    it('calls clearPlanMode(conversationId)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'plan.clear');
      handler({ runId: 'run-1', conversationId: 'conv-9' });
      expect(clearPlanModeMock).toHaveBeenCalledWith('conv-9');
    });

    it('drops malformed params without throwing', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'plan.clear');
      expect(() => handler({})).not.toThrow();
      expect(clearPlanModeMock).not.toHaveBeenCalled();
    });
  });

  // ── caps.record ────────────────────────────────────────────────────────

  describe('caps.record handler (allowlist)', () => {
    it('maxOutputTokens field → recordMaxOutputTokens', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'caps.record');
      handler({ providerId: 'p1', modelId: 'm1', field: 'maxOutputTokens', value: 4096 });
      expect(recordMaxOutputTokensMock).toHaveBeenCalledWith('p1', 'm1', 4096);
    });

    it('contextWindow field → recordContextWindow', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'caps.record');
      handler({ providerId: 'p1', modelId: 'm1', field: 'contextWindow', value: 128000 });
      expect(recordContextWindowMock).toHaveBeenCalledWith('p1', 'm1', 128000);
    });

    it('reasoningObserved field → recordReasoningObserved', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'caps.record');
      handler({ providerId: 'p1', modelId: 'm1', field: 'reasoningObserved' });
      expect(recordReasoningObservedMock).toHaveBeenCalledWith('p1', 'm1');
    });

    it('unknown field is dropped without calling any record method', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'caps.record');
      handler({ providerId: 'p1', modelId: 'm1', field: 'bogus', value: 1 });
      expect(recordMaxOutputTokensMock).not.toHaveBeenCalled();
      expect(recordContextWindowMock).not.toHaveBeenCalled();
      expect(recordReasoningObservedMock).not.toHaveBeenCalled();
    });
  });

  // ── shell.notifyTask ───────────────────────────────────────────────────

  describe('shell.notifyTask handler', () => {
    it('kind=completed → notifyTaskCompleted', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'shell.notifyTask');
      handler({ kind: 'completed', title: 'My Task', conversationId: 'conv-1' });
      expect(notifyTaskCompletedMock).toHaveBeenCalledWith('My Task', 'conv-1');
      expect(notifyTaskErrorMock).not.toHaveBeenCalled();
    });

    it('kind=error → notifyTaskError', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'shell.notifyTask');
      handler({ kind: 'error', title: 'My Task', conversationId: 'conv-1' });
      expect(notifyTaskErrorMock).toHaveBeenCalledWith('My Task', 'conv-1');
      expect(notifyTaskCompletedMock).not.toHaveBeenCalled();
    });

    it('unknown kind drops without calling either', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'shell.notifyTask');
      handler({ kind: 'bogus', title: 'My Task' });
      expect(notifyTaskCompletedMock).not.toHaveBeenCalled();
      expect(notifyTaskErrorMock).not.toHaveBeenCalled();
    });
  });

  // ── cu.setState ────────────────────────────────────────────────────────

  describe('cu.setState handler (allowlist)', () => {
    it.each([
      ['setComputerUseBatchMode', [true], () => setComputerUseBatchModeMock],
      ['setSkipAutoScreenshot', [true], () => setSkipAutoScreenshotMock],
      ['setComputerUseActive', [true, 'conv-1'], () => setComputerUseActiveMock],
      ['setCurrentAction', ['clicking'], () => setCurrentActionMock],
      ['incrementComputerUseStep', ['clicking'], () => incrementComputerUseStepMock],
      ['pauseComputerUseStatus', [], () => pauseComputerUseStatusMock],
      ['setSessionWindowHidden', [true], () => setSessionWindowHiddenMock],
    ] as const)('dispatches action=%s to the real function with args', async (action, args, getMock) => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'cu.setState');
      handler({ action, args });
      expect(getMock()).toHaveBeenCalledWith(...args);
    });

    it('unknown action is dropped without calling any function', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'cu.setState');
      handler({ action: 'launchNukes', args: [] });
      expect(setComputerUseActiveMock).not.toHaveBeenCalled();
      expect(setCurrentActionMock).not.toHaveBeenCalled();
    });
  });

  // ── native.invoke ──────────────────────────────────────────────────────

  describe('native.invoke handler (allowlist)', () => {
    it.each(['show_screen_border', 'get_active_window', 'window_hide', 'activate_app', 'run_shell_command'])(
      'allows %s and forwards to the real Tauri invoke',
      async (cmd) => {
        const { ensureHandlersRegistered } = await importFresh();
        ensureHandlersRegistered();
        const handler = handlerFor(onSidecarRequest, 'native.invoke') as (p: unknown) => Promise<unknown>;
        const result = await handler({ cmd, args: { foo: 'bar' } });
        expect(tauriInvokeMock).toHaveBeenCalledWith(cmd, { foo: 'bar' });
        expect(result).toEqual({ ok: true });
      },
    );

    it('blocks a non-allowlisted command with a fail-closed SidecarRequestError, never forwarding', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'native.invoke') as (p: unknown) => Promise<unknown>;
      await expect(handler({ cmd: 'delete_everything', args: {} })).rejects.toThrow(MockSidecarRequestError);
      expect(tauriInvokeMock).not.toHaveBeenCalled();
    });

    it('rejects malformed params (missing cmd)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'native.invoke') as (p: unknown) => Promise<unknown>;
      await expect(handler({})).rejects.toThrow(MockSidecarRequestError);
    });
  });

  // ── tool.list ──────────────────────────────────────────────────────────

  describe('tool.list handler', () => {
    it('returns the serializable tool projection from getToolInvoker().getAllTools()', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'tool.list') as (p: unknown) => Promise<unknown>;
      const result = await handler(undefined);
      expect(result).toEqual([{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} } }]);
    });
  });

  // ── session.isMessageWrittenToDisk ────────────────────────────────────

  describe('session.isMessageWrittenToDisk handler', () => {
    it('dynamically imports conversationStorage and returns its boolean result', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'session.isMessageWrittenToDisk') as (p: unknown) => Promise<unknown>;
      isMessageWrittenToDiskMock.mockReturnValue(true);
      const result = await handler({ conversationId: 'c1', messageId: 'm1' });
      expect(isMessageWrittenToDiskMock).toHaveBeenCalledWith('m1');
      expect(result).toBe(true);
    });

    it('rejects malformed params (missing messageId)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'session.isMessageWrittenToDisk') as (p: unknown) => Promise<unknown>;
      await expect(handler({ conversationId: 'c1' })).rejects.toThrow(MockSidecarRequestError);
    });
  });

  // ── Run-session registry / emitter install-uninstall ──────────────────

  describe('registerRunSession / unregisterRunSession', () => {
    it('installs push emitters on first registration', async () => {
      const { registerRunSession, __getActiveRunSessionCount } = await importFresh();
      expect(settingsSubscribeMock).not.toHaveBeenCalled();
      registerRunSession('run-1', makeSession());
      expect(__getActiveRunSessionCount()).toBe(1);
      expect(settingsSubscribeMock).toHaveBeenCalledTimes(1);
      expect(chatSubscribeMock).toHaveBeenCalledTimes(1);
      expect(onPlanModeChangeMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-install emitters on a second registration', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession());
      registerRunSession('run-2', makeSession({ conversationId: 'conv-2', loopId: 'loop-2' }));
      expect(settingsSubscribeMock).toHaveBeenCalledTimes(1);
    });

    it('uninstalls emitters only once the LAST session unregisters', async () => {
      const { registerRunSession, unregisterRunSession, __getActiveRunSessionCount } = await importFresh();
      registerRunSession('run-1', makeSession());
      registerRunSession('run-2', makeSession({ conversationId: 'conv-2', loopId: 'loop-2' }));
      unregisterRunSession('run-1');
      expect(settingsUnsubMock).not.toHaveBeenCalled();
      expect(__getActiveRunSessionCount()).toBe(1);
      unregisterRunSession('run-2');
      expect(settingsUnsubMock).toHaveBeenCalledTimes(1);
      expect(chatUnsubMock).toHaveBeenCalledTimes(1);
      expect(__getActiveRunSessionCount()).toBe(0);
    });

    it('getRunSession returns the registered session, undefined once unregistered', async () => {
      const { registerRunSession, unregisterRunSession, getRunSession } = await importFresh();
      const session = makeSession();
      registerRunSession('run-1', session);
      expect(getRunSession('run-1')).toBe(session);
      unregisterRunSession('run-1');
      expect(getRunSession('run-1')).toBeUndefined();
    });
  });

  describe('settings push emitter (debounced)', () => {
    it('pushes state.settings after the debounce window, not immediately', async () => {
      vi.useFakeTimers();
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession());

      capturedSettingsCb?.();
      expect(notifySidecar).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(notifySidecar).toHaveBeenCalledWith('state.settings', { settings: { agentMaxTurns: 200 } });
    });

    it('coalesces rapid-fire changes into a single push', async () => {
      vi.useFakeTimers();
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession());

      capturedSettingsCb?.();
      vi.advanceTimersByTime(20);
      capturedSettingsCb?.();
      vi.advanceTimersByTime(20);
      capturedSettingsCb?.();
      vi.advanceTimersByTime(50);

      const settingsPushes = notifySidecar.mock.calls.filter((c) => c[0] === 'state.settings');
      expect(settingsPushes).toHaveLength(1);
    });
  });

  describe('convPatch push emitter (diffing)', () => {
    it('pushes all 4 scalar fields the first time a conversation is observed', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      chatState = {
        conversations: { 'conv-1': { workspacePath: '/a', title: 'T1', activeSkills: ['s1'] } },
        conversationIndex: { 'conv-1': { model: { providerId: 'p', modelId: 'm' } } },
      };
      capturedChatCb?.();

      expect(notifySidecar).toHaveBeenCalledWith('state.convPatch', {
        conversationId: 'conv-1',
        patch: { workspacePath: '/a', title: 'T1', activeSkills: ['s1'], model: { providerId: 'p', modelId: 'm' } },
      });
    });

    it('only pushes CHANGED fields on a subsequent diff', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      chatState = {
        conversations: { 'conv-1': { workspacePath: '/a', title: 'T1', activeSkills: ['s1'] } },
        conversationIndex: { 'conv-1': { model: { providerId: 'p', modelId: 'm' } } },
      };
      capturedChatCb?.();
      notifySidecar.mockClear();

      // Only title changes.
      chatState = {
        conversations: { 'conv-1': { workspacePath: '/a', title: 'T2', activeSkills: ['s1'] } },
        conversationIndex: { 'conv-1': { model: { providerId: 'p', modelId: 'm' } } },
      };
      capturedChatCb?.();

      expect(notifySidecar).toHaveBeenCalledWith('state.convPatch', {
        conversationId: 'conv-1',
        patch: { title: 'T2' },
      });
    });

    it('pushes nothing when nothing changed', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      chatState = {
        conversations: { 'conv-1': { workspacePath: '/a', title: 'T1', activeSkills: ['s1'] } },
        conversationIndex: {},
      };
      capturedChatCb?.();
      notifySidecar.mockClear();

      capturedChatCb?.(); // same state again
      expect(notifySidecar).not.toHaveBeenCalledWith('state.convPatch', expect.anything());
    });

    it('skips a conversation that has no data yet (not created locally)', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-missing' }));
      chatState = { conversations: {}, conversationIndex: {} };
      expect(() => capturedChatCb?.()).not.toThrow();
      expect(notifySidecar).not.toHaveBeenCalledWith('state.convPatch', expect.anything());
    });
  });

  describe('planMode push emitter', () => {
    it('subscribes via onPlanModeChange and forwards to state.planMode', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession());

      capturedPlanModeCb?.('conv-1', 'planning');
      expect(notifySidecar).toHaveBeenCalledWith('state.planMode', { conversationId: 'conv-1', mode: 'planning' });

      capturedPlanModeCb?.('conv-1', null);
      expect(notifySidecar).toHaveBeenCalledWith('state.planMode', { conversationId: 'conv-1', mode: null });
    });
  });

  // ── Shell EventRouter / LoopContext-lite ───────────────────────────────

  describe('createShellEventRouterForRun', () => {
    it('constructs a real EventRouter with in-process deps and the current locale', async () => {
      const { registerRunSession, createShellEventRouterForRun } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-7' }));

      const router = createShellEventRouterForRun('run-1') as unknown as { deps: unknown; locale: string };
      expect(createEventRouterMock).toHaveBeenCalledTimes(1);
      expect(router.locale).toBe('zh-CN');
      const deps = router.deps as { executionStore: unknown; appendToolCallContext: (l: string, c: unknown) => void; addScratchpadEntry: (e: unknown) => void };
      expect(deps.executionStore).toEqual({ marker: 'execution-port-stub' });

      deps.appendToolCallContext('loop-x', { toolCallId: 'tc1' });
      expect(appendToolCallContextMock).toHaveBeenCalledWith('conv-7', 'loop-x', { toolCallId: 'tc1' });

      deps.addScratchpadEntry({ conversationId: 'conv-7', title: 't', type: 'summary', content: 'c' });
      expect(scratchpadAddEntryMock).toHaveBeenCalledWith({ conversationId: 'conv-7', title: 't', type: 'summary', content: 'c' });
    });

    it('throws for an unknown runId', async () => {
      const { createShellEventRouterForRun } = await importFresh();
      expect(() => createShellEventRouterForRun('no-such-run')).toThrow(/unknown runId/);
    });
  });

  describe('installShellLoopContext / removeShellLoopContext', () => {
    it('installs a LoopContext using session defaults (permissionBridge callbacks) when session.options omits them', async () => {
      const { registerRunSession, installShellLoopContext } = await importFresh();
      const session = makeSession({ conversationId: 'conv-1', loopId: 'loop-1' });
      registerRunSession('run-1', session);

      installShellLoopContext('run-1', session);

      expect(setLoopContextMock).toHaveBeenCalledTimes(1);
      const [loopId, ctx] = setLoopContextMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(loopId).toBe('loop-1');
      expect(ctx.loopId).toBe('loop-1');
      expect(ctx.conversationId).toBe('conv-1');
      expect(ctx.commandConfirmCallback).toBe(requestCommandConfirmationMock);
      expect(ctx.filePermissionCallback).toBe(requestFilePermissionMock);
      expect(ctx.signal).toBe(session.shellAbortController.signal);
      expect(ctx.toolCallToStepId).toBe(session.toolCallToStepId);
    });

    it('uses session.options callbacks when provided instead of the permissionBridge defaults', async () => {
      const { registerRunSession, installShellLoopContext } = await importFresh();
      const customConfirm = vi.fn().mockResolvedValue(true);
      const customFilePerm = vi.fn().mockResolvedValue(true);
      const session = {
        ...makeSession(),
        options: { requestCommandConfirmation: customConfirm, requestFilePermission: customFilePerm },
      };
      registerRunSession('run-1', session);

      installShellLoopContext('run-1', session);

      const [, ctx] = setLoopContextMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(ctx.commandConfirmCallback).toBe(customConfirm);
      expect(ctx.filePermissionCallback).toBe(customFilePerm);
    });

    it('removeShellLoopContext calls clearLoopContext with the session loopId', async () => {
      const { registerRunSession, removeShellLoopContext } = await importFresh();
      const session = makeSession({ loopId: 'loop-42' });
      registerRunSession('run-1', session);

      removeShellLoopContext('run-1');
      expect(clearLoopContextMock).toHaveBeenCalledWith('loop-42');
    });

    it('removeShellLoopContext on an unknown runId is a silent no-op', async () => {
      const { removeShellLoopContext } = await importFresh();
      expect(() => removeShellLoopContext('no-such-run')).not.toThrow();
      expect(clearLoopContextMock).not.toHaveBeenCalled();
    });
  });
});
