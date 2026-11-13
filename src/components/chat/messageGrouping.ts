import type { Message } from '@/types';

/**
 * Group one agent run into a visual block, while treating every user message
 * as a hard boundary — except a message steered into the run (`steered`),
 * which stays inside its run's block, where MessageGroup shows it at the step
 * it followed. The boundary is a compatibility guard for transcripts written
 * by older queue behavior that injected a follow-up into the current loopId
 * without marking it: no persisted user message may disappear merely because
 * the loopId was reused.
 */
export function groupMessagesByLoop(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let currentGroup: Message[] = [];
  let currentLoopId: string | undefined | null = null;

  for (const message of messages) {
    const loopChanged = !message.loopId || message.loopId !== currentLoopId;
    const startsAnotherUserTurn = message.role === 'user' && currentGroup.length > 0 && !message.steered;

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

/**
 * The index of the last group of each loop, including historical transcripts
 * that contain standalone markers between messages of a run.
 */
export function lastGroupIndexByLoop(groups: readonly Message[][]): Map<string, number> {
  const last = new Map<string, number>();
  groups.forEach((group, index) => {
    const loopId = group[0]?.loopId;
    if (loopId) last.set(loopId, index);
  });
  return last;
}
