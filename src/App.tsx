import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { invoke } from '@tauri-apps/api/core';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import Sidebar from '@/components/sidebar/Sidebar';
import ChatView from '@/components/chat/ChatView';
import AutomationView from '@/components/automation/AutomationView';
import SystemSettingsView from '@/components/settings/SystemSettingsModal';
import ToolboxView from '@/components/settings/ToolboxModal';
import RightPanel from '@/components/panel/RightPanel';
import ToastContainer from '@/components/common/ToastContainer';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { installLargeWriteGuard } from '@/core/agent/hooks/largeWriteGuard';
import { initPlatform } from '@/utils/platform';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { initNetworkProxy } from '@/core/sandbox/config';

// Initialize platform detection at module load time (before any component renders)
// so that isWindows()/isMacOS() return correct values immediately
initPlatform().then(() => {
  // Start network proxy after platform is detected (needs isMacOS())
  initNetworkProxy().catch((err) => {
    console.warn('[App] Network proxy init error:', err);
  });
}).catch((err) => {
  console.warn('[App] Platform detection init error:', err);
});
import { useSettingsStore, bootstrapSecrets } from '@/stores/settingsStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PanelLeft, PanelRight, ArrowLeft } from 'lucide-react';
import { isMacOS } from '@/utils/platform';
import { cn } from '@/lib/utils';
import { initNotifications, clearDockBadge } from '@/utils/notifications';
import { initSidebarBadgeChannel } from '@/stores/noticeBadgeStore';
import { initMenubarChannel, useNoticeMenubarStore } from '@/stores/noticeMenubarStore';
import { initNoticeChannelHandlers } from '@/core/notice/channels';
import { setContextProvider } from '@/core/notice/pipeline';
import { cachedContextProvider, primeContextCaches, assembleGateContext, setFocused } from '@/core/notice/contextProvider';
import { drainInbox } from '@/core/notice/inbox';
import { startPetStatusBridge, resyncPetStatus } from '@/core/pet/petStatusBridge';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { imChannelRouter } from '@/core/im/channelRouter';
import { startTraySync, stopTraySync } from '@/core/im/traySync';
import { startInboundDispatcher, stopInboundDispatcher } from '@/core/im/inboundDispatcher';
import { startFeishuWsManager, stopFeishuWsManager } from '@/core/im/feishuWsManager';
import { loadIMPlugins } from '@/core/im/pluginLoader';
import { stopAllHeartbeats } from '@/core/im/pluginHeartbeat';
import { reconcileIMSessions } from '@/core/im/sessionReconcile';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { initFileWatchers, stopAllWatchers } from '@/core/agent/fileWatcher';
import { getPendingWorkspaceRequest, resolveWorkspaceRequest, subscribeToWorkspaceRequest } from '@/core/agent/permissionBridge';
import { startBehaviorSensor, stopBehaviorSensor } from '@/core/agent/behaviorSensor';
import { useI18n } from '@/i18n';
import CloseDialog from '@/components/common/CloseDialog';
import SensitiveAuditDialog from '@/components/settings/SensitiveAuditDialog';
import { checkForUpdate } from '@/core/updates/checker';

/**
 * Drain Notice inbox if we're in a state that can actually deliver.
 * Runs at boot + on every window refocus — a no-op if the queue is
 * empty or the user is still in a fullscreen app (defer until next
 * focus event). Fire-and-forget; all failures are non-fatal.
 *
 * When abuIsFocused=true (called from the focus event), Abu is definitely
 * the foreground window, so no fullscreen app can be blocking — skip the
 * shell-based fullscreen check entirely (avoids spawning PowerShell on Windows).
 */
async function drainPendingInbox(abuIsFocused = false): Promise<void> {
  try {
    if (abuIsFocused) {
      const ctx = { ...cachedContextProvider(Date.now()), mainWindowFocused: true, fullscreenApp: null };
      await drainInbox(ctx);
      return;
    }
    const ctx = await assembleGateContext(Date.now());
    if (ctx.fullscreenApp) return;
    await drainInbox(ctx);
  } catch (err) {
    console.warn('[App] Notice inbox drain error:', err);
  }
}

