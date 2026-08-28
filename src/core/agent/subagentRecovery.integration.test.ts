/**
 * Subagent max_tokens recovery — integration test.
 *
 * Drives the real runSubagentLoop with a mocked ClaudeAdapter that truncates
 * (stopReason='max_tokens') on the first turn and completes on the second, to
 * exercise the recovery WIRING that the pure-helper unit tests can't reach:
 *   - the loop re-prompts instead of ending on a single truncation
 *   - an empty truncation does NOT push two consecutive user messages
 *     (which the Anthropic API rejects with a 400 — the exact bug this guards)
 *   - the output budget escalates on the recovery turn
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '../../types';
import type { ProviderInstance } from '../../types/provider';
import { LLMError } from '../llm/adapter';

const mockEnforceContextBudget = vi.hoisted(() => vi.fn((msgs: unknown[]) => ({
  messages: msgs,
  tokensBefore: 1,
  tokensAfter: 1,
  inputBudget: 100000,
  safetyMarginTokens: 1000,
  strategy: 'unchanged',
})));
const mockCompressContextIfNeeded = vi.hoisted(() => vi.fn().mockResolvedValue({ compressed: false, messages: [] }));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ currentPath: '/tmp/project' }), subscribe: vi.fn() },
}));

const mockClaudeChat = vi.fn();
vi.mock('../llm/claude', () => ({ ClaudeAdapter: class { chat = mockClaudeChat; } }));
vi.mock('../llm/openai-compatible', () => ({ OpenAICompatibleAdapter: class { chat = vi.fn(); } }));

const mockExecuteAnyTool = vi.fn();
const mockGetAllTools = vi.fn().mockReturnValue([]);
vi.mock('../tools/registry', () => ({
  getAllTools: () => mockGetAllTools(),
  executeAnyTool: (...args: unknown[]) => mockExecuteAnyTool(...args),
  toolResultToString: (r: unknown) => String(r),
}));

vi.mock('../memdir/scan', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  loadMemoryIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock('../context/contextManager', () => ({
  enforceContextBudget: (...args: unknown[]) => mockEnforceContextBudget(...args),
  // Pass-through — the real screenshot-budget behavior is covered by
  // contextManager.test.ts; here it must simply not disturb the pipeline.
  trimOldScreenshots: vi.fn((msgs: unknown[]) => msgs),
}));
vi.mock('../context/contextCompressor', () => ({
  compressContextIfNeeded: (...args: unknown[]) => mockCompressContextIfNeeded(...args),
}));
vi.mock('../observability/langfuse', () => ({ startSubagentSpan: vi.fn().mockReturnValue({ end: vi.fn() }) }));

const mockEmitHook = vi.fn((event: unknown) => event);
vi.mock('./lifecycleHooks', () => ({
  emitHook: (event: unknown) => mockEmitHook(event),
}));

const mockGetActiveProvider = vi.fn(
  (..._args: unknown[]): Partial<ProviderInstance> | undefined => ({
    id: 'p1',
    apiFormat: 'anthropic',
    baseUrl: undefined,
    models: [],
  }),
);
const mockResolveAgentModel = vi.hoisted(() => vi.fn(() => 'claude-opus-4-8'));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ agentMaxTurns: 200, maxOutputTokens: undefined, contextWindowSize: undefined }) },
}));

// subagentLoop.ts imports getActiveProvider/getActiveApiKey/resolveAgentModel
// from settingsSelectors.ts (NOT settingsStore.ts) — see that module's doc
// for why (sidecar-bundle-safety: a pure module both the webview and the
// sidecar bundle can import without dragging in settingsStore's zustand
// create()/persist graph). Mock the module subagentLoop.ts ACTUALLY imports.
vi.mock('../../utils/settingsSelectors', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getActiveApiKey: () => 'sk-test',
  resolveAgentModel: (...args: unknown[]) => mockResolveAgentModel(...args),
}));

vi.mock('../../stores/discoveredCapabilitiesStore', () => ({
  useDiscoveredCapsStore: { getState: () => ({ get: () => undefined, recordReasoningObserved: vi.fn() }) },
}));

vi.mock('../enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: () => ({ apiKey: 'sk-test', baseUrl: undefined }),
}));

const mockReadDelegatedMedia = vi.fn();
vi.mock('../subagent/delegatedMediaStore', () => ({
  readDelegatedMedia: (...args: unknown[]) => mockReadDelegatedMedia(...args),
  persistDelegatedMedia: vi.fn(),
}));

vi.mock('../session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(),
}));

import { runSubagentLoop, SubagentResult } from './subagentLoop';
import { agentRegistry } from './registry';

/** Build a fake adapter.chat that synchronously emits the given stream events. */
function emits(events: StreamEvent[]) {
  return async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
    for (const e of events) onEvent(e);
  };
}

const agent = { name: 'tester', systemPrompt: 'sys', tools: [] } as never;
const trustedDelegatedOrigin = {
  parentConversationId: 'conv-1',
  parentLoopId: 'loop-1',
  parentUserMessageId: 'user-1',
} as const;

