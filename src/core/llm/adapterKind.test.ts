import { describe, it, expect } from 'vitest';
import { adapterKindFor, usageProtocolFor } from './adapterKind';

describe('usageProtocolFor', () => {
  it('reads Claude adapter usage as Anthropic and the other adapters as OpenAI-compatible', () => {
    expect(usageProtocolFor('claude')).toBe('anthropic');
    expect(usageProtocolFor('openai-compatible')).toBe('openai-compatible');
    expect(usageProtocolFor('ollama')).toBe('openai-compatible');
  });
});

describe('adapterKindFor', () => {
  it('sends the Ollama provider to its native adapter', () => {
    expect(adapterKindFor({ id: 'ollama', apiFormat: 'openai-compatible' }, false)).toBe('ollama');
  });

  it('keeps the enterprise gateway on the OpenAI-compatible adapter', () => {
    expect(adapterKindFor({ id: 'ollama', apiFormat: 'openai-compatible' }, true)).toBe('openai-compatible');
  });

  it('otherwise follows the API format', () => {
    expect(adapterKindFor({ id: 'lmstudio', apiFormat: 'openai-compatible' }, false)).toBe('openai-compatible');
    expect(adapterKindFor({ id: 'anthropic', apiFormat: 'anthropic' }, false)).toBe('claude');
    expect(adapterKindFor(undefined, false)).toBe('claude');
  });
});
