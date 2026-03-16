/**
 * TriggerContextCache — Stores recent trigger execution summaries per chat.
 *
 * When a trigger processes an IM message and produces a result,
 * the summary is cached here keyed by chatId.
 *
 * When channelRouter creates a new session for the same chat,
 * it injects this summary as context so the user can follow up
 * on trigger results naturally.
 *
 * TTL: 30 minutes. Only the most recent trigger result per chat is kept.
 */

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CachedContext {
  triggerName: string;
  summary: string;
  timestamp: number;
}

/** chatId → most recent trigger context */
const cache = new Map<string, CachedContext>();

/** Store a trigger's result summary for a chat */
export function cacheTriggerContext(chatId: string, triggerName: string, summary: string): void {
  if (!chatId || !summary) return;
  cache.set(chatId, { triggerName, summary, timestamp: Date.now() });
}

/**
 * Retrieve and consume the trigger context for a chat.
 * Returns null if no context or expired. Deletes after retrieval (one-shot).
 */
export function consumeTriggerContext(chatId: string): { triggerName: string; summary: string } | null {
  if (!chatId) return null;
  const entry = cache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(chatId);
    return null;
  }
  cache.delete(chatId); // consume: only inject once
  return { triggerName: entry.triggerName, summary: entry.summary };
}
