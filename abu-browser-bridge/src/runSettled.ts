/**
 * The Abu client → bridge "a run settled" notification, and the only caller of
 * `releaseExtensionTabs`.
 *
 * A run ending used to reach this bridge through no signal at all. The one
 * event it saw was a per-REQUEST abort, and the MCP SDK raises that for its own
 * request timeouts as well, so acting on it released a still-running task's
 * tabs to another conversation — the exact thing the claims exist to prevent
 * (see the long note at `wsServer.ts`'s abort path). So the app now says it
 * outright: one MCP notification at the run's settlement seal, the same seal
 * where the built-in host calls `browser_dispose_owner` over IPC.
 *
 * Registered as the SERVER's fallback notification handler rather than through
 * `setNotificationHandler`, which needs a zod schema — zod is not a declared
 * dependency of this published package, and the notification's shape is two
 * strings. Any other notification method falls through untouched (to a
 * previously installed fallback, if some other module ever adds one).
 */
import {
  ABU_RUN_SETTLED_NOTIFICATION,
  type RunSettledNotificationParams,
} from './types.js';
import { releaseExtensionTabs } from './wsServer.js';

/**
 * Run key a settlement notification means when it carries no usable `runId`.
 *
 * NOT "every run of the conversation": that scope belongs to conversation
 * deletion, and reading a run's settlement as conversation-wide would let one
 * finished delegation strip its siblings — and the conversation's own loop —
 * of tabs they are still driving. `main` is the same "absent ⇒ the
 * conversation's own loop" default `abu/runKey` has in `tools.ts` and the
 * extension's `tabClaims.ts`, so a caller that omits it lands on the pool it
 * would have claimed with.
 */
export const MAIN_RUN_KEY = 'main';

/**
 * Minimal view of the MCP `Server` this module writes to. `params` is widened
 * to a plain record so the handler stays assignable to the SDK's slot (whose
 * own params type carries `_meta`, which this notification does not use).
 */
export interface NotificationFallbackTarget {
  fallbackNotificationHandler?: (
    notification: { method: string; params?: Record<string, unknown> },
  ) => Promise<void>;
}

/**
 * Read a settlement notification's params, or `null` when there is no owner to
 * release. An owner-less release would be unbounded, so it is dropped rather
 * than widened.
 */
export function parseRunSettledParams(params: unknown): RunSettledNotificationParams | null {
  const record = (params ?? {}) as Record<string, unknown>;
  const ownerId = record.ownerId;
  if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
  const runId = record.runId;
  return {
    ownerId,
    runId: typeof runId === 'string' && runId.length > 0 ? runId : MAIN_RUN_KEY,
  };
}

/**
 * Install the settlement handler on an MCP server.
 *
 * `release` is injectable so the wire behaviour can be tested without a live
 * WebSocket; production always uses `releaseExtensionTabs`.
 */
export function registerRunSettledHandler(
  target: NotificationFallbackTarget,
  release: (ownerId: unknown, runId?: unknown) => void = releaseExtensionTabs,
): void {
  const previous = target.fallbackNotificationHandler;
  target.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== ABU_RUN_SETTLED_NOTIFICATION) {
      await previous?.(notification);
      return;
    }
    const parsed = parseRunSettledParams(notification.params);
    if (!parsed) return;
    release(parsed.ownerId, parsed.runId);
  };
}
