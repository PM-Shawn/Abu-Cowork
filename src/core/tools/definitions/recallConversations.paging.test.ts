// Paged reading of a past conversation: boundaries the model will hit when it
// follows the offsets it is given (long messages, CJK and emoji at the cuts,
// messages arriving between two pages).
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../types';
import { getI18n } from '../../../i18n';
import {
  READ_MESSAGE_CHAR_LIMIT,
  READ_PAGE_CHAR_BUDGET,
  cleanSnippet,
  renderConversationPage,
} from './recallConversations';

const t = getI18n().toolResult.recall;

function msg(i: number, content: Message['content'], role: Message['role'] = i % 2 ? 'assistant' : 'user'): Message {
  return { id: `m${i}`, role, content, timestamp: i } as Message;
}

/** Every page from offset 0 to the end, following nextOffset the way the model is told to. */
function readAll(messages: Message[]): { pages: string[]; offsets: number[] } {
  const pages: string[] = [];
  const offsets: number[] = [];
  let offset: number | null = 0;
  while (offset !== null && pages.length < 1000) {
    offsets.push(offset);
    const page = renderConversationPage({ id: 'c', title: 'T', messages, offset }, t);
    pages.push(page.text);
    offset = page.nextOffset;
  }
  return { pages, offsets };
}

/** A UTF-16 string with no unpaired surrogate (what a JSON tool result must be). */
function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('following the offsets through a whole conversation', () => {
  it('reaches the end, each message once and in order, with pages inside the budget', () => {
    const messages = Array.from({ length: 137 }, (_, i) => msg(i, `#${i}# ${'内容'.repeat((i * 37) % 900)}`));
    const { pages, offsets } = readAll(messages);
    expect(pages.at(-1)).toContain(t.convReadEnd);
    const seen = pages.join('\n').match(/#(\d+)#/g)!.map((m) => Number(m.slice(1, -1)));
    expect(seen).toEqual(messages.map((_, i) => i));
    // Each next offset moves forward.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    for (const page of pages) expect(page.length).toBeLessThan(READ_PAGE_CHAR_BUDGET + 600);
  });

  it('the middle page starts at the offset it was given and names the next one', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i, `#${i}# ${'x'.repeat(1000)}`));
    const page = renderConversationPage({ id: 'c', title: 'T', messages, offset: 12 }, t);
    expect(page.text).toContain('#12#');
    expect(page.text).not.toContain('#11#');
    expect(page.nextOffset).not.toBeNull();
    expect(page.text).toContain(`offset=${page.nextOffset}`);
  });

  it('offset exactly at the last message, at the end and far past it', () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, `#${i}#`));
    const last = renderConversationPage({ id: 'c', title: 'T', messages, offset: 4 }, t);
    expect(last.text).toContain('#4#');
    expect(last.nextOffset).toBeNull();
    for (const offset of [5, 6, 1e9, Number.MAX_SAFE_INTEGER]) {
      const past = renderConversationPage({ id: 'c', title: 'T', messages, offset }, t);
      expect(past.nextOffset).toBeNull();
      expect(past.text).not.toContain('#');
    }
  });

  it('messages added between two reads (the conversation is still running) are picked up without repeats', () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg(i, `#${i}# ${'y'.repeat(900)}`));
    const first = renderConversationPage({ id: 'c', title: 'T', messages, offset: 0 }, t);
    messages.push(msg(50, '#50# new'), msg(51, '#51# newer'));
    const { pages } = readAll(messages.slice());
    const fromSecond = renderConversationPage({ id: 'c', title: 'T', messages, offset: first.nextOffset! }, t);
    expect(fromSecond.text).not.toContain(`#${first.nextOffset! - 1}#`);
    expect(pages.join('\n')).toContain('#51#');
  });
});

describe('one message longer than a page', () => {
  it('is shown, cut, with the number of characters left out, and paging still advances', () => {
    const messages = [msg(0, 'q'), msg(1, 'z'.repeat(20_000)), msg(2, 'after')];
    const { pages } = readAll(messages);
    expect(pages.join('\n')).toContain('after');
    expect(pages.join('\n')).toContain(String(20_000 - READ_MESSAGE_CHAR_LIMIT));
  });

  // BUG(found by tester): renderConversationPage cuts every message to
  // READ_MESSAGE_CHAR_LIMIT (1500) characters and the next offset skips to the
  // next message, so the rest of a long message can never be read: an
  // assistant reply or a pasted document whose decisive part (the agreed
  // quote, a clause) comes after the first 1500 characters is out of reach,
  // even when the full-text search found the conversation by exactly that
  // part. The paged read covers whole messages only, not the original text.
  it('every part of a long message can be reached by following the offsets', () => {
    const tail = '最终报价定为 51.8 万元';
    const messages = [msg(0, '报价多少？'), msg(1, `${'说明'.repeat(1200)}${tail}`)];
    const { pages } = readAll(messages);
    expect(pages.join('\n')).toContain(tail);
  });
});

describe('cuts in CJK text and emoji', () => {
  it('never leaves half of a surrogate pair at a message cut, a page edge or a snippet cut', () => {
    for (let shift = 0; shift < 4; shift++) {
      const body = `${'中'.repeat(READ_MESSAGE_CHAR_LIMIT - 2 + shift)}${'😀👨‍👩‍👧𠀀'.repeat(50)}`;
      const messages = Array.from({ length: 12 }, (_, i) => msg(i, `${'🙂'.repeat(i)}${body}`));
      for (const page of readAll(messages).pages) expect(isWellFormed(page)).toBe(true);
      const snippet = cleanSnippet(`${'字'.repeat(199 - shift)}\u0002😀😀😀\u0003${'𠀀'.repeat(10)}`);
      expect(isWellFormed(snippet)).toBe(true);
    }
  });

  it('counts what was left out of a cut CJK message consistently with what was shown', () => {
    const text = '报'.repeat(READ_MESSAGE_CHAR_LIMIT + 321);
    const page = renderConversationPage({ id: 'c', title: 'T', messages: [msg(0, text)], offset: 0 }, t);
    expect(page.text).toContain('321');
  });

  it('a text part list (images and tool parts dropped) is read as its text', () => {
    const messages = [msg(0, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '看这张图里的报价' },
    ] as never)];
    const page = renderConversationPage({ id: 'c', title: 'T', messages, offset: 0 }, t);
    expect(page.text).toContain('看这张图里的报价');
    expect(page.text).not.toContain('AAAA');
  });
});
