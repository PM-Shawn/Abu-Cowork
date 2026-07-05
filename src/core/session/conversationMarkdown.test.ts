import { describe, it, expect } from 'vitest';
import { conversationToMarkdown } from './conversationMarkdown';
import type { Message } from '../../types';

const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ id: role + content, role, content, timestamp: 1, ...extra });

describe('conversationToMarkdown', () => {
  it('renders title, roles and text', () => {
    const md = conversationToMarkdown({
      title: '我的对话',
      messages: [msg('user', 'hi'), msg('assistant', 'hello')],
    });
    expect(md).toContain('# 我的对话');
    expect(md).toContain('**User**');
    expect(md).toContain('hi');
    expect(md).toContain('**Abu**');
    expect(md).toContain('hello');
  });

  it('summarizes tool calls and skips system messages', () => {
    const md = conversationToMarkdown({
      title: 't',
      messages: [
        msg('assistant', 'internal notice', { isSystem: true }),
        msg('assistant', 'running', { toolCalls: [{ id: 'x', name: 'run_command', input: {} }] as Message['toolCalls'] }),
      ],
    });
    expect(md).not.toContain('internal notice');
    expect(md).toContain('🔧 `run_command`');
  });

  it('falls back to a default title when empty', () => {
    const md = conversationToMarkdown({ title: '', messages: [] });
    expect(md).toContain('# 对话');
  });
});
