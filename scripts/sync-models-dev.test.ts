import { describe, it, expect } from 'vitest';
import { diffSnapshots } from './sync-models-dev';
import type { ModelsDevApi } from '../src/core/llm/model-data/schema';

const mk = (id: string, ctx: number, inCost: number): ModelsDevApi => ({
  anthropic: { id: 'anthropic', models: { [id]: { id, limit: { context: ctx, output: 1 }, cost: { input: inCost, output: 1 } } } },
});

describe('diffSnapshots', () => {
  it('reports added, removed, context and price changes', () => {
    const oldApi = { ...mk('a', 100, 5).anthropic.models, ...mk('gone', 9, 9).anthropic.models };
    const newApi = { ...mk('a', 200, 7).anthropic.models, ...mk('b', 50, 1).anthropic.models };
    const d = diffSnapshots(
      { anthropic: { id: 'anthropic', models: oldApi } },
      { anthropic: { id: 'anthropic', models: newApi } },
    );
    expect(d.added).toContain('anthropic/b');
    expect(d.removed).toContain('anthropic/gone');
    expect(d.changed.find(c => c.id === 'anthropic/a')?.fields).toEqual(
      expect.arrayContaining(['context: 100→200', 'input: 5→7']),
    );
  });

  it('empty diff when identical', () => {
    const api = mk('a', 100, 5);
    const d = diffSnapshots(api, api);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });
});
