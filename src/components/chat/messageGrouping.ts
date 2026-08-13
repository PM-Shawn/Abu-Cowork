import type { Message } from '@/types';

/**
 * Group one agent run into a visual block, while treating every user message
 * as a hard boundary. The latter is a compatibility guard for transcripts
 * written by older queue behavior that injected a follow-up into the current
 * loopId: no persisted user message may disappear merely because the loopId
 * was reused.
 */
export function groupMessagesByLoop(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let currentGroup: Message[] = [];
  let currentLoopId: string | undefined | null = null;

  for (const message of messages) {
    const loopChanged = !message.loopId || message.loopId !== currentLoopId;
    const startsAnotherUserTurn = message.role === 'user' && currentGroup.length > 0;

    if (loopChanged || startsAnotherUserTurn) {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [message];
      currentLoopId = message.loopId;
    } else {
      currentGroup.push(message);
    }
  }

  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}
