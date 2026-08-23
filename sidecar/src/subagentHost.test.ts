import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import { RpcError } from './protocol';
import { getCurrentSubagentRunContext } from './subagentRunContext';
import type { SubagentProgressEvent } from '@/core/agent/subagentLoop';
import type { SubagentHostRunParams } from './subagentHost';

// ── Mocked dependencies ─────────────────────────────────────────────────

const runSubagentLoopMock = vi.fn();
vi.mock('@/core/agent/subagentLoop', () => ({
  runSubagentLoop: (...a: unknown[]) => runSubagentLoopMock(...a),
}));

const sendRequestMock = vi.fn();
const sendNotificationMock = vi.fn();
vi.mock('./rpcClient', () => ({
  sendRequest: (...a: unknown[]) => sendRequestMock(...a),
  sendNotification: (...a: unknown[]) => sendNotificationMock(...a),
}));

// agentLoopHost drags the whole agentLoop import graph — mock the single
// lookup subagentHost consumes (image persistence's parent-run resolution).
const findActiveRunDeltaMock = vi.fn();
vi.mock('./agentLoopHost', () => ({
  findActiveRunDeltaForConversation: (...a: unknown[]) => findActiveRunDeltaMock(...a),
}));

import { handleSubagentRun, handleSubagentAbort, __getActiveSubagentRunCount, SUBAGENT_HOST_RUN_WIRE_FIELDS } from './subagentHost';

// Unique default runId per call — `activeRuns` is real module-level state
// that persists across tests within this file (no reset hook exists for
// it), so tests that don't care about a SPECIFIC runId must not collide on
// a shared literal default.
let runIdCounter = 0;
function nextRunId(): string {
  runIdCounter += 1;
  return `default-run-${runIdCounter}`;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    runId: nextRunId(),
    agent: { name: 'tester', description: 'd', systemPrompt: 'sys', filePath: '__preset__' },
    task: 'do the thing',
    locale: 'zh-CN',
    uiStrings: {
      'chat.subagent.taskCancelled': 'x',
      'chat.subagent.outputLimitIncomplete': 'x',
      'chat.subagent.stoppedIncomplete': 'x',
      'chat.subagent.cancelled': 'x',
      'chat.subagent.hookBlocked': 'x',
      'chat.subagent.noContent': 'x',
      'chat.errorEmptyBody': 'x',
    },
    settingsSnapshot: { agentMaxTurns: 200 },
    resolvedCreds: { apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false },
    tools: [{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} } }],
    workspacePathSnapshot: '/tmp/workspace',
    ...overrides,
  };
}

function resultShape(text: string) {
  return { text, toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 0, stopReason: 'completed' as const };
}

// handleSubagentRun's return type is deliberately `Promise<unknown>` at the
// RPC boundary (subagentHost.ts:185 — it crosses a JSON-RPC wire in
// production, so the signature intentionally doesn't leak SubagentResult's
// shape). In these tests it resolves to the plain object literal
// subagentHost.ts builds at its `return { text, toolCallCount, ... }`
// (subagentHost.ts:266-272), which is exactly `resultShape`'s shape — so
// tests narrow the awaited value to this type rather than changing the
// production return type.
type SubagentRunResult = ReturnType<typeof resultShape> & {
  stopReason: 'completed' | 'aborted' | 'error' | 'max_turns';
};

