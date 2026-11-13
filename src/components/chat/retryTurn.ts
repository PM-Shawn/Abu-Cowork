import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { TranslationDict } from '@/i18n/types';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import type { RedoOutcome, RedoRequest } from './redoTurn';
import { ensureConversationModelUsable } from './sendModelGuard';
import { runRequestText } from '@/utils/steeredTurn';

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
 * Run the turn of `userMessage` again: `retry` for 「重试」 under a failed user
 * message and in the step block of a failed step, `resend` for 「重新发送」
 * under a message the app closed midway. The conversation is cut at the user
 * message, and the run writes that message anew with its images and its
 * `@expert` / `/skill` route. `redo` asks first when later turns follow or
 * files can be restored, and a no deletes nothing.
 */
export async function retryTurn({ conversation, userMessage, entry, redo, chatText }: {
  conversation: Conversation;
  userMessage: Message;
  entry: 'retry' | 'resend';
  redo: (request: RedoRequest) => Promise<RedoOutcome>;
  chatText: TranslationDict['chat'];
}): Promise<void> {
  if (!ensureConversationModelUsable(conversation, chatText)) return;
  const conversationId = conversation.id;
  const images = rebuildImageAttachments(userMessage.content, `run-retry-${Date.now()}`);
  // The cut removes the messages steered into the run as well, so the run is
  // asked again with its request and everything steered into it.
  const routedContent = reattachRoutingPrefix(
    runRequestText(conversation.messages, userMessage, textOf(userMessage)),
    userMessage,
  );

  await redo({
    conversationId,
    entry,
    // The cut is the user message itself: a record in which an earlier question
    // shares this loopId keeps that question and its answer.
    cutMessageId: userMessage.id,
    messageIds: [userMessage.id],
    // The provider may have been removed while the question was open.
    canProceed: () => ensureConversationModelUsable(useChatStore.getState().conversations[conversationId], chatText),
    start: (startHold) => {
      announceChatTurnScrollIntent({ conversationId, source: 'run-retry' });
      // A retry is a human pressing a button: the run is attended even when the
      // conversation record carries a scheduler or trigger marker.
      return runAgentLoopDispatched(conversationId, routedContent, {
        initiatedBy: 'user',
        startHold,
        ...(images ? { images } : {}),
      });
    },
  });
}
