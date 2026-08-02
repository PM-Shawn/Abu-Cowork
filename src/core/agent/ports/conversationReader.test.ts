import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';
import type { ConversationMeta } from '../../session/conversationStorage';
import {
  createInProcessConversationReader,
  getConversationReader,
  setConversationReader,
  type ConversationReader,
} from './conversationReader';

describe('createInProcessConversationReader', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      thinkingStartTime: null,
    });
  });

  it('getConversation() returns the live conversation record for a known id', () => {
    const conv: Conversation = {
      id: 'c1',
      title: 't',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      status: 'idle',
    };
    useChatStore.setState({ conversations: { c1: conv } });
    const reader = createInProcessConversationReader();
    expect(reader.getConversation('c1')).toBe(conv);
  });

  it('getConversation() returns undefined for an unknown id', () => {
    const reader = createInProcessConversationReader();
    expect(reader.getConversation('does-not-exist')).toBeUndefined();
  });

  it('getIndexEntry() returns the catalog metadata for a known id', () => {
    const meta: ConversationMeta = {
      id: 'c1',
      title: 'catalog title',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    };
    useChatStore.setState({ conversationIndex: { c1: meta } });
    const reader = createInProcessConversationReader();
    expect(reader.getIndexEntry('c1')).toBe(meta);
  });

  it('getIndexEntry() returns undefined for an unknown id', () => {
    const reader = createInProcessConversationReader();
    expect(reader.getIndexEntry('does-not-exist')).toBeUndefined();
  });

  it('getThinkingStartTime() mirrors the global chatStore scalar', () => {
    useChatStore.setState({ thinkingStartTime: 12345 });
    const reader = createInProcessConversationReader();
    expect(reader.getThinkingStartTime()).toBe(12345);
  });

  it('reflects store updates on the next call (not cached at construction time)', () => {
    const reader = createInProcessConversationReader();
    expect(reader.getConversation('c1')).toBeUndefined();
    const conv: Conversation = {
      id: 'c1',
      title: 't',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      status: 'idle',
    };
    useChatStore.setState({ conversations: { c1: conv } });
    expect(reader.getConversation('c1')).toBe(conv);
  });
});

describe('getConversationReader / setConversationReader', () => {
  const defaultReader = getConversationReader();

  afterEach(() => {
    // restore the default in-process reader so other test files aren't affected
    setConversationReader(defaultReader);
  });

  it('getConversationReader() returns a working in-process reader by default', () => {
    const reader = getConversationReader();
    expect(typeof reader.getConversation).toBe('function');
    expect(typeof reader.getIndexEntry).toBe('function');
    expect(typeof reader.getThinkingStartTime).toBe('function');
  });

  it('setConversationReader() swaps the module-level reader returned by getConversationReader()', () => {
    const stub: ConversationReader = {
      getConversation: () => undefined,
      getIndexEntry: () => undefined,
      getThinkingStartTime: () => 999,
    };
    setConversationReader(stub);
    expect(getConversationReader()).toBe(stub);
    expect(getConversationReader().getThinkingStartTime()).toBe(999);
  });
});
