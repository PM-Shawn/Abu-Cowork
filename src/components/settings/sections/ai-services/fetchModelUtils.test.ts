import { describe, it, expect } from 'vitest';
import { sortKnownFirst, computeFetchPreselection, SMALL_LIST_MAX } from './fetchModelUtils';
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

  describe('computeFetchPreselection', () => {
    it('pre-checks ALL models for a small mixed known/unknown list (<= SMALL_LIST_MAX)', () => {
      expect(SMALL_LIST_MAX).toBe(25);
      const models = makeModels(['gpt-4o', 'unknown-a', 'unknown-b']);
      const isKnown = isKnownFactory(new Set(['gpt-4o']));
      const result = computeFetchPreselection(models, isKnown, new Set());
      expect(result).toEqual(new Set(['gpt-4o', 'unknown-a', 'unknown-b']));
    });

    it('pre-checks ONLY known ids for a large list (aggregator convergence)', () => {
      const knownIds = ['gpt-4o', 'claude-opus'];
      const unknownIds = Array.from({ length: 38 }, (_, i) => `aggregator-model-${i}`);
      const models = makeModels([...knownIds, ...unknownIds]);
      expect(models.length).toBeGreaterThan(SMALL_LIST_MAX);
      const isKnown = isKnownFactory(new Set(knownIds));
      const result = computeFetchPreselection(models, isKnown, new Set());
      expect(result).toEqual(new Set(knownIds));
    });

    it('pre-checks NOTHING for a large list with zero known ids', () => {
      const unknownIds = Array.from({ length: 40 }, (_, i) => `aggregator-model-${i}`);
      const models = makeModels(unknownIds);
      expect(models.length).toBeGreaterThan(SMALL_LIST_MAX);
      const isKnown = () => false;
      const result = computeFetchPreselection(models, isKnown, new Set());
      expect(result).toEqual(new Set());
    });

    it('unions with existingSelected — a curated-preset id survives even though it is not "known" and the fetched list is large', () => {
      const curatedId = 'vendor/curated-preset-model';
      const unknownIds = Array.from({ length: 40 }, (_, i) => `aggregator-model-${i}`);
      const models = makeModels(unknownIds);
      const isKnown = () => false;
      const result = computeFetchPreselection(models, isKnown, new Set([curatedId]));
      expect(result.has(curatedId)).toBe(true);
      expect(result).toEqual(new Set([curatedId]));
    });

    it('unions with existingSelected on the small-list path too', () => {
      const curatedId = 'vendor/curated-preset-model';
      const models = makeModels(['gpt-4o', 'unknown-a']);
      const isKnown = isKnownFactory(new Set(['gpt-4o']));
      const result = computeFetchPreselection(models, isKnown, new Set([curatedId]));
      expect(result).toEqual(new Set([curatedId, 'gpt-4o', 'unknown-a']));
    });

    it('boundary: exactly SMALL_LIST_MAX models pre-checks all (inclusive <=)', () => {
      const models = makeModels(Array.from({ length: SMALL_LIST_MAX }, (_, i) => `model-${i}`));
      const isKnown = () => false;
      const result = computeFetchPreselection(models, isKnown, new Set());
      expect(result.size).toBe(SMALL_LIST_MAX);
    });

    it('boundary: SMALL_LIST_MAX + 1 models switches to known-only branch', () => {
      const models = makeModels(Array.from({ length: SMALL_LIST_MAX + 1 }, (_, i) => `model-${i}`));
      const isKnown = () => false;
      const result = computeFetchPreselection(models, isKnown, new Set());
      expect(result.size).toBe(0);
    });
  });
});
