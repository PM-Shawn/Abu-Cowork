// recall over past conversations: full-text search and paged reading.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../types';
import type { ConversationMeta, SearchHit } from '../../session/conversationStorage';

const mocks = vi.hoisted(() => ({
  catalogSearch: vi.fn(),
  catalogGetCount: vi.fn(),
  loadMessages: vi.fn(),
}));

vi.mock('../../session/conversationStorage', () => ({
  catalogSearch: mocks.catalogSearch,
  catalogGetCount: mocks.catalogGetCount,
  loadMessages: mocks.loadMessages,
}));
vi.mock('../../memdir/scan', () => ({ scanMemoryFiles: async () => [], readMemoryFile: async () => null }));
vi.mock('../../agent/taskLog', () => ({ readTaskLog: async () => [] }));

import { recallTool } from './recallTool';
import { useChatStore } from '../../../stores/chatStore';

function meta(id: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, title: `Title ${id}`, createdAt: 1, updatedAt: 1_700_000_000_000, messageCount: 4, ...extra };
}

function hit(id: string, snippet = '上次定的\u0002报价\u0003是 5 万'): SearchHit {
  return { conv_id: id, title: `Title ${id}`, snippet, rank: 0 };
}

function messages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `line ${i} ` + 'w'.repeat(200), timestamp: i,
  }) as Message);
}

const run = (input: Record<string, unknown>, conversationId?: string) =>
  recallTool.execute(input, conversationId ? ({ conversationId } as never) : undefined) as Promise<string>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalogGetCount.mockResolvedValue(null);
  mocks.catalogSearch.mockResolvedValue([]);
  mocks.loadMessages.mockResolvedValue([]);
  useChatStore.setState({
    conversations: {},
    conversationIndex: {
      mine: meta('mine'),
      other: meta('other'),
      current: meta('current'),
    },
    activeConversationId: null,
  });
});

describe('recall: searching past conversations', () => {
  it('finds conversations by their text, with id and a plain snippet, and leaves out the asking conversation and stale rows', async () => {
    mocks.catalogSearch.mockResolvedValue(['unindexed', 'mine', 'current'].map((id) => hit(id)));
    const out = await run({ query: '报价' }, 'current');
    expect(out).toContain('"Title mine" [id: mine]');
    expect(out).toContain('上次定的报价是 5 万');
    expect(out).not.toContain('\u0002');
    expect(out).not.toContain('[id: unindexed]');
    expect(out).not.toContain('[id: current]');
  });

  it('a conversation found by text is not listed a second time as a title match', async () => {
    useChatStore.setState({ conversationIndex: { a: meta('a', { title: '报价讨论' }) } });
    mocks.catalogSearch.mockResolvedValue([hit('a')]);
    const out = await run({ query: '报价' });
    expect(out.match(/\[id: a\]/g)).toHaveLength(1);
    expect(out).toContain('whose text matches');
  });

  it('title matches carry the id', async () => {
    useChatStore.setState({
      conversationIndex: {
        a: meta('a', { title: '报价讨论' }),
        b: meta('b', { title: '别的事情' }),
      },
    });
    const out = await run({ query: '报价' });
    expect(out).toContain('[id: a]');
    expect(out).not.toContain('[id: b]');
  });

  it('an empty query lists recent conversations with their ids and does not search the catalog', async () => {
    const out = await run({ query: '' });
    expect(out).toContain('[id: mine]');
    expect(mocks.catalogSearch).not.toHaveBeenCalled();
  });

  it('searches the whole phrase and each word, and merges without duplicates', async () => {
    mocks.catalogSearch.mockImplementation(async (q: string) => (q === '报价' ? [hit('mine')] : q === '上次 报价' ? [hit('mine')] : []));
    const out = await run({ query: '上次 报价' });
    const queries = mocks.catalogSearch.mock.calls.map((c) => c[0]);
    expect(queries).toEqual(['上次 报价', '上次', '报价']);
    expect(out.match(/\[id: mine\]/g)).toHaveLength(1);
  });

  it('respects the limit', async () => {
    useChatStore.setState({
      conversationIndex: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, meta(`c${i}`)])),
    });
    mocks.catalogSearch.mockResolvedValue(Array.from({ length: 30 }, (_, i) => hit(`c${i}`)));
    const out = await run({ query: '报价', limit: 3 });
    expect(out.match(/\[id: c\d+\] \(/g)).toHaveLength(3);
  });

  it('a failing catalog does not break the rest of recall', async () => {
    mocks.catalogSearch.mockRejectedValue(new Error('db down'));
    const out = await run({ query: 'Title' });
    expect(typeof out).toBe('string');
  });
});

describe('recall: reading a found conversation', () => {
  it('reads the first page from disk', async () => {
    mocks.loadMessages.mockResolvedValue(messages(6));
    const out = await run({ conversation_id: 'mine' });
    expect(mocks.loadMessages).toHaveBeenCalledWith('mine');
    expect(out).toContain('Conversation "Title mine" [id: mine], segments 1-6 of 6');
    expect(out).toContain('End of conversation');
  });

  it('continues from an offset and reports the next one', async () => {
    mocks.loadMessages.mockResolvedValue(messages(100));
    const first = await run({ conversation_id: 'mine' });
    const next = /offset=(\d+)/.exec(first)![1];
    const second = await run({ conversation_id: 'mine', offset: Number(next) });
    expect(second).toContain(`segments ${Number(next) + 1}-`);
    expect(second).toContain(`line ${next} `);
    expect(first.length).toBeLessThan(8000);
  });

  it('accepts an offset sent as a string', async () => {
    mocks.loadMessages.mockResolvedValue(messages(10));
    const out = await run({ conversation_id: 'mine', offset: '5' });
    expect(out).toContain('segments 6-10 of 10');
  });

  it('last page and past-the-end offset', async () => {
    mocks.loadMessages.mockResolvedValue(messages(10));
    expect(await run({ conversation_id: 'mine', offset: 9 })).toContain('segments 10-10 of 10');
    expect(await run({ conversation_id: 'mine', offset: 10 })).toContain('past the end');
  });

  it('prefers the open copy of a conversation in memory', async () => {
    useChatStore.setState({
      conversations: { mine: { id: 'mine', messages: messages(2) } as never },
    });
    const out = await run({ conversation_id: 'mine' });
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    expect(out).toContain('segments 1-2 of 2');
  });

  it.each([
    ['an unknown id', 'nope'],
    ['a prototype name', '__proto__'],
  ])('answers %s as not found, without reading anything', async (_label, id) => {
    mocks.loadMessages.mockResolvedValue(messages(4));
    const out = await run({ conversation_id: id });
    expect(out).toContain(`No past conversation with id="${id}"`);
    expect(mocks.loadMessages).not.toHaveBeenCalled();
  });

  it('a huge conversation is read in bounded pages', async () => {
    mocks.loadMessages.mockResolvedValue(messages(20_000));
    const out = await run({ conversation_id: 'mine', offset: 10_000 });
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain('of 20000');
    expect(out).toMatch(/offset=\d+/);
  });

  it('read mode ignores the query', async () => {
    mocks.loadMessages.mockResolvedValue(messages(2));
    await run({ conversation_id: 'mine', query: 'something else' });
    expect(mocks.catalogSearch).not.toHaveBeenCalled();
  });
});
