import { useEffect, useCallback, useState, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Plus, Clock, Zap, Wrench, Trash2, Settings, Download, Upload, Pencil, Undo2, HelpCircle } from 'lucide-react';
import GuideModal from '@/components/common/GuideModal';
import ProfileEditModal from '@/components/common/ProfileEditModal';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ConversationStatus } from '@/types';
import ScheduledSection from '@/components/sidebar/ScheduledSection';
import TriggerSection from '@/components/sidebar/TriggerSection';
import abuAvatar from '@/assets/abu-avatar.png';
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { isMacOS } from '@/utils/platform';

interface StatusIndicatorProps {
  status: ConversationStatus;
  onComplete: () => void;
}

function StatusIndicator({ status, onComplete }: StatusIndicatorProps) {
  useEffect(() => {
    if (status === 'completed') {
      const timer = setTimeout(onComplete, 3000);
      return () => clearTimeout(timer);
    }
    if (status === 'error') {
      // Auto-clear error indicator after 10 seconds (user has seen it)
      const timer = setTimeout(onComplete, 10_000);
      return () => clearTimeout(timer);
    }
  }, [status, onComplete]);

  if (status === 'running') {
    return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  if (status === 'completed') {
    return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === 'error') {
    return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
  }
  return null;
}

function IMPlatformDot({ platform }: { platform: string }) {
  const labels: Record<string, string> = {
    dchat: 'DC', feishu: '飞', dingtalk: '钉', wecom: '微', slack: 'SL',
  };
  return (
    <span
      className="shrink-0 h-4 w-4 rounded text-[8px] font-bold leading-4 text-center bg-[#d97757]/15 text-[#d97757]"
      title={platform}
    >
      {labels[platform] ?? platform.slice(0, 2).toUpperCase()}
    </span>
  );
}

export default function Sidebar() {
  const { conversations, activeConversationId, startNewConversation, switchConversation, deleteConversation, renameConversation, clearCompletedStatus, exportConversation, importConversation } = useChatStore();
  const openToolbox = useSettingsStore((s) => s.openToolbox);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const { t } = useI18n();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Undo delete state
  const [pendingDelete, setPendingDelete] = useState<{ id: string; data: string } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Guide modal state — auto-open on first launch only
  const setGuideShown = useSettingsStore((s) => s.setGuideShown);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideCheckedRef = useRef(false);

  useEffect(() => {
    if (guideCheckedRef.current) return;
    // Wait for persist rehydration — guideShown stays false (default) until rehydrated
    const unsub = useSettingsStore.persist.onFinishHydration(() => {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        setGuideOpen(true);
      }
    });
    // If already hydrated (e.g. hot reload), check immediately
    if (useSettingsStore.persist.hasHydrated()) {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        setGuideOpen(true);
      }
    }
    return unsub;
  }, []);

  // Profile edit modal state
  const [profileOpen, setProfileOpen] = useState(false);
  const userNickname = useSettingsStore((s) => s.userNickname);
  const userAvatar = useSettingsStore((s) => s.userAvatar);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Sort by createdAt to keep positions stable during status updates
  // Filter out conversations created by scheduled tasks or triggers — they appear in their own sections
  const sortedConvs = Object.values(conversations)
    .filter((c) => !c.scheduledTaskId && !c.triggerId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const handleDeleteConversation = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    // Save conversation data for undo before deleting
    const json = exportConversation(convId);
    deleteConversation(convId);
    if (json) {
      // Cancel any previous undo timer
      clearTimeout(undoTimerRef.current);
      setPendingDelete({ id: convId, data: json });
      undoTimerRef.current = setTimeout(() => setPendingDelete(null), 5000);
    }
  };

  const handleUndoDelete = () => {
    if (pendingDelete) {
      importConversation(pendingDelete.data);
      clearTimeout(undoTimerRef.current);
      setPendingDelete(null);
    }
  };

  const handleClearCompletedStatus = useCallback((convId: string) => {
    clearCompletedStatus(convId);
  }, [clearCompletedStatus]);

  const handleContextMenu = (e: React.MouseEvent, convId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Clamp to viewport to prevent overflow
    const menuWidth = 160, menuHeight = 120;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x, y, convId });
  };

  const handleExport = async (convId: string) => {
    const json = exportConversation(convId);
    if (!json) return;
    const conv = conversations[convId];
    const defaultName = `abu-conversation-${conv?.title || convId}.json`;
    try {
      const filePath = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (filePath) {
        await writeTextFile(filePath, json);
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
    setContextMenu(null);
  };

  const handleImport = async () => {
    try {
      const filePath = await openDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (filePath) {
        const json = await readTextFile(filePath as string);
        importConversation(json);
      }
    } catch (err) {
      console.error('Import failed:', err);
    }
  };

  return (
    <div className="flex flex-col h-full w-[260px] bg-[#f5f3ee] border-r border-[#e8e4dd]">
      {/* Drag region — covers the title bar area above sidebar content (macOS overlay only) */}
      {isMacOS() && (
        <div
          data-tauri-drag-region
          className="h-7 shrink-0"
        />
      )}
      {/* Top Navigation */}
      <nav className="px-4 pb-2 space-y-0.5" aria-label="Main navigation">
        <button
          onClick={() => { startNewConversation(); setViewMode('chat'); }}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] font-medium rounded-lg',
            activeConversationId === null && viewMode === 'chat'
              ? 'bg-white shadow-sm text-[#29261b]'
              : 'text-[#29261b] hover:bg-[#e8e5de]'
          )}
        >
          <Plus className="h-[18px] w-[18px] text-[#3d3929]" strokeWidth={2} />
          <span>{t.sidebar.newTask}</span>
        </button>
        <button
          onClick={() => setViewMode('schedule')}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
            viewMode === 'schedule'
              ? 'bg-white shadow-sm text-[#29261b] font-medium'
              : 'text-[#3d3929] hover:bg-[#e8e5de]'
          )}
        >
          <Clock className="h-[18px] w-[18px] text-[#656358]" strokeWidth={1.75} />
          <span>{t.sidebar.scheduledTasks}</span>
        </button>
        <button
          onClick={() => setViewMode('trigger')}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
            viewMode === 'trigger'
              ? 'bg-white shadow-sm text-[#29261b] font-medium'
              : 'text-[#3d3929] hover:bg-[#e8e5de]'
          )}
        >
          <Zap className="h-[18px] w-[18px] text-[#656358]" strokeWidth={1.75} />
          <span>{t.sidebar.triggers}</span>
        </button>
        <button
          onClick={() => openToolbox()}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
            viewMode === 'toolbox'
              ? 'bg-white shadow-sm text-[#29261b] font-medium'
              : 'text-[#3d3929] hover:bg-[#e8e5de]'
          )}
        >
          <Wrench className="h-[18px] w-[18px] text-[#656358]" strokeWidth={1.75} />
          <span>{t.sidebar.toolbox}</span>
        </button>
      </nav>

      {/* Scrollable middle section: scheduled + triggers + recents */}
      <ScrollArea className="flex-1 min-h-0">
        {/* Scheduled Section */}
        <ScheduledSection />

        {/* Trigger Section */}
        <TriggerSection />

        {/* Recents Section */}
        <div className="px-6 pt-4 pb-1.5">
          <span className="text-[12px] font-medium text-[#656358]">{t.sidebar.recents}</span>
        </div>

        {/* Conversation List */}
        <div className="px-4">
        {sortedConvs.length === 0 ? (
          <div className="px-4 py-3">
            <p className="text-[13px] text-[#656358]">{t.sidebar.noSessionsYet}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sortedConvs.map((conv) => (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => { switchConversation(conv.id); setViewMode('chat'); if (conv.status === 'error') clearCompletedStatus(conv.id); }}
                onContextMenu={(e) => handleContextMenu(e, conv.id)}
                aria-current={conv.id === activeConversationId && viewMode === 'chat' ? 'true' : undefined}
                className={cn(
                  'group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors w-full text-left',
                  conv.id === activeConversationId && viewMode === 'chat'
                    ? 'bg-white shadow-sm text-[#29261b]'
                    : 'text-[#3d3929] hover:bg-[#e8e5de]'
                )}
              >
                <StatusIndicator
                  status={conv.status ?? 'idle'}
                  onComplete={() => handleClearCompletedStatus(conv.id)}
                />
                {conv.imPlatform && (
                  <IMPlatformDot platform={conv.imPlatform} />
                )}
                {editingId === conv.id ? (
                  <input
                    autoFocus
                    defaultValue={conv.title}
                    className="flex-1 text-[13px] bg-transparent border-b border-[#d97757] outline-none min-w-0"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val && val !== conv.title) renameConversation(conv.id, val);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <span className="flex-1 truncate text-[13px]">{conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => handleDeleteConversation(e, conv.id)}
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 text-[#656358] hover:text-red-500 hover:bg-transparent shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        </div>
      </ScrollArea>

      {/* User Section */}
      <div className="px-5 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          {/* User avatar + nickname (clickable to edit) */}
          <button
            onClick={() => setProfileOpen(true)}
            className="w-8 h-8 rounded-full overflow-hidden shrink-0 hover:ring-2 hover:ring-[#d97757]/40 transition-shadow"
            title={t.sidebar.editProfile}
          >
            <img src={userAvatar || abuAvatar} alt="Avatar" className="w-full h-full object-cover" />
          </button>
          <button
            onClick={() => setProfileOpen(true)}
            className="flex-1 min-w-0 text-left"
            title={t.sidebar.editProfile}
          >
            <div className="text-[13px] font-semibold text-[#29261b] truncate">
              {userNickname || t.sidebar.defaultNickname}
            </div>
          </button>
          <button
            onClick={handleImport}
            className="btn-ghost p-1.5 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de] rounded-md"
            title={t.sidebar.importSession}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => openSystemSettings(updateInfo ? 'about' : undefined)}
            className={cn(
              'btn-ghost p-1.5 rounded-md relative',
              viewMode === 'settings'
                ? 'text-[#d97757] bg-[#d97757]/10'
                : 'text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]'
            )}
          >
            <Settings className="h-3.5 w-3.5" />
            {updateInfo && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
          <button
            onClick={() => setGuideOpen(true)}
            className="btn-ghost p-1.5 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de] rounded-md"
            title={t.sidebar.help}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[#e8e4dd] py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setEditingId(contextMenu.convId);
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[#3d3929] hover:bg-[#f0ede6]"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t.sidebar.renameConversation}
          </button>
          <button
            onClick={() => handleExport(contextMenu.convId)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[#3d3929] hover:bg-[#f0ede6]"
          >
            <Download className="h-3.5 w-3.5" />
            {t.sidebar.exportConversation}
          </button>
          <button
            onClick={(e) => {
              handleDeleteConversation(e, contextMenu.convId);
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[#f0ede6]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.sidebar.deleteConversation}
          </button>
        </div>
      )}

      {/* Guide modal */}
      <GuideModal open={guideOpen} onClose={() => { setGuideOpen(false); setGuideShown(true); }} />

      {/* Profile edit modal */}
      <ProfileEditModal open={profileOpen} onClose={() => setProfileOpen(false)} />


      {/* Undo delete toast */}
      {pendingDelete && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-[#29261b] text-white rounded-xl shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200" role="alert" aria-live="assertive">
          <span className="text-sm">{t.sidebar.conversationDeleted}</span>
          <button
            onClick={handleUndoDelete}
            className="flex items-center gap-1 text-sm font-medium text-[#d97757] hover:text-[#e8956e] transition-colors"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t.sidebar.undo}
          </button>
        </div>
      )}
    </div>
  );
}
