import { describe, it, expect, vi } from 'vitest';
import { createPortSlot } from './portSlot';

describe('createPortSlot', () => {
  it('get() returns the value produced by createDefault()', () => {
    const slot = createPortSlot(() => ({ value: 42 }));
    expect(slot.get()).toEqual({ value: 42 });
  });

  it('createDefault() is invoked exactly once, at slot creation', () => {
    const createDefault = vi.fn(() => ({ id: 'default' }));
    const slot = createPortSlot(createDefault);
    expect(createDefault).toHaveBeenCalledTimes(1);
    slot.get();
    slot.get();
    expect(createDefault).toHaveBeenCalledTimes(1);
  });

  it('set() swaps the value returned by subsequent get() calls', () => {
    const slot = createPortSlot(() => ({ id: 'default' }));
    const replacement = { id: 'replacement' };
    slot.set(replacement);
    expect(slot.get()).toBe(replacement);
  });

  it('independently-created slots do not share state', () => {
    const slotA = createPortSlot(() => ({ id: 'a' }));
    const slotB = createPortSlot(() => ({ id: 'b' }));
    slotA.set({ id: 'a-swapped' });
    expect(slotA.get()).toEqual({ id: 'a-swapped' });
    expect(slotB.get()).toEqual({ id: 'b' });
  });
});
