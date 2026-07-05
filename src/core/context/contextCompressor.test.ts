import { describe, it, expect, vi } from 'vitest';
import { compressContextIfNeeded } from './contextCompressor';
import type { Message } from '../../types';
import type { LLMAdapter } from '../llm/adapter';

/** Build `rounds` user/assistant pairs with enough text to cross the 65% threshold. */
function makeMessages(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ id: `u${i}`, role: 'user', content: 'user message body '.repeat(30) + i, timestamp: 1 });
    msgs.push({ id: `a${i}`, role: 'assistant', content: 'assistant reply body '.repeat(30) + i, timestamp: 2 });
  }
  return msgs;
}

describe('compressContextIfNeeded — independent timeout (Bug 1: 同意后死寂)', () => {
  it('resolves to a graceful failure when the summarization LLM call hangs — never blocks the loop', async () => {
    // Adapter whose chat() never resolves — simulates the flaky pool stalling.
    const hangingAdapter = {
      chat: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
    } as unknown as LLMAdapter;

    const start = Date.now();
    const result = await compressContextIfNeeded(
      makeMessages(8),        // 8 rounds > RECENT_ROUNDS_TO_KEEP + 1
      'system',
      2000,                   // contextWindowSize
      500,                    // reserveForOutput → maxInput 1500, threshold ~975
      { adapter: hangingAdapter, model: 'm', apiKey: 'k', timeoutMs: 50 },
    );
    const elapsed = Date.now() - start;

    expect(hangingAdapter.chat).toHaveBeenCalled();   // compression WAS attempted (over threshold)
    expect(result.compressed).toBe(false);            // fell back gracefully
    expect(result.failed).toBe(true);
    expect(result.failureCode).toBe('timeout');
    expect(result.messages).toHaveLength(16);         // original messages returned intact
    expect(elapsed).toBeLessThan(2000);               // did NOT hang for 90s
  });

  it('does not call the LLM when below the compression threshold', async () => {
    const adapter = { chat: vi.fn() } as unknown as LLMAdapter;
    const result = await compressContextIfNeeded(
      makeMessages(2),
      'system',
      1_000_000,              // huge window → far below threshold
      500,
      { adapter, model: 'm', apiKey: 'k', timeoutMs: 50 },
    );
    expect(adapter.chat).not.toHaveBeenCalled();
    expect(result.compressed).toBe(false);
    expect(result.failed).toBeFalsy();
  });
});
