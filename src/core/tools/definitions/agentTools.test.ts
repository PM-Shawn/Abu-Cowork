import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useChatStore } from '../../../stores/chatStore';
import { saveAgentTool, delegateToAgentTool, useSkillTool } from './agentTools';
import { getLanguageSetting, setLanguage } from '@/i18n';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkwwAAAABJRU5ErkJggg==';
const materializeDelegatedUserTurnMock = vi.hoisted(() => vi.fn());

// Mock dependencies not covered by global setup
vi.mock('../../skill/loader', () => ({
  skillLoader: { getSkill: vi.fn(), getAvailableSkills: vi.fn().mockReturnValue([]), loadSkill: vi.fn(), refreshSkill: vi.fn() },
}));
vi.mock('../../agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), listAgents: vi.fn().mockReturnValue([]) },
}));
vi.mock('../../agent/permissionBridge', () => {
  const getCurrentLoopContext = vi.fn(() => ({
    loopId: 'loop-1',
    conversationId: 'conv-1',
    toolCallToStepId: new Map(),
    eventRouter: {
      getCurrentStepId: () => undefined,
      addChildStepToDelegate: () => undefined,
      completeChildStep: () => undefined,
    },
  }));
  return {
    getCurrentLoopContext,
    getLoopContext: vi.fn(() => getCurrentLoopContext()),
    requestWorkspace: vi.fn(),
  };
});
vi.mock('../../agent/subagentLoop', () => ({
  buildSubagentMcpPreflightFailure: vi.fn().mockReturnValue(null),
  runSubagentLoop: vi.fn(),
  extractParentConversationSummary: vi.fn().mockReturnValue(''),
}));
vi.mock('../../agent/subagentAbort', () => ({
  createSubagentController: vi.fn(),
}));
vi.mock('../../subagent/delegatedUserTurnMaterializer', () => ({
  materializeDelegatedUserTurn: (...args: unknown[]) => materializeDelegatedUserTurnMock(...args),
}));
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: vi.fn().mockReturnValue({
      activeConversationId: 'test',
      conversations: { test: { messages: [] } },
      getActiveConversation: vi.fn(),
      setAgentStatus: vi.fn(),
      addActiveAgent: vi.fn(),
      removeActiveAgent: vi.fn(),
    }),
  },
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: vi.fn().mockReturnValue({ disabledSkills: [] }) },
}));
vi.mock('../../../stores/discoveryStore', () => ({
  useDiscoveryStore: { getState: vi.fn().mockReturnValue({ refresh: vi.fn() }) },
}));
vi.mock('../../../utils/pathUtils', () => ({
  joinPath: (...parts: string[]) => parts.join('/'),
  ensureParentDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/validation', () => ({
  ITEM_NAME_RE: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  AGENT_NAME_RE: /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u,
}));
vi.mock('../helpers/toolHelpers', () => ({
  getSystemInfoData: vi.fn().mockResolvedValue({ home: '/Users/testuser' }),
}));
vi.mock('../../agent/ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => ({ disabledAgents: [], disabledSkills: [] }) }),
}));

const findMissingExpectedFilesMock = vi.fn(async (_files: readonly string[], _ws: string | null | undefined): Promise<string[]> => []);
vi.mock('../../team/expectedFiles', async () => {
  const actual = await vi.importActual<typeof import('../../team/expectedFiles')>('../../team/expectedFiles');
  return { ...actual, findMissingExpectedFiles: (files: readonly string[], ws: string | null | undefined) => findMissingExpectedFilesMock(files, ws) };
});

