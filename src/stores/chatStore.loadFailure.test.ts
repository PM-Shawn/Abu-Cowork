// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chatStore';
import { redactFailureText } from '@/core/diagnostic/scrub';
import * as conversationStorage from '../core/session/conversationStorage';
import type { Message } from '@/types';

vi.mock('../core/session/conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('../core/session/conversationStorage')>('../core/session/conversationStorage');
  return {
    ...actual,
    loadMessages: vi.fn(async () => []),
    appendMessage: vi.fn(async () => undefined),
    replaceMessageById: vi.fn(async () => undefined),
    updateIndexEntry: vi.fn(async () => undefined),
    removeIndexEntry: vi.fn(async () => undefined),
    deleteConversationFiles: vi.fn(async () => undefined),
    catalogMarkMissing: vi.fn(async () => undefined),
  };
});

const loadMessages = vi.mocked(conversationStorage.loadMessages);
const appendMessage = vi.mocked(conversationStorage.appendMessage);
const updateIndexEntry = vi.mocked(conversationStorage.updateIndexEntry);

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const HOST_ERROR = `EACCES: permission denied, open '/data/abu/conversations/c1/messages.jsonl' Authorization: Bearer ${SECRET}`;

const message = (id: string, content: string): Message => ({ id, role: 'user', content, timestamp: 1 });

