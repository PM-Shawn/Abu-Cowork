import { describe, expect, it } from 'vitest';
import type { Message } from '../../../types';
import type { SearchHit } from '../../session/conversationStorage';
import { getI18n } from '../../../i18n';
import {
  READ_MESSAGE_CHAR_LIMIT,
  READ_PAGE_CHAR_BUDGET,
  READ_PAGE_MAX_MESSAGES,
  cleanSnippet,
  findConversation,
  keepIndexedHits,
  readableMessages,
  searchConversationHits,
  renderConversationPage,
} from './recallConversations';

const t = getI18n().toolResult.recall;

function msg(i: number, text: string, role: Message['role'] = i % 2 === 0 ? 'user' : 'assistant'): Message {
  return { id: `m${i}`, role, content: text, timestamp: i };
}

function hit(id: string, snippet = 'snip'): SearchHit {
  return { conv_id: id, title: id, snippet, rank: 0 };
}

describe('findConversation', () => {
  const index = { a: { title: 'A' } };

  it('finds an indexed conversation', () => {
    expect(findConversation(index, 'a')).toEqual({ title: 'A' });
  });

  it('answers a missing id with undefined, and ignores prototype names', () => {
    expect(findConversation(index, 'nope')).toBeUndefined();
    expect(findConversation(index, '__proto__')).toBeUndefined();
    expect(findConversation(index, 'constructor')).toBeUndefined();
    expect(findConversation(index, 'toString')).toBeUndefined();
  });
});