describe('delegateToAgentTool', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getCurrentLoopContext, getLoopContext } = await import('../../agent/permissionBridge');
    vi.mocked(getLoopContext).mockImplementation(() => getCurrentLoopContext());
    materializeDelegatedUserTurnMock.mockResolvedValue(Object.freeze({
      schemaVersion: 1,
      origin: Object.freeze({ conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' }),
      content: Object.freeze([Object.freeze({ type: 'text', text: 'source turn' })]),
    }));
  });

  it('describes the fixed tool boundaries of built-in role presets', () => {
    const type = delegateToAgentTool.inputSchema.properties.type as { description: string };
    expect(type.description).toContain('research (lookup-focused: file reads, search, web and general HTTP requests)');
    expect(type.description).toContain('writer (content authoring: read/write/edit files plus web search)');
    expect(type.description).toContain('executor (full toolset — includes browser, image and MCP tools, except nested delegation and user prompts)');
  });

  it('keeps the trusted shell-only media fallback out of the delegation tool schema', () => {
    expect(delegateToAgentTool.inputSchema.properties).not.toHaveProperty('delegatedMediaFallback');
  });

  it('is explicitly marked concurrency-safe — a fan-out of independent sub-agent delegations must stay parallel, not silently fall back to the fail-closed default', () => {
    expect(delegateToAgentTool.isConcurrencySafe).toBe(true);
  });

  // A run-scoped restriction that stops at the delegation boundary is not a
  // restriction. `allowedTools` was forwarded here; `blockedTools` was not,
  // so an unattended tier that had removed a tool from its own roster got it
  // back by delegating. Asserted on the call to runSubagent, because the
  // regression this guards against is a call site forgetting to forward.
  it('forwards BOTH run-scoped tool restrictions into the delegated run', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher',
      description: 'test',
      systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'done', stopReason: 'completed' } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      allowedTools: ['read_file'],
      blockedTools: ['request_workspace', 'abu-browser__*'],
      imContext: { platform: 'dchat', workspacePath: '/im/workspace' },
      toolCallToStepId: new Map(),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      eventRouter: {
        getCurrentStepId: () => undefined,
        addChildStepToDelegate: () => undefined,
        completeChildStep: () => undefined,
      },
    } as never);

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'look something up' },
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
    );

    expect(vi.mocked(runSubagentLoop)).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ['read_file'],
        blockedTools: ['request_workspace', 'abu-browser__*'],
        imContext: { platform: 'dchat', workspacePath: '/im/workspace' },
        persistParentToolImages: true,
      }),
    );
  });

  // The parent run's consecutive-browser-denial guard is a run-scoped
  // restriction like the two above: a run that delegates its browser work must
  // not be able to be refused forever without ever tripping it.
  it('forwards the parent run\'s browser-denial reporters into the delegated run', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    const reportBrowserDenial = vi.fn();
    const reportBrowserAllow = vi.fn();

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher',
      description: 'test',
      systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'done', stopReason: 'completed' } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      reportBrowserDenial,
      reportBrowserAllow,
      eventRouter: {
        getCurrentStepId: () => undefined,
        addChildStepToDelegate: () => undefined,
        completeChildStep: () => undefined,
      },
    } as never);

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'look something up' },
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
    );

    expect(vi.mocked(runSubagentLoop)).toHaveBeenCalledWith(
      expect.objectContaining({ reportBrowserDenial, reportBrowserAllow }),
    );
  });

  it('hands the triggering multimodal user turn to delegate_to_agent', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');
    const parentUserMessage = {
      id: 'user-1', role: 'user' as const, loopId: 'loop-1', timestamp: 0,
      content: [
        { type: 'text' as const, text: 'Inspect this image.' },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: TINY_PNG_BASE64 } },
        { type: 'text' as const, text: 'Keep this ordering.' },
      ],
    };

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    const materializeSignal = new AbortController().signal;
    vi.mocked(createSubagentController).mockReturnValue({ signal: materializeSignal, cleanup: vi.fn() } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'done', stopReason: 'completed' } as never);
    vi.mocked(useChatStore.getState).mockReturnValue({
      activeConversationId: 'conv-1',
      conversations: { 'conv-1': { messages: [parentUserMessage] } },
      getActiveConversation: vi.fn(), setAgentStatus: vi.fn(), addActiveAgent: vi.fn(), removeActiveAgent: vi.fn(),
    } as never);
    vi.mocked(getLoopContext).mockReturnValue({
      loopId: 'loop-1',
      conversationId: 'conv-1',
      toolCallToStepId: new Map(),
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    const delegatedUserTurn = Object.freeze({
      schemaVersion: 1,
      origin: Object.freeze({ conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' }),
      content: Object.freeze([Object.freeze({ type: 'text', text: 'Inspect this image.' })]),
    });
    materializeDelegatedUserTurnMock.mockResolvedValueOnce(delegatedUserTurn);

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'Describe the image.', messageId: 'attacker-chosen', path: '/Users/attacker/private.png' },
      { conversationId: 'conv-1', loopId: 'loop-1', toolCallId: 'delegate-1' } as never,
    );

    const childOptions = vi.mocked(runSubagentLoop).mock.calls.at(-1)?.[0] as unknown as { delegatedUserTurn?: unknown };
    expect(materializeDelegatedUserTurnMock).toHaveBeenCalledTimes(1);
    expect(materializeDelegatedUserTurnMock).toHaveBeenCalledWith({ conversationId: 'conv-1', loopId: 'loop-1', signal: materializeSignal });
    expect(childOptions.delegatedUserTurn).toBe(delegatedUserTurn);
  });

  it('does not start a child when the trusted delegate signal aborts during materialization', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');
    const controller = new AbortController();
    controller.abort();
    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: controller.signal, cleanup: vi.fn() } as never);
    materializeDelegatedUserTurnMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      if (signal?.aborted) throw new Error('aborted');
      throw new Error('expected aborted signal');
    });

    await expect(delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'stop' },
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
    )).rejects.toThrow(/aborted/);
    expect(runSubagentLoop).not.toHaveBeenCalled();
  });

  it('fails closed instead of binding a delegate to an unspecified or mismatched loop', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getLoopContext } = await import('../../agent/permissionBridge');
    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(getLoopContext).mockReturnValue({
      loopId: 'trusted-loop',
      conversationId: 'trusted-conversation',
      toolCallToStepId: new Map(),
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);

    await expect(delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'do not bind this' },
      { conversationId: 'trusted-conversation' } as never,
    )).rejects.toThrow(/trusted loop context/);
    await expect(delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'do not bind this' },
      { conversationId: 'untrusted-conversation', loopId: 'trusted-loop' } as never,
    )).rejects.toThrow(/trusted loop context/);
    expect(materializeDelegatedUserTurnMock).not.toHaveBeenCalled();
  });

  // The child-step visualization seam: tool-start must stamp the subagent's
  // tool_use id onto the child step (snapshot backfill joins on it), and
  // tool-end must forward the raw resultContent (image rendering). A wiring
  // that drops either regresses subagent screenshots to invisible.
  it('threads toolCallId and resultContent through the child-step progress wiring', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher', description: 'test', systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);

    const addChildStepToDelegate = vi.fn().mockReturnValue('child-step-1');
    const completeChildStep = vi.fn();
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map([['toolu_delegate', 'parent-step-1']]),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      eventRouter: {
        getCurrentStepId: () => 'parent-step-1',
        addChildStepToDelegate,
        completeChildStep,
      },
    } as never);

    const imageContent = [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } },
    ];
    vi.mocked(runSubagentLoop).mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
      options.onProgress?.({ type: 'tool-start', id: 'toolu_sub_1', toolName: 'computer', toolInput: { action: 'screenshot' } });
      options.onProgress?.({ type: 'tool-end', id: 'toolu_sub_1', toolName: 'computer', result: 'shot', error: false, resultContent: imageContent });
      return { text: 'done', stopReason: 'completed' } as never;
    });

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'screenshot the page' },
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
    );

    expect(addChildStepToDelegate).toHaveBeenCalledWith(
      'loop-1',
      'parent-step-1',
      {
        toolName: 'computer',
        toolInput: { action: 'screenshot' },
        toolCallId: expect.stringMatching(/^subagent-v1:sar-.*:toolu_sub_1$/),
      },
    );
    expect(completeChildStep).toHaveBeenCalledWith(
      'loop-1',
      'parent-step-1',
      'child-step-1',
      'shot',
      false,
      imageContent,
    );
  });

  it('forgets a completed child id so a duplicate tool-end cannot complete it twice', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher', description: 'test', systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);
    const completeChildStep = vi.fn();
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map([['delegate', 'parent-step']]),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      eventRouter: {
        getCurrentStepId: () => 'parent-step',
        addChildStepToDelegate: () => 'child-step',
        completeChildStep,
      },
    } as never);
    vi.mocked(runSubagentLoop).mockImplementation(async (options: { onProgress?: (e: unknown) => void }) => {
      options.onProgress?.({ type: 'tool-start', id: 'call_1', toolName: 'read_file', toolInput: {} });
      options.onProgress?.({ type: 'tool-end', id: 'call_1', toolName: 'read_file', result: 'first', error: false });
      options.onProgress?.({ type: 'tool-end', id: 'call_1', toolName: 'read_file', result: 'duplicate', error: false });
      return { text: 'done', stopReason: 'completed' } as never;
    });

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'read it' },
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
    );

    expect(completeChildStep).toHaveBeenCalledOnce();
  });

  it('reports structured subagentStopReason through trusted tool metadata', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher', description: 'test', systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      eventRouter: {
        getCurrentStepId: () => undefined,
        addChildStepToDelegate: () => undefined,
        completeChildStep: () => undefined,
      },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'partial result', stopReason: 'max_turns' } as never);
    const reportMetadata = vi.fn();

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'try hard' },
      { conversationId: 'conv-1', loopId: 'loop-1', reportMetadata } as never,
    );

    expect(reportMetadata).toHaveBeenCalledWith({ subagentStopReason: 'max_turns' });
  });

  it('appends the instructions the user sent the member mid-run to the hand-off result', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');
    const { noteDeliveredInstruction } = await import('../../agent/dispatchInput');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: new AbortController().signal, cleanup: vi.fn() } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(), loopId: 'loop-notes', conversationId: 'conv-1',
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: '默认结束', stopReason: 'completed', toolCallCount: 2 } as never);
    noteDeliveredInstruction('tc-notes:0', '只看 Q3');

    const text = String(await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'go' },
      { conversationId: 'conv-1', loopId: 'loop-notes', toolCallId: 'tc-notes', teamRoster: ['researcher'] } as never,
    ));
    expect(text).toContain('默认结束');
    expect(text).toContain('- 只看 Q3');
    expect(text).toContain('researcher');
    // Taken once: a second hand-off under the same key starts clean.
    const again = String(await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'go' },
      { conversationId: 'conv-1', loopId: 'loop-notes', toolCallId: 'tc-notes', teamRoster: ['researcher'] } as never,
    ));
    expect(again).not.toContain('只看 Q3');
  });

  // A member that stopped mid-task must not read as a finished one. The
  // stop reason used to travel only in `reportMetadata`, which has no carrier
  // on OpenAI-compatible providers — so the leader saw a plain, confident
  // answer and took the work over itself. It now also lands in the body text.
  it('appends the stop reason to the hand-off body when the member did not finish', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: new AbortController().signal, cleanup: vi.fn() } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(), loopId: 'loop-stop', conversationId: 'conv-1',
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: '做到一半', stopReason: 'max_turns', toolCallCount: 3 } as never);

    const previous = getLanguageSetting();
    setLanguage('zh-CN');
    try {
      const text = String(await delegateToAgentTool.execute(
        { agent_name: 'researcher', task: 'go' },
        { conversationId: 'conv-1', loopId: 'loop-stop', teamRoster: ['researcher'] } as never,
      ));
      expect(text).toContain('做到一半');
      expect(text).toContain('轮数用尽');
      expect(text).toContain('未完成');
    } finally {
      setLanguage(previous);
    }
  });

  it('says nothing extra when the member finished normally', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: new AbortController().signal, cleanup: vi.fn() } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(), loopId: 'loop-stop-ok', conversationId: 'conv-1',
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: '全部做完', stopReason: 'completed', toolCallCount: 3 } as never);

    const text = String(await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'go' },
      { conversationId: 'conv-1', loopId: 'loop-stop-ok', teamRoster: ['researcher'] } as never,
    ));
    expect(text).toBe('全部做完');
  });

  it('fails the hand-off when a declared expected file is missing, whatever the member said', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');
    const { clearRunBounds, getRunBounds } = await import('../../team/teamRunBounds');
    clearRunBounds('loop-files');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'writer1', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: new AbortController().signal, cleanup: vi.fn() } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(), loopId: 'loop-files', conversationId: 'conv-1',
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: '报告已写好', stopReason: 'completed', toolCallCount: 2 } as never);
    findMissingExpectedFilesMock.mockResolvedValueOnce(['/ws/writer1/report.md']);
    const reportMetadata = vi.fn();
    const ctx = { conversationId: 'conv-1', loopId: 'loop-files', teamRoster: ['writer1'], workspacePath: '/ws', reportMetadata } as never;

    await expect(delegateToAgentTool.execute({ agent_name: 'writer1', task: 'write', expected_files: ['writer1/report.md'] }, ctx))
      .rejects.toThrow(/report\.md/);
    expect(findMissingExpectedFilesMock).toHaveBeenCalledWith(['writer1/report.md'], '/ws');
    expect(reportMetadata).toHaveBeenCalledWith({ subagentStopReason: 'error' });
    expect(getRunBounds('loop-files').consecutiveFailures.writer1).toBe(1);

    // Present → ordinary success, streak reset.
    const text = await delegateToAgentTool.execute({ agent_name: 'writer1', task: 'write', expected_files: ['writer1/report.md'] }, ctx);
    expect(String(text)).toContain('报告已写好');
    expect(getRunBounds('loop-files').consecutiveFailures.writer1).toBeUndefined();
    clearRunBounds('loop-files');
  });

  it('blocks a team member after three failed hand-offs in a row (code-enforced bound)', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');
    const { clearRunBounds } = await import('../../team/teamRunBounds');
    clearRunBounds('loop-bounds');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({ name: 'researcher', description: 'test', systemPrompt: 'test' } as never);
    vi.mocked(createSubagentController).mockReturnValue({ signal: new AbortController().signal, cleanup: vi.fn() } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      toolCallToStepId: new Map(), loopId: 'loop-bounds', conversationId: 'conv-1',
      eventRouter: { getCurrentStepId: () => undefined, addChildStepToDelegate: () => undefined, completeChildStep: () => undefined },
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'gave up', stopReason: 'error', toolCallCount: 1 } as never);
    const ctx = { conversationId: 'conv-1', loopId: 'loop-bounds', teamRoster: ['researcher'] } as never;

    for (let i = 0; i < 3; i++) {
      const text = await delegateToAgentTool.execute({ agent_name: 'researcher', task: 'try' }, ctx);
      expect(String(text)).toContain('gave up');
    }
    const refused = String(await delegateToAgentTool.execute({ agent_name: 'researcher', task: 'try again' }, ctx));
    expect(refused).toMatch(/failed 3 hand-offs in a row|连续 3 次/);
    expect(refused).toContain('researcher');
    expect(vi.mocked(runSubagentLoop)).toHaveBeenCalledTimes(3);

    // Outside a team the bound does not apply.
    const plain = await delegateToAgentTool.execute({ agent_name: 'researcher', task: 'try' }, { conversationId: 'conv-1', loopId: 'loop-bounds' } as never);
    expect(String(plain)).toContain('gave up');
    clearRunBounds('loop-bounds');
  });

  it('prefers the shell-owned tool execution authorization scope for nested delegation', async () => {
    const { agentRegistry } = await import('../../agent/registry');
    const { getCurrentLoopContext } = await import('../../agent/permissionBridge');
    const { createSubagentController } = await import('../../agent/subagentAbort');
    const { runSubagentLoop } = await import('../../agent/subagentLoop');

    vi.mocked(agentRegistry.getAgent).mockReturnValue({
      name: 'researcher',
      description: 'test',
      systemPrompt: 'test',
    } as never);
    vi.mocked(createSubagentController).mockReturnValue({
      signal: new AbortController().signal,
      cleanup: vi.fn(),
    } as never);
    vi.mocked(runSubagentLoop).mockResolvedValue({ text: 'done', stopReason: 'completed' } as never);
    vi.mocked(getCurrentLoopContext).mockReturnValue({
      authorizationScopeId: undefined,
      allowedTools: ['read_file'],
      blockedTools: [],
      toolCallToStepId: new Map(),
      loopId: 'loop-1',
      conversationId: 'conv-1',
      eventRouter: {
        getCurrentStepId: () => undefined,
        addChildStepToDelegate: () => undefined,
        completeChildStep: () => undefined,
      },
    } as never);

    await delegateToAgentTool.execute(
      { agent_name: 'researcher', task: 'look something up' },
      {
        conversationId: 'conv-1',
        loopId: 'loop-1',
        authorizationScopeId: 'scope-from-tool-context',
        workspacePath: null,
      } as never,
    );

    expect(vi.mocked(runSubagentLoop)).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationScopeId: 'scope-from-tool-context',
        workspaceReader: expect.any(Object),
      }),
    );
    const call = vi.mocked(runSubagentLoop).mock.calls.at(-1)?.[0] as { workspaceReader?: { getCurrentPath: () => string | null } };
    expect(call.workspaceReader?.getCurrentPath()).toBeNull();
  });
});

