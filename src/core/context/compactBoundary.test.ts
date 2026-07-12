import { describe, it, expect, beforeEach } from 'vitest';
import type { Message } from '@/types';
import {
  COMPACT_BOUNDARY_ID_PREFIX,
  isCompactBoundary,
  findLastCompactBoundary,
  createCompactBoundaryMarker,
  computeCompactionPlan,
  buildContextFromBoundary,
} from './compactBoundary';
import { RECENT_ROUNDS_TO_KEEP } from './contextUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function msg(
  role: 'user' | 'assistant' | 'system',
  overrides: Partial<Message> = {},
): Message {
  _seq++;
  return {
    id: `msg-${_seq}`,
    role,
    content: `content-${_seq}`,
    timestamp: 1000 * _seq,
    ...overrides,
  };
}

function resetSeq() {
  _seq = 0;
}

/** Create a valid compact-boundary marker directly (for test setup). */
function makeMarker(
  fromId: string,
  toId: string,
  summaryText = 'summary',
  ts = 999_000,
): Message {
  return createCompactBoundaryMarker({
    summaryText,
    summarizedFromId: fromId,
    summarizedToId: toId,
    source: 'auto',
    timestamp: ts,
  });
}

/**
 * Build a flat message array with the requested number of full rounds
 * (user + assistant pairs).
 */
