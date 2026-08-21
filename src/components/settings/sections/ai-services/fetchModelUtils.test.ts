import { describe, it, expect } from 'vitest';
import { sortKnownFirst, unionSelectAll, filterModels, MODEL_FILTER_MIN_ITEMS } from './fetchModelUtils';
import type { ModelInfo } from '@/types/provider';

function makeModels(ids: string[]): ModelInfo[] {
  return ids.map((id) => ({ id, label: id }));
}

// Simple injected "isKnown" stub keyed off an allowlist — keeps these tests
// independent of the real model capability table.
function isKnownFactory(knownIds: Set<string>) {
  return (id: string) => knownIds.has(id);
}

describe('fetchModelUtils', () => {
  describe('sortKnownFirst', () => {
    it('puts known ids before unknown ids', () => {
      const models = makeModels(['unknown-1', 'gpt-4o', 'unknown-2', 'claude-opus']);
      const isKnown = isKnownFactory(new Set(['gpt-4o', 'claude-opus']));
      const sorted = sortKnownFirst(models, isKnown);
      expect(sorted.map((m) => m.id)).toEqual(['gpt-4o', 'claude-opus', 'unknown-1', 'unknown-2']);
    });

    it('preserves original relative order within each group (stable partition)', () => {
      const models = makeModels(['b-known', 'a-unknown', 'c-known', 'd-unknown']);
      const isKnown = isKnownFactory(new Set(['b-known', 'c-known']));
      const sorted = sortKnownFirst(models, isKnown);
      expect(sorted.map((m) => m.id)).toEqual(['b-known', 'c-known', 'a-unknown', 'd-unknown']);
    });

    it('returns the list unchanged (by content) when nothing is known', () => {
      const models = makeModels(['x', 'y', 'z']);
      const isKnown = () => false;
      expect(sortKnownFirst(models, isKnown).map((m) => m.id)).toEqual(['x', 'y', 'z']);
    });

    it('returns the list unchanged (by content) when everything is known', () => {
      const models = makeModels(['x', 'y', 'z']);
      const isKnown = () => true;
      expect(sortKnownFirst(models, isKnown).map((m) => m.id)).toEqual(['x', 'y', 'z']);
    });
  });

  describe('unionSelectAll', () => {
    it('selects every model in the list', () => {
      const models = makeModels(['llama3:8b', 'qwen2.5:14b']);
      expect(unionSelectAll(models, new Set())).toEqual(new Set(['llama3:8b', 'qwen2.5:14b']));
    });

    it('unions with existingSelected rather than replacing it — a manually added id survives a re-check', () => {
      const models = makeModels(['llama3:8b']);
      const result = unionSelectAll(models, new Set(['typed-by-hand']));
      expect(result).toEqual(new Set(['typed-by-hand', 'llama3:8b']));
    });

    it('keeps existingSelected intact for an empty catalog', () => {
      const result = unionSelectAll([], new Set(['saved-model']));
      expect(result).toEqual(new Set(['saved-model']));
    });

    it('does not mutate the passed-in set', () => {
      const existing = new Set(['saved-model']);
      unionSelectAll(makeModels(['new-model']), existing);
      expect(existing).toEqual(new Set(['saved-model']));
    });
  });

  describe('filterModels', () => {
    const models: ModelInfo[] = [
      { id: 'openai/gpt-4o', label: 'openai/gpt-4o' },
      { id: 'anthropic/claude-opus-4', label: 'anthropic/claude-opus-4' },
      { id: 'llama3:8b', label: 'Llama 3 (8B)' },
    ];

    it('returns the list unchanged for an empty query', () => {
      expect(filterModels(models, '')).toEqual(models);
    });

    it('returns the list unchanged for a whitespace-only query', () => {
      expect(filterModels(models, '   ')).toEqual(models);
    });

    it('matches on a substring of the id', () => {
      expect(filterModels(models, 'claude').map((m) => m.id)).toEqual(['anthropic/claude-opus-4']);
    });

    it('matches case-insensitively', () => {
      expect(filterModels(models, 'GPT-4O').map((m) => m.id)).toEqual(['openai/gpt-4o']);
    });

    it('matches on the label too, not just the id (Ollama labels carry the param size)', () => {
      expect(filterModels(models, '8B').map((m) => m.id)).toEqual(['llama3:8b']);
    });

    it('trims the query before matching', () => {
      expect(filterModels(models, '  opus  ').map((m) => m.id)).toEqual(['anthropic/claude-opus-4']);
    });

    it('returns an empty list when nothing matches', () => {
      expect(filterModels(models, 'gemini')).toEqual([]);
    });
  });

  describe('MODEL_FILTER_MIN_ITEMS', () => {
    it('is small enough that an ordinary provider catalog still gets a search box', () => {
      expect(MODEL_FILTER_MIN_ITEMS).toBe(8);
    });
  });
});
