/**
 * WeChatConnectionManager — Lifecycle management for WeChat iLink polling connections.
 *
 * Watches IMChannelStore for WeChat channels and manages one WeChatInboundAdapter
 * instance per channel. Routes received messages through dispatchDirect so they
 * go through the same trigger + channel-router pipeline as webhook-based platforms.
 *
 * Called from app startup (where startInboundDispatcher is called).
 */

import { WeChatInboundAdapter } from './adapters/wechat';
import type { IMChannel } from '../../types/imChannel';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { dispatchDirect } from './inboundDispatcher';
import type { InboundMessage } from './adapters/types';

/** Active adapter instances keyed by channelId. */
const connections = new Map<string, WeChatInboundAdapter>();

function onMessage(msg: InboundMessage): void {
  // Special sentinel: auth expired — update channel status, don't dispatch
  if (msg.replyContext.extra?.type === 'auth_expired') {
    const channelId = findChannelIdByAdapter();
    if (channelId) {
      useIMChannelStore.getState().setChannelStatus(channelId, 'error', '微信登录已过期，请重新扫码绑定');
    }
    return;
  }

  dispatchDirect('wechat', msg.raw as Record<string, unknown>);
}

function findChannelIdByAdapter(): string | undefined {
  for (const [channelId, adapter] of connections.entries()) {
    if (adapter.getStatus() === 'error') return channelId;
  }
  return undefined;
}

async function startChannel(channel: IMChannel): Promise<void> {
  if (connections.has(channel.id)) return; // already running

  const adapter = new WeChatInboundAdapter();
  adapter.onMessage(onMessage);
  connections.set(channel.id, adapter);

  try {
    useIMChannelStore.getState().setChannelStatus(channel.id, 'connecting');
    await adapter.connect({ appId: channel.appId, appSecret: channel.appSecret });
    useIMChannelStore.getState().setChannelStatus(channel.id, 'connected');
    console.log(`[WeChatManager] Channel ${channel.id} connected`);
  } catch (err) {
    connections.delete(channel.id);
    const msg = err instanceof Error ? err.message : String(err);
    useIMChannelStore.getState().setChannelStatus(channel.id, 'error', msg);
    console.error(`[WeChatManager] Channel ${channel.id} failed to connect:`, err);
  }
}

async function stopChannel(channelId: string): Promise<void> {
  const adapter = connections.get(channelId);
  if (!adapter) return;
  await adapter.disconnect();
  connections.delete(channelId);
  console.log(`[WeChatManager] Channel ${channelId} disconnected`);
}

/**
 * Get the active InboundAdapter for a channel (for context_token access by replyToChat).
 */
export function getWeChatAdapter(channelId: string): WeChatInboundAdapter | undefined {
  return connections.get(channelId);
}

/**
 * Initialise the manager: start all enabled WeChat channels and subscribe to store
 * changes so new/removed channels are handled automatically.
 */
export function startWeChatManager(): void {
  const store = useIMChannelStore.getState();

  // Boot existing enabled WeChat channels
  for (const channel of Object.values(store.channels)) {
    if (channel.platform === 'wechat' && channel.enabled) {
      void startChannel(channel);
    }
  }

  // Subscribe to store changes
  useIMChannelStore.subscribe((state, prev) => {
    const newChannels = state.channels;
    const oldChannels = prev.channels;

    for (const [id, channel] of Object.entries(newChannels)) {
      if (channel.platform !== 'wechat') continue;
      const old = oldChannels[id];

      const becameEnabled = channel.enabled && (!old || !old.enabled);
      const credentialsChanged =
        old && (old.appId !== channel.appId || old.appSecret !== channel.appSecret);

      if (becameEnabled || credentialsChanged) {
        if (credentialsChanged) void stopChannel(id);
        void startChannel(channel);
      }

      const becameDisabled = !channel.enabled && old?.enabled;
      if (becameDisabled) void stopChannel(id);
    }

    // Handle deletions
    for (const id of Object.keys(oldChannels)) {
      if (!newChannels[id] && oldChannels[id].platform === 'wechat') {
        void stopChannel(id);
      }
    }
  });
}

export function stopWeChatManager(): void {
  for (const id of [...connections.keys()]) {
    void stopChannel(id);
  }
}
