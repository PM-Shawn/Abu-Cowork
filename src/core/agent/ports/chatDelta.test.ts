import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  createInProcessChatDelta,
  getChatDelta,
  setChatDelta,
  type ChatDelta,
} from './chatDelta';

// Filler timestamp (TESTING.md §3) — not asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

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
      id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.appendText(id, 'hello', 'a1');
    delta.flushTokens(id, 'a1'); // force immediate flush past the RAF buffer
    expect(useChatStore.getState().conversations[id].messages[0].content).toBe('hello');
  });

  it('setLastMessageContent() forwards and overwrites content', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: 'stale', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.setLastMessageContent(id, '', 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].content).toBe('');
  });

  it('appendThinking() forwards to updateMessageThinking', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.appendThinking(id, 'pondering...', 'a1');
    delta.flushTokens(id, 'a1'); // thinking is RAF-buffered same as text tokens — force immediate flush
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('pondering...');
  });

  it('setThinkingDuration() forwards to updateMessageThinkingDuration', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.setThinkingDuration(id, 7, 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinkingDuration).toBe(7);
  });

  it('finishStreaming() forwards and flips isStreaming false', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: 'done', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.finishStreaming(id, 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(false);
    expect(useChatStore.getState().agentStatus).toBe('idle');
  });

  it('cancelStreaming() forwards and records the stop terminal without changing content', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '部分', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.cancelStreaming(id);
    expect(useChatStore.getState().conversations[id].messages[0]).toMatchObject({
      content: '部分',
      stopReason: 'user',
    });
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
      id: 'a1', role: 'assistant', content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true,
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
      id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.appendThinking(id, 'first', 'a1');
    delta.flushTokens(id, 'a1'); // thinking is RAF-buffered same as text tokens — force immediate flush
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('first');
    delta.appendThinking(id, 'second', 'a1');
    delta.flushTokens(id, 'a1');
    expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('second');
  });

  it('setMessageToolCalls() forwards to the reclaimed toolExecutor.ts action', () => {
    const delta = createInProcessChatDelta();
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(id, {
      id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
    });
    delta.setMessageToolCalls(id, 'a1', [{ id: 't1', name: 'read_file', input: {} }]);
    const msg = useChatStore.getState().conversations[id].messages[0];
    expect(msg.toolCalls).toEqual([{ id: 't1', name: 'read_file', input: {} }]);
    expect(msg.isStreaming).toBe(false);
  });

  // ── Discrete family — one forwarding test each is enough; the underlying
  // store actions already have full behavioral coverage in chatStore.test.ts.
  describe('discrete family forwarding', () => {
    it('addMessage() forwards to chatStore.addMessage', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      delta.addMessage(id, { id: 'm1', role: 'user', content: 'hi', timestamp: FIXED_TIMESTAMP });
      expect(useChatStore.getState().conversations[id].messages[0].id).toBe('m1');
    });

    it('deleteMessage() forwards to chatStore.deleteMessage', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'm1', role: 'user', content: 'hi', timestamp: FIXED_TIMESTAMP });
      delta.deleteMessage(id, 'm1');
      expect(useChatStore.getState().conversations[id].messages).toHaveLength(0);
    });

    it('updateToolCall() forwards to chatStore.updateToolCall', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP,
        toolCalls: [{ id: 't1', name: 'read_file', input: {} }],
      });
      delta.updateToolCall(id, 'a1', 't1', 'ok', undefined, false);
      expect(useChatStore.getState().conversations[id].messages[0].toolCalls?.[0].result).toBe('ok');
    });

    it('appendToolCallContext() forwards to chatStore.appendToolCallContext', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop1',
      });
      delta.appendToolCallContext(id, 'loop1', { id: 't1', name: 'read_file', input: {}, result: 'ok' });
      expect(useChatStore.getState().conversations[id].messages[0].toolCallsForContext).toHaveLength(1);
    });

    it('updateMessageUsage() forwards to chatStore.updateMessageUsage', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP });
      delta.updateMessageUsage(id, { inputTokens: 10, outputTokens: 20 }, 'a1');
      expect(useChatStore.getState().conversations[id].messages[0].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    });

    it('setExecutionStepsSnapshot() forwards to chatStore.setExecutionStepsSnapshot', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop1',
      });
      delta.setExecutionStepsSnapshot(id, 'loop1', [
        { id: 's1', type: 'tool', label: 'step', status: 'completed', toolName: 'read_file' },
      ]);
      expect(useChatStore.getState().conversations[id].messages[0].executionSteps).toHaveLength(1);
    });

    it('setPlannedStepsSnapshot() forwards to chatStore.setPlannedStepsSnapshot', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop1',
      });
      delta.setPlannedStepsSnapshot(id, 'loop1', [{ index: 0, description: 'plan', status: 'pending' }]);
      expect(useChatStore.getState().conversations[id].messages[0].plannedSteps).toHaveLength(1);
    });

    it('setConversationStatus() forwards to chatStore.setConversationStatus', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      delta.setConversationStatus(id, 'running');
      expect(useChatStore.getState().conversations[id].status).toBe('running');
    });

    it('setAgentStatus() forwards to chatStore.setAgentStatus', () => {
      const delta = createInProcessChatDelta();
      delta.setAgentStatus('thinking');
      expect(useChatStore.getState().agentStatus).toBe('thinking');
    });

    it('setCurrentUsage() forwards to chatStore.setCurrentUsage', () => {
      const delta = createInProcessChatDelta();
      delta.setCurrentUsage({ inputTokens: 1, outputTokens: 2 });
      expect(useChatStore.getState().currentUsage).toEqual({ inputTokens: 1, outputTokens: 2 });
    });

    it('setRetryInfo() forwards to chatStore.setRetryInfo', () => {
      const delta = createInProcessChatDelta();
      delta.setRetryInfo({ attempt: 1, maxAttempts: 3, delayMs: 1000 });
      expect(useChatStore.getState().retryInfo).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 1000 });
    });

    it('setContextUsage() forwards to chatStore.setContextUsage', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      delta.setContextUsage(id, { percent: 10, tokensUsed: 100, tokensMax: 1000 });
      expect(useChatStore.getState().conversations[id].contextUsage).toEqual({ percent: 10, tokensUsed: 100, tokensMax: 1000 });
    });

    it('setContextCache() / clearContextCache() forward to chatStore', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      const cache = {
        summaryMessage: { id: 'sum1', role: 'assistant' as const, content: 'summary', timestamp: FIXED_TIMESTAMP },
        summarizedRange: [0, 5] as [number, number],
        messageCountAtCompression: 5,
      };
      delta.setContextCache(id, cache);
      expect(useChatStore.getState().conversations[id].contextCache).toEqual(cache);
      delta.clearContextCache(id);
      expect(useChatStore.getState().conversations[id].contextCache).toBeUndefined();
    });

    it('setIsCompressing() forwards to chatStore.setIsCompressing', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      delta.setIsCompressing(id, true);
      expect(useChatStore.getState().conversations[id].isCompressing).toBe(true);
    });

    it('setConversationModel() forwards to chatStore.setConversationModel', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      delta.setConversationModel(id, { providerId: 'p1', modelId: 'm1' });
      expect(useChatStore.getState().conversations[id].model).toEqual({ providerId: 'p1', modelId: 'm1' });
    });

    it('setPendingProposalSignal() forwards to chatStore.setPendingProposalSignal', () => {
      const delta = createInProcessChatDelta();
      const id = useChatStore.getState().createConversation();
      const signal = {
        computedAt: FIXED_TIMESTAMP, toolCallCount: 5, hadErrors: false, usedSkill: false,
        triggerLevel: 'companion' as const,
      };
      delta.setPendingProposalSignal(id, signal);
      expect(useChatStore.getState().conversations[id].pendingProposalSignal).toEqual(signal);
    });

    it('removeActiveAgent() forwards to chatStore.removeActiveAgent', () => {
      const delta = createInProcessChatDelta();
      useChatStore.setState({ activeAgentNames: ['agentA', 'agentB'] });
      delta.removeActiveAgent('agentA');
      expect(useChatStore.getState().activeAgentNames).toEqual(['agentB']);
    });
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
      setMessageToolCalls: () => calls.push('setMessageToolCalls'),
      addMessage: () => calls.push('addMessage'),
      deleteMessage: () => calls.push('deleteMessage'),
      updateToolCall: () => calls.push('updateToolCall'),
      appendToolCallContext: () => calls.push('appendToolCallContext'),
      updateMessageUsage: () => calls.push('updateMessageUsage'),
      setExecutionStepsSnapshot: () => calls.push('setExecutionStepsSnapshot'),
      setPlannedStepsSnapshot: () => calls.push('setPlannedStepsSnapshot'),
      setConversationStatus: () => calls.push('setConversationStatus'),
      setAgentStatus: () => calls.push('setAgentStatus'),
      setCurrentUsage: () => calls.push('setCurrentUsage'),
      setRetryInfo: () => calls.push('setRetryInfo'),
      setContextUsage: () => calls.push('setContextUsage'),
      setContextCache: () => calls.push('setContextCache'),
      clearContextCache: () => calls.push('clearContextCache'),
      setIsCompressing: () => calls.push('setIsCompressing'),
      setConversationModel: () => calls.push('setConversationModel'),
      setPendingProposalSignal: () => calls.push('setPendingProposalSignal'),
      removeActiveAgent: () => calls.push('removeActiveAgent'),
    };
    setChatDelta(stub);
    expect(getChatDelta()).toBe(stub);
    getChatDelta().appendText('c1', 'tok');
    expect(calls).toEqual(['appendText']);
  });
});
