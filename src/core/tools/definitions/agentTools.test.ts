import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useChatStore } from '../../../stores/chatStore';
import { saveAgentTool, delegateToAgentTool } from './agentTools';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkwwAAAABJRU5ErkJggg==';
const materializeDelegatedUserTurnMock = vi.hoisted(() => vi.fn());

// Mock dependencies not covered by global setup
vi.mock('../../skill/loader', () => ({
  skillLoader: { getSkill: vi.fn(), loadSkill: vi.fn(), refreshSkill: vi.fn() },
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
}));
vi.mock('../helpers/toolHelpers', () => ({
  getSystemInfoData: vi.fn().mockResolvedValue({ home: '/Users/testuser' }),
}));
vi.mock('../../agent/ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => ({ disabledAgents: [], disabledSkills: [] }) }),
}));

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