/** Lets the store's own `import()` of the storage module and the awaits behind it finish. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.dynamicImportSettled();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('chatStore: a conversation whose record cannot be read', () => {
  beforeEach(() => {
    loadMessages.mockReset();
    loadMessages.mockResolvedValue([]);
    appendMessage.mockClear();
    updateIndexEntry.mockClear();
    useChatStore.setState({
      conversations: {},
      loadFailures: {},
      activeConversationId: null,
      conversationIndex: {
        c1: { id: 'c1', title: 'first', createdAt: 1, updatedAt: 1, messageCount: 4 },
        c2: { id: 'c2', title: 'second', createdAt: 1, updatedAt: 1, messageCount: 2 },
      },
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the record strictly, so a record that is there and cannot be read is told apart from an empty one', async () => {
    await useChatStore.getState().loadConversation('c1');
    expect(loadMessages).toHaveBeenCalledWith('c1', { strictRead: true });
  });

  it('a read that succeeds shows the messages and records no failure; an empty record is an empty conversation', async () => {
    loadMessages.mockResolvedValueOnce([message('m1', 'hello')]);
    await useChatStore.getState().loadConversation('c1');
    await useChatStore.getState().loadConversation('c2');
    expect(useChatStore.getState().conversations.c1?.messages.map((m) => m.id)).toEqual(['m1']);
    expect(useChatStore.getState().conversations.c2?.messages).toEqual([]);
    expect(useChatStore.getState().loadFailures).toEqual({});
  });

  it('a read that fails records the failure and holds no conversation: nothing says the record is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().loadConversation('c1');
    expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
    expect(useChatStore.getState().conversations.c1).toBeUndefined();
    expect(useChatStore.getState().conversationIndex.c1.messageCount).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs the host text through the redaction helper, as text, and never the error object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().loadConversation('c1');
    expect(redactFailureText(HOST_ERROR)).not.toContain(SECRET);
    expect(warn).toHaveBeenCalledWith('[chatStore] loadConversation failed:', redactFailureText(HOST_ERROR));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(warn.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
  });

  it('logs a thrown value that is no Error as redacted text as well', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(`failed with api_key=${SECRET}`);
    await useChatStore.getState().loadConversation('c1');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
  });

  it('does not persist the failures', () => {
    useChatStore.setState({ loadFailures: { c1: true } });
    const partialize = useChatStore.persist.getOptions().partialize!;
    expect(Object.keys(partialize(useChatStore.getState()) as object)).not.toContain('loadFailures');
  });

  it('keeps the failure of one conversation off every other conversation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().switchConversation('c1');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
    await useChatStore.getState().switchConversation('c2');
    expect(useChatStore.getState().activeConversationId).toBe('c2');
    expect(useChatStore.getState().conversations.c2?.messages).toEqual([]);
    expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
  });

  it('a later read that succeeds removes the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().loadConversation('c1');
    loadMessages.mockResolvedValueOnce([message('m1', 'hello')]);
    await useChatStore.getState().loadConversation('c1');
    expect(useChatStore.getState().loadFailures).toEqual({});
    expect(useChatStore.getState().conversations.c1?.messages.map((m) => m.id)).toEqual(['m1']);
  });

  describe('retryLoadConversation', () => {
    it('reads again; while that read fails the failure stays, and the next retry reads once more', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      loadMessages.mockRejectedValue(new Error(HOST_ERROR));
      await useChatStore.getState().loadConversation('c1');
      await useChatStore.getState().retryLoadConversation('c1');
      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
      expect(useChatStore.getState().conversations.c1).toBeUndefined();
      await useChatStore.getState().retryLoadConversation('c1');
      expect(loadMessages).toHaveBeenCalledTimes(3);
    });

    it('keeps the failure on the page until the read has answered, then shows the conversation', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
      await useChatStore.getState().loadConversation('c1');
      let answer!: (messages: Message[]) => void;
      loadMessages.mockReturnValueOnce(new Promise<Message[]>((resolve) => { answer = resolve; }));
      const retry = useChatStore.getState().retryLoadConversation('c1');
      await settled();
      expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
      answer([message('m1', 'hello')]);
      await retry;
      expect(useChatStore.getState().loadFailures).toEqual({});
      expect(useChatStore.getState().conversations.c1?.messages.map((m) => m.id)).toEqual(['m1']);
    });

    it('two presses read once', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
      await useChatStore.getState().loadConversation('c1');
      let answer!: (messages: Message[]) => void;
      loadMessages.mockReturnValueOnce(new Promise<Message[]>((resolve) => { answer = resolve; }));
      const first = useChatStore.getState().retryLoadConversation('c1');
      const second = useChatStore.getState().retryLoadConversation('c1');
      await settled();
      expect(loadMessages).toHaveBeenCalledTimes(2);
      answer([message('m1', 'hello')]);
      await Promise.all([first, second]);
      expect(loadMessages).toHaveBeenCalledTimes(2);
    });

    it('releases the re-entry check when the read fails, so 重试 can be pressed again', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      loadMessages.mockRejectedValue(new Error(HOST_ERROR));
      await useChatStore.getState().loadConversation('c1');
      let fail!: (error: Error) => void;
      loadMessages.mockReturnValueOnce(new Promise<Message[]>((_resolve, reject) => { fail = reject; }));
      const first = useChatStore.getState().retryLoadConversation('c1');
      await settled();
      fail(new Error(HOST_ERROR));
      await first;
      loadMessages.mockResolvedValueOnce([message('m1', 'hello')]);
      await useChatStore.getState().retryLoadConversation('c1');
      expect(useChatStore.getState().conversations.c1?.messages.map((m) => m.id)).toEqual(['m1']);
    });
  });

  it('a message that arrives for it writes nothing to the record and leaves the index count alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().loadConversation('c1');
    useChatStore.getState().addMessage('c1', message('late', 'arrives after the failed read'));
    await settled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(updateIndexEntry).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations.c1).toBeUndefined();
    expect(useChatStore.getState().conversationIndex.c1.messageCount).toBe(4);
    expect(useChatStore.getState().loadFailures).toEqual({ c1: true });
  });

  it('control: a message for a conversation that was read is written', async () => {
    await useChatStore.getState().loadConversation('c2');
    useChatStore.getState().addMessage('c2', message('m9', 'hello'));
    await settled();
    expect(appendMessage).toHaveBeenCalledWith('c2', expect.objectContaining({ id: 'm9' }));
  });

  it('deleting it removes the failure with it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await useChatStore.getState().switchConversation('c1');
    useChatStore.getState().deleteConversation('c1');
    expect(useChatStore.getState().loadFailures).toEqual({});
    expect(useChatStore.getState().conversationIndex.c1).toBeUndefined();
    expect(useChatStore.getState().activeConversationId).not.toBe('c1');
  });

  it('a read that fails after the conversation was deleted records nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail!: (error: Error) => void;
    loadMessages.mockReturnValueOnce(new Promise<Message[]>((_resolve, reject) => { fail = reject; }));
    const loading = useChatStore.getState().loadConversation('c1');
    await settled();
    useChatStore.getState().deleteConversation('c1');
    fail(new Error(HOST_ERROR));
    await loading;
    expect(useChatStore.getState().loadFailures).toEqual({});
    expect(useChatStore.getState().conversations.c1).toBeUndefined();
  });
});
