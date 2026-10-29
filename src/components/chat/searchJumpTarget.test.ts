import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { searchJumpTarget } from './searchJumpTarget';

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: 0, ...extra };
}

describe('searchJumpTarget', () => {
  const messages = [
    message('u1', 'user', 'first question', { loopId: 'l1' }),
    message('a1', 'assistant', 'first answer', { loopId: 'l1' }),
    message('u2', 'user', 'Second QUESTION about invoices', { loopId: 'l2' }),
    message('a2', 'assistant', 'second answer', { loopId: 'l2' }),
  ];
  const groups = [messages.slice(0, 2), messages.slice(2)];

  it('finds the group of the first message that contains the query', () => {
    expect(searchJumpTarget(messages, groups, 'invoices')).toEqual({ groupIndex: 1, messageId: 'u2' });
  });

  it('matches without regard to case and surrounding spaces', () => {
    expect(searchJumpTarget(messages, groups, '  second question ')).toEqual({ groupIndex: 1, messageId: 'u2' });
  });

  it('skips internal system rows and keeps recovery notices', () => {
    const withSystem = [
      message('s1', 'user', 'hidden invoices prompt', { isSystem: true }),
      message('r1', 'assistant', 'recovered invoices task', { isSystem: true, isRecoveryNotice: true }),
    ];
    expect(searchJumpTarget(withSystem, [[withSystem[1]]], 'invoices')).toEqual({ groupIndex: 0, messageId: 'r1' });
  });

  it('returns null when no message matches', () => {
    expect(searchJumpTarget(messages, groups, 'nothing like this')).toBeNull();
  });

  it('locates an exact source reply independently of matching text', () => {
    expect(searchJumpTarget(messages, groups, '', 'a2')).toEqual({ groupIndex: 1, messageId: 'a2' });
    expect(searchJumpTarget(messages, groups, 'first', 'missing')).toBeNull();
  });

  it('returns null when the matching message is in no shown group', () => {
    expect(searchJumpTarget(messages, [groups[0]], 'invoices')).toBeNull();
  });
});
