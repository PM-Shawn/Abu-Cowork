import { describe, expect, it, vi } from 'vitest';
import {
  announceChatTurnScrollIntent,
  subscribeChatTurnScrollIntent,
  type ChatTurnScrollIntentSource,
} from './chatTurnScrollIntent';

describe('chat turn scroll intent', () => {
  it.each([
    'composer',
    'edit-resend',
    'regenerate',
    'run-retry',
    'queue-resume',
    'sandbox-recovery',
  ] satisfies ChatTurnScrollIntentSource[])('covers the %s dispatch entry', (source) => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatTurnScrollIntent(listener);

    announceChatTurnScrollIntent({ conversationId: 'conversation-1', source });

    expect(listener).toHaveBeenCalledWith({ conversationId: 'conversation-1', source });
    unsubscribe();
  });
});
