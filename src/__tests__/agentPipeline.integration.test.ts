/**
 * Agent Pipeline Integration Test
 *
 * Tests the full message → LLM → tool execution → response pipeline.
 * Uses mocked LLM adapter to simulate various response scenarios.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTaskExecutionStore } from '../stores/taskExecutionStore';
// The real title side call would spend one of the mocked chat replies these cases count (it is covered in
// titleGen*.test.ts); here it is a spy that records how many replies had been requested when it was asked.
const titleProbe = vi.hoisted(() => ({
  chatCalls: () => 0,
  asked: [] as Array<{ convId: string; chatCallsSoFar: number }>,
}));
vi.mock('../core/session/titleGen', () => ({
  requestConversationTitle: async (convId: string) => {
    titleProbe.asked.push({ convId, chatCallsSoFar: titleProbe.chatCalls() });
  },
  abortConversationTitle: () => {},
}));
// Mock workspaceStore
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      currentPath: '/Users/testuser/project',
      setWorkspace: vi.fn(),
      clearWorkspace: vi.fn(),
    }),
    subscribe: vi.fn(),
  },
}));

// Mock the LLM adapters to return controlled responses
// Use class-based mocks so they work with `new`
const mockClaudeChat = vi.fn();
titleProbe.chatCalls = () => mockClaudeChat.mock.calls.length;
vi.mock('../core/llm/claude', () => ({
  ClaudeAdapter: class {
    chat = mockClaudeChat;
  },
}));

vi.mock('../core/llm/openai-compatible', () => ({
  OpenAICompatibleAdapter: class {
    chat = vi.fn();
  },
}));

vi.mock('../core/llm/tauriFetch', () => ({
  getTauriFetch: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock('../utils/consoleError', () => ({
  reportError: vi.fn(),
}));

// Mock tool registry
vi.mock('../core/tools/registry', () => ({
  getAllTools: vi.fn().mockReturnValue([
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ result: 'file content here' }),
    },
    {
      name: 'run_command',
      description: 'Run a command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ result: 'command output' }),
    },
  ]),
}));

// Mock orchestrator
vi.mock('../core/agent/orchestrator', () => ({
  routeInput: vi.fn().mockImplementation((input: string) => ({
    type: 'general',
    cleanInput: input,
    name: 'abu',
  })),
  buildSystemPromptSections: vi.fn().mockResolvedValue([
    { name: 'base', text: 'You are Abu', cacheable: true },
  ]),
}));

// Mock event router
vi.mock('../core/agent/eventRouter', () => ({
  createEventRouter: vi.fn().mockReturnValue({
    route: vi.fn(),
    createStepForToolUse: vi.fn().mockReturnValue('step-1'),
    completeStep: vi.fn(),
    addChildStepToDelegate: vi.fn(),
    completeChildStep: vi.fn(),
  }),
}));

// Mock skill loader
vi.mock('../core/skill/loader', () => ({
  skillLoader: {
    getSkill: vi.fn().mockReturnValue(null),
    refreshSkill: vi.fn().mockResolvedValue(null),
    listSupportingFiles: vi.fn().mockResolvedValue([]),
  },
}));

// Mock context modules
vi.mock('../core/context/contextManager', () => ({
  ContextBudgetError: class ContextBudgetError extends Error {
    code: string;
    estimatedTokens: number;
    inputBudget: number;

    constructor(code: string, estimatedTokens: number, inputBudget: number) {
      super(code);
      this.code = code;
      this.estimatedTokens = estimatedTokens;
      this.inputBudget = inputBudget;
    }
  },
  enforceContextBudget: vi.fn().mockImplementation((msgs) => ({
    messages: msgs,
    tokensBefore: 1,
    tokensAfter: 1,
    inputBudget: 100000,
    safetyMarginTokens: 1000,
    strategy: 'unchanged',
  })),
  trimOldScreenshots: vi.fn().mockImplementation((msgs) => msgs),
  computeInputBudget: (contextWindowSize: number, reserveForOutput: number) => ({
    inputBudget: contextWindowSize - reserveForOutput,
    safetyMarginTokens: 0,
  }),
}));

vi.mock('../core/context/autoCompact', () => ({
  getUsagePercent: vi.fn().mockReturnValue(0.3),
  // Real clamped math rather than a fixed stub: the published `percent` is what
  // the compression tests read back, so it has to track the actual token counts.
  getDisplayPercent: vi.fn().mockImplementation((tokens: number, maxTokens: number) => (
    maxTokens <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((tokens / maxTokens) * 100)))
  )),
}));

vi.mock('../core/context/tokenEstimator', () => ({
  estimateToolSchemaTokens: vi.fn().mockReturnValue(500),
  estimateTokens: vi.fn().mockReturnValue(100),
  estimateTextTokenWeight: vi.fn().mockImplementation(
    (text: string) => (text === 'You are Abu' ? 100 : 0),
  ),
  estimateMessageTokens: vi.fn().mockReturnValue(200),
  calibrateFromUsage: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock('../core/context/contextUtils', () => ({
  getMessageText: vi.fn().mockImplementation((content: unknown) => (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((block): block is { type: 'text'; text: string } => (
          typeof block === 'object' && block !== null
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string'
        )).map((block) => block.text).join('\n')
        : ''
  )),
}));

const delegatedMediaBytes = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('../core/subagent/delegatedMediaStore', () => ({
  persistDelegatedMedia: vi.fn(async (_conversationId: string, input: { mediaType: string; bytes: Uint8Array }) => {
    const id = `delegated-media-${delegatedMediaBytes.size + 1}`;
    delegatedMediaBytes.set(id, input.bytes);
    return { id, sha256: 'a'.repeat(64), mediaType: input.mediaType, bytes: input.bytes.byteLength };
  }),
  readDelegatedMedia: vi.fn(async (_conversationId: string, ref: { id: string }) => delegatedMediaBytes.get(ref.id) ?? null),
}));

vi.mock('../core/session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(),
}));

// Mock misc
vi.mock('../core/agent/retry', () => ({
  withRetry: vi.fn().mockImplementation(async (
    fn: () => Promise<unknown>,
    config?: { maxRetries?: number },
    signal?: AbortSignal,
    onRetry?: (attempt: number, error: { code?: string; retryable?: boolean }, delayMs: number) => void,
  ) => {
    let attempt = 0;
    const maxRetries = config?.maxRetries ?? 3;
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request cancelled');
      }
      try {
        return await fn();
      } catch (error) {
        const retryable = typeof error === 'object'
          && error !== null
          && (error as { retryable?: unknown }).retryable === true
          && (error as { code?: unknown }).code !== 'cancelled';
        if (!retryable || attempt >= maxRetries) {
          throw error;
        }
        onRetry?.(attempt + 1, error as { code?: string; retryable?: boolean }, 0);
        attempt++;
      }
    }
  }),
}));

vi.mock('../core/agent/permissionBridge', () => ({
  clearLoopContext: vi.fn(),
  getLoopContextForConversation: vi.fn().mockReturnValue(null),
  requestCommandConfirmation: vi.fn().mockResolvedValue(true),
  requestFilePermission: vi.fn().mockResolvedValue(true),
  drainConfirmationQueue: vi.fn().mockReturnValue([]),
  drainFilePermissionQueue: vi.fn().mockReturnValue([]),
  drainWorkspaceRequest: vi.fn().mockReturnValue(null),
  drainUserQuestions: vi.fn(),
}));

vi.mock('../core/agent/userInputQueue', () => ({
  drainQueuedInputs: vi.fn().mockReturnValue([]),
  drainSystemQueuedInputs: vi.fn().mockReturnValue([]),
  clearInputQueue: vi.fn(),
  hasQueuedInputs: vi.fn().mockReturnValue(false),
  hasSystemQueuedInputs: vi.fn().mockReturnValue(false),
  enqueueUserInput: vi.fn(),
  pauseUserInputQueue: vi.fn(),
  takeSteeringInputs: vi.fn().mockResolvedValue([]),
  restoreSteeringInputs: vi.fn(),
  beginSteeringRun: vi.fn(),
  endSteeringRun: vi.fn(),
  requeueUserInput: vi.fn(),
  steeredMessageId: (id: string) => `steer-${id}`,
}));

vi.mock('../core/agent/executionSnapshot', () => ({
  snapshotExecutionSteps: vi.fn().mockReturnValue([]),
}));

vi.mock('../core/agent/lifecycleHooks', () => ({
  emitHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/tools/builtins', () => ({
  clearAllSkillHooks: vi.fn(),
  clearSkillHooksByConversation: vi.fn(),
  clearSkillHooksByLoop: vi.fn(),
}));

vi.mock('../core/agent/toolExecutor', () => ({
  executeToolBatch: vi.fn().mockResolvedValue({
    mcpChanged: false,
    requiresUserRecovery: false,
    observations: [],
  }),
}));

vi.mock('../core/capabilities', () => ({
  getBuiltinSearchConfig: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../core/llm/modelCapabilities', () => ({
  resolveAgentModelCapabilities: vi.fn().mockReturnValue({
    toolCalling: 'native',
    structuredArguments: 'reliable',
    computerUseTier: 'full',
    capabilitySource: 'builtin',
    vision: true,
  }),
  resolveCapabilities: vi.fn().mockReturnValue({
    contextWindow: 200000,
    maxOutputTokens: 8192,
    thinking: false,
    vision: true,
  }),
  computeReasoningParams: vi.fn().mockReturnValue({
    maxTokens: 8192,
    enableThinking: false,
  }),
  deriveUiCaps: vi.fn().mockReturnValue([]),
  // subagentLoop's per-turn starvation check — reached as soon as a delegate
  // run takes a tool_use turn, so the factory has to provide it. Mirror the
  // real (pure) implementation rather than stubbing a constant.
  isReasoningStarvation: vi.fn().mockImplementation(
    (stopReason: string, contentLength: number, toolCallCount: number) =>
      (stopReason === 'max_tokens' || stopReason === 'length') && contentLength === 0 && toolCallCount === 0,
  ),
  reserveOutputTokens: (requested: number, contextWindow: number) =>
    Math.max(1, Math.min(requested, Math.floor(contextWindow * 0.25))),
}));

vi.mock('../core/tools/toolNames', () => ({
  TOOL_NAMES: {
    WEB_SEARCH: 'web_search',
    DELEGATE_TO_AGENT: 'delegate_to_agent',
    SHOW_WIDGET: 'show_widget',
    TOOL_SEARCH: 'tool_search',
    SEND_FILE: 'send_file',
  },
  // agentLoop calls this on every tool_use event — the real function, not a
  // stub, so hidden-marking semantics stay faithful in the pipeline test.
  isDisplayHiddenStepBackedTool: (name?: string) => name === 'show_widget',
}));

vi.mock('../core/tools/toolPrefetch', () => ({
  prefetchTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../core/tools/toolSearch', () => ({
  classifyTools: vi.fn().mockImplementation((tools) => ({
    coreTools: tools,
    deferredTools: [],
  })),
  buildDeferredToolsSummary: vi.fn().mockReturnValue(''),
  promoteSearchedDeferredTools: vi.fn(),
}));

vi.mock('../core/logging/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../core/agent/subagentAbort', () => ({
  createSubagentController: vi.fn().mockReturnValue({
    signal: new AbortController().signal,
    cleanup: vi.fn(),
  }),
}));

vi.mock('../core/session/checkpoint', () => ({
  writeCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/session/sessionDir', () => ({
  getSessionOutputDir: vi.fn().mockResolvedValue('/tmp/test-session'),
}));

vi.mock('../core/llm/promptSections', () => ({
  sectionsToString: vi.fn().mockReturnValue('system prompt'),
  mergeSections: vi.fn().mockImplementation((a, b) => [...(a || []), ...(b || [])]),
  orderSectionsForCaching: vi.fn().mockImplementation((sections) => sections),
}));

vi.mock('../core/skill/preprocessor', () => ({
  substituteVariables: vi.fn().mockImplementation((content) => content),
}));

vi.mock('../core/skill/toolFilter', () => ({
  // Exact-name match (with a minimal trailing-wildcard case) rather than a blanket
  // `true`: the loop now passes a non-empty blockedTools (['send_file']) for
  // non-IM runs, which exercises the deferred-tool filter — a blanket-true mock
  // would drop every deferred tool instead of just the blocked one.
  matchesToolName: vi.fn().mockImplementation((name: string, pattern: string) => {
    if (pattern === '*') return true;
    if (pattern?.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    return name === pattern;
  }),
  parseToolPatterns: vi.fn().mockReturnValue({ inputValidators: new Map() }),
}));

// These three live at `src/utils/*`. The specifiers used to be copied verbatim
// from agentLoop.ts (`../../utils/*`), which is right from `src/core/agent/` but
// resolves to a non-existent `<repo>/utils/*` from here — vitest registered the
// mocks under a path nothing imports, said nothing, and ran the real modules.
// The completion case below asserts the interception is live so this cannot rot
// back silently.
vi.mock('@/utils/notifications', () => ({
  notifyTaskCompleted: vi.fn(),
  notifyTaskError: vi.fn(),
}));

vi.mock('@/utils/pathUtils', () => ({
  joinPath: vi.fn().mockImplementation((...parts: string[]) => parts.join('/')),
}));

vi.mock('@/utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

// Now import the module under test
import { runAgentLoop, persistExecutionSnapshot } from '../core/agent/agentLoop';
import { LLMError } from '../core/llm/adapter';
import * as delegatedMediaStore from '../core/subagent/delegatedMediaStore';
import { executeToolBatch } from '../core/agent/toolExecutor';
import { escalateMaxOutputTokens } from '../core/agent/loopGuards';
import { getI18n, getLanguageSetting, setLanguage } from '../i18n';
import * as notifications from '../utils/notifications';
import type { StreamEvent, Message } from '../types';
// Mocked module reference — used to override token estimator per-test
import * as tokenEstimatorModule from '../core/context/tokenEstimator';
import * as contextManagerModule from '../core/context/contextManager';
import * as toolSearchModule from '../core/tools/toolSearch';
import { notifyTaskCompleted } from '@/utils/notifications';
import { joinPath } from '@/utils/pathUtils';
import { isWindows } from '@/utils/platform';
import { isMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import { createCompactBoundaryMarker } from '@/core/context/compactBoundary';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkwwAAAABJRU5ErkJggg==';

describe('Agent Pipeline Integration', () => {
  // runAgentLoop lazily `await import()`s these on its hot path, so the FIRST
  // test in this file paid their cold Vite transform inside its own body
  // (measured 3.9 s vs 18 ms for the next test) against the default 5 s
  // testTimeout — and under v8 coverage or a loaded runner it crossed the line.
  // A timed-out body is not cancelled, so it kept mutating shared state after
  // vitest moved on. Warm them here instead: hookTimeout is 30 s.
  beforeAll(async () => {
    await Promise.all([
      import('../core/agent/entryOrchestration'),
      import('../core/memdir/relevance'),
    ]);
  });

  beforeEach(() => {
    // chatStore.scheduleFlush() batches streamed tokens behind
    // requestAnimationFrame. This file runs under the `node` environment, which
    // has no such global, so the first streamed token threw and every turn that
    // emitted text ended in `error` instead of `completed` — invisibly, because
    // the assertions only checked that messages existed. Same synchronous stub
    // subagentMultimodalHandoff.integration.test.ts already uses: no timers, no
    // clock, flush order stays deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    delegatedMediaBytes.clear();
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
    });
    useTaskExecutionStore.setState({
      executions: {},
    });
    // Set up settings with API key — providers is an array, activeModel has providerId + modelId
    useSettingsStore.setState({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          apiFormat: 'anthropic',
          apiKey: 'test-key',
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000, maxOutputTokens: 8192 }],
          enabled: true,
        },
      ],
      activeModel: { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('complete conversation: user message → LLM text response → done', async () => {
    // Set up mock adapter to emit text and done
    mockClaudeChat.mockImplementation(
      async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
        onEvent({ type: 'text', text: 'Hello! How can I help?' });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      },
    );

    const convId = useChatStore.getState().createConversation();

    await runAgentLoop(convId, 'Hi there');

    // Verify conversation has both user and assistant messages
    const conv = useChatStore.getState().conversations[convId];
    expect(conv.messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = conv.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Hi there');

    const assistantMsg = conv.messages.find((m) => m.role === 'assistant' && m.content !== '');
    expect(assistantMsg).toBeDefined();

    // Guards the shared `@/utils/*` mocks above: a vi.mock whose specifier does
    // not resolve is silently ignored, so these would pass through to the real
    // modules — notifyTaskCompleted would publish on the Notice Bus with a
    // Date.now() dedup key. Asserting on a non-spy throws, so a broken
    // specifier fails here loudly instead of degrading into a real call.
    expect(vi.mocked(notifyTaskCompleted)).toHaveBeenCalledWith(expect.any(String), convId);
    expect(vi.mocked(joinPath)).toHaveBeenCalled();
    expect(vi.mocked(isWindows)).toHaveBeenCalled();
  });

  it('starts direct @agent delegation with the triggering image turn as ordered MessageContent blocks', async () => {
    const { routeInput } = await import('../core/agent/orchestrator');
    vi.mocked(routeInput).mockReturnValueOnce({
      type: 'delegate', cleanInput: 'Describe the image.', name: 'abu',
      delegateAgent: { name: 'researcher', description: 'research', systemPrompt: 'research', filePath: '__preset__' },
    } as never);
    mockClaudeChat.mockImplementationOnce(async (_messages: unknown, _options: unknown, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: 'text', text: 'done' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    });
    const conversationId = useChatStore.getState().createConversation();

    await runAgentLoop(conversationId, 'Describe the image.', {
      images: [{ id: 'img-1', data: TINY_PNG_BASE64, mediaType: 'image/png' }],
    });

    const firstChildMessages = mockClaudeChat.mock.calls[0][0] as Array<{ role: string; content: unknown }>;
    const firstChildUser = firstChildMessages.find((message) => message.role === 'user');
    const parentUser = useChatStore.getState().conversations[conversationId].messages
      .find((message) => message.role === 'user');
    const parentContent = parentUser?.content;
    expect(Array.isArray(parentContent)).toBe(true);
    expect(firstChildUser?.content).toEqual([
      ...(parentContent as Array<unknown>).map(({ filePath: _filePath, ...block }) => block),
      { type: 'text', text: 'Describe the image.' },
    ]);
  });

  it('preserves structured upstream details when a direct @agent provider call is rejected', async () => {
    const { routeInput } = await import('../core/agent/orchestrator');
    vi.mocked(routeInput).mockReturnValueOnce({
      type: 'delegate', cleanInput: 'Use a delegated agent.', name: 'abu',
      delegateAgent: { name: 'researcher', description: 'research', systemPrompt: 'research', filePath: '__preset__' },
    } as never);
    const upstream = {
      status: 403,
      error_type: 'governance.alicloud_content_safety_input_rejected',
      traceId: 'delegate-pipeline-trace-403',
      summary: 'provider rejected the delegated request',
    } as const;
    mockClaudeChat.mockRejectedValueOnce(new LLMError(
      '{"private":"raw delegated provider body"}',
      'content_policy',
      {
        retryable: false,
        statusCode: 403,
        rawBody: '{"private":"raw delegated provider body"}',
        upstream,
      },
    ));
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'Use a delegated agent.');

    expect(result).toMatchObject({
      reason: 'error',
      messageTaken: true,
      upstream,
    });
    const assistantText = useChatStore.getState().conversations[conversationId].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    expect(assistantText).toMatch(/content[- ]safety|内容安全/i);
    expect(assistantText).not.toContain('raw delegated provider body');
    expect(mockClaudeChat).toHaveBeenCalledTimes(1);
  });

  it('asks for the conversation title only after the first reply ended, and the reply calls stay as they were', async () => {
    titleProbe.asked.length = 0;
    mockClaudeChat.mockImplementation(async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
      onEvent({ type: 'text', text: 'Sure, here is the summary.' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    });
    const conversationId = useChatStore.getState().createConversation();

    await runAgentLoop(conversationId, 'please summarise the quarterly numbers');

    expect(mockClaudeChat).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(titleProbe.asked).toHaveLength(1));
    expect(titleProbe.asked[0]).toEqual({ convId: conversationId, chatCallsSoFar: 1 });
  });

  it('re-materializes delegated media refs for each primary provider retry attempt', async () => {
    const mediaRef = {
      id: 'delegated-media-retry',
      sha256: 'b'.repeat(64),
      mediaType: 'image/png' as const,
      bytes: 3,
    };
    delegatedMediaBytes.set(mediaRef.id, new Uint8Array([1, 2, 3]));
    const conversationId = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(conversationId, {
      id: 'historical-user-with-ref',
      role: 'user',
      content: [
        { type: 'text', text: 'Historical reference' },
        {
          type: 'delegated_media_ref',
          originConversationId: conversationId,
          attachment: mediaRef,
        },
      ] as never,
      timestamp: 1,
      loopId: 'older-loop',
    });

    let providerAttempt = 0;
    const outboundPayloads: string[] = [];
    mockClaudeChat.mockImplementation(
      async (messages: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
        providerAttempt++;
        const outboundPayload = JSON.stringify(messages);
        outboundPayloads.push(outboundPayload);
        if (providerAttempt === 1) {
          delegatedMediaBytes.set(mediaRef.id, new Uint8Array([4, 5, 6]));
          throw new LLMError('temporary provider failure', 'network_error', { retryable: true });
        }
        onEvent({ type: 'done', stopReason: 'end_turn' });
      },
    );

    await runAgentLoop(conversationId, 'Retry after a transient provider failure.');

    expect(mockClaudeChat).toHaveBeenCalledTimes(2);
    expect(delegatedMediaStore.readDelegatedMedia).toHaveBeenCalledTimes(2);
    expect(outboundPayloads[0]).toContain('AQID');
    expect(outboundPayloads[1]).toContain('BAUG');
  });

  it('returns structured upstream details and renders friendly copy for a content-policy rejection', async () => {
    const upstream = {
      status: 403,
      error_type: 'governance.alicloud_content_safety_input_rejected',
      traceId: 'pipeline-trace-403',
      summary: 'The upstream content safety system rejected the request.',
    } as const;
    mockClaudeChat.mockRejectedValueOnce(new LLMError(
      upstream.summary,
      'content_policy',
      {
        retryable: false,
        statusCode: 403,
        rawBody: '{"private":"raw provider body must stay out of the chat"}',
        upstream,
      },
    ));
    const conversationId = useChatStore.getState().createConversation();

    const result = await runAgentLoop(conversationId, 'Fixed non-sensitive fixture input.');

    expect(result).toMatchObject({
      reason: 'error',
      messageTaken: true,
      upstream,
    });
    const assistantText = useChatStore.getState().conversations[conversationId].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    expect(assistantText).not.toContain('raw provider body must stay out of the chat');
    expect(assistantText).not.toContain(upstream.error_type);
  });

  it('returns aborted before starting a direct delegate provider call when its linked signal is already aborted', async () => {
    const { routeInput } = await import('../core/agent/orchestrator');
    const { createSubagentController } = await import('../core/agent/subagentAbort');
    const controller = new AbortController();
    controller.abort();
    vi.mocked(createSubagentController).mockReturnValueOnce({ signal: controller.signal, cleanup: vi.fn() } as never);
    vi.mocked(routeInput).mockReturnValueOnce({
      type: 'delegate', cleanInput: 'Stop.', name: 'abu',
      delegateAgent: { name: 'researcher', description: 'research', systemPrompt: 'research', filePath: '__preset__' },
    } as never);
    const conversationId = useChatStore.getState().createConversation();

    await expect(runAgentLoop(conversationId, 'Stop.')).resolves.toMatchObject({ reason: 'aborted' });
    expect(mockClaudeChat).not.toHaveBeenCalled();
  });

  it('estimates each published context component only once per turn', async () => {
    mockClaudeChat.mockImplementation(
      async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
        onEvent({ type: 'text', text: 'Done.' });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      },
    );

    const convId = useChatStore.getState().createConversation();
    await runAgentLoop(convId, 'Measure this turn once');

    const usage = useChatStore.getState().conversations[convId].contextUsage;
    expect(usage?.tokensUsed).toBe(800);
    expect(tokenEstimatorModule.estimateToolSchemaTokens).toHaveBeenCalledTimes(1);
    expect(tokenEstimatorModule.estimateMessageTokens).toHaveBeenCalledTimes(1);
    expect(tokenEstimatorModule.estimateTokens).not.toHaveBeenCalled();
  });

  it('handles missing API key gracefully', async () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          apiFormat: 'anthropic',
          apiKey: '', // Empty API key
          // The pinned model must still be listed, otherwise the availability
          // guard (not the key check) is what refuses the run.
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000, maxOutputTokens: 8192 }],
          enabled: true,
        },
      ],
      activeModel: { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
    });

    const convId = useChatStore.getState().createConversation();
    await runAgentLoop(convId, 'Hello');

    // Should have added an error message about API key
    const conv = useChatStore.getState().conversations[convId];
    const errorMsg = conv.messages.find(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('API Key'),
    );
    expect(errorMsg).toBeDefined();

    // Regression: user message must also be persisted, not orphaned by the early return.
    // Bug history: error branch only added the assistant warning, leaving the chat with
    // a lone "请先配置 API Key" bubble and no user input above it.
    const userMsg = conv.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toBe('Hello');
    // User and assistant messages should share the same loopId (one logical turn).
    expect(userMsg?.loopId).toBeDefined();
    expect(userMsg?.loopId).toBe(errorMsg?.loopId);
  });

  it('keeps the user message when routing fails before the loop starts', async () => {
    // Regression: routing produces the cleanInput the user message is built
    // from, so it runs BEFORE that message is persisted. A throw there escaped
    // as an unhandled rejection and the typed input vanished with no trace —
    // the composer had already cleared.
    const orchestration = await import('../core/agent/entryOrchestration');
    const spy = vi
      .spyOn(orchestration, 'precomputeOrchestration')
      .mockRejectedValue(new Error('skill index unavailable'));

    try {
      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'route me somewhere');

      expect(result.reason).toBe('error');

      const conv = useChatStore.getState().conversations[convId];
      const userMsg = conv.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toBe('route me somewhere');

      const errorMsg = conv.messages.find(
        (m) => m.role === 'assistant'
          && typeof m.content === 'string'
          && m.content.includes('skill index unavailable'),
      );
      expect(errorMsg).toBeDefined();
      expect(userMsg?.loopId).toBe(errorMsg?.loopId);
    } finally {
      spy.mockRestore();
    }
  });

  it('shows an actionable local error and skips the provider when the latest input is too large', async () => {
    vi.mocked(contextManagerModule.enforceContextBudget).mockImplementationOnce(() => {
      throw new contextManagerModule.ContextBudgetError('INPUT_TOO_LARGE', 20_000, 10_000);
    });

    const convId = useChatStore.getState().createConversation();
    await runAgentLoop(convId, 'oversized input');

    expect(mockClaudeChat).not.toHaveBeenCalled();
    const assistantText = useChatStore.getState().conversations[convId].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    expect(assistantText).toMatch(/上下文容量|too large/i);
  });

  it('explains a model whose window cannot hold the instructions in plain words', async () => {
    vi.mocked(contextManagerModule.enforceContextBudget).mockImplementationOnce(() => {
      throw new contextManagerModule.ContextBudgetError('FIXED_CONTEXT_TOO_LARGE', 20_000, 10_000);
    });

    const convId = useChatStore.getState().createConversation();
    await runAgentLoop(convId, 'hello');

    expect(mockClaudeChat).not.toHaveBeenCalled();
    const assistantText = useChatStore.getState().conversations[convId].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    expect(assistantText).toContain('This model can remember too little at once to hold the instructions Abu needs. Switch to a model that can remember more.');
    // 一句普通说明，前面不带错误前缀
    expect(assistantText).not.toContain('Error:');
    expect(assistantText).not.toContain('raise the context length');
  });

  it('replaces the raw provider text when the request stays too long after recovery', async () => {
    const overflow = new LLMError('raw provider overflow text', 'context_too_long', { retryable: false, statusCode: 400 });
    // 第一次是正常请求，第二次是整理内容后的重试
    mockClaudeChat.mockRejectedValueOnce(overflow).mockRejectedValueOnce(overflow);

    const convId = useChatStore.getState().createConversation();
    const result = await runAgentLoop(convId, 'hello');

    expect(result.reason).toBe('error');
    expect(mockClaudeChat).toHaveBeenCalledTimes(2);
    const assistantText = useChatStore.getState().conversations[convId].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    expect(assistantText).toContain('This model can remember too little at once to hold the instructions Abu needs.');
    expect(assistantText).not.toContain('Error:');
    expect(assistantText).not.toContain('raw provider overflow text');
  });

  it('escalateMaxOutputTokens pure function works correctly', () => {
    // Already tested in agentLoop.test.ts, but verify integration
    const result = escalateMaxOutputTokens(8192, 200000, 1);
    expect(result.maxOutputTokens).toBe(16384);
    expect(result.changed).toBe(true);
  });

  // Regression coverage for the loop-termination work (B turn cap / C structured
  // exit reason / A no-progress guard). These drive runAgentLoop end-to-end with
  // the mocked adapter and assert the reason it returns to callers.
  describe('loop termination reasons', () => {
    // agentMaxTurns is global state; reset it so the small-cap test below can't
    // bleed into the others (which rely on the default 200 cap).
    afterEach(() => {
      useSettingsStore.setState({ agentMaxTurns: undefined });
    });

    it('stops with reason=no_progress after 3 turns of all-unparseable tool calls', async () => {
      // A guard: a model emitting only malformed tool calls used to spin
      // (continueLoop is set on the tool_use branch regardless of parse errors)
      // up to maxTurns. It must now abort after MAX_NO_PROGRESS_TURNS.
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `bad-${calls}`, name: 'read_file', input: { _parse_error: 'bad json' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      expect(result.reason).toBe('no_progress');
      expect(calls).toBe(3); // two tolerated retries, abort on the third
    });

    it('quietly asks the model to rewrite a malformed operation once, then carries on', async () => {
      let calls = 0;
      const sent: unknown[] = [];
      mockClaudeChat.mockImplementation(
        async (messages: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          sent.push(messages);
          if (calls === 1) {
            onEvent({ type: 'malformed_tool_call', raw: '<tool_call>{"name":' });
          } else {
            onEvent({ type: 'text', text: 'rewritten properly' });
          }
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      expect(result.reason).toBe('completed');
      expect(calls).toBe(2);
      expect(JSON.stringify(sent[1])).toContain('could not be parsed');
      const messages = useChatStore.getState().conversations[convId].messages;
      const visible = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).not.toContain('<tool_call>');
      expect(visible).not.toContain(getI18n().chat.malformedToolCall);
      expect(visible).toContain('rewritten properly');
      // 给模型的纠错消息只进模型的上下文，聊天界面不显示
      const nudge = messages.find((m) => String(m.content).includes('could not be parsed'));
      expect(nudge?.isSystem).toBe(true);
      expect(messages.filter((m) => !m.isSystem).map((m) => String(m.content)).join(''))
        .not.toContain('could not be parsed');
    });

    it('tells the user in one sentence when the rewrite is malformed too', async () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'malformed_tool_call', raw: '<invoke name="read_file">' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      expect(calls).toBe(2);
      // 操作没有做成，按未完成结束，定时任务等后台调用方不会当成成功
      expect(result.reason).toBe('no_progress');
      const visible = useChatStore.getState().conversations[convId].messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).toContain(getI18n().chat.malformedToolCall);
      // 按普通说明显示，前面不带错误前缀
      expect(visible).not.toContain('Error:');
      expect(visible).not.toContain('<invoke');
    });

    it('ends as no_progress after giving up even when a system wake-up is waiting', async () => {
      const { hasSystemQueuedInputs } = await import('../core/agent/userInputQueue');
      // 等待中的系统唤醒只有一条：取走之后就没有了
      let pendingWakeUps = 1;
      vi.mocked(hasSystemQueuedInputs).mockImplementation(() => pendingWakeUps-- > 0);
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'malformed_tool_call', raw: '<invoke name="read_file">' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      try {
        const convId = useChatStore.getState().createConversation();
        const result = await runAgentLoop(convId, 'do the thing');

        // 放弃之后本次运行结束，系统唤醒留给下一次运行开始时取走
        expect(result.reason).toBe('no_progress');
        expect(calls).toBe(2);
        const visible = useChatStore.getState().conversations[convId].messages
          .filter((m) => m.role === 'assistant')
          .map((m) => String(m.content))
          .join('');
        expect(visible.split(getI18n().chat.malformedToolCall).length - 1).toBe(1);
      } finally {
        vi.mocked(hasSystemQueuedInputs).mockImplementation(() => false);
      }
    });

    it('does not let an unparseable native call restore the rewrite chance', async () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          if (calls === 2) {
            onEvent({ type: 'tool_use', id: 'bad-native', name: 'read_file', input: { _parse_error: 'bad json' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
            return;
          }
          onEvent({ type: 'malformed_tool_call', raw: '<invoke name="read_file">' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      // 写坏 → 无法解析的原生调用 → 再写坏：第二次写坏直接放弃
      expect(calls).toBe(3);
      expect(result.reason).toBe('no_progress');
      const visible = useChatStore.getState().conversations[convId].messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).toContain(getI18n().chat.malformedToolCall);
    });

    it('rewrites quietly again after a proper operation came in between', async () => {
      let calls = 0;
      const sent: unknown[] = [];
      mockClaudeChat.mockImplementation(
        async (messages: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          sent.push(messages);
          if (calls === 2) {
            onEvent({ type: 'tool_use', id: 'good-native', name: 'read_file', input: { path: '/x' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
          } else if (calls === 4) {
            onEvent({ type: 'text', text: 'all done' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          } else {
            onEvent({ type: 'malformed_tool_call', raw: '<invoke name="read_file">' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          }
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      // 写坏 → 正常操作 → 再写坏：第二次写坏仍然悄悄重写一次
      expect(calls).toBe(4);
      expect(result.reason).toBe('completed');
      expect(JSON.stringify(sent[3]).split('could not be parsed').length - 1).toBe(2);
      const visible = useChatStore.getState().conversations[convId].messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).not.toContain(getI18n().chat.malformedToolCall);
      expect(visible).toContain('all done');
    });

    it('treats an operation cut off by the output limit as a truncation and keeps the rewrite for later', async () => {
      let calls = 0;
      const sent: unknown[] = [];
      mockClaudeChat.mockImplementation(
        async (messages: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          sent.push(messages);
          if (calls === 1) {
            onEvent({ type: 'malformed_tool_call', raw: '<tool_call>{"name":"read_file","arguments":{"path"' });
            onEvent({ type: 'done', stopReason: 'max_tokens' });
          } else if (calls === 2) {
            onEvent({ type: 'malformed_tool_call', raw: '<invoke name="read_file">' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          } else {
            onEvent({ type: 'text', text: 'done at last' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          }
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      expect(result.reason).toBe('completed');
      expect(calls).toBe(3);
      // 被截断的那一次只走截断续写，不消耗写坏重写的机会
      expect(JSON.stringify(sent[1])).toContain('Output token limit reached');
      expect(JSON.stringify(sent[1])).not.toContain('could not be parsed');
      expect(JSON.stringify(sent[2])).toContain('could not be parsed');
      const visible = useChatStore.getState().conversations[convId].messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).not.toContain(getI18n().chat.malformedToolCall);
      expect(visible).toContain('done at last');
    });

    it('stops at the truncation limit when every reply is an operation cut off by the output limit', async () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'malformed_tool_call', raw: '<tool_call>{"name":"write_file","arguments":{"content":"' });
          onEvent({ type: 'done', stopReason: 'max_tokens' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'do the thing');

      // 第一次加三次截断续写，写坏重写一次也没有发生
      expect(calls).toBe(4);
      expect(result.reason).toBe('error');
      const visible = useChatStore.getState().conversations[convId].messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content))
        .join('');
      expect(visible).not.toContain(getI18n().chat.malformedToolCall);
      const conversationText = JSON.stringify(useChatStore.getState().conversations[convId].messages);
      expect(conversationText).not.toContain('could not be parsed');
    });

    it('stops a well-formed repeated tool loop after three unchanged observations', async () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({
            type: 'tool_use',
            id: `search-${calls}`,
            name: 'tool_search',
            input: { query: 'computer' },
          });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );
      const repeatedBatch = {
        mcpChanged: false,
        requiresUserRecovery: false,
        observations: [{
          name: 'tool_search',
          input: { query: 'computer' },
          result: 'no deferred tools',
          images: [],
          error: false,
        }],
      };
      vi.mocked(executeToolBatch)
        .mockResolvedValueOnce(repeatedBatch)
        .mockResolvedValueOnce(repeatedBatch)
        .mockResolvedValueOnce(repeatedBatch);

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'operate the computer');

      expect(result.reason).toBe('no_progress');
      expect(calls).toBe(3);
    });

    it('promotes only after a successful tool_search observation in the loop process', async () => {
      const rareTool = {
        name: 'rare_clipboard',
        description: 'Read clipboard',
        inputSchema: { type: 'object' as const, properties: {} },
        execute: async () => 'ok',
      };
      vi.mocked(toolSearchModule.classifyTools).mockReturnValueOnce({
        coreTools: [],
        deferredTools: [rareTool],
      });
      mockClaudeChat
        .mockImplementationOnce(
          async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
            onEvent({
              type: 'tool_use',
              id: 'search-1',
              name: 'tool_search',
              input: { query: 'clipboard' },
            });
            onEvent({ type: 'done', stopReason: 'tool_use' });
          },
        )
        .mockImplementationOnce(
          async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
            onEvent({ type: 'text', text: 'ready' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          },
        );
      vi.mocked(executeToolBatch).mockResolvedValueOnce({
        mcpChanged: false,
        requiresUserRecovery: false,
        observations: [{
          name: 'tool_search',
          input: { query: 'clipboard' },
          result: '### rare_clipboard\nRead clipboard',
          images: [],
          error: false,
        }],
      });

      const convId = useChatStore.getState().createConversation();
      await runAgentLoop(convId, 'read my clipboard');

      expect(toolSearchModule.promoteSearchedDeferredTools).toHaveBeenCalledWith(
        { query: 'clipboard' },
        [rareTool],
        convId,
      );
    });

    it('stops with reason=max_turns when the turn cap is reached', async () => {
      // B+C: the cap is now always finite (was unlimited by default), and the cap
      // branch must report 'max_turns' to callers, not the old silent 'completed'.
      useSettingsStore.setState({ agentMaxTurns: 2 });
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'loop on tools');

      expect(result.reason).toBe('max_turns');
      expect(calls).toBe(2); // turn 3's top-of-loop check trips before its LLM call
    });

    it('tells the model the steps left on every request from the threshold on, never in the prompt or the history', async () => {
      // Cap 10: the threshold is the floor of 5 steps left, so requests 6 to 10 carry the note.
      useSettingsStore.setState({ agentMaxTurns: 10 });
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: `/x${calls}` } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'loop on tools');

      expect(result.reason).toBe('max_turns');
      const requests = mockClaudeChat.mock.calls.map(([messages, options]) => ({
        messages: messages as Message[],
        options: options as { systemPrompt?: string; volatileContextTail?: string },
      }));
      expect(requests.map((r) => /\[(Only \d+ steps are left|This is the last model request)/.exec(r.options.volatileContextTail ?? '')?.[1] ?? null)).toEqual([
        null, null, null, null, null,
        'Only 5 steps are left', 'Only 4 steps are left', 'Only 3 steps are left', 'Only 2 steps are left', 'This is the last model request',
      ]);
      const NOTE = /steps are left|last model request in this run/;
      for (const r of requests) {
        expect(r.options.systemPrompt ?? '').not.toMatch(NOTE);
        expect(JSON.stringify(r.messages)).not.toMatch(NOTE);
      }
      expect(JSON.stringify(useChatStore.getState().conversations[convId].messages)).not.toMatch(NOTE);
    });


    it('stops with reason=awaiting_user when a tool requires sandbox recovery', async () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({
            type: 'tool_use',
            id: 'blocked-automation',
            name: 'run_command',
            input: { command: 'osascript -e \'tell application "Notes" to activate\'' },
          });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );
      vi.mocked(executeToolBatch).mockResolvedValueOnce({
        mcpChanged: false,
        requiresUserRecovery: true,
        observations: [],
      });

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'create a note');

      expect(result.reason).toBe('awaiting_user');
      expect(calls).toBe(1);
      expect(useChatStore.getState().conversations[convId]?.status).toBe('idle');
    });

    it('reports reason=aborted (not completed) when cancelled between turns', async () => {
      // Regression for the pre-existing bug the structured-reason work fixes: the
      // top-of-loop abort break never set exitReason, so a run cancelled between
      // turns returned 'completed' and scheduler/trigger pushed its partial output
      // as a success.
      const convId = useChatStore.getState().createConversation();
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
          // Cancel after this turn's stream — the NEXT iteration's top-of-loop
          // abort check is what should fire.
          useChatStore.getState().cancelStreaming(convId);
        },
      );

      const result = await runAgentLoop(convId, 'start, then get cancelled');

      expect(result.reason).toBe('aborted');
    });

    it('drops the untouched assistant placeholder when the turn aborts before any output', async () => {
      // Regression: every turn writes an empty assistant placeholder before
      // streaming. An abort that fires before any text/thinking/tool call
      // used to leave it behind (empty, or holding only the stop marker),
      // rendering as a blank assistant bubble.
      const convId = useChatStore.getState().createConversation();
      mockClaudeChat.mockImplementation(async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await runAgentLoop(convId, 'aborted before output');

      expect(result.reason).toBe('aborted');
      const conv = useChatStore.getState().conversations[convId];
      const ghosts = conv.messages.filter((m) => {
        if (m.role !== 'assistant') return false;
        const raw = typeof m.content === 'string' ? m.content : '';
        const text = raw.replace('*[已停止]*', '').trim();
        return text.length === 0 && !(m.toolCalls?.length) && !m.thinking;
      });
      expect(ghosts).toHaveLength(0);
    });

    it('second runAgentLoop on a running conversation enqueues instead of racing', async () => {
      // Regression: the entry sequence clearAbortController→getAbortController
      // replaces the map entry WITHOUT aborting the previous loop, so a rapid
      // double-send (before React flips isRunning) spawned two concurrent
      // loops on one conversation — the earlier one unstoppable.
      const { enqueueUserInput } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let streamCalls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          streamCalls++;
          await gate; // keep the first loop in flight
          onEvent({ type: 'text', text: 'done' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const first = runAgentLoop(convId, 'first message');
      await new Promise((r) => setTimeout(r, 20)); // let the first loop reach the LLM call

      const second = await runAgentLoop(convId, 'second message');

      expect(second.reason).toBe('enqueued');
      expect(vi.mocked(enqueueUserInput)).toHaveBeenCalledWith(convId, 'second message');
      // Codex-style staging: the queued message must NOT appear in the
      // transcript yet — it surfaces only when the running loop drains it.
      const msgs = useChatStore.getState().conversations[convId].messages;
      expect(msgs.some((m) => m.role === 'user' && m.content === 'second message')).toBe(false);

      release();
      await first;
      expect(streamCalls).toBe(1); // no concurrent second stream
    });

    it('report_plan tool_use event does NOT pre-land plannedSteps (approval decides)', async () => {
      // Regression: plannedSteps used to be written at tool_use time — before
      // approval — so a REJECTED plan still showed up in the progress panel.
      // They now land inside the tool's execute() only for approved/safe plans.
      const convId = useChatStore.getState().createConversation();
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'tool_use', id: 't-plan', name: 'report_plan', input: { steps: ['删除文件'] } });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      await runAgentLoop(convId, 'plan only');

      const execs = Object.values(useTaskExecutionStore.getState().executions)
        .filter((e) => e.conversationId === convId);
      expect(execs.every((e) => e.plannedSteps.length === 0)).toBe(true);
    });

    it('drained system wake-ups remain hidden user-context messages', async () => {
      const { drainSystemQueuedInputs } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation();
      vi.mocked(drainSystemQueuedInputs).mockReturnValueOnce([
        { id: 'q1', text: '后台任务完成', timestamp: 123, isSystem: true },
      ]);
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'text', text: '好的' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      await runAgentLoop(convId, '从1数到3');

      const conv = useChatStore.getState().conversations[convId];
      const queuedMsg = conv.messages.find((m) => m.role === 'user' && m.content === '后台任务完成');
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg?.isSystem).toBe(true);
    });

    it('keeps an aborted turn that already streamed partial text', async () => {
      // The ghost cleanup must not eat turns with real progress.
      const convId = useChatStore.getState().createConversation();
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'text', text: '正在分析问题…' });
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        },
      );

      const result = await runAgentLoop(convId, 'partial text then abort');

      expect(result.reason).toBe('aborted');
      const conv = useChatStore.getState().conversations[convId];
      const partial = conv.messages.find(
        (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('正在分析问题'),
      );
      expect(partial).toBeDefined();
    });

    it('runs skill cleanup when the turn cap is hit (review finding [3])', async () => {
      // The max_turns break used to skip the terminal cleanup that every other exit
      // path runs. Now that the cap is always finite this path is routine, so a skill
      // left active would bleed into the user's NEXT message. Assert it deactivates.
      useSettingsStore.setState({ agentMaxTurns: 2 });
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      // Mark a skill active — the single-turn lifecycle requires every terminal
      // path (including max_turns) to clear it.
      useChatStore.setState((s: { conversations: Record<string, { activeSkills?: string[] }> }) => {
        const c = s.conversations[convId];
        if (c) c.activeSkills = ['test-skill'];
      });

      const result = await runAgentLoop(convId, 'loop until capped');

      expect(result.reason).toBe('max_turns');
      expect(useChatStore.getState().conversations[convId].activeSkills).toEqual([]);
    });

    // The cap used to end the run as `status: 'completed'` under the copy
    // "已完成 N 轮执行" — so a leader (and the user) read a run that stopped
    // mid-task as a finished one. `max_turns` is an INCOMPLETE reason
    // everywhere else (isIncompleteReason, the scheduler); the chat UI now
    // says the same thing.
    it('ends the turn cap as unfinished, not completed (P2)', async () => {
      useSettingsStore.setState({ agentMaxTurns: 2 });
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const previousLanguage = getLanguageSetting();
      setLanguage('zh-CN');
      let result;
      try {
        result = await runAgentLoop(convId, 'loop until capped');
      } finally {
        setLanguage(previousLanguage);
      }

      expect(result.reason).toBe('max_turns');
      const conv = useChatStore.getState().conversations[convId];
      // Not a terminal 'completed': the task is unfinished and the user can
      // just keep typing.
      expect(conv.status).toBe('idle');
      expect(conv.completedAt).toBeUndefined();
      // The cap now ends in a notice CARD (a `max-turns-` marker with the cap
      // it hit), not a sentence — so nothing here can read as "已完成" either.
      const capMsg = conv.messages.at(-1)!;
      expect(isMaxTurnsNoticeMessage(capMsg)).toBe(true);
      expect(capMsg.maxTurnsNotice).toEqual({ limit: 2, streak: 1 });
      expect(String(capMsg.content)).not.toContain('已完成');
      // 'completed' used to be what cleared the per-conversation agent state
      // (the活动 indicator). Idle must clear it just as thoroughly.
      expect(useChatStore.getState().agentStates.has(convId)).toBe(false);
    });

    // The `@agent` route runs the child through runSubagent directly, so it
    // never passes through `delegate_to_agent` and never gets that tool's
    // `delegateStoppedNote`. It used to post the child's raw partial text as
    // the assistant answer and go idle in silence — the user read a truncated
    // answer as the final one.
    it('tells the user when an @agent delegate ran out of turns', async () => {
      const { routeInput } = await import('../core/agent/orchestrator');
      vi.mocked(routeInput).mockReturnValueOnce({
        type: 'delegate', cleanInput: 'Do the long thing.', name: 'abu',
        delegateAgent: { name: 'researcher', description: 'research', systemPrompt: 'research', filePath: '__preset__' },
      } as never);
      // Same recipe as the main-loop cap above: a small global cap plus an
      // adapter that never stops calling tools. subagentLoop.ts resolves the
      // same global setting (definition > global > default), and the delegate
      // card carries no maxTurns of its own, so the child's cap is 2.
      useSettingsStore.setState({ agentMaxTurns: 2 });
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'text', text: `partial ${calls}` });
          onEvent({ type: 'tool_use', id: `d-${calls}`, name: 'read_file', input: { path: '/x' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      // This file's `vi.mock('../../utils/notifications')` never resolves from
      // src/__tests__/, so the real facade runs — spy on it locally instead of
      // repairing a shared mock the other tests in this file already run without.
      const completedSpy = vi.spyOn(notifications, 'notifyTaskCompleted').mockResolvedValue(undefined);

      const convId = useChatStore.getState().createConversation();
      const previousLanguage = getLanguageSetting();
      setLanguage('zh-CN');
      let result;
      try {
        result = await runAgentLoop(convId, 'Do the long thing.');
      } finally {
        setLanguage(previousLanguage);
        completedSpy.mockRestore();
      }

      expect(result.reason).toBe('max_turns');
      const conv = useChatStore.getState().conversations[convId];
      // Unfinished, not finished: no green "done", no completion notification.
      expect(conv.status).toBe('idle');
      expect(completedSpy).not.toHaveBeenCalled();
      // The cap note comes AFTER the partial result, and carries the number the
      // child actually ran with.
      const assistantMsgs = conv.messages.filter((m) => m.role === 'assistant');
      const capMsg = assistantMsgs.at(-1);
      expect(String(capMsg?.content)).toBe('已达到 2 轮上限，任务未完成。直接发送消息即可继续。');
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
      expect(String(assistantMsgs.at(-2)?.content)).not.toContain('已达到');
    });

    it('resets the no-progress counter when a system wake-up rescues the loop (review finding [5])', async () => {
      // Without the reset, a mid-stream user rescue buys only ONE more turn before
      // the (still-3) counter trips. With it, the full 3-turn tolerance is restored:
      // turns 1-3 trip the guard, the rescue at turn 3 resets it, turns 4-6 trip it
      // again → stop at turn 6 (calls===6). Without the reset it would stop at turn 4.
      const { hasSystemQueuedInputs } = await import('../core/agent/userInputQueue');
      vi.mocked(hasSystemQueuedInputs).mockReturnValueOnce(true); // rescue exactly once (turn 3)

      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          onEvent({ type: 'tool_use', id: `bad-${calls}`, name: 'read_file', input: { _parse_error: 'bad' } });
          onEvent({ type: 'done', stopReason: 'tool_use' });
        },
      );

      const convId = useChatStore.getState().createConversation();
      const result = await runAgentLoop(convId, 'spin, get rescued, spin again');

      expect(result.reason).toBe('no_progress');
      expect(calls).toBe(6);
    });

    it('pauses staged user follow-ups instead of attaching them to the aborted run', async () => {
      const { pauseUserInputQueue, drainSystemQueuedInputs } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation();
      mockClaudeChat.mockImplementation(async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await runAgentLoop(convId, 'abort with staged input');

      expect(result.reason).toBe('aborted');
      expect(pauseUserInputQueue).toHaveBeenCalledWith(convId);
      expect(drainSystemQueuedInputs).toHaveBeenCalledWith(convId);
      expect(useChatStore.getState().conversations[convId].messages).not.toContainEqual(
        expect.objectContaining({ role: 'user', content: '别丢了我' }),
      );
    });

    it('rejects an image-only send during a running in-process loop instead of starting a second stream (F6)', async () => {
      // The mid-run queue is text-only. An image send must stay with the
      // composer and wait for the current run; falling through replaces the
      // live AbortController and races two streams on one conversation.
      const { enqueueUserInput } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let streamCalls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          streamCalls++;
          if (streamCalls === 1) await gate; // keep the first loop in flight
          onEvent({ type: 'text', text: 'done' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const first = runAgentLoop(convId, 'first message');
      await new Promise((r) => setTimeout(r, 20)); // let the first loop reach the LLM call

      const second = await runAgentLoop(convId, '', {
        images: [{ id: 'img-1', data: 'aGk=', mediaType: 'image/png' }],
      });

      expect(second.reason).toBe('error');
      expect(vi.mocked(enqueueUserInput)).not.toHaveBeenCalled();

      release();
      await first;
      expect(streamCalls).toBe(1);
    });

    it('rejects a headless send during a running in-process loop instead of starting a second stream', async () => {
      const { enqueueUserInput } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation(undefined, {
        scheduledTaskId: 'schedule-1',
        skipActivate: true,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let streamCalls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          streamCalls++;
          await gate;
          onEvent({ type: 'text', text: 'done' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      const first = runAgentLoop(convId, 'scheduled first');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await runAgentLoop(convId, 'overlapping scheduler delivery');

      expect(second.reason).toBe('error');
      expect(vi.mocked(enqueueUserInput)).not.toHaveBeenCalled();
      release();
      await first;
      expect(streamCalls).toBe(1);
    });
  });

  describe('steering: messages typed while the run works', () => {
    const toolStepThenAnswer = () => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          if (calls === 1) {
            onEvent({ type: 'tool_use', id: 't-1', name: 'read_file', input: { path: '/x' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
            return;
          }
          onEvent({ type: 'text', text: '好的，已改成蓝色' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );
    };

    it('takes them after a tool step and puts them, in order, before the next model request', async () => {
      const { takeSteeringInputs } = await import('../core/agent/userInputQueue');
      toolStepThenAnswer();
      vi.mocked(takeSteeringInputs).mockResolvedValueOnce([
        { id: 'q1', text: '改成蓝色', timestamp: 11, delivery: 'steer' },
        { id: 'q2', text: '标题也改短', timestamp: 12, delivery: 'steer' },
      ]);
      const convId = useChatStore.getState().createConversation();

      const result = await runAgentLoop(convId, '做一张图表');

      expect(result.reason).toBe('completed');
      // Once, at the step after the tool step: not before the first request,
      // not after the final answer.
      // The take names the run: only what was typed into it is handed out.
      const runLoopId = useChatStore.getState().conversations[convId].messages[0].loopId;
      expect(vi.mocked(takeSteeringInputs)).toHaveBeenCalledExactlyOnceWith(convId, runLoopId);
      const takeOrder = vi.mocked(takeSteeringInputs).mock.invocationCallOrder[0];
      expect(takeOrder).toBeGreaterThan(mockClaudeChat.mock.invocationCallOrder[0]);
      expect(takeOrder).toBeLessThan(mockClaudeChat.mock.invocationCallOrder[1]);

      const secondRequest = mockClaudeChat.mock.calls[1][0] as Message[];
      const tail = secondRequest.slice(-3).map((m) => [m.role, m.role === 'user' ? m.content : 'step']);
      expect(tail).toEqual([['assistant', 'step'], ['user', '改成蓝色'], ['user', '标题也改短']]);

      const messages = useChatStore.getState().conversations[convId].messages;
      const loopId = messages[0].loopId;
      const steered = messages.filter((m) => m.steered);
      expect(steered.map((m) => ({ id: m.id, role: m.role, content: m.content, loopId: m.loopId, timestamp: m.timestamp })))
        .toEqual([
          { id: 'steer-q1', role: 'user', content: '改成蓝色', loopId, timestamp: 11 },
          { id: 'steer-q2', role: 'user', content: '标题也改短', loopId, timestamp: 12 },
        ]);
      // In the transcript after the tool step and before the answer.
      const index = (id: string) => messages.findIndex((m) => m.id === id);
      const toolStep = messages.findIndex((m) => m.toolCalls?.some((tc) => tc.id === 't-1'));
      const answer = messages.findIndex((m) => m.role === 'assistant' && m.content === '好的，已改成蓝色');
      expect(toolStep).toBeLessThan(index('steer-q1'));
      expect(index('steer-q2')).toBe(index('steer-q1') + 1);
      expect(index('steer-q2')).toBeLessThan(answer);
      expect(steered.every((m) => !m.isSystem)).toBe(true);
    });

    it('a run that answers in plain text takes nothing: what was typed starts its own turn', async () => {
      const { takeSteeringInputs } = await import('../core/agent/userInputQueue');
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'text', text: '这是最终答案' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );
      const convId = useChatStore.getState().createConversation();

      await runAgentLoop(convId, '你好');

      expect(vi.mocked(takeSteeringInputs)).not.toHaveBeenCalled();
    });

    it('the final answer after the last tool step takes nothing more', async () => {
      const { takeSteeringInputs } = await import('../core/agent/userInputQueue');
      toolStepThenAnswer();
      const convId = useChatStore.getState().createConversation();

      await runAgentLoop(convId, '做一张图表');

      // Taken once, before the answer; the answer ends the run with no take.
      expect(vi.mocked(takeSteeringInputs)).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().conversations[convId].messages.some((m) => m.steered)).toBe(false);
    });

    it('Stop during the take gives the messages back instead of showing them', async () => {
      const { takeSteeringInputs, restoreSteeringInputs, pauseUserInputQueue, endSteeringRun } = await import('../core/agent/userInputQueue');
      toolStepThenAnswer();
      const convId = useChatStore.getState().createConversation();
      const taken = [{ id: 'q1', text: '先别发', timestamp: 11, delivery: 'steer' as const }];
      vi.mocked(takeSteeringInputs).mockImplementationOnce(async () => {
        useChatStore.getState().getAbortController(convId).abort();
        return taken;
      });

      const result = await runAgentLoop(convId, '发邮件');

      expect(result.reason).toBe('aborted');
      expect(vi.mocked(restoreSteeringInputs)).toHaveBeenCalledExactlyOnceWith(convId, taken);
      expect(vi.mocked(pauseUserInputQueue)).toHaveBeenCalledWith(convId);
      // The run's steering ends before the pause, so the restored entry is
      // paused as one for after the task.
      expect(vi.mocked(endSteeringRun).mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(restoreSteeringInputs).mock.invocationCallOrder[0]);
      expect(vi.mocked(endSteeringRun).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(pauseUserInputQueue).mock.invocationCallOrder.at(-1)!);
      expect(useChatStore.getState().conversations[convId].messages.some((m) => m.steered)).toBe(false);
      expect(mockClaudeChat).toHaveBeenCalledTimes(1);
    });

    it('a step the turn cap stops is never handed a message', async () => {
      const { takeSteeringInputs } = await import('../core/agent/userInputQueue');
      const defaultMaxTurns = useSettingsStore.getState().agentMaxTurns;
      useSettingsStore.setState({ agentMaxTurns: 2 });
      try {
        let calls = 0;
        mockClaudeChat.mockImplementation(
          async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
            calls++;
            onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
          },
        );
        const convId = useChatStore.getState().createConversation();

        const result = await runAgentLoop(convId, 'loop until capped');

        expect(result.reason).toBe('max_turns');
        // After step 1 (step 2 runs); never after step 2, which hits the cap.
        expect(vi.mocked(takeSteeringInputs)).toHaveBeenCalledTimes(1);
      } finally {
        // The file's beforeEach merges settings: a cap left here would stop
        // every later multi-step run early.
        useSettingsStore.setState({ agentMaxTurns: defaultMaxTurns });
      }
    });

    it('a run reads steering from the start of its own steps to its end; a run nobody watches never does', async () => {
      const { beginSteeringRun, endSteeringRun } = await import('../core/agent/userInputQueue');
      toolStepThenAnswer();
      const convId = useChatStore.getState().createConversation();

      await runAgentLoop(convId, '做一张图表');
      const loopId = useChatStore.getState().conversations[convId].messages[0].loopId;
      expect(vi.mocked(beginSteeringRun).mock.calls).toEqual([[convId, loopId]]);
      expect(vi.mocked(endSteeringRun)).toHaveBeenCalledWith(convId, loopId);
      expect(vi.mocked(endSteeringRun).mock.invocationCallOrder.at(-1)!)
        .toBeGreaterThan(vi.mocked(beginSteeringRun).mock.invocationCallOrder[0]);

      vi.mocked(beginSteeringRun).mockClear();
      toolStepThenAnswer();
      await runAgentLoop(useChatStore.getState().createConversation(), '定时汇总', { initiatedBy: 'automation' });
      expect(vi.mocked(beginSteeringRun)).not.toHaveBeenCalled();
    });

    it('a run nobody is watching (automation) takes nothing', async () => {
      const { takeSteeringInputs } = await import('../core/agent/userInputQueue');
      toolStepThenAnswer();
      const convId = useChatStore.getState().createConversation();

      await runAgentLoop(convId, '定时汇总', { initiatedBy: 'automation' });

      expect(vi.mocked(takeSteeringInputs)).not.toHaveBeenCalled();
    });
  });

  // Tester additions (P7): the in-process loop against the REAL input queue,
  // so a message typed into the queue, the loop's take, a restore and the
  // pause on Stop are the product's own code end to end.
  describe('steering against the real input queue (tester)', () => {
    type Queue = typeof import('../core/agent/userInputQueue');
    let real: Queue;
    let mocked: Queue;
    const touched: string[] = [];

    beforeEach(async () => {
      // The file's beforeEach merges settings, so a turn cap an earlier test
      // set (the steering block's 'a step the turn cap stops ...' sets 2)
      // would otherwise stop these multi-step runs early.
      useSettingsStore.setState({ agentMaxTurns: useSettingsStore.getInitialState().agentMaxTurns });
      real = await vi.importActual<Queue>('../core/agent/userInputQueue');
      mocked = await import('../core/agent/userInputQueue');
      vi.mocked(mocked.takeSteeringInputs).mockImplementation(real.takeSteeringInputs);
      vi.mocked(mocked.restoreSteeringInputs).mockImplementation(real.restoreSteeringInputs);
      vi.mocked(mocked.pauseUserInputQueue).mockImplementation(real.pauseUserInputQueue);
      vi.mocked(mocked.clearInputQueue).mockImplementation(real.clearInputQueue);
      vi.mocked(mocked.beginSteeringRun).mockImplementation(real.beginSteeringRun);
      vi.mocked(mocked.endSteeringRun).mockImplementation(real.endSteeringRun);
      vi.mocked(mocked.requeueUserInput).mockImplementation(real.requeueUserInput);
    });

    afterEach(() => {
      vi.mocked(mocked.takeSteeringInputs).mockReset().mockResolvedValue([]);
      vi.mocked(mocked.restoreSteeringInputs).mockReset();
      vi.mocked(mocked.pauseUserInputQueue).mockReset();
      vi.mocked(mocked.clearInputQueue).mockReset();
      vi.mocked(mocked.beginSteeringRun).mockReset();
      vi.mocked(mocked.endSteeringRun).mockReset();
      vi.mocked(mocked.requeueUserInput).mockReset();
      for (const id of touched.splice(0)) real.clearInputQueue(id);
    });

    const newConversation = (): string => {
      const id = useChatStore.getState().createConversation();
      touched.push(id);
      return id;
    };

    /** The model calls a tool `toolSteps` times, then answers. */
    const toolStepsThenAnswer = (toolSteps: number) => {
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          if (calls <= toolSteps) {
            onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
            return;
          }
          onEvent({ type: 'text', text: '完成' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );
    };

    /** Runs `typing` while the n-th tool step executes (the user types while the task works). */
    const typeDuringToolStep = (typing: () => void) => {
      vi.mocked(executeToolBatch).mockImplementationOnce(async () => {
        typing();
        return { mcpChanged: false, requiresUserRecovery: false, observations: [] };
      });
    };

    const requestTail = (call: number, count: number) => (mockClaudeChat.mock.calls[call][0] as Message[])
      .slice(-count)
      .map((m) => [m.role, m.role === 'user' ? m.content : 'step']);

    const userTexts = (convId: string) => useChatStore.getState().conversations[convId].messages
      .filter((m) => m.role === 'user')
      .map((m) => [m.content, m.steered ?? false]);

    it('two messages typed during one tool step arrive together, in order, right after the step', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      typeDuringToolStep(() => {
        real.enqueueUserInput(convId, '只要华东区');
        real.enqueueUserInput(convId, '/ppt 做成汇报'); // names its own route: waits for the end
        real.enqueueUserInput(convId, '按月排序');
      });

      const result = await runAgentLoop(convId, '整理销售表');

      expect(result.reason).toBe('completed');
      expect(requestTail(1, 3)).toEqual([['assistant', 'step'], ['user', '只要华东区'], ['user', '按月排序']]);
      expect(userTexts(convId)).toEqual([['整理销售表', false], ['只要华东区', true], ['按月排序', true]]);
      expect(real.getQueuedInputs(convId).map((item) => [item.text, item.delivery])).toEqual([['/ppt 做成汇报', undefined]]);
    });

    // Re-review addition (P7): on the sidecar path the shell opens a watched
    // run for steering when it registers it, before the loop has routed. An
    // `@expert` turn has no step of its own, so the loop ends that steering at
    // once and what was typed waits for after the turn.
    it('an @expert turn reads no steering: a message the shell bound to the run waits for after the turn', async () => {
      const { routeInput } = await import('../core/agent/orchestrator');
      vi.mocked(routeInput).mockReturnValueOnce({
        type: 'delegate', cleanInput: '查一下十月的销量', name: 'abu',
        delegateAgent: { name: 'researcher', description: 'research', systemPrompt: 'research', filePath: '__preset__' },
      } as never);
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'text', text: '查好了' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );
      const completedSpy = vi.spyOn(notifications, 'notifyTaskCompleted').mockResolvedValue(undefined);
      const convId = newConversation();
      real.beginSteeringRun(convId, 'loop-expert');
      expect(real.enqueueUserInput(convId, '只看华东区')).toMatchObject({ delivery: 'steer', runId: 'loop-expert' });

      let reason: string | undefined;
      try {
        reason = (await runAgentLoop(convId, '@researcher 查一下十月的销量', { loopId: 'loop-expert' })).reason;
      } finally {
        completedSpy.mockRestore();
      }

      // The expert answered the whole turn (the delegate branch returns before the loop's own end).
      expect(reason).toBe('completed');
      expect(mockClaudeChat).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mocked.endSteeringRun)).toHaveBeenCalledWith(convId, 'loop-expert');
      expect(vi.mocked(mocked.takeSteeringInputs)).not.toHaveBeenCalled();
      expect(useChatStore.getState().conversations[convId].messages.some((m) => m.steered)).toBe(false);
      expect(real.getQueuedInputs(convId).map((item) => [item.text, item.delivery])).toEqual([['只看华东区', undefined]]);
      expect(real.enqueueUserInput(convId, '再加一句结论')?.delivery).toBeUndefined();
    });

    it('a message typed while the take is in flight is delivered exactly once, at the next step', async () => {
      toolStepsThenAnswer(2);
      const convId = newConversation();
      typeDuringToolStep(() => { real.enqueueUserInput(convId, 'early'); });
      vi.mocked(mocked.takeSteeringInputs).mockImplementationOnce(async (id: string, runId: string) => {
        const taken = await real.takeSteeringInputs(id, runId);
        real.enqueueUserInput(id, 'late'); // typed between the take and the message
        return taken;
      });

      await runAgentLoop(convId, '做报表');

      expect(requestTail(1, 2)).toEqual([['assistant', 'step'], ['user', 'early']]);
      expect(requestTail(2, 2)).toEqual([['assistant', 'step'], ['user', 'late']]);
      expect(userTexts(convId)).toEqual([['做报表', false], ['early', true], ['late', true]]);
      expect(real.getQueuedInputs(convId)).toEqual([]);
    });

    it('a message typed during the take of the last step is not lost: it waits once in the queue for its own turn', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      vi.mocked(mocked.takeSteeringInputs).mockImplementationOnce(async (id: string, runId: string) => {
        const taken = await real.takeSteeringInputs(id, runId);
        real.enqueueUserInput(id, 'late');
        return taken;
      });

      await runAgentLoop(convId, '做报表');

      expect(userTexts(convId)).toEqual([['做报表', false]]);
      expect(real.getQueuedInputs(convId).map((item) => item.text)).toEqual(['late']);
    });

    it('Stop pressed exactly during the take: the messages wait as paused chips for after the task, and none is shown', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      typeDuringToolStep(() => {
        real.enqueueUserInput(convId, '先别发邮件');
        real.enqueueUserInput(convId, '改成草稿');
      });
      vi.mocked(mocked.takeSteeringInputs).mockImplementationOnce(async (id: string, runId: string) => {
        const taken = await real.takeSteeringInputs(id, runId);
        useChatStore.getState().getAbortController(id).abort();
        return taken;
      });

      const result = await runAgentLoop(convId, '发邮件');

      expect(result.reason).toBe('aborted');
      expect(mockClaudeChat).toHaveBeenCalledTimes(1);
      expect(userTexts(convId)).toEqual([['发邮件', false]]);
      expect(real.getQueuedInputs(convId).map((item) => [item.text, item.delivery])).toEqual([
        ['先别发邮件', undefined],
        ['改成草稿', undefined],
      ]);
      expect(real.isUserInputQueuePaused(convId)).toBe(true);
    });

    it('a message typed into another conversation is not taken by this run', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      const other = newConversation();
      typeDuringToolStep(() => { real.enqueueUserInput(other, '这是另一个对话的'); });

      await runAgentLoop(convId, '做报表');

      expect(userTexts(convId)).toEqual([['做报表', false]]);
      expect(real.getQueuedInputs(other).map((item) => item.text)).toEqual(['这是另一个对话的']);
    });

    // Found by the tester: same as the sidecar path (agentLoopRunner.test.ts,
    // "a run of a conversation deleted after a take ..."): the conversation is
    // deleted during the take; deleteConversation clears the queue, then the
    // loop restored the taken entries into it.
    it('a conversation deleted during the take keeps no queued entries afterwards', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      typeDuringToolStep(() => { real.enqueueUserInput(convId, '先别发'); });
      vi.mocked(mocked.takeSteeringInputs).mockImplementationOnce(async (id: string, runId: string) => {
        const taken = await real.takeSteeringInputs(id, runId);
        // What chatStore.deleteConversation does, in its order (the action
        // itself needs store mocks this file does not set up): abort the run,
        // clear the conversation's queue, drop the record.
        useChatStore.getState().getAbortController(id).abort('conversation-deleted');
        real.clearInputQueue(id);
        useChatStore.setState((state) => {
          const { [id]: _deleted, ...rest } = state.conversations;
          return { conversations: rest };
        });
        return taken;
      });

      await runAgentLoop(convId, '发邮件').catch(() => undefined);

      expect(real.getQueuedInputs(convId)).toEqual([]);
    });

    it('a queued hand-off that meets the live run goes back for after it: the loop never takes it as a message', async () => {
      toolStepsThenAnswer(1);
      const convId = newConversation();
      const handoff = { id: 'qi-before', text: '最后再总结三句话', timestamp: 7 };
      let staged: Promise<{ reason: string }> | undefined;
      // Another surface's dispatcher hands off an entry typed for the run before, while this run works.
      typeDuringToolStep(() => { staged = runAgentLoop(convId, handoff.text, { queuedHandoff: handoff }); });

      const result = await runAgentLoop(convId, '整理销售表');

      expect(result.reason).toBe('completed');
      await expect(staged).resolves.toEqual({ reason: 'enqueued' });
      expect(vi.mocked(mocked.enqueueUserInput)).not.toHaveBeenCalled();
      expect(userTexts(convId)).toEqual([['整理销售表', false]]);
      expect(real.getQueuedInputs(convId)).toEqual([handoff]);
    });

    // The sequence the harness cannot drive (one inject per run, no Stop):
    // Stop a task, start a new one, steer the new one, then resume the queue.
    it('Stop, then a new task the user steers: the new task reads its correction, the stopped one\'s message waits and later joins nothing', async () => {
      // The model's steps across the three runs, in order.
      const script: Array<'tool' | 'answer'> = ['tool', 'tool', 'answer', 'tool', 'answer'];
      let calls = 0;
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          calls++;
          if (script.shift() === 'tool') {
            onEvent({ type: 'tool_use', id: `t-${calls}`, name: 'read_file', input: { path: '/x' } });
            onEvent({ type: 'done', stopReason: 'tool_use' });
            return;
          }
          onEvent({ type: 'text', text: '完成' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );
      const convId = newConversation();

      // Run A: the user types a correction during its tool step, then presses
      // Stop while the run takes it.
      typeDuringToolStep(() => { real.enqueueUserInput(convId, '先别发邮件'); });
      vi.mocked(mocked.takeSteeringInputs).mockImplementationOnce(async (id: string, runId: string) => {
        const taken = await real.takeSteeringInputs(id, runId);
        useChatStore.getState().getAbortController(id).abort();
        return taken;
      });
      expect((await runAgentLoop(convId, '发邮件')).reason).toBe('aborted');
      expect(real.isUserInputQueuePaused(convId)).toBe(true);
      expect(real.getQueuedInputs(convId).map((item) => [item.text, item.delivery])).toEqual([['先别发邮件', undefined]]);
      const requestsOfA = mockClaudeChat.mock.calls.length;

      // Run C: the user starts a new task by sending normally and types a
      // correction during its tool step. The paused queue does not hold it back.
      typeDuringToolStep(() => { real.enqueueUserInput(convId, '标题改成周报'); });
      expect((await runAgentLoop(convId, '写周报')).reason).toBe('completed');
      expect(requestTail(requestsOfA + 1, 2)).toEqual([['assistant', 'step'], ['user', '标题改成周报']]);
      const messages = useChatStore.getState().conversations[convId].messages;
      const loopOfC = messages.find((m) => m.role === 'user' && m.content === '写周报')?.loopId;
      expect(messages.filter((m) => m.steered).map((m) => [m.content, m.loopId])).toEqual([['标题改成周报', loopOfC]]);
      // A's message still waits, paused, for after the task.
      expect(real.getQueuedInputs(convId).map((item) => [item.text, item.delivery])).toEqual([['先别发邮件', undefined]]);

      // 「继续队列」: A's message starts its own run D, which is handed nothing.
      real.resumeUserInputQueue(convId);
      const next = real.dequeueNextUserInput(convId)!;
      expect(next.text).toBe('先别发邮件');
      expect((await runAgentLoop(convId, next.text)).reason).toBe('completed');
      expect(useChatStore.getState().conversations[convId].messages.filter((m) => m.steered)).toHaveLength(1);
      expect(real.getQueuedInputs(convId)).toEqual([]);
    });
  });

  describe('persistExecutionSnapshot', () => {
    it('stores plannedSteps on the loop\'s last assistant message and evicts the execution (F3)', () => {
      // Regression: eviction destroyed plannedSteps with the execution, so the
      // progress panel collapsed to the placeholder after every finished loop.
      // Note steps=[] — plannedSteps alone must still be persisted.
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'a-plan', role: 'assistant', content: '计划完成', timestamp: 1, loopId: 'loop-f3',
      });
      useTaskExecutionStore.setState({
        executions: {
          'exec-f3': {
            id: 'exec-f3',
            conversationId: convId,
            loopId: 'loop-f3',
            status: 'completed',
            startTime: 1,
            plannedSteps: [{ index: 1, description: '步骤一', status: 'completed' }],
            planParsed: true,
            steps: [],
          },
        },
        loopIdIndex: { 'loop-f3': 'exec-f3' },
      });

      persistExecutionSnapshot(convId, 'loop-f3');

      const msg = useChatStore.getState().conversations[convId].messages.find((m) => m.id === 'a-plan');
      expect(msg?.plannedSteps).toEqual([{ index: 1, description: '步骤一', status: 'completed' }]);
      expect(useTaskExecutionStore.getState().executions['exec-f3']).toBeUndefined();
    });
  });

  describe('context warning level after compression', () => {
    // Restore estimateMessageTokens to its default stub value after each test
    // to prevent bleed-through into the sibling tests above.
    afterEach(() => {
      vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(200);
    });

    it('publishes the provider\'s input count of what was sent, not the size of the raw history', async () => {
      // Setup:
      //  - A conversation with 10 history messages (would be Critical by the
      //    local estimate: estimateMessageTokens returns 180 000 for large arrays)
      //  - A compaction divider covering messages 0-7, so what is sent is tiny:
      //    [summary, msg8, msg9, the new turn] → well under every threshold
      //  - The LLM does 2 tool-use turns, then returns end_turn; every reply
      //    reports 1 234 input tokens
      //
      // Expected: the ring shows 1 234, and its categories add up to it.

      // --- Token estimator override ------------------------------------------
      // Large message array (raw history, ≥ 8 msgs) → 180 000 tokens.
      // What is sent (summary + the messages after the divider) stays below 8.
      vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockImplementation(
        (msgs: Message[]) => (msgs.length >= 8 ? 180_000 : 200),
      );

      // --- Conversation setup ------------------------------------------------
      const convId = useChatStore.getState().createConversation();
      const chatStoreState = useChatStore.getState();

      // Fixed anchor (TESTING.md §3) — only the relative spacing between
      // messages matters here, not the absolute value.
      const now = 1_700_000_000_000;
      const historyMsgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
        id: `hist-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `History message ${i} — ${'x'.repeat(200)}`,
        timestamp: now - (10 - i) * 1000,
      }));

      // Inject history messages using the proper store action
      for (const msg of historyMsgs) {
        chatStoreState.addMessage(convId, msg);
      }
      chatStoreState.addMessage(convId, createCompactBoundaryMarker({
        summaryText: 'Compressed summary of earlier conversation',
        summarizedFromId: 'hist-0',
        summarizedToId: 'hist-7',
        keptUserMessageIds: [],
        restoredFiles: [],
        source: 'manual',
        timestamp: now - 500,
      }));

      // --- LLM mock ----------------------------------------------------------
      let llmCallCount = 0;
      mockClaudeChat.mockImplementation(
        async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
          llmCallCount++;
          onEvent({ type: 'usage', usage: { inputTokens: 1_234, outputTokens: 10 } });
          if (llmCallCount <= 2) {
            // Emit one tool call so the loop continues
            onEvent({
              type: 'tool_use',
              id: `tool-${llmCallCount}`,
              name: 'read_file',
              input: { path: '/tmp/test.txt' },
            });
            onEvent({ type: 'done', stopReason: 'tool_use' });
          } else {
            // Final turn: plain text response, end the loop
            onEvent({ type: 'text', text: 'Done.' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
          }
        },
      );

      // --- Run the agent loop ------------------------------------------------
      await runAgentLoop(convId, 'Summarize the history');

      // --- Assertion ---------------------------------------------------------
      const conv = useChatStore.getState().conversations[convId];
      expect(conv.contextUsage?.percent).toBeLessThan(60);

      // --- Anchor invariant --------------------------------------------------
      // The published snapshot must ALSO say how much of the conversation its
      // token count stands for. Here `tokensUsed` is the provider's count of the
      // compacted request, but the anchor spans the full raw history — that
      // pairing is what stops ContextIndicator from re-counting (and thereby
      // un-compressing) the history and rendering a >100% water level.
      const usage = conv.contextUsage!;
      expect(usage.messageCountAtPublish).toBeGreaterThanOrEqual(historyMsgs.length);
      expect(usage.messageCountAtPublish).toBeLessThanOrEqual(conv.messages.length);
      expect(usage.tokensUsed).toBe(1_234);

      expect(usage.breakdown?.version).toBe(1);
      const breakdown = usage.breakdown!;
      expect(
        breakdown.systemPrompt
          + breakdown.tools
          + breakdown.mcp
          + breakdown.skills
          + breakdown.conversation,
      ).toBe(usage.tokensUsed);
    });
  });
});
