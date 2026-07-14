import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEnsureFullyLoaded } from './useEnsureFullyLoaded';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'test',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    ...overrides,
  };
}

/** Flush the microtask the hook's ensureFullyLoaded().catch().finally() chain awaits. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useEnsureFullyLoaded', () => {
  let ensureFullyLoadedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureFullyLoadedSpy = vi.spyOn(useChatStore.getState(), 'ensureFullyLoaded')
      .mockResolvedValue(makeConversation({ __fullyLoaded: true }));
  });

  afterEach(() => {
    ensureFullyLoadedSpy.mockRestore();
  });

  it('does nothing when conversation is null', async () => {
    const { result } = renderHook(() => useEnsureFullyLoaded(null));
    await flush();
    expect(ensureFullyLoadedSpy).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it('does nothing when the conversation is already __fullyLoaded', async () => {
    const conv = makeConversation({ __fullyLoaded: true });
    const { result } = renderHook(() => useEnsureFullyLoaded(conv));
    await flush();
    expect(ensureFullyLoadedSpy).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it('triggers ensureFullyLoaded once for a not-yet-fully-loaded conversation and reports loading state', async () => {
    let resolveLoad!: (conv: Conversation) => void;
    ensureFullyLoadedSpy.mockReturnValue(
      new Promise<Conversation>((resolve) => { resolveLoad = resolve; }),
    );
    const conv = makeConversation({ __fullyLoaded: undefined });

    const { result } = renderHook(() => useEnsureFullyLoaded(conv));

    expect(ensureFullyLoadedSpy).toHaveBeenCalledWith('conv-1');
    expect(result.current).toBe(true);

    await act(async () => {
      resolveLoad(makeConversation({ __fullyLoaded: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
    expect(ensureFullyLoadedSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call ensureFullyLoaded again on a re-render with the same in-flight conversation id', async () => {
    let resolveLoad!: (conv: Conversation) => void;
    ensureFullyLoadedSpy.mockReturnValue(
      new Promise<Conversation>((resolve) => { resolveLoad = resolve; }),
    );
    const conv = makeConversation({ __fullyLoaded: undefined });

    const { rerender } = renderHook(({ c }) => useEnsureFullyLoaded(c), {
      initialProps: { c: conv },
    });
    // Re-render with a NEW object reference but same id/flag — simulates an
    // unrelated store mutation reflowing the conversation prop while the
    // load is still in flight.
    rerender({ c: { ...conv } });

    expect(ensureFullyLoadedSpy).toHaveBeenCalledTimes(1);
    resolveLoad(makeConversation({ __fullyLoaded: true }));
    await flush();
  });

  it('calls again when the conversation id changes to a different not-fully-loaded conversation', async () => {
    ensureFullyLoadedSpy.mockResolvedValue(makeConversation({ __fullyLoaded: true }));
    const convA = makeConversation({ id: 'conv-a', __fullyLoaded: undefined });
    const convB = makeConversation({ id: 'conv-b', __fullyLoaded: undefined });

    const { rerender } = renderHook(({ c }) => useEnsureFullyLoaded(c), {
      initialProps: { c: convA },
    });
    await flush();
    rerender({ c: convB });
    await flush();

    expect(ensureFullyLoadedSpy).toHaveBeenNthCalledWith(1, 'conv-a');
    expect(ensureFullyLoadedSpy).toHaveBeenNthCalledWith(2, 'conv-b');
    expect(ensureFullyLoadedSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows a rejection and still clears the loading state', async () => {
    ensureFullyLoadedSpy.mockRejectedValue(new Error('disk error'));
    const conv = makeConversation({ __fullyLoaded: undefined });

    const { result } = renderHook(() => useEnsureFullyLoaded(conv));
    expect(result.current).toBe(true);
    await flush();
    expect(result.current).toBe(false);
  });
});