function App() {
  const refreshDiscovery = useDiscoveryStore((s) => s.refresh);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const rightPanelCollapsed = useSettingsStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useSettingsStore((s) => s.toggleRightPanel);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeSystemSettings = useSettingsStore((s) => s.closeSystemSettings);
  const closeAutomation = useSettingsStore((s) => s.closeAutomation);
  const closeToolbox = useSettingsStore((s) => s.closeToolbox);
  const activeConv = useActiveConversation();
  const { t } = useI18n();

  // Right panel toggle only when there's an active conversation with messages
  const showRightPanelToggle = viewMode === 'chat' && (activeConv?.messages?.length ?? 0) > 0;
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const hasRunningAgent = useChatStore((s) =>
    Object.values(s.conversations).some((c) => c.status === 'running')
  );

  const handleQuit = useCallback(() => {
    setShowCloseDialog(false);
    invoke('app_exit');
  }, []);

  const handleMinimize = useCallback(() => {
    setShowCloseDialog(false);
    invoke('window_hide');
  }, []);

  // Clear dock badge whenever the window regains focus
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        setFocused(focused);
        if (focused) {
          clearDockBadge();
          useNoticeMenubarStore.getState().dismissAll();
          // Re-deliver L2 notices Gate queued while we were
          // fullscreen / unfocused. Phase-2 main-window-toast will
          // aggregate these; for v0.13.0 they just flow back through
          // sidebar_badge / menubar so the user isn't left unaware.
          void drainPendingInbox(true);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFn = fn;
      });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Pet window asks for status resync when it (re)opens
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen('pet-resync-request', () => {
      resyncPetStatus();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Listen for window close-requested event from Rust
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen('close-requested', () => {
      const action = useSettingsStore.getState().closeAction;
      if (action === 'quit') {
        invoke('app_exit');
      } else if (action === 'minimize') {
        invoke('window_hide');
      } else {
        setShowCloseDialog(true);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  useEffect(() => {
    registerBuiltinTools();
    installLargeWriteGuard();
    refreshDiscovery();
    initMCPStoreSync();

    // Hydrate API keys from the encrypted secret store. During Phase 2 the
    // plaintext apiKey is still persisted via localStorage as a fallback,
    // so a transient failure here is logged but non-fatal.
    bootstrapSecrets().catch((err) => {
      console.warn('[App] Secret bootstrap error:', err);
    });

    // Initialize notifications with logging
    initNotifications().then((granted) => {
      console.log('[App] Notification permission initialized:', granted);
    }).catch((err) => {
      console.error('[App] Notification init error:', err);
    });

    // Register Notice System channel handlers + wire real context
    setContextProvider(cachedContextProvider);
    initSidebarBadgeChannel();
    initMenubarChannel();
    initNoticeChannelHandlers();
    primeContextCaches()
      .then(() => drainPendingInbox())
      .catch(() => {});

    // Pet status bridge: aggregate chatStore conversation statuses and
    // push to pet window via Tauri event. Idempotent.
    startPetStatusBridge();

    // Initialize file watchers
    initFileWatchers().catch((err) => {
      console.warn('[App] File watcher init error:', err);
    });

    // Skill drafts: boot-time refresh + hourly TTL sweeper (workspace-switch
    // refresh is already wired in skillDraftsStore). startDraftsSweeper is
    // idempotent.
    import('@/stores/skillDraftsStore').then(({ useSkillDraftsStore, startDraftsSweeper }) => {
      void useSkillDraftsStore.getState().refresh();
      void useSkillDraftsStore.getState().cleanExpired();
      void useSkillDraftsStore.getState().cleanTrash();
      startDraftsSweeper();
    }).catch((err) => {
      console.warn('[App] Drafts store init error:', err);
    });

    // One-shot backfill: older conversations bound to a workspace that now
    // has a project fall through createConversation's auto-associate hook
    // (which only fires at creation time) and CreateProjectDialog's
    // per-project backfill (which only sees the conversations matching at
    // the moment the project is created). This pass catches the "I chatted
    // in this folder last week, made the project today" case. Idempotent.
    import('@/utils/projectMigration').then(({ backfillProjectIds }) => {
      const n = backfillProjectIds();
      if (n > 0) console.log(`[App] Backfilled projectId for ${n} conversation(s)`);
    }).catch((err) => {
      console.warn('[App] Project backfill error:', err);
    });

    return () => {
      cleanupMCPStoreSync();
      stopAllWatchers();
      import('@/stores/skillDraftsStore').then(({ stopDraftsSweeper }) => stopDraftsSweeper()).catch(() => {});
    };
  }, [refreshDiscovery]);

  // Start scheduler engine and trigger engine
  // Plugins must load BEFORE triggerEngine so the HTTP server knows to bind 0.0.0.0
  useEffect(() => {
    const init = async () => {
      // Load IM plugins first — determines whether trigger server binds LAN or localhost
      await loadIMPlugins().catch((err) => console.warn('[App] IM plugin loading failed:', err));

      schedulerEngine.start();
      triggerEngine.start();
      imChannelRouter.start();
      reconcileIMSessions();
      // Migrate old memory systems (entries.json / memory.md) to memdir (.md files)
      import('@/core/memdir/migrate').then(m => m.migrateMemdirIfNeeded()).catch(() => {});
      // Initialize conversation file storage and check for crash recovery
      import('@/core/session/conversationStorage').then(m => m.initConversationStorage()).catch(() => {});
      import('@/core/session/checkpoint').then(async ({ findOrphanedCheckpoints, clearCheckpoint }) => {
        const orphans = await findOrphanedCheckpoints();
        if (orphans.length === 0) return;
        const { useChatStore } = await import('@/stores/chatStore');
        for (const cp of orphans) {
          const meta = useChatStore.getState().conversationIndex[cp.conversationId];
          if (!meta) { await clearCheckpoint(cp.conversationId); continue; }
          // Load conversation from disk so messages are available
          await useChatStore.getState().loadConversation(cp.conversationId);
          // Add a system message indicating the interruption
          const statusText = cp.status === 'tool_executing'
            ? `执行工具时中断` : `等待模型响应时中断`;
          useChatStore.getState().addMessage(cp.conversationId, {
            id: `recovery-${Date.now().toString(36)}`,
            role: 'assistant',
            content: `⚠️ 上次对话在第 ${cp.turnCount} 轮${statusText}。你可以继续发送消息恢复工作。`,
            timestamp: Date.now(),
            isSystem: true,
          });
          await clearCheckpoint(cp.conversationId);
          // Do NOT auto-navigate — app always starts on welcome screen.
          // The recovery message is visible when user clicks the conversation in sidebar.
        }
      }).catch(() => {});
      startInboundDispatcher();
      startTraySync();
      startFeishuWsManager();
    };
    init();
    return () => {
      schedulerEngine.stop();
      triggerEngine.stop();
      imChannelRouter.stop();
      stopInboundDispatcher();
      stopTraySync();
      stopFeishuWsManager();
      stopAllHeartbeats();
      import('@/core/session/conversationStorage').then(m => m.shutdownConversationStorage()).catch(() => {});
    };
  }, []);

  // Behavior sensor — controlled by setting
  const behaviorSensorEnabled = useSettingsStore((s) => s.behaviorSensorEnabled);
  useEffect(() => {
    if (behaviorSensorEnabled) {
      startBehaviorSensor();
    } else {
      stopBehaviorSensor();
    }
    return () => stopBehaviorSensor();
  }, [behaviorSensorEnabled]);

  // Auto-drain workspace requests that can never be shown to the user.
  // This happens when: (1) a trigger/background task calls request_workspace but the
  // conversation is not active, or (2) the user navigates away from the chat view.
  // Without this, the agent loop Promise hangs forever showing "执行中...".
  const pendingWsReq = useSyncExternalStore(subscribeToWorkspaceRequest, getPendingWorkspaceRequest);
  const activeConvIdForDrain = activeConv?.id ?? null;
  useEffect(() => {
    if (pendingWsReq && pendingWsReq.conversationId !== activeConvIdForDrain) {
      // Request belongs to a non-visible conversation — auto-cancel so agent loop can proceed
      resolveWorkspaceRequest(null);
    }
  }, [pendingWsReq, activeConvIdForDrain]);

  // Update checks: delayed startup check (avoid launch contention) +
  // 6h background poll (reach users who keep app running for days).
  // checker.ts has a 6h throttle, so overlapping calls won't duplicate requests.
  useEffect(() => {
    const run = () =>
      void checkForUpdate().catch((err) => {
        console.warn('[App] Update check error:', err);
      });

    const startupTimer = setTimeout(run, 30_000);
    const pollTimer = setInterval(run, 6 * 60 * 60 * 1000);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(pollTimer);
    };
  }, []);

  // Catch unhandled rejections from Tauri plugin resource cleanup
  // (e.g., plugin-http fetch to unreachable URLs, plugin-fs watch on deleted paths)
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = String(e.reason);
      if (msg.includes('resource id') && msg.includes('is invalid')) {
        console.warn('[App] Suppressed Tauri resource cleanup error:', msg);
        e.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);

  // Hide native title bar text on macOS (overlay mode — title shown in sidebar instead)
  // On Windows, show app name in native title bar
  useEffect(() => {
    getCurrentWindow().setTitle(isMacOS() ? '' : 'Abu');
  }, []);

  // macOS uses overlay title bar (content behind traffic lights); Windows uses native title bar
  const mac = isMacOS();

  return (
    <ErrorBoundary>
    <TooltipProvider delayDuration={200}>
      {/* Title bar drag region — only needed on macOS where we use overlay title bar */}
      {mac && (
        <div
          data-tauri-drag-region
          className="fixed top-0 left-0 right-0 h-11 z-40"
        />
      )}

      {/* Sidebar & panel toggle buttons — positioned in title bar area on macOS, top bar on Windows */}
      <div className={cn('fixed left-0 right-0 z-40 pointer-events-none', mac ? 'top-0 h-11' : 'top-0 h-8')}>
        {viewMode === 'settings' || viewMode === 'automation' || viewMode === 'toolbox' ? (
          <button
            onClick={
              viewMode === 'settings' ? closeSystemSettings
              : viewMode === 'automation' ? closeAutomation
              : closeToolbox
            }
            className="absolute flex items-center gap-1.5 btn-ghost px-2 py-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md pointer-events-auto text-sm"
            style={{ top: mac ? 8 : 4, left: mac ? 80 : 8 }}
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>
              {viewMode === 'settings' ? t.settings.title
               : viewMode === 'automation' ? t.sidebar.automation
               : t.sidebar.toolbox}
            </span>
          </button>
        ) : (
          <button
            onClick={toggleSidebar}
            className="absolute btn-ghost p-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md transition-[left] duration-200 pointer-events-auto"
            style={{ top: mac ? 8 : 4, left: sidebarCollapsed ? 96 : 232 }}
            title={sidebarCollapsed ? t.sidebar.showSidebar : t.sidebar.hideSidebar}
          >
            <PanelLeft className="h-3.5 w-[18px]" strokeWidth={1.5} />
          </button>
        )}

        {showRightPanelToggle && (
          <button
            onClick={toggleRightPanel}
            className="absolute right-2 btn-ghost p-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md pointer-events-auto"
            style={{ top: mac ? 8 : 4 }}
            title={rightPanelCollapsed ? t.panel.showPanel : t.panel.hidePanel}
          >
            <PanelRight className="h-3.5 w-[18px]" strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div className="flex h-full w-full">
        {/* Sidebar - width changes are always instant (no slide animation) */}
        <div
          className="shrink-0 overflow-hidden"
          style={{
            width: (sidebarCollapsed || viewMode === 'settings' || viewMode === 'automation' || viewMode === 'toolbox') ? 0 : 260,
          }}
        >
          <Sidebar />
        </div>

        {/* Main — pt-7 on macOS to clear overlay title bar; no padding on Windows (native title bar) */}
        <main className={cn('flex-1 min-w-0 bg-[var(--abu-bg-base)]', mac ? 'pt-11' : 'pt-8')}>
          {viewMode === 'automation' && <AutomationView />}
          {viewMode === 'toolbox' && <ToolboxView />}
          {viewMode === 'settings' && <SystemSettingsView />}
          {(viewMode === 'chat' || !viewMode) && <ChatView />}
        </main>

        {/* Right panel */}
        <RightPanel />

        <ToastContainer />

        <CloseDialog
          open={showCloseDialog}
          hasRunningAgent={hasRunningAgent}
          onQuit={handleQuit}
          onMinimize={handleMinimize}
          onCancel={() => setShowCloseDialog(false)}
          onCloseActionChange={useSettingsStore.getState().setCloseAction}
        />

        {/* v0.15 one-shot onboarding: scan existing memories for sensitive
            content and offer to mark them private. Self-gates on the
            hasRunSensitiveAudit_v015 settings flag. */}
        <SensitiveAuditDialog />
      </div>
    </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
