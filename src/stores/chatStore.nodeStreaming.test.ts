import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let chat: typeof import('./chatStore');

beforeAll(async () => {
  chat = await import('./chatStore');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(1_700_000_000_000);
  vi.spyOn(Math, 'random').mockReturnValue(0.25);
  chat.useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
});

afterEach(async () => {
  chat.flushTokenBuffer();
  await vi.advanceTimersByTimeAsync(16);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('streaming with the shared Node test environment', () => {
  it('flushes text and thinking on successive frames and completes the message', async () => {
    const store = chat.useChatStore.getState();
    const conversationId = store.createConversation();
    store.addMessage(conversationId, {
      id: 'assistant', role: 'assistant', content: '', timestamp: 1_700_000_000_000, isStreaming: true,
    });
    const message = () => chat.useChatStore.getState().conversations[conversationId].messages[0];

    store.appendToLastMessage(conversationId, 'Hello', 'assistant');
    store.updateMessageThinking(conversationId, 'Checking', 'assistant');
    expect(message().content).toBe('');
    expect(message().thinking).toBeUndefined();
    await vi.advanceTimersByTimeAsync(16);
    expect(message()).toMatchObject({ content: 'Hello', thinking: 'Checking' });

    store.appendToLastMessage(conversationId, ' world', 'assistant');
    store.updateMessageThinking(conversationId, 'Checked', 'assistant');
    await vi.advanceTimersByTimeAsync(16);
    store.finishStreaming(conversationId, 'assistant');
    expect(message()).toMatchObject({ content: 'Hello world', thinking: 'Checked', isStreaming: false });
  });

  it('cancels a pending frame without cancelling a different frame', async () => {
    const applied: string[] = [];
    const cancelled = requestAnimationFrame(() => applied.push('cancelled'));
    requestAnimationFrame(() => applied.push('kept'));
    cancelAnimationFrame(cancelled);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(16);
    expect(applied).toEqual(['kept']);
  });
});
