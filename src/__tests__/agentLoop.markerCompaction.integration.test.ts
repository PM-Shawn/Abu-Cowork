/**
 * Integration tests for the compact-boundary marker compaction path (P1 Part A, marker version).
 *
 * Tests A3 + A4 wiring in agentLoop.ts:
 *   A4 (send-side): buildContextFromBoundary pre-empts the 65% path when a marker exists.
 *   A3 (trigger):   at 85%+ postCompressionTokens + turnCount≥3, summarizeConversation +
 *                   createCompactBoundaryMarker are called and the marker is appended to
 *                   the store via addMessage (append-only, no rewrite of existing messages).
 *
 * Tests:
 *   1. ≥85% + turnCount≥3 → marker appended; every original seed message still present,
 *      content byte-identical (append-only, #1 data-loss class cannot happen).
 *   2. <85% → NO marker created.
 *   3. Successful marker creation clears the ephemeral 65% contextCache.
 *   4. At most one marker per runAgentLoop (persistentCompactionDone flag).
 *   5. Pre-existing marker → send-side delivers compact context to LLM (no compact-boundary
 *      messages, contains the summary user message).
 *   6. Without a marker the 65% compressContextIfNeeded path is still called (no regression).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTaskExecutionStore } from '../stores/taskExecutionStore';
import type { StreamEvent, Message } from '../types';
import {
  isCompactBoundary,
  createCompactBoundaryMarker,
} from '../core/context/compactBoundary';

// ── workspaceStore mock ──────────────────────────────────────────────────────
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

// ── LLM adapter mocks ────────────────────────────────────────────────────────
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

// ── Tool registry ────────────────────────────────────────────────────────────
vi.mock('../core/tools/registry', () => ({
  getAllTools: vi.fn().mockReturnValue([
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ result: 'file content' }),
    },
  ]),
}));

// ── Orchestrator ─────────────────────────────────────────────────────────────
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

// ── Event router ─────────────────────────────────────────────────────────────
vi.mock('../core/agent/eventRouter', () => ({
  createEventRouter: vi.fn().mockReturnValue({
    route: vi.fn(),
    createStepForToolUse: vi.fn().mockReturnValue('step-1'),
    completeStep: vi.fn(),
    addChildStepToDelegate: vi.fn(),
    completeChildStep: vi.fn(),
  }),
}));

// ── Skill loader ─────────────────────────────────────────────────────────────
vi.mock('../core/skill/loader', () => ({
  skillLoader: {
    getSkill: vi.fn().mockReturnValue(null),
    refreshSkill: vi.fn().mockResolvedValue(null),
    listSupportingFiles: vi.fn().mockResolvedValue([]),
  },
}));

// ── Context manager — pass-through (returns Message[] directly) ───────────────
vi.mock('../core/context/contextManager', () => ({
  prepareContextMessages: vi.fn().mockImplementation((msgs: Message[]) => msgs),
  trimOldScreenshots: vi.fn().mockImplementation((msgs: Message[]) => msgs),
}));

// ── 65% send-only compressor: never compresses + summarize returns fixed text ─
vi.mock('../core/context/contextCompressor', () => ({
  compressContextIfNeeded: vi.fn().mockResolvedValue({
    compressed: false,
    messages: [],
    savedTokens: 0,
  }),
  summarizeConversation: vi.fn().mockResolvedValue('Mocked summary of the middle messages.'),
}));

vi.mock('../core/context/microCompactor', () => ({
  applyMicroCompaction: vi.fn().mockImplementation((msgs: Message[]) => msgs),
}));

// ── autoCompact tracker ──────────────────────────────────────────────────────
vi.mock('../core/context/autoCompact', () => ({
  AutoCompactTracker: class {
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
    shouldCompact = vi.fn().mockReturnValue(false);
    shouldForceHardTruncation = vi.fn().mockReturnValue(false);
    isDisabled = vi.fn().mockReturnValue(false);
    getLastLevel = vi.fn().mockReturnValue(0);
    updateLevel = vi.fn().mockImplementation(
      (tokens: number, maxInput: number): 0 | 1 | 2 | 3 => {
        if (maxInput <= 0) return 0;
        const ratio = tokens / maxInput;
        if (ratio >= 0.85) return 3;
        if (ratio >= 0.75) return 2;
        if (ratio >= 0.60) return 1;
        return 0;
      },
    );
  },
  getUsagePercent: vi.fn().mockImplementation((tokens: number, max: number) =>
    max > 0 ? Math.round((tokens / max) * 100) : 0,
  ),
}));

// ── Token estimator — values overridden per-test ─────────────────────────────
vi.mock('../core/context/tokenEstimator', () => ({
  estimateToolSchemaTokens: vi.fn().mockReturnValue(500),
  estimateTokens: vi.fn().mockReturnValue(5000),
  estimateMessageTokens: vi.fn().mockReturnValue(200), // default: well below 85%
  calibrateFromUsage: vi.fn(),
  setActiveModel: vi.fn(),
}));

// ── contextUtils — realistic identifyRounds split on user messages ────────────
vi.mock('../core/context/contextUtils', () => ({
  identifyRounds: vi.fn().mockImplementation((messages: Message[]) => {
    const rounds: Message[][] = [];
    let current: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        rounds.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) rounds.push(current);
    return rounds;
  }),
  RECENT_ROUNDS_TO_KEEP: 4,
}));

// ── conversationStorage — full mock; no real disk I/O in integration test ────
vi.mock('../core/session/conversationStorage', () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
  replaceMessageById: vi.fn().mockResolvedValue(undefined),
  updateLastMessage: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadIndex: vi.fn().mockResolvedValue({ version: 1, entries: {} }),
  deleteConversationFiles: vi.fn().mockResolvedValue(undefined),
  removeIndexEntry: vi.fn().mockResolvedValue(undefined),
  migrateConversation: vi.fn().mockResolvedValue(undefined),
  flushWrites: vi.fn().mockResolvedValue(undefined),
  initConversationStorage: vi.fn().mockResolvedValue(undefined),
  loadConversation: vi.fn().mockResolvedValue(undefined),
  loadArchive: vi.fn().mockResolvedValue([]),
  appendArchive: vi.fn().mockResolvedValue(0),
  updateIndexEntry: vi.fn().mockResolvedValue(undefined),
  flushIndex: vi.fn().mockResolvedValue(undefined),
}));

// ── Misc mocks ────────────────────────────────────────────────────────────────
vi.mock('../core/agent/retry', () => ({
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
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
  executeToolBatch: vi.fn().mockResolvedValue({ continueLoop: false, mcpChanged: false }),
}));
vi.mock('../core/agent/todoManager', () => ({
  formatTodosForPrompt: vi.fn().mockReturnValue(''),
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
  computeReasoningParams: vi.fn().mockReturnValue({ maxTokens: 8192, enableThinking: false }),
  resolveEffectiveContextWindow: vi.fn().mockReturnValue(200000),
  deriveUiCaps: vi.fn().mockReturnValue([]),
}));
vi.mock('../core/tools/toolNames', () => ({
  TOOL_NAMES: { WEB_SEARCH: 'web_search', DELEGATE_TO_AGENT: 'delegate_to_agent' },
}));
vi.mock('../core/tools/toolPrefetch', () => ({
  prefetchTools: vi.fn().mockReturnValue([]),
}));
vi.mock('../core/tools/toolSearch', () => ({
  classifyTools: vi.fn().mockImplementation((tools: unknown[]) => ({
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
  getSessionOutputDir: vi.fn().mockResolvedValue('/tmp/test'),
}));
vi.mock('../core/llm/promptSections', () => ({
  sectionsToString: vi.fn().mockReturnValue('system prompt'),
  mergeSections: vi.fn().mockImplementation((a: unknown[], b?: unknown[]) => [
    ...(a || []),
    ...(b || []),
  ]),
}));
vi.mock('../core/skill/preprocessor', () => ({
  substituteVariables: vi.fn().mockImplementation((content: unknown) => content),
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
vi.mock('../core/enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: vi.fn().mockReturnValue({ apiKey: 'test-key', baseUrl: undefined }),
  EnterpriseLlmUnavailableError: class extends Error {},
}));
vi.mock('../core/observability/langfuse', () => ({
  startConversationTrace: vi.fn(),
  endConversationTrace: vi.fn(),
  startGeneration: vi.fn().mockReturnValue({ end: vi.fn() }),
}));
vi.mock('../core/llm/costTracker', () => ({
  calculateTurnCost: vi.fn().mockReturnValue(0),
}));
vi.mock('../core/agent/subagentLoop', () => ({
  runSubagentLoop: vi.fn(),
  extractParentConversationSummary: vi.fn().mockReturnValue(''),
}));
vi.mock('../utils/consoleError', () => ({
  reportError: vi.fn(),
}));
vi.mock('../core/agent/loopGuards', () => ({
  allToolsUnparseable: vi.fn().mockReturnValue(false),
  MAX_NO_PROGRESS_TURNS: 3,
  resolveMaxTurns: vi.fn().mockReturnValue(200),
}));
vi.mock('../core/agent/proposalSignal', () => ({
  computeProposalSignal: vi.fn().mockReturnValue(null),
}));
vi.mock('../core/memdir/relevance', () => ({
  findRelevantMemories: vi.fn().mockResolvedValue([]),
  formatRelevantMemoriesSection: vi.fn().mockReturnValue(''),
  extractQueryText: vi.fn().mockReturnValue(''),
}));

// ── Module under test ─────────────────────────────────────────────────────────
import { runAgentLoop } from '../core/agent/agentLoop';
import * as tokenEstimatorModule from '../core/context/tokenEstimator';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  content = 'message content',
): Message {
  return { id, role, content, timestamp: Date.now() };
}

/** 7 user+assistant pairs — enough rounds for computeCompactionPlan to find middle messages. */
function makeSeedMessages(): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < 7; i++) {
    msgs.push(makeMsg(`u${i}`, 'user', `User round ${i}`));
    msgs.push(makeMsg(`a${i}`, 'assistant', `Assistant round ${i}`));
  }
  return msgs;
}