// save_skill was deprecated — skill creation/modification now goes through
// skill_manage (see skillManageTool.test.ts). save_agent tests continue below.
describe('save_agent multi-file support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('save_agent', () => {
    it('should save AGENT.md + supporting files', async () => {
      const result = await saveAgentTool.execute({
        name: 'my-agent',
        content: '---\nname: my-agent\n---\n# My Agent',
        files: [
          { path: 'scripts/helper.py', content: 'print("hello")' },
        ],
      });

      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/agents/my-agent/AGENT.md',
        expect.any(String),
      );
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/agents/my-agent/scripts/helper.py',
        'print("hello")',
      );
      expect(result).toContain('Attached files');
      expect(result).toContain('scripts/helper.py');
    });
  });
});

// "帮我优化这个专家": the model rewrites the whole AGENT.md. Its content must not
// be able to drop the agent's identity (role-id is what team memberships point
// at, created drives the newest-first sort) nor invent one.
describe('save_agent identity', () => {
  const AGENT_PATH = '/Users/testuser/.abu/agents/reviewer/AGENT.md';
  const NOW = 1757570400000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(readTextFile).mockResolvedValue('');
  });

  function writtenAgentMd(): string {
    const call = vi.mocked(writeTextFile).mock.calls.find(([path]) => path === AGENT_PATH);
    expect(call).toBeDefined();
    return String(call?.[1]);
  }

  it('keeps an existing agent\'s role-id and created stamp when the model rewrites it', async () => {
    vi.mocked(exists).mockImplementation(async (path) => path === AGENT_PATH);
    vi.mocked(readTextFile).mockResolvedValue(
      '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ndescription: Reviews code\n---\n\nYou review code.',
    );

    await saveAgentTool.execute({
      name: 'reviewer',
      content: '---\nname: reviewer\nrole-id: role-other\ndescription: Reviews code thoroughly\n---\n\nYou review code carefully.',
    });

    expect(readTextFile).toHaveBeenCalledWith(AGENT_PATH);
    const md = writtenAgentMd();
    expect(md).toMatch(/^role-id: role-abc123$/m);
    expect(md).toMatch(/^created: 1700000000000$/m);
    expect(md).not.toContain('role-other');
    expect(md).toContain('description: Reviews code thoroughly');
    expect(md).toContain('You review code carefully.');
  });

  it('stamps a new agent with its creation time and drops a role-id the model invented', async () => {
    await saveAgentTool.execute({
      name: 'reviewer',
      content: '---\nname: reviewer\nrole-id: role-made-up\ndescription: Reviews code\n---\n\nYou review code.',
    });

    expect(readTextFile).not.toHaveBeenCalled();
    const md = writtenAgentMd();
    expect(md).toMatch(new RegExp(`^created: ${NOW}$`, 'm'));
    expect(md).not.toMatch(/role-id:/);
  });

  it('leaves a legacy agent (no created stamp) unstamped even if the model writes one', async () => {
    vi.mocked(exists).mockImplementation(async (path) => path === AGENT_PATH);
    vi.mocked(readTextFile).mockResolvedValue('---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.');

    await saveAgentTool.execute({
      name: 'reviewer',
      content: `---\nname: reviewer\ncreated: ${NOW}\ndescription: Reviews code\n---\n\nYou review code.`,
    });

    expect(writtenAgentMd()).not.toMatch(/created:/);
  });
});


it('does not auto-enable a child skill when runtime resolution refuses it', async () => {
  const { useSettingsStore } = await import('@/stores/settingsStore');
  const { skillLoader } = await import('@/core/skill/loader');
  const toggleSkillEnabled = vi.fn();
  vi.mocked(useSettingsStore.getState).mockReturnValue({ disabledSkills: ['closed-skill'], toggleSkillEnabled } as unknown as ReturnType<typeof useSettingsStore.getState>);
  vi.mocked(skillLoader.getSkill).mockReturnValue(undefined);
  const result = await useSkillTool.execute({ skill_name: 'closed-skill' });
  expect(result).toContain('not found');
  expect(toggleSkillEnabled).not.toHaveBeenCalled();
});
