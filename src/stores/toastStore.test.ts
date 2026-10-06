import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE_TOASTS, useToastStore } from './toastStore';

const titles = () => useToastStore.getState().toasts.map((toast) => toast.title);
// What the list shows: the first three in the store.
const shown = () => titles().slice(0, MAX_VISIBLE_TOASTS);
const add = useToastStore.getState().addToast;

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
  });

  afterEach(() => {
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows three at a time', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3);
  });

  describe('timing of a notification that is shown at once', () => {
    it('ends after 3 s, after 10 s with actions, after its own duration, and never with duration 0', async () => {
      add({ type: 'error', title: 'stays', duration: 0 });
      add({ type: 'warning', title: 'with action', actions: [{ label: 'Open', onClick: () => undefined }] });
      add({ type: 'success', title: 'plain' });
      await vi.advanceTimersByTimeAsync(2999);
      expect(titles()).toEqual(['stays', 'with action', 'plain']);
      await vi.advanceTimersByTimeAsync(1);
      expect(titles()).toEqual(['stays', 'with action']);
      add({ type: 'info', title: 'six seconds', duration: 6000 });
      await vi.advanceTimersByTimeAsync(5999);
      expect(titles()).toEqual(['stays', 'with action', 'six seconds']);
      await vi.advanceTimersByTimeAsync(1);
      expect(titles()).toEqual(['stays', 'with action']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(titles()).toEqual(['stays']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(titles()).toEqual(['stays']);
    });
  });

  describe('a notification waiting behind three shown ones', () => {
    // One error per failed draft, added in one loop (「全部接受」 in SkillDraftsPanel).
    it('gives each of five errors its full time on screen, in order', async () => {
      for (const n of [1, 2, 3, 4, 5]) add({ type: 'error', title: `error ${n}` });
      expect(shown()).toEqual(['error 1', 'error 2', 'error 3']);
      await vi.advanceTimersByTimeAsync(2999);
      expect(titles()).toEqual(['error 1', 'error 2', 'error 3', 'error 4', 'error 5']);
      await vi.advanceTimersByTimeAsync(1);
      // The first three have had their 3 s; the two that waited are shown now and start theirs.
      expect(shown()).toEqual(['error 4', 'error 5']);
      await vi.advanceTimersByTimeAsync(2999);
      expect(shown()).toEqual(['error 4', 'error 5']);
      await vi.advanceTimersByTimeAsync(1);
      expect(titles()).toEqual([]);
    });

    it('does not count down while it waits, however long', async () => {
      for (const n of [1, 2, 3]) add({ type: 'error', title: `kept ${n}`, duration: 0 });
      add({ type: 'error', title: 'waiting' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(titles()).toEqual(['kept 1', 'kept 2', 'kept 3', 'waiting']);
      useToastStore.getState().removeToast(useToastStore.getState().toasts[0].id);
      expect(shown()).toEqual(['kept 2', 'kept 3', 'waiting']);
      await vi.advanceTimersByTimeAsync(2999);
      expect(shown()).toEqual(['kept 2', 'kept 3', 'waiting']);
      await vi.advanceTimersByTimeAsync(1);
      expect(shown()).toEqual(['kept 2', 'kept 3']);
    });

    it('comes in at once when a shown one is dismissed, the oldest waiting first', async () => {
      for (const n of [1, 2, 3, 4, 5]) add({ type: 'info', title: `notice ${n}` });
      await vi.advanceTimersByTimeAsync(1000);
      useToastStore.getState().removeToast(useToastStore.getState().toasts[1].id);
      expect(shown()).toEqual(['notice 1', 'notice 3', 'notice 4']);
      // 1 and 3 end 3 s after they were added; 4 has its own 3 s from the moment it came in.
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown()).toEqual(['notice 4', 'notice 5']);
      await vi.advanceTimersByTimeAsync(999);
      expect(shown()).toEqual(['notice 4', 'notice 5']);
      await vi.advanceTimersByTimeAsync(1);
      expect(shown()).toEqual(['notice 5']);
      await vi.advanceTimersByTimeAsync(2000);
      expect(titles()).toEqual([]);
    });

    it('never shows when it is removed while it waits, and leaves no timer behind', async () => {
      for (const n of [1, 2, 3, 4]) add({ type: 'info', title: `notice ${n}` });
      useToastStore.getState().removeToast(useToastStore.getState().toasts[3].id);
      expect(titles()).toEqual(['notice 1', 'notice 2', 'notice 3']);
      await vi.advanceTimersByTimeAsync(3000);
      expect(titles()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
