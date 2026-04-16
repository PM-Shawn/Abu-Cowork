import type { Message, MessageContent } from '../../../../src/types';

export const RECENT_ROUNDS_TO_KEEP = 4;

export function getMessageText(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export function identifyRounds(messages: Message[]): Message[][] {
  const rounds: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) rounds.push(current);

  return rounds;
}
