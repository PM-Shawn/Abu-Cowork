/**
 * useEnsureFullyLoaded — "query-full" policy for RightPanel stats (P1 plan
 * Step 6).
 *
 * FilesSection and ContextSection compute stats over `conversation.messages`.
 * Once windowing lands (P1 steps 8-9), that array may be a recent-tail
 * window rather than the full history — panel statistics would silently
 * under-count. This hook forces a one-time full reload via
 * `chatStore.ensureFullyLoaded` whenever the active conversation isn't
 * already flagged `__fullyLoaded`, and reports whether that reload is still
 * in flight so the caller can render a light loading state instead of
 * accepting a possibly-incomplete window (the plan explicitly rejects
 * silent under-counting — "accept-window" — for these two panels).
 *
 * Today (pre-windowing) `conversation.messages` is already complete, so the
 * reload settles near-instantly — this is mostly latent/forward-compatible
 * plumbing, not yet load-bearing.
 *
 * Kept in a hook (rather than inlined per-component) both to share the
 * dedup/in-flight logic between FilesSection and ContextSection, and
 * because it's the testable seam for behavior that's otherwise awkward to
 * unit test at the component level.
 */
import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@/types';
import { useChatStore } from '@/stores/chatStore';

/** Returns true while a forced full reload of `conversation` is in flight. */
export function useEnsureFullyLoaded(conversation: Conversation | null): boolean {
  const [isLoading, setIsLoading] = useState(false);
  const inFlightIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversation || conversation.__fullyLoaded) return;
    if (inFlightIdRef.current === conversation.id) return; // already loading this conv
    inFlightIdRef.current = conversation.id;
    setIsLoading(true);
    useChatStore.getState().ensureFullyLoaded(conversation.id)
      .catch(() => {
        // Best-effort — panel falls back to whatever is already in memory.
      })
      .finally(() => {
        if (inFlightIdRef.current === conversation.id) {
          inFlightIdRef.current = null;
        }
        setIsLoading(false);
      });
  }, [conversation]);

  return isLoading;
}
