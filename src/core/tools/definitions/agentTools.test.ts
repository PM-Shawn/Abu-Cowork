import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useChatStore } from '../../../stores/chatStore';
import { ensureParentDir } from '../../../utils/pathUtils';
import { agentRegistry, parseAgentFile } from '../../agent/registry';
import { skillLoader } from '../../skill/loader';
import { saveAgentTool, delegateToAgentTool, useSkillTool, createSaveItemTool } from './agentTools';
import { format, getI18n, getLanguageSetting, setLanguage } from '@/i18n';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkwwAAAABJRU5ErkJggg==';
const materializeDelegatedUserTurnMock = vi.hoisted(() => vi.fn());

// Mock dependencies not covered by global setup
vi.mock('../../skill/loader', async () => {
  // save_skill checks a SKILL.md's name with the loader's own reader.
  const actual = await vi.importActual<typeof import('../../skill/loader')>('../../skill/loader');
  return {
    parseSkillFile: actual.parseSkillFile,
    skillLoader: { getSkill: vi.fn(), getAvailableSkills: vi.fn().mockReturnValue([]), loadSkill: vi.fn(), refreshSkill: vi.fn(), isBlockedByPolicy: vi.fn().mockReturnValue(false) },
  };
});
vi.mock('../../agent/registry', async () => {
  // save_agent verifies what it writes with the registry's own reader, so the
  // real parseAgentFile stays; only the registry singleton is stubbed.
  const actual = await vi.importActual<typeof import('../../agent/registry')>('../../agent/registry');
  return {
    parseAgentFile: actual.parseAgentFile,
    getBuiltinAgentNames: actual.getBuiltinAgentNames,
    agentRegistry: { getAgent: vi.fn(), listAgents: vi.fn().mockReturnValue([]), getAvailableAgents: vi.fn().mockReturnValue([]) },
  };
});
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
  getParentDir: (path: string) => path.slice(0, path.lastIndexOf('/')),
  ensureParentDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/validation', async () => ({
  ITEM_NAME_RE: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  AGENT_NAME_RE: /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u,
  isItemNameTaken: (await vi.importActual<typeof import('../../../utils/validation')>('../../../utils/validation')).isItemNameTaken,
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
    it.each([
      'tools: read_file, write_file',
      'tools: null',
      'tools:\n  - read_file\n  - 42',
      'tools:\n  - " "',
      'disallowed-tools: run_command',
      'disallowed-tools:\n  - false',
    ])('rejects unusable tool metadata before writing or refreshing: %s', async (declaration) => {
      const { useDiscoveryStore } = await import('../../../stores/discoveryStore');
      const result = await saveAgentTool.execute({
        name: 'my-agent',
        content: `---\nname: my-agent\n${declaration}\n---\nHelp with a task.`,
        files: [{ path: 'notes.md', content: 'must not be written' }],
      });
      expect(result).toMatch(/^Error:/);
      expect(result).toContain(declaration.startsWith('tools:') ? 'tools' : 'disallowed-tools');
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(useDiscoveryStore.getState().refresh).not.toHaveBeenCalled();
    });

    it('rejects an unparseable agent before touching files', async () => {
      const result = await saveAgentTool.execute({ name: 'my-agent', content: '# Missing frontmatter' });
      expect(result).toMatch(/^Error:/);
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it('preserves valid tool restrictions and optional display fields exactly', async () => {
      const content = '---\nname: my-agent\nintro: Hello\nexpertise: [Planning]\nsample-prompts: [Plan a task]\navatar: icon:code/blue\ntools: [read_file]\ndisallowed-tools: [run_command]\n---\nHelp with a task.';
      const result = await saveAgentTool.execute({ name: 'my-agent', content });
      expect(result).not.toMatch(/^Error:/);
      const written = vi.mocked(writeTextFile).mock.calls.find(([path]) => path === '/Users/testuser/.abu/agents/my-agent/AGENT.md');
      // save_agent stamps `created:` as the last frontmatter line (it owns the
      // agent's identity); every other line the model wrote survives verbatim.
      expect(String(written?.[1]).replace(/^created: \d+\n/m, '')).toBe(content);
    });

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
        { createNew: true },
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
// at, created drives the newest-first sort) nor invent one. Every assertion
// reads the written file back with the registry's own parser — the only
// reading that decides which identity the agent has.
describe('save_agent identity', () => {
  const AGENT_PATH = '/Users/testuser/.abu/agents/reviewer/AGENT.md';
  const NOW = 1757570400000;
  const EXISTING = { roleId: 'role-abc123', createdAt: 1700000000000 };
  const EXISTING_MD = '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ndescription: Reviews code\n---\n\nYou review code.';

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

  function givenExistingFile(raw: string): void {
    vi.mocked(exists).mockImplementation(async (path) => path === AGENT_PATH);
    vi.mocked(readTextFile).mockResolvedValue(raw);
  }

  // These are modify flows ("帮我优化这个专家"), so they pass overwrite.
  function save(content: string, files?: Array<{ path: string; content: string }>) {
    return saveAgentTool.execute({ name: 'reviewer', content, overwrite: true, ...(files ? { files } : {}) });
  }

  function writtenAgentMd(): string {
    const call = vi.mocked(writeTextFile).mock.calls.find(([path]) => path === AGENT_PATH);
    expect(call).toBeDefined();
    return String(call?.[1]);
  }

  /** Identity as the registry reads it from what save_agent wrote. */
  function registryIdentity(): { roleId?: string; createdAt?: number } | null {
    const agent = parseAgentFile(writtenAgentMd(), AGENT_PATH);
    return agent ? { roleId: agent.roleId, createdAt: agent.createdAt } : null;
  }

  function expectRefused(result: string): void {
    expect(result).toBe(format(getI18n().toolResult.agent.errAgentFrontmatterInvalid, { name: 'reviewer' }));
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(ensureParentDir).not.toHaveBeenCalled();
  }

  it('keeps an existing agent\'s role-id and created stamp when the model rewrites it', async () => {
    givenExistingFile(EXISTING_MD);

    await save('---\nname: reviewer\nrole-id: role-other\ndescription: Reviews code thoroughly\n---\n\nYou review code carefully.');

    expect(readTextFile).toHaveBeenCalledWith(AGENT_PATH);
    expect(registryIdentity()).toEqual(EXISTING);
    const agent = parseAgentFile(writtenAgentMd(), AGENT_PATH);
    expect(agent?.description).toBe('Reviews code thoroughly');
    expect(agent?.systemPrompt).toBe('You review code carefully.');
  });

  it('stamps a new agent with its creation time and drops a role-id the model invented', async () => {
    await save('---\nname: reviewer\nrole-id: role-made-up\ndescription: Reviews code\n---\n\nYou review code.');

    expect(readTextFile).not.toHaveBeenCalled();
    expect(registryIdentity()).toEqual({ roleId: undefined, createdAt: NOW });
  });

  it('leaves a legacy agent (no created stamp) unstamped even if the model writes one', async () => {
    givenExistingFile('---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.');

    await save(`---\nname: reviewer\ncreated: ${NOW}\ndescription: Reviews code\n---\n\nYou review code.`);

    expect(registryIdentity()).toEqual({ roleId: undefined, createdAt: undefined });
  });

  describe('CRLF content', () => {
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');

    it('round-trips a new agent', async () => {
      await save(crlf('---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.\n'));

      expect(registryIdentity()).toEqual({ roleId: undefined, createdAt: NOW });
    });

    it('round-trips an existing agent (identity appended as the last frontmatter lines)', async () => {
      givenExistingFile(crlf(EXISTING_MD));

      await save(crlf('---\nname: reviewer\ndescription: Improved\n---\n\nYou review code.\n'));

      expect(writtenAgentMd()).toContain('\r\ncreated: 1700000000000\r\n---\r\n');
      expect(registryIdentity()).toEqual(EXISTING);
    });
  });

  it('carries the role-id of an existing file whose YAML no longer parses', async () => {
    // Joined a team, then broke (here: an unclosed flow list). The next
    // "fix it" save must not lose the id every membership points at.
    givenExistingFile('---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ntools: [read_file\n---\n\nYou review code.');

    await save('---\nname: reviewer\ntools: [read_file]\n---\n\nYou review code.');

    expect(registryIdentity()).toEqual(EXISTING);
  });

  it('refuses content the registry cannot read at all, writing nothing', async () => {
    const result = await save('---\nname: [unclosed\n---\n\nYou review code.', [{ path: 'notes.md', content: 'x' }]);

    expectRefused(result);
  });

  it('refuses content without frontmatter, writing nothing', async () => {
    expectRefused(await save('You review code.'));
  });

  // Shapes where the YAML the helper edits and the object the registry reads
  // disagree. Each one either ends with exactly the carried identity or is
  // refused — never written with an identity the carry rules did not choose.
  describe('hostile or unusual frontmatter', () => {
    const ALIAS_KEY = 'k: &k role-id\n*k : role-victim';

    it('refuses an alias key that smuggles a role-id into a new agent', async () => {
      expectRefused(await save(`---\nname: reviewer\n${ALIAS_KEY}\n---\n\nP`));
    });

    it('refuses an alias key that overrides an existing agent\'s correct role-id', async () => {
      givenExistingFile(EXISTING_MD);

      expectRefused(await save(`---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\n${ALIAS_KEY}\n---\n\nP`));
    });

    it('refuses a !!merge key that smuggles a role-id into a new agent', async () => {
      expectRefused(await save('---\nname: reviewer\n!!merge <<: { role-id: role-victim }\n---\n\nP'));
    });

    it('carries the existing role-id over a !!merge key (an explicit key beats a merged one)', async () => {
      givenExistingFile(EXISTING_MD);

      await save('---\nname: reviewer\n!!merge <<: { role-id: role-victim }\n---\n\nP');

      expect(registryIdentity()).toEqual(EXISTING);
    });

    it('refuses a YAML 1.1 merge key behind a %YAML directive', async () => {
      expectRefused(await save('---\n%YAML 1.1\n--- # c\nname: reviewer\n<<: { role-id: role-victim }\n---\n\nP'));
    });

    it('carries the existing role-id over an explicit (? key) role-id', async () => {
      givenExistingFile(EXISTING_MD);

      await save('---\nname: reviewer\n? role-id\n: role-other\n---\n\nP');

      expect(registryIdentity()).toEqual(EXISTING);
    });

    it('refuses when rewriting the role-id would orphan an alias to its anchored value', async () => {
      givenExistingFile(EXISTING_MD);

      expectRefused(await save('---\nname: reviewer\nrole-id: &v role-other\nother: *v\n---\n\nP'));
    });
  });
});

// "新建一个叫 reviewer 的专家" must not replace the reviewer that already
// exists, and no user item may take a builtin's or a plugin's name: the
// registry prefers the user's file (agents) or scans the user's folder first
// (skills), so such a file hides the real one from every team pointing at
// `builtin:<name>` / `plugin:<name>`. Every refusal writes nothing at all —
// neither the manifest nor any supporting file.
describe('save_agent / save_skill name guard', () => {
  const HOME = '/Users/testuser';
  const AGENTS_DIR = `${HOME}/.abu/agents`;
  const SKILLS_DIR = `${HOME}/.abu/skills`;
  const t = () => getI18n().toolResult.agent;
  const agentMd = (name: string) => `---\nname: ${name}\ndescription: Reviews code\n---\n\nYou review code.`;
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: Commits\n---\n\n# Commit`;
  const saveSkillTool = createSaveItemTool('skill');

  const inUse = (label: string, name: string) => format(t().errNameInUse, { label, name });
  const alreadyExists = (label: string, name: string) => format(t().errItemExists, { label, name });

  /** Folders under `dir` and the manifests inside them, as the fs mocks see them. */
  function givenOnDisk(dir: string, folders: Record<string, string>, manifest = 'AGENT.md'): void {
    vi.mocked(readDir).mockImplementation(async (path) => (
      String(path) === dir ? Object.keys(folders).map((name) => ({ name, isDirectory: true, isFile: false, isSymlink: false })) : []
    ));
    vi.mocked(exists).mockImplementation(async (path) => Object.keys(folders).some((f) => path === `${dir}/${f}/${manifest}`));
    vi.mocked(readTextFile).mockImplementation(async (path) => {
      const folder = Object.keys(folders).find((f) => path === `${dir}/${f}/${manifest}`);
      return folder === undefined ? '' : folders[folder];
    });
  }

  function expectNothingWritten(): void {
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(ensureParentDir).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([]);
    vi.mocked(skillLoader.getAvailableSkills).mockReturnValue([]);
  });

  afterEach(() => {
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(readDir).mockReset().mockResolvedValue([]);
  });

  describe('save_agent', () => {
    const label = () => t().labelAgent;

    it('refuses to create an agent under the name of one that exists, writing no file at all', async () => {
      givenOnDisk(AGENTS_DIR, { reviewer: agentMd('reviewer') });
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'reviewer', description: 'Reviews code' }]);

      const result = await saveAgentTool.execute({
        name: 'reviewer',
        content: agentMd('reviewer'),
        files: [{ path: 'notes.md', content: 'x' }],
      });

      expect(result).toBe(alreadyExists(label(), 'reviewer'));
      expectNothingWritten();
    });

    it('tells the model to pass overwrite only when the user asked to change that item', () => {
      expect(t().errItemExists).toContain('overwrite: true');
      const overwrite = saveAgentTool.inputSchema.properties.overwrite as { type: string; description: string };
      expect(overwrite.type).toBe('boolean');
      expect(saveAgentTool.inputSchema.required).not.toContain('overwrite');
      expect(saveAgentTool.description).toContain('overwrite');
    });

    it('modifies the existing agent when overwrite is true', async () => {
      givenOnDisk(AGENTS_DIR, { reviewer: agentMd('reviewer') });
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'reviewer', description: 'Reviews code' }]);

      const result = await saveAgentTool.execute({
        name: 'reviewer',
        content: '---\nname: reviewer\ndescription: Reviews code thoroughly\n---\n\nYou review code carefully.',
        overwrite: true,
        files: [{ path: 'notes.md', content: 'x' }],
      });

      expect(result).toBe(format(t().agentSaved, {
        label: label(), name: 'reviewer', filePath: `${AGENTS_DIR}/reviewer/AGENT.md`,
        fileList: format(t().savedFileList, { list: '  - notes.md' }),
      }));
      const written = vi.mocked(writeTextFile).mock.calls.find(([path]) => path === `${AGENTS_DIR}/reviewer/AGENT.md`);
      expect(parseAgentFile(String(written?.[1]), `${AGENTS_DIR}/reviewer/AGENT.md`)?.systemPrompt).toBe('You review code carefully.');
      // Replacing is what was asked for: no createNew on the manifest.
      expect(written).toHaveLength(2);
      expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/reviewer/notes.md`, 'x');
    });

    it.each(['产品经理', 'abu', 'ABU', 'Abu'])('refuses the builtin name %s, even with overwrite and before discovery listed anything', async (name) => {
      const result = await saveAgentTool.execute({ name, content: agentMd(name), overwrite: true });

      expect(result).toBe(inUse(label(), name));
      expectNothingWritten();
    });

    it('refuses a builtin name even when a user file already shadows it', async () => {
      givenOnDisk(AGENTS_DIR, { abu: agentMd('abu') });

      const result = await saveAgentTool.execute({ name: 'abu', content: agentMd('abu'), overwrite: true });

      expect(result).toBe(inUse(label(), 'abu'));
      expectNothingWritten();
    });

    it('refuses the name of a plugin\'s agent, including a disabled plugin\'s, even with overwrite', async () => {
      givenOnDisk(AGENTS_DIR, { 'weather-bot': `---\nname: weather-bot\nsource: plugin:weather@official\n---\n\nP` });
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([
        { name: 'weather-bot', description: 'Weather', source: { kind: 'plugin', plugin: 'weather@official' } },
      ]);

      const result = await saveAgentTool.execute({ name: 'Weather-Bot', content: agentMd('Weather-Bot'), overwrite: true });

      expect(result).toBe(inUse(label(), 'Weather-Bot'));
      expect(agentRegistry.getAvailableAgents).toHaveBeenCalledWith({ includeDisabledPlugins: true });
      expectNothingWritten();
    });

    it('refuses to overwrite a plugin\'s AGENT.md the registry has not listed yet', async () => {
      givenOnDisk(AGENTS_DIR, { 'weather-bot': `---\nname: weather-bot\nsource: plugin:weather@official\n---\n\nP` });

      const result = await saveAgentTool.execute({ name: 'weather-bot', content: agentMd('weather-bot'), overwrite: true });

      expect(result).toBe(inUse(label(), 'weather-bot'));
      expectNothingWritten();
    });

    it('refuses a name that differs only in letter case from another agent\'s folder, even with overwrite', async () => {
      // On macOS `reviewer/AGENT.md` IS `Reviewer/AGENT.md`.
      givenOnDisk(AGENTS_DIR, { Reviewer: agentMd('Reviewer') });

      const result = await saveAgentTool.execute({ name: 'reviewer', content: agentMd('reviewer'), overwrite: true });

      expect(result).toBe(inUse(label(), 'reviewer'));
      expectNothingWritten();
    });

    it('refuses a name that differs only in letter case from a listed agent', async () => {
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'Writer', description: '' }]);

      const result = await saveAgentTool.execute({ name: 'writer', content: agentMd('writer') });

      expect(result).toBe(inUse(label(), 'writer'));
      expectNothingWritten();
    });

    // Hand-made `foo/AGENT.md` with `name: bar`: the registry lists `bar`, and
    // replacing that file would make `bar` vanish although nothing said `bar`.
    it.each([true, undefined])('refuses a folder whose manifest names a different agent (overwrite: %s)', async (overwrite) => {
      givenOnDisk(AGENTS_DIR, { foo: agentMd('bar') });
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'bar', description: '' }]);

      const result = await saveAgentTool.execute({ name: 'foo', content: agentMd('foo'), ...(overwrite ? { overwrite } : {}) });

      expect(result).toBe(inUse(label(), 'foo'));
      expectNothingWritten();
    });

    it('refuses a listed agent\'s exact name when its file is not the one this tool would write (project-level)', async () => {
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'reviewer', description: '' }]);

      const result = await saveAgentTool.execute({ name: 'reviewer', content: agentMd('reviewer'), overwrite: true });

      expect(result).toBe(inUse(label(), 'reviewer'));
      expectNothingWritten();
    });

    // Abu writes the avatar itself (the editor's picker only produces preset
    // references). A value that is neither a preset reference nor one emoji
    // would render as raw text everywhere an avatar is shown.
    it.each(['icon:code/blue/extra', 'icon:code', 'icon:nope/blue', 'icon:code/neon', 'code/blue', '🤖🤖', 'AB'])(
      'refuses the avatar %j — neither a preset icon reference nor a single emoji — writing nothing',
      async (avatar) => {
        const result = await saveAgentTool.execute({
          name: 'avatar-check',
          content: `---\nname: avatar-check\ndescription: Reviews code\navatar: ${avatar}\n---\n\nYou review code.`,
        });

        expect(result).toBe(t().errInvalidAvatar);
        expectNothingWritten();
      },
    );

    // YAML reads `avatar: 123` as a number; it would render as raw text too.
    it('refuses an avatar the frontmatter did not type as a string', async () => {
      const result = await saveAgentTool.execute({
        name: 'avatar-check',
        content: '---\nname: avatar-check\ndescription: Reviews code\navatar: 123\n---\n\nYou review code.',
      });

      expect(result).toBe(t().errInvalidAvatar);
      expectNothingWritten();
    });

    it.each(['icon:code/blue', 'icon:chart-bar/coral', '🤖', '👩‍💻', '🇨🇳'])('accepts the avatar %j', async (avatar) => {
      const result = await saveAgentTool.execute({
        name: 'avatar-ok',
        content: `---\nname: avatar-ok\ndescription: Reviews code\navatar: ${avatar}\n---\n\nYou review code.`,
      });

      expect(result).not.toBe(t().errInvalidAvatar);
      const written = vi.mocked(writeTextFile).mock.calls.find(([path]) => path === `${AGENTS_DIR}/avatar-ok/AGENT.md`);
      expect(String(written?.[1])).toContain(`avatar: ${avatar}`);
    });

    it('refuses content whose frontmatter name differs from the name parameter', async () => {
      const result = await saveAgentTool.execute({
        name: 'reviewer',
        content: agentMd('writer'),
        files: [{ path: 'notes.md', content: 'x' }],
      });

      expect(result).toBe(format(t().errManifestNameMismatch, { label: label(), name: 'reviewer', found: 'writer', fileName: 'AGENT.md' }));
      expectNothingWritten();
    });

    // Every `files` entry is checked before the manifest is written: a refusal
    // found halfway through the list used to leave AGENT.md (and the entries
    // before it) on disk under a call that reported failure.
    it.each(['nul', 'con', 'COM1', 'lpt9', 'aux.md'])(
      'refuses the Windows device name %s as an expert name, writing nothing',
      async (name) => {
        const result = await saveAgentTool.execute({ name, content: agentMd(name) });

        expect(result).toBe(format(t().errInvalidName, { label: t().labelAgent, name }));
        expectNothingWritten();
      },
    );

    describe('supporting files are all checked before anything is written', () => {
      const save = (files: unknown[]) => saveAgentTool.execute({ name: 'doc-writer', content: agentMd('doc-writer'), files });

      it.each([
        '../escape.md', '/etc/passwd', '\\\\server\\share\\x', 'C:\\evil.txt', 'C:/evil.txt', 'notes/../../escape.md',
        // Win32 strips a trailing dot or space and reads `NAME::$DATA` as NAME
        // itself, so each of these IS AGENT.md there — replacing the checked
        // manifest (name: abu → the default assistant is shadowed).
        'AGENT.md.', 'AGENT.md ', 'AGENT.md::$DATA', 'sub/AGENT.md.',
        // Windows device names, with or without an extension, any case.
        'CON', 'sub/nul.txt', 'Com1.log', 'LPT9', 'aux', 'PRN.md', 'CON .txt',
        // `.` / empty segments, control characters, other Windows-invalid names.
        './AGENT.md', '.\\Agent.MD', './notes.md', 'notes//a.md', 'notes/', './',
        'notes\u0000.md', 'notes\u001f.md', 'a<b.md', 'a|b.md', 'what?.md', 'star*.md', 'q"uote.md', 'a>b.md',
      ])(
        'refuses the unsafe path %j, writing neither the manifest nor the files before it',
        async (p) => {
          const result = await save([{ path: 'ok.md', content: 'x' }, { path: p, content: 'y' }]);

          expect(result).toBe(format(t().errUnsafeFilePath, { p }));
          expectNothingWritten();
        },
      );

      it.each(['AGENT.md', 'agent.md', 'agent.MD', 'AGENT.md/inside.md'])(
        'refuses %s — the manifest is written from content, never from files',
        async (p) => {
          const result = await save([{ path: p, content: '---\nname: abu\n---\n\nP' }]);

          expect(result).toBe(format(t().errFileIsManifest, { p, fileName: 'AGENT.md' }));
          expectNothingWritten();
        },
      );

      it.each([
        [{ path: 'notes.md' }],
        [{ path: 'notes.md', content: 42 }],
        [{ path: 42, content: 'x' }],
        [{ path: '', content: 'x' }],
        ['notes.md'],
        [null],
      ])('refuses the malformed entry %j, writing nothing', async (entry) => {
        const result = await save([{ path: 'ok.md', content: 'x' }, entry]);

        expect(result).toBe(format(t().errInvalidFileEntry, { index: '1' }));
        expectNothingWritten();
      });

      it('still writes nested supporting files, with either separator', async () => {
        await save([
          { path: 'references/api.md', content: 'a' },
          { path: 'scripts\\render.mjs', content: 'b' },
          { path: 'v1.2/notes.txt', content: 'c' },
        ]);

        expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/references/api.md`, 'a');
        expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/scripts\\render.mjs`, 'b');
        expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/v1.2/notes.txt`, 'c');
      });
    });

    it('writes an agent under a name nothing uses', async () => {
      givenOnDisk(AGENTS_DIR, { reviewer: agentMd('reviewer') });
      vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'reviewer', description: '' }]);

      await saveAgentTool.execute({ name: 'doc-writer', content: agentMd('doc-writer') });

      expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/AGENT.md`, expect.any(String), { createNew: true });
    });

    // Two loops (team members, IM + desktop) can both find the name free and
    // both write: the host creates a new manifest only if it is still absent.
    it('reports a manifest that appeared between the check and the write as existing, writing no files', async () => {
      vi.mocked(writeTextFile).mockImplementationOnce(async (path) => {
        vi.mocked(exists).mockImplementation(async (p) => p === path);
        throw new Error('fs: file already exists and createNew is set');
      });

      const result = await saveAgentTool.execute({
        name: 'doc-writer', content: agentMd('doc-writer'), files: [{ path: 'notes.md', content: 'x' }],
      });

      expect(result).toBe(alreadyExists(label(), 'doc-writer'));
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/AGENT.md`, expect.any(String), { createNew: true });
    });

    it('rethrows a manifest write failure that is not a manifest appearing meanwhile', async () => {
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk full'));

      await expect(saveAgentTool.execute({ name: 'doc-writer', content: agentMd('doc-writer') })).rejects.toThrow('disk full');
    });

    it('creates with createNew even when overwrite is true but nothing is there yet', async () => {
      await saveAgentTool.execute({ name: 'doc-writer', content: agentMd('doc-writer'), overwrite: true });

      expect(writeTextFile).toHaveBeenCalledWith(`${AGENTS_DIR}/doc-writer/AGENT.md`, expect.any(String), { createNew: true });
    });
  });

  describe('save_skill', () => {
    const label = () => t().labelSkill;

    it('refuses to create a skill under the name of one that exists, and modifies it with overwrite', async () => {
      givenOnDisk(SKILLS_DIR, { 'git-commit': skillMd('git-commit') }, 'SKILL.md');
      vi.mocked(skillLoader.getAvailableSkills).mockReturnValue([{ name: 'git-commit', description: '', source: 'user' }]);

      expect(await saveSkillTool.execute({ name: 'git-commit', content: skillMd('git-commit'), files: [{ path: 'a.md', content: 'x' }] }))
        .toBe(alreadyExists(label(), 'git-commit'));
      expectNothingWritten();

      await saveSkillTool.execute({ name: 'git-commit', content: skillMd('git-commit'), overwrite: true });
      expect(writeTextFile).toHaveBeenCalledWith(`${SKILLS_DIR}/git-commit/SKILL.md`, skillMd('git-commit'));
      expect(vi.mocked(writeTextFile).mock.calls[0]).toHaveLength(2);
    });

    it.each([
      ['builtin', 'pdf'],
      ['plugin', 'weather'],
      ['enterprise', 'expense'],
    ] as const)('refuses the name of a %s skill, even with overwrite', async (source, name) => {
      vi.mocked(skillLoader.getAvailableSkills).mockReturnValue([{ name, description: '', source }]);

      expect(await saveSkillTool.execute({ name, content: skillMd(name), overwrite: true })).toBe(inUse(label(), name));
      expect(skillLoader.getAvailableSkills).toHaveBeenCalledWith({ includeDrafts: true, includeDisabledPlugins: true });
      expectNothingWritten();
    });

    it('refuses overwriting a folder whose SKILL.md names a different skill', async () => {
      givenOnDisk(SKILLS_DIR, { 'git-commit': skillMd('commit-helper') }, 'SKILL.md');
      vi.mocked(skillLoader.getAvailableSkills).mockReturnValue([{ name: 'commit-helper', description: '', source: 'user' }]);

      expect(await saveSkillTool.execute({ name: 'git-commit', content: skillMd('git-commit'), overwrite: true }))
        .toBe(inUse(label(), 'git-commit'));
      expectNothingWritten();
    });

    it('refuses content whose frontmatter name differs from the name parameter', async () => {
      const result = await saveSkillTool.execute({ name: 'git-commit', content: skillMd('commit') });

      expect(result).toBe(format(t().errManifestNameMismatch, { label: label(), name: 'git-commit', found: 'commit', fileName: 'SKILL.md' }));
      expectNothingWritten();
    });

    it('writes a skill under a name nothing uses', async () => {
      await saveSkillTool.execute({ name: 'git-commit', content: skillMd('git-commit') });

      expect(writeTextFile).toHaveBeenCalledWith(`${SKILLS_DIR}/git-commit/SKILL.md`, skillMd('git-commit'), { createNew: true });
    });
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

it('tells the model a blacklisted skill is blocked by the organization, without listing the others or enabling it', async () => {
  const { useSettingsStore } = await import('@/stores/settingsStore');
  const { skillLoader } = await import('@/core/skill/loader');
  const { getI18n, format } = await import('@/i18n');
  const toggleSkillEnabled = vi.fn();
  vi.mocked(useSettingsStore.getState).mockReturnValue({ disabledSkills: ['blocked'], toggleSkillEnabled } as unknown as ReturnType<typeof useSettingsStore.getState>);
  vi.mocked(skillLoader.getSkill).mockReturnValue(undefined);
  vi.mocked(skillLoader.isBlockedByPolicy).mockImplementation((name) => name === 'blocked');
  vi.mocked(skillLoader.getAvailableSkills).mockClear();

  const result = await useSkillTool.execute({ skill_name: '/blocked' });

  expect(result).toBe(format(getI18n().toolResult.agent.skillBlockedByPolicy, { skillName: 'blocked' }));
  expect(skillLoader.getAvailableSkills).not.toHaveBeenCalled();
  expect(toggleSkillEnabled).not.toHaveBeenCalled();
  vi.mocked(skillLoader.isBlockedByPolicy).mockReturnValue(false);
});
