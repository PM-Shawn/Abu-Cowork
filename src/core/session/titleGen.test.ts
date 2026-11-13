// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { setLanguage } from '@/i18n';
import { cleanTitle, MAX_TITLE_ATTEMPTS, resetTitleGenForTests, titleContextOf, TITLE_TIMEOUT_MS } from './titleGen';
import type { Message } from '@/types';

const llmCallMock = vi.fn();
vi.mock('../llm/llmCall', () => ({ llmCall: (...a: unknown[]) => llmCallMock(...a) }));

vi.mock('./conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('./conversationStorage')>('./conversationStorage');
  return {
    ...actual,
    appendMessage: vi.fn(async () => undefined),
    updateIndexEntry: vi.fn(async () => undefined),
    catalogReindexConversation: vi.fn(async () => undefined),
    flushIndex: vi.fn(async () => undefined),
  };
});

const user = (content: Message['content'], id = 'm1'): Message => ({ id, role: 'user', content, timestamp: 1 });
/** The first reply ends: the title call is allowed to go out now. */
const endRun = (id: string, reply?: string) => {
  const s = useChatStore.getState();
  s.setConversationStatus(id, 'running');
  if (reply) s.addMessage(id, { id: `a-${id}`, role: 'assistant', content: reply, timestamp: 2 });
  s.setConversationStatus(id, 'completed');
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const title = (id: string) => useChatStore.getState().conversations[id]?.title;

/** A model call that answers with `text` once the test releases it. */
function deferredCall() {
  let release!: (text: string) => void;
  llmCallMock.mockImplementationOnce(() => new Promise((resolve) => { release = (text) => resolve({ text, toolCalls: [] }); }));
  return (text: string) => release(text);
}

beforeEach(() => {
  vi.useFakeTimers();
  llmCallMock.mockReset();
  resetTitleGenForTests();
  setLanguage('en-US');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('model-written conversation titles', () => {
  it('replaces the slice with the model title and passes the conversation id', async () => {
    llmCallMock.mockResolvedValue({ text: 'Quarterly sales summary', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('please summarise the attached quarterly sales numbers for the board'));
    endRun(id);
    expect(title(id)).toContain('please summarise');
    await flush();
    expect(title(id)).toBe('Quarterly sales summary');
    expect(useChatStore.getState().conversationIndex[id]?.title).toBe('Quarterly sales summary');
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(llmCallMock.mock.calls[0][0]).toMatchObject({ conversationId: id });
  });

  it('does not touch the reply: no call before the first reply has ended, and the slice is there meanwhile', async () => {
    const release = deferredCall();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    await flush();
    expect(llmCallMock).not.toHaveBeenCalled();
    useChatStore.getState().setConversationStatus(id, 'running');
    await flush();
    expect(llmCallMock).not.toHaveBeenCalled();
    expect(title(id)).toBe('hello there');
    useChatStore.getState().setConversationStatus(id, 'completed');
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    release('Greeting');
    await flush();
    expect(title(id)).toBe('Greeting');
  });

  it('also asks when the first reply failed or was stopped', async () => {
    llmCallMock.mockResolvedValue({ text: 'Greeting', toolCalls: [] });
    const a = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(a, user('hello there'));
    useChatStore.getState().setConversationStatus(a, 'running');
    useChatStore.getState().setConversationStatus(a, 'error');
    const b = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(b, user('other topic'));
    useChatStore.getState().setConversationStatus(b, 'running');
    useChatStore.getState().setConversationStatus(b, 'idle');
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(2);
  });

  it('gives the model the start of the reply (a few hundred characters) with the first message', async () => {
    llmCallMock.mockResolvedValue({ text: 'Greeting', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id, 'Hi! ' + 'x'.repeat(1000));
    await flush();
    const prompt = llmCallMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('<first_message>\nhello there');
    const reply = /<assistant_reply_start>\n([^]*)\n<\/assistant_reply_start>/.exec(prompt)![1];
    expect(reply.startsWith('Hi! xxx')).toBe(true);
    expect(reply.length).toBe(300);
  });

  it('keeps a title the user set while the model was working', async () => {
    const release = deferredCall();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    useChatStore.getState().renameConversation(id, 'My own name');
    release('Greeting');
    await flush();
    expect(title(id)).toBe('My own name');
  });

  it('keeps a title the user set before the call even started', async () => {
    llmCallMock.mockResolvedValue({ text: 'Greeting', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    useChatStore.getState().renameConversation(id, 'Renamed');
    await flush();
    expect(title(id)).toBe('Renamed');
  });

  it('does nothing when the conversation was deleted meanwhile', async () => {
    const release = deferredCall();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    useChatStore.setState((s) => {
      delete s.conversations[id];
      delete s.conversationIndex[id];
    });
    const rename = vi.spyOn(useChatStore.getState(), 'renameConversation');
    release('Greeting');
    await flush();
    expect(rename).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations[id]).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[id]).toBeUndefined();
  });

  it('keeps the slice when the model does not answer within the timeout, and aborts the call', async () => {
    llmCallMock.mockImplementation(() => new Promise(() => {}));
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    const signal = llmCallMock.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS + 1);
    expect(signal.aborted).toBe(true);
    expect(title(id)).toBe('hello there');
  });

  it('gives way when the conversation runs again: the title call is aborted and not retried', async () => {
    llmCallMock.mockImplementation(() => new Promise(() => {}));
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    const signal = llmCallMock.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    useChatStore.getState().setConversationStatus(id, 'running');
    await flush();
    expect(signal.aborted).toBe(true);
    useChatStore.getState().setConversationStatus(id, 'completed');
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(title(id)).toBe('hello there');
  });

  it('keeps the slice when the call fails, and does not retry by itself', async () => {
    llmCallMock.mockRejectedValue(new Error('boom'));
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(title(id)).toBe('hello there');
    expect(llmCallMock).toHaveBeenCalledTimes(1);
  });

  it('a failed call is not final: the next run\'s end asks again, and a title that comes back is used', async () => {
    llmCallMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ text: 'Greeting', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(title(id)).toBe('hello there');
    endRun(id, 'Hi!');
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(2);
    expect(title(id)).toBe('Greeting');
  });

  it.each([
    ['an empty answer', { text: '', toolCalls: [] }],
    ['an answer that is no title', { text: 'Sure! Here is a detailed summary of the quarterly sales numbers you attached, covering each region.', toolCalls: [] }],
  ])('%s is asked again once, then given up on', async (_name, answer) => {
    llmCallMock.mockResolvedValue(answer);
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    for (let run = 0; run < 4; run++) {
      endRun(id);
      await flush();
    }
    expect(llmCallMock).toHaveBeenCalledTimes(MAX_TITLE_ATTEMPTS);
    expect(title(id)).toBe('hello there');
  });

  it('a timeout counts as an attempt; a call the next run sent out of its way does not', async () => {
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    // Attempt 1 is sent out of the way by the next run.
    llmCallMock.mockImplementationOnce((o: { signal: AbortSignal }) => new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    endRun(id);
    await flush();
    useChatStore.getState().setConversationStatus(id, 'running');
    await flush();
    // Attempt 2 (the first one that counts) times out; attempt 3 may still go out.
    llmCallMock.mockImplementationOnce(() => new Promise(() => {}));
    useChatStore.getState().setConversationStatus(id, 'completed');
    await flush();
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS + 10);
    expect(llmCallMock).toHaveBeenCalledTimes(2);
    llmCallMock.mockResolvedValueOnce({ text: 'Greeting', toolCalls: [] });
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(3);
    expect(title(id)).toBe('Greeting');
  });

  it.each([
    ['empty', ''],
    ['only punctuation and quotes', '"。"'],
    ['a whole reply', 'Sure! Here is a detailed summary of the quarterly sales numbers you attached, covering each region.'],
  ])('keeps the slice for %s output', async (_name, text) => {
    llmCallMock.mockResolvedValue({ text, toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(title(id)).toBe('hello there');
  });

  it('strips quotes, a label and trailing punctuation from the answer', async () => {
    llmCallMock.mockResolvedValue({ text: 'Title: "Budget review."\nbecause...', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(title(id)).toBe('Budget review');
  });

  it('asks for Chinese in the zh-CN interface and cleans a Chinese answer', async () => {
    setLanguage('zh-CN');
    llmCallMock.mockResolvedValue({ text: '「季度销售汇总」。', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('帮我把附件里的季度销售数据整理成给董事会看的汇总'));
    endRun(id);
    await flush();
    expect(title(id)).toBe('季度销售汇总');
    expect(llmCallMock.mock.calls[0][0].system).toContain('Chinese');
    expect(llmCallMock.mock.calls[0][0].system).not.toContain('in English');
  });

  it('asks for English in the en-US interface', async () => {
    llmCallMock.mockResolvedValue({ text: 'Greeting', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(llmCallMock.mock.calls[0][0].system).toContain('in English');
  });

  it('uses the attachment names when the first message is only an attachment', async () => {
    llmCallMock.mockResolvedValue({ text: 'Sales report', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    const defaultTitle = title(id);
    useChatStore.getState().addMessage(id, user('[Attachment: `C:\\Users\\li\\Desktop\\Q3 sales.xlsx`]'));
    endRun(id);
    expect(title(id)).toBe(defaultTitle);
    await flush();
    const prompt = llmCallMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Q3 sales.xlsx');
    expect(prompt).not.toContain('Desktop');
    expect(title(id)).toBe('Sales report');
  });

  // An attachment-only first message keeps the default title, so a later message gets a slice
  // and would be a second candidate: the attempts are bounded per conversation, not per message.
  it('asks at most MAX_TITLE_ATTEMPTS times per conversation: an empty answer to the first, then another message', async () => {
    llmCallMock.mockResolvedValue({ text: '', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    const defaultTitle = title(id);
    useChatStore.getState().addMessage(id, user('[Attachment: `C:\\x\\a.xlsx`]'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(title(id)).toBe(defaultTitle);
    useChatStore.getState().addMessage(id, user('and another thing', 'm2'));
    expect(title(id)).toBe('and another thing');
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(2);
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(MAX_TITLE_ATTEMPTS);
    expect(title(id)).toBe('and another thing');
  });

  it('does not ask twice when a second candidate lands while the first call is still running', async () => {
    const release = deferredCall();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('[Attachment: `C:\\x\\a.xlsx`]'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    useChatStore.getState().addMessage(id, user('hello there', 'm2'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    release('Late title');
    await flush();
    // the slice of m2 is now the title, so the late answer for m1 does not overwrite it
    expect(title(id)).toBe('hello there');
  });

  it('a retry or edit of the first message after its title was written asks nothing', async () => {
    llmCallMock.mockResolvedValue({ text: 'Greeting', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    useChatStore.getState().deleteMessagesFrom(id, 'm1');
    useChatStore.getState().addMessage(id, user('hello there, edited', 'm3'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(title(id)).toBe('Greeting');
  });

  describe('conversations whose titles other code sets', () => {
    it.each([
      ['scheduled task', { scheduledTaskId: 't1' }],
      ['trigger', { triggerId: 'g1' }],
      ['IM channel', { imChannelId: 'c1', imPlatform: 'feishu' }],
    ])('makes no call for a %s conversation', async (_name, options) => {
      const id = useChatStore.getState().createConversation(null, options);
      useChatStore.getState().addMessage(id, user('hello there'));
      endRun(id);
      await flush();
      expect(llmCallMock).not.toHaveBeenCalled();
    });

    it('makes no call for a system-generated message', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { ...user('wake up'), isSystem: true });
      await flush();
      expect(llmCallMock).not.toHaveBeenCalled();
    });

    it('makes no call for a conversation that already has a title', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().renameConversation(id, 'Given name');
      useChatStore.getState().addMessage(id, user('hello there'));
      endRun(id);
      await flush();
      expect(llmCallMock).not.toHaveBeenCalled();
    });
  });

});

describe('cleanTitle', () => {
  it('strips bold labels, "Here\'s a title:" prefixes, list markers and title tags', () => {
    expect(cleanTitle('**标题**：季度销售汇总', 'zh-CN')).toBe('季度销售汇总');
    expect(cleanTitle("Here's a title: Sales summary", 'en-US')).toBe('Sales summary');
    expect(cleanTitle('Here is a short title: Sales summary', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('- Sales summary', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('1. Sales summary', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('<title>Sales summary</title>', 'en-US')).toBe('Sales summary');
  });
  it('keeps numbers with a slash, strips "1、" markers and short preambles', () => {
    expect(cleanTitle('Review 1.5/2.0', 'en-US')).toBe('Review 1.5/2.0');
    expect(cleanTitle('价格调整 3/4.5', 'zh-CN')).toBe('价格调整 3/4.5');
    expect(cleanTitle('1、季度销售汇总', 'zh-CN')).toBe('季度销售汇总');
    expect(cleanTitle('好的，标题：季度销售汇总', 'zh-CN')).toBe('季度销售汇总');
    expect(cleanTitle('Sure! Title: Sales summary', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('#1 priority list', 'en-US')).toBe('#1 priority list');
    expect(cleanTitle('## Sales summary', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('《劳动合同》', 'zh-CN')).toBe('劳动合同');
    expect(cleanTitle('"Sales summary"', 'en-US')).toBe('Sales summary');
    expect(cleanTitle('“a”和“b”', 'zh-CN')).toBe('“a”和“b”');
  });
  it('rejects a slash command or a file path', () => {
    for (const bad of ['/xlsx', '/expense-guide 打车费', '~/Documents/a', 'C:\\Users\\li\\a.xlsx', '../a/b.txt', 'reports/q3.xlsx']) {
      expect(cleanTitle(bad, 'en-US')).toBeNull();
    }
    expect(cleanTitle('Sales and/or costs', 'en-US')).toBe('Sales and/or costs');
  });
  it('rejects empty and overlong output', () => {
    expect(cleanTitle('', 'en-US')).toBeNull();
    expect(cleanTitle(' \n ', 'zh-CN')).toBeNull();
    expect(cleanTitle('字'.repeat(25), 'zh-CN')).toBeNull();
    expect(cleanTitle('字'.repeat(24), 'zh-CN')).toBe('字'.repeat(24));
  });
  it('strips markdown, quotes and trailing punctuation', () => {
    expect(cleanTitle('## **合同审阅**！', 'zh-CN')).toBe('合同审阅');
    expect(cleanTitle('“Plan the trip…”', 'en-US')).toBe('Plan the trip');
    expect(cleanTitle('标题：差旅报销', 'zh-CN')).toBe('差旅报销');
  });
});

describe('titleContextOf', () => {
  it('collects text, attachment marks and block names, and caps their number', () => {
    const marks = Array.from({ length: 9 }, (_, i) => `[Attachment: \`/a/f${i}.pdf\`]`).join(' ');
    const ctx = titleContextOf(user([
      { type: 'text', text: `看看 ${marks}` },
      { type: 'document', name: 'x.pdf', source: { type: 'base64', media_type: 'application/pdf', data: '' } },
    ]));
    expect(ctx.text).toBe('看看');
    expect(ctx.attachments).toHaveLength(5);
  });
  it('limits very long text', () => {
    expect(titleContextOf(user('a'.repeat(5000))).text).toHaveLength(600);
  });
});
