import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import type { ProviderInstance } from '@/types/provider';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  chat: vi.fn(),
  selectedKinds: [] as string[],
}));

vi.mock('../agent/ports/settingsReader', () => ({
  getSettingsReader: () => ({ getSnapshot: () => mocks.settings }),
}));

vi.mock('../llm/selectChatAdapter', () => ({
  selectChatAdapter: (kind: string) => {
    mocks.selectedKinds.push(kind);
    return { chat: mocks.chat };
  },
}));

vi.mock('../session/conversationStorage', () => ({
  loadMessages: async (): Promise<Message[]> => [0, 1, 2, 3].map((i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content: `message ${i} `.repeat(10),
    timestamp: i,
  })),
}));

vi.mock('./scan', () => ({ scanMemoryFiles: async () => [] }));

import { extractMemoriesFromConversation } from './extractor';

function makeProvider(patch: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'acme',
    source: 'custom',
    name: 'Acme',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://acme.example/v1',
    apiKey: 'acme-key',
    models: [{ id: 'acme-model', label: 'Acme Model' }],
    status: 'unchecked',
    sortOrder: 0,
    userAdded: true,
    ...patch,
  };
}

function seed(providers: ProviderInstance[]) {
  mocks.settings = { providers, activeModel: { providerId: 'acme', modelId: 'acme-model' } };
}

beforeEach(() => {
  mocks.chat.mockReset();
  mocks.chat.mockImplementation(async (_messages: unknown, _options: unknown, onEvent: (e: { type: string; text?: string }) => void) => {
    onEvent({ type: 'text', text: '[]' });
  });
  mocks.selectedKinds.length = 0;
});

describe('extractMemoriesFromConversation', () => {
  describe('unusable global default model', () => {
    it.each([
      ['provider turned off', () => seed([makeProvider({ enabled: false })])],
      ['model no longer listed', () => seed([makeProvider({ models: [{ id: 'other', label: 'Other' }] })])],
      ['provider removed', () => seed([])],
    ])('skips extraction and logs the reason: %s', async (_label, arrange) => {
      arrange();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await extractMemoriesFromConversation('conv-1', null);
      expect(mocks.selectedKinds).toEqual([]);
      expect(mocks.chat).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('model unavailable'),
        expect.objectContaining({ providerId: 'acme', modelId: 'acme-model' }),
      );
      warn.mockRestore();
    });
  });

  describe('usable model', () => {
    it('extracts with the provider it resolved', async () => {
      seed([makeProvider()]);
      await extractMemoriesFromConversation('conv-1', null);
      expect(mocks.selectedKinds).toEqual(['openai-compatible']);
      expect(mocks.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ model: 'acme-model', apiKey: 'acme-key', baseUrl: 'https://acme.example/v1' }),
        expect.any(Function),
      );
    });
  });
});
