import { useEffect, useState, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { invoke } from '@tauri-apps/api/core';
import Sidebar from '@/components/sidebar/Sidebar';
import ChatView from '@/components/chat/ChatView';
import ScheduleView from '@/components/schedule/ScheduleView';
import TriggerView from '@/components/trigger/TriggerView';
import SystemSettingsView from '@/components/settings/SystemSettingsModal';
import ToolboxView from '@/components/settings/ToolboxModal';
import RightPanel from '@/components/panel/RightPanel';
import ToastContainer from '@/components/common/ToastContainer';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { initPlatform } from '@/utils/platform';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useActiveConversation } from '@/stores/chatStore';
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
import { useSettingsStore } from '@/stores/settingsStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { isMacOS } from '@/utils/platform';
import { cn } from '@/lib/utils';
import { initNotifications } from '@/utils/notifications';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { imChannelRouter } from '@/core/im/channelRouter';
import { startTraySync, stopTraySync } from '@/core/im/traySync';
import { startFeishuWsManager, stopFeishuWsManager } from '@/core/im/feishuWsManager';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { initFileWatchers, stopAllWatchers } from '@/core/agent/fileWatcher';
import { startBehaviorSensor, stopBehaviorSensor } from '@/core/agent/behaviorSensor';
import { useI18n } from '@/i18n';
import CloseDialog from '@/components/common/CloseDialog';
import { checkForUpdate } from '@/core/updates/checker';

function App() {
  const refreshDiscovery = useDiscoveryStore((s) => s.refresh);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const rightPanelCollapsed = useSettingsStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useSettingsStore((s) => s.toggleRightPanel);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const activeConv = useActiveConversation();
  const { t } = useI18n();

  // Right panel toggle only when there's an active conversation with messages
  const showRightPanelToggle = viewMode === 'chat' && (activeConv?.messages?.length ?? 0) > 0;
  const [showCloseDialog, setShowCloseDialog] = useState(false);

  const handleQuit = useCallback(() => {
    setShowCloseDialog(false);
    invoke('app_exit');
  }, []);

  const handleMinimize = useCallback(() => {
    setShowCloseDialog(false);
    invoke('window_hide');
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
    refreshDiscovery();
    initMCPStoreSync();

    // Initialize notifications with logging
    initNotifications().then((granted) => {
      console.log('[App] Notification permission initialized:', granted);
    }).catch((err) => {
      console.error('[App] Notification init error:', err);
    });

    // Initialize file watchers
    initFileWatchers().catch((err) => {
      console.warn('[App] File watcher init error:', err);
    });

    return () => {
      cleanupMCPStoreSync();
      stopAllWatchers();
    };
  }, [refreshDiscovery]);

  // Start scheduler engine and trigger engine
  useEffect(() => {
    schedulerEngine.start();
    triggerEngine.start();
    imChannelRouter.start();
    startTraySync();
    startFeishuWsManager();
    return () => {
      schedulerEngine.stop();
      triggerEngine.stop();
      imChannelRouter.stop();
      stopTraySync();
      stopFeishuWsManager();
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

  // Check for updates on startup (throttled to once per 24h)
  useEffect(() => {
    // Use void to suppress floating promise lint; errors are caught internally
    void checkForUpdate().catch((err) => {
      console.warn('[App] Update check error:', err);
    });
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
    <TooltipProvider delayDuration={200}>
      {/* Title bar drag region — only needed on macOS where we use overlay title bar */}
      {mac && (
        <div
          data-tauri-drag-region
          className="fixed top-0 left-0 right-0 h-7 z-40"
        />
      )}

      {/* Sidebar & panel toggle buttons — positioned in title bar area on macOS, top bar on Windows */}
      <div className={cn('fixed left-0 right-0 z-40 pointer-events-none', mac ? 'top-0 h-7' : 'top-0 h-8')}>
        {viewMode !== 'toolbox' && (
          <button
            onClick={toggleSidebar}
            className="absolute btn-ghost p-1 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]/80 rounded-md transition-[left] duration-200 pointer-events-auto"
            style={{ top: mac ? 6 : 4, left: sidebarCollapsed ? 70 : 232 }}
            title={sidebarCollapsed ? t.sidebar.showSidebar : t.sidebar.hideSidebar}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="h-3.5 w-3.5" />
              : <PanelLeftClose className="h-3.5 w-3.5" />}
          </button>
        )}

        {showRightPanelToggle && (
          <button
            onClick={toggleRightPanel}
            className="absolute right-2 btn-ghost p-1 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]/80 rounded-md pointer-events-auto"
            style={{ top: mac ? 6 : 4 }}
            title={rightPanelCollapsed ? t.panel.showPanel : t.panel.hidePanel}
          >
            {rightPanelCollapsed
              ? <PanelRightOpen className="h-3.5 w-3.5" />
              : <PanelRightClose className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div className="flex h-full w-full">
        {/* Sidebar - hidden in toolbox mode */}
        {viewMode !== 'toolbox' && (
          <div
            className="sidebar-transition shrink-0 overflow-hidden"
            style={{ width: sidebarCollapsed ? 0 : 260 }}
          >
            <Sidebar />
          </div>
        )}

        {/* Main — pt-7 on macOS to clear overlay title bar; no padding on Windows (native title bar) */}
        <main className={cn('flex-1 min-w-0 bg-[#faf9f5]', mac && 'pt-7')}>
          {viewMode === 'schedule' && <ScheduleView />}
          {viewMode === 'trigger' && <TriggerView />}
          {viewMode === 'toolbox' && <ToolboxView />}
          {viewMode === 'settings' && <SystemSettingsView />}
          {(viewMode === 'chat' || !viewMode) && <ChatView />}
        </main>

        {/* Right panel */}
        <RightPanel />

        <ToastContainer />

        <CloseDialog
          open={showCloseDialog}
          onQuit={handleQuit}
          onMinimize={handleMinimize}
          onCancel={() => setShowCloseDialog(false)}
          onCloseActionChange={useSettingsStore.getState().setCloseAction}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;
