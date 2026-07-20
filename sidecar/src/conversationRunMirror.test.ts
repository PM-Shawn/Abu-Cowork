import { describe, it, expect } from 'vitest';
import { createConversationRunMirror } from './conversationRunMirror';
import type { Conversation, Message } from '@/types';

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    title: 'Test',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('conversationRunMirror', () => {
  describe('seed -> read', () => {
    it('serves the seeded conversation for the matching conversationId', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'a' })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      expect(mirror.reader.getConversation('conv-1')).toBe(conv);
      expect(mirror.reader.getConversation('conv-1')?.messages).toHaveLength(1);
    });

    it('returns undefined for a mismatched conversationId (defensive cross-conversation guard)', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      expect(mirror.reader.getConversation('conv-2')).toBeUndefined();
    });

    it('serves the seeded indexEntry', () => {
      const mirror = createConversationRunMirror('conv-1', {
        conversation: makeConversation(),
        indexEntry: { id: 'conv-1', title: 'T', createdAt: 0, updatedAt: 0, messageCount: 0 },
      });
      expect(mirror.reader.getIndexEntry('conv-1')?.title).toBe('T');
    });

    it('getThinkingStartTime starts null', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      expect(mirror.reader.getThinkingStartTime()).toBeNull();
    });
  });

  describe('write-through visibility (applyChatDeltaWrite)', () => {
    it('addMessage then read sees the new message (flush-then-read hazard fix)', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      const msg = makeMessage({ id: 'new-msg' });
      mirror.applyChatDeltaWrite('addMessage', ['conv-1', msg]);
      const conv = mirror.reader.getConversation('conv-1');
      expect(conv?.messages).toHaveLength(1);
      expect(conv?.messages[0].id).toBe('new-msg');
    });

    it('appendText applied immediately (stronger than RAF-batched in-process path), targeting by msgId', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', content: 'Hello' })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('appendText', ['conv-1', ' world', 'm1']);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].content).toBe('Hello world');
    });

    it('appendText with no msgId targets the LAST message', () => {
      const conv = makeConversation({
        messages: [makeMessage({ id: 'm1', content: 'first' }), makeMessage({ id: 'm2', content: 'second' })],
      });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('appendText', ['conv-1', '!']);
      expect(mirror.reader.getConversation('conv-1')?.messages[1].content).toBe('second!');
      expect(mirror.reader.getConversation('conv-1')?.messages[0].content).toBe('first');
    });

    it('setLastMessageContent replaces content by target', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', content: 'old' })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('setLastMessageContent', ['conv-1', 'new', 'm1']);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].content).toBe('new');
    });

    it('appendThinking accumulates into message.thinking', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1' })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('appendThinking', ['conv-1', 'step 1', 'm1']);
      mirror.applyChatDeltaWrite('appendThinking', ['conv-1', ' step 2', 'm1']);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].thinking).toBe('step 1 step 2');
    });

    it('setMessageToolCalls sets toolCalls and clears isStreaming', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', isStreaming: true })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('setMessageToolCalls', ['conv-1', 'm1', [{ id: 'tc1', name: 'x', input: {}, isExecuting: true }]]);
      const msg = mirror.reader.getConversation('conv-1')?.messages[0];
      expect(msg?.toolCalls).toHaveLength(1);
      expect(msg?.isStreaming).toBe(false);
    });

    it('updateToolCall updates the matching tool call result', () => {
      const conv = makeConversation({
        messages: [makeMessage({ id: 'm1', toolCalls: [{ id: 'tc1', name: 'x', input: {}, isExecuting: true }] })],
      });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('updateToolCall', ['conv-1', 'm1', 'tc1', 'done', undefined, false, undefined]);
      const tc = mirror.reader.getConversation('conv-1')?.messages[0].toolCalls?.[0];
      expect(tc?.result).toBe('done');
      expect(tc?.isExecuting).toBe(false);
    });

    it('deleteMessage removes the message by id', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('deleteMessage', ['conv-1', 'm1']);
      const msgs = mirror.reader.getConversation('conv-1')?.messages;
      expect(msgs).toHaveLength(1);
      expect(msgs?.[0].id).toBe('m2');
    });

    it('setMessageStreamingFlag flips isStreaming', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', isStreaming: true })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('setMessageStreamingFlag', ['conv-1', 'm1', false]);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].isStreaming).toBe(false);
    });

    it('finishStreaming clears isStreaming on the target message', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', isStreaming: true })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('finishStreaming', ['conv-1', 'm1']);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].isStreaming).toBe(false);
    });

    it('deactivateSkills clears activeSkills (one of the 5 read facts)', () => {
      const conv = makeConversation({ activeSkills: ['skill-a'] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('deactivateSkills', ['conv-1']);
      expect(mirror.reader.getConversation('conv-1')?.activeSkills).toEqual([]);
    });

    it('setConversationModel updates both conversation.model and indexEntry.model', () => {
      const mirror = createConversationRunMirror('conv-1', {
        conversation: makeConversation(),
        indexEntry: { id: 'conv-1', title: 'T', createdAt: 0, updatedAt: 0, messageCount: 0 },
      });
      mirror.applyChatDeltaWrite('setConversationModel', ['conv-1', { providerId: 'p', modelId: 'm' }]);
      expect(mirror.reader.getConversation('conv-1')?.model).toEqual({ providerId: 'p', modelId: 'm' });
      expect(mirror.reader.getIndexEntry('conv-1')?.model).toEqual({ providerId: 'p', modelId: 'm' });
    });

    it('setAgentStatus tracks thinkingStartTime (thinking -> set, idle -> clear)', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      mirror.applyChatDeltaWrite('setAgentStatus', ['thinking', undefined, undefined]);
      expect(mirror.reader.getThinkingStartTime()).not.toBeNull();
      mirror.applyChatDeltaWrite('setAgentStatus', ['idle', undefined, undefined]);
      expect(mirror.reader.getThinkingStartTime()).toBeNull();
    });

    it('cancelStreaming clears isStreaming on the last message and thinkingStartTime', () => {
      const conv = makeConversation({ messages: [makeMessage({ id: 'm1', isStreaming: true })] });
      const mirror = createConversationRunMirror('conv-1', { conversation: conv });
      mirror.applyChatDeltaWrite('setAgentStatus', ['thinking', undefined, undefined]);
      mirror.applyChatDeltaWrite('cancelStreaming', ['conv-1']);
      expect(mirror.reader.getConversation('conv-1')?.messages[0].isStreaming).toBe(false);
      expect(mirror.reader.getThinkingStartTime()).toBeNull();
    });

    it('unhandled methods (e.g. flushTokens) are a documented no-op — no throw', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      expect(() => mirror.applyChatDeltaWrite('flushTokens', ['conv-1'])).not.toThrow();
      expect(() => mirror.applyChatDeltaWrite('setCurrentUsage', [null])).not.toThrow();
    });
  });

  describe('applyConvPatch', () => {
    it('patches workspacePath', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      mirror.applyConvPatch({ workspacePath: '/foo' });
      expect(mirror.reader.getConversation('conv-1')?.workspacePath).toBe('/foo');
      expect(mirror.getWorkspacePathSnapshot()).toBe('/foo');
    });

    it('patches title, activeSkills, model — only the given fields', () => {
      const mirror = createConversationRunMirror('conv-1', {
        conversation: makeConversation({ title: 'old', activeSkills: ['a'] }),
      });
      mirror.applyConvPatch({ title: 'new' });
      expect(mirror.reader.getConversation('conv-1')?.title).toBe('new');
      expect(mirror.reader.getConversation('conv-1')?.activeSkills).toEqual(['a']); // untouched
    });

    it('workspacePath patch to null is applied (not treated as absent)', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation({ workspacePath: '/old' }) });
      mirror.applyConvPatch({ workspacePath: null });
      expect(mirror.reader.getConversation('conv-1')?.workspacePath).toBeNull();
      expect(mirror.getWorkspacePathSnapshot()).toBeNull();
    });
  });

  describe('getWorkspacePathSnapshot', () => {
    it('defaults to null when unset', () => {
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      expect(mirror.getWorkspacePathSnapshot()).toBeNull();
    });

    it('reflects a chatDelta write-through too (not just convPatch)', () => {
      // workspacePath isn't a ChatDelta write target in practice, but
      // getWorkspacePathSnapshot must always read the LIVE conversation
      // object, not a stale copy — verify via a convPatch + direct object check.
      const mirror = createConversationRunMirror('conv-1', { conversation: makeConversation() });
      mirror.applyConvPatch({ workspacePath: '/live' });
      expect(mirror.getWorkspacePathSnapshot()).toBe('/live');
    });
  });
});
