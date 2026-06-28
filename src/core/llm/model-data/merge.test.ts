import { describe, it, expect } from 'vitest';
import { mergeLayers } from './merge';
import type { ModelRecord } from './schema';

const snapshot: ModelRecord[] = [
  { id: 'claude-opus-4-8', family: 'claude-opus', vision: true, contextWindow: 1000000,
    maxOutputTokens: 128000, reasoning: true, pdfInput: true, providers: ['anthropic'],
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 } },
  { id: 'qwen3-max', family: 'qwen', vision: false, contextWindow: 262144,
    maxOutputTokens: 32768, reasoning: true, pdfInput: false, providers: ['bailian'] },
];
const volcengine: ModelRecord[] = [
  { id: 'doubao-seed-2.0-pro', family: 'doubao', vision: true, contextWindow: 256000,
    maxOutputTokens: 32768, reasoning: false, pdfInput: false, providers: ['volcengine'] },
];
const overrides = { 'qwen3-max': { thinking: 'qwen' as const, maxOutputTokens: 65536 } };

describe('mergeLayers', () => {
  it('fills Abu-private fields via classifier when no override', () => {
    const out = mergeLayers(snapshot, volcengine, {});
    const opus = out.find(r => r.id === 'claude-opus-4-8')!;
    expect(opus.thinking).toBe('anthropic');
    expect(opus.toolResultImages).toBe('native');
    expect(opus.documentBlock).toBe(true);
  });

  it('override beats classifier and upstream objective fields', () => {
    const out = mergeLayers(snapshot, volcengine, overrides);
    const qwen = out.find(r => r.id === 'qwen3-max')!;
    expect(qwen.thinking).toBe('qwen');
    expect(qwen.maxOutputTokens).toBe(65536);
    expect(qwen.contextWindow).toBe(262144);
  });

  it('volcengine records are present and classified (doubao → workaround images, no thinking)', () => {
    const out = mergeLayers(snapshot, volcengine, {});
    const doubao = out.find(r => r.id === 'doubao-seed-2.0-pro')!;
    expect(doubao).toBeDefined();
    expect(doubao.thinking).toBe(false);
    expect(doubao.toolResultImages).toBe('workaround');
  });

  it('volcengine id duplicated in snapshot does not produce two records', () => {
    const dup: ModelRecord[] = [{ ...volcengine[0] }];
    const snapWithDup = [...snapshot, { ...volcengine[0], providers: ['other'] }];
    const out = mergeLayers(snapWithDup, dup, {});
    expect(out.filter(r => r.id === 'doubao-seed-2.0-pro')).toHaveLength(1);
  });
});
