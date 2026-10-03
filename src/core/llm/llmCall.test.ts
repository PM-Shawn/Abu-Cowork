import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ProviderInstance } from '../../types/provider';
import { getConversationReader, setConversationReader, type ConversationReader } from '../agent/ports/conversationReader';
import { resolveEffectiveLlmCreds } from '../enterprise/llm-resolver';
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
vi.mock('../enterprise/llm-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../enterprise/llm-resolver')>();
  return { ...actual, resolveEffectiveLlmCreds: vi.fn(actual.resolveEffectiveLlmCreds) };
});

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

  it('marks Ollama as a local server and asks it nothing when the user left the context length blank', async () => {
    mockProbeContextWindow.mockClear();
    useSettingsStore.setState({
      providers: [{
        ...provider('ollama'), source: 'builtin', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
        models: [{ id: 'llama3.2', label: 'llama3.2' }],
      }],
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    });

    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

    // 用户没填「上下文长度」，Ollama 不会收到 num_ctx；这条路径不再问 /api/ps
    const options = mockChat.mock.calls[0][1] as { requestedContextLength?: number };
    expect(options).toMatchObject({ model: 'llama3.2', localServer: true });
    expect(options.requestedContextLength).toBeUndefined();
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('passes on only the context length the user filled in for Ollama', async () => {
    mockProbeContextWindow.mockClear();
    useSettingsStore.setState({
      providers: [{
        ...provider('ollama'), source: 'builtin', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
        models: [{ id: 'llama3.2', label: 'llama3.2', declaredCapabilities: { maxInputTokens: 24576 } }],
      }],
      activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    });

    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'llama3.2', requestedContextLength: 24576, localServer: true });
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('does not mark a cloud provider as a local server', async () => {
    await llmCall({ messages: [{ role: 'user', content: 'hi' }] });
    const options = mockChat.mock.calls[0][1] as { localServer?: boolean; requestedContextLength?: number };
    expect(options.localServer).toBe(false);
    expect(options.requestedContextLength).toBeUndefined();
  });

  describe('a model that can no longer be used', () => {
    it.each([
      ['provider removed', () => [provider('own')]],
      ['provider turned off', () => [{ ...provider('default'), enabled: false }]],
      ['model no longer listed', () => [{ ...provider('default'), models: [{ id: 'other', label: 'other' }] }]],
      ['builtin provider trashed', () => [{ ...provider('default'), source: 'builtin' as const, enabled: false, apiKey: '', userAdded: false }]],
    ])('refuses before any request: %s', async (_label, providers) => {
      useSettingsStore.setState({
        providers: providers() as ProviderInstance[],
        activeModel: { providerId: 'default', modelId: 'default-model' },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(llmCall({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/model unavailable/i);

      expect(mockChat).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[llmCall]'),
        expect.objectContaining({ providerId: 'default', modelId: 'default-model' }),
      );
      warn.mockRestore();
    });

    it('names the reason in the error', async () => {
      useSettingsStore.setState({
        providers: [{ ...provider('default'), enabled: false }],
        activeModel: { providerId: 'default', modelId: 'default-model' },
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(llmCall({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('provider-disabled');

      vi.mocked(console.warn).mockRestore();
    });

    it('checks the named conversation\'s own model', async () => {
      setConversationReader({
        getConversation: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never,
        getIndexEntry: () => undefined,
        getThinkingStartTime: () => null,
      } as ConversationReader);
      useSettingsStore.setState({
        providers: [provider('default'), { ...provider('own'), enabled: false }],
        activeModel: { providerId: 'default', modelId: 'default-model' },
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(llmCall({ messages: [{ role: 'user', content: 'hi' }], conversationId: 'c1' }))
        .rejects.toThrow('provider-disabled');

      expect(mockChat).not.toHaveBeenCalled();
      vi.mocked(console.warn).mockRestore();
    });

    it('does not check personal providers when the enterprise gateway supplies credentials', async () => {
      useSettingsStore.setState({ providers: [], activeModel: { providerId: 'default', modelId: 'default-model' } });
      vi.mocked(resolveEffectiveLlmCreds).mockReturnValueOnce({
        apiKey: 'gateway-key',
        baseUrl: 'https://gateway.example.net/v1',
        forceOpenAiCompatible: true,
      });

      await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

      expect(mockChat.mock.calls[0][1]).toMatchObject({ apiKey: 'gateway-key', baseUrl: 'https://gateway.example.net/v1' });
    });

    it('does not check an enterprise-gateway model against personal providers', async () => {
      useSettingsStore.setState({ providers: [], activeModel: { providerId: 'enterprise-gateway', modelId: 'gw-model' } });

      await llmCall({ messages: [{ role: 'user', content: 'hi' }] });

      expect(mockChat).toHaveBeenCalledTimes(1);
    });
  });
});
