import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Message } from '../../types';
import type { ProviderInstance } from '../../types/provider';
import { getConversationReader, setConversationReader, type ConversationReader } from '../agent/ports/conversationReader';
import { extractMemoriesFromConversation } from './extractor';

const mockChat = vi.fn();
const mockLoadMessages = vi.fn();

vi.mock('../llm/selectChatAdapter', () => ({
  selectChatAdapter: () => ({ chat: (...args: unknown[]) => mockChat(...args) }),
}));
vi.mock('../session/conversationStorage', () => ({
  loadMessages: (...args: unknown[]) => mockLoadMessages(...args),
}));
vi.mock('./scan', () => ({ scanMemoryFiles: async () => [] }));

function provider(id: string): ProviderInstance {
  return {
    id,
    source: 'custom',
    name: id,
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: `https://${id}.example.net/v1`,
    apiKey: `sk-${id}`,
    models: [{ id: `${id}-model`, label: `${id}-model` }],
    status: 'verified',
    sortOrder: 1,
    userAdded: true,
  };
}

function transcript(): Message[] {
  const line = (i: number, role: 'user' | 'assistant'): Message => ({
    id: `m${i}`,
    role,
    content: `${role} message number ${i} with enough words to count as a real conversation turn`,
    timestamp: i,
  });
  return [line(1, 'user'), line(2, 'assistant'), line(3, 'user'), line(4, 'assistant')];
}

describe('memory extraction runs on the conversation\'s own provider', () => {
  const originalReader = getConversationReader();

  beforeEach(() => {
    mockChat.mockReset().mockResolvedValue(undefined);
    mockLoadMessages.mockReset().mockResolvedValue(transcript());
    useSettingsStore.setState({
      providers: [provider('default'), provider('own')],
      activeModel: { providerId: 'default', modelId: 'default-model' },
    });
  });

  afterEach(() => setConversationReader(originalReader));

  it('sends the transcript to the provider the conversation is bound to, with that provider\'s key', async () => {
    setConversationReader({
      getConversation: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never,
      getIndexEntry: () => undefined,
      getThinkingStartTime: () => null,
    } as ConversationReader);

    await extractMemoriesFromConversation('c1', null);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: 'own-model',
      apiKey: 'sk-own',
      baseUrl: 'https://own.example.net/v1',
    });
  });

  it('uses the default only for a conversation without a model of its own', async () => {
    setConversationReader({
      getConversation: () => ({}) as never,
      getIndexEntry: () => undefined,
      getThinkingStartTime: () => null,
    } as ConversationReader);

    await extractMemoriesFromConversation('c1', null);

    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'default-model', apiKey: 'sk-default' });
  });
});
