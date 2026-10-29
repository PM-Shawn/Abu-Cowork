import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { conversationBranchPrefix } from './conversationBranchProtocol';
import { sanitizeLoadedLedgerMessages } from './loadedMessageSanitizer';

const completed: Message[] = [
  { id: 'user', role: 'user', content: 'Question', timestamp: 1, runState: 'completed', loopId: 'loop' },
  { id: 'answer', role: 'assistant', content: 'Answer', timestamp: 2, streamEnded: true, loopId: 'loop' },
];
const text = { errorEmptyBody: 'No response' };
const prefix = (messages: Message[]) => conversationBranchPrefix(messages, 'source', 'answer', () => null, text);
describe('branch prefix across live and persisted projections', () => {
  it('compares a reopened conversation with its original ledger', () => {
    expect(prefix(sanitizeLoadedLedgerMessages(completed, { text }))).toBe(prefix(completed));
  });
  it('normalizes earlier interrupted turns and removes the same empty rows as the reader', () => {
    const history: Message[] = [
      { id: 'older-user', role: 'user', content: 'Earlier', timestamp: 0, loopId: 'old', runState: 'running' },
      { id: 'empty', role: 'assistant', content: '', timestamp: 0, loopId: 'old' },
      { id: 'old-tool', role: 'assistant', content: 'Partial', timestamp: 0, loopId: 'old',
        toolCalls: [{ id: 'call', name: 'read_file', input: {}, result: 'Read', isExecuting: true }] },
      ...completed,
    ];
    expect(prefix(sanitizeLoadedLedgerMessages(history, { text }))).toBe(prefix(history));
    expect(JSON.parse(prefix(history))).toHaveLength(4);
  });
  it('rejects a currently incomplete selected turn before applying restart normalization', () => {
    const running = completed.map(message => message.id === 'user' ? { ...message, runState: 'running' as const } : message);
    expect(() => prefix(running)).toThrow('incomplete');
  });
  it('detects edits even when message IDs are unchanged', () => {
    expect(prefix(completed.map(message => message.id === 'user' ? { ...message, content: 'Edited' } : message))).not.toBe(prefix(completed));
  });
  it('excludes later turns and includes earlier tool results', () => {
    const later: Message = { id: 'later', role: 'user', content: 'Future', timestamp: 3, runState: 'running' };
    expect(prefix([...completed, later])).toBe(prefix(completed));
  });
  it('does not alter caller-owned messages', () => {
    const before = structuredClone(completed);
    prefix(completed);
    expect(completed).toEqual(before);
  });
});
