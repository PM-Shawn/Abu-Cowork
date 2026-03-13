/**
 * Feishu WebSocket Manager
 *
 * Manages the lifecycle of the Feishu WebSocket long connection.
 * Bridges the IM channel store with the Rust-side WebSocket client.
 *
 * When a Feishu channel is enabled, starts the WSS connection.
 * When disabled/deleted, stops it.
 * Status updates from Rust are forwarded to the IM channel store.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useIMChannelStore } from '../../stores/imChannelStore';
import type { IMChannelStatus } from '../../types/imChannel';

interface WsStatus {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  reconnect_attempts: number;
}

let statusUnlisten: UnlistenFn | null = null;
let storeUnsubscribe: (() => void) | null = null;
let currentChannelId: string | null = null;
let starting = false;

/**
 * Start listening for Feishu WebSocket status events and
 * auto-manage the connection based on channel store state.
 */
export async function startFeishuWsManager(): Promise<void> {
  // Listen for status events from Rust
  statusUnlisten = await listen<WsStatus>('feishu-ws-status', (event) => {
    if (!currentChannelId) return;

    const ws = event.payload;
    let status: IMChannelStatus;
    if (ws.connected) {
      status = 'connected';
    } else if (ws.connecting) {
      status = 'connecting';
    } else if (ws.error) {
      status = 'error';
    } else {
      status = 'disconnected';
    }

    useIMChannelStore
      .getState()
      .setChannelStatus(currentChannelId, status, ws.error ?? undefined);
  });

  // Subscribe to store changes — auto-start/stop WS based on channel state
  const store = useIMChannelStore;
  let prevFeishuEnabled = false;

  storeUnsubscribe = store.subscribe((state) => {
    const feishuChannels = Object.values(state.channels).filter(
      (ch) => ch.platform === 'feishu' && ch.enabled,
    );

    const hasEnabled = feishuChannels.length > 0;

    if (hasEnabled && !prevFeishuEnabled) {
      // Feishu channel just got enabled — start WS
      const ch = feishuChannels[0];
      startFeishuWs(ch.id, ch.appId, ch.appSecret);
    } else if (!hasEnabled && prevFeishuEnabled) {
      // Feishu channel just got disabled — stop WS
      stopFeishuWs();
    }

    prevFeishuEnabled = hasEnabled;
  });

  // Check current state on startup
  const feishuChannels = Object.values(store.getState().channels).filter(
    (ch) => ch.platform === 'feishu' && ch.enabled,
  );
  if (feishuChannels.length > 0) {
    const ch = feishuChannels[0];
    startFeishuWs(ch.id, ch.appId, ch.appSecret);
  }
}

/**
 * Stop the Feishu WS manager and clean up.
 */
export async function stopFeishuWsManager(): Promise<void> {
  if (statusUnlisten) {
    statusUnlisten();
    statusUnlisten = null;
  }
  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }
  await stopFeishuWs();
}

async function startFeishuWs(
  channelId: string,
  appId: string,
  appSecret: string,
): Promise<void> {
  // Guard against duplicate starts (store subscription + initial check)
  if (starting || currentChannelId === channelId) return;
  starting = true;
  currentChannelId = channelId;

  useIMChannelStore
    .getState()
    .setChannelStatus(channelId, 'connecting');

  try {
    await invoke('start_feishu_ws', {
      appId,
      appSecret,
    });
    console.log('[FeishuWsManager] WebSocket started for channel', channelId);
  } catch (e) {
    console.error('[FeishuWsManager] Failed to start WebSocket:', e);
    useIMChannelStore
      .getState()
      .setChannelStatus(channelId, 'error', String(e));
  } finally {
    starting = false;
  }
}

async function stopFeishuWs(): Promise<void> {
  if (!currentChannelId) return;

  try {
    await invoke('stop_feishu_ws');
    console.log('[FeishuWsManager] WebSocket stopped');
  } catch (e) {
    console.error('[FeishuWsManager] Failed to stop WebSocket:', e);
  }

  useIMChannelStore
    .getState()
    .setChannelStatus(currentChannelId, 'disconnected');

  currentChannelId = null;
}
