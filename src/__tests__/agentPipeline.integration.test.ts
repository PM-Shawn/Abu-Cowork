/**
 * Agent Pipeline Integration Test
 *
 * Tests the full message → LLM → tool execution → response pipeline.
 * Uses mocked LLM adapter to simulate various response scenarios.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  prepareContextMessages: vi.fn().mockImplementation((msgs) => ({
    messages: msgs,
    compressed: false,
  })),
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
    shouldCompact = vi.fn().mockReturnValue(false);
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
  requestCommandConfirmation: vi.fn().mockResolvedValue(true),
  requestFilePermission: vi.fn().mockResolvedValue(true),
  drainConfirmationQueue: vi.fn().mockReturnValue([]),
  drainFilePermissionQueue: vi.fn().mockReturnValue([]),
  drainWorkspaceRequest: vi.fn().mockReturnValue(null),
}));

vi.mock('../core/agent/userInputQueue', () => ({
  drainQueuedInputs: vi.fn().mockReturnValue([]),
  clearInputQueue: vi.fn(),
  hasQueuedInputs: vi.fn().mockReturnValue(false),
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
  deriveUiCaps: vi.fn().mockReturnValue([]),
}));

vi.mock('../core/tools/toolNames', () => ({
  TOOL_NAMES: {
    WEB_SEARCH: 'web_search',
    DELEGATE_TO_AGENT: 'delegate_to_agent',
  },
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

vi.mock('../core/agent/backgroundAgentRegistry', () => ({
  getRunningAgents: vi.fn().mockReturnValue([]),
  setConversationLookup: vi.fn(),
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
import { runAgentLoop, escalateMaxOutputTokens } from '../core/agent/agentLoop';
import type { StreamEvent } from '../types';

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
  });

  it('escalateMaxOutputTokens pure function works correctly', () => {
    // Already tested in agentLoop.test.ts, but verify integration
    const result = escalateMaxOutputTokens(8192, 200000, 1, false);
    expect(result.maxOutputTokens).toBe(16384);
    expect(result.changed).toBe(true);
  });
});
