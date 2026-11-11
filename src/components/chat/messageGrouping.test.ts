import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { groupMessagesByLoop, lastGroupIndexByLoop } from './messageGrouping';

function message(id: string, role: Message['role'], loopId?: string): Message {
  return { id, role, loopId, content: id, timestamp: 0 };
}

describe('groupMessagesByLoop', () => {
  it('keeps automatic summary markers and later steps in the same run', () => {
    const messages = [
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      message('compact-boundary-1', 'system', 'loop-1'),
      message('assistant-2', 'assistant', 'loop-1'),
    ];
    expect(groupMessagesByLoop(messages)).toEqual([messages]);
  });

  it('places manual summary markers between runs', () => {
    const messages = [
      message('assistant-1', 'assistant', 'loop-1'),
      message('compact-boundary-manual', 'system'),
      message('user-2', 'user', 'loop-2'),
    ];
    expect(groupMessagesByLoop(messages)).toEqual(messages.map((item) => [item]));
  });
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

  it('keeps messages steered into a run inside that run, in order', () => {
    const messages = [
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      { ...message('steer-q1', 'user', 'loop-1'), steered: true as const },
      message('assistant-2', 'assistant', 'loop-1'),
      { ...message('steer-q2', 'user', 'loop-1'), steered: true as const },
      message('assistant-3', 'assistant', 'loop-1'),
      message('user-2', 'user', 'loop-2'),
    ];

    expect(groupMessagesByLoop(messages).map((group) => group.map((item) => item.id))).toEqual([
      ['user-1', 'assistant-1', 'steer-q1', 'assistant-2', 'steer-q2', 'assistant-3'],
      ['user-2'],
    ]);
    expect(lastGroupIndexByLoop(groupMessagesByLoop(messages)).get('loop-1')).toBe(0);
  });

  it('a steered message of another run still starts a group', () => {
    const messages = [
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      { ...message('steer-q1', 'user', 'loop-2'), steered: true as const },
    ];
    expect(groupMessagesByLoop(messages)).toHaveLength(2);
  });

  it('keeps legacy messages without loopIds as separate groups', () => {
    expect(groupMessagesByLoop([
      message('legacy-user', 'user'),
      message('legacy-assistant', 'assistant'),
    ])).toHaveLength(2);
  });
});

describe('lastGroupIndexByLoop', () => {
  it('maps each loop to the index of its only group', () => {
    const groups = groupMessagesByLoop([
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      message('user-2', 'user', 'loop-2'),
      message('assistant-2', 'assistant', 'loop-2'),
    ]);
    expect([...lastGroupIndexByLoop(groups)]).toEqual([['loop-1', 0], ['loop-2', 1]]);
  });

  it('maps a loop that a compaction marker split in two to its last group', () => {
    const groups = groupMessagesByLoop([
      message('user-1', 'user', 'loop-1'),
      message('assistant-1', 'assistant', 'loop-1'),
      message('compaction-marker', 'assistant'),
      message('assistant-2', 'assistant', 'loop-1'),
    ]);
    expect(groups).toHaveLength(3);
    expect([...lastGroupIndexByLoop(groups)]).toEqual([['loop-1', 2]]);
  });

  it('leaves groups without a loop id out', () => {
    const groups = groupMessagesByLoop([message('legacy-user', 'user'), message('legacy-assistant', 'assistant')]);
    expect(lastGroupIndexByLoop(groups).size).toBe(0);
  });
});
