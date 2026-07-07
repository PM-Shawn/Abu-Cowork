/**
 * Pure helpers for compact-boundary markers (long-conversation P1 Part A).
 *
 * A compact-boundary marker is a Message with:
 *   - role: 'system'
 *   - id prefix: COMPACT_BOUNDARY_ID_PREFIX
 *   - compactBoundary payload set
 *   - isSystem NOT set (must reach the UI renderer as a divider, not be hidden)
 *
 * Markers are append-only: they are pushed to the end of messages.jsonl and
 * never mutate earlier entries. The send-side rebuilds a compact context on
 * the fly by honouring the LAST marker in the array.
 */

import type { Message } from '@/types';
import { identifyRounds, RECENT_ROUNDS_TO_KEEP } from './contextUtils';

export const COMPACT_BOUNDARY_ID_PREFIX = 'compact-boundary-';

/** True iff msg is a compaction boundary marker (id prefix + payload present). */
export function isCompactBoundary(msg: Message): boolean {
  return (
    msg.id.startsWith(COMPACT_BOUNDARY_ID_PREFIX) &&
    msg.compactBoundary !== undefined
  );
}

/**
 * Last (highest-index) marker in the array, or null. Reverse scan so that
 * the common case (marker is at or near the tail) is O(1).
 */
export function findLastCompactBoundary(
  messages: Message[],
): { marker: Message; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundary(messages[i])) {
      return { marker: messages[i], index: i };
    }
  }
  return null;
}

/**
 * Build a marker Message.
 *
 * id  = `${COMPACT_BOUNDARY_ID_PREFIX}${timestamp.toString(36)}`
 * role = 'system', content = '', isSystem NOT set.
 * timestamp is accepted as a parameter so callers can inject Date.now() —
 * keeping this function pure and deterministic for tests.
 */
export function createCompactBoundaryMarker(params: {
  summaryText: string;
  summarizedFromId: string;
  summarizedToId: string;
  source: 'auto' | 'manual';
  timestamp: number;
}): Message {
  const { summaryText, summarizedFromId, summarizedToId, source, timestamp } =
    params;
  return {
    id: `${COMPACT_BOUNDARY_ID_PREFIX}${timestamp.toString(36)}`,
    role: 'system',
    content: '',
    timestamp,
    compactBoundary: {
      summaryText,
      summarizedFromId,
      summarizedToId,
      createdAt: timestamp,
      source,
    },
  };
}

/**
 * Compute what a compaction would summarise from the raw (marker-free) history.
 * Returns null if there are not enough rounds to compact.
 *
 * Algorithm:
 *   1. Filter out all existing markers → clean logical view.
 *   2. identifyRounds(clean).
 *   3. Require rounds.length > RECENT_ROUNDS_TO_KEEP + 1, else return null.
 *   4. firstRound = rounds[0]
 *      recentRounds = last RECENT_ROUNDS_TO_KEEP rounds
 *      middleRounds = everything in between
 *   5. middleMessages = middleRounds.flat(); if empty → return null.
 *   6. summarizedFromId = middleMessages[0].id
 *      summarizedToId   = middleMessages[middleMessages.length - 1].id
 */
export function computeCompactionPlan(historyMessages: Message[]): {
  middleMessages: Message[];
  summarizedFromId: string;
  summarizedToId: string;
} | null {
  // Work on the clean logical view (no markers)
  const clean = historyMessages.filter((m) => !isCompactBoundary(m));
  const rounds = identifyRounds(clean);

  if (rounds.length <= RECENT_ROUNDS_TO_KEEP + 1) {
    return null;
  }

  // firstRound = rounds[0]; recentRounds = last N; middleRounds = in between
  const middleRounds = rounds.slice(1, rounds.length - RECENT_ROUNDS_TO_KEEP);
  const middleMessages = middleRounds.flat();

  if (middleMessages.length === 0) {
    return null;
  }

  return {
    middleMessages,
    summarizedFromId: middleMessages[0].id,
    summarizedToId: middleMessages[middleMessages.length - 1].id,
  };
}

// Internal predicate — a message that is NOT a compact-boundary marker
function notMarker(m: Message): boolean {
  return !isCompactBoundary(m);
}

/**
 * Send-side: rebuild the context array honouring the last marker.
 *
 * - No marker found → return historyMessages unchanged (no copy, same ref).
 * - Find last marker; locate summarizedFromId / summarizedToId by id.
 * - DEFENSIVE: if either id is missing, or toIdx < fromIdx → return
 *   historyMessages with all markers filtered out (never crash the send path).
 * - Otherwise build:
 *     [ ...slice(0, fromIdx).filter(notMarker),   // firstRound verbatim
 *       summaryMsg,                               // synthetic user message
 *       ...slice(toIdx + 1).filter(notMarker) ]   // recent + anything appended after
 *
 *   summaryMsg = {
 *     id:        `context-summary-${marker.id}`,
 *     role:      'user',
 *     content:   `[对话历史摘要]\n${boundary.summaryText}`,
 *     timestamp: boundary.createdAt,
 *   }
 */
export function buildContextFromBoundary(historyMessages: Message[]): Message[] {
  const found = findLastCompactBoundary(historyMessages);
  if (found === null) {
    return historyMessages;
  }

  const { marker } = found;
  const b = marker.compactBoundary!; // guaranteed by isCompactBoundary

  const fromIdx = historyMessages.findIndex((m) => m.id === b.summarizedFromId);
  const toIdx = historyMessages.findIndex((m) => m.id === b.summarizedToId);

  // Defensive: ids not found or range inverted → safe fallback (no crash)
  if (fromIdx === -1 || toIdx === -1 || toIdx < fromIdx) {
    return historyMessages.filter(notMarker);
  }

  const summaryMsg: Message = {
    id: `context-summary-${marker.id}`,
    role: 'user',
    content: `[对话历史摘要]\n${b.summaryText}`,
    timestamp: b.createdAt,
  };

  return [
    ...historyMessages.slice(0, fromIdx).filter(notMarker),
    summaryMsg,
    ...historyMessages.slice(toIdx + 1).filter(notMarker),
  ];
}
