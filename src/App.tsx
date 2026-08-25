import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from '@/utils/tauriEnv';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { traceErrorBoundaryCatch } from '@/core/observability/runtimeTrace';
import { subscribeShellCrashReports } from '@/core/observability/shellCrashReports';
import Sidebar from '@/components/sidebar/Sidebar';
import ChatView from '@/components/chat/ChatView';
import ImageLightbox from '@/components/chat/ImageLightbox';
import AutomationView from '@/components/automation/AutomationView';
import SystemSettingsDialog from '@/components/settings/SystemSettingsDialog';
import CapabilitySetupDialog from '@/components/settings/CapabilitySetupDialog';
import ToolboxView from '@/components/settings/ToolboxModal';
import TodoView from '@/components/todos/TodoView';
import InboxView from '@/components/inbox/InboxView';
import { useLabsFlag, resolveLabsFlag } from '@/core/labs/resolve';
import { LABS_TODOS_INBOX, LABS_PET } from '@/core/labs/registry';
import { resolvePetBootAction } from '@/core/pet/petBoot';
import { setPetVisible, hidePet } from '@/core/pet/petVisibility';
import RightPanel from '@/components/panel/RightPanel';
import { usePreviewStore } from '@/stores/previewStore';
import { resolveChatWidth, useViewportWidth } from '@/components/panel/panelWidths';
import ToastContainer from '@/components/common/ToastContainer';
import WindowTitleBar from '@/components/window/WindowTitleBar';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { initPlatform } from '@/utils/platform';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { initNetworkProxy } from '@/core/sandbox/config';
import { startSidecar } from '@/core/sidecar/sidecarManager';

// Initialize platform detection at module load time (before any component renders)
// so that isWindows()/isMacOS() return correct values immediately
const platformInitialization = initPlatform().then((detectedPlatform) => {
  // Start network proxy after platform is detected (needs isMacOS())
  initNetworkProxy().catch((err) => {
    console.warn('[App] Network proxy init error:', err);
  });
  // P1-0 sidecar skeleton: fire-and-forget, fail-soft. startSidecar() never
  // throws on its own (see src/core/sidecar/sidecarManager.ts), the .catch
  // here is defense-in-depth so a future change there can't ever surface as
  // an app-startup failure.
  startSidecar().catch((err) => {
    console.warn('[App] Sidecar init error:', err);
  });
  return detectedPlatform;
}).catch((err) => {
  console.warn('[App] Platform detection init error:', err);
  return 'unknown';
});
import { useSettingsStore, bootstrapSecrets } from '@/stores/settingsStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import ConversationSearchModal from '@/components/sidebar/ConversationSearchModal';
import { isMacOS, isWindows } from '@/utils/platform';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { cn } from '@/lib/utils';
import { initNotifications } from '@/utils/notifications';
import { initSidebarBadgeChannel } from '@/stores/noticeBadgeStore';
import { initMenubarChannel } from '@/stores/noticeMenubarStore';
import { initNoticeChannelHandlers } from '@/core/notice/channels';
import { setContextProvider } from '@/core/notice/pipeline';
import { cachedContextProvider, primeContextCaches, assembleGateContext } from '@/core/notice/contextProvider';
import { installNoticeFocusSync } from '@/core/notice/focusSync';
import { drainInbox } from '@/core/notice/inbox';
import { startPetStatusBridge, resyncPetStatus } from '@/core/pet/petStatusBridge';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { imChannelRouter } from '@/core/im/channelRouter';
import { startTraySync, stopTraySync } from '@/core/im/traySync';
import { startInboundDispatcher, stopInboundDispatcher } from '@/core/im/inboundDispatcher';
import { startFeishuWsManager, stopFeishuWsManager } from '@/core/im/feishuWsManager';
import { startWeChatManager, stopWeChatManager } from '@/core/im/wechatConnectionManager';
import { loadIMPlugins } from '@/core/im/pluginLoader';
import { stopAllHeartbeats } from '@/core/im/pluginHeartbeat';
import { reconcileIMSessions } from '@/core/im/sessionReconcile';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { provisionFirstPartyMCPServers } from '@/core/agent/mcpDiscovery';
import {
  initBuiltinBrowserRuntime,
  cleanupBuiltinBrowserRuntime,
} from '@/core/browser/builtinBrowserRuntime';
import { initFileWatchers, stopAllWatchers } from '@/core/agent/fileWatcher';
import { startRegistryWatcher, stopRegistryWatcher } from '@/core/skill/registryWatcher';
import { getPendingWorkspaceRequest, resolveWorkspaceRequest, subscribeToWorkspaceRequest } from '@/core/agent/permissionBridge';
import { startBehaviorSensor, stopBehaviorSensor } from '@/core/agent/behaviorSensor';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useI18n } from '@/i18n';
import CloseDialog from '@/components/common/CloseDialog';
import SensitiveAuditDialog from '@/components/settings/SensitiveAuditDialog';
import { checkForUpdate } from '@/core/updates/checker';
import { usePingCadence } from '@/hooks/usePingCadence';
import { fetchUnseenAnnouncements, markSeen, type AnnouncementItem } from '@/utils/consoleAnnouncement';
import AnnouncementBanner from '@/components/common/AnnouncementBanner';
import DisclaimerBanner from '@/components/common/DisclaimerBanner';
import { pushDiagnosticSnapshot } from '@/utils/consoleDiagnostic';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
// Side-effect import: registers policyEnforcer in the enterprise mounts registry
import '@/core/enterprise/policy/enforcer';  // enforcer.ts — non-JSX, side-effect only
import PolicyConfirmModal from '@/components/enterprise/PolicyConfirmModal';
import BindToEnterpriseFlow from '@/components/enterprise/BindToEnterpriseFlow';
import { useDeepLinkEnroll } from '@/core/enterprise/useDeepLinkEnroll';
import {
  consumeComputerUseResumeToken,
  resumeTokenMatchesTask,
} from '@/core/capabilityPlugins/computerUseResume';
import { restoreComputerUseSetupRequest } from '@/core/capabilityPlugins/setupBridge';
import { checkComputerUsePermissions } from '@/core/agent/computerUsePermission';

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

