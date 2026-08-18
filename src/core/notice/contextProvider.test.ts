import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

import {
  cachedContextProvider,
  setFocused,
} from './contextProvider';
import { route } from './router';

// Deterministic clock (TESTING.md §3) — setFocused() reads Date.now() directly
// (no injectable clock) to bump its internal TTL, so tests freeze the global
// clock via fake timers rather than depending on real wall-clock proximity
// between setFocused() and the cachedContextProvider(now) reads below.
const FIXED_NOW = 1_700_000_000_000;

describe('contextProvider.setFocused', () => {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    useChatStore.setState({ activeConversationId: null });
    setFocused(true);
    delete runtime.__ABU_SHELL__;
  });

  afterEach(() => {
    delete runtime.__ABU_SHELL__;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reflects the pushed focus state in cachedContextProvider', () => {
    setFocused(false);
    expect(cachedContextProvider(FIXED_NOW).mainWindowFocused).toBe(false);

    setFocused(true);
    expect(cachedContextProvider(FIXED_NOW).mainWindowFocused).toBe(true);
  });

  it('protects the pushed value against TTL expiry within the window', () => {
    // setFocused bumps the TTL — sync readers within the window must see
    // the pushed value, not whatever Tauri last reported.
    setFocused(false);
    const inTTL = FIXED_NOW + 500;
    expect(cachedContextProvider(inTTL).mainWindowFocused).toBe(false);
  });

  it('uses live renderer focus in Electron when the pushed cache is stale', () => {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setFocused(false);

    expect(cachedContextProvider(FIXED_NOW).mainWindowFocused).toBe(true);
  });

  it('keeps a visible current-conversation completion out of the menubar', () => {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useChatStore.setState({ activeConversationId: 'conv-1' });
    setFocused(false);

    const targets = route({
      id: 'ntc-visible-complete',
      type: 'task_complete',
      tier: 'L1',
      source: 'agent',
      payload: { conversationId: 'conv-1' },
      dedupKey: 'visible-complete',
      createdAt: FIXED_NOW,
    }, cachedContextProvider(FIXED_NOW));

    expect(targets).toEqual([{ channel: 'chat_card', conversationId: 'conv-1' }]);
  });

  it('does not mistake a focused child WebContentsView for an app-window blur', () => {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setFocused(true);

    expect(cachedContextProvider(FIXED_NOW).mainWindowFocused).toBe(true);
  });
});
