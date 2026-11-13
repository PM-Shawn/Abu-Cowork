import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { runRequestText, steeredMessagesOf } from './steeredTurn';

function user(id: string, content: Message['content'], loopId?: string, steered?: true): Message {
  return { id, role: 'user', content, timestamp: 0, ...(loopId ? { loopId } : {}), ...(steered ? { steered } : {}) };
}
function assistant(id: string, loopId: string): Message {
  return { id, role: 'assistant', content: '', timestamp: 0, loopId };
}

describe('steeredTurn', () => {
  const request = user('u1', '写一份周报', 'loop-1');
  const conversation: Message[] = [
    user('u0', '上一个任务', 'loop-0'),
    assistant('a0', 'loop-0'),
    request,
    assistant('a1', 'loop-1'),
    user('s1', '用表格', 'loop-1', true),
    assistant('a2', 'loop-1'),
    user('s2', [{ type: 'text', text: '标题加粗' }], 'loop-1', true),
    assistant('a3', 'loop-1'),
    user('u2', '下一个任务', 'loop-2'),
    user('s3', '别的运行里的补充', 'loop-2', true),
  ];

  describe('steeredMessagesOf', () => {
    it('lists the messages steered into the run, in order, and nothing of other runs', () => {
      expect(steeredMessagesOf(conversation, request).map((m) => m.id)).toEqual(['s1', 's2']);
    });

    it('is empty for a run without steering, a message without a loop, a steered message and an unknown request', () => {
      expect(steeredMessagesOf(conversation, conversation[0])).toEqual([]);
      expect(steeredMessagesOf(conversation, user('x', 'no loop'))).toEqual([]);
      expect(steeredMessagesOf(conversation, conversation[4])).toEqual([]);
      expect(steeredMessagesOf(conversation, user('gone', 'x', 'loop-1'))).toEqual([]);
    });
  });

  describe('runRequestText', () => {
    it('joins the request and each steered message with a blank line', () => {
      expect(runRequestText(conversation, request, '写一份周报')).toBe('写一份周报\n\n用表格\n\n标题加粗');
    });

    it('returns the request text unchanged when nothing was steered', () => {
      expect(runRequestText(conversation, conversation[0], '  上一个任务 ')).toBe('  上一个任务 ');
    });

    it('skips steered messages without text and an empty request', () => {
      const messages = [request, user('s-empty', '   ', 'loop-1', true), user('s-ok', '加图', 'loop-1', true)];
      expect(runRequestText(messages, request, '')).toBe('加图');
    });
  });
});