describe('keepIndexedHits', () => {
  const index = { a: {}, b: {}, c: {} };
  const hits = ['a', 'unindexed', 'b', 'a', 'c'].map((id) => hit(id));

  it('keeps indexed conversations, once each, in rank order', () => {
    expect(keepIndexedHits(hits, index, 10).map((h) => h.hit.conv_id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a catalog row whose conversation is no longer in the index', () => {
    expect(keepIndexedHits([hit('unindexed')], index, 10)).toEqual([]);
  });

  it('respects the limit', () => {
    expect(keepIndexedHits(hits, index, 2).map((h) => h.hit.conv_id)).toEqual(['a', 'b']);
  });
});

describe('cleanSnippet', () => {
  it('removes the match markers and collapses whitespace', () => {
    expect(cleanSnippet('…定的\u0002报价\u0003是\n  5 万…')).toBe('…定的报价是 5 万…');
  });

  it('bounds a long snippet', () => {
    expect(cleanSnippet('x'.repeat(5000)).length).toBeLessThan(260);
  });
});

describe('readableMessages', () => {
  it('keeps what people said and drops system notes and empty messages', () => {
    const messages: Message[] = [
      msg(0, 'hello'),
      msg(1, 'sys', 'system'),
      { ...msg(2, 'note'), isSystem: true },
      msg(3, '   '),
      { id: 'p', role: 'user', content: [{ type: 'text', text: 'part text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as never], timestamp: 4 },
      { id: 'img', role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as never], timestamp: 5 },
    ];
    expect(readableMessages(messages).map((m) => m.id)).toEqual(['m0', 'p']);
  });
});

describe('renderConversationPage', () => {
  const page = (messages: Message[], offset: number) =>
    renderConversationPage({ id: 'c1', title: 'Quote talk', messages, offset }, t);

  it('first page of a short conversation shows everything and says it ends', () => {
    const out = page([msg(0, 'what price?'), msg(1, 'It is 5万')], 0);
    expect(out.nextOffset).toBeNull();
    expect(out.text).toContain('segments 1-2 of 2');
    expect(out.text).toContain('User: what price?');
    expect(out.text).toContain('Assistant: It is 5万');
    expect(out.text).toContain('End of conversation');
    expect(out.text).not.toContain('offset=');
  });

  it('pages a long conversation: no gap, no overlap, last page ends', () => {
    const messages = Array.from({ length: 100 }, (_, i) => msg(i, `message number ${i} ${'y'.repeat(300)}`));
    const seen: number[] = [];
    let offset: number | null = 0;
    let guard = 0;
    while (offset !== null && guard++ < 50) {
      const out = page(messages, offset);
      expect(out.text.length).toBeLessThan(READ_PAGE_CHAR_BUDGET + 1500);
      for (const m of out.text.matchAll(/message number (\d+) /g)) seen.push(Number(m[1]));
      if (out.nextOffset !== null) {
        expect(out.text).toContain(`offset=${out.nextOffset}`);
        expect(out.nextOffset).toBeGreaterThan(offset);
      } else {
        expect(out.text).toContain('End of conversation');
      }
      offset = out.nextOffset;
    }
    expect(offset).toBeNull();
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('caps the number of messages on a page', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(i, 'hi'));
    const out = page(messages, 0);
    expect(out.nextOffset).toBe(READ_PAGE_MAX_MESSAGES);
    expect(out.text).toContain(`segments 1-${READ_PAGE_MAX_MESSAGES} of 200`);
  });

  it('huge messages are cut and counted, a page stays bounded and paging still advances', () => {
    const huge = 'z'.repeat(1_000_000);
    const messages = [msg(0, huge), msg(1, huge), msg(2, huge), msg(3, huge), msg(4, huge), msg(5, 'short answer')];
    const out = page(messages, 0);
    expect(out.text.length).toBeLessThan(READ_PAGE_CHAR_BUDGET + 500);
    expect(out.text).toContain(`${1_000_000 - READ_MESSAGE_CHAR_LIMIT} more characters`);
    expect(out.nextOffset).not.toBeNull();
    expect(out.nextOffset).toBeGreaterThan(0);
    // 5 messages of 667 segments each, then the short one: the last segment is reachable by its offset.
    const segmentsPerHuge = Math.ceil(1_000_000 / READ_MESSAGE_CHAR_LIMIT);
    expect(page(messages, 5 * segmentsPerHuge).text).toContain('Assistant: short answer');
  });

  it('a message longer than a page is read in segments that follow one another', () => {
    const out = page([msg(0, 'q'.repeat(10 * READ_MESSAGE_CHAR_LIMIT))], 0);
    expect(out.text).toContain('segments 1-3 of 10');
    expect(out.nextOffset).toBe(3);
    expect(page([msg(0, 'q'.repeat(10 * READ_MESSAGE_CHAR_LIMIT))], 9).nextOffset).toBeNull();
  });

  it('does not split a surrogate pair at the cut', () => {
    const emoji = '😀'.repeat(READ_MESSAGE_CHAR_LIMIT);
    const out = page([msg(0, emoji)], 0);
    expect(out.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('offset at or past the end says so', () => {
    const messages = [msg(0, 'a'), msg(1, 'b')];
    expect(page(messages, 2).text).toContain('offset 2 is past the end');
    expect(page(messages, 2).nextOffset).toBeNull();
    expect(page(messages, 999).text).toContain('has 2 segments');
  });

  it('bad offsets fall back to the start or clamp', () => {
    const messages = [msg(0, 'a'), msg(1, 'b')];
    expect(page(messages, -5).text).toContain('segments 1-2 of 2');
    expect(page(messages, Number.NaN).text).toContain('segments 1-2 of 2');
    expect(page(messages, 0.9).text).toContain('segments 1-2 of 2');
    expect(page(messages, Infinity).text).toContain('segments 1-2 of 2');
  });

  it('an empty conversation says so', () => {
    expect(page([], 0).text).toContain('no readable messages');
    expect(page([msg(0, 'x', 'system')], 0).nextOffset).toBeNull();
  });

  it('offset counts readable messages, so system notes in between do not shift pages', () => {
    const messages = [msg(0, 'first'), { ...msg(1, 'note'), isSystem: true }, msg(2, 'second')];
    const out = page(messages, 1);
    expect(out.text).toContain('segments 2-2 of 2');
    expect(out.text).toContain('second');
    expect(out.text).not.toContain('note');
  });
});

describe('searchConversationHits', () => {
  const index: Record<string, object> = { a: {}, b: {}, c: {}, here: {} };

  it('asks the catalog for more rows than wanted, so dropped rows can be replaced', async () => {
    const asked: number[] = [];
    const search = async (_q: string, limit: number) => { asked.push(limit); return [hit('a')]; };
    await searchConversationHits('报价', index, 4, undefined, search);
    expect(asked).toEqual([12]);
  });

  it('leaves out the conversation being asked from and rows that are not in the index', async () => {
    const out = await searchConversationHits('x', index, 5, 'here', async () => [hit('here'), hit('gone'), hit('b'), hit('c')]);
    expect(out.map((h) => h.hit.conv_id)).toEqual(['b', 'c']);
    expect(out[0].meta).toBe(index.b);
  });
});
