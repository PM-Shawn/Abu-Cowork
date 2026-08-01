/**
 * Port-frame coalescer — P1-3b-2's generalization of P1-1's `eventCoalescer`
 * (see `eventCoalescer.ts`'s module doc for the original merge discipline)
 * to the THREE ports the main agent loop's sidecar run will stream deltas
 * over (design doc §3 "chatDelta (28法)" / "executionPort" / "scratchpadPort"
 * rows — all three share one signal and one FIFO ordering, per that table:
 * "与 chatDelta 共享合帧器与顺序（步骤先于结果的因果链靠单信道 FIFO）").
 *
 * Unlike `eventCoalescer.ts` (pure, timer-free — the ~16ms window lives in
 * its OWN caller, `llmHost.ts`), this module owns its window timer directly
 * — `portFrameSenders.ts` (item 2) just calls `push()`, never touches
 * `setTimeout` itself. DORMANT this batch: nothing calls
 * `createPortFrameCoalescer` yet (3b-3 wires it into the per-run sidecar
 * host) — this file is pure, independently unit-testable machinery.
 *
 * Frame shape: `{ p: port, m: method, a: raw args }` — see this batch's
 * `portFrameSenders.ts` (item 2) for the producers and `frameApplier.ts`
 * (item 3) for the shell-side consumer. `p`/`m` intentionally short (wire
 * payload, not a human-facing API).
 *
 * ## Merge rule (generalizes eventCoalescer's "same StreamEvent type,
 * consecutive" rule to "same port+method+target, consecutive")
 *
 * A pushed frame merges into the LAST pending frame iff ALL of:
 *   - same `p` (port)
 *   - same `m` (method) — one of the two append-token methods:
 *     `chat`/`appendText` or `chat`/`appendThinking` (see chatDelta.ts:
 *     `appendText(convId, token, msgId?)` / `appendThinking(convId,
 *     thinking, msgId?)` — `a[0]` = convId, `a[1]` = token/thinking string,
 *     `a[2]` = optional msgId)
 *   - same target: `a[0]` (convId) AND `a[2]` (msgId, including both
 *     undefined — two consecutive appendText calls that both omit msgId
 *     target "the last message" and are safe to merge)
 * merge = string-concat `a[1]`, everything else (a[0], a[2]) kept from the
 * FIRST of the pair (they're required-equal by the merge condition anyway).
 *
 * ALL other frames (every other chat method, every exec method, every
 * scratchpad method, every session method) append in order, NEVER merged,
 * NEVER reordered relative to each other or relative to a merged run — this
 * is the design doc's "order is the UI's causal chain" invariant
 * (`setMessageToolCalls` must be visible before the approval dialog the
 * following `tool.invoke` request triggers, etc.). A non-mergeable frame
 * arriving while a mergeable run is pending flushes that pending frame
 * FIRST (in the same `push()` return), then the new frame follows — total
 * order is a strict FIFO of "logical frames after merging", exactly like
 * `eventCoalescer.ts`'s discipline.
 */

export interface PortFrame {
  /** Port discriminant. */
  p: 'chat' | 'exec' | 'scratchpad' | 'session';
  /** Method name on that port's real in-process implementation. */
  m: string;
  /** Raw args, in the real method's own parameter order. */
  a: unknown[];
}

/**
 * `appendText` streams INCREMENTAL tokens — consecutive frames' `a[1]`
 * strings are CONCATENATED.
 */
const APPEND_MERGE_METHODS = new Set(['appendText']);
/**
 * `appendThinking` maps to `updateMessageThinking`, whose semantics are
 * REPLACE, not append: each `a[1]` is already the FULL accumulated thinking
 * text for the call (see `chatStore.ts`'s `updateMessageThinking` doc —
 * "REPLACE (not append) semantics … the buffer just remembers the latest
 * value"). Concatenating consecutive frames would duplicate the whole
 * accumulated text over and over ("A"→"AB"→"ABC" merged as "A"+"AB"+"ABC")
 * — the garbled, ever-growing repeated thinking bug real-machine smoke
 * caught. A coalesced run of these keeps ONLY THE LATEST frame's value.
 */
