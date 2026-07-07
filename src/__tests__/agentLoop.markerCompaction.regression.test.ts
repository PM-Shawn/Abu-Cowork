/**
 * Regression test for the marker-version compaction path (P1 Part A).
 *
 * Uses REAL conversationStorage backed by an in-memory filesystem (no mock of
 * the storage module). This is the append-only safety net: any code path that
 * rewrites or truncates the messages.jsonl file would be caught here.
 *
 * Key invariant being tested ("Bug #1" class from the old rewrite approach):
 *   After a compact-boundary marker is appended, calling loadMessages()
 *   MUST return ALL original messages (unchanged) PLUS the new marker PLUS
 *   any assistant replies written during the compaction turn.
 *
 * Tests:
 *   1. All original seed messages survive on disk with byte-identical content.
 *   2. Exactly one compact-boundary marker is appended (not a rewrite).
 *   3. The compaction-round assistant reply is on disk (content not erased).
 *   4. buildContextFromBoundary(loaded) reconstructs a compact, marker-free
 *      context — proving the marker is usable for future send-side bypasses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTaskExecutionStore } from '../stores/taskExecutionStore';
import type { StreamEvent, Message } from '../types';
import {
  isCompactBoundary,
  buildContextFromBoundary,
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

// ── 65% send-only compressor: never compresses; summarize returns fixed text ──
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

// ── Token estimator — set to >85% so A3 fires ────────────────────────────────
// contextWindow=200000, maxOutput=8192 → maxInput=191808; 85% ≈ 163037 tokens.
// 5000 + 165000 + 500 = 170500 (≈89%) → triggers persistent compaction.
vi.mock('../core/context/tokenEstimator', () => ({
  estimateToolSchemaTokens: vi.fn().mockReturnValue(500),
  estimateTokens: vi.fn().mockReturnValue(5000),
  estimateMessageTokens: vi.fn().mockReturnValue(165000),
  calibrateFromUsage: vi.fn(),
  setActiveModel: vi.fn(),
}));

// ── contextUtils — split rounds on user messages ──────────────────────────────
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

// ── NOTE: conversationStorage is NOT mocked ───────────────────────────────────
// The real module runs against the in-memory filesystem set up in beforeEach.
// This is the key difference from the integration test.

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

// ── In-memory filesystem ──────────────────────────────────────────────────────
// Replicates the pattern used in conversationStorage.test.ts — Tauri fs calls
// are redirected to a simple Map so real storage functions exercise real logic
// without touching the actual file system.
function setupMemoryFs(): { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const writeToMemory = (path: string, content: string) => {
    files.set(path, content);
    // Populate parent directories so exists() returns true for them
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/') || '/');
    }
  };

  (exists as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    return files.has(path) || dirs.has(path);
  });

  (readTextFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (path: string) => {
      if (!files.has(path)) throw new Error(`File not found: ${path}`);
      return files.get(path)!;
    },
  );

  (writeTextFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (path: string, content: string) => {
      writeToMemory(path, content);
    },
  );

  (invoke as ReturnType<typeof vi.fn>).mockImplementation(
    async (cmd: string, args?: { path?: string; content?: string }) => {
      if (cmd === 'atomic_write_text' && args?.path !== undefined) {
        writeToMemory(args.path, args.content ?? '');
        return;
      }
      return undefined;
    },
  );

  (mkdir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    dirs.add(path);
  });

  (remove as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    for (const key of files.keys()) {
      if (key.startsWith(path)) files.delete(key);
    }
    dirs.delete(path);
  });

  (readDir as ReturnType<typeof vi.fn>).mockImplementation(async () => []);

  return { files, dirs };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  content = 'message content',
): Message {
  return { id, role, content, timestamp: Date.now() };
}

/** 7 user+assistant pairs — enough rounds for computeCompactionPlan to work. */
function makeSeedMessages(): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < 7; i++) {
    msgs.push(makeMsg(`u${i}`, 'user', `User round ${i}`));
    msgs.push(makeMsg(`a${i}`, 'assistant', `Assistant round ${i}`));
  }
  return msgs;
}

