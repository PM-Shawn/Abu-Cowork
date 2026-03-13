/**
 * TraySync — Sync IM channel status to system tray menu
 *
 * Subscribes to imChannelStore changes and calls the Rust
 * update_tray_menu command to keep the tray menu up to date.
 */

import { invoke } from '@tauri-apps/api/core';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { useTriggerStore } from '../../stores/triggerStore';

const PLATFORM_LABELS: Record<string, string> = {
  feishu: '飞书',
  dchat: 'D-Chat',
  dingtalk: '钉钉',
  wecom: '企微',
  slack: 'Slack',
};

interface IMTrayStatus {
  platform: string;
  label: string;
  sessions: number;
}

let unsubIM: (() => void) | null = null;
let unsubTrigger: (() => void) | null = null;

function syncTray() {
  const imState = useIMChannelStore.getState();
  const triggerState = useTriggerStore.getState();

  // Build IM channel entries
  const imChannels: IMTrayStatus[] = [];
  const activeChannels = Object.values(imState.channels).filter((c) => c.enabled);

  for (const ch of activeChannels) {
    const sessions = Object.values(imState.sessions).filter((s) => s.channelId === ch.id);
    const statusDot = ch.status === 'connected' ? '●' : ch.status === 'error' ? '✗' : '○';
    imChannels.push({
      platform: ch.platform,
      label: `${statusDot} ${PLATFORM_LABELS[ch.platform] ?? ch.platform}`,
      sessions: sessions.length,
    });
  }

  // Count active triggers
  const triggerCount = Object.values(triggerState.triggers).filter((t) => t.enabled).length;

  invoke('update_tray_menu', {
    imChannels,
    triggerCount,
  }).catch(() => {
    // Silently ignore — tray might not be available in dev mode
  });
}

/**
 * Start syncing IM/trigger status to system tray.
 * Call once at app startup.
 */
export function startTraySync() {
  // Initial sync
  syncTray();

  // Subscribe to store changes (debounced)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(syncTray, 500);
  };

  unsubIM = useIMChannelStore.subscribe(debouncedSync);
  unsubTrigger = useTriggerStore.subscribe(debouncedSync);
}

/**
 * Stop syncing.
 */
export function stopTraySync() {
  unsubIM?.();
  unsubTrigger?.();
  unsubIM = null;
  unsubTrigger = null;
}
