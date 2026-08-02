/**
 * Event coalescer — pure merge logic for the sidecar's LLM event stream.
 *
 * Context: `LLMAdapter.chat()`'s `onEvent` callback fires the `StreamEvent`
 * union defined in `src/types/index.ts` (text / thinking / tool_use /
 * tool_result / usage / done / error). This is already ONE LEVEL ABOVE the
 * provider wire protocol — the Claude adapter, for example, only calls
 * `onEvent({type:'thinking', ...})` once per whole thinking block (at
 * `content_block_stop`), while `onEvent({type:'text', ...})` fires once per
 * SSE `text_delta` chunk (i.e. still high-frequency). The OpenAI-compatible
 * adapter streams BOTH text and thinking as per-chunk deltas. So the
 * high-frequency case this module exists to batch is: many consecutive
 * `text` (or `thinking`) events in a row, each carrying a small delta.
 *
 * `StreamEvent` carries no content-block index — by the time an event
 * reaches this module, the adapter has already flattened away any
 * block/index bookkeeping. This module's merge rule is therefore simplified
 * from "same content block" (the wire-protocol-level framing that the task
 * card describes) to "same StreamEvent `type`, both text or both thinking,
 * consecutively": whenever a delta event arrives immediately after another
 * delta event of the SAME type, concatenate; a delta of a DIFFERENT type (or
 * any non-delta event) forces the pending delta out first. This is safe
 * because every consumer of the `text`/`thinking` events treats them as an
 * ordered concatenation stream regardless of which underlying provider
 * "block" produced them (see agentLoop's buffer accumulation) — merging
 * across a block boundary within the same event type never changes the
 * resulting concatenated text, only how many wire messages carried it.
 *
 * This module is deliberately synchronous and timer-free — it does no
 * batching by itself. The ~16ms sender-side window that decides WHEN to
 * flush a buffered delta lives in sidecar/src/llmHost.ts, which calls
 * `push()`/`flush()` here and schedules the timer around them. Keeping the
 * merge rule here pure (no timers, no I/O) is what makes it exhaustively
 * unit-testable without fake timers.
 */

import type { StreamEvent } from '@/types';

type MergeableEvent = Extract<StreamEvent, { type: 'text' } | { type: 'thinking' }>;

function isMergeable(event: StreamEvent): event is MergeableEvent {
  return event.type === 'text' || event.type === 'thinking';
}

function mergeInto(pending: MergeableEvent, next: MergeableEvent): MergeableEvent {
  if (pending.type === 'text' && next.type === 'text') {
    return { type: 'text', text: pending.text + next.text };
  }
  if (pending.type === 'thinking' && next.type === 'thinking') {
    return { type: 'thinking', thinking: pending.thinking + next.thinking };
  }
  // Different mergeable types (text vs thinking) never reach here — callers
  // must flush before starting a new pending run of a different type. Kept
  // as a defensive throw so a future refactor can't silently corrupt order.
  throw new Error(`eventCoalescer: mergeInto called with mismatched types ${pending.type}/${next.type}`);
}

export interface EventCoalescer {
  /**
   * Feed one event in arrival order. Returns the events that must be sent
   * immediately, IN ORDER — empty when the event was absorbed into the
   * pending buffer (i.e. it will go out later, via a subsequent `push`'s
   * flush, an explicit `flush()`, or the sender's timer). Never reorders:
   * any events returned here are always exactly the pending buffer (if any)
   * followed by `event` itself (for non-mergeable events) — total order is
   * preserved.
   */
  push(event: StreamEvent): StreamEvent[];
  /** Force out the pending buffered event, if any. Idempotent — returns [] when nothing is pending. */
  flush(): StreamEvent[];
  /** Whether a delta is currently buffered and awaiting a flush (drives the sender's timer arm/disarm). */
  hasPending(): boolean;
}

export function createEventCoalescer(): EventCoalescer {
  let pending: MergeableEvent | null = null;

  function flush(): StreamEvent[] {
    if (!pending) return [];
    const out = pending;
    pending = null;
    return [out];
  }

  function push(event: StreamEvent): StreamEvent[] {
    if (isMergeable(event)) {
      if (pending && pending.type === event.type) {
        pending = mergeInto(pending, event);
        return [];
      }
      const flushed = flush();
      pending = event;
      return flushed;
    }
    // Non-mergeable (tool_use / tool_result / usage / done / error): flush
    // whatever was pending FIRST, then the event itself goes out immediately
    // — never buffered — so total order across types is never violated.
    const flushed = flush();
    flushed.push(event);
    return flushed;
  }

  function hasPending(): boolean {
    return pending !== null;
  }

  return { push, flush, hasPending };
}