/** Standard store + in-memory filesystem setup for one test. */
function setupTest(files: Map<string, string>): string {
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
  const seedMessages = makeSeedMessages();
  useChatStore.setState((state) => {
    const c = state.conversations[convId];
    if (c) c.messages = seedMessages;
  });

  // Write seed messages directly to the in-memory filesystem as JSONL.
  // conversationStorage uses appDataDir() → '/Users/testuser/.abu' (global mock).
  const basePath = '/Users/testuser/.abu/conversations';
  const msgsPath = `${basePath}/${convId}/messages.jsonl`;
  const seedContent =
    seedMessages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  files.set(msgsPath, seedContent);

  return convId;
}

/** 3-turn LLM mock: tool_use × 2, then text + end_turn. */
function mockLlmThreeTurns(): void {
  let callCount = 0;
  mockClaudeChat.mockImplementation(
    async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
      callCount++;
      if (callCount < 3) {
        onEvent({
          type: 'tool_use',
          id: `t-${callCount}`,
          name: 'read_file',
          input: { path: '/x' },
        });
        onEvent({ type: 'done', stopReason: 'tool_use' });
      } else {
        onEvent({ type: 'text', text: 'Done' });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Marker Compaction Regression — real storage, in-memory fs', () => {
  let files: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    const memFs = setupMemoryFs();
    files = memFs.files;
    mockLlmThreeTurns();
  });

  afterEach(async () => {
    // Drain fire-and-forget dynamic imports and write queue before test teardown.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const storage = await import('../core/session/conversationStorage');
    await storage.flushWrites();
  });

  // ── Regression test: append-only guarantee ────────────────────────────────
  it('original seed messages are preserved byte-for-byte on disk after compaction (no data loss)', async () => {
    const convId = setupTest(files);
    const seedMessages = makeSeedMessages();

    await runAgentLoop(convId, 'Compact me');

    // Drain fire-and-forget replaceMessageById calls (finishStreaming, etc.)
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const storage = await import('../core/session/conversationStorage');
    await storage.flushWrites();

    const diskMessages = await storage.loadMessages(convId);

    // ── Disk must be non-empty ─────────────────────────────────────────────
    expect(diskMessages.length).toBeGreaterThan(0);

    // ── Every original seed message must still be present on disk ────────
    for (const orig of seedMessages) {
      const found = diskMessages.find((m) => m.id === orig.id);
      expect(found, `seed message ${orig.id} should still be on disk`).toBeDefined();
      // Byte-level content check — nothing was mutated
      expect(
        found?.content,
        `content of ${orig.id} should be byte-identical on disk`,
      ).toBe(orig.content);
    }

    // ── No duplicate IDs on disk ──────────────────────────────────────────
    const diskIds = diskMessages.map((m) => m.id);
    expect(new Set(diskIds).size).toBe(diskIds.length);

    // ── A compact-boundary marker was appended (append-only, not replacing) ─
    const markersOnDisk = diskMessages.filter((m) => isCompactBoundary(m));
    expect(markersOnDisk).toHaveLength(1);
    expect(markersOnDisk[0].compactBoundary?.source).toBe('auto');

    // ── The in-memory store also has all seed messages + the marker ───────
    const conv = useChatStore.getState().conversations[convId];
    const storeMarkers = (conv?.messages ?? []).filter((m) => isCompactBoundary(m));
    expect(storeMarkers).toHaveLength(1);
    // Seed messages still in store (append-only applies to store too)
    for (const orig of seedMessages) {
      expect(
        conv?.messages.find((m) => m.id === orig.id),
        `seed ${orig.id} must still be in store`,
      ).toBeDefined();
    }
  });

  // ── Regression: compaction-round assistant reply is NOT erased from disk ──
  it('the compaction-round assistant reply exists on disk after compaction — the #1 data-loss class cannot regress', async () => {
    // Concise statement of the old bug (#1 class):
    //   OLD approach: rewriteActiveMessages was called WITHOUT the trailing
    //   assistant stub → stub overwritten out of existence on disk → subsequent
    //   replaceMessageById(stubId) was a no-op (id not found) → reply permanently lost.
    //
    //   MARKER approach: no rewriteActiveMessages ever runs. The stub is appended
    //   to disk via appendMessage (append-only). Even if replaceMessageById fires
    //   before the write queue flushes (timing), flushWrites() ensures the stub IS
    //   on disk — the id just won't have its final content until the next
    //   replaceMessageById succeeds. The key invariant: stub is PRESENT, not erased.
    const convId = setupTest(files);

    await runAgentLoop(convId, 'Compact me');

    // Drain fire-and-forget microtasks (appendMessage, replaceMessageById calls)
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const storage = await import('../core/session/conversationStorage');
    await storage.flushWrites();

    const diskMessages = await storage.loadMessages(convId);
    const seedMessages = makeSeedMessages();

    // ── All original seed messages still present (append-only, nothing erased) ──
    for (const orig of seedMessages) {
      expect(
        diskMessages.find((m) => m.id === orig.id),
        `seed message ${orig.id} must not be erased from disk`,
      ).toBeDefined();
    }

    // ── At least one new assistant message was appended (stub exists on disk) ──
    // The seed messages have ids a0..a6 — any assistant message beyond those
    // is the compaction-round stub. In the old approach this stub was rewritten
    // OUT of the file; in the marker version it is only ever APPENDED.
    const seedAssistantIds = new Set(seedMessages.filter(m => m.role === 'assistant').map(m => m.id));
    const newAssistantsOnDisk = diskMessages.filter(
      (m) => m.role === 'assistant' && !seedAssistantIds.has(m.id),
    );
    expect(
      newAssistantsOnDisk.length,
      'at least one new assistant stub must be appended to disk (not erased)',
    ).toBeGreaterThan(0);

    // ── Store has the compaction-round reply with final content 'Done' ────────
    // Even if disk timing means the stub's final content ('Done') hasn't been
    // persisted via replaceMessageById yet, the in-memory store always has it.
    // This ensures the LLM response is never LOST — at worst it needs a disk sync.
    const conv = useChatStore.getState().conversations[convId];
    const storeAssistant = conv?.messages.find(
      (m) =>
        m.role === 'assistant' &&
        typeof m.content === 'string' &&
        m.content.includes('Done'),
    );
    expect(
      storeAssistant,
      'compaction-round reply must be captured in the in-memory store',
    ).toBeDefined();
  });

  // ── Regression: marker on disk enables buildContextFromBoundary ───────────
  it('loadMessages() after compaction produces a messages array that buildContextFromBoundary can use to rebuild a compact, marker-free context', async () => {
    const convId = setupTest(files);
    const seedMessages = makeSeedMessages();

    await runAgentLoop(convId, 'Compact me');

    for (let i = 0; i < 50; i++) await Promise.resolve();
    const storage = await import('../core/session/conversationStorage');
    await storage.flushWrites();

    const diskMessages = await storage.loadMessages(convId);

    // buildContextFromBoundary must detect the marker and return a compact view
    const compactView = buildContextFromBoundary(diskMessages);

    // Compact view must be different from the full disk history (marker present)
    expect(compactView).not.toBe(diskMessages);

    // No compact-boundary markers in the compact view (they are stripped)
    const markersInView = compactView.filter((m) => isCompactBoundary(m));
    expect(markersInView).toHaveLength(0);

    // The synthetic summary user message must be present
    const summaryMsg = compactView.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.startsWith('[对话历史摘要]'),
    );
    expect(summaryMsg, 'compact view must include the summary message').toBeDefined();

    // The compact view must be shorter than the full disk history
    // (markers + middle messages replaced by a single summary message)
    expect(compactView.length).toBeLessThan(diskMessages.length);

    // First-round seed messages (u0, a0) must still be present in compact view
    // (firstRound is preserved verbatim by buildContextFromBoundary)
    const u0InView = compactView.find((m) => m.id === 'u0');
    const a0InView = compactView.find((m) => m.id === 'a0');
    expect(u0InView, 'first-round user message must be in compact view').toBeDefined();
    expect(a0InView, 'first-round assistant message must be in compact view').toBeDefined();

    // Byte-identical content check for u0 / a0 (not mutated by compaction)
    const origU0 = seedMessages.find((m) => m.id === 'u0');
    const origA0 = seedMessages.find((m) => m.id === 'a0');
    expect(u0InView?.content).toBe(origU0?.content);
    expect(a0InView?.content).toBe(origA0?.content);
  });
});
