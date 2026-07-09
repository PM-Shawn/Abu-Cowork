/**
 * Notice channel handlers — concrete delivery implementations.
 *
 * Each handler is registered via `registerChannel(name, fn)` from
 * pipeline.ts. This file collects all channel handler init functions
 * in one place; App.tsx calls `initAllNoticeChannels()` at startup.
 *
 * Channel handlers are responsible for the actual side effects:
 * - system_notification: sends OS notification via Tauri plugin
 * - main_window_toast: emits Tauri event for in-app toast (Week 2+)
 *
 * sidebar_badge and menubar have their own stores (noticeBadgeStore,
 * noticeMenubarStore) that register themselves.
 */

import {
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isMacOS } from '@/utils/platform';
import { registerChannel } from './pipeline';
import type { Notice } from './types';
import { getI18n } from '@/i18n';

// ── State ──────────────────────────────────────────────────────────────

let notificationPermission = false;
let unreadCount = 0;

/** Initialize notification permission state. Called by initNotifications in App. */
export function setNotificationPermission(granted: boolean): void {
  notificationPermission = granted;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getTitle(notice: Notice): string {
  const n = getI18n().noticeTitle;
  const noticeTitle: Record<string, string> = {
    task_complete: n.taskComplete,
    agent_error: n.agentError,
    schedule_fired: n.scheduleFired,
    permission_request: n.permissionRequest,
    user_input_needed: n.userInputNeeded,
    meeting_prep: n.meetingPrep,
    skill_proposal_offer: n.skillProposalOffer,
    skill_draft_ready: n.skillDraftReady,
    im_inbound: n.imInbound,
    update_available: n.updateAvailable,
  };
  return noticeTitle[notice.type] ?? 'Abu';
}

function getBody(notice: Notice): string {
  const payload = notice.payload;
  if (payload.title && typeof payload.title === 'string') {
    return `「${payload.title}」`;
  }
  if (payload.conversationTitle && typeof payload.conversationTitle === 'string') {
    return `「${payload.conversationTitle}」`;
  }
  if (payload.name && typeof payload.name === 'string') {
    return `「${payload.name}」`;
  }
  return '';
}

async function bumpDockBadge(): Promise<void> {
  if (!isMacOS()) return;
  try {
    unreadCount += 1;
    await getCurrentWindow().setBadgeCount(unreadCount);
  } catch {
    // Non-critical
  }
}

/** Clear dock badge. Re-exported for App focus handler. */
export async function clearDockBadgeCount(): Promise<void> {
  if (unreadCount === 0) return;
  if (!isMacOS()) return;
  try {
    unreadCount = 0;
    await getCurrentWindow().setBadgeCount(undefined);
  } catch {
    // Non-critical
  }
}

// ── Channel handlers ───────────────────────────────────────────────────

function handleSystemNotification(notice: Notice): void {
  if (!notificationPermission) return;

  const title = getTitle(notice);
  const body = getBody(notice);

  try {
    sendNotification({ title, body });
  } catch {
    // Permission might have been revoked
  }

  bumpDockBadge();
}

function handleMainWindowToast(notice: Notice): void {
  // Emit a Tauri event that a toast component can subscribe to.
  // Week 2+ will add the in-app toast UI component.
  getCurrentWindow()
    .emit('notice-toast', {
      id: notice.id,
      type: notice.type,
      tier: notice.tier,
      title: getTitle(notice),
      body: getBody(notice),
    })
    .catch(() => {});
}

// ── Registration ───────────────────────────────────────────────────────

let registered = false;

/**
 * Register system_notification and main_window_toast channel handlers.
 * Call once at app startup. Idempotent.
 */
export function initNoticeChannelHandlers(): void {
  if (registered) return;
  registered = true;

  registerChannel('system_notification', handleSystemNotification);
  registerChannel('main_window_toast', handleMainWindowToast);
}
