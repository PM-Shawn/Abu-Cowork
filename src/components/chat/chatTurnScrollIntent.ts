export type ChatTurnScrollIntentSource =
  | 'composer'
  | 'edit-resend'
  | 'regenerate'
  | 'run-retry'
  | 'queue-resume'
  | 'sandbox-recovery';

export interface ChatTurnScrollIntent {
  conversationId: string;
  source: ChatTurnScrollIntentSource;
}

type Listener = (intent: ChatTurnScrollIntent) => void;

const listeners = new Set<Listener>();

/**
 * Announces a user-visible run before its dispatcher can append the new user
 * row. ChatView uses this narrow renderer-local signal to close the one-commit
 * pending gap for every resend surface, not only the main composer.
 */
export function announceChatTurnScrollIntent(intent: ChatTurnScrollIntent): void {
  for (const listener of listeners) listener(intent);
}

export function subscribeChatTurnScrollIntent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