const REPLACE_MERGE_METHODS = new Set(['appendThinking']);

function isMergeable(frame: PortFrame): boolean {
  return frame.p === 'chat' && (APPEND_MERGE_METHODS.has(frame.m) || REPLACE_MERGE_METHODS.has(frame.m));
}

/** Same convId (a[0]) AND same msgId (a[2], including both-undefined) — see module doc's "same target" bullet. */
function sameTarget(a: PortFrame, b: PortFrame): boolean {
  return a.a[0] === b.a[0] && a.a[2] === b.a[2];
}

function canMergeInto(pending: PortFrame, next: PortFrame): boolean {
  return (
    isMergeable(pending) &&
    isMergeable(next) &&
    pending.m === next.m &&
    sameTarget(pending, next)
  );
}

function mergeInto(pending: PortFrame, next: PortFrame): PortFrame {
  const pendingToken = pending.a[1];
  const nextToken = next.a[1];
  if (typeof pendingToken !== 'string' || typeof nextToken !== 'string') {
    // Defensive — the mergeable-method allowlist above guarantees a[1] is
    // the token/thinking string for appendText/appendThinking; a future
    // refactor that widens MERGEABLE_CHAT_METHODS without updating this
    // function should fail loudly rather than silently corrupt content.
    throw new Error(`portFrameCoalescer: mergeInto called on non-string a[1] for ${pending.p}/${pending.m}`);
  }
  // appendText → concatenate the incremental tokens; appendThinking (REPLACE
  // semantics) → keep ONLY the latest full value, never concatenate.
  const merged = APPEND_MERGE_METHODS.has(pending.m) ? pendingToken + nextToken : nextToken;
  return { p: pending.p, m: pending.m, a: [pending.a[0], merged, pending.a[2]] };
}

const DEFAULT_WINDOW_MS = 16;

export interface PortFrameCoalescer {
  /** Feed one frame in arrival order. Buffers or sends per the merge rule — see module doc. */
  push(frame: PortFrame): void;
  /** Force out the pending buffered frame (if any) synchronously, and clear the window timer. Idempotent. */
  flush(): void;
  /** Number of frames currently buffered, awaiting a flush (0 or 1 — only one mergeable run is ever pending at a time). */
  pendingCount(): number;
}

/**
 * `send` is called with a non-empty, ORDERED batch of frames whenever the
 * window timer fires or `flush()` is called with something pending. Never
 * called with an empty array.
 */
export function createPortFrameCoalescer(
  send: (frames: PortFrame[]) => void,
  opts?: { windowMs?: number },
): PortFrameCoalescer {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;

  let pending: PortFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Non-mergeable frames queued ahead of `pending`, or in place of it — flushed together to preserve arrival order in one `send()` batch. */
  let queued: PortFrame[] = [];

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function armTimer(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, windowMs);
  }

  function flush(): void {
    clearTimer();
    if (pending !== null) {
      queued.push(pending);
      pending = null;
    }
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    send(batch);
  }

  function push(frame: PortFrame): void {
    if (isMergeable(frame)) {
      if (pending !== null && canMergeInto(pending, frame)) {
        pending = mergeInto(pending, frame);
      } else {
        if (pending !== null) queued.push(pending);
        pending = frame;
      }
      armTimer();
      return;
    }

    // Non-mergeable: whatever was pending gets queued ahead of it (order
    // preserved), then the new frame is appended too — the whole batch
    // sends together on this SAME push() call (mirrors eventCoalescer's
    // "non-mergeable forces an immediate flush" rule), so a discrete frame
    // never waits out the window behind it.
    if (pending !== null) {
      queued.push(pending);
      pending = null;
    }
    queued.push(frame);
    flush();
  }

  function pendingCount(): number {
    return pending !== null ? 1 : 0;
  }

  return { push, flush, pendingCount };
}
