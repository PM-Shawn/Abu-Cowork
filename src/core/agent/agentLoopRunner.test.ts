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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// ── Mocked dependencies ─────────────────────────────────────────────────

const onSidecarNotification = vi.fn();
const onSidecarRequest = vi.fn();
const onSidecarConnectionState = vi.fn();
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
const getSidecarStatusMock = vi.fn().mockReturnValue('running');
const sidecarRequestMock = vi.fn();
const agentStartRequestMock = vi.fn((_params: { runId: string; clientMessageId: string }) => Promise.resolve({
  version: 1,
  runId: _params.runId,
  clientMessageId: _params.clientMessageId,
  acceptedAt: 1,
  state: 'accepted',
  replay: false,
}));
const runGetStateRequestMock = vi.fn((params: { runId: string }) => Promise.resolve({
  version: 1,
  runId: params.runId,
  state: 'not_found',
}));
vi.mock('../sidecar/sidecarManager', () => ({
  onSidecarNotification: (...a: unknown[]) => onSidecarNotification(...a),
  onSidecarRequest: (...a: unknown[]) => onSidecarRequest(...a),
  onSidecarConnectionState: (...a: unknown[]) => onSidecarConnectionState(...a),
  notifySidecar: (...a: unknown[]) => notifySidecar(...a),
  getSidecarStatus: (...a: unknown[]) => getSidecarStatusMock(...a),
  request: (method: string, params: unknown, ...rest: unknown[]) => {
    if (method === 'agent.start') return agentStartRequestMock(params as { runId: string; clientMessageId: string }, ...rest);
    if (method === 'run.getState') return runGetStateRequestMock(params as { runId: string }, ...rest);
    return sidecarRequestMock(method, params, ...rest);
  },
  SidecarRequestError: MockSidecarRequestError,
}));

const {
  traceRuntimeEventMock,
  startRuntimeRunMock,
  markRuntimeRunStageMock,
  finishRuntimeRunMock,
} = vi.hoisted(() => ({
  traceRuntimeEventMock: vi.fn(),
  startRuntimeRunMock: vi.fn(),
  markRuntimeRunStageMock: vi.fn(),
  finishRuntimeRunMock: vi.fn(),
}));
vi.mock('../observability/runtimeTrace', () => ({
  traceRuntimeEvent: (...a: unknown[]) => traceRuntimeEventMock(...a),
  startRuntimeRun: (...a: unknown[]) => startRuntimeRunMock(...a),
  markRuntimeRunStage: (...a: unknown[]) => markRuntimeRunStageMock(...a),
  finishRuntimeRun: (...a: unknown[]) => finishRuntimeRunMock(...a),
  runtimeErrorType: (error: unknown) => error instanceof Error ? error.name.toLowerCase() : typeof error,
}));

const applyDeltaFramesMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./frameApplier', () => ({
  applyDeltaFrames: (...a: unknown[]) => applyDeltaFramesMock(...a),
}));

const cancelExecutionMock = vi.fn();
vi.mock('./ports/executionPort', () => ({
  getExecutionPort: () => ({ marker: 'execution-port-stub', cancelExecution: (...a: unknown[]) => cancelExecutionMock(...a) }),
}));

const appendToolCallContextMock = vi.fn();
const chatDeltaAppendTextMock = vi.fn();
const chatDeltaFinishStreamingMock = vi.fn();
const chatDeltaSetAgentStatusMock = vi.fn();
const chatDeltaSetConversationStatusMock = vi.fn();
const chatDeltaCancelStreamingMock = vi.fn();
const chatDeltaDeactivateSkillsMock = vi.fn();
const chatDeltaAddMessageMock = vi.fn();
const chatDeltaDeleteMessagesFromMock = vi.fn();
const chatDeltaCheckpointToolCallMetadataMock = vi.fn();
vi.mock('./ports/chatDelta', () => ({
  getChatDelta: () => ({
    appendToolCallContext: (...a: unknown[]) => appendToolCallContextMock(...a),
    appendText: (...a: unknown[]) => chatDeltaAppendTextMock(...a),
    finishStreaming: (...a: unknown[]) => chatDeltaFinishStreamingMock(...a),
    setAgentStatus: (...a: unknown[]) => chatDeltaSetAgentStatusMock(...a),
    setConversationStatus: (...a: unknown[]) => chatDeltaSetConversationStatusMock(...a),
    cancelStreaming: (...a: unknown[]) => chatDeltaCancelStreamingMock(...a),
    deactivateSkills: (...a: unknown[]) => chatDeltaDeactivateSkillsMock(...a),
    addMessage: (...a: unknown[]) => chatDeltaAddMessageMock(...a),
    deleteMessagesFrom: (...a: unknown[]) => chatDeltaDeleteMessagesFromMock(...a),
    checkpointToolCallMetadata: (...a: unknown[]) => chatDeltaCheckpointToolCallMetadataMock(...a),
  }),
}));

const scratchpadAddEntryMock = vi.fn();
vi.mock('./ports/scratchpadPort', () => ({
  getScratchpadPort: () => ({ addEntry: (...a: unknown[]) => scratchpadAddEntryMock(...a) }),
}));

const recordMaxOutputTokensMock = vi.fn();
const recordContextWindowMock = vi.fn();
const recordReasoningObservedMock = vi.fn();
const capsGetMock = vi.fn().mockReturnValue(undefined);
vi.mock('./ports/capsPort', () => ({
  getCapsPort: () => ({
    get: (...a: unknown[]) => capsGetMock(...a),
    recordMaxOutputTokens: (...a: unknown[]) => recordMaxOutputTokensMock(...a),
    recordContextWindow: (...a: unknown[]) => recordContextWindowMock(...a),
    recordReasoningObserved: (...a: unknown[]) => recordReasoningObservedMock(...a),
  }),
}));

const getAllToolsMock = vi.fn().mockReturnValue([
  { name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} }, execute: async () => 'x', isConcurrencySafe: true },
]);
const executeAnyToolMock = vi.fn().mockResolvedValue('tool result');
vi.mock('./ports/toolInvoker', () => ({
  getToolInvoker: () => ({
    getAllTools: (...a: unknown[]) => getAllToolsMock(...a),
    executeAnyTool: (...a: unknown[]) => executeAnyToolMock(...a),
  }),
}));

// P1-3d-3 — `checkToolApproval` (registry.ts) is the SINGLE SOURCE OF TRUTH
// the shell-side `approval.check` handler (`handleApprovalCheck`) calls
// directly (not through the `ToolInvoker` port, unlike `tool.invoke`) — see
// that handler's doc. Mocked here so this file's approval.check tests
// control allow/deny deterministically without exercising the REAL command/
// path/policy chain (that chain has its own dedicated coverage in
// `toolRegistry.integration.test.ts`).
const checkToolApprovalMock = vi.fn().mockResolvedValue({ decision: 'allow' });
vi.mock('../tools/registry', () => ({
  checkToolApproval: (...a: unknown[]) => checkToolApprovalMock(...a),
}));

// P1-3d A-write — the two reverse-mechanism targets `handleWorkspaceBindFromWrite`/
// `handleSnapshotBeforeAiEdit` call. Mocked so this file's tests control their
// resolution deterministically without exercising the real store writes / version
// history (those have their own dedicated coverage — `defaultWorkspace.test.ts` /
// `aiEditSnapshots.test.ts`).
const bindWorkspaceFromWriteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./defaultWorkspace', () => ({
  bindWorkspaceFromWrite: (...a: unknown[]) => bindWorkspaceFromWriteMock(...a),
}));

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/aiEditSnapshots', () => ({
  snapshotBeforeAiEdit: (...a: unknown[]) => snapshotBeforeAiEditMock(...a),
}));

/** Fuller settings snapshot — only used by runAgentLoopDispatched tests (resolveEntryModel/creds resolution need `providers`/`activeModel`); every OTHER pre-existing test relies on the plain `{agentMaxTurns:200}` default below and asserts against it exactly. */
function dispatchSettingsSnapshot() {
  return {
    agentMaxTurns: 200,
    activeModel: { providerId: 'p1', modelId: 'model-a' },
    providers: [
      { id: 'p1', name: 'P1', apiFormat: 'anthropic', enabled: true, apiKey: 'sk-1', baseUrl: undefined, models: [{ id: 'model-a', name: 'Model A' }] },
    ],
  };
}
const getSettingsSnapshotMock = vi.fn().mockReturnValue({ agentMaxTurns: 200 });
vi.mock('./ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => getSettingsSnapshotMock() }),
}));

const getConversationMock = vi.fn();
const getIndexEntryMock = vi.fn();
vi.mock('./ports/conversationReader', () => ({
  getConversationReader: () => ({
    getConversation: (...a: unknown[]) => getConversationMock(...a),
    getIndexEntry: (...a: unknown[]) => getIndexEntryMock(...a),
  }),
}));

const hasAbortControllerMock = vi.fn().mockReturnValue(false);
const getAbortControllerMock = vi.fn(() => new AbortController());
const clearAbortControllerMock = vi.fn();
vi.mock('./ports/abortRegistry', () => ({
  getAbortRegistry: () => ({
    hasAbortController: (...a: unknown[]) => hasAbortControllerMock(...a),
    getAbortController: (...a: unknown[]) => getAbortControllerMock(...a),
    clearAbortController: (...a: unknown[]) => clearAbortControllerMock(...a),
  }),
}));

const runAgentLoopMock = vi.fn().mockResolvedValue({ reason: 'completed' });
const isInteractiveDesktopMock = vi.fn().mockReturnValue(true);
const buildUserMessageContentMock = vi.fn(async (_conversationId: string, text: string) => text);
vi.mock('./agentLoop', () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
  isInteractiveDesktop: (...a: unknown[]) => isInteractiveDesktopMock(...a),
  buildUserMessageContent: (...a: [string, string, unknown]) => buildUserMessageContentMock(...a),
  resolveToolContextWorkspacePath: (
    options: { authorizationScopeId?: string; imContext?: { workspacePath?: string | null } } | undefined,
    conversation: { workspacePath?: string | null } | null | undefined,
    globalWorkspacePath: string | null,
  ) => (
    options?.imContext?.workspacePath ??
    conversation?.workspacePath ??
    (options?.authorizationScopeId !== undefined ? null : globalWorkspacePath)
  ),
}));

const precomputeOrchestrationMock = vi.fn().mockResolvedValue({
  route: { type: 'general', name: 'general', cleanInput: 'hi' },
  systemPromptSections: [],
});
vi.mock('./entryOrchestration', () => ({
  precomputeOrchestration: (...a: unknown[]) => precomputeOrchestrationMock(...a),
}));

const resolveEffectiveLlmCredsMock = vi.fn().mockReturnValue({ apiKey: 'sk-1', baseUrl: undefined, forceOpenAiCompatible: false });
vi.mock('../enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: (...a: unknown[]) => resolveEffectiveLlmCredsMock(...a),
}));

const enqueueUserInputMock = vi.fn();
const getQueuedInputsMock = vi.fn().mockReturnValue([]);
const removeQueuedInputMock = vi.fn();
const drainSystemQueuedInputsMock = vi.fn().mockReturnValue([]);
const pauseUserInputQueueMock = vi.fn();
const dequeueNextUserInputMock = vi.fn().mockReturnValue(undefined);
let capturedQueueCb: (() => void) | undefined;
const queueUnsubMock = vi.fn();
const subscribeToInputQueueMock = vi.fn((cb: () => void) => {
  capturedQueueCb = cb;
  return queueUnsubMock;
});
vi.mock('./userInputQueue', () => ({
  enqueueUserInput: (...a: unknown[]) => enqueueUserInputMock(...a),
  getQueuedInputs: (...a: unknown[]) => getQueuedInputsMock(...a),
  removeQueuedInput: (...a: unknown[]) => removeQueuedInputMock(...a),
  drainSystemQueuedInputs: (...a: unknown[]) => drainSystemQueuedInputsMock(...a),
  pauseUserInputQueue: (...a: unknown[]) => pauseUserInputQueueMock(...a),
  dequeueNextUserInput: (...a: unknown[]) => dequeueNextUserInputMock(...a),
  subscribeToInputQueue: (...a: [() => void]) => subscribeToInputQueueMock(...a),
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
const getPlanModeMock = vi.fn().mockReturnValue('off');
vi.mock('./planMode', () => ({
  clearPlanMode: (...a: unknown[]) => clearPlanModeMock(...a),
  onPlanModeChange: (...a: [(conversationId: string, mode: string | null) => void]) => onPlanModeChangeMock(...a),
  getPlanMode: (...a: unknown[]) => getPlanModeMock(...a),
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
const clearAllSkillHooksMock = vi.fn();
vi.mock('../tools/builtins', () => ({
  setComputerUseBatchMode: (...a: unknown[]) => setComputerUseBatchModeMock(...a),
  setSkipAutoScreenshot: (...a: unknown[]) => setSkipAutoScreenshotMock(...a),
  clearAllSkillHooks: (...a: unknown[]) => clearAllSkillHooksMock(...a),
}));

const drainCapabilitySetupRequestsMock = vi.fn();
vi.mock('../capabilityPlugins/setupBridge', () => ({
  drainCapabilitySetupRequests: (...a: unknown[]) => drainCapabilitySetupRequestsMock(...a),
}));

const clearCheckpointMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../session/checkpoint', () => ({
  clearCheckpoint: (...a: unknown[]) => clearCheckpointMock(...a),
}));

const closeAxSessionMock = vi.fn().mockResolvedValue(undefined);
const endComputerUseTaskMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../tools/definitions/computerTools', () => ({
  closeAxSession: (...a: unknown[]) => closeAxSessionMock(...a),
  endComputerUseTask: (...a: unknown[]) => endComputerUseTaskMock(...a),
}));

const notifyTaskCompletedMock = vi.fn().mockResolvedValue(undefined);
const notifyTaskErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/notifications', () => ({
  notifyTaskCompleted: (...a: unknown[]) => notifyTaskCompletedMock(...a),
  notifyTaskError: (...a: unknown[]) => notifyTaskErrorMock(...a),
}));

// P1-3d-5 slice 2a — `workspace.authorizedWritablePaths`/`shell.sandboxBlocked`
// handlers call these two REAL functions directly (not through a port), same
// single-source-of-truth discipline as `checkToolApproval` above.
const getAuthorizedWritablePathsMock = vi.fn().mockReturnValue([]);
vi.mock('../tools/pathSafety', () => ({
  getAuthorizedWritablePaths: (...a: unknown[]) => getAuthorizedWritablePathsMock(...a),
}));

