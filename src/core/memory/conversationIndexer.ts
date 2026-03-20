/**
 * Lightweight Conversation Indexer — saves conversation metadata to memory backend.
 *
 * Called on conversation switch/completion. No LLM calls — pure data extraction.
 * Stores title, timestamp, message count, and tools used as a conversation_index entry.
 * Uses conversationId in keywords for deduplication.
 */

import type { Conversation } from '../../types';
import { getMemoryBackend } from './router';

/**
 * Index a conversation as a lightweight memory entry.
 * Idempotent: updates existing index entry if one exists for this conversation ID.
 */
export async function indexConversation(conversation: Conversation): Promise<void> {
  if (!conversation.id || conversation.messages.length < 2) return;

  const backend = getMemoryBackend();
  const convIdTag = `conv:${conversation.id}`;

  // Collect unique tool names used in this conversation
  const toolNames = new Set<string>();
  for (const m of conversation.messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolNames.add(tc.name);
      }
    }
  }

  const title = conversation.title || '无标题对话';
  const msgCount = conversation.messages.length;
  const toolList = [...toolNames].slice(0, 10);

  const summary = `"${title}" (${msgCount}条消息)`;
  const content = JSON.stringify({
    title,
    messageCount: msgCount,
    toolsUsed: toolList,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    workspacePath: conversation.workspacePath ?? null,
  });

  // Build keywords: conversation ID tag + title tokens + tool names
  const titleTokens = title
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）[\]{}:：\-\n]+/)
    .filter(w => w.length >= 2)
    .slice(0, 8);
  const keywords = [convIdTag, ...titleTokens, ...toolList.slice(0, 5)];

  // Check for existing index entry (dedup by conversation ID)
  try {
    const existing = await backend.list({ scope: 'user', category: 'conversation_index' });
    const prev = existing.find(e => e.keywords.includes(convIdTag));

    if (prev) {
      // Update existing entry
      await backend.update(prev.id, { summary, content, keywords });
      return;
    }
  } catch {
    // If list fails, proceed to add new entry
  }

  // Add new index entry
  await backend.add({
    category: 'conversation_index',
    summary,
    content,
    keywords,
    sourceType: 'auto_flush',
    scope: 'user',
  });
}