/** Reset stores and return a conversationId pre-seeded with 7 rounds. */
function setupStore(): string {
  useChatStore.setState({
    conversations: {},
    activeConversationId: null,
    agentStatus: 'idle',
    currentTool: null,
    currentUsage: null,
    pendingInput: null,
    thinkingStartTime: null,
  });
  useTaskExecutionStore.setState({ executions: {} });
  useSettingsStore.setState({
    providers: [
      {
        id: 'anthropic',
        source: 'builtin' as const,
        name: 'Anthropic',
        apiFormat: 'anthropic' as const,
        apiKey: 'test-key',
        baseUrl: '',
        models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4', contextWindow: 200000 }],
        enabled: true,
        status: 'unchecked' as const,
        sortOrder: 0,
      },
    ],
    activeModel: { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
  });
  const convId = useChatStore.getState().createConversation();
  useChatStore.setState((state) => {
    const c = state.conversations[convId];
    if (c) c.messages = makeSeedMessages();
  });
  return convId;
}

/** LLM mock: tool_use × 2 turns, then text + end_turn on turn 3. */
function mockLlmThreeTurns(): void {
  let callCount = 0;
  mockClaudeChat.mockImplementation(
    async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
      callCount++;
      if (callCount < 3) {
        onEvent({ type: 'tool_use', id: `t-${callCount}`, name: 'read_file', input: { path: '/x' } });
        onEvent({ type: 'done', stopReason: 'tool_use' });
      } else {
        onEvent({ type: 'text', text: 'Done' });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      }
    },
  );
}