const showSandboxBlockedToastMock = vi.fn();
vi.mock('../sandbox/recovery', () => ({
  showSandboxBlockedToast: (...a: unknown[]) => showSandboxBlockedToastMock(...a),
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
const waitForConversationPersistenceMock = vi.fn().mockResolvedValue(undefined);
const chatStoreAddMessageMock = vi.fn();
const chatStoreUpdateUserMessageRunMock = vi.fn();
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    subscribe: (...a: [() => void]) => chatSubscribeMock(...a),
    getState: () => ({
      ...chatState,
      addMessage: (...a: unknown[]) => chatStoreAddMessageMock(...a),
      updateUserMessageRun: (...a: unknown[]) => chatStoreUpdateUserMessageRunMock(...a),
    }),
  },
  waitForConversationPersistence: (...a: unknown[]) => waitForConversationPersistenceMock(...a),
}));

interface TaskExecStateStub {
  getExecutionByConversationId: (conversationId: string) => { plannedSteps: unknown[] } | undefined;
}
let taskExecState: TaskExecStateStub = { getExecutionByConversationId: () => undefined };
let capturedExecCb: (() => void) | undefined;
const execUnsubMock = vi.fn();
const execSubscribeMock = vi.fn((cb: () => void) => {
  capturedExecCb = cb;
  return execUnsubMock;
});
vi.mock('../../stores/taskExecutionStore', () => ({
  useTaskExecutionStore: {
    subscribe: (...a: [() => void]) => execSubscribeMock(...a),
    getState: () => taskExecState,
  },
}));

