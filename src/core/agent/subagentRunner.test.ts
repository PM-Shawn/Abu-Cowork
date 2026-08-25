/**
 * subagentRunner.ts — sidecar routing selector + run-session registry.
 *
 * Every test dynamically re-imports the module fresh (`vi.resetModules()` +
 * `await import('./subagentRunner')`) so each test starts with a clean
 * module-level `sessions` map and `handlersRegistered` flag — both are
 * singleton state inside the real module, and the "register handlers
 * exactly once" / "capture the ONE registered tool.invoke handler" tests
 * need that isolation.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { SubagentDefinition } from '../../types';

// ── Mocked dependencies (thin forwarding factories over stable outer
// vi.fn() proxies — survives vi.resetModules() per-test re-import, same
// pattern as sidecarManager.test.ts) ──────────────────────────────────────

const getSidecarStatus = vi.fn();
const sidecarRequestMock = vi.fn();
const notifySidecar = vi.fn();
const onSidecarRequest = vi.fn();
const onSidecarNotification = vi.fn();
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
  getSidecarStatus: (...a: unknown[]) => getSidecarStatus(...a),
  request: (...a: unknown[]) => sidecarRequestMock(...a),
  notifySidecar: (...a: unknown[]) => notifySidecar(...a),
  onSidecarRequest: (...a: unknown[]) => onSidecarRequest(...a),
  onSidecarNotification: (...a: unknown[]) => onSidecarNotification(...a),
  SidecarRequestError: MockSidecarRequestError,
}));

const runSubagentLoopMock = vi.fn();
vi.mock('./subagentLoop', async () => {
  const actual = await vi.importActual<typeof import('./subagentLoop')>('./subagentLoop');
  return {
    ...actual,
    runSubagentLoop: (...a: unknown[]) => runSubagentLoopMock(...a),
  };
});

const executeAnyToolMock = vi.fn().mockResolvedValue('tool result');
const getAllToolsMock = vi.fn().mockReturnValue([]);
vi.mock('./ports/toolInvoker', () => ({
  getToolInvoker: () => ({
    getAllTools: getAllToolsMock,
    executeAnyTool: (...a: unknown[]) => executeAnyToolMock(...a),
    toolResultToString: (r: unknown) => String(r),
  }),
}));

const checkToolApprovalMock = vi.fn().mockResolvedValue({ decision: 'allow' });
vi.mock('../tools/registry', () => ({
  checkToolApproval: (...a: unknown[]) => checkToolApprovalMock(...a),
}));

const getSettingsSnapshotMock = vi.fn().mockReturnValue({ agentMaxTurns: 200 });
vi.mock('./ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => getSettingsSnapshotMock() }),
}));

const getCurrentPathMock = vi.fn().mockReturnValue('/tmp/workspace');
vi.mock('./ports/workspaceReader', () => ({
  getWorkspaceReader: () => ({ getCurrentPath: () => getCurrentPathMock() }),
}));

const getActiveApiKeyMock = vi.fn().mockReturnValue('sk-test');
const getActiveProviderMock = vi.fn().mockReturnValue({ id: 'p1', baseUrl: undefined, apiFormat: 'anthropic' });
vi.mock('../../utils/settingsSelectors', () => ({
  getActiveApiKey: (...a: unknown[]) => getActiveApiKeyMock(...a),
  getActiveProvider: (...a: unknown[]) => getActiveProviderMock(...a),
}));

const resolveEffectiveLlmCredsMock = vi.fn().mockReturnValue({ apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false });
vi.mock('../enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: (...a: unknown[]) => resolveEffectiveLlmCredsMock(...a),
}));

const emitHookMock = vi.fn((event: unknown) => event);
vi.mock('./lifecycleHooks', () => ({
  emitHook: (...a: unknown[]) => emitHookMock(...a),
}));

vi.mock('../../i18n', () => ({
  getLocale: () => 'zh-CN',
  getI18n: () => ({
    chat: {
      subagent: {
        taskCancelled: '任务已取消',
        outputLimitIncomplete: '输出未完成',
        stoppedIncomplete: '已停止',
        cancelled: '已取消',
        hookBlocked: '被拦截',
        noContent: '无内容',
      },
      errorEmptyBody: '空响应',
    },
  }),
}));

const agent: SubagentDefinition = {
  name: 'tester',
  description: 'd',
  systemPrompt: 'sys',
  filePath: '__preset__',
};

/** Deferred promise helper — lets a test control exactly when sidecarRequest() settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function importFresh() {
  vi.resetModules();
  const mod = await import('./subagentRunner');
  return mod;
}

describe('subagentRunner', () => {
  // Same cold-transform hazard as agentLoopRunner.test.ts: left in the first
  // test body, the first importFresh() here measured 2.7 s against the 5 s
  // testTimeout — and a timed-out body is not cancelled, so it keeps mutating
  // the shared mocks after vitest has moved on. Pay it under the 30 s
  // hookTimeout instead.
  beforeAll(async () => {
    await import('./subagentRunner');
  });

  beforeEach(() => {
    getSidecarStatus.mockReset();
    sidecarRequestMock.mockReset();
    notifySidecar.mockReset();
    onSidecarRequest.mockReset();
    onSidecarNotification.mockReset();
    runSubagentLoopMock.mockReset();
    runSubagentLoopMock.mockResolvedValue({ text: 'in-process result', toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
    executeAnyToolMock.mockReset();
    executeAnyToolMock.mockResolvedValue('tool result');
    checkToolApprovalMock.mockReset();
    checkToolApprovalMock.mockResolvedValue({ decision: 'allow' });
    getAllToolsMock.mockReset();
    getAllToolsMock.mockReturnValue([
      { name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} }, execute: async () => 'x' },
    ]);
    getSettingsSnapshotMock.mockReturnValue({ agentMaxTurns: 200 });
    getCurrentPathMock.mockReturnValue('/tmp/workspace');
    getActiveApiKeyMock.mockReturnValue('sk-test');
    getActiveProviderMock.mockReturnValue({ id: 'p1', baseUrl: undefined, apiFormat: 'anthropic' });
    resolveEffectiveLlmCredsMock.mockReset();
    resolveEffectiveLlmCredsMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false });
    emitHookMock.mockClear();
  });

  describe('routing', () => {
    it('runs in-process (runSubagentLoop) when the sidecar is not running', async () => {
      getSidecarStatus.mockReturnValue('stopped');
      const { runSubagent } = await importFresh();

      const result = await runSubagent({ agent, task: 'do the thing' });

      expect(runSubagentLoopMock).toHaveBeenCalledTimes(1);
      expect(runSubagentLoopMock).toHaveBeenCalledWith({
        agent,
        task: 'do the thing',
        skillCommandApprovalFactory: expect.any(Function),
      });
      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(result.text).toBe('in-process result');
    });

    it('aborts a scoped in-process subagent signal when the subagent run settles', async () => {
      getSidecarStatus.mockReturnValue('stopped');
      let runSignal: AbortSignal | undefined;
      runSubagentLoopMock.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
        runSignal = options.signal;
        expect(runSignal?.aborted).toBe(false);
        return { text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 };
      });
      const { runSubagent } = await importFresh();
      const parentController = new AbortController();

      await runSubagent({
        agent,
        task: 'start a background command',
        signal: parentController.signal,
        authorizationScopeId: 'scope-subagent',
      });

      expect(runSignal).toBeDefined();
      expect(runSignal).not.toBe(parentController.signal);
      expect(runSignal?.aborted).toBe(true);
      expect(parentController.signal.aborted).toBe(false);
    });

    it('routes through the sidecar when running — dispatches subagent.run and reconstructs the SubagentResult', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({
        text: 'sidecar result',
        toolCallCount: 2,
        turnCount: 3,
        tokenUsage: { input: 10, output: 20 },
        duration: 5,
      });
      const { runSubagent } = await importFresh();

      const result = await runSubagent({ agent, task: 'do the thing' });

      expect(runSubagentLoopMock).not.toHaveBeenCalled();
      expect(sidecarRequestMock).toHaveBeenCalledTimes(1);
      const [method, params, timeoutMs] = sidecarRequestMock.mock.calls[0];
      expect(method).toBe('subagent.run');
      expect(timeoutMs).toBe(0);
      const p = params as { runId: string; agent: unknown; task: string; tools: unknown[] };
      expect(typeof p.runId).toBe('string');
      expect(p.agent).toEqual(agent);
      expect(p.task).toBe('do the thing');
      // tools are serialized without `execute` (a function can't cross JSON-RPC).
      expect(p.tools).toEqual([{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object', properties: {} } }]);

      expect(result.text).toBe('sidecar result');
      expect(result.toolCallCount).toBe(2);
      expect(result.turnCount).toBe(3);
      expect(result.tokenUsage).toEqual({ input: 10, output: 20 });
    });

    it('serializes blockedTools into subagent.run params alongside allowedTools', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({
        text: 'sidecar result',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
      });
      const { runSubagent } = await importFresh();

      await runSubagent({
        agent,
        task: 'read only',
        allowedTools: ['read_*'],
        blockedTools: ['run_command', 'abu-browser__*'],
      });

      const params = sidecarRequestMock.mock.calls[0][1] as {
        allowedTools?: string[];
        blockedTools?: string[];
      };
      expect(params.allowedTools).toEqual(['read_*']);
      expect(params.blockedTools).toEqual(['run_command', 'abu-browser__*']);
    });

    it('serializes the inherited run permission ceiling into subagent.run params', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({
        text: 'sidecar result',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
      });
      const { runSubagent } = await importFresh();
      const ceiling = { version: 1, source: 'trigger', capability: 'custom', allowedTools: ['read_file'] };

      await runSubagent({
        agent,
        task: 'bounded work',
        runPermissionCeiling: ceiling as never,
      });

      const params = sidecarRequestMock.mock.calls[0][1] as { runPermissionCeiling?: unknown };
      expect(params.runPermissionCeiling).toEqual(ceiling);
    });

    it('treats an empty authorization scope as explicit and snapshots no global workspace for sidecar subagents', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({
        text: 'sidecar result',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
      });
      getCurrentPathMock.mockReturnValue('/tmp/global-workspace');
      const { runSubagent } = await importFresh();

      await runSubagent({ agent, task: 'do the thing', authorizationScopeId: '' });

      const params = sidecarRequestMock.mock.calls[0][1] as {
        authorizationScopeId?: string;
        workspacePathSnapshot?: string | null;
      };
      expect(params.authorizationScopeId).toBe('');
      expect(params.workspacePathSnapshot).toBeNull();
    });

    it('uses the parent run settings snapshot for both subagent credentials and sidecar model selection', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({
        text: 'sidecar result',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 1, output: 1 },
        duration: 1,
      });
      const parentSettings = {
        activeModel: { providerId: 'parent-provider', modelId: 'parent-model' },
        providers: [{ id: 'parent-provider', apiKey: 'parent-key', baseUrl: 'https://parent.test' }],
      };
      const parentReader = { getSnapshot: () => parentSettings };
      getActiveApiKeyMock.mockImplementation((settings: unknown) => {
        expect(settings).toBe(parentSettings);
        return 'parent-key';
      });
      getActiveProviderMock.mockImplementation((settings: unknown) => {
        expect(settings).toBe(parentSettings);
        return { id: 'parent-provider', baseUrl: 'https://parent.test', apiFormat: 'openai-compatible' };
      });
      resolveEffectiveLlmCredsMock.mockImplementation((apiKey: string, baseUrl: string | undefined) => ({
        apiKey,
        baseUrl,
        forceOpenAiCompatible: false,
      }));
      const { getSubagentRunInheritance, runSubagent } = await importFresh();

      expect(getSubagentRunInheritance({
        loopId: 'loop-parent',
        conversationId: 'conv-parent',
        settingsReader: parentReader as never,
      }, 'scope-parent', null)).toEqual(expect.objectContaining({
        parentConversationId: 'conv-parent',
        parentLoopId: 'loop-parent',
        settingsReader: parentReader,
        authorizationScopeId: 'scope-parent',
      }));
      expect(getSubagentRunInheritance({
        loopId: 'loop-parent',
        conversationId: 'conv-parent',
        settingsReader: parentReader as never,
      }, 'scope-parent', null).workspaceReader?.getCurrentPath()).toBeNull();

      expect(getSubagentRunInheritance({
        loopId: 'loop-trigger-parent',
        conversationId: 'conv-trigger-parent',
        triggerId: 'trigger-1',
        scheduledTaskId: 'task-1',
      } as never)).toEqual(expect.objectContaining({
        triggerId: 'trigger-1',
        scheduledTaskId: 'task-1',
      }));

      expect(getSubagentRunInheritance({
        loopId: 'loop-im-parent',
        conversationId: 'conv-im-parent',
        settingsReader: parentReader as never,
        authorizationScopeId: 'scope-im',
        runPermissionCeiling: {
          version: 1,
          source: 'im',
          capability: 'safe_tools',
        },
        imReplyTarget: { platform: 'feishu', chatId: 'chat-trusted' },
      } as never, 'scope-im', '/srv/im-workspace')).toEqual(expect.objectContaining({
        imContext: {
          platform: 'feishu',
          replyChatId: 'chat-trusted',
          workspacePath: '/srv/im-workspace',
          capability: 'safe_tools',
        },
        parentLoopId: 'loop-im-parent',
      }));

      await runSubagent({ agent, task: 'do the thing', settingsReader: parentReader as never });

      const params = sidecarRequestMock.mock.calls[0][1] as {
        settingsSnapshot: unknown;
        resolvedCreds: unknown;
      };
      expect(params.settingsSnapshot).toBe(parentSettings);
      expect(params.resolvedCreds).toEqual({
        apiKey: 'parent-key',
        baseUrl: 'https://parent.test',
        forceOpenAiCompatible: false,
      });
    });

    it('falls back to runSubagentLoop when the dispatch-time projection fails (e.g. resolveEffectiveLlmCreds throws) — session never registered, sidecar never touched', async () => {
      getSidecarStatus.mockReturnValue('running');
      resolveEffectiveLlmCredsMock.mockImplementation(() => { throw new Error('EnterpriseLlmUnavailableError'); });
      const { runSubagent } = await importFresh();

      const result = await runSubagent({ agent, task: 'do the thing' });

      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(runSubagentLoopMock).toHaveBeenCalledTimes(1);
      expect(result.text).toBe('in-process result');
    });
  });

  describe('tool.invoke reverse-channel handler', () => {
    it('threads the ORIGINAL session callbacks (commandConfirmCallback/filePermissionCallback) into executeAnyTool', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const confirmCb = vi.fn().mockResolvedValue(true);
      const filePermCb = vi.fn().mockResolvedValue(true);
      const controller = new AbortController();
      const runPromise = runSubagent({
        agent,
        task: 'do the thing',
        signal: controller.signal,
        commandConfirmCallback: confirmCb,
        filePermissionCallback: filePermCb,
      });

      // Registration happened synchronously inside runSubagent() before it
      // awaited the (still-pending) sidecarRequest — the handler is
      // capturable immediately.
      expect(onSidecarRequest).toHaveBeenCalledWith('tool.invoke', expect.any(Function));
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;

      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const toolResult = await toolInvokeHandler({ runId, toolName: 'read_file', input: { path: 'x.txt' }, context: { workspacePath: '/forged' } });

      expect(toolResult).toBe('tool result');
      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'read_file',
        { path: 'x.txt' },
        confirmCb,
        filePermCb,
        expect.objectContaining({ workspacePath: '/tmp/workspace', abortSignal: controller.signal }),
      );

      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('overwrites a forged sidecar ceiling with the parent-owned subagent ceiling', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();
      const ceiling = { version: 1, source: 'trigger', capability: 'safe_tools' };

      const runPromise = runSubagent({
        agent,
        task: 'bounded work',
        runPermissionCeiling: ceiling as never,
      });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await toolInvokeHandler({
        runId,
        toolName: 'read_file',
        input: { path: 'x.txt' },
        context: { runPermissionCeiling: { version: 1, source: 'trigger', capability: 'full' } },
      });

      expect(executeAnyToolMock.mock.calls.at(-1)?.[4]).toEqual(
        expect.objectContaining({ runPermissionCeiling: ceiling }),
      );
      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('keeps a scope-only scheduled subagent background at the shell tool boundary', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const runPromise = runSubagent({
        agent,
        task: 'scheduled delegated work',
        authorizationScopeId: 'scope-scheduled',
      });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await toolInvokeHandler({
        runId,
        toolName: 'computer',
        input: { action: 'screenshot' },
        context: { interactionMode: 'foreground' },
      });

      expect(executeAnyToolMock.mock.calls.at(-1)?.[4]).toEqual(expect.objectContaining({
        authorizationScopeId: 'scope-scheduled',
        interactionMode: 'background',
      }));
      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('overwrites a forged IM reply target with the parent-owned subagent target', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const runPromise = runSubagent({
        agent,
        task: 'send the generated report',
        imContext: {
          platform: 'feishu',
          workspacePath: '/tmp/workspace',
          replyChatId: 'trusted-chat',
        },
      });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await toolInvokeHandler({
        runId,
        toolName: 'send_file',
        input: { path: '/tmp/report.pdf' },
        context: { imReplyTarget: { platform: 'feishu', chatId: 'attacker-chat' } },
      });

      expect(executeAnyToolMock.mock.calls.at(-1)?.[4]).toEqual(expect.objectContaining({
        imReplyTarget: { platform: 'feishu', chatId: 'trusted-chat' },
      }));
      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('installs a parent-owned skill command approval bridge for delegated tools', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();
      const ceiling = { version: 1, source: 'trigger', capability: 'full' };

      const runPromise = runSubagent({
        agent,
        task: 'use the build skill',
        authorizationScopeId: 'scope-real',
        runPermissionCeiling: ceiling as never,
      });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await toolInvokeHandler({
        runId,
        toolName: 'use_skill',
        input: { skill_name: 'build' },
        context: { authorizationScopeId: 'scope-forged' },
      });

      const trustedContext = executeAnyToolMock.mock.calls.at(-1)?.[4] as {
        skillCommandApproval?: (request: unknown) => Promise<unknown>;
      };
      expect(trustedContext.skillCommandApproval).toEqual(expect.any(Function));
      await trustedContext.skillCommandApproval?.({
        toolName: 'run_command',
        input: { command: 'git status', cwd: '/trusted/skill' },
        context: { authorizationScopeId: 'scope-forged-again' },
      });
      expect(checkToolApprovalMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
        authorizationScopeId: 'scope-real',
        runPermissionCeiling: ceiling,
      }));

      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('aborts the shell-side tool signal after a scoped sidecar subagent settles without sending a late subagent.abort', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();
      const parentController = new AbortController();

      const runPromise = runSubagent({
        agent,
        task: 'start a background command',
        signal: parentController.signal,
        authorizationScopeId: 'scope-subagent',
      });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      await toolInvokeHandler({
        runId,
        toolName: 'run_command',
        input: { command: 'start-background-worker', background: true, cwd: '/tmp' },
      });
      const toolContext = executeAnyToolMock.mock.calls[0][4] as { abortSignal?: AbortSignal };

      expect(toolContext.abortSignal?.aborted).toBe(false);
      expect(toolContext.abortSignal).not.toBe(parentController.signal);
      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;

      expect(toolContext.abortSignal?.aborted).toBe(true);
      expect(parentController.signal.aborted).toBe(false);
      expect(notifySidecar).not.toHaveBeenCalledWith('subagent.abort', expect.objectContaining({ runId }));
    });

    it('overwrites a forged sidecar workspace with null when the subagent session has no trusted workspace', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const runPromise = runSubagent({
        agent,
        task: 'do the thing',
        workspaceReader: { getCurrentPath: () => null },
      });

      expect(onSidecarRequest).toHaveBeenCalledWith('tool.invoke', expect.any(Function));
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      await toolInvokeHandler({ runId, toolName: 'run_command', input: { command: 'touch ok' }, context: { workspacePath: '/forged' } });

      expect(executeAnyToolMock).toHaveBeenCalledWith(
        'run_command',
        { command: 'touch ok' },
        undefined,
        undefined,
        expect.objectContaining({ workspacePath: null }),
      );

      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('an unknown runId (no matching session) throws instead of silently executing', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockReturnValue(new Promise(() => {})); // never settles
      const { runSubagent } = await importFresh();
      void runSubagent({ agent, task: 'do the thing' }); // fire-and-forget — just need registration to happen

      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;

      await expect(toolInvokeHandler({ runId: 'not-a-real-run', toolName: 'read_file', input: {} })).rejects.toThrow(/unknown runId/);
      expect(executeAnyToolMock).not.toHaveBeenCalled();
    });

    it('refuses a delegated tool call outside the inherited whitelist', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();
      const runPromise = runSubagent({ agent, task: 'read only', allowedTools: ['read_*'] });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await expect(
        toolInvokeHandler({ runId, toolName: 'write_file', input: { path: 'x' } }),
      ).rejects.toThrow(/not allowed/);
      expect(executeAnyToolMock).not.toHaveBeenCalled();

      d.resolve({ text: 'done', toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('refuses a delegated tool call matching inherited blockedTools even if the sidecar explicitly asks for it', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();
      const runPromise = runSubagent({ agent, task: 'read only', blockedTools: ['run_command', 'abu-browser__*'] });
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;

      await expect(
        toolInvokeHandler({ runId, toolName: 'abu-browser__screenshot', input: {} }),
      ).rejects.toThrow(/blocked/);
      expect(executeAnyToolMock).not.toHaveBeenCalled();

      d.resolve({ text: 'done', toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('run-session lifecycle: the session is removed once the run settles — a LATE tool.invoke for the same (finished) runId is rejected as unknown', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({ text: 'done', toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      const { runSubagent } = await importFresh();

      await runSubagent({ agent, task: 'do the thing' });
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;

      await expect(toolInvokeHandler({ runId, toolName: 'read_file', input: {} })).rejects.toThrow(/unknown runId/);
    });
  });

  describe('subagent.progress reverse-channel handler', () => {
    it('dispatches an incoming subagent.progress notification to the ORIGINAL session\'s onProgress callback', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const onProgress = vi.fn();
      const runPromise = runSubagent({ agent, task: 'do the thing', onProgress });

      expect(onSidecarNotification).toHaveBeenCalledWith('subagent.progress', expect.any(Function));
      const progressHandler = onSidecarNotification.mock.calls.find((c) => c[0] === 'subagent.progress')![1] as (p: unknown) => void;

      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const event = { type: 'tool-end', id: 't1', toolName: 'read_file', result: 'contents', error: false };
      progressHandler({ runId, event });

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(event);

      d.resolve({ text: 'done', toolCallCount: 1, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      await runPromise;
    });

    it('an unknown runId is silently dropped — no throw, no callback invocation', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockReturnValue(new Promise(() => {})); // never settles
      const { runSubagent } = await importFresh();

      const onProgress = vi.fn();
      void runSubagent({ agent, task: 'do the thing', onProgress }); // registers handlers; runId won't match below

      const progressHandler = onSidecarNotification.mock.calls.find((c) => c[0] === 'subagent.progress')![1] as (p: unknown) => void;

      expect(() => progressHandler({ runId: 'not-a-real-run', event: { type: 'turn-complete', turn: 1, totalTurns: 200 } })).not.toThrow();
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('malformed params (missing runId/event) are silently dropped', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockReturnValue(new Promise(() => {}));
      const { runSubagent } = await importFresh();

      const onProgress = vi.fn();
      void runSubagent({ agent, task: 'do the thing', onProgress });

      const progressHandler = onSidecarNotification.mock.calls.find((c) => c[0] === 'subagent.progress')![1] as (p: unknown) => void;

      expect(() => progressHandler(null)).not.toThrow();
      expect(() => progressHandler({})).not.toThrow();
      expect(() => progressHandler({ runId: 123, event: {} })).not.toThrow();
      expect(onProgress).not.toHaveBeenCalled();
    });
  });

  describe('fallback discipline', () => {
    it('a transport failure BEFORE any tool.invoke arrived falls back to runSubagentLoop', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockRejectedValue(new Error('Sidecar process closed'));
      const { runSubagent } = await importFresh();

      const result = await runSubagent({ agent, task: 'do the thing' });

      expect(runSubagentLoopMock).toHaveBeenCalledTimes(1);
      expect(result.text).toBe('in-process result');
    });

    it('a transport failure AFTER ≥1 tool.invoke arrived surfaces an error SubagentResult — NO rerun', async () => {
      getSidecarStatus.mockReturnValue('running');
      const d = deferred<unknown>();
      sidecarRequestMock.mockReturnValue(d.promise);
      const { runSubagent } = await importFresh();

      const runPromise = runSubagent({ agent, task: 'do the thing' });
      const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
      const toolInvokeHandler = onSidecarRequest.mock.calls.find((c) => c[0] === 'tool.invoke')![1] as (p: unknown) => Promise<unknown>;
      await toolInvokeHandler({ runId, toolName: 'read_file', input: {} }); // marks firstToolInvokeArrived

      d.reject(new Error('sidecar crashed mid-run'));
      const result = await runPromise;

      expect(runSubagentLoopMock).not.toHaveBeenCalled();
      expect(result.text).toContain('sidecar crashed mid-run');
      expect(result.toolCallCount).toBe(0);
      expect(result.turnCount).toBe(0);
    });
  });

  describe('abort', () => {
    it('sends a subagent.abort notification when the caller aborts, and arms a grace timer', async () => {
      vi.useFakeTimers();
      try {
        getSidecarStatus.mockReturnValue('running');
        sidecarRequestMock.mockReturnValue(new Promise(() => {})); // never settles on its own
        const { runSubagent } = await importFresh();

        const controller = new AbortController();
        const runPromise = runSubagent({ agent, task: 'do the thing', signal: controller.signal });
        // Let buildSubagentRunParams/sidecarRequest dispatch happen (microtask).
        await Promise.resolve();

        controller.abort();
        await Promise.resolve();

        const runId = (sidecarRequestMock.mock.calls[0][1] as { runId: string }).runId;
        expect(notifySidecar).toHaveBeenCalledWith('subagent.abort', { runId });

        // Grace period (5s) elapses with the sidecar never responding. This is
        // still a user cancellation, never a transport retry.
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await runPromise;

        expect(runSubagentLoopMock).not.toHaveBeenCalled();
        expect(result.text).toContain('任务已取消');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not dispatch or fall back when the caller signal is already aborted', async () => {
      getSidecarStatus.mockReturnValue('running');
      const { runSubagent } = await importFresh();
      const controller = new AbortController();
      controller.abort();

      const result = await runSubagent({
        agent,
        task: 'do not resurrect this task',
        signal: controller.signal,
      });

      expect(sidecarRequestMock).not.toHaveBeenCalled();
      expect(runSubagentLoopMock).not.toHaveBeenCalled();
      expect(result.text).toContain('任务已取消');
    });

    it('does not detach a scoped subagent owner after the abort grace period', async () => {
      vi.useFakeTimers();
      try {
        getSidecarStatus.mockReturnValue('running');
        const request = deferred<unknown>();
        sidecarRequestMock.mockReturnValue(request.promise);
        const { runSubagent } = await importFresh();
        const controller = new AbortController();
        let settled = false;

        const runPromise = runSubagent({
          agent,
          task: 'scoped delegated work',
          signal: controller.signal,
          authorizationScopeId: 'scope-parent',
        }).then((result) => {
          settled = true;
          return result;
        });
        await Promise.resolve();
        controller.abort();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(settled).toBe(false);
        request.resolve({
          text: 'cancelled after resources settled',
          toolCallCount: 0,
          turnCount: 0,
          tokenUsage: { input: 0, output: 0 },
          duration: 0,
        });
        await runPromise;
        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('handler registration', () => {
    it('registers tool.invoke/hook.emit/hook.notify/subagent.progress handlers exactly once, no matter how many runs are dispatched', async () => {
      getSidecarStatus.mockReturnValue('running');
      sidecarRequestMock.mockResolvedValue({ text: 'ok', toolCallCount: 0, turnCount: 1, tokenUsage: { input: 0, output: 0 }, duration: 1 });
      const { runSubagent } = await importFresh();

      await runSubagent({ agent, task: 'first' });
      await runSubagent({ agent, task: 'second' });
      await runSubagent({ agent, task: 'third' });

      expect(onSidecarRequest.mock.calls.filter((c) => c[0] === 'tool.invoke')).toHaveLength(1);
      expect(onSidecarRequest.mock.calls.filter((c) => c[0] === 'hook.emit')).toHaveLength(1);
      expect(onSidecarNotification.mock.calls.filter((c) => c[0] === 'hook.notify')).toHaveLength(1);
      expect(onSidecarNotification.mock.calls.filter((c) => c[0] === 'subagent.progress')).toHaveLength(1);
    });
  });
});
