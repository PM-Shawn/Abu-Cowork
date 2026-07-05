/**
 * conversationToMarkdown — serialize a conversation to a plain Markdown
 * transcript for the "Copy as Markdown" action (mirrors Codex desktop's export,
 * which is a lightweight clipboard copy rather than a heavy bundle). Pure and
 * synchronous — safe on any size, no disk I/O.
 */
import type { Conversation, Message } from '../../types';
import { getMessageText } from '../context/contextUtils';

function roleLabel(role: Message['role']): string {
  if (role === 'user') return '**User**';
  if (role === 'assistant') return '**Abu**';
  return `**${role}**`;
}

export function conversationToMarkdown(
  conv: Pick<Conversation, 'title' | 'messages'>,
): string {
  const out: string[] = [`# ${conv.title?.trim() || '对话'}`, ''];

  for (const m of conv.messages) {
    if (m.isSystem) continue;
    out.push(roleLabel(m.role), '');

    const text = getMessageText(m.content).trim();
    if (text) out.push(text, '');

    const toolNames = (m.toolCalls ?? []).map((tc) => tc.name).filter(Boolean);
    if (toolNames.length > 0) {
      out.push(...toolNames.map((n) => `> 🔧 \`${n}\``), '');
    }

    out.push('---', '');
  }

  return out.join('\n');
}
