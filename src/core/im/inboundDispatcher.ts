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
import { isTauriEnv } from '../../utils/tauriEnv';
import type { ImageAttachment } from '../../types';

let unlistenIM: UnlistenFn | null = null;

export async function startInboundDispatcher(): Promise<void> {
  if (!isTauriEnv()) return; // web / E2E: no Tauri event bus
  unlistenIM = await listen<{ platform: string; payload: Record<string, unknown> }>(
    'im-inbound-event',
    (event) => {
      const { platform, payload } = event.payload;
      dispatch(platform, payload);
    }
  );
  console.log('[InboundDispatcher] Started');
}

/**
 * Directly dispatch a message that arrived via a polling adapter (e.g. WeChat iLink),
 * bypassing the Tauri event bus. Same routing logic as the event listener.
 */
export function dispatchDirect(
  platform: string,
  payload: Record<string, unknown>,
  images?: ImageAttachment[],
  text?: string,
): void {
  dispatch(platform, payload, images, text);
}

export function stopInboundDispatcher(): void {
  unlistenIM?.();
  unlistenIM = null;
  console.log('[InboundDispatcher] Stopped');
}

function dispatch(
  platform: string,
  rawPayload: Record<string, unknown>,
  images?: ImageAttachment[],
  text?: string,
) {
  // Parse once, share with both paths
  const message = parseInboundMessage(platform, rawPayload);
  if (!message) return;
  // Attach adapter-downloaded images (e.g. WeChat inbound photos) so the channel
  // router can forward them to the agent as real vision content. Trigger matching
  // is text-based and unaffected.
  if (images?.length) message.images = images;
  // The adapter's own text wins when it provides one. It has already downloaded
  // the attachments, so its text carries the local paths for files and videos —
  // `parseInboundMessage` re-parses the raw payload and can only emit a bare
  // "[文件: name]", which silently dropped the one thing the agent needs to open
  // the attachment it was just sent.
  if (text !== undefined) message.text = text;

  // Trigger first: check if any IM trigger matches this message
  const matched = triggerEngine.tryMatchIMTriggers(message);
  if (matched) {
    console.log(`[InboundDispatcher] Message routed to trigger engine (${matched} trigger(s))`);
    return;
  }

  // No trigger matched → hand off to channel router
  imChannelRouter.dispatchMessage(message);
}
