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

function provider(overrides: Partial<ProviderInstance> & Pick<ProviderInstance, 'id'>): ProviderInstance {
  return {
    source: 'custom',
    name: overrides.id,
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: `https://${overrides.id}.example.net/v1`,
    apiKey: '',
    models: [{ id: `${overrides.id}-model`, label: `${overrides.id}-model` }],
    status: 'verified',
    sortOrder: 1,
    userAdded: true,
    ...overrides,
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

function runOn(p: ProviderInstance): Promise<void> {
  useSettingsStore.setState({
    providers: [p],
    activeModel: { providerId: p.id, modelId: p.models[0].id },
  });
  return extractMemoriesFromConversation('c1', null);
}

describe('memory extraction API key gate', () => {
  const originalReader = getConversationReader();

  beforeEach(() => {
    mockChat.mockReset().mockResolvedValue(undefined);
    mockLoadMessages.mockReset().mockResolvedValue(transcript());
    setConversationReader({
      getConversation: () => ({}) as never,
      getIndexEntry: () => undefined,
      getThinkingStartTime: () => null,
    } as ConversationReader);
  });

  afterEach(() => setConversationReader(originalReader));

  it.each<[string, ProviderInstance]>([
    ['Ollama', provider({ id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434' })],
    ['LM Studio', provider({ id: 'lmstudio', source: 'builtin', baseUrl: 'http://127.0.0.1:1234/v1' })],
    ['a custom OpenAI-compatible endpoint on this machine', provider({ id: 'local-vllm', baseUrl: 'http://localhost:8000/v1' })],
  ])('runs on %s without a key', async (_name, p) => {
    await runOn(p);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: p.models[0].id,
      apiKey: '',
      baseUrl: p.baseUrl,
    });
  });

  it.each<[string, ProviderInstance]>([
    ['a built-in cloud provider', provider({ id: 'deepseek', source: 'builtin', baseUrl: 'https://api.deepseek.com' })],
    ['a custom endpoint on a remote host', provider({ id: 'remote' })],
    ['a custom Anthropic-format endpoint on this machine', provider({ id: 'local-claude', apiFormat: 'anthropic', baseUrl: 'http://127.0.0.1:8080' })],
  ])('skips %s when its key is missing', async (_name, p) => {
    await runOn(p);

    expect(mockChat).not.toHaveBeenCalled();
  });

  it('runs on a cloud provider once it has a key', async () => {
    await runOn(provider({ id: 'deepseek', source: 'builtin', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' }));

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toMatchObject({ apiKey: 'sk-ds' });
  });
});
