import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  createInProcessChatDelta,
  getChatDelta,
  setChatDelta,
  type ChatDelta,
} from './chatDelta';

describe('createInProcessChatDelta', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      pendingInputAppend: null,
      thinkingStartTime: null,
    });
  });

  it('appendText() + flushTokens() forwards to appendToLastMessage/flushTokenBuffer', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
    });
    delta.appendText(id, 'hello', 'a1');
    delta.flushTokens(id, 'a1'); // force immediate flush past the RAF buffer
    expect(useChatStore.getState().conversations[id].messages[0].content).toBe('hello');
  });

  it('setLastMessageContent() forwards and overwrites content', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: 'stale', timestamp: Date.now(), isStreaming: true,
    });
    delta.setLastMessageContent(id, '', 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].content).toBe('');
  });

  it('appendThinking() forwards to updateMessageThinking', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
    });
    delta.appendThinking(id, 'pondering...', 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('pondering...');
  });

  it('setThinkingDuration() forwards to updateMessageThinkingDuration', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
    });
    delta.setThinkingDuration(id, 7, 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinkingDuration).toBe(7);
  });

  it('finishStreaming() forwards and flips isStreaming false', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: 'done', timestamp: Date.now(), isStreaming: true,
    });
    delta.finishStreaming(id, 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(false);
    expect(useChatStore.getState().agentStatus).toBe('idle');
  });

  it('cancelStreaming() forwards and appends the stop marker', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '部分', timestamp: Date.now(), isStreaming: true,
    });
    delta.cancelStreaming(id);
    expect(useChatStore.getState().conversations[id].messages[0].content).toContain('已停止');
  });

  it('deactivateSkills() forwards to deactivateConversationSkills', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.setState((state) => {
      state.conversations[id].activeSkills = ['writer'];
      state.conversations[id].activeSkillArgs = { writer: 'x' };
    });
    delta.deactivateSkills(id);
    expect(useChatStore.getState().conversations[id].activeSkills).toEqual([]);
    expect(useChatStore.getState().conversations[id].activeSkillArgs).toEqual({});
  });

  it('setMessageStreamingFlag() forwards and flips the exact message id', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: 'partial', timestamp: Date.now(), isStreaming: true,
    });
    delta.setMessageStreamingFlag(id, 'a1', false);
    expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(false);
    // no finishStreaming side effects — agentStatus untouched
    expect(useChatStore.getState().agentStatus).toBe('idle');
  });

  it('reflects store updates on the next call (not cached at construction time)', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
    });
    delta.appendThinking(id, 'first', 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('first');
    delta.appendThinking(id, 'second', 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('second');
  });
});

describe('getChatDelta / setChatDelta', () => {
  const defaultDelta = getChatDelta();

  afterEach(() => {
    // restore the default in-process delta so other test files aren't affected
    setChatDelta(defaultDelta);
  });

  it('getChatDelta() returns a working in-process delta by default', () => {
    const delta = getChatDelta();
    expect(typeof delta.appendText).toBe('function');
    expect(typeof delta.deactivateSkills).toBe('function');
  });

  it('setChatDelta() swaps the module-level delta returned by getChatDelta()', () => {
    const calls: string[] = [];
    const stub: ChatDelta = {
      appendText: () => calls.push('appendText'),
      setLastMessageContent: () => calls.push('setLastMessageContent'),
      appendThinking: () => calls.push('appendThinking'),
      setThinkingDuration: () => calls.push('setThinkingDuration'),
      flushTokens: () => calls.push('flushTokens'),
      finishStreaming: () => calls.push('finishStreaming'),
      cancelStreaming: () => calls.push('cancelStreaming'),
      deactivateSkills: () => calls.push('deactivateSkills'),
      setMessageStreamingFlag: () => calls.push('setMessageStreamingFlag'),
    };
    setChatDelta(stub);
    expect(getChatDelta()).toBe(stub);
    getChatDelta().appendText('c1', 'tok');
    expect(calls).toEqual(['appendText']);
  });
});