function buildRounds(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(msg('user'));
    messages.push(msg('assistant'));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// isCompactBoundary
// ---------------------------------------------------------------------------

describe('isCompactBoundary', () => {
  it('returns true for a valid marker (id prefix + payload)', () => {
    const m = makeMarker('a', 'b');
    expect(isCompactBoundary(m)).toBe(true);
  });

  it('returns false for an ordinary user message', () => {
    resetSeq();
    expect(isCompactBoundary(msg('user'))).toBe(false);
  });

  it('returns false for an ordinary assistant message', () => {
    resetSeq();
    expect(isCompactBoundary(msg('assistant'))).toBe(false);
  });

  it('returns false for a plain system message (isSystem=true, no prefix or payload)', () => {
    resetSeq();
    expect(isCompactBoundary(msg('system', { isSystem: true }))).toBe(false);
  });

  it('returns false when id has the prefix but compactBoundary payload is absent', () => {
    resetSeq();
    const m = msg('system', { id: `${COMPACT_BOUNDARY_ID_PREFIX}abc` });
    expect(isCompactBoundary(m)).toBe(false);
  });

  it('returns false when compactBoundary payload is present but id prefix is wrong', () => {
    const m = makeMarker('a', 'b');
    const withBadId: Message = { ...m, id: 'no-prefix-here' };
    expect(isCompactBoundary(withBadId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findLastCompactBoundary
// ---------------------------------------------------------------------------

describe('findLastCompactBoundary', () => {
  it('returns null for an empty array', () => {
    expect(findLastCompactBoundary([])).toBeNull();
  });

  it('returns null when there are no markers', () => {
    resetSeq();
    expect(findLastCompactBoundary([msg('user'), msg('assistant')])).toBeNull();
  });

  it('returns the single marker with its correct index', () => {
    resetSeq();
    const u = msg('user');
    const a = msg('assistant');
    const m = makeMarker(u.id, a.id);
    const result = findLastCompactBoundary([u, a, m]);
    expect(result).not.toBeNull();
    expect(result!.marker.id).toBe(m.id);
    expect(result!.index).toBe(2);
  });

  it('returns the LAST (highest-index) marker when multiple markers exist', () => {
    resetSeq();
    const u1 = msg('user');
    const a1 = msg('assistant');
    const marker1 = makeMarker(u1.id, a1.id, 'first', 1001);
    const u2 = msg('user');
    const a2 = msg('assistant');
    const marker2 = makeMarker(u2.id, a2.id, 'second', 1002);

    const messages = [u1, a1, marker1, u2, a2, marker2];
    const result = findLastCompactBoundary(messages);
    expect(result).not.toBeNull();
    expect(result!.marker.id).toBe(marker2.id);
    expect(result!.index).toBe(5);
  });

  it('returns the first element when a single marker is at index 0', () => {
    const m = makeMarker('x', 'y');
    const result = findLastCompactBoundary([m]);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createCompactBoundaryMarker
// ---------------------------------------------------------------------------

describe('createCompactBoundaryMarker', () => {
  const TS = 1_700_000_000_000;

  it('builds the id with prefix + base-36 timestamp + a random suffix (collision-safe)', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'text',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'auto',
      timestamp: TS,
    });
    expect(m.id).toMatch(new RegExp(`^${COMPACT_BOUNDARY_ID_PREFIX}${TS.toString(36)}-[a-z0-9]+$`));
    // Two markers in the same millisecond must not collide.
    const m2 = createCompactBoundaryMarker({
      summaryText: 'text',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'auto',
      timestamp: TS,
    });
    expect(m.id).not.toBe(m2.id);
  });

  it('sets role to "system"', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'x',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'manual',
      timestamp: TS,
    });
    expect(m.role).toBe('system');
  });

  it('sets content to empty string', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'x',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'auto',
      timestamp: TS,
    });
    expect(m.content).toBe('');
  });

  it('does NOT set isSystem', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'x',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'auto',
      timestamp: TS,
    });
    expect(m.isSystem).toBeUndefined();
  });

  it('stores all payload fields correctly', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'hello',
      summarizedFromId: 'from-id',
      summarizedToId: 'to-id',
      source: 'manual',
      timestamp: TS,
    });
    const b = m.compactBoundary!;
    expect(b.summaryText).toBe('hello');
    expect(b.summarizedFromId).toBe('from-id');
    expect(b.summarizedToId).toBe('to-id');
    expect(b.source).toBe('manual');
    expect(b.createdAt).toBe(TS);
  });

  it('sets timestamp on the Message itself equal to the param', () => {
    const m = createCompactBoundaryMarker({
      summaryText: 'x',
      summarizedFromId: 'f',
      summarizedToId: 't',
      source: 'auto',
      timestamp: TS,
    });
    expect(m.timestamp).toBe(TS);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionPlan
// ---------------------------------------------------------------------------

describe('computeCompactionPlan', () => {
  beforeEach(() => resetSeq());

  it('returns null when the history is empty', () => {
    expect(computeCompactionPlan([])).toBeNull();
  });

  it(`returns null when rounds ≤ ${RECENT_ROUNDS_TO_KEEP + 1} (not enough to compact)`, () => {
    // RECENT_ROUNDS_TO_KEEP + 1 = 5 rounds → still null
    const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 1);
    expect(computeCompactionPlan(messages)).toBeNull();
  });

  it('returns null for exactly RECENT_ROUNDS_TO_KEEP rounds', () => {
    const messages = buildRounds(RECENT_ROUNDS_TO_KEEP);
    expect(computeCompactionPlan(messages)).toBeNull();
  });

  it(`returns a plan when rounds > ${RECENT_ROUNDS_TO_KEEP + 1}`, () => {
    // 6 rounds: firstRound=0, middleRounds=[1], recentRounds=[2..5]
    const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 2);
    const plan = computeCompactionPlan(messages);
    expect(plan).not.toBeNull();
  });

  it('middleMessages contains only the middle rounds (not firstRound, not recentRounds)', () => {
    resetSeq();
    // 8 rounds (indices 0..7)
    // firstRound=0; recentRounds=4..7; middleRounds=1..3
    const numRounds = RECENT_ROUNDS_TO_KEEP + 4; // 8
    const messages = buildRounds(numRounds);

    const plan = computeCompactionPlan(messages);
    expect(plan).not.toBeNull();

    const { middleMessages, summarizedFromId, summarizedToId } = plan!;

    // First round = rounds[0] = messages[0..1]
    const firstRoundIds = [messages[0].id, messages[1].id];
    // Recent rounds = rounds[4..7] = messages[8..15]
    const recentIds = messages.slice(8).map((m) => m.id);

    for (const id of firstRoundIds) {
      expect(middleMessages.map((m) => m.id)).not.toContain(id);
    }
    for (const id of recentIds) {
      expect(middleMessages.map((m) => m.id)).not.toContain(id);
    }

    // Middle = messages[2..7] (rounds 1..3, i.e. 6 messages)
    expect(middleMessages).toHaveLength(6);
    expect(summarizedFromId).toBe(messages[2].id);
    expect(summarizedToId).toBe(messages[7].id);
  });

  it('filters out existing markers before computing rounds', () => {
    resetSeq();
    // 6 rounds of real messages = RECENT_ROUNDS_TO_KEEP + 2 = 8 messages
    const realMessages = buildRounds(RECENT_ROUNDS_TO_KEEP + 2);
    // Inject a stale marker between round 0 and round 1
    const staleMarker = makeMarker(realMessages[0].id, realMessages[1].id);
    const mixed = [
      realMessages[0],
      realMessages[1],
      staleMarker,
      ...realMessages.slice(2),
    ];

    // With or without the marker the plan should be the same
    const planWithout = computeCompactionPlan(realMessages);
    const planWith = computeCompactionPlan(mixed);

    expect(planWith).not.toBeNull();
    expect(planWith!.summarizedFromId).toBe(planWithout!.summarizedFromId);
    expect(planWith!.summarizedToId).toBe(planWithout!.summarizedToId);
    expect(planWith!.middleMessages).toHaveLength(
      planWithout!.middleMessages.length,
    );
  });

  it('returns correct from/to ids for a minimal 6-round history', () => {
    resetSeq();
    // 6 rounds: [u1,a1] [u2,a2] [u3,a3] [u4,a4] [u5,a5] [u6,a6]
    // firstRound = [u1,a1]
    // recentRounds = last 4 = [u3..a6]
    // middleRounds = [u2,a2]
    const messages = buildRounds(6);
    const plan = computeCompactionPlan(messages);

    expect(plan).not.toBeNull();
    // middleRounds = rounds[1] = messages[2..3]
    expect(plan!.summarizedFromId).toBe(messages[2].id);
    expect(plan!.summarizedToId).toBe(messages[3].id);
    expect(plan!.middleMessages).toHaveLength(2);
  });

  describe('substantiveness + delta guard (opts.estimateTokens)', () => {
    // 100 tokens per message — deterministic estimator for the guard.
    const est = (msgs: { length: number }) => msgs.length * 100;

    it('without estimateTokens, always plans (manual /compact path is unguarded)', () => {
      resetSeq();
      const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 2);
      // no opts → no guard
      expect(computeCompactionPlan(messages)).not.toBeNull();
    });

    it('no marker: returns null when the whole middle is below minNewTokens', () => {
      resetSeq();
      const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 2); // middle = 1 round = 2 msgs = 200 tokens
      expect(computeCompactionPlan(messages, { estimateTokens: est, minNewTokens: 500 })).toBeNull();
      expect(computeCompactionPlan(messages, { estimateTokens: est, minNewTokens: 100 })).not.toBeNull();
    });

    it('marker present: returns null when NEW content since the last marker is below the threshold (no per-turn re-fire)', () => {
      resetSeq();
      // 8 rounds → clean middle = msg[2..7] (6 msgs). Marker covers up to msg[5].
      const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 4);
      const marker = makeMarker(messages[2].id, messages[5].id);
      const mixed = [...messages.slice(0, 6), marker, ...messages.slice(6)];
      // NEW content after msg[5] = msg[6], msg[7] = 2 msgs = 200 tokens
      expect(computeCompactionPlan(mixed, { estimateTokens: est, minNewTokens: 500 })).toBeNull();
    });

    it('marker present: plans again once NEW content since the last marker is substantial', () => {
      resetSeq();
      const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 4);
      const marker = makeMarker(messages[2].id, messages[5].id);
      const mixed = [...messages.slice(0, 6), marker, ...messages.slice(6)];
      // 200 new tokens >= 100 → re-fire allowed
      const plan = computeCompactionPlan(mixed, { estimateTokens: est, minNewTokens: 100 });
      expect(plan).not.toBeNull();
      // Still summarizes the whole raw middle (last-marker-wins send-side).
      expect(plan!.summarizedToId).toBe(messages[7].id);
    });
  });
});

