import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

import {
  cachedContextProvider,
  setFocused,
} from './contextProvider';

describe('contextProvider.setFocused', () => {
  beforeEach(() => {
    useChatStore.setState({ activeConversationId: null });
    setFocused(true);
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
});
