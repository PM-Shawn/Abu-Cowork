import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE_TOASTS, VISIBLE_TOASTS_BESIDE_DECISION, useToastStore } from './toastStore';

const titles = () => useToastStore.getState().toasts.map((toast) => toast.title);
// What the list shows: the newest ones, as many as there are places.
const shown = () => titles().slice(-useToastStore.getState().places);
const add = useToastStore.getState().addToast;
const remove = (title: string) => {
  const found = useToastStore.getState().toasts.find((toast) => toast.title === title);
  if (!found) throw new Error(`no notice ${title}`);
  useToastStore.getState().removeToast(found.id);
};
const sandbox = (folder: string) => add({
  type: 'warning',
  title: 'Write blocked',
  message: `Folder: ${folder}`,
  actions: [{ label: 'Authorize', onClick: () => undefined }, { label: 'Open settings', onClick: () => undefined }],
});
const clear = () => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
  useToastStore.getState().setPlaces(MAX_VISIBLE_TOASTS);
};

// Records, in steps of 100 ms, for how long each title is among the shown ones until the list is empty.
async function watch(limitMs: number): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  for (let elapsed = 0; elapsed < limitMs && titles().length > 0; elapsed += 100) {
    for (const title of shown()) seen[title] = (seen[title] ?? 0) + 100;
    await vi.advanceTimersByTimeAsync(100);
  }
  return seen;
}

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clear();
  });

  afterEach(() => {
    clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('has three places, and one beside an approval', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(VISIBLE_TOASTS_BESIDE_DECISION).toBe(1);
    expect(useToastStore.getState().places).toBe(3);
  });

  describe('timing of a notification that stays on screen', () => {
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

  describe('a new notification is on screen at once', () => {
    it('shows an error in the same tick behind six sandbox notifications', () => {
      for (const n of [1, 2, 3, 4, 5, 6]) sandbox(`/fake/project/folder-${n}`);
      add({ type: 'error', title: 'Send blocked' });
      expect(shown()).toContain('Send blocked');
      expect(shown().at(-1)).toBe('Send blocked');
      expect(titles()).toHaveLength(7);
    });

    it('shows the new one beside three that stay until dismissed, and the pushed-out one returns', async () => {
      for (const n of [1, 2, 3]) add({ type: 'error', title: `kept ${n}`, duration: 0 });
      add({ type: 'success', title: 'new' });
      expect(shown()).toEqual(['kept 2', 'kept 3', 'new']);
      expect(titles()).toEqual(['kept 1', 'kept 2', 'kept 3', 'new']);
      await vi.advanceTimersByTimeAsync(3000);
      expect(shown()).toEqual(['kept 1', 'kept 2', 'kept 3']);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(shown()).toEqual(['kept 1', 'kept 2', 'kept 3']);
    });
  });

  describe('a notification pushed out by newer ones', () => {
    it('stops its clock off screen and returns for the time it had left, the last pushed out first', async () => {
      add({ type: 'info', title: 'a' });
      await vi.advanceTimersByTimeAsync(1000);
      add({ type: 'info', title: 'b' });
      await vi.advanceTimersByTimeAsync(1000);
      // a has had 2 s, b 1 s. Three long ones push both out.
      for (const n of [1, 2, 3]) add({ type: 'info', title: `long ${n}`, duration: 5000 });
      expect(shown()).toEqual(['long 1', 'long 2', 'long 3']);
      await vi.advanceTimersByTimeAsync(4999);
      expect(titles()).toEqual(['a', 'b', 'long 1', 'long 2', 'long 3']);
      await vi.advanceTimersByTimeAsync(1);
      // All three long ones end together: both come back, each with what it had left.
      expect(shown()).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(999);
      expect(shown()).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(1);
      expect(shown()).toEqual(['b']);
      await vi.advanceTimersByTimeAsync(999);
      expect(shown()).toEqual(['b']);
      await vi.advanceTimersByTimeAsync(1);
      expect(titles()).toEqual([]);
    });

    it('returns one at a time as places free, most recently pushed out first', async () => {
      for (const n of [1, 2, 3, 4, 5]) add({ type: 'error', title: `kept ${n}`, duration: 0 });
      expect(shown()).toEqual(['kept 3', 'kept 4', 'kept 5']);
      remove('kept 4');
      expect(shown()).toEqual(['kept 2', 'kept 3', 'kept 5']);
      remove('kept 5');
      expect(shown()).toEqual(['kept 1', 'kept 2', 'kept 3']);
    });

    // One error per failed draft, added in one loop (「全部接受」 in SkillDraftsPanel).
    it('gives each of five different errors its full 3 s on screen in total, and drops none', async () => {
      for (const n of [1, 2, 3, 4, 5]) add({ type: 'error', title: `error ${n}` });
      expect(shown()).toEqual(['error 3', 'error 4', 'error 5']);
      const seen = await watch(20_000);
      expect(seen).toEqual({ 'error 1': 3000, 'error 2': 3000, 'error 3': 3000, 'error 4': 3000, 'error 5': 3000 });
      expect(titles()).toEqual([]);
    });

    it('gives every sandbox notification its full 10 s even when an error cuts in', async () => {
      for (const n of [1, 2, 3, 4, 5, 6]) sandbox(`/fake/project/folder-${n}`);
      await vi.advanceTimersByTimeAsync(2000);
      add({ type: 'error', title: 'Send blocked' });
      const seen: Record<string, number> = {};
      for (let elapsed = 0; elapsed < 60_000 && useToastStore.getState().toasts.length > 0; elapsed += 100) {
        for (const toast of useToastStore.getState().toasts.slice(-3)) seen[toast.message ?? toast.title] = (seen[toast.message ?? toast.title] ?? 0) + 100;
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(seen['Send blocked']).toBe(3000);
      // Folders 4 to 6 had 2 s before the watch began.
      for (const n of [1, 2, 3]) expect(seen[`Folder: /fake/project/folder-${n}`]).toBe(10_000);
      for (const n of [4, 5, 6]) expect(seen[`Folder: /fake/project/folder-${n}`]).toBe(8000);
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('is removed off screen by removeToast and never shows', async () => {
      for (const n of [1, 2, 3, 4]) add({ type: 'info', title: `notice ${n}` });
      expect(shown()).toEqual(['notice 2', 'notice 3', 'notice 4']);
      remove('notice 1');
      expect(titles()).toEqual(['notice 2', 'notice 3', 'notice 4']);
      await vi.advanceTimersByTimeAsync(3000);
      expect(titles()).toEqual([]);
    });

    it('leaves no timer once all are gone, and runs one timer per shown notification meanwhile', async () => {
      for (const n of [1, 2, 3, 4, 5]) add({ type: 'info', title: `notice ${n}` });
      expect(vi.getTimerCount()).toBe(3);
      remove('notice 1');
      expect(vi.getTimerCount()).toBe(3);
      remove('notice 5');
      expect(vi.getTimerCount()).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(titles()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('equal notifications merge', () => {
    it('shows five equal errors once, as the newest, with its full time again', async () => {
      add({ type: 'error', title: 'Send blocked', message: 'Pick a model first' });
      await vi.advanceTimersByTimeAsync(2000);
      add({ type: 'info', title: 'other' });
      for (let n = 0; n < 4; n += 1) add({ type: 'error', title: 'Send blocked', message: 'Pick a model first' });
      expect(titles()).toEqual(['other', 'Send blocked']);
      await vi.advanceTimersByTimeAsync(2999);
      expect(titles()).toEqual(['other', 'Send blocked']);
      await vi.advanceTimersByTimeAsync(1);
      expect(titles()).toEqual([]);
    });

    it('keeps the id of the one that was there and takes the actions of the new one', () => {
      const first = vi.fn();
      const second = vi.fn();
      add({ type: 'warning', title: 'Write blocked', message: 'Folder: /fake/project/a', actions: [{ label: 'Authorize', onClick: first }] });
      const { id } = useToastStore.getState().toasts[0];
      add({ type: 'warning', title: 'Write blocked', message: 'Folder: /fake/project/a', actions: [{ label: 'Authorize', onClick: second }] });
      const [only, ...rest] = useToastStore.getState().toasts;
      expect(rest).toEqual([]);
      expect(only.id).toBe(id);
      only.actions?.[0].onClick();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it('brings a waiting equal one back on screen instead of adding another', () => {
      sandbox('/fake/project/a');
      for (const n of [1, 2, 3]) add({ type: 'info', title: `notice ${n}`, duration: 0 });
      expect(shown()).not.toContain('Write blocked');
      sandbox('/fake/project/a');
      expect(titles()).toEqual(['notice 1', 'notice 2', 'notice 3', 'Write blocked']);
      expect(shown().at(-1)).toBe('Write blocked');
    });

    it('does not merge notifications that differ in type, title, message or action labels', () => {
      add({ type: 'error', title: 'Failed', message: 'one' });
      add({ type: 'warning', title: 'Failed', message: 'one' });
      add({ type: 'error', title: 'Failed', message: 'two' });
      add({ type: 'error', title: 'Failed' });
      add({ type: 'error', title: 'Failed', message: 'one', actions: [{ label: 'Retry', onClick: () => undefined }] });
      sandbox('/fake/project/a');
      sandbox('/fake/project/b');
      expect(titles()).toHaveLength(7);
    });
  });

  describe('places', () => {
    it('with one place shows the newest alone; the others keep their time and return with the places', async () => {
      for (const n of [1, 2, 3]) add({ type: 'info', title: `notice ${n}` });
      await vi.advanceTimersByTimeAsync(1000);
      useToastStore.getState().setPlaces(VISIBLE_TOASTS_BESIDE_DECISION);
      expect(shown()).toEqual(['notice 3']);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(titles()).toEqual(['notice 1', 'notice 2', 'notice 3']);
      await vi.advanceTimersByTimeAsync(1);
      // The newest has had its 3 s; the next one takes the single place with the 2 s it had left.
      expect(shown()).toEqual(['notice 2']);
      await vi.advanceTimersByTimeAsync(60);
      useToastStore.getState().setPlaces(MAX_VISIBLE_TOASTS);
      expect(shown()).toEqual(['notice 1', 'notice 2']);
      await vi.advanceTimersByTimeAsync(1939);
      expect(shown()).toEqual(['notice 1', 'notice 2']);
      await vi.advanceTimersByTimeAsync(1);
      expect(shown()).toEqual(['notice 1']);
      await vi.advanceTimersByTimeAsync(60);
      expect(titles()).toEqual([]);
    });

    it('a notification that arrives while there is one place takes it', () => {
      useToastStore.getState().setPlaces(VISIBLE_TOASTS_BESIDE_DECISION);
      add({ type: 'info', title: 'first' });
      add({ type: 'error', title: 'second' });
      expect(shown()).toEqual(['second']);
      expect(titles()).toEqual(['first', 'second']);
    });
  });
});
