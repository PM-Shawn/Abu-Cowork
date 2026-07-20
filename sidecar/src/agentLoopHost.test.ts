import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcError } from './protocol';

// ── Mocked dependencies ─────────────────────────────────────────────────

const runAgentLoopMock = vi.fn();
vi.mock('@/core/agent/agentLoop', () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
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
  handleAgentAbort,
  handleAgentEnqueueInput,
  handleStateConvPatch,
  handleStateExecPatch,
  handleStateSettings,
  handleStatePlanMode,
  shutdownAllAgentRuns,
  __getActiveAgentRunCount,
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

describe('agentLoopHost', () => {
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    applyPlanModeStateMock.mockReset();
    sendRequestMock.mockReset();
    sendRequestMock.mockResolvedValue('tool output');
    sendNotificationMock.mockReset();
    hasLocalToolMock.mockReset();
    hasLocalToolMock.mockReturnValue(false);
    isLocalToolReadOnlyMock.mockReset();
    executeLocalToolMock.mockReset();
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
    ])('rejects %s with RpcError -32602', async (_label, params) => {
      await expect(handleAgentRun(params)).rejects.toThrow(RpcError);
      await expect(handleAgentRun(params)).rejects.toMatchObject({ code: -32602 });
    });

    it('rejects a duplicate runId that is already active', async () => {
      const dupRunId = 'dup-agent-run';
      const never = new Promise(() => {});
      runAgentLoopMock.mockReturnValueOnce(never);
      void handleAgentRun(baseParams({ runId: dupRunId, conversationId: 'conv-dup' }));
      await Promise.resolve();

      await expect(handleAgentRun(baseParams({ runId: dupRunId, conversationId: 'conv-dup-2' })))
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
      const params = baseParams();
      const result = await handleAgentRun(params);
      expect(result).toEqual({ reason: 'completed' });
      expect(sawContextRunId).toBe(params.runId);
    });

    it('passes settingsReader/orchestration/options through AgentLoopOptions', async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      runAgentLoopMock.mockImplementationOnce(async (_convId: string, _msg: string, options: Record<string, unknown>) => {
        capturedOptions = options;
        return { reason: 'completed' };
      });
      const params = baseParams({ options: { blockedTools: ['x'] } });
      await handleAgentRun(params);
      expect(capturedOptions?.blockedTools).toEqual(['x']);
      expect(capturedOptions?.orchestration).toBe(params.orchestration);
      expect(capturedOptions?.settingsReader).toBeDefined();
    });

    it('applies planMode when provided', async () => {
      runAgentLoopMock.mockResolvedValueOnce({ reason: 'completed' });
      const params = baseParams({ planMode: 'planning' });
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
      const okParams = baseParams();
      await handleAgentRun(okParams);
      expect(__getActiveAgentRunCount()).toBe(before);

      runAgentLoopMock.mockRejectedValueOnce(new Error('boom'));
      const errParams = baseParams();
      await expect(handleAgentRun(errParams)).rejects.toThrow('boom');
      expect(__getActiveAgentRunCount()).toBe(before);
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

      const runA = handleAgentRun(baseParams({ runId: 'run-A', conversationId: 'conv-A' }));
      const runB = handleAgentRun(baseParams({ runId: 'run-B', conversationId: 'conv-B' }));
      await Promise.all([runA, runB]);

      expect(seenByRun.first.conversationId).toBe('conv-A');
      expect(seenByRun.firstAgain.conversationId).toBe('conv-A');
      expect(seenByRun.second.conversationId).toBe('conv-B');
    });
  });

  describe('handleAgentAbort', () => {
    it('is idempotent and silent for an unknown runId', () => {
      expect(() => handleAgentAbort({ runId: 'never-existed' })).not.toThrow();
    });

    it('aborts the run\'s conversation-scoped controller (observed via AbortRegistry inside the loop)', async () => {
      let capturedSignal: AbortSignal | undefined;
      let releaseLoop: (() => void) | undefined;
      const params = baseParams({ runId: 'abort-me', conversationId: 'conv-abort-me' });
      const loopStarted = new Promise<void>((resolveStarted) => {
        runAgentLoopMock.mockImplementationOnce(async () => {
          const ctx = getCurrentAgentRunContext();
          capturedSignal = ctx.abortRegistry.getAbortController(ctx.conversationId).signal;
          resolveStarted();
          await new Promise<void>((r) => { releaseLoop = r; });
          return { reason: capturedSignal?.aborted ? 'aborted' : 'completed' };
        });
      });
      const runPromise = handleAgentRun(params);
      await loopStarted;
      expect(capturedSignal?.aborted).toBe(false);
      handleAgentAbort({ runId: 'abort-me' });
      expect(capturedSignal?.aborted).toBe(true);
      releaseLoop?.();
      const result = await runPromise;
      expect(result).toEqual({ reason: 'aborted' });
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
      const runPromise = handleAgentRun(baseParams({ runId: 'enqueue-run-1', conversationId }));
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
      const runPromise = handleAgentRun(baseParams({ runId: 'enqueue-run-2', conversationId }));
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
      const runPromise = handleAgentRun(baseParams({ runId: 'enqueue-run-3', conversationId }));
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

      const params = baseParams({
        runId: 'seed-run-1',
        conversationId,
        queuedInputs: [
          { id: 'leftover-1', text: 'leftover one' },
          { id: 'leftover-2', text: 'leftover two', isSystem: true },
        ],
      });
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
      await handleAgentRun(baseParams({ runId: 'seed-run-2', conversationId }));
      expect(getQueuedInputs(conversationId)).toHaveLength(0);
    });
  });

  describe('state.convPatch / state.execPatch routing', () => {
    it('handleStateConvPatch updates the run\'s conversation mirror; unknown runId is a silent drop', async () => {
      let readWorkspacePath: string | null | undefined;
      const params = baseParams({ runId: 'patch-me', conversationId: 'conv-patch-me' });
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
      const params = baseParams({ runId: 'flush-me', conversationId: 'conv-flush-me' });
      runAgentLoopMock.mockImplementationOnce(async () => {
        const ctx = getCurrentAgentRunContext();
        ctx.chatDelta.setConversationStatus(ctx.conversationId, 'idle');
        return { reason: 'completed' };
      });
      await handleAgentRun(params);
      const deltaCalls = sendNotificationMock.mock.calls.filter((c) => c[0] === 'agent.delta');
      expect(deltaCalls.length).toBeGreaterThan(0);
      const lastBatch = deltaCalls[deltaCalls.length - 1][1] as { runId: string; frames: unknown[] };
      expect(lastBatch.runId).toBe('flush-me');
      expect(lastBatch.frames.length).toBeGreaterThan(0);
    });
  });

  describe('local tool dispatch (P1-3d-1)', () => {
    /** Runs `fn(toolInvoker)` inside the run's real agentRunContext scope (via runAgentLoopMock), returning fn's result. */
    async function withToolInvoker<T>(fn: (toolInvoker: ReturnType<typeof getCurrentAgentRunContext>['toolInvoker']) => Promise<T>): Promise<T> {
      let captured!: T;
      runAgentLoopMock.mockImplementationOnce(async () => {
        captured = await fn(getCurrentAgentRunContext().toolInvoker);
        return { reason: 'completed' };
      });
      await handleAgentRun(baseParams());
      return captured;
    }

    it('local registry hit runs locally and never calls tool.invoke', async () => {
      hasLocalToolMock.mockReturnValue(true);
      executeLocalToolMock.mockResolvedValue('local result');

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('show_widget', { title: 't' }),
      );

      expect(result).toBe('local result');
      expect(executeLocalToolMock).toHaveBeenCalledWith('show_widget', { title: 't' }, undefined, undefined);
      expect(sendRequestMock).not.toHaveBeenCalledWith('tool.invoke', expect.anything());
    });

    it('local registry miss falls through to reverse tool.invoke, unchanged', async () => {
      hasLocalToolMock.mockReturnValue(false);

      const result = await withToolInvoker((toolInvoker) =>
        toolInvoker.executeAnyTool('read_file', { path: '/tmp/x' }),
      );

      expect(result).toBe('tool output');
      expect(executeLocalToolMock).not.toHaveBeenCalled();
      expect(sendRequestMock).toHaveBeenCalledWith(
        'tool.invoke',
        expect.objectContaining({ toolName: 'read_file', input: { path: '/tmp/x' } }),
      );
    });

    it('a read-only local tool that fails falls back to reverse tool.invoke (safe idempotent retry)', async () => {
      hasLocalToolMock.mockReturnValue(true);
      isLocalToolReadOnlyMock.mockReturnValue(true);
      executeLocalToolMock.mockRejectedValue(new Error('local dispatch bug'));
      sendRequestMock.mockResolvedValue('shell fallback result');

      const result = await withToolInvoker((toolInvoker) => toolInvoker.executeAnyTool('http_fetch', { url: 'https://x' }));

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
      const params = baseParams({ runId: 'shutdown-me', conversationId: 'conv-shutdown-me' });
      void handleAgentRun(params);
      await started;
      expect(capturedSignal?.aborted).toBe(false);
      shutdownAllAgentRuns();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });
});
