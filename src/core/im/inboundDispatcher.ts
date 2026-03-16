/**
 * InboundDispatcher — Single entry point for all IM inbound messages.
 *
 * Listens to 'im-inbound-event' from Rust, parses the message once,
 * then routes to either trigger engine or channel router (never both).
 *
 * Routing rule: triggers first (they have explicit filter rules).
 * If no trigger matches, falls through to channel router.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { parseInboundMessage } from './inboundRouter';
import { triggerEngine } from '../trigger/triggerEngine';
import { imChannelRouter } from './channelRouter';

let unlistenIM: UnlistenFn | null = null;

export async function startInboundDispatcher(): Promise<void> {
  unlistenIM = await listen<{ platform: string; payload: Record<string, unknown> }>(
    'im-inbound-event',
    (event) => {
      const { platform, payload } = event.payload;
      dispatch(platform, payload);
    }
  );
  console.log('[InboundDispatcher] Started');
}

export function stopInboundDispatcher(): void {
  unlistenIM?.();
  unlistenIM = null;
  console.log('[InboundDispatcher] Stopped');
}

function dispatch(platform: string, rawPayload: Record<string, unknown>) {
  // Parse once, share with both paths
  const message = parseInboundMessage(platform, rawPayload);
  if (!message) return;

  // Trigger first: check if any IM trigger matches this message
  const matched = triggerEngine.tryMatchIMTriggers(message);
  if (matched) {
    console.log(`[InboundDispatcher] Message routed to trigger engine (${matched} trigger(s))`);
    return;
  }

  // No trigger matched → hand off to channel router
  imChannelRouter.dispatchMessage(message);
}
