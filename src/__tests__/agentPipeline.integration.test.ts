/**
 * Agent Pipeline Integration Test
 *
 * Tests the full message → LLM → tool execution → response pipeline.
 * Uses mocked LLM adapter to simulate various response scenarios.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTaskExecutionStore } from '../stores/taskExecutionStore';
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
  // Real prepareContextMessages returns Message[] — mirror that. (Previously
  // returned an object, which was silently tolerated until the send path
  // started calling array methods on the result via rehydrateImageData.)
  prepareContextMessages: vi.fn().mockImplementation((msgs) => msgs),
  trimOldScreenshots: vi.fn().mockImplementation((msgs) => msgs),
}));

vi.mock('../core/context/contextCompressor', () => ({
  compressContextIfNeeded: vi.fn().mockResolvedValue(false),
}));

vi.mock('../core/context/microCompactor', () => ({
  applyMicroCompaction: vi.fn().mockImplementation((msgs) => msgs),
}));

vi.mock('../core/context/autoCompact', () => ({
  AutoCompactTracker: class {
    recordUsage = vi.fn();
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
    shouldCompact = vi.fn().mockReturnValue(false);
    shouldForceHardTruncation = vi.fn().mockReturnValue(false);
    isDisabled = vi.fn().mockReturnValue(false);
    getLastLevel = vi.fn().mockReturnValue(0);
    // updateLevel mirrors the real calculateWarningLevel thresholds so that
    // token-count-based tests (like the post-compression warning level test)
    // get the correct 0/1/2/3 output instead of a hardcoded stub value.
    updateLevel = vi.fn().mockImplementation((tokens: number, maxInput: number): 0 | 1 | 2 | 3 => {
      if (maxInput <= 0) return 0;
      const ratio = tokens / maxInput;
      if (ratio >= 0.85) return 3;
      if (ratio >= 0.75) return 2;
      if (ratio >= 0.60) return 1;
      return 0;
    });
  },
  getUsagePercent: vi.fn().mockReturnValue(0.3),
}));

vi.mock('../core/context/tokenEstimator', () => ({
  estimateToolSchemaTokens: vi.fn().mockReturnValue(500),
  estimateTokens: vi.fn().mockReturnValue(100),
  estimateMessageTokens: vi.fn().mockReturnValue(200),
  calibrateFromUsage: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock('../core/context/contextUtils', () => ({
  identifyRounds: vi.fn().mockReturnValue([]),
  RECENT_ROUNDS_TO_KEEP: 4,
}));

// Mock misc
vi.mock('../core/agent/retry', () => ({
  withRetry: vi.fn().mockImplementation((fn) => fn()),
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
  clearInputQueue: vi.fn(),
  hasQueuedInputs: vi.fn().mockReturnValue(false),
  enqueueUserInput: vi.fn(),
}));

vi.mock('../core/agent/executionSnapshot', () => ({
  snapshotExecutionSteps: vi.fn().mockReturnValue([]),
}));

vi.mock('../core/agent/lifecycleHooks', () => ({
  emitHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/tools/builtins', () => ({
  clearAllSkillHooks: vi.fn(),
}));

vi.mock('../core/agent/toolExecutor', () => ({
  executeToolBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

vi.mock('../core/capabilities', () => ({
  getBuiltinSearchConfig: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../core/llm/modelCapabilities', () => ({
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
  resolveEffectiveContextWindow: vi.fn().mockImplementation(
    (_modelId: string, userSetting?: number, discovered?: number) => {
      // Mirror the real implementation: min of model cap (200000 here) + user + discovered
      const candidates = [200000];
      if (typeof userSetting === 'number' && userSetting > 0) candidates.push(userSetting);
      if (typeof discovered === 'number' && discovered > 0) candidates.push(discovered);
      return Math.min(...candidates);
    },
  ),
  deriveUiCaps: vi.fn().mockReturnValue([]),
}));

vi.mock('../core/tools/toolNames', () => ({
  TOOL_NAMES: {
    WEB_SEARCH: 'web_search',
    DELEGATE_TO_AGENT: 'delegate_to_agent',
    SHOW_WIDGET: 'show_widget',
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
}));

vi.mock('../core/skill/preprocessor', () => ({
  substituteVariables: vi.fn().mockImplementation((content) => content),
}));

vi.mock('../core/skill/toolFilter', () => ({
  matchesToolName: vi.fn().mockReturnValue(true),
  parseToolPatterns: vi.fn().mockReturnValue({ inputValidators: new Map() }),
}));

vi.mock('../../utils/notifications', () => ({
  notifyTaskCompleted: vi.fn(),
  notifyTaskError: vi.fn(),
}));

vi.mock('../../utils/pathUtils', () => ({
  joinPath: vi.fn().mockImplementation((...parts: string[]) => parts.join('/')),
}));

vi.mock('../../utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

// Now import the module under test
import { runAgentLoop, escalateMaxOutputTokens, persistExecutionSnapshot } from '../core/agent/agentLoop';
import type { StreamEvent, Message } from '../types';
// Mocked module reference — used to override token estimator per-test
import * as tokenEstimatorModule from '../core/context/tokenEstimator';

describe('Agent Pipeline Integration', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
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
  });

  it('handles missing API key gracefully', async () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          apiFormat: 'anthropic',
          apiKey: '', // Empty API key
          models: [],
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

    it('drained queued messages surface as user bubbles at consumption time', async () => {
      const { drainQueuedInputs } = await import('../core/agent/userInputQueue');
      const convId = useChatStore.getState().createConversation();
      vi.mocked(drainQueuedInputs).mockReturnValueOnce([
        { id: 'q1', text: '数完说你好', timestamp: 123 },
      ]);
      mockClaudeChat.mockImplementation(
        async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
          onEvent({ type: 'text', text: '好的' });
          onEvent({ type: 'done', stopReason: 'end_turn' });
        },
      );

      await runAgentLoop(convId, '从1数到3');

      const conv = useChatStore.getState().conversations[convId];
      const queuedMsg = conv.messages.find((m) => m.role === 'user' && m.content === '数完说你好');
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg?.isSystem).toBeFalsy();
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

    it('resets the no-progress counter when a queued-input override rescues the loop (review finding [5])', async () => {
      // Without the reset, a mid-stream user rescue buys only ONE more turn before
      // the (still-3) counter trips. With it, the full 3-turn tolerance is restored:
      // turns 1-3 trip the guard, the rescue at turn 3 resets it, turns 4-6 trip it
      // again → stop at turn 6 (calls===6). Without the reset it would stop at turn 4.
      const { hasQueuedInputs } = await import('../core/agent/userInputQueue');
      vi.mocked(hasQueuedInputs).mockReturnValueOnce(true); // rescue exactly once (turn 3)

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

    it('surfaces staged queue messages as user bubbles when the loop aborts (F5)', async () => {
      // Regression: the abort path called clearInputQueue directly, silently
      // destroying messages the user staged mid-loop. They must land in the
      // transcript instead — the aborted loop can't answer them, but the text
      // has to stay visible.
      const { drainQueuedInputs } = await import('../core/agent/userInputQueue');
      // Drain is called at the top of each loop iteration AND (now) in the
      // abort path: 1st call = loop top (empty), 2nd call = abort drain (item).
      vi.mocked(drainQueuedInputs)
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ id: 'q9', text: '别丢了我', timestamp: 1 }]);
      const convId = useChatStore.getState().createConversation();
      mockClaudeChat.mockImplementation(async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await runAgentLoop(convId, 'abort with staged input');

      expect(result.reason).toBe('aborted');
      const conv = useChatStore.getState().conversations[convId];
      const staged = conv.messages.find((m) => m.role === 'user' && m.content === '别丢了我');
      expect(staged).toBeDefined();
    });

    it('image-only send during a running loop starts a normal loop instead of staging (F6)', async () => {
      // Regression: the concurrency guard staged EVERY interactive send into
      // the text-only queue — an image-only send was swallowed entirely.
      // Image/empty sends must fall through to a normal loop start.
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

      expect(second.reason).not.toBe('enqueued');
      expect(vi.mocked(enqueueUserInput)).not.toHaveBeenCalled();

      release();
      await first;
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

    it('drops warningLevel to 0 when cache-hit compression brings payload under threshold', async () => {
      // Regression test for the bug where contextWarningLevel was computed on
      // pre-compression tokens, causing a stuck Critical banner even after
      // cached compression brought the actual payload below the threshold.
      //
      // Setup:
      //  - A conversation with 10 history messages (would be Level 3 / Critical
      //    without compression: estimateMessageTokens returns 180 000 for large arrays)
      //  - A contextCache covering messages 0-7, so the post-compression payload
      //    is tiny: [summaryMessage, msg8, msg9] — 3 messages → Level 0
      //  - The LLM does 2 tool-use turns (so turnCount reaches 3 in the loop
      //    where the cache-hit check fires), then returns end_turn on turn 3
      //
      // Expected: after runAgentLoop, contextUsage.percent < 60 (Level 0 threshold)

      // --- Token estimator override ------------------------------------------
      // Large message array (pre-cache history, turns 1+2, ≥ 8 msgs) → 180 000 tokens → Level 3
      // Small message array (post-cache, turn 3, 6 msgs) → 200 tokens → Level 0
      // maxInputTokens = 200 000 - 8 192 = 191 808
      // Level-3 threshold = 85% × 191 808 ≈ 163 000
      // 180 000 + 100 (sys) + 500 (tools) = 180 600 > 163 000 → Level 3 pre-cache
      // 200 + 100 + 500 = 800 / 191 808 ≈ 0.4% → Level 0 post-cache
      // Turn 1 & 2 have 11/12 history messages (≥ 8) → 180 000 tokens → Level 3.
      // Turn 3 cache-hit yields 6 messages (summaryMessage + slice(8) of 13) → Level 0.
      // Threshold 8 sits between post-cache (6) and pre-cache (11/12) counts.
      vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockImplementation(
        (msgs: Message[]) => (msgs.length >= 8 ? 180_000 : 200),
      );

      // --- Conversation setup ------------------------------------------------
      const convId = useChatStore.getState().createConversation();
      const chatStoreState = useChatStore.getState();

      // Build a history of 10 messages so the cache check fires correctly.
      // runAgentLoop appends the user message, making the effective history
      // 10 messages when it slices messages.slice(0, -1) on each turn.
      const now = Date.now();
      const historyMsgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
        id: `hist-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `History message ${i} — ${'x'.repeat(200)}`,
        timestamp: now - (10 - i) * 1000,
      }));

      // summaryMessage stands in for the cached compression output
      const summaryMessage: Message = {
        id: 'context-summary-cached',
        role: 'assistant',
        content: '[Compressed summary of earlier conversation]',
        timestamp: now - 5000,
      };

      // Inject history messages using the proper store action
      for (const msg of historyMsgs) {
        chatStoreState.addMessage(convId, msg);
      }

      // Attach contextCache using the proper store action.
      // messageCountAtCompression = 5 ≤ 10 → cache is considered valid.
      // summarizedRange = [0, 8] → newMessages = historyMessages.slice(8) = msgs 8 & 9 (2 msgs)
      // post-compression messagesForContext = [] + summaryMessage + [msg8, msg9] = 3 msgs
      chatStoreState.setContextCache(convId, {
        summaryMessage,
        summarizedRange: [0, 8],
        messageCountAtCompression: 5,
      });

      // --- LLM mock ----------------------------------------------------------
      // Turn 1: tool_use → continueLoop = true (turnCount = 1)
      // Turn 2: tool_use → continueLoop = true (turnCount = 2)
      // Turn 3: end_turn  → loop ends      (turnCount = 3 → cache check fires)
      let llmCallCount = 0;
      mockClaudeChat.mockImplementation(
        async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
          llmCallCount++;
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
      // The post-compression payload is 6 messages → ~800 tokens → Level 0.
      // Before the T2 bug fix this would have been Level 3 because the warning
      // level was computed on the pre-compression (10+) message history.
      const conv = useChatStore.getState().conversations[convId];
      expect(conv.contextUsage?.percent).toBeLessThan(60);
    });
  });
});