/**
 * A render crash that reaches the app-root boundary blanks the whole UI, so it
 * gets a runtime-log record. Local only — see traceErrorBoundaryCatch.
 * Module scope keeps the prop reference stable across renders.
 */
function traceAppRootRenderError(error: Error): void {
  traceErrorBoundaryCatch('app_root', error);
}

function App() {
  const [desktopPlatform, setDesktopPlatform] = useState(() => {
    if (isMacOS()) return 'macos';
    if (isWindows()) return 'windows';
    return 'unknown';
  });
  const refreshDiscovery = useDiscoveryStore((s) => s.refresh);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const rightPanelCollapsed = useSettingsStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useSettingsStore((s) => s.toggleRightPanel);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setFileTreeMode = usePreviewStore((s) => s.setFileTreeMode);
  // Preview split (TRAE-style): when the workspace panel has WIDE content
  // (preview/browser/terminal — not the narrow summary tab), the chat column
  // takes a stable, resizable width and the workspace flex-fills the rest.
  const hasAnyTab = usePreviewStore((s) => s.tabs.length > 0);
  const hasWideContent = usePreviewStore((s) => s.tabs.some((t) => t.kind !== 'summary'));
  const chatWidth = usePreviewStore((s) => s.chatWidth);
  const viewportWidth = useViewportWidth();
  const showTodosInbox = useLabsFlag(LABS_TODOS_INBOX);
  const activeConv = useActiveConversation();
  const { t } = useI18n();
  usePingCadence();

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      await platformInitialization;
      const token = consumeComputerUseResumeToken();
      if (!token || cancelled) return;
      const chat = useChatStore.getState();
      if (!(token.conversationId in chat.conversationIndex)) {
        const conversationStorage = await import('@/core/session/conversationStorage');
        await conversationStorage.initConversationStorage();
        const meta = conversationStorage.getIndexEntries()[token.conversationId];
        if (!meta || cancelled) return;
        useChatStore.setState((state) => ({
          conversationIndex: { ...state.conversationIndex, [token.conversationId]: meta },
        }));
      }
      const permissions = await checkComputerUsePermissions();
      if (!permissions || cancelled) return;
      await chat.switchConversation(token.conversationId);
      if (cancelled) return;
      const conversation = useChatStore.getState().conversations[token.conversationId];
      if (!conversation || !await resumeTokenMatchesTask(token, conversation.messages)) return;
      useSettingsStore.getState().setViewMode('chat');
      restoreComputerUseSetupRequest({
        conversationId: token.conversationId,
        taskSummaryHash: token.taskSummaryHash,
        requirements: token.requirements,
      });
    };
    const run = () => void restore();
    if (useChatStore.persist.hasHydrated()) run();
    else {
      const unsubscribe = useChatStore.persist.onFinishHydration(run);
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void platformInitialization.then((platform) => {
      if (active) setDesktopPlatform(platform);
    });
    return () => {
      active = false;
    };
  }, []);

  // If the Todos/Inbox Labs experiment is turned off while the user is parked
  // on one of its views, fall back to chat — otherwise the sidebar nav out of
  // that view disappears with it, stranding the user on an orphaned screen.
  useEffect(() => {
    if (!showTodosInbox && (viewMode === 'todos' || viewMode === 'inbox')) {
      setViewMode('chat');
    }
  }, [showTodosInbox, viewMode, setViewMode]);

  const theme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    // Also drive the NATIVE window theme. On Windows/Linux the OS paints a real
    // title bar whose color follows the window theme (Windows uses DWM immersive
    // dark mode); without this the Windows title bar stays white even when the
    // app is in dark mode. macOS uses an overlay title bar, so this is a harmless
    // no-op there. 'system' → null lets the OS decide.
    const syncNativeTheme = (t: 'light' | 'dark' | null) => {
      if (!isTauriEnv()) return; // web / E2E: no Tauri window API
      getCurrentWindow().setTheme(t).catch(() => {}); // best-effort; never block render
    };
    const apply = (dark: boolean) => {
      root.classList.toggle('dark', dark);
    };
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches);
      syncNativeTheme(null);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      apply(theme === 'dark');
      syncNativeTheme(theme === 'dark' ? 'dark' : 'light');
    }
  }, [theme]);

  // Right panel toggle only when there's an active conversation with messages
  // The overlay panel toggle is now ONLY the "reopen panel" affordance: when the right
  // panel is open it carries its own collapse button in the workspace tab strip, so the
  // overlay would just double it up. Show the overlay only while the panel is collapsed
  // (and there's a conversation to show a panel for).
  const showRightPanelToggle = viewMode === 'chat' && ((activeConv?.messages?.length ?? 0) > 0 || hasAnyTab) && rightPanelCollapsed;
  // Lives in previewStore (not local state) so BrowserTab can hide the native
  // browser webview while the dialog is up — otherwise the webview paints over
  // it and the user cannot see or click the close confirmation.
  const showCloseDialog = usePreviewStore((s) => s.appModalOpen);
  const setShowCloseDialog = usePreviewStore((s) => s.setAppModalOpen);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [pendingAnnouncements, setPendingAnnouncements] = useState<AnnouncementItem[]>([]);
  const { pendingEnroll, dismissEnroll } = useDeepLinkEnroll();
  const hasRunningAgent = useChatStore((s) =>
    Object.values(s.conversations).some((c) => c.status === 'running')
  );

  const handleQuit = useCallback(() => {
    setShowCloseDialog(false);
    invoke('app_exit');
  }, [setShowCloseDialog]);

  const handleMinimize = useCallback(() => {
    setShowCloseDialog(false);
    invoke('window_hide');
  }, [setShowCloseDialog]);

  // Keep notification focus state aligned through both the native Tauri event
  // and the renderer's own focus event. Electron can miss one during startup
  // or reload; either path must still clear stale menubar attention.
  useEffect(() => {
    if (!isTauriEnv()) return; // web / E2E: no Tauri window API
    return installNoticeFocusSync(() => {
      // Re-deliver L2 notices Gate queued while we were fullscreen or
      // unfocused. This stays on the native-focus path to avoid draining the
      // same SQLite row twice when native and DOM focus events arrive together.
      void drainPendingInbox(true);
    });
  }, []);

  // Pet window asks for status resync when it (re)opens
  useEffect(() => {
    if (!isTauriEnv()) return; // web / E2E: no Tauri IPC
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

  // Electron's bundled browser runtime asks the renderer to adopt a new
  // WebContentsView into the normal workspace. Keeping this in the existing
  // BrowserTab UI gives users a visible address bar, history controls, and a
  // close button while the agent operates the page.
  useEffect(() => {
    if (!isTauriEnv()) return;
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen<{ id: string; url: string }>('browser://automation-open', (event) => {
      const { id, url } = event.payload ?? {};
      if (typeof id !== 'string' || !id.startsWith('__abu-browser-automation__')) return;
      usePreviewStore.getState().openBrowser(typeof url === 'string' ? url : 'about:blank', id);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Pet window sends a message to the currently active conversation
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen('pet-send-message', (event) => {
      const { text, conversationId } = event.payload as { text: string; conversationId?: string | null };
      const store = useChatStore.getState();
      // A waiting-state inline reply targets the conversation the notice
      // pointed at; a plain quick message falls back to the active one.
      const convId =
        (conversationId && store.conversations[conversationId] ? conversationId : null) ??
        store.activeConversationId ??
        store.createConversation(null);
      runAgentLoopDispatched(convId, text).catch((err) => {
        console.warn('[pet-send-message] runAgentLoopDispatched error:', err);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Pet window notifies the main window when its own open state changes
  // (e.g. user closes it via the pet's right-click menu), so the Settings
  // toggle stays in sync without needing a reload.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen('pet-open-state-changed', (event) => {
      const { open } = event.payload as { open: boolean };
      useSettingsStore.getState().setPetOpen(open);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Severe shell crashes (main-process exception, renderer death) are recorded
  // locally by the main process; the renderer owns the telemetry opt-out, so it
  // is the tier that decides whether they may also be reported remotely.
  useEffect(() => {
    if (!isTauriEnv()) return; // web / E2E: no Tauri IPC
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    subscribeShellCrashReports().then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    }).catch(() => {
      // Observability is best-effort and must never block app startup.
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // Listen for window close-requested event from Rust
  useEffect(() => {
    if (!isTauriEnv()) return; // web / E2E: no Tauri IPC
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
  }, [setShowCloseDialog]);

  useEffect(() => {
    registerBuiltinTools();
    refreshDiscovery();
    provisionFirstPartyMCPServers();
    initMCPStoreSync();
    initBuiltinBrowserRuntime();

    // Hydrate API keys from the encrypted secret store. During Phase 2 the
    // plaintext apiKey is still persisted via localStorage as a fallback,
    // so a transient failure here is logged but non-fatal.
    bootstrapSecrets().catch((err) => {
      console.warn('[App] Secret bootstrap error:', err);
    });

    // Restore sleep prevention preference. caffeinate dies with the process,
    // so we re-enable it on every launch if the user had it turned on.
    if (useSettingsStore.getState().preventSleep) {
      invoke('set_prevent_sleep', { enabled: true }).catch((err) => {
        console.warn('[App] Failed to restore sleep prevention:', err);
      });
    }

    // Restore (or force-hide) the desktop pet on startup based on the pet Labs
    // unlock flag + persisted petOpen intent. A pet that is no longer unlocked
    // but left petOpen=true must never resurface.
    {
      const s = useSettingsStore.getState();
      const petUnlocked = resolveLabsFlag(LABS_PET, s.labs);
      const action = resolvePetBootAction(petUnlocked, s.petOpen);
      if (action === 'show') {
        void setPetVisible(true);
      } else if (action === 'hide') {
        void hidePet();
        s.setPetOpen(false);
      }
    }

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

    // Watch ~/.abu/skills and ~/.abu/agents so items dropped straight into those
    // folders appear live (no restart needed). Self-contained + best-effort.
    startRegistryWatcher().catch((err) => {
      console.warn('[App] Registry watcher init error:', err);
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
      void cleanupBuiltinBrowserRuntime();
      cleanupMCPStoreSync();
      stopAllWatchers();
      stopRegistryWatcher();
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
      // Migrate old memory systems (entries.json / memory.md) to memdir (.md files),
      // then run the one-shot secret sweep over existing memories — global dir,
      // current workspace dir, and every workspace opened later (marker-gated
      // per directory, so repeat calls cost one exists() check; new writes are
      // sanitized at the writeMemory funnel). Fire-and-forget: a turn sent in
      // the first seconds after launch may still see pre-sweep bytes — accepted
      // one-shot race; blocking startup on the sweep would be worse.
      import('@/core/memdir/migrate').then(m => m.migrateMemdirIfNeeded())
        .then(async () => {
          const { sweepMemorySecrets } = await import('@/core/memdir/secretSweep');
          const { useWorkspaceStore } = await import('@/stores/workspaceStore');
          await sweepMemorySecrets(null);
          const current = useWorkspaceStore.getState().currentPath;
          if (current) await sweepMemorySecrets(current);
          useWorkspaceStore.subscribe((state, prev) => {
            if (state.currentPath && state.currentPath !== prev.currentPath) {
              void sweepMemorySecrets(state.currentPath);
            }
          });
        })
        .catch(() => {});
      // Initialize conversation storage before checking crash checkpoints.
      // Otherwise the checkpoint scan can beat the async Zustand index
      // rehydrate, mistake a valid conversation for a missing one, and delete
      // the only recovery hint.
      const conversationStorage = await import('@/core/session/conversationStorage').catch(() => null);
      if (conversationStorage) {
        await conversationStorage.initConversationStorage().catch(() => {});
        // Reconcile the SQLite conversation catalog against JSONL on disk
        // (message-storage P0): first run does the full scan-build migration,
        // later runs do incremental repair. Fire-and-forget — catalog is a
        // rebuildable projection, JSONL stays the source of truth.
        conversationStorage.reconcileCatalog().catch(() => {});
      }
      import('@/core/session/checkpoint').then(async ({ findOrphanedCheckpoints, clearCheckpoint }) => {
        const orphans = await findOrphanedCheckpoints();
        if (orphans.length === 0) return;
        const { useChatStore } = await import('@/stores/chatStore');
        for (const cp of orphans) {
          const storeState = useChatStore.getState();
          const meta = storeState.conversationIndex[cp.conversationId]
            ?? conversationStorage?.getIndexEntries()[cp.conversationId];
          if (!meta) { await clearCheckpoint(cp.conversationId); continue; }
          if (!storeState.conversationIndex[cp.conversationId]) {
            useChatStore.setState({
              conversationIndex: {
                ...storeState.conversationIndex,
                [cp.conversationId]: meta,
              },
            });
          }
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
            isRecoveryNotice: true,
          });
          await clearCheckpoint(cp.conversationId);
          // Do NOT auto-navigate — app always starts on welcome screen.
          // The recovery message is visible when user clicks the conversation in sidebar.
        }
      }).catch(() => {});
      startInboundDispatcher();
      startTraySync();
      startFeishuWsManager();
      startWeChatManager();
    };
    init();
    return () => {
      schedulerEngine.stop();
      triggerEngine.stop();
      imChannelRouter.stop();
      stopInboundDispatcher();
      stopTraySync();
      stopFeishuWsManager();
      stopWeChatManager();
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

  // Cloud announcements: poll on startup (60s delay) + every 6h.
  // Shows unseen announcements as a dismissible banner.
  useEffect(() => {
    const run = async () => {
      const items = await fetchUnseenAnnouncements();
      if (items.length > 0) setPendingAnnouncements(items);
    };

    const startupTimer = setTimeout(() => { void run() }, 60_000);
    const pollTimer = setInterval(() => { void run() }, 6 * 60 * 60 * 1000);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(pollTimer);
    };
  }, []);

  // Diagnostic snapshot push — two triggers:
  // 1. Startup (90s): push last persisted snapshot so Console always has fresh data.
  // 2. Store subscription: push whenever a fresh runAll() completes (isChecking true→false).
  useEffect(() => {
    const startupTimer = setTimeout(pushDiagnosticSnapshot, 90_000);

    let wasChecking = false;
    const unsub = useDiagnosticStore.subscribe((state) => {
      if (wasChecking && !state.isChecking && state.lastCheckedAt !== null) {
        pushDiagnosticSnapshot();
      }
      wasChecking = state.isChecking;
    });

    return () => {
      clearTimeout(startupTimer);
      unsub();
    };
  }, []);

  // Enterprise mode: load persisted binding from AppData at startup.
  // If bound, start the background heartbeat (protocol layer) and mount
  // all enterprise business modules via the @enterprise-modules alias.
  //
  // In OSS builds, @enterprise-modules resolves to enterprise-modules-stub
  // (noop). In Enterprise builds, it resolves to ../Abu-enterprise-modules/src
  // which side-effect-registers KB / Skill / MCP / Me / Migration panels.
  useEffect(() => {
    let cancel = false
    ;(async () => {
      await useEnterpriseStore.getState().init().catch(e => console.warn('[enterprise] init failed', e))
      if (cancel) return
      if (useEnterpriseStore.getState().mode.kind !== 'personal') {
        const { activateEnterpriseRuntime } = await import('@/core/enterprise/runtime')
        await activateEnterpriseRuntime()
      }
    })()
    return () => { cancel = true }
  }, [])

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
    if (desktopPlatform === 'unknown') return;
    if (!isTauriEnv()) return; // web / E2E: no Tauri window API
    getCurrentWindow().setTitle(desktopPlatform === 'macos' ? '' : 'Abu');
  }, [desktopPlatform]);

  // macOS keeps its compact controls in a fixed overlay. Electron Windows uses
  // the native caption row plus controls embedded into the workspace headers.
  const mac = desktopPlatform === 'macos';
  const windowsWorkspaceHeader =
    desktopPlatform === 'windows' && hasElectronCommandHost();

  // Preview split is active only when a preview is open in the chat view AND the
  // right panel is showing — then the chat holds a stable width and preview flex-fills.
  // Chat takes a fixed width only when the preview is actually shown (preview tab active);
  // on the summary tab the chat flex-fills and the panel is a fixed details column.
  const previewSplit = viewMode === 'chat' && hasWideContent && !rightPanelCollapsed;
  const previewChatWidth = resolveChatWidth(chatWidth, viewportWidth, !sidebarCollapsed);
  // Whether the right panel actually sits BESIDE the chat (either tab) — mirrors
  // RightPanel's own render gate. Drives the chat's right margin: a tight 4px
  // gutter between the two cards, vs 8px to the window edge when chat is alone.
  const rightPanelBeside =
    viewMode === 'chat' &&
    !rightPanelCollapsed &&
    (((activeConv?.messages?.length ?? 0) > 0) || hasAnyTab);

  const windowTitleBarProps = {
    platform: desktopPlatform,
    windowsTitleBarOverlay: windowsWorkspaceHeader,
    sidebarCollapsed,
    showSearch: viewMode !== 'settings',
    showNewTask: sidebarCollapsed && viewMode !== 'settings',
    showRightPanelToggle,
    rightPanelCollapsed,
    onToggleSidebar: toggleSidebar,
    onOpenSearch: () => setSearchModalOpen(true),
    onNewTask: () => {
      startNewConversation();
      setViewMode('chat');
      setFileTreeMode(false);
    },
    onToggleRightPanel: toggleRightPanel,
    onOpenWindowMenu: (
      group: 'edit' | 'window' | 'help',
      anchor: { x: number; y: number },
    ) => invoke('window_titlebar_menu', { group, ...anchor }),
    labels: {
      appName: 'Abu',
      editMenu: t.sidebar.editMenu,
      windowMenu: t.sidebar.windowMenu,
      helpMenu: t.sidebar.helpMenu,
      showSidebar: t.sidebar.showSidebar,
      hideSidebar: t.sidebar.hideSidebar,
      search: t.sidebar.searchPlaceholder,
      newTask: t.sidebar.newTask,
      showPanel: t.panel.showPanel,
      hidePanel: t.panel.hidePanel,
    },
  };

  return (
    <ErrorBoundary onError={traceAppRootRenderError}>
    <TooltipProvider delayDuration={200}>
      <div
        data-abu-app-shell
        className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--abu-bg-canvas)]"
      >
        {/* Chromium builds the OS drag region by walking the layout tree in
            DOCUMENT order, unioning `drag` rects and subtracting `no-drag`
            ones — stacking order does not decide the winner, the LAST writer
            does. macOS renders its chrome as `fixed` overlays, so the controls
            must come after the cards or a card's own drag row (see
            `windowDragRowProps`) unions straight back over them and the
            buttons stop responding. Windows/Linux keep their chrome rows in
            normal flow, where moving them would move them visually. */}
        {!mac && <WindowTitleBar {...windowTitleBarProps} />}

        <div
          data-abu-app-layout
          className="flex min-h-0 w-full flex-1 overflow-hidden bg-[var(--abu-bg-canvas)]"
        >
          {/* Sidebar - width changes are always instant (no slide animation). */}
          <div
            className="flex shrink-0 flex-col overflow-hidden"
            style={{
              width: sidebarCollapsed ? 0 : 260,
            }}
          >
            <div className="min-h-0 flex-1">
              <Sidebar windowsWorkspaceHeader={windowsWorkspaceHeader} />
            </div>
          </div>

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Only the exposed canvas gutters are draggable. The raised cards
                explicitly carve out stable no-drag interaction surfaces. */}
            <div
              data-abu-panel-container
              data-tauri-drag-region={mac ? '' : undefined}
              className="flex min-h-0 flex-1"
            >
              <main
                data-electron-no-drag
                className={cn(
                  'relative bg-[var(--abu-bg-base)]',
                  'mt-2 mb-2 ml-2 rounded-[var(--abu-radius-panel)] border border-[var(--abu-border)] shadow-[var(--abu-shadow-card)] overflow-hidden',
                  previewSplit ? 'shrink-0' : 'flex-1 min-w-0',
                  // Right panel beside chat (preview OR summary): tighter 4px gutter; otherwise 8px to the window edge.
                  rightPanelBeside ? 'mr-1' : 'mr-2',
                )}
                style={previewSplit ? { width: previewChatWidth } : undefined}
              >
                {viewMode === 'automation' && <AutomationView />}
                {viewMode === 'toolbox' && <ToolboxView />}
                {viewMode === 'todos' && <TodoView />}
                {viewMode === 'inbox' && <InboxView />}
                {(viewMode === 'chat' || !viewMode) && (
                  <ChatView
                    windowsWorkspaceHeader={windowsWorkspaceHeader}
                    rightPanelToggleVisible={showRightPanelToggle}
                  />
                )}
              </main>

              {/* Right panel */}
              <RightPanel />
            </div>
          </div>
        </div>

        {mac && <WindowTitleBar {...windowTitleBarProps} />}

        <ToastContainer />

        <ImageLightbox />

        <ConversationSearchModal open={searchModalOpen} onClose={() => setSearchModalOpen(false)} />

        {/* System settings — overlay dialog, self-gates on systemSettingsOpen */}
        <SystemSettingsDialog />

        {/* Task-local capability setup — suspends the exact requesting tool call. */}
        <CapabilitySetupDialog />

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

        {/* First-launch disclaimer banner — shows once until dismissed.
            Self-gates on hasAcknowledgedDisclaimer in settingsStore. */}
        <DisclaimerBanner />

        {/* Enterprise policy confirmation modal (z-[60], above all overlays).
            Only appears when the tool dispatcher detects a require_confirmation policy. */}
        <PolicyConfirmModal />

        {/* Cloud announcement banner — shows the first unseen announcement */}
        {pendingAnnouncements.length > 0 && pendingAnnouncements[0] && (
          <AnnouncementBanner
            item={pendingAnnouncements[0]}
            onDismiss={() => {
              const id = pendingAnnouncements[0]?.id;
              if (id != null) markSeen(id);
              setPendingAnnouncements((prev) => prev.slice(1));
            }}
          />
        )}

        {/* Deep-link enrollment: show BindToEnterpriseFlow pre-seeded with serverUrl
            when the app is opened via abu://enroll?server=<URL>&token=<token>.
            Renders above all other overlays (z-50 inside BindToEnterpriseFlow). */}
        {pendingEnroll && (
          <BindToEnterpriseFlow
            initialServerUrl={pendingEnroll.serverUrl}
            onDone={dismissEnroll}
            onCancel={dismissEnroll}
          />
        )}
      </div>
    </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
