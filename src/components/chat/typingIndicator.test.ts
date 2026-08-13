import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { shouldShowTypingIndicator } from './typingIndicator';

function message(id: string, role: Message['role']): Message {
  return { id, role, content: id, timestamp: 0 };
}

describe('shouldShowTypingIndicator', () => {
  it('shows for the first user message of a running conversation', () => {
    expect(shouldShowTypingIndicator('running', [message('user-1', 'user')])).toBe(true);
  });

  it('shows when a queued user message starts after existing assistant history', () => {
    expect(shouldShowTypingIndicator('running', [
      message('user-1', 'user'),
      message('assistant-1', 'assistant'),
      message('queued-user', 'user'),
    ])).toBe(true);
  });

  it('hides as soon as the streaming assistant placeholder exists', () => {
    expect(shouldShowTypingIndicator('running', [
      message('queued-user', 'user'),
      { ...message('assistant-2', 'assistant'), isStreaming: true },
    ])).toBe(false);
  });

  it('does not show for an idle conversation ending in a user message', () => {
    expect(shouldShowTypingIndicator('idle', [message('user-1', 'user')])).toBe(false);
  });
});
