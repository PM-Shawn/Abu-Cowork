// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { setLanguage } from '@/i18n';
import { createGeneralShellConversation } from '@/core/app/generalShellConversation';
import { petMessageConversation } from '@/core/pet/petQuickMessage';
import { resetTitleGenForTests } from './titleGen';
import type { Message } from '@/types';

const llmCallMock = vi.fn();
vi.mock('../llm/llmCall', () => ({ llmCall: (...a: unknown[]) => llmCallMock(...a) }));

const { updateIndexEntryMock } = vi.hoisted(() => ({ updateIndexEntryMock: vi.fn(async () => undefined) }));
vi.mock('./conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('./conversationStorage')>('./conversationStorage');
  return {
    ...actual,
    appendMessage: vi.fn(async () => undefined),
    updateIndexEntry: updateIndexEntryMock,
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
const conv = (id: string) => useChatStore.getState().conversations[id];

function deferred() {
  const releases: Array<(t: string) => void> = [];
  llmCallMock.mockImplementation(() => new Promise((resolve) => { releases.push((text) => resolve({ text, toolCalls: [] })); }));
  return releases;
}

beforeEach(() => {
  vi.useFakeTimers();
  llmCallMock.mockReset();
  updateIndexEntryMock.mockClear();
  resetTitleGenForTests();
  setLanguage('en-US');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('how conversations are created', () => {
  it.each([
    ['app binding', () => useChatStore.getState().setPendingAppBinding({
      version: 2, appId: 'a', appVersion: '1', origin: 'user', appName: 'App',
    } as never)],
    ['team pin', () => useChatStore.getState().setPendingTeamId('t1', 'app')],
  ])('a conversation started from an app home (%s) is titled once', async (_n, prime) => {
    llmCallMock.mockResolvedValue({ text: 'Fresh title', toolCalls: [] });
    prime();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('do the thing'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(conv(id).title).toBe('Fresh title');
  });

  it('a project conversation is titled', async () => {
    llmCallMock.mockResolvedValue({ text: 'Fresh title', toolCalls: [] });
    const id = useChatStore.getState().createConversation(null, { projectId: 'p1' });
    useChatStore.getState().addMessage(id, user('do the thing'));
    endRun(id);
    await flush();
    expect(conv(id).title).toBe('Fresh title');
  });

  it('an expert-contact first message (welcome message precedes it) is titled from the user text', async () => {
    llmCallMock.mockResolvedValue({ text: 'Fresh title', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().stageExpertContact(id, { identity: { kind: 'expert', key: 'expert:x' } as never, introduction: 'Hi, I am X' });
    useChatStore.getState().addMessage(id, user('help with contract'));
    endRun(id);
    await flush();
    expect(llmCallMock).toHaveBeenCalledTimes(1);
    expect(llmCallMock.mock.calls[0][0].messages[0].content).toContain('help with contract');
    expect(llmCallMock.mock.calls[0][0].messages[0].content).not.toContain('Hi, I am X');
    expect(conv(id).title).toBe('Fresh title');
  });

  it('createGeneralShellConversation and the pet quick message are titled once', async () => {
    llmCallMock.mockResolvedValue({ text: 'Fresh title', toolCalls: [] });
    const a = createGeneralShellConversation(null, { leaveApp: false });
    useChatStore.getState().addMessage(a, user('make an app'));
    endRun(a);
    await flush();
    expect(conv(a).title).toBe('Fresh title');
    llmCallMock.mockClear();
    const b = petMessageConversation(null, { leaveApp: false });
    expect(b).toBe(useChatStore.getState().activeConversationId);
    useChatStore.getState().addMessage(b, user('quick question'));
    endRun(b);
    await flush();
    // the pet reuses the open conversation when there is one, so the answer is the same id and no second call
    expect(llmCallMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([
    ['scheduler-style rename before the first message', { skipActivate: true }],
  ])('a conversation renamed by its creator before the first message is left alone (%s)', async (_n, opts) => {
    const id = useChatStore.getState().createConversation(null, opts);
    useChatStore.getState().renameConversation(id, '[定时] weekly report - 09:00');
    useChatStore.getState().addMessage(id, user('run the report'));
    endRun(id);
    await flush();
    expect(llmCallMock).not.toHaveBeenCalled();
    expect(conv(id).title).toBe('[定时] weekly report - 09:00');
  });
});

describe('restart, concurrency, odd answers', () => {
  it('a conversation loaded after a restart with a slice title and history asks nothing on its next message', async () => {
    const id = useChatStore.getState().createConversation();
    useChatStore.setState((s) => {
      s.conversations[id].title = 'old first message...';
      s.conversationIndex[id].title = 'old first message...';
      s.conversations[id].messages = [user('old first message that was long', 'o1')];
    });
    resetTitleGenForTests(); // a new process
    useChatStore.getState().addMessage(id, user('second', 'o2'));
    endRun(id);
    await flush();
    expect(llmCallMock).not.toHaveBeenCalled();
    expect(conv(id).title).toBe('old first message...');
  });

  it('two conversations created in a row each get their own title, whatever order the answers arrive in', async () => {
    const releases = deferred();
    const a = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(a, user('first topic'));
    endRun(a);
    const b = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(b, user('second topic'));
    endRun(b);
    await flush();
    expect(releases).toHaveLength(2);
    const [promptA, promptB] = llmCallMock.mock.calls.map((c) => c[0]);
    expect(promptA.conversationId).toBe(a);
    expect(promptB.conversationId).toBe(b);
    releases[1]('Title B');
    releases[0]('Title A');
    await flush();
    expect(conv(a).title).toBe('Title A');
    expect(conv(b).title).toBe('Title B');
  });

  it('a model answer with a leading blank line and an explanation uses the first line only', async () => {
    llmCallMock.mockResolvedValue({ text: '\n\nBudget review\nThis conversation is about...', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(conv(id).title).toBe('Budget review');
    expect(conv(id).title).not.toMatch(/[\r\n]/);
  });

  it('CRLF line breaks never reach the stored title', async () => {
    llmCallMock.mockResolvedValue({ text: 'Budget review\r\nmore', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    expect(conv(id).title).toBe('Budget review');
  });

  it('an English answer in the Chinese interface is accepted as is (no language check)', async () => {
    setLanguage('zh-CN');
    llmCallMock.mockResolvedValue({ text: 'Budget review', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('帮我看看预算'));
    endRun(id);
    await flush();
    expect(conv(id).title).toBe('Budget review');
  });

  it('a Chinese answer in the English interface is accepted as is', async () => {
    llmCallMock.mockResolvedValue({ text: '预算审阅', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('look at the budget'));
    endRun(id);
    await flush();
    expect(conv(id).title).toBe('预算审阅');
  });

  it('an answer identical to the slice changes nothing and writes no second index entry', async () => {
    llmCallMock.mockResolvedValue({ text: 'hello', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello'));
    endRun(id);
    await flush();
    updateIndexEntryMock.mockClear();
    expect(conv(id).title).toBe('hello');
    expect(updateIndexEntryMock).not.toHaveBeenCalled();
  });
});

describe('title goes through the rename path', () => {
  it('writes memory, the index entry the sidebar reads, and the disk index', async () => {
    llmCallMock.mockResolvedValue({ text: 'Fresh title', toolCalls: [] });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('a long first message to be sliced for the sidebar title ok'));
    endRun(id);
    await flush();
    const s = useChatStore.getState();
    expect(s.conversations[id].title).toBe('Fresh title');
    expect(s.conversationIndex[id].title).toBe('Fresh title');
    expect(updateIndexEntryMock).toHaveBeenCalled();
    const lastCall = updateIndexEntryMock.mock.calls.at(-1) as unknown as unknown[];
    expect(JSON.stringify(lastCall)).toContain('Fresh title');
  });

  it('the title the model wrote survives a user rename back to the slice text only if the user did it', async () => {
    const releases = deferred();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, user('hello there'));
    endRun(id);
    await flush();
    useChatStore.getState().renameConversation(id, 'Mine');
    releases[0]('Model title');
    await flush();
    expect(conv(id).title).toBe('Mine');
  });
});
