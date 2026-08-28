import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcError } from './protocol';
import type { SubagentLoopOptions, SubagentProgressEvent } from '@/core/agent/subagentLoop';
import { canonicalizeActiveToolResultContent } from '@/core/agent/activeToolResultContent';
import { firstImageContent } from '@/core/tools/toolResultContent';

// ── Mocked dependencies ─────────────────────────────────────────────────

const runAgentLoopMock = vi.fn();
vi.mock('@/core/agent/agentLoop', () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

const runSubagentLoopMock = vi.fn();
vi.mock('@/core/agent/subagentLoop', () => ({
  runSubagentLoop: (...a: unknown[]) => runSubagentLoopMock(...a),
}));

const applyPlanModeStateMock = vi.fn();
vi.mock('@/core/agent/planMode', () => ({
  applyPlanModeState: (...a: unknown[]) => applyPlanModeStateMock(...a),
}));

const { sendRequestMock, sendNotificationMock, setPreRequestFlushMock } = vi.hoisted(() => ({
  sendRequestMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  setPreRequestFlushMock: vi.fn(),
}));
vi.mock('./rpcClient', () => ({
  sendRequest: (...a: unknown[]) => sendRequestMock(...a),
  sendNotification: (...a: unknown[]) => sendNotificationMock(...a),
  setPreRequestFlush: (...a: unknown[]) => setPreRequestFlushMock(...a),
}));

const traceSidecarRuntimeEventMock = vi.hoisted(() => vi.fn());
vi.mock('./runtimeTrace', () => ({
  traceSidecarRuntimeEvent: (...a: unknown[]) => traceSidecarRuntimeEventMock(...a),
  sidecarRuntimeErrorType: (error: unknown) => error instanceof Error ? error.name.toLowerCase() : typeof error,
}));

const delegatedMediaStoreMocks = vi.hoisted(() => ({
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
}));
vi.mock('@/core/subagent/delegatedMediaStore', () => delegatedMediaStoreMocks);

// P1-3d-1 — mock the local tool registry so this file's dispatch tests
// (see "local tool dispatch (P1-3d-1)" below) exercise ONLY
// createReverseToolInvoker.executeAnyTool's branch/fallback wiring, not any
// real tool's execute() body. `localTools/index.test.ts` covers the real
// registry (hasLocalTool/isLocalToolReadOnly/executeLocalTool contract)
// against the actual show_widget/read_me/http_fetch/web_search
// implementations — no existing test in THIS file exercises a Tier A tool
// name via toolInvoker.executeAnyTool, so this mock has zero blast radius
// on the rest of the suite.
const { hasLocalToolMock, isLocalToolReadOnlyMock, executeLocalToolMock } = vi.hoisted(() => ({
  hasLocalToolMock: vi.fn(),
  isLocalToolReadOnlyMock: vi.fn(),
  executeLocalToolMock: vi.fn(),
}));
vi.mock('./localTools', () => ({
  hasLocalTool: (...a: unknown[]) => hasLocalToolMock(...a),
  isLocalToolReadOnly: (...a: unknown[]) => isLocalToolReadOnlyMock(...a),
  executeLocalTool: (...a: unknown[]) => executeLocalToolMock(...a),
}));

import {
  handleAgentRun,
  handleAgentStart,
  handleAgentGetState,
  handleAgentAbort,
  handleAgentEnqueueInput,
  handleStateConvPatch,
  handleStateExecPatch,
  handleStateSettings,
  handleStatePlanMode,
  shutdownAllAgentRuns,
  __getActiveAgentRunCount,
  __resetAgentRunRegistryForTests,
  buildAgentRunPayloadDigest,
} from './agentLoopHost';
import { getCurrentAgentRunContext } from './agentRunContext';
// Real (unmocked) module — this file doesn't mock '@/core/agent/userInputQueue',
// same discipline the rest of agentLoopHost.test.ts already relies on for
// other bare-getter ports it doesn't need to isolate.
import { getQueuedInputs, clearInputQueue } from '@/core/agent/userInputQueue';

let runIdCounter = 0;
function nextRunId(): string {
  runIdCounter += 1;
  return `run-${runIdCounter}`;
}

function baseConversation(id: string) {
  return { id, title: 'T', messages: [], createdAt: 0, updatedAt: 0, status: 'idle' };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  const runId = (overrides.runId as string | undefined) ?? nextRunId();
  const conversationId = (overrides.conversationId as string | undefined) ?? `conv-${runId}`;
  return {
    runId,
    conversationId,
    userMessage: 'hello',
    options: {},
    orchestration: { route: { type: 'chat', cleanInput: 'hello' }, systemPromptSections: [] },
    conversationSnapshot: baseConversation(conversationId),
    settingsSnapshot: { activeModel: { providerId: 'p', modelId: 'm' } },
    resolvedCreds: { apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false },
    toolList: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    locale: 'en-US',
    ...overrides,
  };
}

function reliableParams(overrides: Record<string, unknown> = {}) {
  const params = baseParams(overrides);
  const withIdentity = {
    ...params,
    clientMessageId: (overrides.clientMessageId as string | undefined) ?? `msg-${params.runId}`,
    options: {
      ...(params.options as Record<string, unknown>),
      prePersistedUserMessageId: (overrides.clientMessageId as string | undefined) ?? `msg-${params.runId}`,
    },
  };
  return {
    ...withIdentity,
    payloadDigest: buildAgentRunPayloadDigest(withIdentity),
  };
}

async function handleStartedAgentRun(overrides: Record<string, unknown> = {}): Promise<unknown> {
  const params = reliableParams(overrides);
  handleAgentStart(params);
  return await handleAgentRun(params);
}

/**
 * P1-3d-3/3d-4 — `sendRequestMock` now fields TWO reverse-RPC methods
 * (`approval.check` and `tool.invoke`), so a blanket `.mockResolvedValue`
 * would answer both identically and silently mask the approval-gate branch
 * (an `approval.check` response resolving to a bare string, not
 * `{decision:'allow'}`, is exactly the fail-closed "unavailable" case — see
 * `checkLocalToolApproval`). This helper keeps the two methods
 * independently configurable so each test's mock setup means what it says.
 * `approvalReason` only matters when `approvalDecision: 'deny'` — P1-3d-4
 * made a deny TERMINAL (its `reason` becomes the `ToolResult` directly, no
 * `tool.invoke` fallback — see the "SECURITY: approval.check deny" test).
 */
function mockSendRequest(
  overrides: { approvalDecision?: 'allow' | 'deny'; approvalReason?: string; toolInvokeResult?: unknown } = {},
) {
  const { approvalDecision = 'allow', approvalReason = 'Error: denied by shell policy', toolInvokeResult = 'tool output' } = overrides;
  sendRequestMock.mockImplementation((method: unknown) => {
    if (method === 'approval.check') {
      return Promise.resolve(
        approvalDecision === 'deny' ? { decision: 'deny', reason: approvalReason } : { decision: 'allow' },
      );
    }
    return Promise.resolve(toolInvokeResult);
  });
}

/** Deferred promise helper — lets tests assert that async media reads are a real ordering boundary. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('agentLoopHost', () => {
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    runSubagentLoopMock.mockReset();
    applyPlanModeStateMock.mockReset();
    sendRequestMock.mockReset();
    mockSendRequest();
    sendNotificationMock.mockReset();
    traceSidecarRuntimeEventMock.mockReset();
    hasLocalToolMock.mockReset();
    hasLocalToolMock.mockReturnValue(false);
    isLocalToolReadOnlyMock.mockReset();
    executeLocalToolMock.mockReset();
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReset();
    delegatedMediaStoreMocks.readDelegatedMedia.mockReset();
    __resetAgentRunRegistryForTests();
  });

  describe('Reliable Run Protocol start registry', () => {
    it('acknowledges ownership before execution and exposes accepted state', () => {
      const params = reliableParams({ runId: 'start-accepted' });
      expect(handleAgentStart(params)).toEqual(expect.objectContaining({
        version: 1,
        runId: 'start-accepted',
        clientMessageId: 'msg-start-accepted',
        state: 'accepted',
        replay: false,
      }));
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(handleAgentGetState({ runId: 'start-accepted' })).toEqual(expect.objectContaining({
        state: 'accepted',
        clientMessageId: 'msg-start-accepted',
      }));
    });

    it('replays the same acceptance without executing twice and rejects conflicting reuse', () => {
      const params = reliableParams({ runId: 'start-replay' });
      handleAgentStart(params);
      expect(handleAgentStart(params)).toEqual(expect.objectContaining({ replay: true, state: 'accepted' }));
      expect(() => handleAgentStart({ ...params, payloadDigest: 'different' })).toThrow(RpcError);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it('caches the ordered terminal for getState and later start replays', async () => {
      const params = reliableParams({ runId: 'start-terminal' });
      handleAgentStart(params);
      runAgentLoopMock.mockResolvedValueOnce({ reason: 'completed' });
      await handleAgentRun(params);

      expect(handleAgentGetState({ runId: params.runId })).toEqual(expect.objectContaining({
        state: 'terminal',
        terminal: expect.objectContaining({ state: 'completed', result: { reason: 'completed' } }),
      }));
      expect(handleAgentStart(params)).toEqual(expect.objectContaining({
        replay: true,
        state: 'terminal',
        terminal: expect.objectContaining({ state: 'completed' }),
      }));
      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    });

    it('accepts Stop between ACK and execution and never enters the loop', async () => {
      const params = reliableParams({ runId: 'start-cancelled' });
      handleAgentStart(params);
      await expect(handleAgentAbort({ runId: params.runId })).resolves.toEqual({ accepted: true, state: 'aborting' });
      await expect(handleAgentRun(params)).resolves.toEqual({ reason: 'aborted' });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(handleAgentGetState({ runId: params.runId })).toEqual(expect.objectContaining({
        state: 'terminal',
        terminal: expect.objectContaining({ state: 'interrupted' }),
      }));
    });

    it('rejects agent.run before agent.start establishes ownership', async () => {
      const params = reliableParams({ runId: 'run-without-start' });

      await expect(handleAgentRun(params)).rejects.toMatchObject({ code: -32602 });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it('rejects agent.run when executable params are tampered after start', async () => {
      const params = reliableParams({ runId: 'run-tamper' });
      handleAgentStart(params);

      await expect(handleAgentRun({ ...params, userMessage: 'tampered task' })).rejects.toMatchObject({ code: -32602 });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });
  });

  describe('param validation', () => {
    it.each([
      ['non-object params', 42],
      ['missing runId', { ...baseParams(), runId: undefined }],
      ['missing conversationId', { ...baseParams(), conversationId: undefined }],
      ['userMessage not a string', { ...baseParams(), userMessage: 123 }],
      ['options not an object', { ...baseParams(), options: null }],
      ['orchestration.route not an object', { ...baseParams(), orchestration: { route: null, systemPromptSections: [] } }],
      ['orchestration.systemPromptSections not an array', { ...baseParams(), orchestration: { route: {}, systemPromptSections: 'x' } }],
      ['conversationSnapshot missing id', { ...baseParams(), conversationSnapshot: {} }],
      ['settingsSnapshot not an object', { ...baseParams(), settingsSnapshot: null }],
      ['resolvedCreds not an object', { ...baseParams(), resolvedCreds: null }],
      ['toolList not an array', { ...baseParams(), toolList: 'nope' }],
      ['locale not a string', { ...baseParams(), locale: 42 }],
      ['empty authorizationScopeId', { ...baseParams(), options: { authorizationScopeId: '' } }],
      ['malformed runPermissionCeiling', {
        ...baseParams(),
        options: { runPermissionCeiling: { version: 1, source: 'trigger', capability: 'not-a-tier' } },
      }],
    ])('rejects %s with RpcError -32602', async (_label, params) => {
      await expect(handleAgentRun(params)).rejects.toThrow(RpcError);
      await expect(handleAgentRun(params)).rejects.toMatchObject({ code: -32602 });
    });

    it('rejects a duplicate runId that is already active', async () => {
      const dupRunId = 'dup-agent-run';
      const never = new Promise(() => {});
      runAgentLoopMock.mockReturnValueOnce(never);
      const firstParams = reliableParams({ runId: dupRunId, conversationId: 'conv-dup' });
      handleAgentStart(firstParams);
      void handleAgentRun(firstParams);
      await Promise.resolve();

      await expect(handleAgentRun(reliableParams({ runId: dupRunId, conversationId: 'conv-dup-2' })))
        .rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('happy path', () => {
    it('runs the loop inside an agentRunContext scope and returns its result', async () => {
      let sawContextRunId: string | undefined;
      runAgentLoopMock.mockImplementationOnce(async () => {
        sawContextRunId = getCurrentAgentRunContext().runId;
        return { reason: 'completed' };
      });
      const params = reliableParams();
      handleAgentStart(params);
      const result = await handleAgentRun(params);
      expect(result).toEqual({ reason: 'completed' });
      expect(sawContextRunId).toBe(params.runId);
      expect(traceSidecarRuntimeEventMock).toHaveBeenCalledWith(
        'sidecar.agent_run_received',
        expect.objectContaining({ runId: params.runId, stage: 'params_parsed' }),
      );
      expect(traceSidecarRuntimeEventMock).toHaveBeenCalledWith(
        'sidecar.agent_loop_started',
        expect.objectContaining({ runId: params.runId, stage: 'agent_loop_running' }),
      );
      expect(traceSidecarRuntimeEventMock).toHaveBeenCalledWith(
        'sidecar.agent_run_completed',
        expect.objectContaining({ runId: params.runId, outcome: 'completed' }),
      );
    });

    it('passes settingsReader/orchestration/options through AgentLoopOptions', async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      runAgentLoopMock.mockImplementationOnce(async (_convId: string, _msg: string, options: Record<string, unknown>) => {
        capturedOptions = options;
        return { reason: 'completed' };
      });
      const params = reliableParams({ options: { blockedTools: ['x'], allowedTools: ['read_*'] } });
      handleAgentStart(params);
      await handleAgentRun(params);
      expect(capturedOptions?.blockedTools).toEqual(['x']);
      expect(capturedOptions?.allowedTools).toEqual(['read_*']);
      expect(capturedOptions?.orchestration).toBe(params.orchestration);
      expect(capturedOptions?.settingsReader).toBeDefined();
    });

    it('validates and restores the run permission ceiling into AgentLoopOptions', async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      runAgentLoopMock.mockImplementationOnce(async (_convId: string, _msg: string, options: Record<string, unknown>) => {
        capturedOptions = options;
        return { reason: 'completed' };
      });
      const ceiling = { version: 1, source: 'trigger', capability: 'safe_tools' };

      await handleStartedAgentRun({ options: { runPermissionCeiling: ceiling } });

      expect(capturedOptions?.runPermissionCeiling).toEqual(ceiling);
    });

    it('applies planMode when provided', async () => {
      runAgentLoopMock.mockResolvedValueOnce({ reason: 'completed' });
      const params = reliableParams({ planMode: 'planning' });
      handleAgentStart(params);
      await handleAgentRun(params);
      expect(applyPlanModeStateMock).toHaveBeenCalledWith(params.conversationId, 'planning');
    });

    it('removes the run from activeRuns after settling (both success and error)', async () => {
      // Relative, not absolute — a prior test in this file (duplicate-runId
      // rejection) intentionally leaves one run permanently "active"
      // (never-resolving promise), same documented pattern as
      // subagentHost.test.ts's own activeRuns tests.
      const before = __getActiveAgentRunCount();
      runAgentLoopMock.mockResolvedValueOnce({ reason: 'completed' });
      const okParams = reliableParams();
      handleAgentStart(okParams);
      await handleAgentRun(okParams);
      expect(__getActiveAgentRunCount()).toBe(before);

      runAgentLoopMock.mockRejectedValueOnce(new Error('boom'));
      const errParams = reliableParams();
      handleAgentStart(errParams);
      await expect(handleAgentRun(errParams)).rejects.toThrow('boom');
      expect(__getActiveAgentRunCount()).toBe(before);
      expect(sendNotificationMock).toHaveBeenCalledWith('agent.terminal', {
        version: 1,
        runId: errParams.runId,
        state: 'failed',
        result: { reason: 'error', error: 'boom', messageTaken: true },
        failure: {
          errorType: 'error',
          message: 'boom',
          stack: expect.stringContaining('Error: boom'),
        },
      });
    });

    it('aborts scoped run controllers on normal completion so background commands cannot outlive unattended runs', async () => {
      let capturedSignal: AbortSignal | undefined;
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
        expect(capturedSignal.aborted).toBe(false);
        ctx.abortRegistry.clearAbortController(ctx.conversationId);
        return { reason: 'completed' };
      });

      await handleStartedAgentRun({
        runId: 'scoped-controller-complete',
        options: { authorizationScopeId: 'scope-complete' },
      });

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('aborts scoped run controllers when the loop throws', async () => {
      let capturedSignal: AbortSignal | undefined;
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
        throw new Error('boom');
      });

      const scopedErrorParams = reliableParams({
        runId: 'scoped-controller-error',
        options: { authorizationScopeId: 'scope-error' },
      });
      handleAgentStart(scopedErrorParams);
      await expect(handleAgentRun(scopedErrorParams)).rejects.toThrow('boom');

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('does not abort unscoped run controllers on normal completion', async () => {
      let capturedSignal: AbortSignal | undefined;
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
        return { reason: 'completed' };
      });

      await handleStartedAgentRun({ runId: 'unscoped-controller-complete' });

      expect(capturedSignal?.aborted).toBe(false);
    });
  });

  describe('ALS isolation of two concurrent runs\' ports', () => {
    it('interleaved runs never see each other\'s chatDelta/toolInvoker/conversationId', async () => {
      const seenByRun: Record<string, { conversationId: string }> = {};
      const gate: { resolveA?: () => void; resolveB?: () => void } = {};
      const waitA = new Promise<void>((r) => { gate.resolveA = r; });
      const waitB = new Promise<void>((r) => { gate.resolveB = r; });

      runAgentLoopMock.mockImplementation(async (conversationId: string) => {
        const ctx = getCurrentAgentRunContext();
        if (conversationId.includes('A')) {
          seenByRun.first = { conversationId: ctx.conversationId };
          gate.resolveA?.();
          await waitB;
          seenByRun.firstAgain = { conversationId: ctx.conversationId };
        } else {
          await waitA;
          seenByRun.second = { conversationId: ctx.conversationId };
          gate.resolveB?.();
        }
        return { reason: 'completed' };
      });

      const paramsA = reliableParams({ runId: 'run-A', conversationId: 'conv-A' });
      const paramsB = reliableParams({ runId: 'run-B', conversationId: 'conv-B' });
      handleAgentStart(paramsA);
      handleAgentStart(paramsB);
      const runA = handleAgentRun(paramsA);
      const runB = handleAgentRun(paramsB);
      await Promise.all([runA, runB]);

      expect(seenByRun.first.conversationId).toBe('conv-A');
      expect(seenByRun.firstAgain.conversationId).toBe('conv-A');
      expect(seenByRun.second.conversationId).toBe('conv-B');
    });
  });

  describe('handleAgentAbort', () => {
    it('is idempotent and silent for an unknown runId', async () => {
      await expect(handleAgentAbort({ runId: 'never-existed' })).resolves.toEqual({ accepted: false, state: 'not_found' });
    });

    it('aborts the run\'s conversation-scoped controller (observed via AbortRegistry inside the loop)', async () => {
      let capturedSignal: AbortSignal | undefined;
      let releaseLoop: (() => void) | undefined;
      const params = reliableParams({ runId: 'abort-me', conversationId: 'conv-abort-me' });
      const loopStarted = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          const ctx = getCurrentAgentRunContext();
          capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
          resolveStarted();
          await new Promise<void>((r) => { releaseLoop = r; });
          return { reason: capturedSignal?.aborted ? 'aborted' : 'completed' };
        });
      });
      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await loopStarted;
      expect(capturedSignal?.aborted).toBe(false);
      await expect(handleAgentAbort({ runId: 'abort-me' })).resolves.toEqual({ accepted: true, state: 'aborting' });
      expect(capturedSignal?.aborted).toBe(true);
      expect(traceSidecarRuntimeEventMock).toHaveBeenCalledWith(
        'sidecar.agent_abort_ack_ready',
        expect.objectContaining({ runId: 'abort-me', outcome: 'success' }),
      );
      releaseLoop?.();
      const result = await runPromise;
      expect(result).toEqual({ reason: 'aborted' });
    });

    it('does not acknowledge Stop until pending media transport is flushed', async () => {
      const params = reliableParams({ runId: 'abort-with-media', conversationId: 'conv-abort-media' });
      const pngBase64 = 'iVBORw0KGgo=';
      let resolvePersist!: (ref: {
        id: string;
        sha256: string;
        mediaType: string;
        bytes: number;
      }) => void;
      let releaseLoop!: () => void;
      delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
        new Promise((resolve) => { resolvePersist = resolve; }),
      );
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        ctx.abortRegistry.getAbortController(ctx.conversationId);
        ctx.chatDelta.updateToolCall(
          ctx.conversationId,
          'm1',
          'tc-abort-media',
          'Screenshot saved to: /tmp/private.png',
          [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } }],
          false,
        );
        await new Promise<void>((resolve) => { releaseLoop = resolve; });
        return { reason: 'aborted' };
      });

      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await vi.waitFor(() => expect(delegatedMediaStoreMocks.persistDelegatedMedia).toHaveBeenCalledOnce());
      const abortPromise = handleAgentAbort({ runId: params.runId });
      let abortSettled = false;
      void abortPromise.then(() => { abortSettled = true; });
      await Promise.resolve();
      expect(abortSettled).toBe(false);

      resolvePersist({
        id: 'media_abort',
        sha256: '9'.repeat(64),
        mediaType: 'image/png',
        bytes: 8,
      });
      await expect(abortPromise).resolves.toEqual({ accepted: true, state: 'aborting' });

      const deltaCall = sendNotificationMock.mock.calls.find((call) => call[0] === 'agent.delta');
      expect(deltaCall).toBeDefined();
      expect(JSON.stringify(deltaCall)).not.toContain(pngBase64);
      const deltaOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findIndex((call) => call[0] === 'agent.delta')
      ];
      const ackOrder = traceSidecarRuntimeEventMock.mock.invocationCallOrder[
        traceSidecarRuntimeEventMock.mock.calls.findIndex((call) => (
          call[0] === 'sidecar.agent_abort_ack_ready'
          && (call[1] as { runId?: string }).runId === params.runId
        ))
      ];
      expect(deltaOrder).toBeLessThan(ackOrder);

      releaseLoop();
      await expect(runPromise).resolves.toEqual({ reason: 'aborted' });
    });
  });

  describe('handleAgentEnqueueInput (P1-3B-4)', () => {
    it('is idempotent and silent for an unknown runId', () => {
      expect(() => handleAgentEnqueueInput({ runId: 'never-existed', message: 'x' })).not.toThrow();
    });

    it('id-preserving path (queueId present) stages the message into the sidecar\'s userInputQueue under that exact id', async () => {
      const conversationId = 'conv-enqueue-1';
      clearInputQueue(conversationId);
      let releaseLoop: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          resolveStarted();
          await new Promise<void>((r) => { releaseLoop = r; });
          return { reason: 'completed' };
        });
      });
      const params = reliableParams({ runId: 'enqueue-run-1', conversationId });
      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await started;

      handleAgentEnqueueInput({ runId: 'enqueue-run-1', message: 'more instructions', queueId: 'shell-id-1' });

      expect(getQueuedInputs(conversationId).map((qi) => ({ id: qi.id, text: qi.text }))).toEqual([
        { id: 'shell-id-1', text: 'more instructions' },
      ]);

      releaseLoop?.();
      await runPromise;
    });

    it('backward-compat path (no queueId, userMessage field) still stages the message, under a locally-minted id', async () => {
      const conversationId = 'conv-enqueue-2';
      clearInputQueue(conversationId);
      let releaseLoop: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          resolveStarted();
          await new Promise<void>((r) => { releaseLoop = r; });
          return { reason: 'completed' };
        });
      });
      const params = reliableParams({ runId: 'enqueue-run-2', conversationId });
      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await started;

      handleAgentEnqueueInput({ runId: 'enqueue-run-2', userMessage: 'legacy shape' });

      const queued = getQueuedInputs(conversationId);
      expect(queued.map((qi) => qi.text)).toEqual(['legacy shape']);
      expect(typeof queued[0].id).toBe('string');
      expect(queued[0].id.length).toBeGreaterThan(0);

      releaseLoop?.();
      await runPromise;
    });

    it('threads isSystem through', async () => {
      const conversationId = 'conv-enqueue-3';
      clearInputQueue(conversationId);
      let releaseLoop: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          resolveStarted();
          await new Promise<void>((r) => { releaseLoop = r; });
          return { reason: 'completed' };
        });
      });
      const params = reliableParams({ runId: 'enqueue-run-3', conversationId });
      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await started;

      handleAgentEnqueueInput({ runId: 'enqueue-run-3', message: 'sys', queueId: 'sys-id', isSystem: true });

      expect(getQueuedInputs(conversationId)[0].isSystem).toBe(true);

      releaseLoop?.();
      await runPromise;
    });

    it('drops params with neither message nor userMessage', () => {
      expect(() => handleAgentEnqueueInput({ runId: 'whatever' })).not.toThrow();
      expect(() => handleAgentEnqueueInput(null)).not.toThrow();
    });
  });

  describe('handleAgentRun — queuedInputs seeding (P1-3B-4)', () => {
    it('seeds the sidecar\'s userInputQueue from params.queuedInputs, id-preserved, before the loop starts', async () => {
      const conversationId = 'conv-seed-1';
      clearInputQueue(conversationId);
      let seenAtLoopStart: { id: string; text: string; isSystem?: boolean }[] = [];
      runAgentLoopMock.mockImplementationOnce(async () => {
        seenAtLoopStart = getQueuedInputs(conversationId).map((qi) => ({ id: qi.id, text: qi.text, isSystem: qi.isSystem }));
        return { reason: 'completed' };
      });

      const params = reliableParams({
        runId: 'seed-run-1',
        conversationId,
        queuedInputs: [
          { id: 'leftover-1', text: 'leftover one' },
          { id: 'leftover-2', text: 'leftover two', isSystem: true },
        ],
      });
      handleAgentStart(params);
      await handleAgentRun(params);

      expect(seenAtLoopStart).toEqual([
        { id: 'leftover-1', text: 'leftover one', isSystem: undefined },
        { id: 'leftover-2', text: 'leftover two', isSystem: true },
      ]);
    });

    it('is a no-op when queuedInputs is absent', async () => {
      const conversationId = 'conv-seed-2';
      clearInputQueue(conversationId);
      runAgentLoopMock.mockResolvedValueOnce({ reason: 'completed' });
      await handleStartedAgentRun({ runId: 'seed-run-2', conversationId });
      expect(getQueuedInputs(conversationId)).toHaveLength(0);
    });
  });

  describe('state.convPatch / state.execPatch routing', () => {
    it('handleStateConvPatch updates the run\'s conversation mirror; unknown runId is a silent drop', async () => {
      let readWorkspacePath: string | null | undefined;
      const params = reliableParams({ runId: 'patch-me', conversationId: 'conv-patch-me' });
      const started = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          const ctx = getCurrentAgentRunContext();
          resolveStarted();
          // Give the patch a moment to land, then read.
          await new Promise((r) => setTimeout(r, 0));
          readWorkspacePath = ctx.workspaceReader.getCurrentPath();
          return { reason: 'completed' };
        });
      });
      handleAgentStart(params);
      const runPromise = handleAgentRun(params);
      await started;
      expect(() => handleStateConvPatch({ runId: 'unknown', patch: { workspacePath: '/x' } })).not.toThrow();
      handleStateConvPatch({ runId: 'patch-me', patch: { workspacePath: '/patched' } });
      await runPromise;
      expect(readWorkspacePath).toBe('/patched');
    });

    it('handleStateExecPatch is a silent no-op for malformed/unknown params', () => {
      expect(() => handleStateExecPatch({ runId: 'nope' })).not.toThrow();
      expect(() => handleStateExecPatch(null)).not.toThrow();
      expect(() => handleStateExecPatch({ runId: 'nope', plannedSteps: 'not-an-array' })).not.toThrow();
    });
  });

  describe('handleStateSettings', () => {
    it('silently ignores malformed params', () => {
      expect(() => handleStateSettings(null)).not.toThrow();
      expect(() => handleStateSettings({})).not.toThrow();
    });
  });

  describe('handleStatePlanMode', () => {
    it('applies a valid mode', () => {
      handleStatePlanMode({ conversationId: 'c1', mode: 'approved' });
      expect(applyPlanModeStateMock).toHaveBeenCalledWith('c1', 'approved');
    });

    it('applies null (clear)', () => {
      handleStatePlanMode({ conversationId: 'c1', mode: null });
      expect(applyPlanModeStateMock).toHaveBeenCalledWith('c1', null);
    });

    it('rejects an invalid mode value silently (no call)', () => {
      applyPlanModeStateMock.mockClear();
      handleStatePlanMode({ conversationId: 'c1', mode: 'bogus' });
      expect(applyPlanModeStateMock).not.toHaveBeenCalled();
    });
  });

  describe('coalescer flush on settle', () => {
    it('sends a final agent.delta batch containing frames pushed right before the loop resolves', async () => {
      const params = reliableParams({ runId: 'flush-me', conversationId: 'conv-flush-me' });
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        ctx.chatDelta.setConversationStatus(ctx.conversationId, 'idle');
        return { reason: 'completed' };
      });
      handleAgentStart(params);
      await handleAgentRun(params);
      const deltaCalls = sendNotificationMock.mock.calls.filter((c) => c[0] === 'agent.delta');
      expect(deltaCalls.length).toBeGreaterThan(0);
      const lastBatch = deltaCalls[deltaCalls.length - 1][1] as { runId: string; frames: unknown[] };
      expect(lastBatch.runId).toBe('flush-me');
      expect(lastBatch.frames.length).toBeGreaterThan(0);
      expect(sendNotificationMock).toHaveBeenCalledWith('agent.terminal', {
        version: 1,
        runId: 'flush-me',
        state: 'completed',
        result: { reason: 'completed' },
      });
      const deltaOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findLastIndex((call) => call[0] === 'agent.delta')
      ];
      const terminalOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findIndex((call) => call[0] === 'agent.terminal')
      ];
      expect(deltaOrder).toBeLessThan(terminalOrder);
      expect(traceSidecarRuntimeEventMock).toHaveBeenCalledWith(
        'sidecar.agent_delta_emitted',
        expect.objectContaining({ runId: 'flush-me', frameCount: lastBatch.frames.length }),
      );
    });

    it('drains delayed media updateToolCall transport before final flush and terminal', async () => {
      const params = reliableParams({ runId: 'drain-media-before-terminal', conversationId: 'conv-drain-media' });
      const pngBase64 = 'iVBORw0KGgo=';
      let resolvePersist!: (ref: {
        id: string;
        sha256: string;
        mediaType: string;
        bytes: number;
      }) => void;
      delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
        new Promise((resolve) => { resolvePersist = resolve; }),
      );
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        ctx.chatDelta.updateToolCall(
          ctx.conversationId,
          'm1',
          'tc1',
          'Screenshot saved to: /Users/alice/Desktop/secret-shot.png',
          [
            { type: 'text', text: 'Screenshot saved to: /Users/alice/Desktop/secret-shot.png' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
            },
          ],
          false,
        );
        ctx.pushFrame({
          p: 'session',
          m: 'replaceMessageById',
          a: [ctx.conversationId, { id: 'm1', role: 'assistant', content: 'durable', timestamp: 1 }],
        });
        ctx.chatDelta.setConversationStatus(ctx.conversationId, 'idle');
        return { reason: 'completed' };
      });
      handleAgentStart(params);
      const run = handleAgentRun(params);

      await vi.waitFor(() => expect(delegatedMediaStoreMocks.persistDelegatedMedia).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(sendNotificationMock.mock.calls.some((call) => call[0] === 'agent.delta')).toBe(false);
      expect(sendNotificationMock.mock.calls.some((call) => call[0] === 'agent.terminal')).toBe(false);

      resolvePersist({
        id: 'media_host_drain',
        sha256: 'e'.repeat(64),
        mediaType: 'image/png',
        bytes: 8,
      });
      await expect(run).resolves.toEqual({ reason: 'completed' });

      const deltaCalls = sendNotificationMock.mock.calls.filter((call) => call[0] === 'agent.delta');
      const methods = deltaCalls.flatMap((call) => (call[1] as { frames: { m: string }[] }).frames.map((frame) => frame.m));
      expect(methods).toEqual(['updateToolCall', 'replaceMessageById', 'setConversationStatus']);
      const wire = JSON.stringify(deltaCalls);
      expect(wire).not.toContain(pngBase64);
      expect(wire).not.toContain('/Users/alice/Desktop/secret-shot.png');
      const lastDeltaOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findLastIndex((call) => call[0] === 'agent.delta')
      ];
      const terminalOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findIndex((call) => call[0] === 'agent.terminal')
      ];
      expect(lastDeltaOrder).toBeLessThan(terminalOrder);
    });
  });

  describe('local tool dispatch (P1-3d-1 / P1-3d-3 approval gate)', () => {
    /** Runs `fn(toolInvoker)` inside the run's real agentRunContext scope (via runAgentLoopMock), returning fn's result. */
    async function withToolInvoker<T>(fn: (toolInvoker: ReturnType<typeof getCurrentAgentRunContext>['toolInvoker']) => Promise<T>): Promise<T> {
      let captured!: T;
      runAgentLoopMock.mockImplementationOnce(async () => {
        captured = await fn(getCurrentAgentRunContext().toolInvoker);
        return { reason: 'completed' };
      });
      await handleStartedAgentRun();
      return captured;
    }

    it('local registry hit + approval.check allow runs locally and never calls tool.invoke', async () => {
      hasLocalToolMock.mockReturnValue(true);
      executeLocalToolMock.mockResolvedValue('local result');
      // beforeEach's mockSendRequest() default already answers approval.check with {decision:'allow'}.

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      expect(result).toBe('local result');
      expect(sendRequestMock).toHaveBeenCalledWith(
        'approval.check',
        expect.objectContaining({ toolName: 'show_widget', input: { title: 't' } }),
      );
      expect(executeLocalToolMock).toHaveBeenCalledWith('show_widget', { title: 't' }, undefined, undefined);
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
    });

    it('executes a local file tool only with the canonical path bound by shell approval', async () => {
      hasLocalToolMock.mockReturnValue(true);
      executeLocalToolMock.mockResolvedValue('local file');
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') {
          return Promise.resolve({
            decision: 'allow',
            executionPath: '/canonical/workspace/report.md',
          });
        }
        return Promise.resolve('unexpected fallback');
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('read_file', { path: '/workspace/link/report.md' }),
      );

      expect(result).toBe('local file');
      expect(executeLocalToolMock).toHaveBeenCalledWith(
        'read_file',
        { path: '/canonical/workspace/report.md' },
        undefined,
        undefined,
      );
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
    });

    it('does not execute a local file tool when an allow ACK omits its canonical path', async () => {
      hasLocalToolMock.mockReturnValue(true);
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') return Promise.resolve({ decision: 'allow' });
        if (method === 'tool.invoke') return Promise.resolve('reverse result');
        return Promise.resolve(undefined);
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('read_file', { path: '/workspace/link/report.md' }),
      );

      expect(result).toBe('reverse result');
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({ toolName: 'read_file', input: { path: '/workspace/link/report.md' } }),
      );
    });

    it('does not start a local tool when Stop wins after the allow ACK was requested', async () => {
      hasLocalToolMock.mockReturnValue(true);
      isLocalToolReadOnlyMock.mockReturnValue(false);
      let approve!: (value: { decision: 'allow'; executionPath: string }) => void;
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') {
          return new Promise((resolve) => { approve = resolve; });
        }
        return Promise.resolve('unexpected fallback');
      });
      const controller = new AbortController();

      const execution = withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool(
          'write_file',
          { path: '/tmp/late.txt', content: 'late' },
          undefined,
          undefined,
          { abortSignal: controller.signal },
        ),
      );
      await vi.waitFor(() => expect(sendRequestMock).toHaveBeenCalledWith(
        'approval.check',
        expect.objectContaining({ toolName: 'write_file' }),
      ));

      controller.abort();
      approve({ decision: 'allow', executionPath: '/tmp/late.txt' });

      await expect(execution).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
    });

    it('local registry miss falls through to reverse tool.invoke, unchanged (no approval.check for a non-local tool)', async () => {
      hasLocalToolMock.mockReturnValue(false);

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool(
          'read_file',
          { path: '/tmp/x' },
          undefined,
          undefined,
          {
            conversationId: 'conv-wire',
            deferredToolNames: ['rare_clipboard'],
            abortSignal: new AbortController().signal,
            reportMetadata: vi.fn(),
          },
        ),
      );

      expect(result).toBe('tool output');
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).not.toHaveBeenCalledWith('approval.check', expect.anything());
      expect(sendRequestMock).toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({
          toolName: 'read_file',
          input: { path: '/tmp/x' },
          context: {
            conversationId: 'conv-wire',
            deferredToolNames: ['rare_clipboard'],
          },
        }),
      );
    });

    it('materializes shell-returned opaque image refs before a sidecar main-loop direct nested subagent sees tool results', async () => {
      hasLocalToolMock.mockReturnValue(false);
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const pngBase64 = 'iVBORw0KGgo=';
      const readGate = deferred<Uint8Array>();
      delegatedMediaStoreMocks.readDelegatedMedia.mockReturnValueOnce(readGate.promise);
      mockSendRequest({
        toolInvokeResult: [
          { type: 'text', text: 'Image: /tmp/secret.png' },
          {
            type: 'delegated_media_ref',
            originConversationId: 'conv-main-nested',
            attachment: {
              id: 'media_shell_reverse',
              sha256: 'b'.repeat(64),
              mediaType: 'image/png',
              bytes: pngBytes.byteLength,
            },
          },
        ],
      });
      let nestedToolReturned = false;
      let nestedImage: ReturnType<typeof firstImageContent>;
      runSubagentLoopMock.mockImplementationOnce(async (options: SubagentLoopOptions) => {
        const rawResult = await options.toolInvoker!.executeAnyTool('read_file', { path: '/tmp/secret.png' });
        nestedToolReturned = true;
        const admitted = canonicalizeActiveToolResultContent(rawResult);
        nestedImage = firstImageContent(admitted);
        if (nestedImage) {
          options.onProgress?.({
            type: 'tool-end',
            id: 'nested-read',
            toolName: 'read_file',
            result: 'Image: /tmp/secret.png',
            error: false,
            resultContent: admitted,
          });
        }
        return {
          text: 'nested done',
          toolCallCount: 1,
          turnCount: 1,
          tokenUsage: { input: 0, output: 0 },
          duration: 1,
          stopReason: 'completed',
        };
      });
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        const exec = ctx.executionPort.createExecution(ctx.conversationId, ctx.runId);
        ctx.executionPort.addStep(exec.id, {
          id: 'parent-delegate',
          executionId: exec.id,
          type: 'delegate',
          label: 'Delegate',
          status: 'running',
          toolName: 'delegate_to_agent',
          toolInput: {},
          source: 'agent',
          detailBlocks: [],
          childSteps: [{
            id: 'child-read',
            executionId: exec.id,
            type: 'file-read',
            label: 'read_file',
            status: 'running',
            toolName: 'read_file',
            toolInput: {},
            source: 'agent',
            detailBlocks: [],
          }],
        });
        const { runSubagent } = await import('./shims/subagentRunnerRun');
        await runSubagent({
          agent: { name: 'nested', description: 'd', systemPrompt: 'sys', filePath: '__preset__' },
          task: 'inspect image',
          parentConversationId: ctx.conversationId,
          onProgress: (event: SubagentProgressEvent) => {
            if (event.type !== 'tool-end') return;
            const image = firstImageContent(event.resultContent);
            if (!image?.base64) return;
            ctx.executionPort.updateChildStep(
              exec.id,
              'parent-delegate',
              'child-read',
              event.result,
              event.error,
              [{
                id: 'detail-image',
                stepId: 'child-read',
                type: 'image',
                label: 'Image',
                content: 'Image preview',
                imageData: { mediaType: image.mediaType, base64: image.base64 },
                isTruncated: false,
                isExpanded: true,
              }],
            );
          },
        } as never);
        return { reason: 'completed' };
      });

      const params = reliableParams({ runId: 'main-nested-ref-run', conversationId: 'conv-main-nested' });
      handleAgentStart(params);
      const run = handleAgentRun(params);

      await vi.waitFor(() => expect(sendRequestMock).toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({ toolName: 'read_file' }),
      ));
      await Promise.resolve();
      expect(delegatedMediaStoreMocks.readDelegatedMedia).toHaveBeenCalledOnce();
      expect(nestedToolReturned).toBe(false);
      expect(sendNotificationMock.mock.calls.some((call) => (
        call[0] === 'agent.delta'
        && JSON.stringify(call[1]).includes('updateChildStep')
      ))).toBe(false);

      readGate.resolve(pngBytes);
      await expect(run).resolves.toEqual({ reason: 'completed' });

      expect(nestedImage).toEqual({ mediaType: 'image/png', base64: pngBase64 });
      const wire = JSON.stringify(sendNotificationMock.mock.calls);
      expect(wire).not.toContain(pngBase64);
      expect(wire).not.toContain('/tmp/secret.png');
      expect(wire).toContain('updateChildStep');
      const lastDeltaOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findLastIndex((call) => call[0] === 'agent.delta')
      ];
      const terminalOrder = sendNotificationMock.mock.invocationCallOrder[
        sendNotificationMock.mock.calls.findIndex((call) => call[0] === 'agent.terminal')
      ];
      expect(lastDeltaOrder).toBeLessThan(terminalOrder);
    });

    it('fails closed when a sidecar main-loop direct nested subagent cannot materialize shell-returned opaque refs', async () => {
      hasLocalToolMock.mockReturnValue(false);
      delegatedMediaStoreMocks.readDelegatedMedia.mockRejectedValueOnce(
        new Error('missing iVBORw0KGgo= at /Users/alice/secret.png'),
      );
      mockSendRequest({
        toolInvokeResult: [
          { type: 'text', text: 'Image: [REDACTED:path]' },
          {
            type: 'delegated_media_ref',
            originConversationId: 'conv-main-nested-fail',
            attachment: {
              id: 'media_shell_reverse_missing',
              sha256: 'c'.repeat(64),
              mediaType: 'image/png',
              bytes: 8,
            },
          },
        ],
      });
      let nestedRawResult: unknown;
      runSubagentLoopMock.mockImplementationOnce(async (options: SubagentLoopOptions) => {
        nestedRawResult = await options.toolInvoker!.executeAnyTool('read_file', { path: '/tmp/secret.png' });
        return {
          text: String(nestedRawResult),
          toolCallCount: 1,
          turnCount: 1,
          tokenUsage: { input: 0, output: 0 },
          duration: 1,
          stopReason: 'completed',
        };
      });
      runAgentLoopMock.mockImplementationOnce(async () => {
        const { runSubagent } = await import('./shims/subagentRunnerRun');
        await runSubagent({
          agent: { name: 'nested', description: 'd', systemPrompt: 'sys', filePath: '__preset__' },
          task: 'inspect image',
        } as never);
        return { reason: 'completed' };
      });

      await handleStartedAgentRun({ runId: 'main-nested-ref-fail-run', conversationId: 'conv-main-nested-fail' });

      expect(nestedRawResult).toBe('Error: Could not prepare sidecar tool media for display.');
      const wire = JSON.stringify(sendNotificationMock.mock.calls);
      expect(wire).not.toContain('iVBORw0KGgo=');
      expect(wire).not.toContain('/Users/alice/secret.png');
      expect(wire).not.toContain('media_shell_reverse_missing');
    });

    it('replays a validated subagent stopReason envelope into the original tool context', async () => {
      hasLocalToolMock.mockReturnValue(false);
      mockSendRequest({
        toolInvokeResult: { result: 'partial report', subagentStopReason: 'max_turns' },
      });
      const reportMetadata = vi.fn();

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool(
          'delegate_to_agent',
          { task: 'work' },
          undefined,
          undefined,
          { reportMetadata },
        ),
      );

      expect(result).toBe('partial report');
      expect(reportMetadata).toHaveBeenCalledWith({ subagentStopReason: 'max_turns' });
    });

    it('replays a validated batch terminal summary metadata envelope into the original tool context', async () => {
      hasLocalToolMock.mockReturnValue(false);
      const summary = {
        version: 1 as const,
        batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
        taskCount: 1,
        counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
        prompt: 'do not persist',
        resultContent: [{ type: 'image', source: { data: 'base64' } }],
        tasks: [{ taskIndex: 0, status: 'stopped' as const, terminalReason: 'aborted' as const, output: 'do not persist' }],
      };
      mockSendRequest({
        toolInvokeResult: { result: 'partial report', metadata: { batchTerminalSummary: summary } },
      });
      const reportMetadata = vi.fn();

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool(
          'run_agent_batch',
          { tasks: [] },
          undefined,
          undefined,
          { conversationId: 'conv-wire', toolCallId: 'tc-batch', reportMetadata },
        ),
      );

      expect(result).toBe('partial report');
      expect(reportMetadata).toHaveBeenCalledWith({
        batchTerminalSummary: {
          version: 1,
          batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
          taskCount: 1,
          counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
        },
      });
    });

    it('rejects a malformed subagent metadata envelope instead of guessing', async () => {
      hasLocalToolMock.mockReturnValue(false);
      mockSendRequest({
        toolInvokeResult: { result: 'partial report', subagentStopReason: 'mystery' },
      });

      await expect(withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('delegate_to_agent', { task: 'work' }),
      )).rejects.toThrow(/Invalid tool\.invoke subagent metadata envelope/);
    });

    it('rejects an invalid batch summary metadata envelope instead of guessing', async () => {
      hasLocalToolMock.mockReturnValue(false);
      mockSendRequest({
        toolInvokeResult: {
          result: 'partial report',
          metadata: {
            batchTerminalSummary: {
              version: 1,
              batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
              taskCount: 1,
              counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
              tasks: [{ taskIndex: 0, status: 'mystery', terminalReason: 'completed' }],
            },
          },
        },
      });

      await expect(withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('run_agent_batch', { tasks: [] }),
      )).rejects.toThrow(/Invalid tool\.invoke batch summary envelope/);
    });

    it.each([
      ['forged identity', {
        version: 1,
        batch: { conversationId: 'other-conv', batchToolCallId: 'tc-batch' },
        taskCount: 1,
        counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
      }],
      ['malformed counts', {
        version: 1,
        batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
        taskCount: 1,
        counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
        tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
      }],
      ['duplicate task index', {
        version: 1,
        batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
        taskCount: 2,
        counts: { succeeded: 0, failed: 0, stopped: 2, incomplete: 0 },
        tasks: [
          { taskIndex: 0, status: 'stopped', terminalReason: 'aborted' },
          { taskIndex: 0, status: 'stopped', terminalReason: 'aborted' },
        ],
      }],
      ['out-of-range task index', {
        version: 1,
        batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
        taskCount: 1,
        counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [{ taskIndex: 1, status: 'stopped', terminalReason: 'aborted' }],
      }],
      ['illegal status-reason pair', {
        version: 1,
        batch: { conversationId: 'conv-wire', batchToolCallId: 'tc-batch' },
        taskCount: 1,
        counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'completed' }],
      }],
    ])('rejects %s in a batch summary metadata envelope', async (_label, batchTerminalSummary) => {
      hasLocalToolMock.mockReturnValue(false);
      mockSendRequest({
        toolInvokeResult: { result: 'partial report', metadata: { batchTerminalSummary } },
      });

      await expect(withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool(
          'run_agent_batch',
          { tasks: [] },
          undefined,
          undefined,
          { conversationId: 'conv-wire', toolCallId: 'tc-batch', reportMetadata: vi.fn() },
        ),
      )).rejects.toThrow(/Invalid tool\.invoke batch summary envelope/);
    });

    // ── P1-3d-3/3d-4 SAFETY-CRITICAL: approval.check deny (terminal, no
    // fallback) vs. transport failure / malformed response (fall back) ──

    it('SECURITY: approval.check deny is TERMINAL — returns the shell\'s reason directly, never executes locally, never falls back to tool.invoke (no double approval/confirm pass)', async () => {
      hasLocalToolMock.mockReturnValue(true);
      mockSendRequest({ approvalDecision: 'deny', approvalReason: 'Error: user denied access to /etc' });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      // Local execute() must NEVER be reached on a deny.
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).toHaveBeenCalledWith('approval.check', expect.objectContaining({ toolName: 'show_widget' }));
      // A deny is terminal — falling back to tool.invoke would re-run the
      // shell's FULL approval chain a second time, double-firing any
      // confirm/permission UI the user already answered once.
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
      expect(result).toBe('Error: user denied access to /etc');
    });

    it('SECURITY: approval.check deny with no `reason` field falls back to the same default ToolResult text the reverse path uses', async () => {
      hasLocalToolMock.mockReturnValue(true);
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') return Promise.resolve({ decision: 'deny' }); // no reason field
        return Promise.resolve('should never be reached');
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
      expect(result).toBe('Error: tool "show_widget" was denied');
    });

    it('SECURITY: approval.check transport failure fails CLOSED as UNAVAILABLE (not a deny) — never executes locally, falls back to reverse tool.invoke (never defaults to allow)', async () => {
      hasLocalToolMock.mockReturnValue(true);
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') return Promise.reject(new Error('sidecar<->shell pipe broke'));
        return Promise.resolve('shell fallback after transport failure');
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      // A rejected approval.check request must NOT be treated as an allow —
      // and, per P1-3d-4, must NOT be treated as an explicit deny either
      // (the shell never answered, so nothing terminal happened): it falls
      // through to the reverse path, which independently re-derives its own
      // approval decision (and any UI) exactly once.
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(result).toBe('shell fallback after transport failure');
      expect(sendRequestMock).toHaveBeenCalledWith('tool.invoke', expect.objectContaining({ toolName: 'show_widget' }));
    });

    it('SECURITY: a malformed approval.check response (not {decision:"allow"|"deny"}) fails CLOSED as UNAVAILABLE (not a deny) — falls back to reverse tool.invoke, same as a transport failure', async () => {
      hasLocalToolMock.mockReturnValue(true);
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') return Promise.resolve('not-an-object'); // malformed shape
        return Promise.resolve('shell fallback');
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      // Malformed is "couldn't determine the answer", NOT "the answer is
      // no" — must fall back (unlike an explicit deny, which is terminal).
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).toHaveBeenCalledWith('tool.invoke', expect.objectContaining({ toolName: 'show_widget' }));
      expect(result).toBe('shell fallback');
    });

    it('SECURITY: an approval.check response with an unrecognized `decision` value (neither "allow" nor "deny") fails CLOSED as UNAVAILABLE, not treated as a deny', async () => {
      hasLocalToolMock.mockReturnValue(true);
      sendRequestMock.mockImplementation((method: unknown) => {
        if (method === 'approval.check') return Promise.resolve({ decision: 'maybe' }); // unrecognized value
        return Promise.resolve('shell fallback for unrecognized decision');
      });

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).toHaveBeenCalledWith('tool.invoke', expect.objectContaining({ toolName: 'show_widget' }));
      expect(result).toBe('shell fallback for unrecognized decision');
    });

    it('a read-only local tool that fails falls back to reverse tool.invoke (safe idempotent retry)', async () => {
      hasLocalToolMock.mockReturnValue(true);
      isLocalToolReadOnlyMock.mockReturnValue(true);
      executeLocalToolMock.mockRejectedValue(new Error('local dispatch bug'));
      mockSendRequest({ toolInvokeResult: 'shell fallback result' }); // approval still allows — local dispatch itself is what fails

      const result = await withToolInvoker((toolInvoker) => toolInvoker.executeAnyTool('http_fetch', { url: 'https://x' }));

      expect(executeLocalToolMock).toHaveBeenCalled(); // proves local execution was actually attempted (approved) before failing
      expect(result).toBe('shell fallback result');
      expect(sendRequestMock).toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({ toolName: 'http_fetch' }),
      );
    });

    it('a NON-read-only local tool that fails rethrows — no reverse fallback (no double execution)', async () => {
      hasLocalToolMock.mockReturnValue(true);
      isLocalToolReadOnlyMock.mockReturnValue(false);
      executeLocalToolMock.mockRejectedValue(new Error('side-effect already committed'));
      // beforeEach's mockSendRequest() default approves — local execution is actually attempted, then fails.

      await expect(
        withToolInvoker((toolInvoker) => toolInvoker.executeAnyTool('hypothetical_write_tool', {})),
      ).rejects.toThrow('side-effect already committed');
      expect(sendRequestMock).not.toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({ toolName: 'hypothetical_write_tool' }),
      );
    });
  });

  describe('shutdownAllAgentRuns', () => {
    it('aborts every active run\'s controller', async () => {
      let capturedSignal: AbortSignal | undefined;
      const started = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          const ctx = getCurrentAgentRunContext();
          capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
          resolveStarted();
          await new Promise(() => {}); // never resolves on its own
          return { reason: 'completed' };
        });
      });
      const params = reliableParams({ runId: 'shutdown-me', conversationId: 'conv-shutdown-me' });
      handleAgentStart(params);
      void handleAgentRun(params);
      await started;
      expect(capturedSignal?.aborted).toBe(false);
      shutdownAllAgentRuns();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });
});