/** LLM mock: single turn ending immediately (end_turn). */
function mockLlmOneTurn(text = 'Hello'): void {
  mockClaudeChat.mockImplementation(
    async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
      onEvent({ type: 'text', text });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Marker Compaction Integration (P1 Part A — marker version)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default token mock: well below 85% so tests opt in explicitly
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(200);
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);
  });

  afterEach(() => {
    useSettingsStore.setState({ agentMaxTurns: undefined });
  });

  // ── Test 1: ≥85% triggers marker; original messages untouched ─────────────
  it('appends a compact-boundary marker and leaves every original message intact when context ≥ 85%', async () => {
    // contextWindow=200000, maxOutput=8192 → maxInput=191808; 85% ≈ 163037 tokens
    // 5000 + 165000 + 500 = 170500 (≈89%) → triggers A3
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(165000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);

    mockLlmThreeTurns();
    const convId = setupStore();
    const seedIds = makeSeedMessages().map((m) => m.id);
    const seedById = Object.fromEntries(makeSeedMessages().map((m) => [m.id, m]));

    await runAgentLoop(convId, 'Compact me');

    const conv = useChatStore.getState().conversations[convId];
    const allMsgs = conv?.messages ?? [];

    // Exactly one compact-boundary marker was appended
    const markers = allMsgs.filter((m) => isCompactBoundary(m));
    expect(markers).toHaveLength(1);
    expect(markers[0].compactBoundary?.source).toBe('auto');
    expect(markers[0].compactBoundary?.summaryText).toBe(
      'Mocked summary of the middle messages.',
    );
    expect(markers[0].role).toBe('system');
    expect(markers[0].id).toMatch(/^compact-boundary-/);

    // ── Append-only: every original seed message is still present ───────────
    for (const id of seedIds) {
      const found = allMsgs.find((m) => m.id === id);
      expect(found, `seed message ${id} should still be in store`).toBeDefined();
    }

    // ── Content byte-identical: no seed message was mutated ─────────────────
    for (const [id, orig] of Object.entries(seedById)) {
      const found = allMsgs.find((m) => m.id === id);
      expect(found?.content, `content of ${id} should be unchanged`).toBe(
        orig.content,
      );
    }

    // ── No duplicate message ids in the store ─────────────────────────────
    const ids = allMsgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── Test 2: <85% → no marker created ─────────────────────────────────────
  it('does NOT append a marker when context is below 85%', async () => {
    // 5000 + 145000 + 500 = 150500 (≈78%) → below threshold
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(145000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);

    mockLlmThreeTurns();
    const convId = setupStore();

    await runAgentLoop(convId, 'Small context');

    const conv = useChatStore.getState().conversations[convId];
    const markers = (conv?.messages ?? []).filter((m) => isCompactBoundary(m));
    expect(markers).toHaveLength(0);
  });

  // ── Test 3: clearContextCache is called after marker creation ─────────────
  it('clears the ephemeral 65% contextCache when a marker is successfully created', async () => {
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(165000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);

    mockLlmThreeTurns();
    const convId = setupStore();

    // Pre-inject a contextCache to prove clearContextCache removes it
    const fakeSummaryMsg: Message = {
      id: 'context-summary-fake',
      role: 'user',
      content: '[对话历史摘要]\nOld summary',
      timestamp: Date.now(),
    };
    useChatStore.setState((state) => {
      const c = state.conversations[convId];
      if (c) {
        c.contextCache = {
          summaryMessage: fakeSummaryMsg,
          summarizedRange: [0, 10],
          messageCountAtCompression: 14,
        };
      }
    });

    await runAgentLoop(convId, 'Clear cache');

    const conv = useChatStore.getState().conversations[convId];
    // After marker creation, contextCache must be undefined
    expect(conv?.contextCache).toBeUndefined();
    // And a marker was indeed created (guards the expectation is meaningful)
    const markers = (conv?.messages ?? []).filter((m) => isCompactBoundary(m));
    expect(markers).toHaveLength(1);
  });

  // ── Test 4: at most one marker per runAgentLoop ───────────────────────────
  it('lands at most one compact-boundary marker even when tokens stay above 85% throughout', async () => {
    // Tokens well above threshold for all turns
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(175000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);

    mockLlmThreeTurns();
    const convId = setupStore();

    await runAgentLoop(convId, 'High tokens all turns');

    const conv = useChatStore.getState().conversations[convId];
    const markers = (conv?.messages ?? []).filter((m) => isCompactBoundary(m));
    // persistentCompactionDone prevents more than one marker per runAgentLoop call
    expect(markers).toHaveLength(1);
  });

  // ── Test 5: send-side bypasses raw history when marker exists ─────────────
  it('sends compact context (no markers, has summary message) to LLM when history contains a marker', async () => {
    // Single end_turn turn — turnCount=1 < 3, so A3 does not fire for a new marker
    mockLlmOneTurn('Hi');
    const convId = setupStore();

    // Pre-seed: create a marker that references real seed message ids
    const seedMsgs = makeSeedMessages();
    const markerTs = Date.now() - 5000;
    const preExistingMarker = createCompactBoundaryMarker({
      summaryText: 'Earlier rounds summarized here',
      summarizedFromId: 'u1', // second seed message
      summarizedToId: 'a3',   // 8th seed message
      source: 'auto',
      timestamp: markerTs,
    });
    // Inject marker into the conversation history
    useChatStore.setState((state) => {
      const c = state.conversations[convId];
      if (c) c.messages = [...seedMsgs, preExistingMarker];
    });

    await runAgentLoop(convId, 'Read summary');

    // The LLM adapter received messages on the first (only) call
    expect(mockClaudeChat).toHaveBeenCalledTimes(1);
    const messagesReceivedByLlm = mockClaudeChat.mock.calls[0][0] as Message[];
    expect(Array.isArray(messagesReceivedByLlm)).toBe(true);

    // No compact-boundary marker should be in the context sent to the LLM
    const markersInContext = messagesReceivedByLlm.filter((m) =>
      m.id.startsWith('compact-boundary-'),
    );
    expect(markersInContext).toHaveLength(0);

    // The synthetic summary user message must be present
    const summaryMsg = messagesReceivedByLlm.find(
      (m) => typeof m.content === 'string' && m.content.includes('[对话历史摘要]'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain('Earlier rounds summarized here');
    expect(summaryMsg?.role).toBe('user');
  });

  // ── Test 6: 65% compressContextIfNeeded is still called when no marker ────
  it('still invokes compressContextIfNeeded on the 65% path when no compact-boundary marker exists', async () => {
    const { compressContextIfNeeded } = await import('../core/context/contextCompressor');

    // Tokens irrelevant — compressContextIfNeeded is called at turnCount≥3 regardless
    // (its internal logic decides whether to actually compress)
    vi.mocked(tokenEstimatorModule.estimateTokens).mockReturnValue(5000);
    vi.mocked(tokenEstimatorModule.estimateMessageTokens).mockReturnValue(130000);
    vi.mocked(tokenEstimatorModule.estimateToolSchemaTokens).mockReturnValue(500);

    mockLlmThreeTurns();
    const convId = setupStore();
    // Ensure no pre-existing marker and no contextCache
    useChatStore.setState((state) => {
      const c = state.conversations[convId];
      if (c) c.contextCache = undefined;
    });

    await runAgentLoop(convId, 'No marker');

    // compressContextIfNeeded must have been called (65% path still live)
    expect(compressContextIfNeeded).toHaveBeenCalled();

    // No marker should have been created (tokens 150500 < threshold 163037)
    const conv = useChatStore.getState().conversations[convId];
    const markers = (conv?.messages ?? []).filter((m) => isCompactBoundary(m));
    expect(markers).toHaveLength(0);
  });
});