describe('subagent max_tokens recovery (integration)', () => {
  beforeEach(() => {
    mockClaudeChat.mockReset();
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool.mockResolvedValue('tool output');
    mockEmitHook.mockReset();
    mockEmitHook.mockImplementation((event: unknown) => event);
    mockGetAllTools.mockReset();
    mockGetAllTools.mockReturnValue(
      ['noop', 'do_work', 'computer', 'read_file'].map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        execute: vi.fn(),
      })),
    );
    mockGetActiveProvider.mockReset();
    mockGetActiveProvider.mockReturnValue({ id: 'p1', apiFormat: 'anthropic', baseUrl: undefined, models: [] });
    mockResolveAgentModel.mockReset();
    mockResolveAgentModel.mockReturnValue('claude-opus-4-8');
    mockReadDelegatedMedia.mockReset();
    mockEnforceContextBudget.mockClear();
    mockEnforceContextBudget.mockImplementation((msgs: unknown[]) => ({
      messages: msgs,
      tokensBefore: 1,
      tokensAfter: 1,
      inputBudget: 100000,
      safetyMarginTokens: 1000,
      strategy: 'unchanged',
    }));
    mockCompressContextIfNeeded.mockReset();
    mockCompressContextIfNeeded.mockResolvedValue({ compressed: false, messages: [] });
  });

  it('uses the IM workspace inherited by a delegate instead of the global workspace reader', async () => {
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent,
      task: 'do the thing',
      imContext: { platform: 'dchat', workspacePath: '/im/workspace' },
      workspaceReader: { getCurrentPath: () => '/global/workspace' },
    });

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { systemPrompt?: string };
    expect(chatOptions.systemPrompt).toContain('Path: /im/workspace');
    expect(chatOptions.systemPrompt).not.toContain('/global/workspace');
  });

  it('starts a delegated multimodal turn with source blocks in order and task text last', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    mockReadDelegatedMedia.mockResolvedValue(imageBytes);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [
          { type: 'text', text: 'The first label.' },
          { type: 'image', attachment: { id: 'attachment_opaque_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } },
          { type: 'text', text: 'The second label.' },
        ],
      },
      ...trustedDelegatedOrigin,
    } as never);

    const firstMessages = mockClaudeChat.mock.calls[0][0] as Array<{ role: string; content: unknown }>;
    const firstUserMessage = firstMessages.find((message) => message.role === 'user');
    expect(firstUserMessage?.content).toEqual([
      { type: 'text', text: 'The first label.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoBAgME',
        },
      },
      { type: 'text', text: 'The second label.' },
      { type: 'text', text: 'Describe the image.' },
    ]);
    expect(mockReadDelegatedMedia).toHaveBeenCalledWith(
      'conv-1',
      {
        id: 'attachment_opaque_1',
        sha256: 'a'.repeat(64),
        mediaType: 'image/png',
        bytes: 12,
      },
      undefined,
    );
    expect(mockReadDelegatedMedia).toHaveBeenCalledTimes(1);

    const firstBudgetMessages = mockEnforceContextBudget.mock.calls[0][0] as Array<{ id: string; content: unknown }>;
    expect(firstBudgetMessages[0].id).toBe('sub-user-0');
    expect(Array.isArray(firstBudgetMessages[0].content)).toBe(true);
  });

  it('fails before reading delegated media or calling the adapter when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      signal: controller.signal,
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'image', attachment: { id: 'attachment_opaque_abort', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } }],
      },
      ...trustedDelegatedOrigin,
    });

    expect(result.stopReason).toBe('aborted');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
    expect(mockClaudeChat).not.toHaveBeenCalled();
  });

  it('fails closed before reading media or calling the adapter for a text-only target', async () => {
    mockResolveAgentModel.mockReturnValue('deepseek-chat');

    const result = await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'image', attachment: { id: 'attachment_opaque_text', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } }],
      },
      ...trustedDelegatedOrigin,
    });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('does not support image input');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
    expect(mockClaudeChat).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown custom model unless image support is explicitly declared', async () => {
    mockResolveAgentModel.mockReturnValue('unlisted-proxy-model');
    mockGetActiveProvider.mockReturnValue({
      id: 'custom-p1', source: 'custom', name: 'Custom proxy', enabled: true,
      apiFormat: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'sk-test', models: [], status: 'verified', sortOrder: 0,
    });
    const delegatedUserTurn = {
      schemaVersion: 1,
      origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
      content: [{ type: 'image', attachment: { id: 'attachment_unknown', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } }],
    } as never;

    const unspecified = await runSubagentLoop({ agent, task: 'Describe it.', delegatedUserTurn, ...trustedDelegatedOrigin });
    expect(unspecified.stopReason).toBe('error');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
    expect(mockClaudeChat).not.toHaveBeenCalled();

    mockGetActiveProvider.mockReturnValue({
      id: 'custom-p1', source: 'custom', name: 'Custom proxy', enabled: true,
      apiFormat: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'sk-test', models: [], status: 'verified', sortOrder: 0,
      declaredCapabilities: { supportsImages: true },
    });
    mockReadDelegatedMedia.mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]));
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));
    await runSubagentLoop({ agent, task: 'Describe it.', delegatedUserTurn, ...trustedDelegatedOrigin });
    expect(mockClaudeChat).toHaveBeenCalledOnce();

    mockClaudeChat.mockClear();
    mockReadDelegatedMedia.mockClear();
    mockGetActiveProvider.mockReturnValue({
      id: 'custom-p1', source: 'custom', name: 'Custom proxy', enabled: true,
      apiFormat: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'sk-test', models: [], status: 'verified', sortOrder: 0,
      declaredCapabilities: { supportsImages: false },
    });
    const denied = await runSubagentLoop({ agent, task: 'Describe it.', delegatedUserTurn, ...trustedDelegatedOrigin });
    expect(denied.stopReason).toBe('error');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
    expect(mockClaudeChat).not.toHaveBeenCalled();
  });

  it('does not read or base64-materialize a MediaRef until the adapter request seam', async () => {
    mockReadDelegatedMedia.mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]));
    mockEnforceContextBudget.mockImplementation((msgs: unknown[]) => {
      expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
      return { messages: msgs, tokensBefore: 1, tokensAfter: 1, inputBudget: 100000, safetyMarginTokens: 1000, strategy: 'unchanged' };
    });
    mockClaudeChat.mockImplementationOnce(async (messages: unknown, opts: unknown, onEvent: (e: StreamEvent) => void) => {
      expect(mockReadDelegatedMedia).toHaveBeenCalledOnce();
      expect(JSON.stringify(messages)).toContain('iVBORw0KGgoBAgME');
      void opts;
      onEvent({ type: 'done', stopReason: 'end_turn' } as StreamEvent);
    });

    await runSubagentLoop({
      agent,
      task: 'Describe it.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'image', attachment: { id: 'attachment_seam', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } }],
      },
      ...trustedDelegatedOrigin,
    } as never);

    expect(mockEnforceContextBudget).toHaveBeenCalled();
    expect(mockReadDelegatedMedia).toHaveBeenCalled();
    expect(mockReadDelegatedMedia.mock.invocationCallOrder[0])
      .toBeGreaterThan(mockEnforceContextBudget.mock.invocationCallOrder[0]);
  });

  it('re-materializes delegated media for every provider retry instead of caching base64 for the run', async () => {
    vi.useFakeTimers();
    mockReadDelegatedMedia
      .mockResolvedValueOnce(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]))
      .mockResolvedValueOnce(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2]));
    mockClaudeChat
      .mockImplementationOnce(async () => {
        throw new LLMError('temporary transport error', 'network_error', {
          retryable: true,
          retryAfterMs: 1,
        });
      })
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const run = runSubagentLoop({
      agent,
      task: 'Describe it.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'image', attachment: { id: 'attachment_retry', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 9 } }],
      },
      ...trustedDelegatedOrigin,
    } as never);

    await vi.waitFor(() => expect(mockClaudeChat).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5);
    const result = await run;

    expect(result.text).toBe('done');
    expect(mockClaudeChat).toHaveBeenCalledTimes(2);
    expect(mockReadDelegatedMedia).toHaveBeenCalledTimes(2);
  });

  it('uses the explicit text-only fallback without reading delegated image bytes', async () => {
    mockResolveAgentModel.mockReturnValue('deepseek-chat');
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      delegatedMediaFallback: 'text-only',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'image', attachment: { id: 'attachment_opaque_fallback', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } }],
      },
      ...trustedDelegatedOrigin,
    });

    const messages = mockClaudeChat.mock.calls[0][0] as Array<{ role: string; content: unknown }>;
    expect(messages.find((message) => message.role === 'user')?.content).toEqual([
      { type: 'text', text: '[Attached image omitted because the selected subagent model does not support vision.]' },
      { type: 'text', text: 'Describe the image.' },
    ]);
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
  });

  it('fails closed before reading media or calling the adapter for a document-unsupported target', async () => {
    mockResolveAgentModel.mockReturnValue('gpt-4o');

    const result = await runSubagentLoop({
      agent,
      task: 'Read the document.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [{ type: 'document', attachment: { id: 'attachment_opaque_document', sha256: 'a'.repeat(64), mediaType: 'application/pdf', bytes: 12 } }],
      },
      ...trustedDelegatedOrigin,
    });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('does not support document input');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
    expect(mockClaudeChat).not.toHaveBeenCalled();
  });

  it('fails before the adapter request when a delegated media ref cannot be read', async () => {
    mockReadDelegatedMedia.mockResolvedValue(null);

    const result = await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [
          { type: 'image', attachment: { id: 'attachment_opaque_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 12 } },
        ],
      },
      ...trustedDelegatedOrigin,
    } as never);

    expect(mockClaudeChat).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('stored media is missing or corrupt');
  });

  it('keeps text-only delegated turns on the original string path', async () => {
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent,
      task: 'Summarize this.',
      context: 'Use bullets.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [
          { type: 'text', text: 'The parent user had no media.' },
        ],
      },
      ...trustedDelegatedOrigin,
    } as never);

    const firstMessages = mockClaudeChat.mock.calls[0][0] as Array<{ role: string; content: unknown }>;
    expect(firstMessages.find((message) => message.role === 'user')?.content).toBe('Summarize this.\n\nUse bullets.');
    expect(mockReadDelegatedMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['path-like origin', {
      schemaVersion: 1,
      origin: { conversationId: '../conv-1', loopId: 'loop-1', messageId: 'user-1' },
      content: [{ type: 'text', text: 'text-only but forged origin' }],
    }],
    ['extra field', {
      schemaVersion: 1,
      origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
      content: [{ type: 'text', text: 'text-only with extra field', filePath: '/tmp/secret.png' }],
    }],
  ])('fails closed before the adapter for text-only delegatedUserTurn with %s', async (_label, delegatedUserTurn) => {
    const result = await runSubagentLoop({
      agent,
      task: 'Summarize this.',
      delegatedUserTurn,
    } as never);

    expect(mockClaudeChat).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('invalid envelope');
  });

  it('does not re-inject delegated media after compression while re-reading refs per provider request', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 5]);
    mockReadDelegatedMedia.mockResolvedValue(imageBytes);
    mockCompressContextIfNeeded.mockResolvedValue({
      compressed: true,
      messages: [{ id: 'sub-user-0', role: 'user', content: 'compressed without media', timestamp: 1 }],
    });
    const toolTurn = emits([
      { type: 'tool_use', id: 'tool-1', name: 'noop', input: {} } as StreamEvent,
      { type: 'done', stopReason: 'tool_use' } as StreamEvent,
    ]);
    mockClaudeChat
      .mockImplementationOnce(toolTurn)
      .mockImplementationOnce(toolTurn)
      .mockImplementationOnce(toolTurn)
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const result = await runSubagentLoop({
      agent,
      task: 'Describe the image.',
      delegatedUserTurn: {
        schemaVersion: 1,
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-1' },
        content: [
          { type: 'image', attachment: { id: 'attachment_opaque_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 9 } },
        ],
      },
      ...trustedDelegatedOrigin,
    } as never);

    expect(result.text).toBe('done');
    expect(mockReadDelegatedMedia).toHaveBeenCalledTimes(3);
    expect(mockCompressContextIfNeeded).toHaveBeenCalled();
    const fourthSend = mockClaudeChat.mock.calls[3][0] as Array<{ id: string; content: unknown }>;
    expect(fourthSend[0]).toMatchObject({ id: 'sub-user-0', content: 'compressed without media' });
  });

  it('informs subagents that their tool and permission boundary is fixed', async () => {
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({ agent, task: 'do the thing' });

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { systemPrompt?: string };
    expect(chatOptions.systemPrompt).toContain('## Tool and Permission Boundaries');
    expect(chatOptions.systemPrompt).toContain('fixed when this run started and cannot be expanded in this session');
    expect(chatOptions.systemPrompt).toContain('tell the parent agent exactly what is missing');
    expect(chatOptions.systemPrompt).toContain('Do not work around a missing tool by simulating it or installing alternative software');
  });

  it('applies wildcard matching to agent.tools and warns when an entry matches no known tool', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'abu-browser__screenshot', description: 'shot', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSubagentLoop({
        agent: { ...agent, tools: ['abu-browser__*', 'missing_tool'] },
        task: 'do the thing',
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tools entries matched no known tools: missing_tool'));
    } finally {
      warnSpy.mockRestore();
    }

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { tools?: Array<{ name: string }> };
    expect(chatOptions.tools?.map((t) => t.name)).toEqual(['abu-browser__screenshot']);
  });

  it('expands the senior engineer builtin browser wildcard into browser tools', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'abu-browser__screenshot', description: 'shot', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    // Builtins are normally registered during application discovery. This
    // isolated loop test deliberately bypasses discovery's filesystem work.
    (agentRegistry as unknown as { registerBuiltins: () => void }).registerBuiltins();
    const seniorEngineer = agentRegistry.getAgent('高级开发工程师');
    expect(seniorEngineer).toBeDefined();
    await runSubagentLoop({ agent: seniorEngineer!, task: 'inspect the page' });

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { tools?: Array<{ name: string }> };
    expect(chatOptions.tools?.map((tool) => tool.name)).toContain('abu-browser__screenshot');
  });

  it('fails before the model starts when a declared MCP tool is unavailable', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);

    const result = await runSubagentLoop({
      agent: { ...agent, name: 'notion-researcher', tools: ['notion__query', 'slack__*'] },
      task: 'do the thing',
    });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('notion-researcher');
    expect(result.text).toContain('notion__query');
    expect(result.text).not.toContain('slack__*');
    expect(mockClaudeChat).not.toHaveBeenCalled();
    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
  });

  it('returns a structured config error for non-string AGENT.md tools entries', async () => {
    const result = await runSubagentLoop({
      agent: { ...agent, name: 'malformed-agent', tools: ['read_file', null, 42] as never },
      task: 'do the thing',
    });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('malformed-agent');
    expect(result.text).toContain('2, 3');
    expect(mockClaudeChat).not.toHaveBeenCalled();
    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
  });

  it('fails closed before the model when an AGENT.md tools entry is blank', async () => {
    const result = await runSubagentLoop({
      agent: { ...agent, name: 'blank-agent', tools: ['   '] },
      task: 'do the thing',
    });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('blank-agent');
    expect(result.text).toContain('1');
    expect(mockClaudeChat).not.toHaveBeenCalled();
    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
  });

  it.each(['notion__query', { server: 'notion' }])(
    'returns a structured config error when AGENT.md tools is the non-array value %j',
    async (tools) => {
      const result = await runSubagentLoop({
        agent: { ...agent, name: 'malformed-agent', tools: tools as never },
        task: 'do the thing',
      });

      expect(result.stopReason).toBe('error');
      expect(result.text).toContain('malformed-agent');
      expect(result.text).toContain('tools');
      expect(mockClaudeChat).not.toHaveBeenCalled();
      expect(mockExecuteAnyTool).not.toHaveBeenCalled();
    },
  );

  it.each(['write_file', ['read_file', null], ['   ']])(
    'fails closed for malformed AGENT.md disallowed-tools value %j',
    async (disallowedTools) => {
      const result = await runSubagentLoop({
        agent: { ...agent, name: 'malformed-agent', disallowedTools: disallowedTools as never },
        task: 'do the thing',
      });

      expect(result.stopReason).toBe('error');
      expect(result.text).toContain('malformed-agent');
      expect(result.text).toContain('disallowed-tools');
      expect(mockClaudeChat).not.toHaveBeenCalled();
      expect(mockExecuteAnyTool).not.toHaveBeenCalled();
    },
  );

  it('applies wildcard matching to agent.disallowedTools and warns when an entry matches no known tool', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'abu-browser__screenshot', description: 'shot', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'abu-browser__click', description: 'click', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSubagentLoop({
        agent: { ...agent, disallowedTools: ['abu-browser__*', 'missing_tool'] },
        task: 'do the thing',
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disallowedTools entries matched no known tools: missing_tool'));
    } finally {
      warnSpy.mockRestore();
    }

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { tools?: Array<{ name: string }> };
    expect(chatOptions.tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('keeps exact agent.tools names working under the shared matcher', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent: { ...agent, tools: ['read_file'] },
      task: 'do the thing',
    });

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { tools?: Array<{ name: string }> };
    expect(chatOptions.tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('keeps exact disallowedTools matching narrow', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'read_file_v2', description: 'read v2', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({
      agent: { ...agent, disallowedTools: ['read_file'] },
      task: 'do the thing',
    });

    const chatOptions = mockClaudeChat.mock.calls[0][1] as { tools?: Array<{ name: string }> };
    expect(chatOptions.tools?.map((t) => t.name)).toEqual(['read_file_v2']);
  });

  it('marks adapter failures with structured stopReason=error', async () => {
    mockClaudeChat.mockRejectedValueOnce(new Error('adapter failed'));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    expect(result.text).toContain('adapter failed');
    expect(result.stopReason).toBe('error');
  });

  it('marks a normal end_turn with no text or tools as no-content error', async () => {
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    expect(result.text).toContain('no content');
    expect(result.stopReason).toBe('error');
    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
  });

  it('recovers from an empty truncation without emitting consecutive user messages', async () => {
    // Turn 1: empty truncation (no text, no tool calls). Turn 2: normal completion.
    mockClaudeChat
      .mockImplementationOnce(emits([{ type: 'done', stopReason: 'max_tokens' } as StreamEvent]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'the final answer' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // Recovery fired: the loop re-prompted instead of ending on the first truncation.
    expect(mockClaudeChat).toHaveBeenCalledTimes(2);

    // #1 regression: the second request's history must not contain two consecutive
    // user-role messages (Anthropic rejects that with a 400). An empty truncation
    // still records an assistant turn between the two user messages.
    const secondCallMessages = mockClaudeChat.mock.calls[1][0] as Array<{ role: string }>;
    const hasConsecutiveUsers = secondCallMessages.some(
      (m, i) => i > 0 && m.role === 'user' && secondCallMessages[i - 1].role === 'user',
    );
    expect(hasConsecutiveUsers).toBe(false);

    // The resumed answer is returned.
    expect(result.text).toContain('the final answer');
    expect(result.stopReason).toBe('completed');
    expect(result.turnCount).toBe(2);
  });

  // Contract that agentLoop's @agent delegate branch depends on: when the user
  // aborts MID-RUN, runSubagentLoop RETURNS a (partial/cancelled) SubagentResult
  // — it does NOT throw. Therefore the delegate branch must re-check
  // signal.aborted AFTER the await to report {reason:'aborted'}; a throw-based
  // abort path would never fire. If anyone regresses this to throw on abort, the
  // delegate abort fix silently breaks — this test guards the premise.
  //
  // An already-aborted-at-entry signal now returns before delegated media is read
  // or a provider is called. This test separately guards the mid-run return shape.
  it('returns a SubagentResult (does not throw) when aborted mid-run', async () => {
    const ac = new AbortController();
    // Turn 0: the user hits Stop during the LLM call, then the model still emits a
    // tool call so the loop would continue — the top-of-turn abort check on turn 1
    // catches the cancellation and returns.
    mockClaudeChat.mockImplementationOnce(async (_m: unknown, _o: unknown, onEvent: (e: StreamEvent) => void) => {
      ac.abort();
      onEvent({ type: 'tool_use', id: 't1', name: 'noop', input: {} } as StreamEvent);
      onEvent({ type: 'done', stopReason: 'tool_use' } as StreamEvent);
    });

    const result = await runSubagentLoop({ agent, task: 'do the thing', signal: ac.signal });

    // Returned (not thrown) as a SubagentResult, and did not start another turn.
    expect(result).toBeInstanceOf(SubagentResult);
    expect(result.stopReason).toBe('aborted');
    expect(mockClaudeChat).toHaveBeenCalledTimes(1);
  });

  it('classifies an adapter rejection caused by a mid-stream abort as aborted, not error', async () => {
    const ac = new AbortController();
    mockClaudeChat.mockImplementationOnce(async () => {
      ac.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const result = await runSubagentLoop({ agent, task: 'do the thing', signal: ac.signal });

    expect(result).toBeInstanceOf(SubagentResult);
    expect(result.stopReason).toBe('aborted');
    expect(result.text).toContain('cancelled');
    expect(mockClaudeChat).toHaveBeenCalledTimes(1);
  });

  it('escalates the output budget on the recovery turn', async () => {
    mockClaudeChat
      .mockImplementationOnce(emits([{ type: 'done', stopReason: 'max_tokens' } as StreamEvent]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    await runSubagentLoop({ agent, task: 'do the thing' });

    const firstMaxTokens = (mockClaudeChat.mock.calls[0][1] as { maxTokens: number }).maxTokens;
    const secondMaxTokens = (mockClaudeChat.mock.calls[1][1] as { maxTokens: number }).maxTokens;
    expect(secondMaxTokens).toBeGreaterThan(firstMaxTokens);
  });

  // Bug #4: a turn truncated by max_tokens AFTER emitting a complete tool call.
  // Previously the subagent broke before executing it (toolCallCount > 0 was
  // excluded from recovery), discarding the work. It must instead execute the
  // tool, send the result back, and let the model resume.
  it('continues a max_tokens turn that carries complete tool calls (executes + resumes)', async () => {
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 't1', name: 'do_work', input: { x: 1 } } as StreamEvent,
        { type: 'done', stopReason: 'max_tokens' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'finished after the tool' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // The truncated-but-complete tool call was executed, not discarded.
    expect(mockExecuteAnyTool).toHaveBeenCalledTimes(1);
    // The loop continued to a second turn instead of ending on the truncation.
    expect(mockClaudeChat).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('finished after the tool');

    // Tool execution is real progress, so this is treated like a normal tool_use
    // turn: the recovery counter resets and the budget is NOT escalated (the resume
    // gets a fresh base budget). This keeps the shared recovery counter clean for a
    // later pure-text truncation and avoids an unbounded escalate-every-turn loop.
    const firstMaxTokens = (mockClaudeChat.mock.calls[0][1] as { maxTokens: number }).maxTokens;
    const secondMaxTokens = (mockClaudeChat.mock.calls[1][1] as { maxTokens: number }).maxTokens;
    expect(secondMaxTokens).toBe(firstMaxTokens);
  });

  it('keeps a scope-only scheduled nested subagent background at the in-process tool boundary', async () => {
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 't-scheduled', name: 'computer', input: { action: 'screenshot' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    await runSubagentLoop({
      agent,
      task: 'scheduled delegated work',
      authorizationScopeId: 'scope-scheduled',
    });

    expect(mockExecuteAnyTool.mock.calls.at(-1)?.[4]).toEqual(expect.objectContaining({
      authorizationScopeId: 'scope-scheduled',
      interactionMode: 'background',
    }));
  });

  // Bug #4 follow-up (review pass 2): a max_tokens turn whose tool call is MALFORMED
  // (_parse_error) is NOT progress — it must not be treated as a continuable tool turn
  // (which would spin a broken model), so the loop stops rather than re-prompting forever.
  it('does not spin on a max_tokens turn carrying only a malformed tool call', async () => {
    // Every turn: one unparseable tool call + max_tokens. A naive "continue on any
    // tool call" would loop to maxTurns; the well-formed-only guard stops it fast.
    mockClaudeChat.mockImplementation(emits([
      { type: 'tool_use', id: 't1', name: 'do_work', input: { _parse_error: 'bad json' } } as StreamEvent,
      { type: 'done', stopReason: 'max_tokens' } as StreamEvent,
    ]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // Did not run away to the 200-turn cap.
    expect(mockClaudeChat.mock.calls.length).toBeLessThan(10);
    expect(result).toBeTruthy();
    expect(result.stopReason).toBe('error');
  });

  it('stops re-prompting once the recovery limit is exhausted and marks the result incomplete', async () => {
    // Always truncate empty → recovery fires 3 times then gives up on the 4th.
    mockClaudeChat.mockImplementation(emits([{ type: 'done', stopReason: 'max_tokens' } as StreamEvent]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // 1 initial + 3 recovery attempts = 4 calls, then it stops (does not spin to maxTurns).
    expect(mockClaudeChat).toHaveBeenCalledTimes(4);
    expect(result.text).toContain('output token limit');
    expect(result.stopReason).toBe('error');
  });

  it('marks a run that consumes all configured turns as max_turns', async () => {
    mockClaudeChat.mockImplementation(emits([
      { type: 'tool_use', id: 't1', name: 'do_work', input: { x: 1 } } as StreamEvent,
      { type: 'done', stopReason: 'tool_use' } as StreamEvent,
    ]));

    const result = await runSubagentLoop({
      agent: { ...agent, maxTurns: 1 },
      task: 'do the thing',
    });

    expect(result.stopReason).toBe('max_turns');
    expect(result.turnCount).toBe(1);
  });

  // Gap fix: subagentLoop previously never called applyDeclaredCapabilities/resolveModelDeclared,
  // so a custom provider's declared capabilities had no effect on the subagent (only on the main
  // agentLoop). Verifies the subagent now resolves per-model declared caps the same way, using
  // 'claude-opus-4-8' (a known reasoning model, thinking='anthropic' by default) as the probe:
  // declaring supportsReasoning:false must visibly gate enableThinking off.
  it('applies provider-declared capabilities to the subagent (gates reasoning + reaches chatOptions)', async () => {
    type Opts = { enableThinking?: boolean; declaredCapabilities?: { supportsReasoning?: boolean } };

    // Baseline: no declared capabilities → the model's default reasoning behavior applies.
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));
    await runSubagentLoop({ agent, task: 'do the thing' });
    const baselineOpts = mockClaudeChat.mock.calls[0][1] as Opts;
    expect(baselineOpts.enableThinking).toBe(true);

    // Provider declares supportsReasoning:false for this model → must gate thinking off,
    // and declaredCapabilities itself must be threaded into chatOptions so the adapter's
    // request processors (tools/reasoning gating) can see it too.
    mockGetActiveProvider.mockReturnValue({
      id: 'p1',
      apiFormat: 'anthropic',
      baseUrl: undefined,
      models: [],
      declaredCapabilities: { supportsReasoning: false },
    });
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'ok' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));
    await runSubagentLoop({ agent, task: 'do the thing' });
    const declaredOpts = mockClaudeChat.mock.calls[1][1] as Opts;
    expect(declaredOpts.declaredCapabilities?.supportsReasoning).toBe(false);
    expect(declaredOpts.enableThinking).toBeUndefined();
  });

  // Subagent image visibility: a tool that returns rich content (screenshot /
  // read_file image) must surface the raw blocks on the tool-end progress
  // event — the parent's child-step visualization renders images from exactly
  // this field, and it used to be silently dropped by the stringification.
  it('tool-end progress event carries resultContent for rich tool results, omits it for strings', async () => {
    const imageResult = [
      { type: 'text', text: 'Image: /tmp/shot.png (37KB, image/png)' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ];
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool
      .mockResolvedValueOnce(imageResult)   // t1: rich result
      .mockResolvedValueOnce('plain text'); // t2: string result

    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 't1', name: 'computer', input: { action: 'screenshot' } } as StreamEvent,
        { type: 'tool_use', id: 't2', name: 'read_file', input: { path: '/a' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; id?: string; resultContent?: unknown }> = [];
    await runSubagentLoop({ agent, task: 'do the thing', onProgress: (e) => events.push(e) });

    const toolEnds = events.filter((e) => e.type === 'tool-end');
    expect(toolEnds).toHaveLength(2);
    const byId = Object.fromEntries(toolEnds.map((e) => [e.id!, e]));
    expect(byId.t1.resultContent).toEqual(imageResult);
    expect(byId.t2.resultContent).toBeUndefined();
  });

  it('attaches cumulative token usage to a completed tool turn progress event', async () => {
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool.mockResolvedValueOnce('ok');
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } as StreamEvent,
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/a' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 5 } } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
    await runSubagentLoop({ agent, task: 'do the thing', onProgress: (event) => events.push(event) });

    expect(events.find((event) => event.type === 'turn-complete')).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 25 },
    });
  });

  it.each([
    ['agent allowlist', { tools: ['read_file'] }, 'write_file'],
    ['agent denylist', { tools: [], disallowedTools: ['write_file'] }, 'write_file'],
    ['always-blocked orchestration tool', { tools: [] }, 'run_agent_batch'],
  ])('rejects a hostile model call outside the frozen %s roster', async (_label, boundary, toolName) => {
    mockGetAllTools.mockReturnValue([
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
      { name: 'run_agent_batch', description: 'batch', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 'hostile-tool', name: toolName, input: { path: '/tmp/x' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'reported boundary failure' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; id?: string; result?: string; error?: boolean }> = [];
    await runSubagentLoop({
      agent: { ...agent, ...boundary },
      task: 'attempt an unavailable tool',
      onProgress: (event) => events.push(event),
    });

    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-end',
      id: 'hostile-tool',
      error: true,
      result: expect.stringContaining('fixed tool boundary'),
    }));
  });

  it('rechecks constrained tool input after a preToolCall hook modifies it', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'run_command', description: 'run', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockEmitHook.mockImplementation((event: unknown) => {
      const hookEvent = event as { type?: string };
      return hookEvent.type === 'preToolCall'
        ? { ...hookEvent, modifiedInput: { command: 'rm -rf /tmp/forbidden' } }
        : event;
    });
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 'hook-mutated', name: 'run_command', input: { command: 'npm run test:unit' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'reported boundary failure' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; id?: string; result?: string; error?: boolean }> = [];
    await runSubagentLoop({
      agent: { ...agent, tools: ['run_command(npm run *)'] },
      task: 'run a safe command',
      onProgress: (event) => events.push(event),
    });

    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-end',
      id: 'hook-mutated',
      error: true,
      result: expect.stringContaining('fixed tool boundary'),
    }));
  });

  it('rechecks the parent run constraint after a preToolCall hook modifies input', async () => {
    mockGetAllTools.mockReturnValue([
      { name: 'run_command', description: 'run', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
    ]);
    mockEmitHook.mockImplementation((event: unknown) => {
      const hookEvent = event as { type?: string };
      return hookEvent.type === 'preToolCall'
        ? { ...hookEvent, modifiedInput: { command: 'rm -rf /tmp/forbidden' } }
        : event;
    });
    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 'parent-hook-mutated', name: 'run_command', input: { command: 'npm run test:unit' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'reported boundary failure' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; id?: string; result?: string; error?: boolean }> = [];
    await runSubagentLoop({
      agent,
      task: 'run a safe command',
      allowedTools: ['run_command(npm run *)'],
      onProgress: (event) => events.push(event),
    });

    expect(mockExecuteAnyTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-end',
      id: 'parent-hook-mutated',
      error: true,
      result: expect.stringContaining('not allowed for this agent run'),
    }));
  });

  it('keeps the generic Error-prefix contract for child tool progress', async () => {
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool.mockResolvedValueOnce('Error: permission denied');

    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/ok' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'done' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    const events: Array<{ type: string; id?: string; error?: boolean; result?: string }> = [];
    await runSubagentLoop({ agent, task: 'do the thing', onProgress: (e) => events.push(e) });

    const toolEnds = events.filter((e) => e.type === 'tool-end');
    expect(toolEnds).toEqual([
      expect.objectContaining({ id: 't1', result: 'Error: permission denied', error: true }),
    ]);
  });

  it('bounds the canonical long-run history while preserving every tool pairing and the newest images', async () => {
    // Deliberately repeat the first raw provider id. Owner release must bind by
    // array position, not `.find(id)`, or both evicted tokens clear only the
    // first call and the second rich payload leaks in both history projections.
    const toolIds = ['duplicate', 'duplicate', ...Array.from({ length: 8 }, (_, index) => `t${index + 2}`)];
    const imageResults = Array.from({ length: 10 }, (_, index) => ([
      { type: 'text', text: `Screenshot ${index}` },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: index.toString(36).padStart(4, 'A') },
      },
    ]));
    mockExecuteAnyTool.mockReset();
    for (const result of imageResults) mockExecuteAnyTool.mockResolvedValueOnce(result);
    for (let index = 0; index < imageResults.length; index++) {
      mockClaudeChat.mockImplementationOnce(emits([
        { type: 'tool_use', id: toolIds[index], name: 'computer', input: { action: 'screenshot' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]));
    }
    mockClaudeChat.mockImplementationOnce(emits([
      { type: 'text', text: 'done' } as StreamEvent,
      { type: 'done', stopReason: 'end_turn' } as StreamEvent,
    ]));

    await runSubagentLoop({ agent, task: 'take ten screenshots' });

    type HistoryCall = { id: string; result?: string; resultContent?: unknown[] };
    type HistoryMessage = { toolCalls?: HistoryCall[]; toolCallsForContext?: HistoryCall[] };
    const finalHistory = mockClaudeChat.mock.calls.at(-1)?.[0] as HistoryMessage[];
    const primaryCalls = finalHistory.flatMap((message) => message.toolCalls ?? []);
    const contextCalls = finalHistory.flatMap((message) => message.toolCallsForContext ?? []);
    const primaryWithImages = primaryCalls.filter((call) => call.resultContent?.some((block) => (
      block as { type?: string }
    ).type === 'image'));
    const contextWithImages = contextCalls.filter((call) => call.resultContent?.some((block) => (
      block as { type?: string }
    ).type === 'image'));

    expect(primaryCalls.map((call) => call.id)).toEqual(toolIds);
    expect(contextCalls.map((call) => call.id)).toEqual(toolIds);
    expect(primaryWithImages.map((call) => call.id)).toEqual(toolIds.slice(2));
    expect(contextWithImages.map((call) => call.id)).toEqual(toolIds.slice(2));
    expect(primaryCalls.every((call) => call.result !== undefined)).toBe(true);
    expect(contextCalls.every((call) => call.result !== undefined)).toBe(true);
  });

  // The subagent's OWN eyes: a vision-capable model must receive its tool
  // results' image blocks back in its next-turn context (it used to be sent
  // text-only with supportsVision hardcoded false — a subagent that took a
  // screenshot could never look at it).
  it('feeds tool-result images back into the subagent\'s own next-turn context, with vision resolved per model', async () => {
    const imageResult = [
      { type: 'text', text: 'Image: /tmp/shot.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ];
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool.mockResolvedValueOnce(imageResult);

    mockClaudeChat
      .mockImplementationOnce(emits([
        { type: 'tool_use', id: 't1', name: 'computer', input: { action: 'screenshot' } } as StreamEvent,
        { type: 'done', stopReason: 'tool_use' } as StreamEvent,
      ]))
      .mockImplementationOnce(emits([
        { type: 'text', text: 'looks good' } as StreamEvent,
        { type: 'done', stopReason: 'end_turn' } as StreamEvent,
      ]));

    await runSubagentLoop({ agent, task: 'screenshot and verify' });

    // supportsVision resolved from the model's real capabilities (claude-opus-4-8
    // per this harness's resolveAgentModel mock), not hardcoded false.
    const firstOpts = mockClaudeChat.mock.calls[0][1] as { supportsVision?: boolean };
    expect(firstOpts.supportsVision).toBe(true);

    // The second turn's history carries the image blocks for the adapter's
    // normalizer to turn into vision content.
    type CtxMessage = { toolCallsForContext?: Array<{ id?: string; resultContent?: unknown }> };
    const secondMessages = mockClaudeChat.mock.calls[1][0] as CtxMessage[];
    const withCtx = secondMessages.find((m) => m.toolCallsForContext?.length);
    expect(withCtx).toBeDefined();
    expect(withCtx!.toolCallsForContext![0].id).toBe('t1');
    expect(withCtx!.toolCallsForContext![0].resultContent).toEqual(imageResult);
  });
});
