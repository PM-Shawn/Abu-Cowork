import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@/types';
import { mergeToolInventory, type InventoryCandidate } from './toolInventory';

const tool: ToolDefinition = {
  name: 'notes__read', description: 'Read notes',
  inputSchema: { type: 'object', properties: {} }, execute: async () => 'ok',
};
const live: InventoryCandidate = {
  name: tool.name, source: { kind: 'mcp', server: 'notes' }, definition: tool, unavailableReasons: [],
};

describe('mergeToolInventory', () => {
  it.each([true, false])('gives builtin names priority independent of ordering (builtin first: %s)', first => {
    const builtin: InventoryCandidate = {
      ...live, source: { kind: 'builtin' }, unavailableReasons: [{ kind: 'labs-gated', experimentId: 'held-back' }],
    };
    expect(mergeToolInventory(first ? [builtin, live] : [live, builtin])).toEqual([builtin]);
  });

  it.each([true, false])('retains a disabled gate when merging a live schema (live first: %s)', first => {
    const disabled: InventoryCandidate = {
      ...live, definition: undefined, unavailableReasons: [{ kind: 'mcp-disabled', server: 'notes' }],
    };
    const input = first ? [live, disabled, disabled] : [disabled, live, disabled];
    expect(mergeToolInventory(input)).toEqual([{ ...disabled, definition: tool }]);
    expect(live.unavailableReasons).toEqual([]);
    expect(disabled.definition).toBeUndefined();
  });

  it('sorts by qualified name and retains offline entries without inventing a definition', () => {
    const offline: InventoryCandidate = {
      name: 'alpha__read', source: { kind: 'mcp', server: 'alpha' },
      unavailableReasons: [{ kind: 'mcp-not-connected', server: 'alpha', status: 'disconnected' }],
    };
    expect(mergeToolInventory([live, offline])).toEqual([offline, live]);
    expect(mergeToolInventory([])).toEqual([]);
  });
});
