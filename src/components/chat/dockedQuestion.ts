import { findQuestionOwningMessage, type PendingUserQuestion } from '@/core/agent/permissionBridge';
import type { Message } from '@/types';

/**
 * The question card the dock above the composer shows for a conversation: its
 * oldest pending question whose tool call is in the conversation. ChatView
 * renders this one, and a message typed while it is open answers this one
 * (`sendWhileRunning.ts`), so the text never answers a card the user cannot
 * see.
 */
export function findDockedQuestion(
  pending: readonly PendingUserQuestion[],
  conversationId: string,
  messages: readonly Message[],
): { question: PendingUserQuestion; owner: Message } | undefined {
  const question = pending.find((pq) => pq.conversationId === conversationId);
  if (!question) return undefined;
  const owner = findQuestionOwningMessage(messages, question.id);
  return owner ? { question, owner } : undefined;
}
