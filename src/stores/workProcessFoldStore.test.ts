import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeWorkProcessFoldKey,
  useWorkProcessFoldStore,
  WORK_PROCESS_FOLD_MAX_ENTRIES,
} from './workProcessFoldStore';

describe('workProcessFoldStore', () => {
  beforeEach(() => {
    useWorkProcessFoldStore.getState().reset();
  });

  it('builds a stable key from loop id with user/assistant fallbacks', () => {
    expect(makeWorkProcessFoldKey('conv', 'loop', 'user', 'assistant')).toBe('v1:conv:loop');
    expect(makeWorkProcessFoldKey('conv', undefined, 'user', 'assistant')).toBe('v1:conv:user');
    expect(makeWorkProcessFoldKey('conv', undefined, undefined, 'assistant')).toBe('v1:conv:assistant');
  });

  it('touch creates an auto-expanded entry and updates deterministic access order', () => {
    const key = makeWorkProcessFoldKey('conv', 'loop', undefined, undefined);
    useWorkProcessFoldStore.getState().touch('conv', key);
    const firstTick = useWorkProcessFoldStore.getState().entries[key].accessTick;
    useWorkProcessFoldStore.getState().touch('conv', key);

    expect(useWorkProcessFoldStore.getState().entries[key]).toMatchObject({
      conversationId: 'conv',
      mode: 'auto',
      autoCollapseHandled: false,
    });
    expect(useWorkProcessFoldStore.getState().entries[key].accessTick).toBeGreaterThan(firstTick);
  });

  it('auto-collapse does not override a manual mode', () => {
    const key = makeWorkProcessFoldKey('conv', 'loop', undefined, undefined);
    useWorkProcessFoldStore.getState().setMode('conv', key, 'expanded');
    useWorkProcessFoldStore.getState().markAutoCollapsed('conv', key);

    expect(useWorkProcessFoldStore.getState().entries[key]).toMatchObject({
      mode: 'expanded',
      autoCollapseHandled: false,
    });
  });

  it('clears all fold entries for a deleted conversation', () => {
    const a = makeWorkProcessFoldKey('conv-a', 'loop-a', undefined, undefined);
    const b = makeWorkProcessFoldKey('conv-b', 'loop-b', undefined, undefined);
    useWorkProcessFoldStore.getState().touch('conv-a', a);
    useWorkProcessFoldStore.getState().touch('conv-b', b);

    useWorkProcessFoldStore.getState().clearConversation('conv-a');

    expect(useWorkProcessFoldStore.getState().entries[a]).toBeUndefined();
    expect(useWorkProcessFoldStore.getState().entries[b]).toBeDefined();
  });

  it('prunes to 256 entries by deterministic LRU and key tie-break', () => {
    for (let i = 0; i < WORK_PROCESS_FOLD_MAX_ENTRIES + 2; i++) {
      const key = makeWorkProcessFoldKey('conv', `loop-${i.toString().padStart(3, '0')}`, undefined, undefined);
      useWorkProcessFoldStore.getState().touch('conv', key);
    }

    const entries = useWorkProcessFoldStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(WORK_PROCESS_FOLD_MAX_ENTRIES);
    expect(entries[makeWorkProcessFoldKey('conv', 'loop-000', undefined, undefined)]).toBeUndefined();
    expect(entries[makeWorkProcessFoldKey('conv', 'loop-001', undefined, undefined)]).toBeUndefined();
    expect(entries[makeWorkProcessFoldKey('conv', 'loop-257', undefined, undefined)]).toBeDefined();
  });
});
