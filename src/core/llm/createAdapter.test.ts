import { describe, it, expect } from 'vitest';
import { createAdapterForKind } from './createAdapter';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { OllamaNativeAdapter } from './ollama-native';

describe('createAdapterForKind', () => {
  it('creates the adapter for each kind', () => {
    expect(createAdapterForKind('claude')).toBeInstanceOf(ClaudeAdapter);
    expect(createAdapterForKind('openai-compatible')).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(createAdapterForKind('ollama')).toBeInstanceOf(OllamaNativeAdapter);
  });
});
