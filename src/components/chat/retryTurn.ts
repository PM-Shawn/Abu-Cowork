import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { TranslationDict } from '@/i18n/types';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import { computeRewindImpact } from '@/utils/rewindImpact';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import type { RewindTarget } from './rewindQuestion';
import { ensureConversationModelUsable } from './sendModelGuard';

/**
 * Re-attach the original routing prefix (`@expert` or `/skill`) to user text
 * for the redo paths. The user message we store is post-routing cleanInput
 * (without the prefix), so resending raw text would fall back to the default
 * route and lose the expert / skill association.
 */
export function reattachRoutingPrefix(body: string, original: Message): string {
  const trimmed = body.trim();
  if (original.delegateAgent) {
    return trimmed ? `@${original.delegateAgent.name} ${trimmed}` : `@${original.delegateAgent.name}`;
  }
  if (original.skill) {
    return trimmed ? `/${original.skill.name} ${trimmed}` : `/${original.skill.name}`;
  }
  return body;
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  const textBlock = message.content.find((block) => block.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

/**
 * Run the turn of `userMessage` again, for 「重试」 under a failed user message
 * and in the step block of a failed step. The conversation is cut at the
 * user message, and the run writes that message anew with its images and its `@expert` / `/skill` route. When
 * later turns follow, `askBeforeRewind` is asked first and a no deletes
 * nothing.
 */
export async function retryTurn({ conversation, userMessage, askBeforeRewind, chatText }: {
  conversation: Conversation;
  userMessage: Message;
  askBeforeRewind: (target: RewindTarget) => Promise<boolean>;
  chatText: TranslationDict['chat'];
}): Promise<void> {
  if (!ensureConversationModelUsable(conversation, chatText)) return;
  const conversationId = conversation.id;
  const images = rebuildImageAttachments(userMessage.content, `run-retry-${Date.now()}`);
  const routedContent = reattachRoutingPrefix(textOf(userMessage), userMessage);
  // The cut is the user message itself: a record in which an earlier question
  // shares this loopId keeps that question and its answer.
  const truncateFromId = userMessage.id;

  const impact = computeRewindImpact(conversation.messages, userMessage.loopId, userMessage.id);
  if (impact.hasLaterTurns && !(await askBeforeRewind({
    conversationId,
    laterTurnsCount: impact.laterTurnsCount,
    loopId: userMessage.loopId,
    fallbackMessageId: userMessage.id,
    messageIds: [userMessage.id],
  }))) return;

  // Re-check: the provider may have been removed while the question was open.
  if (!ensureConversationModelUsable(useChatStore.getState().conversations[conversationId], chatText)) return;
  useChatStore.getState().deleteMessagesFrom(conversationId, truncateFromId);
  announceChatTurnScrollIntent({ conversationId, source: 'run-retry' });
  // A retry is a human pressing a button: the run is attended even when the
  // conversation record carries a scheduler or trigger marker.
  await runAgentLoopDispatched(conversationId, routedContent, {
    initiatedBy: 'user',
    ...(images ? { images } : {}),
  });
}
