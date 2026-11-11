import { enqueueUserInput, isSteerableText } from '@/core/agent/userInputQueue';
import { getPendingUserQuestions, resolveUserQuestion } from '@/core/agent/permissionBridge';
import { useChatStore } from '@/stores/chatStore';
import type { UserQuestionResult } from '@/types';
import { findDockedQuestion } from './dockedQuestion';

/**
 * A message typed into the composer while the conversation's task runs.
 *
 * - While the task waits on the question card the dock shows
 *   (ask_user_question, `dockedQuestion.ts`), the message answers that card
 *   once: the tool result says the user replied in the chat instead of
 *   choosing and carries the text as written, so the model can take it as the
 *   answer or as a new instruction. Nothing is queued. A plan waiting for
 *   approval (`payload.confirm`) is not answered this way, because approving
 *   is consent and typed words are no consent; the message then steers the
 *   task after the plan is answered. Text that names its own route (`/skill`,
 *   `@expert`) answers no card either.
 * - Otherwise it is staged in the input queue: plain text steers the running
 *   task, which reads it after its current step; text that names its own route,
 *   and anything typed into a run that reads no steering message (scheduled,
 *   triggered or IM), waits for the end of the task (`enqueueUserInput`).
 *
 * Returns false only for empty text, which is neither staged nor sent.
 */
export function sendWhileRunning(conversationId: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (replyToDockedQuestion(conversationId, trimmed)) return true;
  return enqueueUserInput(conversationId, trimmed) !== undefined;
}

/**
 * The first rule above for a surface that is not the composer (the pet): a
 * message sent while the conversation's task waits on the card the dock shows
 * answers that card once, as a reply written in the chat. False when there is
 * no card it may answer (none open, a plan approval, empty text or text that
 * names its own route); the caller then sends the message its usual way, and
 * the dispatcher stages it into the running task if there is one.
 */
export function replyToDockedQuestion(conversationId: string, text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && isSteerableText(trimmed) && answerDockedQuestion(conversationId, trimmed);
}

/** Answer the card the dock shows with `text` written in the chat; false when it shows none it may answer. */
function answerDockedQuestion(conversationId: string, text: string): boolean {
  const store = useChatStore.getState();
  const docked = findDockedQuestion(
    getPendingUserQuestions(),
    conversationId,
    store.conversations[conversationId]?.messages ?? [],
  );
  if (!docked || docked.question.payload.confirm) return false;
  const result: UserQuestionResult = { answers: [], chatReply: text };
  // Recorded on the card first, as the dock does, so the settled card shows
  // what the tool returns.
  store.setToolCallUserQuestionAnswers(conversationId, docked.owner.id, docked.question.id, result);
  resolveUserQuestion(docked.question.id, result);
  return true;
}
