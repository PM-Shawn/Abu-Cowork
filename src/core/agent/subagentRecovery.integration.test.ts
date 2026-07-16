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

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ currentPath: '/tmp/project' }), subscribe: vi.fn() },
}));

const mockClaudeChat = vi.fn();
vi.mock('../llm/claude', () => ({ ClaudeAdapter: class { chat = mockClaudeChat; } }));
vi.mock('../llm/openai-compatible', () => ({ OpenAICompatibleAdapter: class { chat = vi.fn(); } }));

const mockExecuteAnyTool = vi.fn();
vi.mock('../tools/registry', () => ({
  getAllTools: vi.fn().mockReturnValue([]),
  executeAnyTool: (...args: unknown[]) => mockExecuteAnyTool(...args),
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

const mockGetActiveProvider = vi.fn(
  (..._args: unknown[]): Partial<ProviderInstance> | undefined => ({
    id: 'p1',
    apiFormat: 'anthropic',
    baseUrl: undefined,
    models: [],
  }),
);
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ agentMaxTurns: 200, maxOutputTokens: undefined, contextWindowSize: undefined }) },
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getActiveApiKey: () => 'sk-test',
  resolveAgentModel: () => 'claude-opus-4-8',
}));

vi.mock('../../stores/discoveredCapabilitiesStore', () => ({
  useDiscoveredCapsStore: { getState: () => ({ get: () => undefined, recordReasoningObserved: vi.fn() }) },
}));

vi.mock('../enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: () => ({ apiKey: 'sk-test', baseUrl: undefined }),
}));

import { runSubagentLoop, SubagentResult } from './subagentLoop';

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
    mockExecuteAnyTool.mockReset();
    mockExecuteAnyTool.mockResolvedValue('tool output');
    mockGetActiveProvider.mockReset();
    mockGetActiveProvider.mockReturnValue({ id: 'p1', apiFormat: 'anthropic', baseUrl: undefined, models: [] });
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

  // Contract that agentLoop's @agent delegate branch depends on: when the user
  // aborts MID-RUN, runSubagentLoop RETURNS a (partial/cancelled) SubagentResult
  // — it does NOT throw. Therefore the delegate branch must re-check
  // signal.aborted AFTER the await to report {reason:'aborted'}; a throw-based
  // abort path would never fire. If anyone regresses this to throw on abort, the
  // delegate abort fix silently breaks — this test guards the premise.
  //
  // Note: an already-aborted-at-entry signal is deliberately IGNORED (stale-abort
  // guard in runSubagentLoop), so the real cancellation shape is a mid-run abort.
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
  });

  it('stops re-prompting once the recovery limit is exhausted and marks the result incomplete', async () => {
    // Always truncate empty → recovery fires 3 times then gives up on the 4th.
    mockClaudeChat.mockImplementation(emits([{ type: 'done', stopReason: 'max_tokens' } as StreamEvent]));

    const result = await runSubagentLoop({ agent, task: 'do the thing' });

    // 1 initial + 3 recovery attempts = 4 calls, then it stops (does not spin to maxTurns).
    expect(mockClaudeChat).toHaveBeenCalledTimes(4);
    expect(result.text).toContain('output token limit');
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
});
