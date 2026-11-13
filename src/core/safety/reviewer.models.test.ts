/**
 * The action reviewer decides whether an operation may run directly, so its verdict has to come
 * back parsable on every kind of model: one whose thinking is turned off for the call, and one that
 * always thinks and is given room for it. The real llmCall, adapter and parser run; only the
 * network boundary is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ProviderInstance } from '../../types/provider';

vi.unmock('@anthropic-ai/sdk');
const mockFetch = vi.fn();
vi.mock('../llm/tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { reviewAction } from './reviewer';

const ctx = { kind: 'command' as const, detail: 'cp x ~/Desktop/y', staticReason: 'writes outside the workspace' };
const VERDICT = '{"risk":"low","reason":"matches the stated intent"}';

function stream(blocks: Array<{ type: 'thinking' | 'text'; text: string }>, stopReason: string): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.text } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return new Response(events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function useClaude(modelId: string): void {
  const provider: ProviderInstance = {
    id: 'anthropic', source: 'custom', name: 'Anthropic', enabled: true, apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com', apiKey: 'k', models: [{ id: modelId, label: modelId }],
    status: 'verified', sortOrder: 1, userAdded: true,
  };
  useSettingsStore.setState({ providers: [provider], activeModel: { providerId: 'anthropic', modelId } });
}

const sentBody = () => JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;

describe('reviewAction on models with different thinking controls', () => {
  beforeEach(() => mockFetch.mockReset());

  it('a model whose thinking is turned off: disabled on the wire, the verdict is read from the text', async () => {
    useClaude('claude-opus-5');
    mockFetch.mockResolvedValueOnce(stream([{ type: 'text', text: VERDICT }], 'end_turn'));
    const verdict = await reviewAction(ctx);
    expect(sentBody()).toMatchObject({ max_tokens: 200, thinking: { type: 'disabled' } });
    expect(verdict).toMatchObject({ risk: 'low', decision: 'allow' });
  });

  it('a model that always thinks: no off field, the budget holds the thinking and the verdict, which still parses', async () => {
    useClaude('claude-fable-5');
    mockFetch.mockResolvedValueOnce(stream([
      { type: 'thinking', text: 'Considering the command... '.repeat(50) },
      { type: 'text', text: VERDICT },
    ], 'end_turn'));
    const verdict = await reviewAction(ctx);
    const body = sentBody();
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(200 + 8192);
    expect(verdict).toMatchObject({ risk: 'low', decision: 'allow' });
  });

  it('a truncated answer still escalates to the user, never allows', async () => {
    useClaude('claude-fable-5');
    mockFetch.mockResolvedValueOnce(stream([{ type: 'thinking', text: 'still thinking' }], 'max_tokens'));
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });
});