vi.mock('../../i18n', () => ({
  getI18n: () => ({
    chat: {
      sidecarInterrupted: '后台服务意外中断，正在自动恢复。请稍后重新发送刚才的请求。',
      messageSaveFailed: '消息未能写入磁盘，阿布没有启动任务。请检查磁盘权限后重试。',
      attachmentDuringRun: '请等待当前任务结束后再发送图片，草稿已为你保留。',
      conversationBusy: '当前会话已有任务在运行，请等待结束后再启动新任务。',
    },
  }),
  getLocale: () => 'zh-CN',
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
  // Newest registration wins: the running test always registers last, so a
  // stale handler leaked in by an abandoned (timed-out) test body cannot be
  // picked up ahead of it.
  const call = mock.mock.calls.findLast((c) => c[0] === method);
  if (!call) throw new Error(`no handler registered for ${method}`);
  return call[1] as (params: unknown) => unknown;
}

function makeSession(
  overrides: Partial<{
    conversationId: string;
    loopId: string;
    terminalPublished: boolean;
    authorizationScopeId: string;
    workspacePathSnapshot: string | null;
  }> = {},
) {
  return {
    conversationId: overrides.conversationId ?? 'conv-1',
    loopId: overrides.loopId ?? 'loop-1',
    options: {
      ...(Object.prototype.hasOwnProperty.call(overrides, 'authorizationScopeId')
        ? { authorizationScopeId: overrides.authorizationScopeId }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(overrides, 'workspacePathSnapshot')
        ? { workspacePathSnapshot: overrides.workspacePathSnapshot }
        : {}),
    },
    shellAbortController: new AbortController(),
    toolCallToStepId: new Map<string, string>(),
    ...(overrides.terminalPublished === undefined
      ? {}
      : { terminalPublished: overrides.terminalPublished }),
  };
}

describe('agentLoopRunner', () => {
  // The FIRST import of this module graph pays Vite's cold transform cost
  // (measured ~4.0 s here; more under v8 coverage or a loaded runner), and the
  // default 5 s testTimeout applies to test BODIES only. Left inside the first
  // `await importFresh()` that cost blew the timeout; vitest then failed that
  // test WITHOUT cancelling its body, so the abandoned continuation later ran
  // ensureHandlersRegistered() against the *next* test's freshly-reset mocks —
  // turning one slow test into a cascade of unrelated red assertions.
  // Paying it here instead is safe: hookTimeout is 30 s, and vi.resetModules()
  // drops the evaluated-module cache but NOT the transform cache, so every
  // later importFresh() only re-evaluates (~10-400 ms).
  beforeAll(async () => {
    await import('./agentLoopRunner');
  });

  beforeEach(() => {
    onSidecarNotification.mockReset();
    onSidecarRequest.mockReset();
    onSidecarConnectionState.mockReset();
    notifySidecar.mockReset();
    applyDeltaFramesMock.mockReset();
    applyDeltaFramesMock.mockResolvedValue(undefined);
    appendToolCallContextMock.mockReset();
    chatDeltaAppendTextMock.mockReset();
    chatDeltaFinishStreamingMock.mockReset();
    chatDeltaSetAgentStatusMock.mockReset();
    chatDeltaSetConversationStatusMock.mockReset();
    chatDeltaCancelStreamingMock.mockReset();
    chatDeltaDeactivateSkillsMock.mockReset();
    chatDeltaAddMessageMock.mockReset();
    chatDeltaDeleteMessagesFromMock.mockReset();
    chatDeltaCheckpointToolCallMetadataMock.mockReset();
    cancelExecutionMock.mockReset();
    scratchpadAddEntryMock.mockReset();
    recordMaxOutputTokensMock.mockReset();
    recordContextWindowMock.mockReset();
    recordReasoningObservedMock.mockReset();
    getAllToolsMock.mockReset();
    getAllToolsMock.mockReturnValue([
      { name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} }, execute: async () => 'x', isConcurrencySafe: true },
    ]);
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
    waitForConversationPersistenceMock.mockReset();
    waitForConversationPersistenceMock.mockResolvedValue(undefined);
    capturedChatCb = undefined;
    // P1-3c-2: handleMainLoopToolInvoke now refuses to execute when
    // conversations[session.conversationId] is absent (conversation
    // deleted) — 'conv-1' is the ubiquitous default conversationId across
    // this whole suite (see makeSession()'s default), so it must exist by
    // default here or every unrelated test that happens to invoke the
    // tool.invoke handler for 'conv-1' would spuriously start throwing.
    // Tests that specifically exercise the "conversation deleted" refusal
    // (or the convPatch emitter's "no data yet" case) override chatState
    // themselves before asserting.
    chatState = { conversations: { 'conv-1': {} }, conversationIndex: {} };
    tauriInvokeMock.mockClear();
    execSubscribeMock.mockClear();
    execUnsubMock.mockReset();
    capturedExecCb = undefined;
    taskExecState = { getExecutionByConversationId: () => undefined };
    clearAllSkillHooksMock.mockReset();
    drainCapabilitySetupRequestsMock.mockReset();
    clearCheckpointMock.mockReset();
    clearCheckpointMock.mockResolvedValue(undefined);
    closeAxSessionMock.mockReset();
    closeAxSessionMock.mockResolvedValue(undefined);
    endComputerUseTaskMock.mockReset();
    endComputerUseTaskMock.mockResolvedValue(undefined);
    executeAnyToolMock.mockReset();
    executeAnyToolMock.mockResolvedValue('tool result');
    capsGetMock.mockReset();
    capsGetMock.mockReturnValue(undefined);
    getConversationMock.mockReset();
    getIndexEntryMock.mockReset();
    hasAbortControllerMock.mockReset();
    hasAbortControllerMock.mockReturnValue(false);
    getAbortControllerMock.mockReset();
    getAbortControllerMock.mockImplementation(() => new AbortController());
    clearAbortControllerMock.mockReset();
    runAgentLoopMock.mockReset();
    runAgentLoopMock.mockResolvedValue({ reason: 'completed' });
    isInteractiveDesktopMock.mockReset();
    isInteractiveDesktopMock.mockReturnValue(true);
    precomputeOrchestrationMock.mockReset();
    precomputeOrchestrationMock.mockResolvedValue({
      route: { type: 'general', name: 'general', cleanInput: 'hi' },
      systemPromptSections: [],
    });
    resolveEffectiveLlmCredsMock.mockReset();
    resolveEffectiveLlmCredsMock.mockReturnValue({ apiKey: 'sk-1', baseUrl: undefined, forceOpenAiCompatible: false });
    enqueueUserInputMock.mockReset();
    getQueuedInputsMock.mockReset();
    getQueuedInputsMock.mockReturnValue([]);
    removeQueuedInputMock.mockReset();
    drainSystemQueuedInputsMock.mockReset();
    drainSystemQueuedInputsMock.mockReturnValue([]);
    pauseUserInputQueueMock.mockReset();
    dequeueNextUserInputMock.mockReset();
    dequeueNextUserInputMock.mockReturnValue(undefined);
    subscribeToInputQueueMock.mockClear();
    queueUnsubMock.mockReset();
    capturedQueueCb = undefined;
    getSidecarStatusMock.mockReset();
    getSidecarStatusMock.mockReturnValue('running');
    sidecarRequestMock.mockReset();
    agentStartRequestMock.mockReset();
    agentStartRequestMock.mockImplementation((params: { runId: string; clientMessageId: string }) => Promise.resolve({
      version: 1,
      runId: params.runId,
      clientMessageId: params.clientMessageId,
      acceptedAt: 1,
      state: 'accepted',
      replay: false,
    }));
    runGetStateRequestMock.mockReset();
    runGetStateRequestMock.mockImplementation((params: { runId: string }) => Promise.resolve({
      version: 1,
      runId: params.runId,
      state: 'not_found',
    }));
    chatStoreAddMessageMock.mockReset();
    chatStoreUpdateUserMessageRunMock.mockReset();
    buildUserMessageContentMock.mockReset();
    buildUserMessageContentMock.mockImplementation(async (_conversationId: string, text: string) => text);
    traceRuntimeEventMock.mockReset();
    startRuntimeRunMock.mockReset();
    markRuntimeRunStageMock.mockReset();
    finishRuntimeRunMock.mockReset();
    getSettingsSnapshotMock.mockReset();
    getSettingsSnapshotMock.mockReturnValue({ agentMaxTurns: 200 });
    getPlanModeMock.mockReset();
    getPlanModeMock.mockReturnValue('off');
    checkToolApprovalMock.mockReset();
    checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });
    bindWorkspaceFromWriteMock.mockReset();
    bindWorkspaceFromWriteMock.mockResolvedValue(undefined);
    snapshotBeforeAiEditMock.mockReset();
    snapshotBeforeAiEditMock.mockResolvedValue(undefined);
    getAuthorizedWritablePathsMock.mockReset();
    getAuthorizedWritablePathsMock.mockReturnValue([]);
    showSandboxBlockedToastMock.mockReset();
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

      // 12 notifications (including the ordered agent.terminal fact and
      // hook.notify via the
      // shared hookBridge) and 7 requests (native.invoke/tool.list/
      // approval.check — P1-3d-3 — /
      // snapshot.beforeAiEdit — P1-3d A-write — /
      // workspace.authorizedWritablePaths — P1-3d-5 slice 2a — /
      // tool.invoke via the router / hook.emit via the shared hookBridge).
      expect(onSidecarNotification).toHaveBeenCalledTimes(12);
      expect(onSidecarRequest).toHaveBeenCalledTimes(7);
      expect(onSidecarConnectionState).toHaveBeenCalledTimes(1);

      const notifiedMethods = onSidecarNotification.mock.calls.map((c) => c[0]);
      expect(notifiedMethods).toEqual(
        expect.arrayContaining(['agent.delta', 'agent.terminal', 'approval.drain', 'plan.clear', 'caps.record', 'shell.notifyTask', 'cu.setState', 'skillHooks.clearAll', 'input.consumed', 'workspace.bindFromWrite', 'shell.sandboxBlocked', 'hook.notify']),
      );
      const requestedMethods = onSidecarRequest.mock.calls.map((c) => c[0]);
      expect(requestedMethods).toEqual(
        expect.arrayContaining(['native.invoke', 'tool.list', 'approval.check', 'snapshot.beforeAiEdit', 'workspace.authorizedWritablePaths', 'tool.invoke', 'hook.emit']),
      );
    });

    it('projects connection recovery and failure onto active user-run lifecycle state', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-connection', {
        ...makeSession(),
        accepted: true,
        userMessageId: 'msg-connection',
      });
      const handler = onSidecarConnectionState.mock.calls.at(-1)![0] as (
        event: { state: 'connected' | 'recovering' | 'failed'; reason: string },
      ) => void;

      handler({ state: 'recovering', reason: 'process-close' });
      handler({ state: 'connected', reason: 'ready' });
      handler({ state: 'failed', reason: 'crash-loop' });

      expect(chatStoreUpdateUserMessageRunMock.mock.calls).toEqual([
        ['conv-1', 'msg-connection', { state: 'recovering' }],
        ['conv-1', 'msg-connection', { state: 'running' }],
        ['conv-1', 'msg-connection', {
          state: 'connection-failed',
          error: '后台服务意外中断，正在自动恢复。请稍后重新发送刚才的请求。',
        }],
      ]);
    });
  });

  // ── agent.delta ────────────────────────────────────────────────────────

  describe('agent.delta handler', () => {
    it('routes to applyDeltaFrames for a known runId', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      const frames = [{ p: 'chat', m: 'appendText', a: ['conv-1', 'hi'] }];
      handler({ runId: 'run-1', frames });

      await Promise.resolve();
      expect(applyDeltaFramesMock).toHaveBeenCalledWith(frames);
    });

    it('serializes separate frame batches for the same run', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());

      let releaseFirst!: () => void;
      const firstPending = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      applyDeltaFramesMock
        .mockImplementationOnce(() => firstPending)
        .mockResolvedValueOnce(undefined);

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      const first = [{ p: 'chat', m: 'addMessage', a: ['conv-1', { id: 'a' }] }];
      const second = [{ p: 'session', m: 'replaceMessageById', a: ['conv-1', { id: 'a' }] }];
      handler({ runId: 'run-1', frames: first });
      handler({ runId: 'run-1', frames: second });

      await Promise.resolve();
      expect(applyDeltaFramesMock).toHaveBeenCalledTimes(1);
      expect(applyDeltaFramesMock).toHaveBeenNthCalledWith(1, first);

      releaseFirst();
      await firstPending;
      await vi.waitFor(() => {
        expect(applyDeltaFramesMock).toHaveBeenNthCalledWith(2, second);
      });
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

    it('drops malformed frame entries without throwing or applying the batch', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1', loopId: 'loop-1' }));

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      expect(() => handler({
        runId: 'run-1',
        frames: [
          null,
          { p: 'chat', m: 'setAgentStatus' },
          { p: 'exec', m: 'addStep', a: null },
        ],
      })).not.toThrow();

      expect(applyDeltaFramesMock).not.toHaveBeenCalled();
    });

    it('filters chat/session frames that target a different conversation than the registered run', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1', loopId: 'loop-1' }));

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      const forged = [
        { p: 'chat', m: 'setAgentStatus', a: ['conv-forged', 'tool-calling', 'read_file'] },
        { p: 'session', m: 'replaceMessageById', a: ['conv-forged', { id: 'm-forged' }] },
        { p: 'chat', m: 'setRetryInfo', a: ['conv-1', { attempt: 1, maxAttempts: 3, delayMs: 1000 }] },
      ];

      handler({ runId: 'run-1', frames: forged });

      await Promise.resolve();
      expect(applyDeltaFramesMock).toHaveBeenCalledWith([
        { p: 'chat', m: 'setRetryInfo', a: ['conv-1', { attempt: 1, maxAttempts: 3, delayMs: 1000 }] },
      ]);
    });

    it('filters exec and scratchpad frames that are not bound to the registered conversation and loop', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1', loopId: 'loop-1' }));

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      const frames = [
        { p: 'exec', m: 'createExecution', a: ['conv-forged', 'loop-1'] },
        { p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-forged'] },
        { p: 'exec', m: 'addStep', a: ['loop-forged', { id: 's-forged' }] },
        { p: 'scratchpad', m: 'addEntry', a: ['entry-forged', { conversationId: 'conv-forged', title: 't', type: 'summary', content: 'c' }] },
        { p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] },
        { p: 'exec', m: 'addStep', a: ['loop-1', { id: 's-real' }] },
        { p: 'scratchpad', m: 'addEntry', a: ['entry-real', { conversationId: 'conv-1', title: 't', type: 'summary', content: 'c' }] },
      ];

      handler({ runId: 'run-1', frames });

      await Promise.resolve();
      expect(applyDeltaFramesMock).toHaveBeenCalledWith([
        { p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] },
        { p: 'exec', m: 'addStep', a: ['loop-1', { id: 's-real' }] },
        { p: 'scratchpad', m: 'addEntry', a: ['entry-real', { conversationId: 'conv-1', title: 't', type: 'summary', content: 'c' }] },
      ]);
    });

    it('drops valid-looking frames when the registered conversation has already been deleted', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      chatState = { conversations: {}, conversationIndex: {} };
      registerRunSession('run-deleted', makeSession({ conversationId: 'conv-1', loopId: 'loop-1' }));

      const handler = handlerFor(onSidecarNotification, 'agent.delta');
      handler({
        runId: 'run-deleted',
        frames: [{ p: 'chat', m: 'setAgentStatus', a: ['conv-1', 'tool-calling', 'read_file'] }],
      });

      await Promise.resolve();
      expect(applyDeltaFramesMock).not.toHaveBeenCalled();
    });
  });

  describe('agent.terminal handler', () => {
    it('accepts the first valid terminal, fences late frames, and ignores a conflicting duplicate', async () => {
      const { ensureHandlersRegistered, registerRunSession, getRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-terminal', makeSession());

      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      terminalHandler({
        version: 1,
        runId: 'run-terminal',
        state: 'completed',
        result: { reason: 'completed' },
      });
      terminalHandler({
        version: 1,
        runId: 'run-terminal',
        state: 'failed',
        result: { reason: 'error', error: 'late conflict' },
        failure: { errorType: 'error', message: 'late conflict' },
      });
      deltaHandler({ runId: 'run-terminal', frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'late'] }] });

      expect(getRunSession('run-terminal')?.terminal).toEqual({
        version: 1,
        runId: 'run-terminal',
        state: 'completed',
        result: { reason: 'completed' },
      });
      expect(applyDeltaFramesMock).not.toHaveBeenCalled();
    });

    it('drops malformed terminals and terminals for unknown runs', async () => {
      const { ensureHandlersRegistered, registerRunSession, getRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('known-run', makeSession());
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');

      terminalHandler({ version: 2, runId: 'known-run', state: 'completed', result: { reason: 'completed' } });
      terminalHandler({ version: 1, runId: 'known-run', state: 'completed', result: { reason: 'error' } });
      terminalHandler({ version: 1, runId: 'missing-run', state: 'completed', result: { reason: 'completed' } });

      expect(getRunSession('known-run')?.terminal).toBeUndefined();
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

  // ── shell.sandboxBlocked (P1-3d-5 slice 2a) ───────────────────────────

  describe('shell.sandboxBlocked handler', () => {
    it('forwards command to the real showSandboxBlockedToast', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'shell.sandboxBlocked');
      handler({ command: 'cp foo /blocked/dir' });
      expect(showSandboxBlockedToastMock).toHaveBeenCalledWith('cp foo /blocked/dir');
    });

    it('malformed params (missing command) drop silently, no call', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'shell.sandboxBlocked');
      handler({});
      expect(showSandboxBlockedToastMock).not.toHaveBeenCalled();
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
    it.each([
      'show_screen_border',
      'get_active_window',
      'window_hide',
      'activate_app',
      'run_shell_command',
      'abort_command',
      'ax_close_session',
      'computer_use_end_task',
    ])(
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

  // ── workspace.authorizedWritablePaths (P1-3d-5 slice 2a) ──────────────

  describe('workspace.authorizedWritablePaths handler', () => {
    it('returns writable paths from the shell-owned session scope, ignoring forged params', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({
        authorizationScopeId: 'scope-real',
        workspacePathSnapshot: '/trusted/workspace',
      }));
      getAuthorizedWritablePathsMock.mockImplementation((scopeId?: string) =>
        scopeId === 'scope-real' ? ['/tmp/scoped'] : ['/tmp/global'],
      );
      const handler = handlerFor(onSidecarRequest, 'workspace.authorizedWritablePaths') as (p: unknown) => Promise<unknown>;
      const result = await handler({ runId: 'run-1', authorizationScopeId: 'scope-forged' });
      expect(result).toEqual(['/tmp/scoped']);
      expect(getAuthorizedWritablePathsMock).toHaveBeenCalledWith('scope-real');
    });

    it('rejects unknown runId instead of falling back to global writable paths', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'workspace.authorizedWritablePaths') as (p: unknown) => Promise<unknown>;
      await expect(handler({ runId: 'missing' })).rejects.toThrow(MockSidecarRequestError);
      expect(getAuthorizedWritablePathsMock).not.toHaveBeenCalled();
    });

    it('uses global writable paths only for an unscoped registered session', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());
      getAuthorizedWritablePathsMock.mockReturnValue(['/tmp/global']);
      const handler = handlerFor(onSidecarRequest, 'workspace.authorizedWritablePaths') as (p: unknown) => Promise<unknown>;
      const result = await handler({ runId: 'run-1' });
      expect(result).toEqual(['/tmp/global']);
      expect(getAuthorizedWritablePathsMock).toHaveBeenCalledWith(undefined);
    });
  });

  describe('sidecar context scope hardening', () => {
    it('tool.invoke overwrites sidecar-supplied scope and identity with the shell session values', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({
        authorizationScopeId: 'scope-real',
        workspacePathSnapshot: '/trusted/workspace',
      }));
      const handler = handlerFor(onSidecarRequest, 'tool.invoke') as (p: unknown) => Promise<unknown>;

      await handler({
        runId: 'run-1',
        toolName: 'read_file',
        input: { path: '/tmp/x' },
        context: {
          authorizationScopeId: 'scope-forged',
          conversationId: 'conv-forged',
          loopId: 'loop-forged',
          workspacePath: '/forged/workspace',
        },
      });

      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'read_file',
        { path: '/tmp/x' },
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          authorizationScopeId: 'scope-real',
          conversationId: 'conv-1',
          loopId: 'loop-1',
          workspacePath: '/trusted/workspace',
        }),
      );
    });

    it('tool.invoke overwrites a forged workspace with null when the shell session has no trusted workspace', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({
        authorizationScopeId: 'scope-real',
        workspacePathSnapshot: null,
      }));
      const handler = handlerFor(onSidecarRequest, 'tool.invoke') as (p: unknown) => Promise<unknown>;

      await handler({
        runId: 'run-1',
        toolName: 'run_command',
        input: { command: 'touch ok' },
        context: {
          authorizationScopeId: 'scope-forged',
          workspacePath: '/forged/workspace',
        },
      });

      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'run_command',
        { command: 'touch ok' },
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          authorizationScopeId: 'scope-real',
          workspacePath: null,
        }),
      );
    });

    it('approval.check overwrites sidecar-supplied scope before registry approval', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ authorizationScopeId: 'scope-real' }));
      const handler = handlerFor(onSidecarRequest, 'approval.check') as (p: unknown) => Promise<unknown>;

      await handler({
        runId: 'run-1',
        toolName: 'read_file',
        input: { path: '/tmp/x' },
        context: {
          authorizationScopeId: 'scope-forged',
          conversationId: 'conv-forged',
          loopId: 'loop-forged',
        },
      });

      expect(checkToolApprovalMock).toHaveBeenCalledWith(
        'read_file',
        { path: '/tmp/x' },
        expect.objectContaining({
          authorizationScopeId: 'scope-real',
          conversationId: 'conv-1',
          loopId: 'loop-1',
        }),
        expect.any(Function),
        expect.any(Function),
      );
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
        runId: 'run-1',
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
        runId: 'run-1',
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

  // ── Queued-input forwarder + input.consumed handler (P1-3B-4) ──────────

  describe('queued-input forwarder', () => {
    it('does not forward a user follow-up into the active sidecar run', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      notifySidecar.mockClear();

      getQueuedInputsMock.mockReturnValue([{ id: 'q1', text: 'more', timestamp: 1 }]);
      capturedQueueCb?.();

      expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
    });

    it('threads the isSystem flag through when forwarding', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      getQueuedInputsMock.mockReturnValue([{ id: 'q1', text: 'sys', timestamp: 1, isSystem: true }]);
      capturedQueueCb?.();

      expect(notifySidecar).toHaveBeenCalledWith('agent.enqueueInput', { runId: 'run-1', message: 'sys', queueId: 'q1', isSystem: true });
    });

    it('forwards each entry exactly once — repeated queue-change notifications do not re-send an already-forwarded id', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      getQueuedInputsMock.mockReturnValue([{ id: 'q1', text: 'system result', timestamp: 1, isSystem: true }]);
      capturedQueueCb?.();
      capturedQueueCb?.(); // entry still sitting in the (unmutated — chip lingers) shell queue

      const calls = notifySidecar.mock.calls.filter((c) => c[0] === 'agent.enqueueInput');
      expect(calls).toHaveLength(1);
    });

    it('does not forward for a conversation with no active sidecar RunSession — in-process runs are unaffected', async () => {
      const { registerRunSession } = await importFresh();
      // A session exists (so the forwarder subscription IS installed and running), but for a DIFFERENT conversation.
      registerRunSession('run-other', makeSession({ conversationId: 'conv-other' }));
      getQueuedInputsMock.mockImplementation((convId: string) => (convId === 'conv-1' ? [{ id: 'q1', text: 'more', timestamp: 1 }] : []));

      capturedQueueCb?.();

      expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
    });

    it('does not remove anything from the shell queue itself — the chip lingers until input.consumed', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      getQueuedInputsMock.mockReturnValue([{ id: 'q1', text: 'more', timestamp: 1 }]);
      capturedQueueCb?.();

      expect(removeQueuedInputMock).not.toHaveBeenCalled();
    });

    it('a session pre-seeded with forwardedQueueIds (dispatch-time leftovers) does not re-forward those ids', async () => {
      const { registerRunSession } = await importFresh();
      const session = { ...makeSession({ conversationId: 'conv-1' }), forwardedQueueIds: new Set(['leftover-1']) };
      registerRunSession('run-1', session);

      getQueuedInputsMock.mockReturnValue([{ id: 'leftover-1', text: 'already seeded', timestamp: 1, isSystem: true }]);
      capturedQueueCb?.();

      expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
    });

    it('Stop is a synchronous barrier that freezes new queue forwarding', async () => {
      const { registerRunSession } = await importFresh();
      const session = { ...makeSession({ conversationId: 'conv-1' }), abortRequested: true };
      registerRunSession('run-1', session);
      getQueuedInputsMock.mockReturnValue([{ id: 'q-after-stop', text: 'must stay local', timestamp: 1, isSystem: true }]);

      capturedQueueCb?.();

      expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
    });
  });

  describe('input.consumed handler', () => {
    it('removes exactly the consumed ids from the shell userInputQueue', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      const handler = handlerFor(onSidecarNotification, 'input.consumed');

      handler({ runId: 'run-1', queueIds: ['q1', 'q2'] });

      expect(removeQueuedInputMock).toHaveBeenCalledWith('conv-1', 'q1');
      expect(removeQueuedInputMock).toHaveBeenCalledWith('conv-1', 'q2');
      expect(removeQueuedInputMock).toHaveBeenCalledTimes(2);
    });

    it('drops the consumed ids from the session forwardedQueueIds set (housekeeping)', async () => {
      const { ensureHandlersRegistered, registerRunSession, getRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = { ...makeSession({ conversationId: 'conv-1' }), forwardedQueueIds: new Set(['q1', 'q2']) };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarNotification, 'input.consumed');
      handler({ runId: 'run-1', queueIds: ['q1'] });

      expect(getRunSession('run-1')?.forwardedQueueIds?.has('q1')).toBe(false);
      expect(getRunSession('run-1')?.forwardedQueueIds?.has('q2')).toBe(true);
    });

    it('unknown runId is silently dropped — no throw, removeQueuedInput not called', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'input.consumed');

      expect(() => handler({ runId: 'no-such-run', queueIds: ['q1'] })).not.toThrow();
      expect(removeQueuedInputMock).not.toHaveBeenCalled();
    });

    it('drops malformed params without throwing or calling through', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      const handler = handlerFor(onSidecarNotification, 'input.consumed');

      expect(() => handler(null)).not.toThrow();
      expect(() => handler({})).not.toThrow();
      expect(() => handler({ runId: 'run-1' })).not.toThrow();
      expect(() => handler({ runId: 'run-1', queueIds: 'nope' })).not.toThrow();
      expect(removeQueuedInputMock).not.toHaveBeenCalled();
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
      expect(deps.executionStore).toEqual(expect.objectContaining({ marker: 'execution-port-stub' }));

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

    it('installs the session imContext into the shell LoopContext for nested delegate tools', async () => {
      const { registerRunSession, installShellLoopContext } = await importFresh();
      const imContext = { platform: 'dchat' as const, workspacePath: '/im/workspace' };
      const session = {
        ...makeSession({ conversationId: 'conv-1', loopId: 'loop-1' }),
        options: { imContext },
      };
      registerRunSession('run-1', session);

      installShellLoopContext('run-1', session);

      const [, ctx] = setLoopContextMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(ctx.imContext).toBe(imContext);
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

  // ── state.execPatch push emitter (P1-3B-3B) ─────────────────────────────

  describe('execPatch push emitter (plannedSteps)', () => {
    it('pushes state.execPatch when plannedSteps changes for an active session', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const steps1 = [{ id: 's1' }];
      taskExecState = { getExecutionByConversationId: () => ({ plannedSteps: steps1 }) };
      capturedExecCb?.();

      expect(notifySidecar).toHaveBeenCalledWith('state.execPatch', { runId: 'run-1', plannedSteps: steps1 });
    });

    it('does not push again when the plannedSteps reference is unchanged', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      const steps1 = [{ id: 's1' }];
      taskExecState = { getExecutionByConversationId: () => ({ plannedSteps: steps1 }) };
      capturedExecCb?.();
      notifySidecar.mockClear();

      capturedExecCb?.(); // same reference again (an unrelated store write, e.g. addStep)
      expect(notifySidecar).not.toHaveBeenCalledWith('state.execPatch', expect.anything());
    });

    it('pushes again when the plannedSteps reference changes (report_plan replaces the array)', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      const steps1 = [{ id: 's1' }];
      taskExecState = { getExecutionByConversationId: () => ({ plannedSteps: steps1 }) };
      capturedExecCb?.();
      notifySidecar.mockClear();

      const steps2 = [{ id: 's1' }, { id: 's2' }];
      taskExecState = { getExecutionByConversationId: () => ({ plannedSteps: steps2 }) };
      capturedExecCb?.();

      expect(notifySidecar).toHaveBeenCalledWith('state.execPatch', { runId: 'run-1', plannedSteps: steps2 });
    });

    it('skips a session with no execution yet, without throwing', async () => {
      const { registerRunSession } = await importFresh();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-missing' }));
      taskExecState = { getExecutionByConversationId: () => undefined };
      expect(() => capturedExecCb?.()).not.toThrow();
      expect(notifySidecar).not.toHaveBeenCalledWith('state.execPatch', expect.anything());
    });
  });

  // ── skillHooks.clearAll handler (closes a P1-3B-3A escalation) ─────────

  describe('skillHooks.clearAll handler', () => {
    it('calls the real clearAllSkillHooks', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'skillHooks.clearAll');
      handler({ runId: 'run-1' });
      expect(clearAllSkillHooksMock).toHaveBeenCalledTimes(1);
    });

    it('drops malformed params without throwing or calling through', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarNotification, 'skillHooks.clearAll');
      expect(() => handler(null)).not.toThrow();
      expect(() => handler({})).not.toThrow();
      expect(() => handler({ runId: 123 })).not.toThrow();
      expect(clearAllSkillHooksMock).not.toHaveBeenCalled();
    });
  });

  // ── tool.invoke (main-loop) handler ─────────────────────────────────────

  describe('tool.invoke (main-loop) handler', () => {
    it('executes via getToolInvoker().executeAnyTool, threading the session callbacks', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const confirmCb = vi.fn().mockResolvedValue(true);
      const filePermCb = vi.fn().mockResolvedValue(true);
      const session = makeSession({ conversationId: 'conv-1', loopId: 'run-1' });
      session.options = { requestCommandConfirmation: confirmCb, requestFilePermission: filePermCb };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const context = { conversationId: 'conv-1', loopId: 'run-1', toolCallId: 'tc-1' };
      const result = await handler({ runId: 'run-1', toolName: 'read_file', input: { path: 'x' }, context });

      expect(result).toBe('tool result');
      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'read_file',
        { path: 'x' },
        confirmCb,
        filePermCb,
        expect.objectContaining({ ...context, abortSignal: session.shellAbortController.signal }),
      );
    });

    it('returns a narrow metadata envelope and checkpoints when a subagent tool reports structured terminal metadata', async () => {
      executeAnyToolMock.mockImplementationOnce(async (...args: unknown[]) => {
        const context = args[4] as { reportMetadata?: (value: unknown) => void };
        context.reportMetadata?.({ subagentStopReason: 'max_turns' });
        return 'partial report';
      });
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());
      chatState = {
        conversations: {
          'conv-1': {
            messages: [{
              id: 'msg-1',
              role: 'assistant',
              content: '',
              timestamp: 0,
              toolCalls: [{ id: 'tc-1', name: 'delegate_to_agent', input: {}, isExecuting: true }],
            }],
          },
        },
        conversationIndex: {},
      } as unknown as ChatStateStub;

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const result = await handler({
        runId: 'run-1',
        toolName: 'delegate_to_agent',
        input: {},
        context: { conversationId: 'conv-1', assistantMessageId: 'msg-1', toolCallId: 'tc-1' },
      });

      expect(result).toEqual({ result: 'partial report', metadata: { subagentStopReason: 'max_turns' } });
      expect(chatDeltaCheckpointToolCallMetadataMock).toHaveBeenCalledWith(
        'conv-1',
        'msg-1',
        'tc-1',
        { subagentStopReason: 'max_turns' },
      );
    });

    it('does not checkpoint metadata when the wire context forges a different conversation', async () => {
      executeAnyToolMock.mockImplementationOnce(async (...args: unknown[]) => {
        const context = args[4] as { reportMetadata?: (value: unknown) => void };
        context.reportMetadata?.({
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: 'conv-1', batchToolCallId: 'tc-1' },
            taskCount: 1,
            counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
          },
        });
        return 'partial report';
      });
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = {
        conversations: {
          'conv-1': {
            messages: [{
              id: 'msg-1',
              role: 'assistant',
              content: '',
              timestamp: 0,
              toolCalls: [{ id: 'tc-1', name: 'run_agent_batch', input: {}, isExecuting: true }],
            }],
          },
          'other-conv': {
            messages: [{
              id: 'msg-1',
              role: 'assistant',
              content: '',
              timestamp: 0,
              toolCalls: [{ id: 'tc-1', name: 'run_agent_batch', input: {}, isExecuting: true }],
            }],
          },
        },
        conversationIndex: {},
      } as unknown as ChatStateStub;

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const result = await handler({
        runId: 'run-1',
        toolName: 'run_agent_batch',
        input: {},
        context: { conversationId: 'other-conv', assistantMessageId: 'msg-1', toolCallId: 'tc-1' },
      });

      expect(result).toEqual({
        result: 'partial report',
        metadata: {
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: 'conv-1', batchToolCallId: 'tc-1' },
            taskCount: 1,
            counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
          },
        },
      });
      expect(chatDeltaCheckpointToolCallMetadataMock).not.toHaveBeenCalled();
    });

    it('drops a forged batch summary identity instead of returning or checkpointing it', async () => {
      executeAnyToolMock.mockImplementationOnce(async (...args: unknown[]) => {
        const context = args[4] as { reportMetadata?: (value: unknown) => void };
        context.reportMetadata?.({
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: 'other-conv', batchToolCallId: 'tc-1' },
            taskCount: 1,
            counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
          },
        });
        return 'partial report';
      });
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = {
        conversations: {
          'conv-1': {
            messages: [{
              id: 'msg-1',
              role: 'assistant',
              content: '',
              timestamp: 0,
              toolCalls: [{ id: 'tc-1', name: 'run_agent_batch', input: {}, isExecuting: true }],
            }],
          },
        },
        conversationIndex: {},
      } as unknown as ChatStateStub;

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const result = await handler({
        runId: 'run-1',
        toolName: 'run_agent_batch',
        input: {},
        context: { conversationId: 'conv-1', assistantMessageId: 'msg-1', toolCallId: 'tc-1' },
      });

      expect(result).toBe('partial report');
      expect(chatDeltaCheckpointToolCallMetadataMock).not.toHaveBeenCalled();
    });

    it('does not checkpoint into a same-conversation historical same-name tool call that is not live', async () => {
      executeAnyToolMock.mockImplementationOnce(async (...args: unknown[]) => {
        const context = args[4] as { reportMetadata?: (value: unknown) => void };
        context.reportMetadata?.({ subagentStopReason: 'max_turns' });
        return 'partial report';
      });
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = {
        conversations: {
          'conv-1': {
            messages: [{
              id: 'msg-1',
              role: 'assistant',
              content: '',
              timestamp: 0,
              toolCalls: [{ id: 'tc-1', name: 'delegate_to_agent', input: {}, isExecuting: false }],
            }],
          },
        },
        conversationIndex: {},
      } as unknown as ChatStateStub;

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const result = await handler({
        runId: 'run-1',
        toolName: 'delegate_to_agent',
        input: {},
        context: { conversationId: 'conv-1', assistantMessageId: 'msg-1', toolCallId: 'tc-1' },
      });

      expect(result).toEqual({ result: 'partial report', metadata: { subagentStopReason: 'max_turns' } });
      expect(chatDeltaCheckpointToolCallMetadataMock).not.toHaveBeenCalled();
    });

    it('falls back to the real permissionBridge default callbacks when session.options omits them', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      await handler({ runId: 'run-1', toolName: 'read_file', input: {} });

      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'read_file',
        {},
        requestCommandConfirmationMock,
        requestFilePermissionMock,
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
    });

    it('refuses a reverse tool call outside the run whitelist before execution', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      session.options = { allowedTools: ['read_*'] };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      await expect(
        handler({ runId: 'run-1', toolName: 'write_file', input: { path: 'x' } }),
      ).rejects.toThrow(/not allowed/);
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });

    it.each(['tool_search', 'use_skill', 'read_file', 'run_command'])(
      'recovery whitelist refuses reverse %s at the shell boundary',
      async (toolName) => {
        const { ensureHandlersRegistered, registerRunSession } = await importFresh();
        ensureHandlersRegistered();
        const session = makeSession();
        session.options = { allowedTools: ['computer', 'ask_user_question'] };
        registerRunSession('run-1', session);

        const handler = handlerFor(onSidecarRequest, 'tool.invoke');
        await expect(
          handler({ runId: 'run-1', toolName, input: {} }),
        ).rejects.toThrow(/not allowed/);
        expect(executeAnyToolMock).not.toHaveBeenCalled();
      },
    );

    it('refuses a reverse tool call matching a blockedTools NAMESPACE WILDCARD, not just an exact name', async () => {
      // `blockedTools` carries `abu-browser__*` for the read_tools trigger
      // tier (browserToolPolicy.listAllBrowserToolPatterns). resolveTools and
      // executeToolBatch glob-match it; this shell boundary is the third
      // enforcement point and must not fall back to exact-name matching.
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      session.options = { blockedTools: ['request_workspace', 'abu-browser__*'] };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      await expect(
        handler({ runId: 'run-1', toolName: 'abu-browser__click', input: {} }),
      ).rejects.toThrow(/blocked/);
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });

    it('still matches a non-wildcard blockedTools entry exactly — no accidental prefix widening', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      session.options = { blockedTools: ['request_workspace'] };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      await expect(
        handler({ runId: 'run-1', toolName: 'request_workspace', input: {} }),
      ).rejects.toThrow(/blocked/);
      // A name merely *containing* the blocked entry must still run.
      await handler({ runId: 'run-1', toolName: 'request_workspace_v2', input: {} });
      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'request_workspace_v2',
        {},
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('marks the session committed on the first tool.invoke', async () => {
      const { ensureHandlersRegistered, registerRunSession, getRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());
      expect(getRunSession('run-1')?.committed).not.toBe(true);

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      await handler({ runId: 'run-1', toolName: 'read_file', input: {} });

      expect(getRunSession('run-1')?.committed).toBe(true);
    });

    it('throws for an unknown runId instead of silently executing', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'tool.invoke');

      await expect(handler({ runId: 'no-such-run', toolName: 'read_file', input: {} })).rejects.toThrow();
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });

    // P1-3c-2 (design doc §3 change 3 / P1-3C-SCOUT-REPORT.md §5 "secondary
    // finding") — the residual window `deleteConversation`'s fire-and-forget
    // abort can't close by itself: a `tool.invoke` for a KNOWN, still-
    // registered runId can still arrive after the shell has erased the
    // conversation record (deletion doesn't unregister the run session —
    // that only happens when the `agent.run` RPC resolves, later).
    it('refuses to execute when the run\'s conversation has been deleted (known runId, no conversation record)', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      // Simulate deleteConversation having already erased the record while
      // the run session itself is still registered.
      chatState = { conversations: {}, conversationIndex: {} };

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');

      await expect(handler({ runId: 'run-1', toolName: 'write_file', input: { path: 'x', content: 'y' } }))
        .rejects.toThrow();
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });

    it('still executes when the run\'s conversation record exists', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = { conversations: { 'conv-1': {} }, conversationIndex: {} };

      const handler = handlerFor(onSidecarRequest, 'tool.invoke');
      const result = await handler({ runId: 'run-1', toolName: 'read_file', input: {} });

      expect(result).toBe('tool result');
      expect(executeAnyToolMock).toHaveBeenCalled();
    });

    it('rejects malformed params (missing runId/toolName)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'tool.invoke');

      await expect(handler(null)).rejects.toThrow();
      await expect(handler({ runId: 'run-1' })).rejects.toThrow();
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });
  });

  // ── approval.check handler (P1-3d-3) ────────────────────────────────────
  //
  // Symmetric twin of the `tool.invoke` handler tests above, but for the
  // sidecar's "would this local tool call be approved?" reverse request
  // (see `handleApprovalCheck`'s doc). SAFETY-CRITICAL: this is the shell
  // half of the fail-closed contract — the sidecar-side half
  // (`checkLocalToolApproval` in `sidecar/src/agentLoopHost.ts`) is covered
  // by `agentLoopHost.test.ts`'s "local tool dispatch" describe block.

  describe('approval.check handler', () => {
    it('returns {decision:"allow"} from checkToolApproval, threading the session callbacks', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const confirmCb = vi.fn().mockResolvedValue(true);
      const filePermCb = vi.fn().mockResolvedValue(true);
      const session = makeSession({ conversationId: 'conv-1', loopId: 'run-1' });
      session.options = { requestCommandConfirmation: confirmCb, requestFilePermission: filePermCb };
      registerRunSession('run-1', session);
      checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      const context = { conversationId: 'conv-1', loopId: 'run-1' };
      const result = await handler({ runId: 'run-1', toolName: 'show_widget', input: { title: 't' }, context });

      expect(result).toEqual({ decision: 'allow' });
      expect(checkToolApprovalMock).toHaveBeenCalledWith(
        'show_widget',
        { title: 't' },
        expect.objectContaining({ conversationId: 'conv-1', loopId: 'run-1' }),
        confirmCb,
        filePermCb,
      );
    });

    it('marks an allowed side-effecting local tool as committed before returning its ACK', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      registerRunSession('run-write', session);
      getAllToolsMock.mockReturnValueOnce([{
        name: 'write_file', description: 'writes', inputSchema: { type: 'object', properties: {} },
        execute: async () => 'ok', isConcurrencySafe: false,
      }]);
      checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      await handler({ runId: 'run-write', toolName: 'write_file', input: { path: '/tmp/x' } });

      expect((session as typeof session & { committed?: boolean }).committed).toBe(true);
    });

    it('keeps an allowed read-only local tool replay-safe', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      registerRunSession('run-read', session);
      checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      await handler({ runId: 'run-read', toolName: 'read_file', input: { path: '/tmp/x' } });

      expect((session as typeof session & { committed?: boolean }).committed).not.toBe(true);
    });

    it('marks an allowed HTTP mutation as committed before returning its ACK', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      registerRunSession('run-http', session);
      getAllToolsMock.mockReturnValueOnce([{
        name: 'http_fetch', description: 'fetches', inputSchema: { type: 'object', properties: {} },
        execute: async () => 'ok', isConcurrencySafe: false,
      }]);
      checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });

      await handlerFor(onSidecarRequest, 'approval.check')({
        runId: 'run-http',
        toolName: 'http_fetch',
        input: { url: 'https://example.com/items', method: 'POST', body: '{}' },
      });

      expect((session as typeof session & { committed?: boolean }).committed).toBe(true);
    });

    it('returns {decision:"deny", reason} verbatim from checkToolApproval — never executes anything itself', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());
      checkToolApprovalMock.mockResolvedValue({ decision: 'deny', reason: 'Error: [policy] blocked by enterprise policy' });

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      const result = await handler({ runId: 'run-1', toolName: 'show_widget', input: {} });

      expect(result).toEqual({ decision: 'deny', reason: 'Error: [policy] blocked by enterprise policy' });
      expect(executeAnyToolMock).not.toHaveBeenCalled(); // approval.check must never itself execute the tool
    });

    it('falls back to the real permissionBridge default callbacks when session.options omits them', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession());

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      await handler({ runId: 'run-1', toolName: 'show_widget', input: {} });

      expect(checkToolApprovalMock).toHaveBeenCalledWith(
        'show_widget',
        {},
        expect.objectContaining({ conversationId: 'conv-1', loopId: 'loop-1' }),
        requestCommandConfirmationMock,
        requestFilePermissionMock,
      );
    });

    it('refuses local sidecar approval outside the run whitelist', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      const session = makeSession();
      session.options = { allowedTools: ['read_*'] };
      registerRunSession('run-1', session);

      const handler = handlerFor(onSidecarRequest, 'approval.check');
      await expect(
        handler({ runId: 'run-1', toolName: 'write_file', input: { path: 'x' } }),
      ).rejects.toThrow(/not allowed/);
      expect(checkToolApprovalMock).not.toHaveBeenCalled();
    });

    it.each(['tool_search', 'use_skill', 'read_file', 'run_command'])(
      'recovery whitelist refuses local %s approval at the shell boundary',
      async (toolName) => {
        const { ensureHandlersRegistered, registerRunSession } = await importFresh();
        ensureHandlersRegistered();
        const session = makeSession();
        session.options = { allowedTools: ['computer', 'ask_user_question'] };
        registerRunSession('run-1', session);

        const handler = handlerFor(onSidecarRequest, 'approval.check');
        await expect(
          handler({ runId: 'run-1', toolName, input: {} }),
        ).rejects.toThrow(/not allowed/);
        expect(checkToolApprovalMock).not.toHaveBeenCalled();
      },
    );

    it('throws for an unknown runId instead of silently answering', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'approval.check');

      await expect(handler({ runId: 'no-such-run', toolName: 'show_widget', input: {} })).rejects.toThrow();
      expect(checkToolApprovalMock).not.toHaveBeenCalled();
    });

    it('refuses to answer when the run\'s conversation has been deleted (known runId, no conversation record) — same fail-closed discipline as tool.invoke', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = { conversations: {}, conversationIndex: {} };

      const handler = handlerFor(onSidecarRequest, 'approval.check');

      await expect(handler({ runId: 'run-1', toolName: 'show_widget', input: {} })).rejects.toThrow();
      expect(checkToolApprovalMock).not.toHaveBeenCalled();
    });

    it('rejects malformed params (missing runId/toolName)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'approval.check');

      await expect(handler(null)).rejects.toThrow();
      await expect(handler({ runId: 'run-1' })).rejects.toThrow();
      expect(checkToolApprovalMock).not.toHaveBeenCalled();
    });
  });

  // ── workspace.bindFromWrite (P1-3d A-write) ─────────────────────────────
  //
  // Shell-side twin of `sidecar/src/shims/defaultWorkspaceRun.ts`'s
  // `bindWorkspaceFromWrite` — a fire-and-forget NOTIFICATION forwarded when
  // a locally-executed `write_file` calls it. See `handleWorkspaceBindFromWrite`'s
  // own doc.

  describe('workspace.bindFromWrite handler', () => {
    it('calls the real bindWorkspaceFromWrite with conversationId and path, for a known runId', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const handler = handlerFor(onSidecarNotification, 'workspace.bindFromWrite');
      handler({ runId: 'run-1', conversationId: 'conv-1', path: '/Users/x/Abu/report/out.html' });
      await Promise.resolve();

      expect(bindWorkspaceFromWriteMock).toHaveBeenCalledWith('conv-1', '/Users/x/Abu/report/out.html');
    });

    it('silently drops for an unknown/already-finished runId (3a discipline — same as agent.delta)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();

      const handler = handlerFor(onSidecarNotification, 'workspace.bindFromWrite');
      expect(() => handler({ runId: 'no-such-run', conversationId: 'conv-1', path: '/tmp/x' })).not.toThrow();
      await Promise.resolve();

      expect(bindWorkspaceFromWriteMock).not.toHaveBeenCalled();
    });

    it('silently drops a notification that targets a conversation not owned by the run', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const handler = handlerFor(onSidecarNotification, 'workspace.bindFromWrite');
      expect(() => handler({
        runId: 'run-1',
        conversationId: 'conv-forged',
        path: '/Users/x/Abu/report/out.html',
      })).not.toThrow();
      await Promise.resolve();

      expect(bindWorkspaceFromWriteMock).not.toHaveBeenCalled();
    });

    it('silently drops malformed params (missing runId/path)', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const handler = handlerFor(onSidecarNotification, 'workspace.bindFromWrite');
      expect(() => handler(null)).not.toThrow();
      expect(() => handler({ runId: 'run-1' })).not.toThrow();
      await Promise.resolve();

      expect(bindWorkspaceFromWriteMock).not.toHaveBeenCalled();
    });

    it('never throws even if the real bindWorkspaceFromWrite rejects (fire-and-forget — logged, not propagated)', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      bindWorkspaceFromWriteMock.mockRejectedValueOnce(new Error('store write failed'));

      const handler = handlerFor(onSidecarNotification, 'workspace.bindFromWrite');
      expect(() => handler({ runId: 'run-1', conversationId: 'conv-1', path: '/tmp/x' })).not.toThrow();
      await Promise.resolve();
      await Promise.resolve(); // flush the rejected promise's .catch()
    });
  });

  // ── snapshot.beforeAiEdit (P1-3d A-write) ───────────────────────────────
  //
  // Shell-side twin of `sidecar/src/shims/aiEditSnapshotsRun.ts`'s
  // `snapshotBeforeAiEdit` — an AWAITED REQUEST forwarded when a
  // locally-executed `write_file`/`edit_file` calls it. Symmetric to
  // `approval.check`'s tests above (same session-lookup/fail-closed
  // discipline), but a throw here is swallowed by the sidecar shim's
  // fail-open catch, never surfaced to the user as a denial — see
  // `handleSnapshotBeforeAiEdit`'s own doc.

  describe('snapshot.beforeAiEdit handler', () => {
    it('calls the real snapshotBeforeAiEdit with path + opts, for a known runId with an existing conversation', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const handler = handlerFor(onSidecarRequest, 'snapshot.beforeAiEdit');
      const result = await handler({
        runId: 'run-1',
        path: '/tmp/x.txt',
        opts: { loopId: 'loop-1', conversationId: 'conv-1', knownContent: 'hello' },
      });

      expect(result).toBeNull();
      expect(snapshotBeforeAiEditMock).toHaveBeenCalledWith('/tmp/x.txt', {
        loopId: 'loop-1',
        conversationId: 'conv-1',
        knownContent: 'hello',
      });
    });

    it('tolerates a missing/empty opts object (defaults every field to undefined)', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));

      const handler = handlerFor(onSidecarRequest, 'snapshot.beforeAiEdit');
      await handler({ runId: 'run-1', path: '/tmp/x.txt' });

      expect(snapshotBeforeAiEditMock).toHaveBeenCalledWith('/tmp/x.txt', {
        loopId: undefined,
        conversationId: undefined,
        knownContent: undefined,
      });
    });

    it('throws for an unknown runId instead of silently answering', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'snapshot.beforeAiEdit');

      await expect(handler({ runId: 'no-such-run', path: '/tmp/x.txt' })).rejects.toThrow();
      expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
    });

    it('refuses to answer when the run\'s conversation has been deleted (known runId, no conversation record) — same fail-closed discipline as approval.check/tool.invoke', async () => {
      const { ensureHandlersRegistered, registerRunSession } = await importFresh();
      ensureHandlersRegistered();
      registerRunSession('run-1', makeSession({ conversationId: 'conv-1' }));
      chatState = { conversations: {}, conversationIndex: {} };

      const handler = handlerFor(onSidecarRequest, 'snapshot.beforeAiEdit');

      await expect(handler({ runId: 'run-1', path: '/tmp/x.txt' })).rejects.toThrow();
      expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
    });

    it('rejects malformed params (missing runId/path)', async () => {
      const { ensureHandlersRegistered } = await importFresh();
      ensureHandlersRegistered();
      const handler = handlerFor(onSidecarRequest, 'snapshot.beforeAiEdit');

      await expect(handler(null)).rejects.toThrow();
      await expect(handler({ runId: 'run-1' })).rejects.toThrow();
      expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
    });
  });

  // ── runAgentLoopDispatched (the dispatch entrypoint) ────────────────────

  describe('runAgentLoopDispatched', () => {
    /** Deferred promise helper — lets a test control exactly when sidecarRequest() settles (mirrors subagentRunner.test.ts's own helper). */
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    /** Advances microtasks until the given mock has been called (or gives up after `times` ticks) — dispatch does async work (buildAgentRunParams awaits precomputeOrchestration) before it reaches sidecarRequest. */
    async function waitForCall(mock: ReturnType<typeof vi.fn>, times = 30): Promise<void> {
      for (let i = 0; i < times; i++) {
        if (mock.mock.calls.length > 0) return;
        await Promise.resolve();
      }
    }

    beforeEach(() => {
      getConversationMock.mockReturnValue({ id: 'conv-1', title: 't', messages: [], status: 'idle' });
      getIndexEntryMock.mockReturnValue(undefined);
      getSettingsSnapshotMock.mockReturnValue(dispatchSettingsSnapshot());
    });

    it('runs in-process (runAgentLoop) when the sidecar is not running', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      getSidecarStatusMock.mockReturnValue('stopped');

      const result = await runAgentLoopDispatched('conv-1', 'hello');

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      expect(runAgentLoopMock).toHaveBeenCalledWith('conv-1', 'hello', {
        runtimeEvent: expect.any(Function),
      });
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(result).toEqual({ reason: 'completed' });
    });

    it('dispatches agent.run when the sidecar is running and returns the sidecar result', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      const result = await runAgentLoopDispatched('conv-1', 'hello');

      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      const [method, params, timeoutMs] = sidecarRequestMock.mock.calls[0];
      expect(method).toBe('agent.run');
      expect(timeoutMs).toBe(0);
      const p = params as { runId: string; conversationId: string; userMessage: string; resolvedCreds: unknown; toolList: unknown[] };
      expect(typeof p.runId).toBe('string');
      expect(p.conversationId).toBe('conv-1');
      expect(p.userMessage).toBe('hello');
      expect(p.resolvedCreds).toEqual({ apiKey: 'sk-1', baseUrl: undefined, forceOpenAiCompatible: false });
      expect(p.toolList).toEqual([{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} } }]);
      expect(result).toEqual({ reason: 'completed' });
      const runId = (params as { runId: string }).runId;
      expect(endComputerUseTaskMock).toHaveBeenCalledOnce();
      expect(endComputerUseTaskMock).toHaveBeenCalledWith('conv-1', runId);
    });

    it('keeps imContext on both wire params and the installed shell LoopContext', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const imContext = { platform: 'dchat' as const, workspacePath: '/im/workspace' };
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello', { imContext });

      const params = sidecarRequestMock.mock.calls[0][1] as {
        options: { imContext?: unknown };
      };
      expect(params.options.imContext).toBe(imContext);
      const installedContext = setLoopContextMock.mock.calls.at(-1)?.[1] as {
        imContext?: unknown;
      };
      expect(installedContext.imContext).toBe(imContext);
    });

    it('does not let shell-side Computer Use cleanup failure replace the settled run result', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });
      endComputerUseTaskMock.mockRejectedValueOnce(new Error('cleanup transport closed'));

      await expect(runAgentLoopDispatched('conv-1', 'hello')).resolves.toEqual({ reason: 'completed' });

      expect(traceRuntimeEventMock).toHaveBeenCalledWith(
        'renderer.computer_use_task_cleanup',
        expect.objectContaining({
          conversationId: 'conv-1',
          stage: 'run_finally',
          outcome: 'error',
        }),
      );
    });

    it('starts queued user follow-ups FIFO as independent runs with fresh loopIds', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });
      dequeueNextUserInputMock
        .mockReturnValueOnce({ id: 'q1', text: 'first follow-up', timestamp: 1 })
        .mockReturnValueOnce({ id: 'q2', text: 'second follow-up', timestamp: 2 })
        .mockReturnValue(undefined);

      const result = await runAgentLoopDispatched('conv-1', 'original task');

      expect(result).toEqual({ reason: 'completed' });
      expect(sidecarRequestMock).toHaveBeenCalledTimes(3);
      const payloads = sidecarRequestMock.mock.calls.map((call) => call[1] as {
        runId: string;
        conversationId: string;
        userMessage: string;
      });
      expect(payloads.map((payload) => payload.userMessage)).toEqual([
        'original task',
        'first follow-up',
        'second follow-up',
      ]);
      expect(new Set(payloads.map((payload) => payload.runId)).size).toBe(3);
      expect(chatStoreAddMessageMock.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'original task', loopId: payloads[0].runId }),
          expect.objectContaining({ content: 'first follow-up', loopId: payloads[1].runId }),
          expect.objectContaining({ content: 'second follow-up', loopId: payloads[2].runId }),
        ]),
      );
    });

    it('does not fan out the remaining queue after a handed-off run fails', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock
        .mockResolvedValueOnce({ reason: 'completed' })
        .mockResolvedValueOnce({ reason: 'error', error: 'provider unavailable' });
      dequeueNextUserInputMock
        .mockReturnValueOnce({ id: 'q1', text: 'first follow-up', timestamp: 1 })
        .mockReturnValueOnce({ id: 'q2', text: 'must remain queued', timestamp: 2 });
      getQueuedInputsMock.mockReturnValue([
        { id: 'q2', text: 'must remain queued', timestamp: 2 },
      ]);

      await expect(runAgentLoopDispatched('conv-1', 'original task'))
        .resolves.toEqual({ reason: 'completed' });

      expect(sidecarRequestMock).toHaveBeenCalledTimes(2);
      expect(dequeueNextUserInputMock).toHaveBeenCalledTimes(1);
      expect(pauseUserInputQueueMock).toHaveBeenCalledWith('conv-1');
    });

    it('persists the user message before the bounded start handshake', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello');

      expect(chatStoreAddMessageMock).toHaveBeenCalledWith('conv-1', expect.objectContaining({
        role: 'user',
        content: 'hello',
        runState: 'pending',
        runId: expect.any(String),
        clientMessageId: expect.any(String),
      }));
      expect(chatStoreAddMessageMock.mock.invocationCallOrder[0])
        .toBeLessThan(agentStartRequestMock.mock.invocationCallOrder[0]);
      expect(waitForConversationPersistenceMock).toHaveBeenCalledWith('conv-1');
      const startParams = agentStartRequestMock.mock.calls[0][0] as {
        runId: string;
        clientMessageId: string;
        payloadDigest: string;
        options: { prePersistedUserMessageId?: string };
      };
      expect(startParams.clientMessageId).toBe(`msg-${startParams.runId}`);
      expect(startParams.payloadDigest).toMatch(/^rrp1-/);
      expect(startParams.options.prePersistedUserMessageId).toBe(startParams.clientMessageId);
    });

    it('does not start or fall back when the durable user-message append fails', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      waitForConversationPersistenceMock
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockRejectedValueOnce(new Error('disk unavailable'));

      await expect(runAgentLoopDispatched('conv-1', 'hello')).resolves.toEqual({
        reason: 'error',
        error: '消息未能写入磁盘，阿布没有启动任务。请检查磁盘权限后重试。',
      });

      expect(agentStartRequestMock).not.toHaveBeenCalled();
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(markRuntimeRunStageMock).not.toHaveBeenCalledWith(expect.any(String), 'local_message_persisted');
      expect(traceRuntimeEventMock).toHaveBeenCalledWith(
        'renderer.local_message_persist_failed',
        expect.objectContaining({ stage: 'local_message_persist_failed' }),
      );
    });

    it('recovers a lost start ACK from run.getState without replaying execution', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      agentStartRequestMock.mockRejectedValueOnce(new Error('ACK lost'));
      runGetStateRequestMock.mockImplementationOnce((params: { runId: string }) => Promise.resolve({
        version: 1,
        runId: params.runId,
        state: 'running',
      }));
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await expect(runAgentLoopDispatched('conv-1', 'hello')).resolves.toEqual({ reason: 'completed' });
      expect(agentStartRequestMock).toHaveBeenCalledTimes(1);
      expect(runGetStateRequestMock).toHaveBeenCalledTimes(1);
      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      expect(chatStoreUpdateUserMessageRunMock).toHaveBeenCalledWith(
        'conv-1',
        expect.any(String),
        expect.objectContaining({ state: 'running' }),
      );
    });

    it('replays agent.start once with identical ids when state is not found', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      agentStartRequestMock
        .mockRejectedValueOnce(new Error('ACK lost'))
        .mockImplementationOnce((params: { runId: string; clientMessageId: string }) => Promise.resolve({
          version: 1,
          runId: params.runId,
          clientMessageId: params.clientMessageId,
          acceptedAt: 2,
          state: 'accepted',
          replay: false,
        }));
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello');

      expect(agentStartRequestMock).toHaveBeenCalledTimes(2);
      const first = agentStartRequestMock.mock.calls[0][0] as { runId: string; clientMessageId: string; payloadDigest: string };
      const second = agentStartRequestMock.mock.calls[1][0] as typeof first;
      expect(second).toMatchObject(first);
    });

    it('reattaches to an accepted running sidecar run after the execution RPC transport closes', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockRejectedValueOnce(new Error('execution response transport closed'));
      runGetStateRequestMock.mockImplementationOnce((params: { runId: string }) => Promise.resolve({
        version: 1,
        runId: params.runId,
        state: 'running',
      }));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      for (let i = 0; i < 20 && runGetStateRequestMock.mock.calls.length === 0; i++) await Promise.resolve();
      handlerFor(onSidecarNotification, 'agent.terminal')({
        version: 1,
        runId,
        state: 'completed',
        result: { reason: 'completed' },
      });

      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
    });

    it('replays execution once after a pre-commit sidecar restart reports not_found', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock
        .mockRejectedValueOnce(new Error('sidecar restarted'))
        .mockResolvedValueOnce({ reason: 'completed' });

      await expect(runAgentLoopDispatched('conv-1', 'hello')).resolves.toEqual({ reason: 'completed' });

      expect(sidecarRequestMock.mock.calls.filter((call) => call[0] === 'agent.run')).toHaveLength(2);
      expect(agentStartRequestMock).toHaveBeenCalledTimes(2);
      const starts = agentStartRequestMock.mock.calls.map((call) => call[0] as {
        runId: string;
        clientMessageId: string;
        payloadDigest: string;
      });
      expect(starts[1]).toMatchObject(starts[0]);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it('uses a cached terminal returned by run.getState and never replays work', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockRejectedValueOnce(new Error('response lost'));
      runGetStateRequestMock.mockImplementationOnce((params: { runId: string }) => Promise.resolve({
        version: 1,
        runId: params.runId,
        state: 'terminal',
        terminal: {
          version: 1,
          runId: params.runId,
          state: 'completed',
          result: { reason: 'completed' },
        },
      }));

      await expect(runAgentLoopDispatched('conv-1', 'hello')).resolves.toEqual({ reason: 'completed' });
      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      expect(agentStartRequestMock).toHaveBeenCalledTimes(1);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it('settles from agent.terminal when the RPC response is lost, without surfacing an error or rerunning', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      let runSignal: AbortSignal | undefined;
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => {
        runSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      terminalHandler({ version: 1, runId, state: 'completed', result: { reason: 'completed' } });

      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(runSignal?.aborted).toBe(true);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(chatDeltaAppendTextMock).not.toHaveBeenCalledWith('conv-1', expect.stringContaining('Error'));
    });

    it('keeps the first completed terminal when Stop races with renderer cleanup', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      getAbortControllerMock.mockReturnValue(shellController);
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      terminalHandler({ version: 1, runId, state: 'completed', result: { reason: 'completed' } });
      shellController.abort();

      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(sidecarRequestMock).not.toHaveBeenCalledWith('agent.abort', expect.anything(), expect.anything());
      expect(chatDeltaCancelStreamingMock).not.toHaveBeenCalled();
    });

    it('aborts scoped shell controllers after a terminal without sending a late agent.abort', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      getAbortControllerMock.mockReturnValue(shellController);
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));

      const running = runAgentLoopDispatched('conv-1', 'hello', { authorizationScopeId: 'scope-shell' });
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      terminalHandler({ version: 1, runId, state: 'completed', result: { reason: 'completed' } });

      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(shellController.signal.aborted).toBe(true);
      expect(sidecarRequestMock).not.toHaveBeenCalledWith('agent.abort', expect.anything(), expect.anything());
    });

    it('uses a failed terminal before any delta as authoritative and finalizes the UI exactly once', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      const failed = {
        version: 1,
        runId,
        state: 'failed',
        result: { reason: 'error', error: 'provider failed' },
        failure: { errorType: 'provider_error', message: 'provider failed', stack: 'provider stack' },
      };
      terminalHandler(failed);
      terminalHandler(failed);

      await expect(running).resolves.toEqual({ reason: 'error', error: 'provider failed' });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(chatDeltaAppendTextMock).toHaveBeenCalledTimes(1);
      expect(chatDeltaAppendTextMock).toHaveBeenCalledWith('conv-1', expect.stringContaining('provider failed'));
      expect(chatDeltaFinishStreamingMock).toHaveBeenCalledTimes(1);
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'error');
    });

    it('skips re-appending the error text when agentLoop already rendered it (errorType: agent_loop_error)', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const terminalHandler = handlerFor(onSidecarNotification, 'agent.terminal');
      terminalHandler({
        version: 1,
        runId,
        state: 'failed',
        result: { reason: 'error', error: '余额不足或无可用资源包，请充值。' },
        failure: { errorType: 'agent_loop_error', message: '余额不足或无可用资源包，请充值。' },
      });

      await expect(running).resolves.toEqual({ reason: 'error', error: '余额不足或无可用资源包，请充值。' });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      // agentLoop's own catch branch already appended the display error inside
      // the sidecar — the shell must not render it a second time.
      expect(chatDeltaAppendTextMock).not.toHaveBeenCalled();
      expect(chatDeltaFinishStreamingMock).toHaveBeenCalledTimes(1);
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'error');
    });

    it('does not settle a failed terminal until its failed lifecycle is durable', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const failurePersistence = deferred<void>();
      waitForConversationPersistenceMock.mockImplementation(() => (
        waitForConversationPersistenceMock.mock.calls.length === 4
          ? failurePersistence.promise
          : Promise.resolve()
      ));
      sidecarRequestMock.mockImplementation((_method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      ));

      let settled = false;
      const running = runAgentLoopDispatched('conv-1', 'hello').finally(() => { settled = true; });
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      handlerFor(onSidecarNotification, 'agent.terminal')({
        version: 1,
        runId,
        state: 'failed',
        result: { reason: 'error', error: 'provider failed' },
        failure: { errorType: 'provider_error', message: 'provider failed' },
      });

      await vi.waitFor(() => expect(waitForConversationPersistenceMock).toHaveBeenCalledTimes(4));
      expect(settled).toBe(false);
      failurePersistence.resolve();
      await expect(running).resolves.toEqual({ reason: 'error', error: 'provider failed' });
    });

    it('records a stall after 30 seconds without a non-empty delta, without changing run behavior', async () => {
      vi.useFakeTimers();
      const { runAgentLoopDispatched } = await importFresh();
      const rpc = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(rpc.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await vi.advanceTimersByTimeAsync(29_999);
      expect(traceRuntimeEventMock).not.toHaveBeenCalledWith(
        'renderer.agent_run_stalled',
        expect.anything(),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(traceRuntimeEventMock).toHaveBeenCalledWith(
        'renderer.agent_run_stalled',
        expect.objectContaining({ runId, stage: 'stalled_before_first_delta' }),
      );

      rpc.resolve({ reason: 'completed' });
      await expect(running).resolves.toEqual({ reason: 'completed' });
    });

    it('first delta clears the stall timer and records successful frame application', async () => {
      vi.useFakeTimers();
      const { runAgentLoopDispatched } = await importFresh();
      const rpc = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(rpc.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      await vi.advanceTimersByTimeAsync(10_000);
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'first'] }] });
      await vi.waitFor(() => expect(applyDeltaFramesMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(traceRuntimeEventMock).toHaveBeenCalledWith(
        'renderer.agent_delta_received',
        expect.objectContaining({ runId, frameCount: 1 }),
      );
      expect(traceRuntimeEventMock).toHaveBeenCalledWith(
        'renderer.first_frame_applied',
        expect.objectContaining({ runId, frameCount: 1 }),
      );
      expect(traceRuntimeEventMock).not.toHaveBeenCalledWith(
        'renderer.agent_run_stalled',
        expect.anything(),
      );

      rpc.resolve({ reason: 'completed' });
      await expect(running).resolves.toEqual({ reason: 'completed' });
    });

    it('serializes the per-run tool whitelist into agent.run options', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'read only', { allowedTools: ['read_*'] });

      const params = sidecarRequestMock.mock.calls[0][1] as {
        options: { allowedTools?: string[] };
      };
      expect(params.options.allowedTools).toEqual(['read_*']);
    });

    it('keeps the entry provider, model, and credentials atomic when the conversation model changes during persistence', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const p1Model = { providerId: 'p1', modelId: 'model-a' };
      const p2Model = { providerId: 'p2', modelId: 'model-b' };
      getSettingsSnapshotMock.mockReturnValue({
        agentMaxTurns: 200,
        activeModel: p1Model,
        providers: [
          { id: 'p1', name: 'P1', apiFormat: 'anthropic', enabled: true, apiKey: 'p1-key', baseUrl: 'https://p1.test', models: [{ id: 'model-a', name: 'Model A' }] },
          { id: 'p2', name: 'P2', apiFormat: 'openai-compatible', enabled: true, apiKey: 'p2-key', baseUrl: 'https://p2.test', models: [{ id: 'model-b', name: 'Model B' }] },
        ],
      });
      let conversation = { id: 'conv-1', title: 't', messages: [], status: 'idle' } as Record<string, unknown>;
      getConversationMock.mockImplementation(() => conversation);
      let persistenceCount = 0;
      waitForConversationPersistenceMock.mockImplementation(async () => {
        persistenceCount += 1;
        if (persistenceCount === 2) conversation = { ...conversation, model: p2Model };
      });
      resolveEffectiveLlmCredsMock.mockImplementation((apiKey: string, baseUrl: string | undefined) => ({
        apiKey,
        baseUrl,
        forceOpenAiCompatible: false,
      }));
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello');

      const params = sidecarRequestMock.mock.calls[0][1] as {
        conversationSnapshot: { model?: unknown };
        settingsSnapshot: { activeModel: unknown };
        resolvedCreds: { apiKey: string; baseUrl?: string };
      };
      expect(params.conversationSnapshot.model).toEqual(p1Model);
      expect(params.settingsSnapshot.activeModel).toEqual(p1Model);
      expect(params.resolvedCreds).toEqual({
        apiKey: 'p1-key',
        baseUrl: 'https://p1.test',
        forceOpenAiCompatible: false,
      });
      const installedContext = setLoopContextMock.mock.calls.at(-1)?.[1] as {
        settingsReader?: { getSnapshot: () => { activeModel: unknown } };
      };
      expect(installedContext.settingsReader?.getSnapshot().activeModel).toEqual(p1Model);
    });

    it('creates the task controller before prompt preprocessing and stops without dispatching when it is aborted there', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const controller = new AbortController();
      getAbortControllerMock.mockReturnValue(controller);
      const orchestration = deferred<{
        route: { type: 'general'; name: string; cleanInput: string };
        systemPromptSections: never[];
      }>();
      precomputeOrchestrationMock.mockReturnValue(orchestration.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(precomputeOrchestrationMock);
      expect(precomputeOrchestrationMock.mock.calls[0][4]).toBe(controller.signal);
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'running');

      controller.abort();
      orchestration.resolve({
        route: { type: 'general', name: 'general', cleanInput: 'hello' },
        systemPromptSections: [],
      });

      await expect(running).resolves.toEqual({ reason: 'aborted' });
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(clearAbortControllerMock).toHaveBeenLastCalledWith('conv-1');
      expect(chatDeltaSetConversationStatusMock).toHaveBeenLastCalledWith('conv-1', 'idle');
    });

    it('propagates a durability failure for an interrupted run aborted during parameter construction', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const controller = new AbortController();
      getAbortControllerMock.mockReturnValue(controller);
      const orchestration = deferred<{
        route: { type: 'general'; name: string; cleanInput: string };
        systemPromptSections: never[];
      }>();
      precomputeOrchestrationMock.mockReturnValue(orchestration.promise);
      waitForConversationPersistenceMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('interrupted lifecycle not durable'));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(precomputeOrchestrationMock);
      controller.abort();
      orchestration.reject(new Error('prompt construction aborted'));

      await expect(running).rejects.toThrow('interrupted lifecycle not durable');
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(chatStoreUpdateUserMessageRunMock).toHaveBeenCalledWith(
        'conv-1',
        expect.any(String),
        { state: 'interrupted' },
      );
    });

    it('propagates a durability failure for an interrupted run aborted immediately before dispatch', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const controller = new AbortController();
      getAbortControllerMock.mockReturnValue(controller);
      waitForConversationPersistenceMock
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => { controller.abort(); })
        .mockRejectedValueOnce(new Error('pre-dispatch lifecycle not durable'));

      const running = runAgentLoopDispatched('conv-1', 'hello');

      await expect(running).rejects.toThrow('pre-dispatch lifecycle not durable');
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(chatStoreUpdateUserMessageRunMock).toHaveBeenCalledWith(
        'conv-1',
        expect.any(String),
        { state: 'interrupted' },
      );
    });

    it('buildAgentRunParams includes only system wake-ups from the shell queue at dispatch time', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      getQueuedInputsMock.mockReturnValue([
        { id: 'q1', text: 'leftover 1', timestamp: 111 },
        { id: 'q2', text: 'leftover 2', timestamp: 222, isSystem: true },
      ]);
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello');

      const params = sidecarRequestMock.mock.calls[0][1] as { queuedInputs: unknown };
      // User follow-ups remain shell-side; the system entry is projected to
      // id/text/isSystem and the shell-local timestamp is dropped.
      expect(params.queuedInputs).toEqual([
        { id: 'q2', text: 'leftover 2', isSystem: true },
      ]);
    });

    it('queuedInputs is an empty array when the shell queue has nothing staged', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      getQueuedInputsMock.mockReturnValue([]);
      sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

      await runAgentLoopDispatched('conv-1', 'hello');

      const params = sidecarRequestMock.mock.calls[0][1] as { queuedInputs: unknown };
      expect(params.queuedInputs).toEqual([]);
    });

    it('pre-seeds the new RunSession.forwardedQueueIds from the queuedInputs snapshot, so the live forwarder never re-sends a dispatch-time leftover', async () => {
      const { runAgentLoopDispatched, getRunSession } = await importFresh();
      getQueuedInputsMock.mockReturnValue([{ id: 'leftover-1', text: 'already seeded', timestamp: 1, isSystem: true }]);
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      expect(getRunSession(runId)?.forwardedQueueIds?.has('leftover-1')).toBe(true);

      // The live forwarder must not re-forward it even if the (unrelated) queue-change listener fires.
      capturedQueueCb?.();
      expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());

      d.resolve({ reason: 'completed' });
      await p;
    });

    it('registers and then unregisters the RunSession across a successful dispatch', async () => {
      const { runAgentLoopDispatched, getRunSession, __getActiveRunSessionCount } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      expect(getRunSession(runId)).toBeDefined();
      expect(setLoopContextMock).toHaveBeenCalledTimes(1);

      d.resolve({ reason: 'completed' });
      await p;
      expect(getRunSession(runId)).toBeUndefined();
      expect(__getActiveRunSessionCount()).toBe(0);
      expect(clearLoopContextMock).toHaveBeenCalledTimes(1);
      expect(clearAbortControllerMock).toHaveBeenCalledWith('conv-1');
    });

    it('Stop uses an acknowledged abort request, finalizes locally, and closes the hung agent.run transport', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      getAbortControllerMock.mockReturnValue(shellController);
      sidecarRequestMock.mockImplementation((method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => {
        if (method === 'agent.abort') return Promise.resolve({ accepted: true, state: 'aborting' });
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      getConversationMock.mockReturnValue({
        id: 'conv-1',
        title: 't',
        status: 'running',
        messages: [{ id: 'ghost-1', role: 'assistant', content: '', timestamp: 1, isStreaming: true }],
      });
      drainSystemQueuedInputsMock.mockReturnValue([
        { id: 'system-1', text: 'hidden control input', timestamp: 3, isSystem: true },
      ]);
      shellController.abort();
      for (let i = 0; i < 30 && !sidecarRequestMock.mock.calls.some((c) => c[0] === 'agent.abort'); i++) {
        await Promise.resolve();
      }

      await expect(running).resolves.toEqual({ reason: 'aborted' });
      expect(sidecarRequestMock).toHaveBeenCalledWith(
        'agent.abort',
        { runId: expect.any(String) },
        1_000,
      );
      expect(chatDeltaCancelStreamingMock).toHaveBeenCalledWith('conv-1', { fromSidecarFrame: true });
      expect(chatDeltaDeactivateSkillsMock).toHaveBeenCalledWith('conv-1');
      expect(chatDeltaDeleteMessagesFromMock).toHaveBeenCalledWith('conv-1', 'ghost-1');
      expect(pauseUserInputQueueMock).toHaveBeenCalledWith('conv-1');
      expect(drainSystemQueuedInputsMock).toHaveBeenCalledWith('conv-1');
      expect(chatDeltaAddMessageMock).not.toHaveBeenCalled();
      expect(chatDeltaSetAgentStatusMock).toHaveBeenCalledWith('conv-1', 'idle');
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'idle');
      expect(cancelExecutionMock).toHaveBeenCalledWith(expect.any(String));
      expect(clearAbortControllerMock).toHaveBeenCalledWith('conv-1');
    });

    it('does not report Stop as settled when the interrupted lifecycle cannot be persisted', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      getAbortControllerMock.mockReturnValue(shellController);
      waitForConversationPersistenceMock
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('stop lifecycle not durable'));
      sidecarRequestMock.mockImplementation((method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => {
        if (method === 'agent.abort') return Promise.resolve({ accepted: true, state: 'aborting' });
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      shellController.abort();

      await expect(running).rejects.toThrow('stop lifecycle not durable');
      expect(chatStoreUpdateUserMessageRunMock).toHaveBeenCalledWith(
        'conv-1',
        expect.any(String),
        { state: 'interrupted' },
      );
      expect(clearAbortControllerMock).toHaveBeenCalledWith('conv-1');
    });

    it('force-finalizes after 5s when the sidecar never acknowledges Stop', async () => {
      vi.useFakeTimers();
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      const never = deferred<unknown>();
      getAbortControllerMock.mockReturnValue(shellController);
      sidecarRequestMock.mockImplementation((method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => {
        if (method === 'agent.abort') return never.promise;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      shellController.abort();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(chatDeltaCancelStreamingMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(running).resolves.toEqual({ reason: 'aborted' });
      expect(chatDeltaCancelStreamingMock).toHaveBeenCalledWith('conv-1', { fromSidecarFrame: true });
      expect(cancelExecutionMock).toHaveBeenCalledTimes(1);
    });

    it('finalizes immediately if agent.run fails after Stop, instead of clearing the watchdog and leaving thinking stuck', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      const runRpc = deferred<unknown>();
      const abortRpc = deferred<unknown>();
      getAbortControllerMock.mockReturnValue(shellController);
      sidecarRequestMock.mockImplementation((method: string) => (
        method === 'agent.abort' ? abortRpc.promise : runRpc.promise
      ));

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      shellController.abort();
      runRpc.reject(new Error('sidecar transport closed during stop'));

      await expect(running).resolves.toEqual({ reason: 'aborted' });
      expect(chatDeltaCancelStreamingMock).toHaveBeenCalledWith('conv-1', { fromSidecarFrame: true });
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'idle');
    });

    it('drops delta frames that arrive after the abort ACK fence', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const shellController = new AbortController();
      const firstFrame = deferred<void>();
      getAbortControllerMock.mockReturnValue(shellController);
      applyDeltaFramesMock.mockReturnValueOnce(firstFrame.promise);
      sidecarRequestMock.mockImplementation((method: string, _params: unknown, _timeout: number, signal?: AbortSignal) => {
        if (method === 'agent.abort') return Promise.resolve({ accepted: true, state: 'aborting' });
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls.find((c) => c[0] === 'agent.run')?.[1] as { runId: string }).runId;
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'before-stop'] }] });

      shellController.abort();
      for (let i = 0; i < 30 && !sidecarRequestMock.mock.calls.some((c) => c[0] === 'agent.abort'); i++) {
        await Promise.resolve();
      }
      await Promise.resolve(); // let the ACK handler close the frame gate
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'late'] }] });
      expect(applyDeltaFramesMock).toHaveBeenCalledTimes(1);

      firstFrame.resolve();
      await expect(running).resolves.toEqual({ reason: 'aborted' });
      expect(applyDeltaFramesMock).toHaveBeenCalledTimes(1);
    });

    it('does not resolve or unregister until queued frames and chat persistence settle', async () => {
      const { runAgentLoopDispatched, getRunSession } = await importFresh();
      const rpc = deferred<unknown>();
      const frame = deferred<void>();
      const persistence = deferred<void>();
      sidecarRequestMock.mockReturnValue(rpc.promise);
      applyDeltaFramesMock.mockReturnValueOnce(frame.promise);
      waitForConversationPersistenceMock
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(persistence.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({
        runId,
        frames: [{ p: 'chat', m: 'finishStreaming', a: ['conv-1', 'assistant-1'] }],
      });

      rpc.resolve({ reason: 'completed' });
      let settled = false;
      void running.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(getRunSession(runId)).toBeDefined();
      expect(waitForConversationPersistenceMock).toHaveBeenCalledTimes(2);

      frame.resolve();
      await frame.promise;
      await vi.waitFor(() => {
        expect(waitForConversationPersistenceMock).toHaveBeenCalledWith('conv-1');
      });
      expect(settled).toBe(false);
      expect(getRunSession(runId)).toBeDefined();

      persistence.resolve();
      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(getRunSession(runId)).toBeUndefined();
    });

    it('a transport failure BEFORE the run is committed falls back to runAgentLoop in-process', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockRejectedValue(new Error('sidecar process closed'));

      const result = await runAgentLoopDispatched('conv-1', 'hello');

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      expect(runAgentLoopMock).toHaveBeenCalledWith('conv-1', 'hello', expect.objectContaining({
        loopId: expect.any(String),
        prePersistedUserMessageId: expect.any(String),
      }));
      expect(endComputerUseTaskMock).not.toHaveBeenCalled();
      expect(result).toEqual({ reason: 'completed' });
    });

    it('keeps the replacement local task controller after a pre-commit sidecar fallback', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      let activeController: AbortController | undefined;
      let localController: AbortController | undefined;
      const localStarted = deferred<void>();
      const localFinished = deferred<void>();

      clearAbortControllerMock.mockImplementation(() => {
        activeController = undefined;
      });
      getAbortControllerMock.mockImplementation(() => {
        activeController ??= new AbortController();
        return activeController;
      });
      sidecarRequestMock.mockRejectedValue(new Error('sidecar process closed'));
      runAgentLoopMock.mockImplementation(async () => {
        // Mirror runAgentLoop's synchronous ownership replacement before its
        // first await. The dispatch wrapper's finally must not clear this new
        // controller while the fallback task is still running.
        clearAbortControllerMock('conv-1');
        localController = getAbortControllerMock('conv-1');
        localStarted.resolve();
        try {
          await localFinished.promise;
          return { reason: 'completed' };
        } finally {
          if (activeController === localController) {
            clearAbortControllerMock('conv-1');
          }
        }
      });

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await localStarted.promise;
      await Promise.resolve();

      expect(activeController).toBe(localController);
      expect(activeController?.signal.aborted).toBe(false);

      localFinished.resolve();
      await expect(running).resolves.toEqual({ reason: 'completed' });
      expect(activeController).toBeUndefined();
    });

    it('a transport failure AFTER the run is committed (≥1 tool.invoke arrived) surfaces an error — NO rerun', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      const toolInvokeHandler = handlerFor(onSidecarRequest, 'tool.invoke');
      await toolInvokeHandler({ runId, toolName: 'read_file', input: {} }); // marks committed

      d.reject(new Error('sidecar crashed mid-run'));
      const result = await p;

      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(result.reason).toBe('error');
      expect(result.error).toContain('sidecar crashed mid-run');
    });

    it('does not replay a run when a side-effecting local tool was approved before the sidecar crashed', async () => {
      getAllToolsMock.mockReturnValue([
        { name: 'write_file', description: 'writes a file', inputSchema: { type: 'object', properties: {} }, execute: async () => 'ok', isConcurrencySafe: false },
      ]);
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      await handlerFor(onSidecarRequest, 'approval.check')({
        runId,
        toolName: 'write_file',
        input: { path: '/tmp/already-written', content: 'done' },
      });

      d.reject(new Error('sidecar crashed after local write'));
      const result = await running;

      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(result.reason).toBe('error');
      expect(result.error).toContain('sidecar crashed after local write');
    });

    it('a post-commit failure finalizes the conversation UI so it never hangs on "thinking"', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'thinking…'] }] }); // marks committed → "thinking" shown

      d.reject(new Error('sidecar crashed mid-run'));
      await p;

      // The sidecar's own terminal frames never arrived — the shell must
      // finalize the UI itself (mirrors the in-process error path), else the
      // conversation hangs streaming forever.
      expect(chatDeltaFinishStreamingMock).toHaveBeenCalledWith('conv-1');
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'error');
      expect(chatDeltaSetAgentStatusMock).toHaveBeenCalledWith('conv-1', 'idle');
    });

    it('rejects a post-commit failure result when its terminal state cannot be persisted', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      waitForConversationPersistenceMock.mockImplementation(() => (
        waitForConversationPersistenceMock.mock.calls.length === 4
          ? Promise.reject(new Error('disk unavailable'))
          : Promise.resolve()
      ));
      sidecarRequestMock.mockReturnValue(d.promise);

      const running = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      handlerFor(onSidecarNotification, 'agent.delta')({
        runId,
        frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'thinking…'] }],
      });
      d.reject(new Error('sidecar crashed mid-run'));

      await expect(running).rejects.toThrow('disk unavailable');
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(chatDeltaSetConversationStatusMock).toHaveBeenCalledWith('conv-1', 'error');
    });

    it('shows a localized recovery message when the sidecar process closes after commit', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'partial'] }] });

      d.reject(new Error('Sidecar process closed'));
      const result = await p;

      expect(result).toEqual({ reason: 'error', error: 'Sidecar process closed' });
      expect(chatDeltaAppendTextMock).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('后台服务意外中断，正在自动恢复'),
      );
      expect(chatDeltaAppendTextMock).not.toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('Sidecar process closed'),
      );
    });

    it('a post-commit failure surfaces the REAL sidecar cause from the error data, not the generic wrapper', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'x'] }] });

      // A -32603 wrapper whose real cause lives in `.data.message` (mirrors
      // sidecar protocol.ts errorFromCaught).
      const rpcErr = Object.assign(new Error('Sidecar error -32603: Internal error'), {
        data: { message: 'Maximum call stack size exceeded' },
      });
      d.reject(rpcErr);
      const result = await p;

      expect(result.error).toBe('Maximum call stack size exceeded');
      expect(chatDeltaAppendTextMock).toHaveBeenCalledWith('conv-1', expect.stringContaining('Maximum call stack size exceeded'));
    });

    it('a transport failure AFTER the run is committed via an agent.delta frame (no tool call yet) ALSO surfaces an error — NO rerun', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);

      const p = runAgentLoopDispatched('conv-1', 'hello');
      await waitForCall(sidecarRequestMock);
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      const deltaHandler = handlerFor(onSidecarNotification, 'agent.delta');
      deltaHandler({ runId, frames: [{ p: 'chat', m: 'appendText', a: ['conv-1', 'hi'] }] }); // marks committed

      d.reject(new Error('sidecar crashed mid-stream'));
      const result = await p;

      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(result.reason).toBe('error');
    });

    it('buildAgentRunParams failing (e.g. resolveEffectiveLlmCreds throws) falls back to runAgentLoop in-process — never dispatches', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      resolveEffectiveLlmCredsMock.mockImplementation(() => { throw new Error('EnterpriseLlmUnavailableError'); });

      const result = await runAgentLoopDispatched('conv-1', 'hello');

      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ reason: 'completed' });
    });

    it('upgrades the durable raw message to multimodal content before an early in-process fallback', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      getConversationMock.mockReturnValue({
        id: 'conv-1',
        title: 't',
        status: 'idle',
        messages: [{ id: expect.any(String), role: 'user', content: 'look', timestamp: 1 }],
      });
      // The generated client id is not known ahead of time; make the reader
      // reflect the user row inserted by the runner.
      chatStoreAddMessageMock.mockImplementation((_convId, message) => {
        getConversationMock.mockReturnValue({
          id: 'conv-1',
          title: 't',
          status: 'running',
          messages: [message],
        });
      });
      const multimodal = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }];
      buildUserMessageContentMock.mockResolvedValue(multimodal);
      resolveEffectiveLlmCredsMock.mockImplementation(() => { throw new Error('EnterpriseLlmUnavailableError'); });

      await expect(runAgentLoopDispatched('conv-1', 'look', {
        images: [{ id: 'i1', data: 'x', mediaType: 'image/png' }],
      })).resolves.toEqual({ reason: 'completed' });

      expect(buildUserMessageContentMock).toHaveBeenCalledWith(
        'conv-1',
        'look',
        [{ id: 'i1', data: 'x', mediaType: 'image/png' }],
      );
      expect(chatStoreUpdateUserMessageRunMock).toHaveBeenCalledWith(
        'conv-1',
        expect.any(String),
        expect.objectContaining({ content: multimodal }),
      );
      expect(runAgentLoopMock).toHaveBeenCalledWith(
        'conv-1',
        'look',
        expect.objectContaining({ prePersistedUserMessageId: expect.any(String) }),
      );
      expect(sidecarRequestMock).not.toHaveBeenCalled();
    });

    it('a malformed agent.run response is treated as a failure (pre-commit → falls back in-process)', async () => {
      const { runAgentLoopDispatched } = await importFresh();
      sidecarRequestMock.mockResolvedValue({ notReason: 'oops' });

      const result = await runAgentLoopDispatched('conv-1', 'hello');

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ reason: 'completed' });
    });

    describe('concurrency guard', () => {
      it('rejects an image send against a live in-process run even when the sidecar is down', async () => {
        const { runAgentLoopDispatched } = await importFresh();
        getSidecarStatusMock.mockReturnValue('stopped');
        getConversationMock.mockReturnValue({ id: 'conv-1', title: 't', messages: [], status: 'running' });
        hasAbortControllerMock.mockReturnValue(true);

        const result = await runAgentLoopDispatched('conv-1', '', {
          images: [{ id: 'img-1', data: 'aGk=', mediaType: 'image/png' }],
        });

        expect(result).toEqual({
          reason: 'error',
          error: '请等待当前任务结束后再发送图片，草稿已为你保留。',
        });
        expect(runAgentLoopMock).not.toHaveBeenCalled();
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('rejects a headless send against a live in-process run even when the sidecar is down', async () => {
        const { runAgentLoopDispatched } = await importFresh();
        getSidecarStatusMock.mockReturnValue('stopped');
        getConversationMock.mockReturnValue({ id: 'conv-1', title: 't', messages: [], status: 'running' });
        hasAbortControllerMock.mockReturnValue(true);
        isInteractiveDesktopMock.mockReturnValue(false);

        const result = await runAgentLoopDispatched('conv-1', 'headless overlap');

        expect(result).toEqual({
          reason: 'error',
          error: '当前会话已有任务在运行，请等待结束后再启动新任务。',
        });
        expect(runAgentLoopMock).not.toHaveBeenCalled();
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('stages the message in the shell queue instead of injecting it into an existing sidecar run', async () => {
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        registerRunSession('run-existing', makeSession({ conversationId: 'conv-1' }));

        const result = await runAgentLoopDispatched('conv-1', 'more instructions');

        expect(result).toEqual({ reason: 'enqueued' });
        expect(enqueueUserInputMock).toHaveBeenCalledWith('conv-1', 'more instructions');
        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('starts a new run instead of staging into a session whose terminal is already published', async () => {
        // Regression: the crashed/stopped run stays REGISTERED while its
        // teardown finishes (persistence + the Computer Use lease release over
        // IPC), long after the UI shows the run as over. A send in that window
        // used to be staged into the dead run and then parked as a paused
        // queue chip, so it never reached the model — the real-Electron
        // sidecar-crash E2E lost this race on busy machines.
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        registerRunSession('run-tearing-down', makeSession({
          conversationId: 'conv-1',
          terminalPublished: true,
        }));
        sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

        const result = await runAgentLoopDispatched('conv-1', 'sent right after the error banner');

        expect(result).toEqual({ reason: 'completed' });
        expect(enqueueUserInputMock).not.toHaveBeenCalled();
        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
        expect(sidecarRequestMock).toHaveBeenCalled();
      });

      it('still stages into a sibling session that has NOT published its terminal', async () => {
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        registerRunSession('run-tearing-down', makeSession({
          conversationId: 'conv-1',
          terminalPublished: true,
        }));
        registerRunSession('run-live', makeSession({ conversationId: 'conv-1', loopId: 'loop-2' }));

        const result = await runAgentLoopDispatched('conv-1', 'more instructions');

        expect(result).toEqual({ reason: 'enqueued' });
        expect(enqueueUserInputMock).toHaveBeenCalledWith('conv-1', 'more instructions');
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('refuses to enqueue a restricted recovery into an existing sidecar run', async () => {
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        registerRunSession('run-existing', makeSession({ conversationId: 'conv-1' }));

        const result = await runAgentLoopDispatched('conv-1', 'continue with computer use', {
          blockedTools: ['run_command'],
          requireNewRun: true,
        });

        expect(result).toEqual({
          reason: 'error',
          error: 'A restricted recovery run cannot join an existing agent loop',
        });
        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('stages into the real in-process queue when a live IN-PROCESS run (not a sidecar RunSession) is detected for the conversation', async () => {
        const { runAgentLoopDispatched } = await importFresh();
        getConversationMock.mockReturnValue({ id: 'conv-1', title: 't', messages: [], status: 'running' });
        hasAbortControllerMock.mockReturnValue(true);

        const result = await runAgentLoopDispatched('conv-1', 'more instructions');

        expect(result).toEqual({ reason: 'enqueued' });
        expect(enqueueUserInputMock).toHaveBeenCalledWith('conv-1', 'more instructions');
        expect(sidecarRequestMock).not.toHaveBeenCalled();
        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
      });

      it('refuses to enqueue a restricted recovery into an existing in-process run', async () => {
        const { runAgentLoopDispatched } = await importFresh();
        getConversationMock.mockReturnValue({ id: 'conv-1', title: 't', messages: [], status: 'running' });
        hasAbortControllerMock.mockReturnValue(true);

        const result = await runAgentLoopDispatched('conv-1', 'continue with computer use', {
          blockedTools: ['run_command'],
          requireNewRun: true,
        });

        expect(result).toEqual({
          reason: 'error',
          error: 'A restricted recovery run cannot join an existing agent loop',
        });
        expect(enqueueUserInputMock).not.toHaveBeenCalled();
        expect(sidecarRequestMock).not.toHaveBeenCalled();
      });

      it('claims the conversation before async prompt preprocessing so a rapid second send is queued', async () => {
        const { runAgentLoopDispatched } = await importFresh();
        const controller = new AbortController();
        const orchestration = deferred<{
          route: { type: 'general'; name: string; cleanInput: string };
          systemPromptSections: never[];
        }>();
        let status: 'idle' | 'running' = 'idle';
        getConversationMock.mockImplementation(() => ({
          id: 'conv-1',
          title: 't',
          messages: [],
          status,
        }));
        getAbortControllerMock.mockReturnValue(controller);
        hasAbortControllerMock.mockReturnValue(true);
        chatDeltaSetConversationStatusMock.mockImplementation((_id, next) => {
          status = next as 'idle' | 'running';
        });
        precomputeOrchestrationMock.mockReturnValue(orchestration.promise);
        sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

        const first = runAgentLoopDispatched('conv-1', 'first');
        await waitForCall(precomputeOrchestrationMock);
        expect(status).toBe('running');

        const second = await runAgentLoopDispatched('conv-1', 'second');
        expect(second).toEqual({ reason: 'enqueued' });
        expect(enqueueUserInputMock).toHaveBeenCalledWith('conv-1', 'second');
        expect(sidecarRequestMock).not.toHaveBeenCalled();

        orchestration.resolve({
          route: { type: 'general', name: 'general', cleanInput: 'first' },
          systemPromptSections: [],
        });
        await expect(first).resolves.toEqual({ reason: 'completed' });
        expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      });

      it('rejects an image send while a run is active instead of starting a second agent run', async () => {
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        registerRunSession('run-existing', makeSession({ conversationId: 'conv-1' }));
        sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

        const result = await runAgentLoopDispatched('conv-1', 'look at this', { images: [{ id: 'i1', data: 'x', mediaType: 'image/png' }] });

        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
        expect(sidecarRequestMock).not.toHaveBeenCalled();
        expect(result).toEqual({
          reason: 'error',
          error: '请等待当前任务结束后再发送图片，草稿已为你保留。',
        });
      });

      it('rejects a headless caller when the conversation already has a live run', async () => {
        const { runAgentLoopDispatched, registerRunSession } = await importFresh();
        isInteractiveDesktopMock.mockReturnValue(false);
        registerRunSession('run-existing', makeSession({ conversationId: 'conv-1' }));
        sidecarRequestMock.mockResolvedValue({ reason: 'completed' });

        const result = await runAgentLoopDispatched('conv-1', 'scheduled prompt');

        expect(notifySidecar).not.toHaveBeenCalledWith('agent.enqueueInput', expect.anything());
        expect(sidecarRequestMock).not.toHaveBeenCalled();
        expect(result).toEqual({
          reason: 'error',
          error: '当前会话已有任务在运行，请等待结束后再启动新任务。',
        });
      });
    });
  });
});
