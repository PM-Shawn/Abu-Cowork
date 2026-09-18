import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsState } from '../../stores/settingsStore';
import { getConversationReader, setConversationReader, type ConversationReader } from './ports/conversationReader';
import { settingsForConversation } from './conversationSettings';

const settings = {
  activeModel: { providerId: 'default-provider', modelId: 'default-model' },
  providers: [],
} as unknown as SettingsState;

function useReader(reader: Partial<ConversationReader>): void {
  setConversationReader({
    getConversation: () => undefined,
    getIndexEntry: () => undefined,
    getThinkingStartTime: () => null,
    ...reader,
  } as ConversationReader);
}

describe('settingsForConversation', () => {
  const original = getConversationReader();
  afterEach(() => setConversationReader(original));

  it('uses the model the conversation is bound to', () => {
    useReader({ getConversation: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never });

    expect(settingsForConversation('c1', settings).activeModel).toEqual({ providerId: 'own', modelId: 'own-model' });
  });

  it('falls back to the index entry when the record is not loaded', () => {
    useReader({ getIndexEntry: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never });

    expect(settingsForConversation('c1', settings).activeModel).toEqual({ providerId: 'own', modelId: 'own-model' });
  });

  it('returns the settings unchanged for a conversation without a model', () => {
    useReader({});

    expect(settingsForConversation('c1', settings)).toBe(settings);
  });

  it('leaves every other setting alone', () => {
    useReader({ getConversation: () => ({ model: { providerId: 'own', modelId: 'own-model' } }) as never });

    expect(settingsForConversation('c1', settings).providers).toBe(settings.providers);
  });
});
