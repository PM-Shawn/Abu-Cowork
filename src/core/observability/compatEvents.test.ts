/**
 * observeCompatEvent is inert (see compatEvents.ts header — the direct-write
 * channel was deleted with the client single-source decision). The contract
 * that remains: the API accepts every payload shape and never throws, so the
 * adapter call sites in openai-compatible.ts stay safe.
 */
import { describe, it, expect } from 'vitest';
import { observeCompatEvent } from './compatEvents';

describe('observeCompatEvent', () => {
  it('never throws, for any kind or payload', () => {
    const kinds = [
      'unknown_finish_reason',
      'dropped_tool_calls',
      'error_finish_reason',
      'content_filtered',
    ] as const;
    for (const kind of kinds) {
      expect(() => observeCompatEvent({ kind })).not.toThrow();
    }
    expect(() =>
      observeCompatEvent({
        kind: 'content_filtered',
        modelId: 'gpt-4o',
        requestHost: 'api.openai.com',
        finishReason: 'content_filter',
        toolCallCount: 3,
      })
    ).not.toThrow();
  });
});
