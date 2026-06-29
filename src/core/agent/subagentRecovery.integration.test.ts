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

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ currentPath: '/tmp/project' }), subscribe: vi.fn() },
}));

const mockClaudeChat = vi.fn();
vi.mock('../llm/claude', () => ({ ClaudeAdapter: class { chat = mockClaudeChat; } }));
vi.mock('../llm/openai-compatible', () => ({ OpenAICompatibleAdapter: class { chat = vi.fn(); } }));

vi.mock('../tools/registry', () => ({
  getAllTools: vi.fn().mockReturnValue([]),
  executeAnyTool: vi.fn(),
  toolResultToString: (r: unknown) => String(r),
}));

vi.mock('../memdir/scan', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  loadMemoryIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock('../context/contextManager', () => ({
  prepareContextMessages: vi.fn((msgs: unknown) => msgs),
}));
vi.mock('../context/contextCompressor', () => ({
  compressContextIfNeeded: vi.fn().mockResolvedValue({ compressed: false, messages: [] }),
}));
vi.mock('../observability/langfuse', () => ({ startSubagentSpan: vi.fn().mockReturnValue({ end: vi.fn() }) }));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ agentMaxTurns: 200, maxOutputTokens: undefined, contextWindowSize: undefined }) },
  getActiveProvider: () => ({ id: 'p1', apiFormat: 'anthropic', baseUrl: undefined }),
  getActiveApiKey: () => 'sk-test',
  resolveAgentModel: () => 'claude-opus-4-8',
}));

vi.mock('../../stores/discoveredCapabilitiesStore', () => ({
  useDiscoveredCapsStore: { getState: () => ({ get: () => undefined, recordReasoningObserved: vi.fn() }) },
}));

vi.mock('../enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: () => ({ apiKey: 'sk-test', baseUrl: undefined }),
}));

import { runSubagentLoop } from './subagentLoop';

/** Build a fake adapter.chat that synchronously emits the given stream events. */
function emits(events: StreamEvent[]) {
  return async (_msgs: unknown, _opts: unknown, onEvent: (e: StreamEvent) => void) => {
    for (const e of events) onEvent(e);
  };
}

const agent = { name: 'tester', systemPrompt: 'sys', tools: [] } as never;

describe('subagent max_tokens recovery (integration)', () => {
  beforeEach(() => {
    mockClaudeChat.mockReset();
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

  it('stops re-prompting once the recovery limit is exhausted and marks the result incomplete', async () => {
    // Always truncate empty → recovery fires 3 times then gives up on the 4th.
    mockClaudeChat.mockImplementation(emits([{ type: 'done', stopReason: 'max_tokens' } as StreamEvent]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // 1 initial + 3 recovery attempts = 4 calls, then it stops (does not spin to maxTurns).
    expect(mockClaudeChat).toHaveBeenCalledTimes(4);
    expect(result.text).toContain('token 上限');
  });
});
