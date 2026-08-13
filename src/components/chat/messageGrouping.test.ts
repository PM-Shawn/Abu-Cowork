import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { groupMessagesByLoop } from './messageGrouping';

function message(id: string, role: Message['role'], loopId?: string): Message {
  return { id, role, loopId, content: id, timestamp: 0 };
}

describe('groupMessagesByLoop', () => {
  it('keeps a normal user and its assistant turns in one loop group', () => {
    const messages = [
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      message('assistant-2', 'assistant', 'loop-1'),
    ];

    expect(groupMessagesByLoop(messages).map((group) => group.map((item) => item.id)))
      .toEqual([['user-1', 'assistant-1', 'assistant-2']]);
  });

  it('splits an older same-loop queued user message so it remains visible', () => {
    const messages = [
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      message('queued-user', 'user', 'loop-1'),
      message('assistant-2', 'assistant', 'loop-1'),
    ];

    expect(groupMessagesByLoop(messages).map((group) => group.map((item) => item.id)))
      .toEqual([
        ['user-1', 'assistant-1'],
        ['queued-user', 'assistant-2'],
      ]);
  });

  it('keeps legacy messages without loopIds as separate groups', () => {
    expect(groupMessagesByLoop([
      message('legacy-user', 'user'),
      message('legacy-assistant', 'assistant'),
    ])).toHaveLength(2);
  });
});
