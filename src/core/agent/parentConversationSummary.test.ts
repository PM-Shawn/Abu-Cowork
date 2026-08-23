import { beforeEach, describe, expect, it, vi } from 'vitest';

const getChatStateMock = vi.fn();
const extractParentConversationSummaryMock = vi.fn();

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: (...args: unknown[]) => getChatStateMock(...args),
  },
}));

vi.mock('./subagentLoop', () => ({
  extractParentConversationSummary: (...args: unknown[]) => extractParentConversationSummaryMock(...args),
}));

import { resolveParentConversationSummary } from './parentConversationSummary';

describe('resolveParentConversationSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractParentConversationSummaryMock.mockImplementation((messages: unknown[]) =>
      messages.map((message) => (message as { content?: string }).content).join('|'),
    );
    getChatStateMock.mockReturnValue({
      activeConversationId: 'active-conv',
      conversations: {
        'active-conv': { messages: [{ role: 'user', content: 'active' }] },
        'tool-conv': { messages: [{ role: 'user', content: 'tool-context' }] },
      },
    });
  });

  it('prefers tool execution conversationId over activeConversationId', () => {
    const summary = resolveParentConversationSummary({ conversationId: 'tool-conv' });

    expect(summary).toBe('tool-context');
    expect(extractParentConversationSummaryMock).toHaveBeenCalledWith([
      { role: 'user', content: 'tool-context' },
    ]);
  });

  it('falls back to activeConversationId when tool context has no conversationId', () => {
    expect(resolveParentConversationSummary()).toBe('active');
  });

  it('returns undefined if chat state lookup or summary extraction fails', () => {
    getChatStateMock.mockImplementationOnce(() => {
      throw new Error('store unavailable');
    });
    expect(resolveParentConversationSummary({ conversationId: 'tool-conv' })).toBeUndefined();

    getChatStateMock.mockReturnValueOnce({
      activeConversationId: 'active-conv',
      conversations: { 'tool-conv': { messages: [] } },
    });
    extractParentConversationSummaryMock.mockImplementationOnce(() => {
      throw new Error('summary failed');
    });
    expect(resolveParentConversationSummary({ conversationId: 'tool-conv' })).toBeUndefined();
  });
});
