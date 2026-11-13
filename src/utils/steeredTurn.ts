import type { Message } from '@/types';

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/**
 * The user messages steered into the run that `request` started, in the order
 * the run took them. A steered message shares its run's loopId and comes after
 * the request in the conversation (see `Message.steered`).
 */
export function steeredMessagesOf(messages: readonly Message[], request: Message): Message[] {
  if (!request.loopId || request.steered) return [];
  const start = messages.findIndex((message) => message.id === request.id);
  if (start < 0) return [];
  return messages
    .slice(start + 1)
    .filter((message) => message.role === 'user' && message.steered === true && message.loopId === request.loopId);
}

/** The texts of the messages steered into the run `request` started, trimmed, empty ones left out. */
export function steeredTextsOf(messages: readonly Message[], request: Message): string[] {
  return steeredMessagesOf(messages, request)
    .map((message) => textOf(message).trim())
    .filter((text) => text.length > 0);
}

/**
 * Everything the user asked of a run: its request text, then each message
 * steered into it, separated by a blank line. Redoing a run (regenerate,
 * retry, resend, edit and resend) cuts the conversation at the request, which
 * removes the steered messages too, so the redo sends this text instead of the
 * request alone: nothing the user told the run is lost. A run with no steered
 * message gives back `requestText` unchanged.
 */
export function runRequestText(messages: readonly Message[], request: Message, requestText: string): string {
  const steered = steeredTextsOf(messages, request);
  if (steered.length === 0) return requestText;
  return [requestText.trim(), ...steered].filter((text) => text.length > 0).join('\n\n');
}