// ---------------------------------------------------------------------------
// buildContextFromBoundary
// ---------------------------------------------------------------------------

describe('buildContextFromBoundary', () => {
  beforeEach(() => resetSeq());

  it('returns the original array unchanged when there are no markers', () => {
    resetSeq();
    const messages = [msg('user'), msg('assistant'), msg('user')];
    const result = buildContextFromBoundary(messages);
    expect(result).toBe(messages); // same reference
  });

  it('returns original array unchanged for an empty array', () => {
    const result = buildContextFromBoundary([]);
    expect(result).toHaveLength(0);
  });

  describe('single marker', () => {
    it('produces [firstRound, summaryMsg, ...recent] with no markers in output', () => {
      resetSeq();
      // Build: [u1,a1] [u2,a2] [u3,a3] [u4,a4] [u5,a5]  → marker summarises [u2..a3]
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const u3 = msg('user');
      const a3 = msg('assistant');
      const u4 = msg('user');
      const a4 = msg('assistant');
      const u5 = msg('user');
      const a5 = msg('assistant');
      const marker = makeMarker(u2.id, a3.id, 'the summary', 99_000);
      const messages = [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5, marker];

      const result = buildContextFromBoundary(messages);

      // No markers in result
      expect(result.every((m) => !isCompactBoundary(m))).toBe(true);

      // First element: u1, a1 verbatim
      expect(result[0].id).toBe(u1.id);
      expect(result[1].id).toBe(a1.id);

      // Third element: injected summary user message
      expect(result[2].role).toBe('user');
      expect(result[2].content).toMatch(/^\[对话历史摘要\]\n/);
      expect(result[2].content).toContain('the summary');
      expect(result[2].id).toBe(`context-summary-${marker.id}`);
      expect(result[2].timestamp).toBe(99_000);

      // Rest: u4, a4, u5, a5
      expect(result[3].id).toBe(u4.id);
      expect(result[4].id).toBe(a4.id);
      expect(result[5].id).toBe(u5.id);
      expect(result[6].id).toBe(a5.id);

      expect(result).toHaveLength(7);
    });

    it('preserves messages before summarizedFromId verbatim', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const marker = makeMarker(u2.id, a2.id);
      const messages = [u1, a1, u2, a2, marker];

      const result = buildContextFromBoundary(messages);
      expect(result[0].id).toBe(u1.id);
      expect(result[1].id).toBe(a1.id);
    });

    it('preserves messages after summarizedToId verbatim', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const u3 = msg('user');
      const a3 = msg('assistant');
      const marker = makeMarker(u2.id, a2.id);
      const messages = [u1, a1, u2, a2, u3, a3, marker];

      const result = buildContextFromBoundary(messages);

      // After summary: u3, a3
      const ids = result.map((m) => m.id);
      expect(ids).toContain(u3.id);
      expect(ids).toContain(a3.id);
    });

    it('works when marker is appended at the very end', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const u3 = msg('user');
      const a3 = msg('assistant');
      // Marker appended last — realistic scenario
      const marker = makeMarker(u2.id, u2.id, 'compact');
      const messages = [u1, a1, u2, a2, u3, a3, marker];

      const result = buildContextFromBoundary(messages);

      expect(result.every((m) => !isCompactBoundary(m))).toBe(true);
      // u2 is summarised; a2, u3, a3 appear after
      const summaryIdx = result.findIndex((m) =>
        m.id.startsWith('context-summary-'),
      );
      expect(summaryIdx).toBeGreaterThanOrEqual(0);
      const after = result.slice(summaryIdx + 1).map((m) => m.id);
      expect(after).toContain(a2.id);
      expect(after).toContain(u3.id);
      expect(after).toContain(a3.id);
    });
  });

  describe('multiple markers', () => {
    it('honours only the last marker', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const u3 = msg('user');
      const a3 = msg('assistant');
      const u4 = msg('user');
      const a4 = msg('assistant');
      const u5 = msg('user');
      const a5 = msg('assistant');

      const marker1 = makeMarker(u2.id, a2.id, 'first summary', 1_001);
      const marker2 = makeMarker(u2.id, a3.id, 'second summary', 1_002);

      const messages = [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5, marker1, marker2];

      const result = buildContextFromBoundary(messages);

      // No markers in result
      expect(result.every((m) => !isCompactBoundary(m))).toBe(true);

      // Summary message from marker2 (not marker1)
      const summaryMsg = result.find((m) =>
        m.id.startsWith('context-summary-'),
      )!;
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg.content).toContain('second summary');
      expect(summaryMsg.id).toBe(`context-summary-${marker2.id}`);

      // u3, a3 should NOT appear (they are covered by marker2's range)
      const ids = result.map((m) => m.id);
      expect(ids).not.toContain(u3.id);
      expect(ids).not.toContain(a3.id);

      // u4, a4, u5, a5 should appear in the tail
      expect(ids).toContain(u4.id);
      expect(ids).toContain(a4.id);
      expect(ids).toContain(u5.id);
      expect(ids).toContain(a5.id);
    });

    it('earlier markers inside the covered range do not appear in the result', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const u2 = msg('user');
      const a2 = msg('assistant');
      const marker1 = makeMarker(u2.id, a2.id, 'old', 1_001);
      const u3 = msg('user');
      const a3 = msg('assistant');
      const u4 = msg('user');
      const a4 = msg('assistant');
      const marker2 = makeMarker(u2.id, a3.id, 'new', 1_002);

      // Realistic: marker1 is between messages, marker2 appended at tail
      const messages = [u1, a1, u2, a2, marker1, u3, a3, u4, a4, marker2];

      const result = buildContextFromBoundary(messages);

      expect(result.every((m) => !isCompactBoundary(m))).toBe(true);

      // marker1 should not appear (it falls within slice(toIdx+1) of marker2? No —
      // marker1 is at index 4, toIdx for marker2 is index of a3 = 6).
      // Actually marker1 is at index 4, and a3 is at index 6 → marker1 falls
      // in slice(toIdx+1) and gets filtered by notMarker. Verified below.
      const ids = result.map((m) => m.id);
      expect(ids).not.toContain(marker1.id);
      expect(ids).not.toContain(marker2.id);
    });
  });

  describe('defensive cases', () => {
    // A stale marker (anchor id gone / inverted range) must return the SAME array
    // reference so the caller (agentLoop) treats it as "no usable marker" and
    // falls through to the live 65% compression — never silently shipping the
    // full un-compacted history as if it were compacted.
    it('returns the same array reference when summarizedFromId is not found', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const marker = makeMarker('ghost-id', a1.id);
      const messages = [u1, a1, marker];

      const result = buildContextFromBoundary(messages);

      expect(result).toBe(messages);
    });

    it('returns the same array reference when summarizedToId is not found', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      const marker = makeMarker(u1.id, 'ghost-id');
      const messages = [u1, a1, marker];

      const result = buildContextFromBoundary(messages);

      expect(result).toBe(messages);
    });

    it('returns the same array reference when toIdx < fromIdx (inverted range)', () => {
      resetSeq();
      const u1 = msg('user');
      const a1 = msg('assistant');
      // Inverted: fromId=a1 (index 1), toId=u1 (index 0)
      const marker = makeMarker(a1.id, u1.id);
      const messages = [u1, a1, marker];

      const result = buildContextFromBoundary(messages);

      expect(result).toBe(messages);
    });

    it('does not throw on a messages array containing only a marker', () => {
      const marker = makeMarker('x', 'y');
      expect(() => buildContextFromBoundary([marker])).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: computeCompactionPlan → createCompactBoundaryMarker →
// buildContextFromBoundary. Closes the gap between the anchors the plan emits
// and the send-side reconstruction — the exact chain agentLoop Step 2.1 runs.
// Also pins the append-only invariant: appending the marker never mutates the
// original messages.
// ---------------------------------------------------------------------------
describe('round-trip: plan → marker → build', () => {
  beforeEach(resetSeq);

  it('reconstructs a marker-free compact context whose anchors resolve', () => {
    const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 5); // plenty of middle
    const originalSnapshot = messages.map((m) => m.id);

    const plan = computeCompactionPlan(messages);
    expect(plan).not.toBeNull();

    const marker = createCompactBoundaryMarker({
      summaryText: 'SUMMARY-BODY',
      summarizedFromId: plan!.summarizedFromId,
      summarizedToId: plan!.summarizedToId,
      source: 'auto',
      timestamp: 999_000,
    });
    // Append-only: marker goes to the END, originals untouched.
    const history = [...messages, marker];
    expect(messages.map((m) => m.id)).toEqual(originalSnapshot);

    const built = buildContextFromBoundary(history);

    // 1. No marker leaks into the send set.
    expect(built.some(isCompactBoundary)).toBe(false);
    // 2. The summary synthetic message is present with the marker's body.
    const summary = built.find((m) => m.id.startsWith('context-summary-'));
    expect(summary).toBeDefined();
    expect(typeof summary!.content === 'string' && summary!.content).toContain('SUMMARY-BODY');
    // 3. Every summarized middle message is gone from the send set.
    const summarizedIds = new Set(plan!.middleMessages.map((m) => m.id));
    expect(built.some((m) => summarizedIds.has(m.id))).toBe(false);
    // 4. The first message (task context) survives ahead of the summary.
    expect(built[0].id).toBe(messages[0].id);
    // 5. The last real message (recent) survives after the summary.
    expect(built[built.length - 1].id).toBe(messages[messages.length - 1].id);
  });

  it('is idempotent-safe when a second marker lands on top of the first', () => {
    resetSeq();
    const messages = buildRounds(RECENT_ROUNDS_TO_KEEP + 5);
    const plan1 = computeCompactionPlan(messages)!;
    const marker1 = createCompactBoundaryMarker({
      summaryText: 'FIRST',
      summarizedFromId: plan1.summarizedFromId,
      summarizedToId: plan1.summarizedToId,
      source: 'auto',
      timestamp: 100,
    });
    const history1 = [...messages, marker1];

    // A few more rounds arrive, then a second compaction lands.
    const more = buildRounds(3);
    const history2mid = [...history1, ...more];
    const plan2 = computeCompactionPlan(history2mid)!;
    const marker2 = createCompactBoundaryMarker({
      summaryText: 'SECOND',
      summarizedFromId: plan2.summarizedFromId,
      summarizedToId: plan2.summarizedToId,
      source: 'auto',
      timestamp: 200,
    });
    const history2 = [...history2mid, marker2];

    const built = buildContextFromBoundary(history2);
    // Only the LAST marker governs; no marker in the output.
    expect(built.some(isCompactBoundary)).toBe(false);
    const summaries = built.filter((m) => m.id.startsWith('context-summary-'));
    expect(summaries).toHaveLength(1);
    expect(typeof summaries[0].content === 'string' && summaries[0].content).toContain('SECOND');
  });
});
