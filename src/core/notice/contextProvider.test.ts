import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

import {
  cachedContextProvider,
  setFocused,
} from './contextProvider';
import { route } from './router';

describe('contextProvider.setFocused', () => {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };

  beforeEach(() => {
    useChatStore.setState({ activeConversationId: null });
    setFocused(true);
    delete runtime.__ABU_SHELL__;
  });

  afterEach(() => {
    delete runtime.__ABU_SHELL__;
    vi.restoreAllMocks();
  });

  it('reflects the pushed focus state in cachedContextProvider', () => {
    setFocused(false);
    expect(cachedContextProvider(Date.now()).mainWindowFocused).toBe(false);

    setFocused(true);
    expect(cachedContextProvider(Date.now()).mainWindowFocused).toBe(true);
  });

  it('protects the pushed value against TTL expiry within the window', () => {
    // setFocused bumps the TTL — sync readers within the window must see
    // the pushed value, not whatever Tauri last reported.
    setFocused(false);
    const inTTL = Date.now() + 500;
    expect(cachedContextProvider(inTTL).mainWindowFocused).toBe(false);
  });

  it('uses live renderer focus in Electron when the pushed cache is stale', () => {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setFocused(false);

    expect(cachedContextProvider(Date.now()).mainWindowFocused).toBe(true);
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
      createdAt: Date.now(),
    }, cachedContextProvider(Date.now()));

    expect(targets).toEqual([{ channel: 'chat_card', conversationId: 'conv-1' }]);
  });

  it('does not mistake a focused child WebContentsView for an app-window blur', () => {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setFocused(true);

    expect(cachedContextProvider(Date.now()).mainWindowFocused).toBe(true);
  });
});