describe('subagentHost', () => {
  beforeEach(() => {
    runSubagentLoopMock.mockReset();
    sendRequestMock.mockReset();
    sendRequestMock.mockResolvedValue('tool output');
    sendNotificationMock.mockReset();
    findActiveRunDeltaMock.mockReset();
  });

  describe('param validation', () => {
    it('keeps the sidecar-side SubagentRunParams field list explicit and exhaustive', () => {
      type HostWireField = typeof SUBAGENT_HOST_RUN_WIRE_FIELDS[number];
      type MissingHostRunParam = Exclude<keyof SubagentHostRunParams, HostWireField>;
      expectTypeOf<MissingHostRunParam>().toEqualTypeOf<never>();

      expect(SUBAGENT_HOST_RUN_WIRE_FIELDS).toEqual([
        'runId',
        'agent',
        'task',
        'context',
        'parentConversationSummary',
        'parentConversationId',
        'imContext',
        'allowedTools',
        'blockedTools',
        'locale',
        'uiStrings',
        'settingsSnapshot',
        'resolvedCreds',
        'tools',
        'workspacePathSnapshot',
      ]);
    });

    it.each([
      ['non-object params', 42],
      ['missing runId', { ...baseParams(), runId: undefined }],
      ['agent missing name', { ...baseParams(), agent: {} }],
      ['task not a string', { ...baseParams(), task: 123 }],
      ['tools not an array', { ...baseParams(), tools: 'nope' }],
      ['settingsSnapshot not an object', { ...baseParams(), settingsSnapshot: null }],
      ['resolvedCreds not an object', { ...baseParams(), resolvedCreds: null }],
      ['uiStrings not an object', { ...baseParams(), uiStrings: null }],
      ['locale not a string', { ...baseParams(), locale: 42 }],
      ['workspacePathSnapshot not string/null', { ...baseParams(), workspacePathSnapshot: 42 }],
    ])('rejects %s with RpcError -32602', async (_label, params) => {
      await expect(handleSubagentRun(params)).rejects.toThrow(RpcError);
      await expect(handleSubagentRun(params)).rejects.toMatchObject({ code: -32602 });
    });

    it('rejects a duplicate runId that is already active', async () => {
      const dupRunId = 'dup-test-run'; // fixed, unique to this test — intentionally left "active" forever (never resolved) since nothing else in this file reuses this id
      const d = new Promise(() => {}); // never settles — keeps the first run "active"
      runSubagentLoopMock.mockReturnValueOnce(d);
      void handleSubagentRun(baseParams({ runId: dupRunId }));
      await Promise.resolve(); // let the first call register in activeRuns

      await expect(handleSubagentRun(baseParams({ runId: dupRunId }))).rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('per-run isolation (AsyncLocalStorage context + tool.invoke reverse channel)', () => {
    it('concurrent runs never see each other\'s context, even when interleaved', async () => {
      const seen: Record<string, unknown> = {};
      let releaseA: () => void = () => {};
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

      runSubagentLoopMock.mockImplementation(async (options: { toolInvoker: { executeAnyTool: (...a: unknown[]) => Promise<unknown> } }) => {
        const ctx = getCurrentSubagentRunContext();
        seen[ctx.runId] = ctx;
        if (ctx.runId === 'run-A') {
          await gateA; // pause run A mid-execution
        }
        const toolResult = await options.toolInvoker.executeAnyTool('probe', {}, undefined, undefined, undefined);
        return resultShape(`${ctx.runId}:${toolResult}`);
      });

      const runA = handleSubagentRun(baseParams({ runId: 'run-A', resolvedCreds: { apiKey: 'A-key', baseUrl: undefined, forceOpenAiCompatible: false } }));
      // Let run A start and reach its await-gate before starting run B.
      await Promise.resolve();
      await Promise.resolve();

      const runB = handleSubagentRun(baseParams({ runId: 'run-B', resolvedCreds: { apiKey: 'B-key', baseUrl: undefined, forceOpenAiCompatible: false } }));
      const resultB = (await runB) as SubagentRunResult; // B fully completes WHILE A is still paused

      expect((seen['run-A'] as { resolvedCreds: { apiKey: string } }).resolvedCreds.apiKey).toBe('A-key');
      expect((seen['run-B'] as { resolvedCreds: { apiKey: string } }).resolvedCreds.apiKey).toBe('B-key');
      expect(resultB.text).toBe('run-B:tool output');

      releaseA();
      const resultA = (await runA) as SubagentRunResult;
      expect(resultA.text).toBe('run-A:tool output');
    });

    it('reverse-request correlation: toolInvoker.executeAnyTool sends a tool.invoke request tagged with THIS run\'s runId', async () => {
      runSubagentLoopMock.mockImplementation(async (options: { toolInvoker: { executeAnyTool: (...a: unknown[]) => Promise<unknown> } }) => {
        const r = await options.toolInvoker.executeAnyTool('read_file', { path: 'x.txt' }, undefined, undefined, { workspacePath: '/tmp' });
        return resultShape(String(r));
      });
      sendRequestMock.mockResolvedValue('file contents');

      const result = (await handleSubagentRun(baseParams({ runId: 'run-correlate' }))) as SubagentRunResult;

      expect(sendRequestMock).toHaveBeenCalledWith('tool.invoke', {
        runId: 'run-correlate',
        toolName: 'read_file',
        input: { path: 'x.txt' },
        context: { workspacePath: '/tmp' },
      });
      expect(result.text).toBe('file contents');
    });

    it('returns the structured subagent stopReason across the sidecar boundary', async () => {
      runSubagentLoopMock.mockResolvedValueOnce({
        ...resultShape('failed before completion'),
        stopReason: 'error',
      });

      const result = (await handleSubagentRun(baseParams({ runId: 'stop-reason-run' }))) as SubagentRunResult;

      expect(result.stopReason).toBe('error');
    });

    it('the sidecar-local ToolDefinition.execute stub throws if ever called directly (it never should be)', async () => {
      let capturedTools: Array<{ execute: () => Promise<unknown> }> = [];
      runSubagentLoopMock.mockImplementation(async (options: { toolInvoker: { getAllTools: () => Array<{ execute: () => Promise<unknown> }> } }) => {
        capturedTools = options.toolInvoker.getAllTools();
        return resultShape('ok');
      });

      await handleSubagentRun(baseParams());

      expect(capturedTools).toHaveLength(1);
      await expect(capturedTools[0].execute()).rejects.toThrow(/should never happen/);
    });
  });

  describe('subagent.progress forwarding (follow-up: closes P1-3a-REPORT.md §10 concern #1)', () => {
    it('emits a subagent.progress notification tagged with this run\'s runId for every onProgress call', async () => {
      const events: SubagentProgressEvent[] = [
        { type: 'tool-start', id: 't1', toolName: 'read_file', toolInput: { path: 'x.txt' } },
        { type: 'tool-end', id: 't1', toolName: 'read_file', result: 'file contents', error: false },
        { type: 'turn-complete', turn: 1, totalTurns: 200 },
      ];
      runSubagentLoopMock.mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
        for (const e of events) options.onProgress?.(e);
        return resultShape('ok');
      });

      await handleSubagentRun(baseParams({ runId: 'progress-run' }));

      expect(sendNotificationMock).toHaveBeenCalledTimes(3);
      for (const [i, e] of events.entries()) {
        expect(sendNotificationMock).toHaveBeenNthCalledWith(i + 1, 'subagent.progress', { runId: 'progress-run', event: e });
      }
    });

    it('serializability: a tool-end event with a representative ToolResult-derived string round-trips through JSON unchanged', async () => {
      // result is ALREADY a plain string by the time subagentLoop.ts builds
      // this event (toolResultToString() has already run) — not a raw
      // ToolResult (which could carry an image-content variant). Exercise a
      // string with quotes/newlines/unicode to prove no JSON-unsafe member
      // sneaks in via the notification path.
      const toolEndEvent = {
        type: 'tool-end' as const,
        id: 't1',
        toolName: 'read_file',
        result: 'line one\nline two with "quotes" and 中文 and \\backslash\\',
        error: false,
      };
      runSubagentLoopMock.mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
        options.onProgress?.(toolEndEvent);
        return resultShape('ok');
      });

      await handleSubagentRun(baseParams({ runId: 'roundtrip-run' }));

      const [, notifiedParams] = sendNotificationMock.mock.calls[0] as [string, { runId: string; event: unknown }];
      const roundTripped = JSON.parse(JSON.stringify(notifiedParams));
      expect(roundTripped).toEqual({ runId: 'roundtrip-run', event: toolEndEvent });
    });
  });

  describe('run-scoped tool restrictions across the wire', () => {
    it('forwards BOTH allowedTools and blockedTools from wire params into SubagentLoopOptions', async () => {
      // blockedTools used to be dropped at this boundary, silently re-arming
      // every blockedTools-only safety tier (scheduler/trigger/IM) whenever
      // the subagent ran in the sidecar.
      runSubagentLoopMock.mockResolvedValue(resultShape('ok'));

      await handleSubagentRun(baseParams({
        allowedTools: ['read_*'],
        blockedTools: ['abu-browser__*', 'request_workspace'],
      }));

      expect(runSubagentLoopMock).toHaveBeenCalledWith(expect.objectContaining({
        allowedTools: ['read_*'],
        blockedTools: ['abu-browser__*', 'request_workspace'],
      }));
    });

    it('reconstructs every wire-backed SubagentLoopOptions field from one request', async () => {
      runSubagentLoopMock.mockResolvedValue(resultShape('ok'));
      const agentOverride = {
        name: 'wire-agent',
        description: 'wire description',
        systemPrompt: 'wire prompt',
        filePath: '__preset__',
      };
      const imContext = { platform: 'dchat', workspacePath: '/im/workspace' };

      await handleSubagentRun(baseParams({
        agent: agentOverride,
        task: 'wire task',
        context: 'wire context',
        parentConversationSummary: 'wire summary',
        parentConversationId: 'parent-conversation',
        imContext,
        allowedTools: ['read_*'],
        blockedTools: ['write_*'],
      }));

      expect(runSubagentLoopMock).toHaveBeenCalledWith(expect.objectContaining({
        agent: agentOverride,
        task: 'wire task',
        context: 'wire context',
        parentConversationSummary: 'wire summary',
        parentConversationId: 'parent-conversation',
        imContext,
        allowedTools: ['read_*'],
        blockedTools: ['write_*'],
      }));
    });

    it('rejects a malformed blockedTools param (type validation symmetric with allowedTools)', async () => {
      await expect(handleSubagentRun(baseParams({ blockedTools: 'not-an-array' })))
        .rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('subagent image persistence (sidecar-authoritative when parent loop is sidecar-run)', () => {
    const imageContent = [
      { type: 'text' as const, text: 'Image: /tmp/shot.png' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } },
    ];

    function emitScreenshotRun(overrides: Record<string, unknown> = {}) {
      runSubagentLoopMock.mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
        options.onProgress?.({ type: 'tool-start', id: 'sub-t1', toolName: 'computer', toolInput: { action: 'screenshot' } });
        options.onProgress?.({ type: 'tool-end', id: 'sub-t1', toolName: 'computer', result: 'Image: /tmp/shot.png', error: false, resultContent: imageContent });
        return resultShape('ok');
      });
      return handleSubagentRun(baseParams({ parentConversationId: 'conv-parent', ...overrides }));
    }

    it('appends the image-bearing tool call through the PARENT run\'s frame ChatDelta (mirror + shell, survives ledger checkpoint)', async () => {
      const appendMessageToolCall = vi.fn();
      findActiveRunDeltaMock.mockReturnValue({ chatDelta: { appendMessageToolCall }, loopId: 'parent-loop-1' });

      await emitScreenshotRun();

      expect(findActiveRunDeltaMock).toHaveBeenCalledWith('conv-parent');
      expect(appendMessageToolCall).toHaveBeenCalledTimes(1);
      expect(appendMessageToolCall).toHaveBeenCalledWith('conv-parent', 'parent-loop-1', {
        id: 'sub-t1',
        name: 'computer',
        input: { action: 'screenshot' },
        result: 'Image: /tmp/shot.png',
        resultContent: imageContent,
        isError: undefined,
        hidden: true,
        fromSubagent: true,
      });
      // The progress notification still goes out for both events.
      expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the parent loop is not sidecar-run (shell-side append is the authority)', async () => {
      findActiveRunDeltaMock.mockReturnValue(undefined);
      await emitScreenshotRun();
      expect(sendNotificationMock).toHaveBeenCalledTimes(2); // forwarding unaffected
    });

    it('does not even resolve the parent run for a text-only tool-end', async () => {
      findActiveRunDeltaMock.mockReturnValue({ chatDelta: { appendMessageToolCall: vi.fn() }, loopId: 'parent-loop-1' });
      runSubagentLoopMock.mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
        options.onProgress?.({ type: 'tool-end', id: 't1', toolName: 'read_file', result: 'plain', error: false, resultContent: [{ type: 'text', text: 'plain' }] });
        return resultShape('ok');
      });
      await handleSubagentRun(baseParams({ parentConversationId: 'conv-parent' }));
      expect(findActiveRunDeltaMock).not.toHaveBeenCalled();
    });
  });

  describe('activeRuns lifecycle + abort', () => {
    it('tracks active run count and clears it once the run settles', async () => {
      // `activeRuns` is real module-level state shared across this whole test
      // file (no reset hook) — the "duplicate runId" test above deliberately
      // leaves one run permanently active. Assert the DELTA, not an absolute
      // baseline of 0.
      const before = __getActiveSubagentRunCount();
      let releaseRun!: () => void;
      const gate = new Promise<void>((r) => { releaseRun = r; });
      runSubagentLoopMock.mockImplementation(async () => {
        expect(__getActiveSubagentRunCount()).toBe(before + 1); // registered while in flight
        await gate;
        return resultShape('ok');
      });

      const runPromise = handleSubagentRun(baseParams());
      await Promise.resolve();
      releaseRun();
      await runPromise;

      expect(__getActiveSubagentRunCount()).toBe(before); // cleared once settled
    });

    it('subagent.abort aborts only the targeted run\'s AbortController — a concurrent run is unaffected', async () => {
      const signals: Record<string, AbortSignal> = {};
      let resolveA!: () => void;
      let resolveB!: () => void;
      const gateA = new Promise<void>((r) => { resolveA = r; });
      const gateB = new Promise<void>((r) => { resolveB = r; });

      runSubagentLoopMock.mockImplementation(async (options: { signal?: AbortSignal }, ) => {
        return options;
      });
      // Simpler: capture signal directly via a custom implementation keyed by call order.
      runSubagentLoopMock.mockImplementation(async (options: { signal?: AbortSignal }) => {
        const runId = getCurrentSubagentRunContext().runId;
        signals[runId] = options.signal!;
        if (runId === 'abort-A') { await gateA; } else { await gateB; }
        return resultShape(options.signal?.aborted ? 'aborted' : 'completed');
      });

      const runA = handleSubagentRun(baseParams({ runId: 'abort-A' }));
      await Promise.resolve();
      const runB = handleSubagentRun(baseParams({ runId: 'abort-B' }));
      await Promise.resolve();

      handleSubagentAbort({ runId: 'abort-A' });

      expect(signals['abort-A'].aborted).toBe(true);
      expect(signals['abort-B'].aborted).toBe(false);

      resolveA();
      resolveB();
      const [resultA, resultB] = (await Promise.all([runA, runB])) as [SubagentRunResult, SubagentRunResult];
      expect(resultA.text).toBe('aborted');
      expect(resultB.text).toBe('completed');
    });

    it('subagent.abort with an unknown runId is a silent no-op', () => {
      expect(() => handleSubagentAbort({ runId: 'no-such-run' })).not.toThrow();
    });
  });
});
