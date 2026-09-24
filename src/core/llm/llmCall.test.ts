import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ProviderInstance } from '../../types/provider';
import { getConversationReader, setConversationReader, type ConversationReader } from '../agent/ports/conversationReader';
import { llmCall } from './llmCall';

const mockChat = vi.fn();

vi.mock('./openai-compatible', () => ({
  OpenAICompatibleAdapter: class { chat = (...args: unknown[]) => mockChat(...args); },
}));
vi.mock('./claude', () => ({
  ClaudeAdapter: class { chat = (...args: unknown[]) => mockChat(...args); },
}));

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

describe('llmCall', () => {
  const originalReader = getConversationReader();

  beforeEach(() => {
    mockChat.mockReset().mockResolvedValue(undefined);
    useSettingsStore.setState({
      providers: [provider('default'), provider('own')],
      activeModel: { providerId: 'default', modelId: 'default-model' },
    });
  });

  afterEach(() => setConversationReader(originalReader));

  it('runs on the new-conversation default when no conversation is named', async () => {
    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: 'default-model',
      apiKey: 'sk-default',
      baseUrl: 'https://default.example.net/v1',
    });
  });

  it('runs on the named conversation\'s own model and provider', async () => {
    setConversationReader({
      getConversation: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never,
      getIndexEntry: () => undefined,
      getThinkingStartTime: () => null,
    } as ConversationReader);

    await llmCall({ messages: [{ role: 'user', content: 'hi' }], conversationId: 'c1' });

    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: 'own-model',
      apiKey: 'sk-own',
      baseUrl: 'https://own.example.net/v1',
    });
  });
});
