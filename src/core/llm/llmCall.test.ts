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
vi.mock('./ollama-native', () => ({
  OllamaNativeAdapter: class { chat = (...args: unknown[]) => mockChat(...args); },
}));
const { mockProbeContextWindow } = vi.hoisted(() => ({ mockProbeContextWindow: vi.fn() }));
vi.mock('./contextWindowProbe', () => ({ probeContextWindow: mockProbeContextWindow }));

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

  it('sends Ollama the window the service reported, the same the task used', async () => {
    mockProbeContextWindow.mockResolvedValue(8192);
    useSettingsStore.setState({
      providers: [{
        ...provider('ollama'), source: 'builtin', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
        models: [{ id: 'llama3.2', label: 'llama3.2' }],
      }],
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    });

    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

    // 窗口与任务请求按同一套优先级取；用户没填「上下文长度」，Ollama 不会收到 num_ctx
    const options = mockChat.mock.calls[0][1] as { requestedContextLength?: number };
    expect(options).toMatchObject({ model: 'llama3.2', contextWindow: 8192, localServer: true });
    expect(options.requestedContextLength).toBeUndefined();
  });

  it('passes on only the context length the user filled in for Ollama', async () => {
    mockProbeContextWindow.mockClear();
    mockProbeContextWindow.mockResolvedValue(8192);
    useSettingsStore.setState({
      providers: [{
        ...provider('ollama'), source: 'builtin', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
        models: [{ id: 'llama3.2', label: 'llama3.2', declaredCapabilities: { maxInputTokens: 24576 } }],
      }],
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    });

    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: 'llama3.2', contextWindow: 24576, requestedContextLength: 24576, localServer: true,
    });
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('does not mark a cloud provider as a local server', async () => {
    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });
    const options = mockChat.mock.calls[0][1] as { localServer?: boolean; requestedContextLength?: number };
    expect(options.localServer).toBe(false);
    expect(options.requestedContextLength).toBeUndefined();
  });
});
