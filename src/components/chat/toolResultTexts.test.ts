import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { DetailBlock } from '@/types/execution';
import { blockFullText, collectToolResultTexts } from './toolResultTexts';

function assistant(id: string, contexts: Message['toolCallsForContext']): Message {
  return { id, role: 'assistant', content: '', timestamp: 1, toolCallsForContext: contexts } as Message;
}

function block(overrides: Partial<DetailBlock>): DetailBlock {
  return { id: 'b', stepId: 's', type: 'result', label: 'Result', content: 'short', isTruncated: false, isExpanded: false, ...overrides };
}

describe('collectToolResultTexts', () => {
  it('reads every assistant message of the group, keeps the last entry of an id and skips entries without one', () => {
    const map = collectToolResultTexts([
      assistant('a1', [{ id: 'c1', name: 'run_command', input: {}, result: 'first' }]),
      { id: 'u', role: 'user', content: 'hi', timestamp: 2 } as Message,
      assistant('a2', [
        { id: 'c1', name: 'run_command', input: {}, result: 'second' },
        { name: 'run_command', input: {}, result: 'no id' },
        { id: 'c2', name: 'read_file', input: {}, result: 'file' },
      ]),
    ]);
    expect([...map]).toEqual([['c1', 'second'], ['c2', 'file']]);
  });
});

describe('blockFullText', () => {
  const results = new Map([['c1', 'full text'], ['c2', 'Error: disk full'], ['c3', 'Error: old_content not found']]);

  it('leaves lists, images and scripts as they are', () => {
    for (const type of ['list', 'image', 'script'] as const) {
      expect(blockFullText(block({ type }), { toolCallId: 'c1', status: 'completed' }, results)).toBeUndefined();
    }
  });

  it('leaves a step as it is when no map is given (an expert step)', () => {
    expect(blockFullText(block({}), { toolCallId: 'c1', status: 'completed' }, undefined)).toBeUndefined();
  });

  it('reads the stored result', () => {
    expect(blockFullText(block({ isTruncated: true }), { toolCallId: 'c1', status: 'completed' }, results)).toBe('full text');
  });

  it('drops the prefix the router adds to a failed step', () => {
    expect(blockFullText(block({ type: 'error' }), { toolCallId: 'c2', status: 'error' }, results)).toBe('disk full');
  });

  it('keeps an error text the tool returned itself', () => {
    expect(blockFullText(block({ type: 'error' }), { toolCallId: 'c3', status: 'completed' }, results))
      .toBe('Error: old_content not found');
  });

  it('falls to the live step result, then to a whole block, then to null', () => {
    expect(blockFullText(block({ isTruncated: true }), { status: 'completed', toolResult: 'live' }, results)).toBe('live');
    expect(blockFullText(block({ content: 'whole' }), { status: 'completed' }, results)).toBe('whole');
    expect(blockFullText(block({ isTruncated: true }), { toolCallId: 'gone', status: 'completed' }, results)).toBeNull();
  });

  it('does not take the live result for an error block', () => {
    expect(blockFullText(block({ type: 'error', content: 'boom' }), { status: 'error', toolResult: 'other' }, results)).toBe('boom');
  });
});
